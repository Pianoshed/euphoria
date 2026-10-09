"""2FA on withdrawals, booking timeouts, ledger == balance."""
from datetime import timedelta
from decimal import Decimal
from uuid import uuid4

import pyotp
import pytest
from django.db.models import Sum
from django.utils import timezone

from apps.bookings import services as bs
from apps.bookings.models import Booking
from apps.common.constants import AccountRole, BookingStatus, ServiceStatus
from apps.common.exceptions import DomainError
from apps.services.models import Service, ServiceCategory
from apps.wallet import payment_services, services as ws
from apps.wallet.models import LedgerEntry, Wallet
from apps.wallet.tests.test_hardening import PW, account, make_earning, mk

pytestmark = pytest.mark.django_db


def test_withdrawal_needs_authenticator_code_when_2fa_enabled():
    u = mk("tf")
    u.two_factor_secret = pyotp.random_base32(); u.two_factor_enabled = True
    u.save(update_fields=["two_factor_secret", "two_factor_enabled"])
    ws.deposit(u, amount=Decimal("2000.00"), idempotency_key="s")
    acct = account(u)
    kw = dict(amount=Decimal("1000.00"), payout_account_id=acct.id, current_password=PW)
    with pytest.raises(DomainError):
        payment_services.request_withdrawal(u, idempotency_key="a1", **kw)
    with pytest.raises(DomainError):
        payment_services.request_withdrawal(u, idempotency_key="a2", otp_code="000000", **kw)
    assert ws.get_balance(u) == Decimal("2000.00")
    w = payment_services.request_withdrawal(u, idempotency_key="a3", otp_code=pyotp.TOTP(u.two_factor_secret).now(), **kw)
    assert w.status == "COMPLETED" and ws.get_balance(u) == Decimal("1000.00")


def _funded(status, plan=False):
    c, p = mk(f"c{uuid4().hex[:5]}"), mk(f"p{uuid4().hex[:5]}", role=AccountRole.PROVIDER)
    cat = ServiceCategory.objects.create(name="T", slug=f"t-{uuid4().hex[:8]}")
    svc = Service.objects.create(provider=p, category=cat, title="S", description="d", price=Decimal("1000.00"), status=ServiceStatus.PUBLISHED)
    b = Booking.objects.create(service=svc, customer=c, provider=p, status=BookingStatus.ACCEPTED, agreed_price=Decimal("1000.00"),
                               purchase_idempotency_key=str(uuid4()))
    ws.deposit(c, amount=Decimal("1000.00"), idempotency_key=f"d{b.id}")
    bs.fund_booking(c, b.id)
    Booking.objects.filter(id=b.id).update(status=status, completed_at=timezone.now() - timedelta(days=30))
    Booking.objects.filter(id=b.id).update(updated_at=timezone.now() - timedelta(days=30))
    return b, c, p


def test_stale_completed_booking_is_auto_released_to_provider_once():
    b, c, p = _funded(BookingStatus.COMPLETED)
    assert bs.settle_stale_bookings()["released"] == 1
    assert bs.settle_stale_bookings()["released"] == 0
    assert ws.get_balance(p) == Decimal("1000.00")


def test_stale_in_progress_booking_is_auto_refunded():
    b, c, p = _funded(BookingStatus.IN_PROGRESS)
    assert bs.settle_stale_bookings()["refunded"] == 1
    assert ws.get_balance(c) == Decimal("1000.00") and ws.get_balance(p) == Decimal("0.00")


def test_recent_bookings_are_left_alone():
    b, c, p = _funded(BookingStatus.COMPLETED)
    Booking.objects.filter(id=b.id).update(completed_at=timezone.now())
    assert bs.settle_stale_bookings() == {"released": 0, "refunded": 0, "errors": 0}


def test_ledger_sum_equals_balance_with_promotional_credit():
    planner, buyer = mk("lp", role=AccountRole.PROVIDER), mk("lb")
    ws.deposit(buyer, amount=Decimal("1000.00"), idempotency_key="x")
    ws.grant_promotional_credit(buyer, amount=Decimal("600.00"))
    cat = ServiceCategory.objects.create(name="P", slug=f"p-{uuid4().hex[:8]}")
    plan = Service.objects.create(provider=planner, category=cat, title="P", description="d", price=Decimal("1000.00"),
                                  status=ServiceStatus.PUBLISHED, is_plan=True, capacity=3, platform_fee_rate=Decimal("15.00"))
    b = bs.create_booking(buyer, service_id=plan.id)
    bs.transition_booking(planner, b.id, to_status="ACCEPTED")
    bs.fund_booking(buyer, b.id)
    total = lambda: LedgerEntry.objects.filter(wallet__user=buyer).exclude(entry_type="PROMOTIONAL_CREDIT").aggregate(t=Sum("amount"))["t"]
    assert total() == Wallet.objects.get(user=buyer).balance == Decimal("600.00")
    bs.refund_cancelled_booking(buyer, b.id)
    assert total() == Wallet.objects.get(user=buyer).balance == Decimal("1000.00")

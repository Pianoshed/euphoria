"""Regression tests for the payment / race-condition hardening pass."""
import json
from datetime import timedelta
from decimal import Decimal
from uuid import uuid4

import pytest
from django.core.exceptions import ImproperlyConfigured
from django.utils import timezone

from apps.accounts.models import User
from apps.bookings.models import Booking
from apps.common.constants import AccountRole, AccountStatus, BookingStatus, ServiceStatus
from apps.common.exceptions import AccountNotEligibleError, DomainError, InvalidStateTransitionError
from apps.economy import services as eco
from apps.economy.models import EarningStatus, GiftStatus, PlannerEarning, TransactionOrder, TransactionStatus
from apps.services.models import Service, ServiceCategory
from apps.wallet import payment_services, providers, services as ws
from apps.wallet.models import Escrow, PaymentIntent, PayoutAccount, WithdrawalRequest

pytestmark = pytest.mark.django_db
PW = "a-strong-password-1"


def mk(name, **kw):
    u = User.objects.create_user(email=f"{name}@example.com", username=f"user_{name}", password=PW, **kw)
    u.mark_email_verified()
    return u


def account(user):
    a = PayoutAccount.objects.create(user=user, label="GTBank", masked_reference="****1234")
    PayoutAccount.objects.filter(id=a.id).update(created_at=timezone.now() - timedelta(days=3))
    a.refresh_from_db()
    return a


def make_earning(planner, buyer, net="8500.00", gross="10000.00"):
    cat = ServiceCategory.objects.create(name="C", slug=f"c-{uuid4().hex[:8]}")
    plan = Service.objects.create(provider=planner, category=cat, title="P", description="d", price=Decimal(gross),
                                  status=ServiceStatus.PUBLISHED, is_plan=True, capacity=5, platform_fee_rate=Decimal("15.00"))
    b = Booking.objects.create(service=plan, customer=buyer, provider=planner, status=BookingStatus.COMPLETED,
                               agreed_price=Decimal(gross), quantity=1, unit_price=Decimal(gross), gross_amount=Decimal(gross),
                               purchase_idempotency_key=str(uuid4()))
    fee = Decimal(gross) - Decimal(net)
    o = TransactionOrder.objects.create(buyer=buyer, planner=planner, plan=plan, booking=b, quantity=1, unit_price=Decimal(gross),
                                        gross_amount=Decimal(gross), platform_fee_rate=Decimal("15.00"), platform_fee_amount=fee,
                                        planner_amount=Decimal(net), idempotency_key=str(uuid4()), status=TransactionStatus.HELD)
    ws.deposit(buyer, amount=Decimal(gross), idempotency_key=f"d:{uuid4()}")
    ws.hold_escrow(buyer, booking=b, idempotency_key=f"escrow-hold:{b.id}")
    eco.settle_booking(b.id)
    return PlannerEarning.objects.get(order=o), b


# ---- stub provider can never run in production -------------------------------------------
def test_stub_provider_refused_outside_dev(settings, monkeypatch):
    settings.PAYMENT_PROVIDER = "stub"
    settings.DEBUG = False
    monkeypatch.setattr(providers, "_running_tests", lambda: False)
    with pytest.raises(ImproperlyConfigured):
        providers.get_provider()
    settings.ALLOW_STUB_PAYMENTS = True
    assert providers.get_provider().name == "stub"


def test_stub_webhook_with_empty_secret_never_verifies(settings):
    settings.STUB_PAYMENT_WEBHOOK_SECRET = ""
    assert providers.StubProvider().verify_webhook_signature(headers={"X-Stub-Signature": ""}, body=b"{}") is False


# ---- deposits -----------------------------------------------------------------------------
def test_full_payment_after_failed_attempt_is_still_credited():
    u = mk("dep")
    intent = PaymentIntent.objects.create(user=u, amount=Decimal("300.00"), provider="stub", provider_reference="r1",
                                          status="FAILED", idempotency_key="k-failed", failure_reason="x")
    payment_services._complete_deposit(intent, provider_event_id="evt-ok", allow_failed=True)
    assert ws.get_balance(u) == Decimal("300.00")
    payment_services._complete_deposit(intent, provider_event_id="evt-ok", allow_failed=True)  # replay: no double credit
    assert ws.get_balance(u) == Decimal("300.00")


def test_malformed_stub_webhook_is_a_domain_error_not_a_500():
    with pytest.raises(DomainError):
        providers.StubProvider().parse_webhook_event(body=b"not json")


# ---- withdrawals ----------------------------------------------------------------------------
def test_idempotency_key_cannot_be_replayed_with_a_different_amount():
    u = mk("wd")
    ws.deposit(u, amount=Decimal("5000.00"), idempotency_key="seed")
    acct = account(u)
    payment_services.request_withdrawal(u, amount=Decimal("1000.00"), payout_account_id=acct.id, current_password=PW, idempotency_key="w1")
    with pytest.raises(DomainError):
        payment_services.request_withdrawal(u, amount=Decimal("2000.00"), payout_account_id=acct.id, current_password=PW, idempotency_key="w1")
    assert ws.get_balance(u) == Decimal("4000.00")


def test_staff_cannot_adjust_own_wallet():
    s = mk("staff", is_staff=True)
    with pytest.raises(AccountNotEligibleError):
        ws.admin_adjust_wallet(s, s, amount=Decimal("100.00"), reason="free money")


def test_legacy_escrow_with_zero_paid_amount_refunds_in_full():
    c, p = mk("c1"), mk("p1", role=AccountRole.PROVIDER)
    cat = ServiceCategory.objects.create(name="L", slug=f"l-{uuid4().hex[:8]}")
    svc = Service.objects.create(provider=p, category=cat, title="S", description="d", price=Decimal("500.00"), status=ServiceStatus.PUBLISHED)
    b = Booking.objects.create(service=svc, customer=c, provider=p, status=BookingStatus.FUNDED, agreed_price=Decimal("500.00"),
                               purchase_idempotency_key=str(uuid4()))
    Escrow.objects.create(booking=b, amount=Decimal("500.00"))  # paid_amount / promotional_amount default to 0
    ws.refund_escrow(b)
    assert ws.get_balance(c) == Decimal("500.00")


# ---- planner earnings -------------------------------------------------------------------------
def test_two_payouts_from_one_earning_settle_independently():
    planner, buyer = mk("pl", role=AccountRole.PROVIDER), mk("by")
    earning, _ = make_earning(planner, buyer)
    a1 = eco.withdraw_earnings(planner, amount=Decimal("1000.00"), idempotency_key="A")
    a2 = eco.withdraw_earnings(planner, amount=Decimal("2000.00"), idempotency_key="B")
    alloc = lambda al: [{"earning_id": str(e), "amount": str(t)} for e, t in al]
    eco.finalize_earning_withdrawal(amount=Decimal("1000.00"), user=planner, reservation_key="A", success=True, allocations=alloc(a1))
    eco.finalize_earning_withdrawal(amount=Decimal("2000.00"), user=planner, reservation_key="B", success=False, allocations=alloc(a2))
    earning.refresh_from_db()
    assert (earning.withdrawn_amount, earning.reserved_amount) == (Decimal("1000.00"), Decimal("0.00"))
    assert earning.available_balance == Decimal("7500.00")


def test_bank_reversal_of_completed_earnings_payout_restores_earnings():
    planner, buyer = mk("pl2", role=AccountRole.PROVIDER), mk("by2")
    earning, _ = make_earning(planner, buyer)
    acct = account(planner)
    allocs = eco.withdraw_earnings(planner, amount=Decimal("1000.00"), idempotency_key="E1")
    w = payment_services.request_withdrawal(
        planner, amount=Decimal("1000.00"), payout_account_id=acct.id, current_password=PW, idempotency_key="E1",
        source="EARNINGS", earning_allocations=[{"earning_id": str(e), "amount": str(t)} for e, t in allocs])
    assert w.status == "COMPLETED"
    payment_services._refund(w.id, reason="bank reversed", allowed=("PROCESSING", "COMPLETED"))
    earning.refresh_from_db()
    assert earning.withdrawn_amount == Decimal("0.00") and earning.available_balance == Decimal("8500.00")


def test_earnings_payout_with_forged_allocations_is_rejected():
    planner, buyer = mk("pl3", role=AccountRole.PROVIDER), mk("by3")
    earning, _ = make_earning(planner, buyer)
    acct = account(planner)
    with pytest.raises(DomainError):  # nothing was reserved
        payment_services.request_withdrawal(
            planner, amount=Decimal("1000.00"), payout_account_id=acct.id, current_password=PW, idempotency_key="F1",
            source="EARNINGS", earning_allocations=[{"earning_id": str(earning.id), "amount": "1000.00"}])


def test_post_settlement_refund_only_claws_back_planner_net_share():
    planner, buyer = mk("pl4", role=AccountRole.PROVIDER), mk("by4")
    earning, booking = make_earning(planner, buyer)
    eco.refund_booking(booking.id, reason="goodwill")
    earning.refresh_from_db()
    assert earning.refunded_amount == Decimal("8500.00") and earning.status == EarningStatus.REFUNDED
    assert ws.get_balance(buyer) == Decimal("10000.00")  # customer made whole at the gross amount


# ---- gifts ----------------------------------------------------------------------------------------
def test_expired_gift_is_returned_to_sender_and_status_persists():
    a, b = mk("ga"), mk("gb")
    ws.deposit(a, amount=Decimal("1000.00"), idempotency_key="seed-g")
    gift = eco.create_gift(a, recipient=b, amount=Decimal("400.00"), message="hi", idempotency_key="g1")
    assert gift.expires_at is not None and ws.get_balance(a) == Decimal("600.00")
    type(gift).objects.filter(id=gift.id).update(expires_at=timezone.now() - timedelta(minutes=1))
    with pytest.raises(InvalidStateTransitionError):
        eco.accept_gift(b, gift.id)
    gift.refresh_from_db()
    assert gift.status == GiftStatus.EXPIRED          # previously rolled back by the raise
    assert ws.get_balance(a) == Decimal("1000.00")    # previously the money vanished
    assert ws.get_balance(b) == Decimal("0.00")


def test_expire_stale_gifts_sweeper_is_idempotent():
    a, b = mk("gc"), mk("gd")
    ws.deposit(a, amount=Decimal("500.00"), idempotency_key="seed-h")
    gift = eco.create_gift(a, recipient=b, amount=Decimal("500.00"), idempotency_key="g2")
    type(gift).objects.filter(id=gift.id).update(expires_at=timezone.now() - timedelta(minutes=1))
    assert eco.expire_stale_gifts() == 1 and eco.expire_stale_gifts() == 0
    assert ws.get_balance(a) == Decimal("500.00")


def test_gift_key_replay_with_other_amount_rejected():
    a, b = mk("ge"), mk("gf")
    ws.deposit(a, amount=Decimal("900.00"), idempotency_key="seed-i")
    eco.create_gift(a, recipient=b, amount=Decimal("100.00"), idempotency_key="g3")
    with pytest.raises(DomainError):
        eco.create_gift(a, recipient=b, amount=Decimal("800.00"), idempotency_key="g3")

from decimal import Decimal

import pytest
from django.urls import reverse

from apps.accounts.models import User
from apps.bookings import services as booking_services
from apps.common.constants import AccountRole, BookingStatus, EscrowStatus, ServiceStatus
from apps.common.exceptions import AccountNotEligibleError, InsufficientBalanceError, InvalidStateTransitionError
from apps.services.models import Service, ServiceCategory
from apps.wallet import services as wallet_services
from apps.wallet.models import Escrow, Wallet

pytestmark = pytest.mark.django_db


def make_user(role="CUSTOMER", **kwargs):
    defaults = dict(email=f"{role.lower()}@example.com", username=f"{role.lower()}user", password="a-strong-password-1", role=role)
    defaults.update(kwargs)
    user = User.objects.create_user(**defaults)
    user.mark_email_verified()
    return user


def make_published_service(provider, price=100):
    category = ServiceCategory.objects.create(name="Cleaning", slug="cleaning")
    return Service.objects.create(provider=provider, category=category, title="Deep clean", description="x", price=price, status=ServiceStatus.PUBLISHED)


def login(client, email, password="a-strong-password-1"):
    return client.post(reverse("accounts:login"), {"email": email, "password": password}, content_type="application/json")


def make_funded_booking(price=100):
    provider = make_user(role="PROVIDER")
    customer = make_user(role="CUSTOMER")
    service = make_published_service(provider, price=price)
    booking = booking_services.create_booking(customer, service_id=service.id)
    booking_services.transition_booking(provider, booking.id, to_status=BookingStatus.ACCEPTED)
    wallet_services.deposit(customer, amount=Decimal(price))
    booking_services.fund_booking(customer, booking.id)
    return provider, customer, booking


# --- Funding ---------------------------------------------------------------------

def test_fund_moves_money_into_escrow(client):
    provider, customer, booking = make_funded_booking(price=100)
    booking.refresh_from_db()
    assert booking.status == BookingStatus.FUNDED
    assert wallet_services.get_balance(customer) == Decimal("0.00")
    escrow = Escrow.objects.get(booking=booking)
    assert escrow.amount == Decimal("100.00")
    assert escrow.status == EscrowStatus.HELD


def test_fund_fails_with_insufficient_balance():
    provider = make_user(role="PROVIDER")
    customer = make_user(role="CUSTOMER")
    service = make_published_service(provider, price=500)
    booking = booking_services.create_booking(customer, service_id=service.id)
    booking_services.transition_booking(provider, booking.id, to_status=BookingStatus.ACCEPTED)
    # customer never deposited anything
    with pytest.raises(InsufficientBalanceError):
        booking_services.fund_booking(customer, booking.id)
    booking.refresh_from_db()
    assert booking.status == BookingStatus.ACCEPTED  # unchanged


def test_only_customer_can_fund():
    provider = make_user(role="PROVIDER")
    customer = make_user(role="CUSTOMER")
    service = make_published_service(provider)
    booking = booking_services.create_booking(customer, service_id=service.id)
    booking_services.transition_booking(provider, booking.id, to_status=BookingStatus.ACCEPTED)
    wallet_services.deposit(provider, amount=Decimal(100))
    with pytest.raises(AccountNotEligibleError):
        booking_services.fund_booking(provider, booking.id)


def test_cannot_fund_before_accepted():
    provider = make_user(role="PROVIDER")
    customer = make_user(role="CUSTOMER")
    service = make_published_service(provider)
    booking = booking_services.create_booking(customer, service_id=service.id)  # still PENDING
    wallet_services.deposit(customer, amount=Decimal(100))
    with pytest.raises(InvalidStateTransitionError):
        booking_services.fund_booking(customer, booking.id)


def test_generic_transition_endpoint_cannot_reach_funded(client):
    provider = make_user(role="PROVIDER")
    customer = make_user(role="CUSTOMER")
    service = make_published_service(provider)
    booking = booking_services.create_booking(customer, service_id=service.id)
    booking_services.transition_booking(provider, booking.id, to_status=BookingStatus.ACCEPTED)
    login(client, "customer@example.com")
    resp = client.post(reverse("bookings:transition", args=[booking.id]), {"to_status": "FUNDED"}, content_type="application/json")
    assert resp.status_code == 400  # must go through the dedicated /fund/ endpoint


# --- Full happy path through release --------------------------------------------

def test_full_flow_through_release(client):
    provider, customer, booking = make_funded_booking(price=80)
    booking_services.transition_booking(provider, booking.id, to_status=BookingStatus.IN_PROGRESS)
    booking_services.transition_booking(provider, booking.id, to_status=BookingStatus.COMPLETED)

    assert wallet_services.get_balance(provider) == Decimal("0.00")  # not paid yet
    booking_services.release_booking_funds(customer, booking.id)

    booking.refresh_from_db()
    assert booking.status == BookingStatus.RELEASED
    assert wallet_services.get_balance(provider) == Decimal("80.00")
    escrow = Escrow.objects.get(booking=booking)
    assert escrow.status == EscrowStatus.RELEASED


def test_only_customer_can_release():
    provider, customer, booking = make_funded_booking()
    booking_services.transition_booking(provider, booking.id, to_status=BookingStatus.IN_PROGRESS)
    booking_services.transition_booking(provider, booking.id, to_status=BookingStatus.COMPLETED)
    with pytest.raises(AccountNotEligibleError):
        booking_services.release_booking_funds(provider, booking.id)


def test_cannot_release_before_completed():
    provider, customer, booking = make_funded_booking()  # still FUNDED
    with pytest.raises(InvalidStateTransitionError):
        booking_services.release_booking_funds(customer, booking.id)


def test_cannot_release_twice():
    provider, customer, booking = make_funded_booking(price=50)
    booking_services.transition_booking(provider, booking.id, to_status=BookingStatus.IN_PROGRESS)
    booking_services.transition_booking(provider, booking.id, to_status=BookingStatus.COMPLETED)
    booking_services.release_booking_funds(customer, booking.id)
    with pytest.raises(InvalidStateTransitionError):
        booking_services.release_booking_funds(customer, booking.id)
    assert wallet_services.get_balance(provider) == Decimal("50.00")  # not double-paid


# --- Cancel with refund --------------------------------------------------------------

def test_cancel_funded_booking_refunds_customer(client):
    provider, customer, booking = make_funded_booking(price=60)
    booking_services.refund_cancelled_booking(customer, booking.id)
    booking.refresh_from_db()
    assert booking.status == BookingStatus.CANCELLED
    assert wallet_services.get_balance(customer) == Decimal("60.00")  # refunded
    assert wallet_services.get_balance(provider) == Decimal("0.00")
    escrow = Escrow.objects.get(booking=booking)
    assert escrow.status == EscrowStatus.REFUNDED


def test_cannot_refund_cancel_unfunded_booking():
    provider = make_user(role="PROVIDER")
    customer = make_user(role="CUSTOMER")
    service = make_published_service(provider)
    booking = booking_services.create_booking(customer, service_id=service.id)  # PENDING
    with pytest.raises(InvalidStateTransitionError):
        booking_services.refund_cancelled_booking(customer, booking.id)


# --- Disputes ------------------------------------------------------------------------

def test_customer_can_dispute_completed_booking():
    provider, customer, booking = make_funded_booking()
    booking_services.transition_booking(provider, booking.id, to_status=BookingStatus.IN_PROGRESS)
    booking_services.transition_booking(provider, booking.id, to_status=BookingStatus.COMPLETED)
    updated = booking_services.transition_booking(customer, booking.id, to_status=BookingStatus.DISPUTED)
    assert updated.status == BookingStatus.DISPUTED


def test_non_staff_cannot_resolve_dispute():
    provider, customer, booking = make_funded_booking()
    booking_services.transition_booking(provider, booking.id, to_status=BookingStatus.IN_PROGRESS)
    booking_services.transition_booking(provider, booking.id, to_status=BookingStatus.COMPLETED)
    booking_services.transition_booking(customer, booking.id, to_status=BookingStatus.DISPUTED)
    with pytest.raises(AccountNotEligibleError):
        booking_services.resolve_dispute(customer, booking.id, resolution="RELEASE")


def test_staff_resolves_dispute_in_favor_of_provider():
    provider, customer, booking = make_funded_booking(price=40)
    booking_services.transition_booking(provider, booking.id, to_status=BookingStatus.IN_PROGRESS)
    booking_services.transition_booking(provider, booking.id, to_status=BookingStatus.COMPLETED)
    booking_services.transition_booking(customer, booking.id, to_status=BookingStatus.DISPUTED)

    staff = make_user(role="ADMIN", email="admin@example.com", username="adminuser")
    staff.is_staff = True
    staff.save()
    resolved = booking_services.resolve_dispute(staff, booking.id, resolution="RELEASE", reason="Work verified complete.")
    assert resolved.status == BookingStatus.RELEASED
    assert wallet_services.get_balance(provider) == Decimal("40.00")

    from apps.common.models import AuditLog
    assert AuditLog.objects.filter(action="DISPUTE_RESOLVED").exists()


def test_staff_resolves_dispute_in_favor_of_customer():
    provider, customer, booking = make_funded_booking(price=40)
    booking_services.transition_booking(provider, booking.id, to_status=BookingStatus.IN_PROGRESS)
    booking_services.transition_booking(provider, booking.id, to_status=BookingStatus.COMPLETED)
    booking_services.transition_booking(customer, booking.id, to_status=BookingStatus.DISPUTED)

    staff = make_user(role="ADMIN", email="admin2@example.com", username="admin2user")
    staff.is_staff = True
    staff.save()
    resolved = booking_services.resolve_dispute(staff, booking.id, resolution="REFUND", reason="Work not done.")
    assert resolved.status == BookingStatus.REFUNDED
    assert wallet_services.get_balance(customer) == Decimal("40.00")


def test_hold_escrow_idempotency_key_prevents_double_debit_even_bypassing_state_machine():
    """Defense-in-depth check: even calling wallet_services.hold_escrow
    directly twice with the same deterministic key (bypassing the
    booking state machine's own guard entirely) must not double-debit
    the customer or create a second escrow row."""
    provider = make_user(role="PROVIDER")
    customer = make_user(role="CUSTOMER")
    service = make_published_service(provider, price=30)
    booking = booking_services.create_booking(customer, service_id=service.id)
    wallet_services.deposit(customer, amount=Decimal("30.00"))

    key = f"escrow-hold:{booking.id}"
    wallet_services.hold_escrow(customer, booking=booking, idempotency_key=key)
    # Second call with the same key: must be a no-op, not a second debit.
    wallet_services.hold_escrow(customer, booking=booking, idempotency_key=key)

    assert wallet_services.get_balance(customer) == Decimal("0.00")
    assert Escrow.objects.filter(booking=booking).count() == 1


def test_price_change_after_funding_does_not_affect_escrow():
    provider, customer, booking = make_funded_booking(price=70)
    service = booking.service
    service.price = Decimal("9999.00")
    service.save()
    escrow = Escrow.objects.get(booking=booking)
    assert escrow.amount == Decimal("70.00")

import pytest
from django.urls import reverse

from apps.accounts.models import User
from apps.bookings.models import Booking
from apps.bookings import services as booking_services
from apps.common.constants import BookingStatus, ServiceStatus
from apps.common.exceptions import AccountNotEligibleError, InvalidStateTransitionError, DomainError
from apps.services.models import Service, ServiceCategory
from apps.services import services as service_listing_services

pytestmark = pytest.mark.django_db


def make_user(role="CUSTOMER", **kwargs):
    defaults = dict(email=f"{role.lower()}@example.com", username=f"{role.lower()}user", password="a-strong-password-1", role=role)
    defaults.update(kwargs)
    user = User.objects.create_user(**defaults)
    user.mark_email_verified()
    return user


def make_published_service(provider, price=50):
    category = ServiceCategory.objects.create(name="Cleaning", slug="cleaning")
    return Service.objects.create(
        provider=provider, category=category, title="Deep clean", description="x", price=price, status=ServiceStatus.PUBLISHED
    )


def login(client, email, password="a-strong-password-1"):
    return client.post(reverse("accounts:login"), {"email": email, "password": password}, content_type="application/json")


# --- Creation ------------------------------------------------------------------

def test_customer_creates_booking_snapshots_price(client):
    provider = make_user(role="PROVIDER")
    make_user(role="CUSTOMER")
    service = make_published_service(provider, price=75)
    login(client, "customer@example.com")

    resp = client.post(reverse("bookings:list-create"), {"service_id": str(service.id)}, content_type="application/json")
    assert resp.status_code == 201
    body = resp.json()
    assert body["status"] == "PENDING"
    assert body["agreed_price"] == "75.00"

    # price change afterward doesn't affect the existing booking
    service.price = 999
    service.save()
    booking = Booking.objects.get(id=body["id"])
    assert str(booking.agreed_price) == "75.00"


def test_cannot_book_own_service(client):
    provider = make_user(role="PROVIDER")
    service = make_published_service(provider)
    login(client, "provider@example.com")
    resp = client.post(reverse("bookings:list-create"), {"service_id": str(service.id)}, content_type="application/json")
    assert resp.status_code == 400


def test_cannot_book_unpublished_service(client):
    provider = make_user(role="PROVIDER")
    category = ServiceCategory.objects.create(name="Tutoring", slug="tutoring")
    service = Service.objects.create(provider=provider, category=category, title="Math", description="x", price=20, status=ServiceStatus.DRAFT)
    make_user(role="CUSTOMER")
    login(client, "customer@example.com")
    resp = client.post(reverse("bookings:list-create"), {"service_id": str(service.id)}, content_type="application/json")
    assert resp.status_code == 400


def test_booking_creates_initial_event(client):
    provider = make_user(role="PROVIDER")
    make_user(role="CUSTOMER")
    service = make_published_service(provider)
    login(client, "customer@example.com")
    resp = client.post(reverse("bookings:list-create"), {"service_id": str(service.id)}, content_type="application/json")
    booking_id = resp.json()["id"]
    events = client.get(reverse("bookings:events", args=[booking_id])).json()
    assert len(events) == 1
    assert events[0]["to_status"] == "PENDING"


# --- Authorization per role -----------------------------------------------------

def test_only_provider_can_accept(client):
    provider = make_user(role="PROVIDER")
    customer = make_user(role="CUSTOMER")
    service = make_published_service(provider)
    booking = booking_services.create_booking(customer, service_id=service.id)

    login(client, "customer@example.com")
    resp = client.post(reverse("bookings:transition", args=[booking.id]), {"to_status": "ACCEPTED"}, content_type="application/json")
    assert resp.status_code == 403

    client.post(reverse("accounts:logout"))
    login(client, "provider@example.com")
    resp2 = client.post(reverse("bookings:transition", args=[booking.id]), {"to_status": "ACCEPTED"}, content_type="application/json")
    assert resp2.status_code == 200


def test_non_participant_cannot_view_or_act(client):
    provider = make_user(role="PROVIDER")
    customer = make_user(role="CUSTOMER")
    stranger = make_user(role="CUSTOMER", email="stranger@example.com", username="strangeruser")
    service = make_published_service(provider)
    booking = booking_services.create_booking(customer, service_id=service.id)

    login(client, "stranger@example.com")
    resp = client.get(reverse("bookings:detail", args=[booking.id]))
    assert resp.status_code == 404
    resp2 = client.post(reverse("bookings:transition", args=[booking.id]), {"to_status": "ACCEPTED"}, content_type="application/json")
    assert resp2.status_code in (403, 404)


def test_full_happy_path(client):
    provider = make_user(role="PROVIDER")
    customer = make_user(role="CUSTOMER")
    service = make_published_service(provider)
    booking = booking_services.create_booking(customer, service_id=service.id)

    login(client, "provider@example.com")
    resp = client.post(reverse("bookings:transition", args=[booking.id]), {"to_status": "ACCEPTED"}, content_type="application/json")
    assert resp.status_code == 200

    # Funding (Phase 5) now sits between ACCEPTED and IN_PROGRESS --
    # see apps/bookings/services.py's TRANSITIONS docstring.
    from apps.wallet import services as wallet_services

    client.post(reverse("accounts:logout"))
    login(client, "customer@example.com")
    wallet_services.deposit(customer, amount=service.price)
    resp0 = client.post(reverse("bookings:fund", args=[booking.id]))
    assert resp0.status_code == 200
    client.post(reverse("accounts:logout"))
    login(client, "provider@example.com")

    for to_status in ["IN_PROGRESS", "COMPLETED"]:
        resp = client.post(reverse("bookings:transition", args=[booking.id]), {"to_status": to_status}, content_type="application/json")
        assert resp.status_code == 200, resp.content
        assert resp.json()["status"] == to_status

    booking.refresh_from_db()
    assert booking.completed_at is not None


def test_cannot_skip_from_pending_to_completed():
    provider = make_user(role="PROVIDER")
    customer = make_user(role="CUSTOMER")
    service = make_published_service(provider)
    booking = booking_services.create_booking(customer, service_id=service.id)

    with pytest.raises(InvalidStateTransitionError):
        booking_services.transition_booking(provider, booking.id, to_status=BookingStatus.COMPLETED)


def test_customer_can_cancel_while_pending():
    provider = make_user(role="PROVIDER")
    customer = make_user(role="CUSTOMER")
    service = make_published_service(provider)
    booking = booking_services.create_booking(customer, service_id=service.id)
    updated = booking_services.transition_booking(customer, booking.id, to_status=BookingStatus.CANCELLED)
    assert updated.status == BookingStatus.CANCELLED


def test_customer_cannot_cancel_in_progress_booking():
    from apps.wallet import services as wallet_services

    provider = make_user(role="PROVIDER")
    customer = make_user(role="CUSTOMER")
    service = make_published_service(provider)
    booking = booking_services.create_booking(customer, service_id=service.id)
    booking_services.transition_booking(provider, booking.id, to_status=BookingStatus.ACCEPTED)
    wallet_services.deposit(customer, amount=service.price)
    booking_services.fund_booking(customer, booking.id)
    booking_services.transition_booking(provider, booking.id, to_status=BookingStatus.IN_PROGRESS)
    with pytest.raises(InvalidStateTransitionError):
        booking_services.transition_booking(customer, booking.id, to_status=BookingStatus.CANCELLED)


# --- Double-transition / concurrency safety -------------------------------------

def test_double_accept_second_call_fails_cleanly():
    provider = make_user(role="PROVIDER")
    customer = make_user(role="CUSTOMER")
    service = make_published_service(provider)
    booking = booking_services.create_booking(customer, service_id=service.id)

    booking_services.transition_booking(provider, booking.id, to_status=BookingStatus.ACCEPTED)
    # A second "accept" against the now-ACCEPTED booking must be
    # rejected, not silently re-applied or double-logged.
    with pytest.raises(InvalidStateTransitionError):
        booking_services.transition_booking(provider, booking.id, to_status=BookingStatus.ACCEPTED)

    assert booking.events.filter(to_status=BookingStatus.ACCEPTED).count() == 1


def test_decline_rejected_once_already_accepted():
    """Simulates the outcome a real race should produce: once one
    transition has landed, a competing transition against the
    now-stale status must be rejected -- covering the same guard
    logic that select_for_update()'s row lock protects under real
    concurrent requests (see README's Known Gaps for why we can't
    exercise true multi-connection concurrency against SQLite here)."""
    provider = make_user(role="PROVIDER")
    customer = make_user(role="CUSTOMER")
    service = make_published_service(provider)
    booking = booking_services.create_booking(customer, service_id=service.id)

    booking_services.transition_booking(provider, booking.id, to_status=BookingStatus.ACCEPTED)
    with pytest.raises(InvalidStateTransitionError):
        booking_services.transition_booking(provider, booking.id, to_status=BookingStatus.DECLINED)

    booking.refresh_from_db()
    assert booking.status == BookingStatus.ACCEPTED
    assert booking.events.count() == 2  # initial PENDING + the one successful ACCEPTED


# --- Reviews -----------------------------------------------------------------------

def _complete_booking(provider, customer, service):
    from apps.wallet import services as wallet_services

    booking = booking_services.create_booking(customer, service_id=service.id)
    booking_services.transition_booking(provider, booking.id, to_status=BookingStatus.ACCEPTED)
    wallet_services.deposit(customer, amount=service.price)
    booking_services.fund_booking(customer, booking.id)
    booking_services.transition_booking(provider, booking.id, to_status=BookingStatus.IN_PROGRESS)
    booking_services.transition_booking(provider, booking.id, to_status=BookingStatus.COMPLETED)
    return booking


def test_review_requires_completed_booking():
    provider = make_user(role="PROVIDER")
    customer = make_user(role="CUSTOMER")
    service = make_published_service(provider)
    booking = booking_services.create_booking(customer, service_id=service.id)  # still PENDING

    with pytest.raises(DomainError):
        service_listing_services.create_review(customer, booking_id=booking.id, rating=5)


def test_only_customer_can_review(client):
    provider = make_user(role="PROVIDER")
    customer = make_user(role="CUSTOMER")
    service = make_published_service(provider)
    booking = _complete_booking(provider, customer, service)

    with pytest.raises(AccountNotEligibleError):
        service_listing_services.create_review(provider, booking_id=booking.id, rating=5)


def test_review_created_and_single_use(client):
    provider = make_user(role="PROVIDER")
    customer = make_user(role="CUSTOMER")
    service = make_published_service(provider)
    booking = _complete_booking(provider, customer, service)

    login(client, "customer@example.com")
    resp = client.post(reverse("bookings:review", args=[booking.id]), {"rating": 5, "comment": "Great job!"}, content_type="application/json")
    assert resp.status_code == 201

    resp2 = client.post(reverse("bookings:review", args=[booking.id]), {"rating": 4}, content_type="application/json")
    assert resp2.status_code == 400


def test_review_rating_out_of_range_rejected(client):
    provider = make_user(role="PROVIDER")
    customer = make_user(role="CUSTOMER")
    service = make_published_service(provider)
    booking = _complete_booking(provider, customer, service)
    login(client, "customer@example.com")
    resp = client.post(reverse("bookings:review", args=[booking.id]), {"rating": 6}, content_type="application/json")
    assert resp.status_code == 400

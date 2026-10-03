from django.db import transaction
from django.utils import timezone

from apps.common.constants import AccountRole, AccountStatus, BookingStatus, ContactPermission, ServiceStatus
from apps.common.exceptions import AccountNotEligibleError, DomainError, InvalidStateTransitionError
from apps.common.models import AuditAction, AuditLog
from apps.common.utils import clamp_page_size
from apps.services.models import Service
from apps.wallet import services as wallet_services

from .models import Booking, BookingEvent

# Who may move a booking FROM a given status TO another, and which
# role must be the actor. Never trust a client-submitted `to_status`
# without checking it against this table for the CURRENT persisted
# status (re-read under a row lock, not whatever the client thinks
# the current status is).
#
# NOTE: transitions that move money (ACCEPTED->FUNDED,
# COMPLETED->RELEASED, FUNDED->CANCELLED, DISPUTED->RELEASED/REFUNDED)
# are deliberately NOT in this table -- they're never reachable
# through the generic transition_booking()/`/transition/` endpoint.
# Each has its own dedicated function below that performs the same
# role/state checks under the same row lock, but also drives the
# wallet/escrow side effect atomically alongside the status change.
TRANSITIONS = {
    # (from_status): {to_status: required_role}
    BookingStatus.PENDING: {
        BookingStatus.ACCEPTED: "provider",
        BookingStatus.DECLINED: "provider",
        BookingStatus.CANCELLED: "customer",
    },
    BookingStatus.ACCEPTED: {
        BookingStatus.CANCELLED: "customer",  # unfunded -- nothing to refund
    },
    BookingStatus.FUNDED: {
        BookingStatus.IN_PROGRESS: "provider",
    },
    BookingStatus.IN_PROGRESS: {
        BookingStatus.COMPLETED: "provider",
    },
    BookingStatus.COMPLETED: {
        BookingStatus.DISPUTED: "customer",
    },
}


@transaction.atomic
def create_booking(customer, *, service_id, note_from_customer="", scheduled_for=None):
    if customer.status != AccountStatus.ACTIVE:
        raise AccountNotEligibleError("Your account is not eligible to book services.")

    try:
        service = Service.objects.select_related("provider", "provider__privacy").get(id=service_id)
    except Service.DoesNotExist as exc:
        raise DomainError("Service not found.") from exc

    if service.status != ServiceStatus.PUBLISHED:
        raise DomainError("This service is not currently available for booking.")
    if service.provider_id == customer.id:
        raise DomainError("You cannot book your own service.")
    if service.provider.privacy.who_can_send_service_requests == ContactPermission.NOBODY:
        raise AccountNotEligibleError("This provider is not currently accepting requests.")

    # Price is snapshotted NOW, from the service's current price, and
    # never recalculated later even if the provider changes the listed
    # price afterward -- see Booking's docstring.
    booking = Booking.objects.create(
        service=service,
        customer=customer,
        provider=service.provider,
        status=BookingStatus.PENDING,
        agreed_price=service.price,
        note_from_customer=note_from_customer,
        scheduled_for=scheduled_for,
    )
    _record_event(booking, actor=customer, from_status="", to_status=BookingStatus.PENDING)
    return booking


def _record_event(booking, *, actor, from_status, to_status, note=""):
    BookingEvent.objects.create(
        booking=booking, actor=actor, from_status=from_status, to_status=to_status, note=note
    )


def _actor_role(booking: Booking, user) -> str | None:
    if user.id == booking.customer_id:
        return "customer"
    if user.id == booking.provider_id:
        return "provider"
    return None


@transaction.atomic
def transition_booking(user, booking_id, *, to_status: str, note: str = ""):
    """The single entry point for every booking state change. Locks
    the row, re-reads the CURRENT status from the database (never
    trusts what the caller thinks it is), validates the transition is
    legal from that status, and validates the caller holds the
    required role for it -- so this is safe against two concurrent
    requests racing to transition the same booking (only one wins;
    the loser sees InvalidStateTransitionError against the
    now-updated status, not a corrupted double-transition)."""
    booking = Booking.objects.select_for_update().get(id=booking_id)

    role = _actor_role(booking, user)
    if role is None:
        raise AccountNotEligibleError("You are not a participant in this booking.")

    current = BookingStatus(booking.status)
    target = BookingStatus(to_status)

    allowed_for_status = TRANSITIONS.get(current, {})
    required_role = allowed_for_status.get(target)
    if required_role is None:
        raise InvalidStateTransitionError(f"Cannot move a booking from {current} to {target}.")
    if required_role != role:
        raise AccountNotEligibleError(f"Only the {required_role} can perform this action.")

    booking.status = target
    if target == BookingStatus.COMPLETED:
        booking.completed_at = timezone.now()
        booking.save(update_fields=["status", "completed_at", "updated_at"])
    else:
        booking.save(update_fields=["status", "updated_at"])

    _record_event(booking, actor=user, from_status=current, to_status=target, note=note)
    return booking


@transaction.atomic
def fund_booking(customer, booking_id) -> Booking:
    """ACCEPTED -> FUNDED. Moves the agreed price from the customer's
    wallet into escrow. Idempotency key is derived deterministically
    from the booking id, so a retried request against an
    already-funded booking is a no-op at the wallet layer -- though in
    practice the booking-row lock plus the ACCEPTED-only transition
    check below already prevents a second call from getting this far
    a second time; the deterministic key is defense in depth."""
    booking = Booking.objects.select_for_update().get(id=booking_id)

    if _actor_role(booking, customer) != "customer":
        raise AccountNotEligibleError("Only the customer can fund this booking.")
    current = BookingStatus(booking.status)
    if current != BookingStatus.ACCEPTED:
        raise InvalidStateTransitionError(f"Cannot fund a booking from {current}.")

    wallet_services.hold_escrow(customer, booking=booking, idempotency_key=f"escrow-hold:{booking.id}")

    booking.status = BookingStatus.FUNDED
    booking.save(update_fields=["status", "updated_at"])
    _record_event(booking, actor=customer, from_status=current, to_status=BookingStatus.FUNDED)
    return booking


@transaction.atomic
def release_booking_funds(customer, booking_id) -> Booking:
    """COMPLETED -> RELEASED. The customer confirms the work was done
    and releases escrow to the provider."""
    booking = Booking.objects.select_for_update().get(id=booking_id)

    if _actor_role(booking, customer) != "customer":
        raise AccountNotEligibleError("Only the customer can release payment for this booking.")
    current = BookingStatus(booking.status)
    if current != BookingStatus.COMPLETED:
        raise InvalidStateTransitionError(f"Cannot release funds for a booking in {current}.")

    wallet_services.release_escrow(booking)

    booking.status = BookingStatus.RELEASED
    booking.save(update_fields=["status", "updated_at"])
    _record_event(booking, actor=customer, from_status=current, to_status=BookingStatus.RELEASED)
    return booking


@transaction.atomic
def refund_cancelled_booking(customer, booking_id) -> Booking:
    """FUNDED -> CANCELLED, with a refund. Cancelling before funding
    goes through the plain transition_booking() path above since
    there's no escrow to unwind."""
    booking = Booking.objects.select_for_update().get(id=booking_id)

    if _actor_role(booking, customer) != "customer":
        raise AccountNotEligibleError("Only the customer can cancel this booking.")
    current = BookingStatus(booking.status)
    if current != BookingStatus.FUNDED:
        raise InvalidStateTransitionError(f"Cannot cancel-with-refund a booking in {current}.")

    wallet_services.refund_escrow(booking)

    booking.status = BookingStatus.CANCELLED
    booking.save(update_fields=["status", "updated_at"])
    _record_event(booking, actor=customer, from_status=current, to_status=BookingStatus.CANCELLED, note="Cancelled and refunded.")
    return booking


DISPUTE_RESOLUTIONS = {"RELEASE", "REFUND"}


@transaction.atomic
def resolve_dispute(staff_user, booking_id, *, resolution: str, reason: str = "") -> Booking:
    if not (staff_user.is_staff or staff_user.role in (AccountRole.MODERATOR, AccountRole.ADMIN)):
        raise AccountNotEligibleError("Only staff can resolve a dispute.")
    if resolution not in DISPUTE_RESOLUTIONS:
        raise DomainError(f"Resolution must be one of {sorted(DISPUTE_RESOLUTIONS)}.")

    booking = Booking.objects.select_for_update().get(id=booking_id)
    current = BookingStatus(booking.status)
    if current != BookingStatus.DISPUTED:
        raise InvalidStateTransitionError(f"Cannot resolve a dispute for a booking in {current}.")

    if resolution == "RELEASE":
        wallet_services.release_escrow(booking)
        target = BookingStatus.RELEASED
    else:
        wallet_services.refund_escrow(booking)
        target = BookingStatus.REFUNDED

    booking.status = target
    booking.save(update_fields=["status", "updated_at"])
    _record_event(booking, actor=staff_user, from_status=current, to_status=target, note=reason)
    AuditLog.objects.create(
        actor=staff_user, action=AuditAction.DISPUTE_RESOLVED, target_user=booking.customer,
        reason=reason, metadata={"booking_id": str(booking.id), "resolution": resolution},
    )
    return booking


def get_booking_for_participant(user, booking_id) -> Booking | None:
    try:
        booking = Booking.objects.select_related("service", "customer", "provider").get(id=booking_id)
    except Booking.DoesNotExist:
        return None
    if not booking.is_participant(user):
        return None
    return booking


BOOKING_LIST_ROLE_FILTERS = {"customer", "provider"}


def list_bookings_for_user(user, *, role_filter: str | None, status_filter: str | None, page_size=None):
    qs = Booking.objects.select_related("service", "customer", "provider")

    if role_filter == "customer":
        qs = qs.filter(customer=user)
    elif role_filter == "provider":
        qs = qs.filter(provider=user)
    else:
        from django.db.models import Q

        qs = qs.filter(Q(customer=user) | Q(provider=user))

    if status_filter:
        qs = qs.filter(status=status_filter)

    qs = qs.order_by("-created_at")
    return qs, clamp_page_size(page_size)

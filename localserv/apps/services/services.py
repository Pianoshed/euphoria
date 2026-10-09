from django.db import transaction

from apps.common.constants import AccountRole, BookingStatus, ServiceStatus
from apps.common.exceptions import AccountNotEligibleError, DomainError, InvalidStateTransitionError
from apps.common.models import AuditAction, AuditLog
from apps.common.utils import clamp_page_size, whitelist_ordering

from .models import Review, Service, ServiceCategory

LISTING_ALLOWED_ORDERING = ["created_at", "-created_at", "price", "-price"]

# Status transitions the OWNER may perform themselves. SUSPENDED is
# deliberately absent -- only staff can suspend a listing, and only
# staff can lift a suspension (see suspend_service/unsuspend_service).
OWNER_TRANSITIONS = {
    ServiceStatus.DRAFT: {ServiceStatus.PUBLISHED},
    ServiceStatus.PUBLISHED: {ServiceStatus.ARCHIVED, ServiceStatus.DRAFT},
    ServiceStatus.ARCHIVED: {ServiceStatus.DRAFT},
}


def create_service(
    provider, *, category_id, title, description, price, service_area="", is_plan=False,
    capacity=None, scheduled_at=None, location="", cancellation_policy="FULL_REFUND", platform_fee_rate=None,
):
    if provider.role != AccountRole.PROVIDER:
        raise AccountNotEligibleError("Only provider accounts can create service listings.")
    try:
        category = ServiceCategory.objects.get(id=category_id, is_active=True)
    except ServiceCategory.DoesNotExist as exc:
        raise DomainError("Selected category is not available.") from exc
    if price < 0:
        raise DomainError("Price cannot be negative.")
    if is_plan and price <= 0:
        raise DomainError("A paid Euphoria Plan must have a price greater than zero.")
    if is_plan and capacity is not None and capacity < 1:
        raise DomainError("Plan capacity must be at least 1.")
    if cancellation_policy not in {"FULL_REFUND", "PARTIAL_REFUND", "NO_REFUND"}:
        raise DomainError("Invalid cancellation policy.")

    return Service.objects.create(
        provider=provider,
        category=category,
        title=title,
        description=description,
        price=price,
        service_area=service_area,
        is_plan=is_plan,
        capacity=capacity,
        scheduled_at=scheduled_at,
        location=location,
        cancellation_policy=cancellation_policy,
        platform_fee_rate=platform_fee_rate,
    )


SERVICE_UPDATABLE_FIELDS = {"title", "description", "price", "service_area", "category_id"}


def update_service(user, service: Service, **fields):
    _require_owner(user, service)
    target_is_plan = fields.get("is_plan", service.is_plan)
    if "price" in fields and fields["price"] < 0:
        raise DomainError("Price cannot be negative.")
    if target_is_plan and "price" in fields and fields["price"] <= 0:
        raise DomainError("A paid Euphoria Plan must have a price greater than zero.")
    if target_is_plan and "capacity" in fields and fields["capacity"] is not None and fields["capacity"] < 1:
        raise DomainError("Plan capacity must be at least 1.")
    if "category_id" in fields:
        try:
            fields["category"] = ServiceCategory.objects.get(id=fields.pop("category_id"), is_active=True)
        except ServiceCategory.DoesNotExist as exc:
            raise DomainError("Selected category is not available.") from exc
    for field, value in fields.items():
        setattr(service, field, value)
    service.full_clean(exclude=["provider"])
    service.save()
    return service


def _require_owner(user, service: Service):
    if not user.is_authenticated or service.provider_id != user.id:
        raise AccountNotEligibleError("You do not own this listing.")


@transaction.atomic
def transition_service_status(user, service_id, *, to_status: str):
    service = Service.objects.select_for_update().get(id=service_id)
    _require_owner(user, service)

    current = ServiceStatus(service.status)
    target = ServiceStatus(to_status)
    allowed = OWNER_TRANSITIONS.get(current, set())
    if target not in allowed:
        raise InvalidStateTransitionError(f"Cannot move a listing from {current} to {target}.")

    service.status = target
    service.save(update_fields=["status", "updated_at"])
    return service


@transaction.atomic
def suspend_service(staff_user, service_id, *, reason: str = ""):
    if not (staff_user.is_staff or staff_user.role in (AccountRole.MODERATOR, AccountRole.ADMIN)):
        raise AccountNotEligibleError("Only staff can suspend a listing.")
    if not reason.strip():
        raise DomainError("A reason is required to suspend a listing.")
    service = Service.objects.select_for_update().get(id=service_id)
    service.status = ServiceStatus.SUSPENDED
    service.save(update_fields=["status", "updated_at"])
    AuditLog.objects.create(
        actor=staff_user, action=AuditAction.LISTING_SUSPENDED, target_user=service.provider,
        reason=reason, metadata={"service_id": str(service.id), "title": service.title},
    )
    return service


@transaction.atomic
def unsuspend_service(staff_user, service_id):
    if not (staff_user.is_staff or staff_user.role in (AccountRole.MODERATOR, AccountRole.ADMIN)):
        raise AccountNotEligibleError("Only staff can lift a suspension.")
    service = Service.objects.select_for_update().get(id=service_id)
    if service.status != ServiceStatus.SUSPENDED:
        raise InvalidStateTransitionError("This listing is not suspended.")
    service.status = ServiceStatus.DRAFT
    service.save(update_fields=["status", "updated_at"])
    AuditLog.objects.create(
        actor=staff_user, action=AuditAction.LISTING_UNSUSPENDED, target_user=service.provider,
        metadata={"service_id": str(service.id), "title": service.title},
    )
    return service


def get_visible_service(viewer, service_id) -> Service | None:
    """Returns the service if the viewer may see it: PUBLISHED is
    public, any other status is owner/staff-only. Returns None rather
    than raising so callers can render a uniform 404."""
    try:
        service = Service.objects.select_related("provider", "category").get(id=service_id)
    except Service.DoesNotExist:
        return None

    is_owner = bool(viewer and viewer.is_authenticated and viewer.id == service.provider_id)
    is_staff = bool(viewer and viewer.is_authenticated and (viewer.is_staff or viewer.role in (AccountRole.MODERATOR, AccountRole.ADMIN)))
    if service.status == ServiceStatus.PUBLISHED or is_owner or is_staff:
        return service
    return None


def list_services(viewer, *, category_id=None, provider_id=None, query="", ordering=None, page_size=None, mine=False):
    qs = Service.objects.select_related("provider", "category")

    if mine:
        if not (viewer and viewer.is_authenticated):
            raise AccountNotEligibleError("You must be logged in to view your own listings.")
        qs = qs.filter(provider=viewer)
    else:
        qs = qs.filter(status=ServiceStatus.PUBLISHED)

    if category_id:
        qs = qs.filter(category_id=category_id)
    if provider_id:
        qs = qs.filter(provider_id=provider_id)

    query = (query or "").strip()[:100]
    if query:
        qs = qs.filter(title__icontains=query)

    order = whitelist_ordering(ordering, LISTING_ALLOWED_ORDERING, default="-created_at")
    qs = qs.order_by(order)

    return qs, clamp_page_size(page_size)


# --- Reviews ---------------------------------------------------------------------

@transaction.atomic
def create_review(customer, *, booking_id, rating, comment=""):
    # Local import: avoids a module-load-time circular import (bookings
    # references services.Service via a lazy string FK, not a direct
    # import, so this direction -- services importing bookings -- is
    # safe as long as it happens inside the function, not at the top).
    from apps.bookings.models import Booking

    try:
        booking = Booking.objects.select_for_update().select_related("service").get(id=booking_id)
    except Booking.DoesNotExist as exc:
        raise DomainError("Booking not found.") from exc

    if booking.customer_id != customer.id:
        raise AccountNotEligibleError("Only the customer on this booking can leave a review.")
    if booking.status != BookingStatus.COMPLETED:
        raise DomainError("You can only review a completed booking.")
    if Review.objects.filter(booking=booking).exists():
        raise DomainError("This booking has already been reviewed.")

    return Review.objects.create(
        booking=booking, reviewer=customer, service=booking.service, rating=rating, comment=comment,
    )


def list_reviews_for_service(service_id):
    return Review.objects.filter(service_id=service_id).select_related("reviewer").order_by("-created_at")
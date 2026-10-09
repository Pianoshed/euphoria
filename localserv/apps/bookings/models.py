import uuid

from django.conf import settings
from django.db import models

from apps.common.constants import BookingStatus
from apps.common.models import BaseModel


class Booking(BaseModel):
    """
    A customer's request to have a provider perform a Service.

    Key invariants (enforced in apps.bookings.services, never in a
    view or by trusting client-submitted fields):
    - `status` only ever changes through a validated transition
    - `agreed_price` is a snapshot taken at creation time and never
      recalculated from the service's current price -- the service's
      price can change after a booking exists without affecting it
    - `customer`/`provider`/`service` are set once at creation and
      never mutated
    """

    service = models.ForeignKey(
        "services.Service", on_delete=models.PROTECT, related_name="bookings"
    )
    customer = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="bookings_as_customer"
    )
    provider = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="bookings_as_provider"
    )

    status = models.CharField(max_length=20, choices=BookingStatus.choices, default=BookingStatus.PENDING)
    # `agreed_price` remains the legacy unit price field. The fields below are
    # immutable financial snapshots used by the Euphoria transaction layer.
    agreed_price = models.DecimalField(max_digits=10, decimal_places=2)
    quantity = models.PositiveIntegerField(default=1)
    unit_price = models.DecimalField(max_digits=12, decimal_places=2, null=True, blank=True)
    gross_amount = models.DecimalField(max_digits=12, decimal_places=2, null=True, blank=True)
    platform_fee_rate = models.DecimalField(max_digits=7, decimal_places=4, null=True, blank=True)
    platform_fee_amount = models.DecimalField(max_digits=12, decimal_places=2, null=True, blank=True)
    planner_amount = models.DecimalField(max_digits=12, decimal_places=2, null=True, blank=True)
    currency = models.CharField(max_length=3, default="NGN")
    payment_source = models.CharField(max_length=30, default="WALLET")
    purchase_idempotency_key = models.CharField(max_length=100, null=True, blank=True, unique=True)
    note_from_customer = models.CharField(max_length=500, blank=True)

    scheduled_for = models.DateTimeField(null=True, blank=True)
    completed_at = models.DateTimeField(null=True, blank=True)

    class Meta(BaseModel.Meta):
        db_table = "bookings_booking"
        indexes = [
            models.Index(fields=["customer", "status"]),
            models.Index(fields=["provider", "status"]),
        ]

    def __str__(self):
        return f"Booking {self.id} ({self.status})"

    def is_participant(self, user) -> bool:
        return user is not None and user.is_authenticated and user.id in (self.customer_id, self.provider_id)


class BookingEvent(models.Model):
    """Append-only audit trail of every state transition. Never
    updated or deleted -- write-once, read-many."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    booking = models.ForeignKey(Booking, on_delete=models.CASCADE, related_name="events")
    actor = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, related_name="booking_events"
    )
    from_status = models.CharField(max_length=20, blank=True)
    to_status = models.CharField(max_length=20)
    note = models.CharField(max_length=500, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "bookings_booking_event"
        ordering = ["created_at"]
        indexes = [models.Index(fields=["booking"])]

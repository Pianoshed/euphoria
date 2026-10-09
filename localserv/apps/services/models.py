import uuid

from django.conf import settings
from django.db import models

from apps.common.constants import ServiceStatus
from apps.common.models import BaseModel


class ServiceCategory(models.Model):
    """Managed by staff only (admin panel) -- not user-creatable, so
    the category list can't be spammed or used to bypass content
    moderation via arbitrary category names."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=60, unique=True)
    slug = models.SlugField(max_length=70, unique=True)
    description = models.CharField(max_length=200, blank=True)
    # One emoji shown next to the name in the app, so categories are easy to tell apart at a glance.
    icon = models.CharField(max_length=8, blank=True, default="")
    is_active = models.BooleanField(default=True)

    class Meta:
        db_table = "services_category"
        ordering = ["name"]

    def __str__(self):
        return self.name


class Service(BaseModel):
    """A provider's listing. `status` is never settable directly from
    client-submitted JSON -- only through the dedicated
    publish/archive/suspend service functions, each of which validates
    the transition and who's allowed to make it (see
    apps.services.services)."""

    provider = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="services"
    )
    category = models.ForeignKey(
        ServiceCategory, on_delete=models.PROTECT, related_name="services"
    )

    title = models.CharField(max_length=100)
    description = models.TextField(max_length=3000)
    price = models.DecimalField(max_digits=10, decimal_places=2)
    service_area = models.CharField(max_length=100, blank=True)

    # Plan/experience fields. Existing services remain valid because these are
    # optional and `is_plan=False` preserves the old marketplace semantics.
    is_plan = models.BooleanField(default=False)
    capacity = models.PositiveIntegerField(null=True, blank=True)
    scheduled_at = models.DateTimeField(null=True, blank=True)
    location = models.CharField(max_length=255, blank=True)
    cancellation_policy = models.CharField(max_length=30, default="FULL_REFUND")
    platform_fee_rate = models.DecimalField(max_digits=7, decimal_places=4, null=True, blank=True)

    status = models.CharField(max_length=20, choices=ServiceStatus.choices, default=ServiceStatus.DRAFT)

    class Meta(BaseModel.Meta):
        db_table = "services_service"
        indexes = [
            models.Index(fields=["status", "category"]),
            models.Index(fields=["provider"]),
        ]

    def __str__(self):
        return self.title


class Review(BaseModel):
    """One review per booking, written by the customer only, only
    after the booking reaches COMPLETED. Enforced in
    apps.services.services.create_review, backed by a DB uniqueness
    constraint on `booking` as the real invariant."""

    booking = models.OneToOneField(
        "bookings.Booking", on_delete=models.CASCADE, related_name="review"
    )
    reviewer = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="reviews_written"
    )
    service = models.ForeignKey(Service, on_delete=models.CASCADE, related_name="reviews")
    rating = models.PositiveSmallIntegerField()
    comment = models.CharField(max_length=1000, blank=True)

    class Meta(BaseModel.Meta):
        db_table = "services_review"
        constraints = [
            models.CheckConstraint(condition=models.Q(rating__gte=1) & models.Q(rating__lte=5), name="review_rating_1_to_5"),
        ]
        indexes = [models.Index(fields=["service"])]

    def __str__(self):
        return f"{self.rating}\u2605 for {self.service_id}"

import uuid
from decimal import Decimal

from django.conf import settings
from django.db import models

from apps.common.models import BaseModel


class TransactionStatus(models.TextChoices):
    PENDING = "PENDING", "Pending"
    PAID = "PAID", "Paid"
    HELD = "HELD", "Held"
    COMPLETED = "COMPLETED", "Completed"
    SETTLED = "SETTLED", "Settled"
    REFUNDED = "REFUNDED", "Refunded"
    PARTIALLY_REFUNDED = "PARTIALLY_REFUNDED", "Partially refunded"
    CANCELLED = "CANCELLED", "Cancelled"
    DISPUTED = "DISPUTED", "Disputed"
    FAILED = "FAILED", "Failed"


class EarningStatus(models.TextChoices):
    PENDING = "PENDING", "Pending"
    AVAILABLE = "AVAILABLE", "Available"
    PAID_OUT = "PAID_OUT", "Paid out"
    REVERSED = "REVERSED", "Reversed"
    REFUNDED = "REFUNDED", "Refunded"


class GiftStatus(models.TextChoices):
    PENDING = "PENDING", "Pending"
    ACCEPTED = "ACCEPTED", "Accepted"
    DECLINED = "DECLINED", "Declined"
    EXPIRED = "EXPIRED", "Expired"


class TransactionOrder(BaseModel):
    """Immutable financial snapshot for a booking.

    Booking remains the operational state machine; this model is the
    financial order record so historical pricing/fee data never depends
    on today's Service configuration.
    """

    buyer = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="economy_orders_as_buyer")
    planner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="economy_orders_as_planner")
    plan = models.ForeignKey("services.Service", on_delete=models.PROTECT, related_name="economy_orders")
    booking = models.OneToOneField("bookings.Booking", on_delete=models.PROTECT, related_name="transaction_order")
    quantity = models.PositiveIntegerField(default=1)
    unit_price = models.DecimalField(max_digits=12, decimal_places=2)
    gross_amount = models.DecimalField(max_digits=12, decimal_places=2)
    platform_fee_rate = models.DecimalField(max_digits=7, decimal_places=4, default=Decimal("15.0000"))
    platform_fee_amount = models.DecimalField(max_digits=12, decimal_places=2)
    planner_amount = models.DecimalField(max_digits=12, decimal_places=2)
    currency = models.CharField(max_length=3, default="NGN")
    payment_source = models.CharField(max_length=30, default="WALLET")
    status = models.CharField(max_length=24, choices=TransactionStatus.choices, default=TransactionStatus.PENDING)
    idempotency_key = models.CharField(max_length=100, unique=True)
    settled_at = models.DateTimeField(null=True, blank=True)
    refunded_amount = models.DecimalField(max_digits=12, decimal_places=2, default=Decimal("0.00"))

    class Meta(BaseModel.Meta):
        db_table = "economy_transaction_order"
        constraints = [
            models.CheckConstraint(condition=models.Q(quantity__gt=0), name="economy_order_quantity_positive"),
            models.CheckConstraint(condition=models.Q(unit_price__gte=0), name="economy_order_unit_price_non_negative"),
            models.CheckConstraint(condition=models.Q(gross_amount__gte=0), name="economy_order_gross_non_negative"),
            models.CheckConstraint(condition=models.Q(platform_fee_rate__gte=0) & models.Q(platform_fee_rate__lte=100), name="economy_order_fee_rate_valid"),
            models.CheckConstraint(condition=models.Q(platform_fee_amount__gte=0), name="economy_order_fee_non_negative"),
            models.CheckConstraint(condition=models.Q(planner_amount__gte=0), name="economy_order_planner_non_negative"),
            models.CheckConstraint(condition=models.Q(refunded_amount__gte=0), name="economy_order_refunded_non_negative"),
        ]
        indexes = [
            models.Index(fields=["buyer", "created_at"]),
            models.Index(fields=["planner", "status"]),
            models.Index(fields=["plan", "status"]),
        ]


class PlannerEarning(BaseModel):
    """A settlement entitlement for a planner.

    This is intentionally separate from Wallet so planner earnings cannot
    silently become customer spending balance.
    """

    planner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="planner_earnings")
    order = models.OneToOneField(TransactionOrder, on_delete=models.PROTECT, related_name="planner_earning")
    gross_amount = models.DecimalField(max_digits=12, decimal_places=2)
    platform_fee = models.DecimalField(max_digits=12, decimal_places=2)
    net_amount = models.DecimalField(max_digits=12, decimal_places=2)
    status = models.CharField(max_length=20, choices=EarningStatus.choices, default=EarningStatus.PENDING)
    withdrawn_amount = models.DecimalField(max_digits=12, decimal_places=2, default=Decimal("0.00"))
    refunded_amount = models.DecimalField(max_digits=12, decimal_places=2, default=Decimal("0.00"))
    reserved_amount = models.DecimalField(max_digits=12, decimal_places=2, default=Decimal("0.00"))
    reservation_key = models.CharField(max_length=100, blank=True, default="")
    available_at = models.DateTimeField(null=True, blank=True)
    settled_at = models.DateTimeField(null=True, blank=True)
    reversed_at = models.DateTimeField(null=True, blank=True)

    class Meta(BaseModel.Meta):
        db_table = "economy_planner_earning"
        constraints = [
            models.CheckConstraint(condition=models.Q(gross_amount__gte=0), name="economy_earning_gross_non_negative"),
            models.CheckConstraint(condition=models.Q(platform_fee__gte=0), name="economy_earning_fee_non_negative"),
            models.CheckConstraint(condition=models.Q(net_amount__gte=0), name="economy_earning_net_non_negative"),
            models.CheckConstraint(condition=models.Q(withdrawn_amount__gte=0), name="economy_earning_withdrawn_non_negative"),
            models.CheckConstraint(condition=models.Q(refunded_amount__gte=0), name="economy_earning_refunded_non_negative"),
            models.CheckConstraint(condition=models.Q(reserved_amount__gte=0), name="economy_earning_reserved_non_negative"),
        ]
        indexes = [models.Index(fields=["planner", "status", "created_at"])]

    @property
    def available_balance(self):
        if self.status != EarningStatus.AVAILABLE:
            return Decimal("0.00")
        return max(Decimal("0.00"), self.net_amount - self.withdrawn_amount - self.refunded_amount - self.reserved_amount)


class PlatformFeeSetting(BaseModel):
    """Configurable default/category/plan fee. Only one global default is expected."""

    name = models.CharField(max_length=80, unique=True)
    rate = models.DecimalField(max_digits=7, decimal_places=4, default=Decimal("15.0000"))
    category = models.ForeignKey("services.ServiceCategory", on_delete=models.CASCADE, null=True, blank=True, related_name="platform_fee_settings")
    is_active = models.BooleanField(default=True)

    class Meta(BaseModel.Meta):
        db_table = "economy_platform_fee_setting"
        constraints = [
            models.CheckConstraint(condition=models.Q(rate__gte=0) & models.Q(rate__lte=100), name="economy_fee_setting_rate_valid"),
        ]


class GiftTransaction(BaseModel):
    sender = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="gifts_sent")
    recipient = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="gifts_received")
    amount = models.DecimalField(max_digits=12, decimal_places=2)
    message = models.CharField(max_length=500, blank=True)
    status = models.CharField(max_length=20, choices=GiftStatus.choices, default=GiftStatus.PENDING)
    idempotency_key = models.CharField(max_length=100, unique=True)
    expires_at = models.DateTimeField(null=True, blank=True)
    accepted_at = models.DateTimeField(null=True, blank=True)
    declined_at = models.DateTimeField(null=True, blank=True)
    reference = models.UUIDField(default=uuid.uuid4, unique=True, editable=False)

    class Meta(BaseModel.Meta):
        db_table = "economy_gift_transaction"
        constraints = [models.CheckConstraint(condition=models.Q(amount__gt=0), name="economy_gift_amount_positive")]

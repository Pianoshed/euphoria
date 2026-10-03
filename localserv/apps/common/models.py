import uuid

from django.db import models


class UUIDModel(models.Model):
    """Abstract base: UUID primary key instead of sequential ints.

    Prevents ID enumeration on public-facing endpoints (services,
    bookings, etc.). Internal-only tables may still use BigAutoField
    where a UUID adds no value.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    class Meta:
        abstract = True


class TimeStampedModel(models.Model):
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        abstract = True


class BaseModel(UUIDModel, TimeStampedModel):
    class Meta:
        abstract = True


class AuditAction(models.TextChoices):
    WALLET_ADMIN_ADJUSTMENT = "WALLET_ADMIN_ADJUSTMENT", "Wallet admin adjustment"
    ESCROW_HELD = "ESCROW_HELD", "Escrow held"
    ESCROW_RELEASED = "ESCROW_RELEASED", "Escrow released"
    ESCROW_REFUNDED = "ESCROW_REFUNDED", "Escrow refunded"
    DISPUTE_RESOLVED = "DISPUTE_RESOLVED", "Dispute resolved"
    WITHDRAWAL_REVERSED = "WITHDRAWAL_REVERSED", "Withdrawal reversed"
    ACCOUNT_SUSPENDED = "ACCOUNT_SUSPENDED", "Account suspended"
    ACCOUNT_BANNED = "ACCOUNT_BANNED", "Account banned"
    ACCOUNT_REINSTATED = "ACCOUNT_REINSTATED", "Account reinstated"
    LISTING_SUSPENDED = "LISTING_SUSPENDED", "Listing suspended"
    LISTING_UNSUSPENDED = "LISTING_UNSUSPENDED", "Listing unsuspended"
    REPORT_RESOLVED = "REPORT_RESOLVED", "Report resolved"
    REPORT_DISMISSED = "REPORT_DISMISSED", "Report dismissed"


class AuditLog(models.Model):
    """Immutable audit trail covering staff-initiated actions that
    move money or override normal state: wallet adjustments, escrow/
    dispute resolution, withdrawal reversal (Phase 5/6), and account/
    listing/report moderation actions (Phase 8). Login events and
    other non-staff-initiated security events are still out of scope
    -- see the top-level README's Known Gaps for what remains.
    Never updated after creation."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    actor = models.ForeignKey(
        "accounts.User", on_delete=models.SET_NULL, null=True, related_name="audit_logs_performed"
    )
    action = models.CharField(max_length=30, choices=AuditAction.choices)
    target_user = models.ForeignKey(
        "accounts.User", on_delete=models.SET_NULL, null=True, blank=True, related_name="audit_logs_targeting"
    )
    amount = models.DecimalField(max_digits=12, decimal_places=2, null=True, blank=True)
    reason = models.CharField(max_length=500, blank=True)
    metadata = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "common_audit_log"
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["action", "created_at"])]

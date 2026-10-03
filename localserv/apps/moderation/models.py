from django.conf import settings
from django.db import models

from apps.common.models import BaseModel


class ReportTargetType(models.TextChoices):
    USER = "USER", "User"
    SERVICE = "SERVICE", "Service listing"
    MESSAGE = "MESSAGE", "Chat message"


class ReportReason(models.TextChoices):
    SPAM = "SPAM", "Spam"
    HARASSMENT = "HARASSMENT", "Harassment or abuse"
    FRAUD = "FRAUD", "Fraud or scam"
    PROHIBITED_CONTENT = "PROHIBITED_CONTENT", "Prohibited content"
    IMPERSONATION = "IMPERSONATION", "Impersonation"
    OTHER = "OTHER", "Other"


class ReportStatus(models.TextChoices):
    OPEN = "OPEN", "Open"
    RESOLVED = "RESOLVED", "Resolved"
    DISMISSED = "DISMISSED", "Dismissed"


class Report(BaseModel):
    """
    A user-submitted report against a user, a service listing, or a
    chat message. `target_id` is a plain UUID rather than a
    GenericForeignKey -- the three target models (User, Service,
    Message) all use UUID primary keys already, and a plain FK-less
    reference avoids pulling in django.contrib.contenttypes for what
    is, so far, exactly three known target types. Existence of the
    target is validated in apps.moderation.services.create_report at
    creation time, not enforced by the database (there's no single
    table it could reasonably FK to).
    """

    reporter = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="reports_filed")
    target_type = models.CharField(max_length=10, choices=ReportTargetType.choices)
    target_id = models.UUIDField()
    reason = models.CharField(max_length=20, choices=ReportReason.choices)
    detail = models.CharField(max_length=1000, blank=True)

    status = models.CharField(max_length=10, choices=ReportStatus.choices, default=ReportStatus.OPEN)
    resolved_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="reports_resolved"
    )
    resolved_at = models.DateTimeField(null=True, blank=True)
    resolution_note = models.CharField(max_length=1000, blank=True)

    class Meta(BaseModel.Meta):
        db_table = "moderation_report"
        indexes = [
            models.Index(fields=["status", "created_at"]),
            models.Index(fields=["target_type", "target_id"]),
        ]

    def __str__(self):
        return f"Report({self.target_type}:{self.target_id}) by {self.reporter_id} [{self.status}]"

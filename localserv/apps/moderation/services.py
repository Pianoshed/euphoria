from django.db import transaction
from django.utils import timezone

from apps.accounts.models import User
from apps.common.constants import AccountRole
from apps.common.exceptions import AccountNotEligibleError, DomainError
from apps.common.models import AuditAction, AuditLog
from apps.common.utils import clamp_page_size, whitelist_ordering

from .models import Report, ReportStatus, ReportTargetType


def _is_staff(user) -> bool:
    return bool(user.is_staff or user.role in (AccountRole.MODERATOR, AccountRole.ADMIN))


def _target_exists(target_type: str, target_id) -> bool:
    if target_type == ReportTargetType.USER:
        return User.objects.filter(id=target_id).exists()
    if target_type == ReportTargetType.SERVICE:
        from apps.services.models import Service

        return Service.objects.filter(id=target_id).exists()
    if target_type == ReportTargetType.MESSAGE:
        from apps.chat.models import Message

        return Message.objects.filter(id=target_id).exists()
    return False


def create_report(reporter, *, target_type: str, target_id, reason: str, detail: str = "") -> Report:
    if target_type == ReportTargetType.USER and str(target_id) == str(reporter.id):
        raise DomainError("You cannot report yourself.")
    if not _target_exists(target_type, target_id):
        raise DomainError("The thing you're trying to report could not be found.")

    return Report.objects.create(
        reporter=reporter, target_type=target_type, target_id=target_id, reason=reason, detail=detail,
    )


REPORT_LIST_ALLOWED_ORDERING = ["created_at", "-created_at"]


def list_reports(staff_user, *, status_filter: str | None, target_type_filter: str | None, ordering=None, page_size=None):
    if not _is_staff(staff_user):
        raise AccountNotEligibleError("Only staff can view reports.")
    qs = Report.objects.select_related("reporter", "resolved_by")
    if status_filter:
        qs = qs.filter(status=status_filter)
    if target_type_filter:
        qs = qs.filter(target_type=target_type_filter)
    order = whitelist_ordering(ordering, REPORT_LIST_ALLOWED_ORDERING, default="-created_at")
    qs = qs.order_by(order)
    return qs, clamp_page_size(page_size)


def get_report_for_staff(staff_user, report_id) -> Report:
    if not _is_staff(staff_user):
        raise AccountNotEligibleError("Only staff can view reports.")
    try:
        return Report.objects.select_related("reporter", "resolved_by").get(id=report_id)
    except Report.DoesNotExist as exc:
        raise DomainError("Report not found.") from exc


@transaction.atomic
def resolve_report(staff_user, report_id, *, resolution: str, note: str = "") -> Report:
    if not _is_staff(staff_user):
        raise AccountNotEligibleError("Only staff can resolve reports.")
    if resolution not in (ReportStatus.RESOLVED, ReportStatus.DISMISSED):
        raise DomainError("Resolution must be RESOLVED or DISMISSED.")

    try:
        report = Report.objects.select_for_update().get(id=report_id)
    except Report.DoesNotExist as exc:
        raise DomainError("Report not found.") from exc

    if report.status != ReportStatus.OPEN:
        raise DomainError("This report has already been resolved.")

    report.status = resolution
    report.resolved_by = staff_user
    report.resolved_at = timezone.now()
    report.resolution_note = note
    report.save(update_fields=["status", "resolved_by", "resolved_at", "resolution_note", "updated_at"])

    action = AuditAction.REPORT_RESOLVED if resolution == ReportStatus.RESOLVED else AuditAction.REPORT_DISMISSED
    AuditLog.objects.create(
        actor=staff_user, action=action, reason=note,
        metadata={"report_id": str(report.id), "target_type": report.target_type, "target_id": str(report.target_id)},
    )
    return report

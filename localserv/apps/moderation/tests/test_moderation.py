import pytest
from django.urls import reverse

from apps.accounts.models import User, UserSession
from apps.accounts import services as account_services
from apps.common.constants import AccountStatus, ServiceStatus
from apps.common.exceptions import AccountNotEligibleError, DomainError
from apps.common.models import AuditLog
from apps.moderation import services as moderation_services
from apps.moderation.models import Report, ReportStatus
from apps.services.models import Service, ServiceCategory
from apps.services import services as service_listing_services

pytestmark = pytest.mark.django_db


def make_user(role="CUSTOMER", **kwargs):
    defaults = dict(email=f"{role.lower()}@example.com", username=f"{role.lower()}user", password="a-strong-password-1", role=role)
    defaults.update(kwargs)
    user = User.objects.create_user(**defaults)
    user.mark_email_verified()
    return user


def make_staff(**kwargs):
    staff = make_user(role="ADMIN", **kwargs)
    staff.is_staff = True
    staff.save()
    return staff


def login(client, email="customer@example.com", password="a-strong-password-1"):
    return client.post(reverse("accounts:login"), {"email": email, "password": password}, content_type="application/json")


# --- Report creation ---------------------------------------------------------------

def test_create_report_against_user(client):
    reporter = make_user()
    target = make_user(role="PROVIDER")
    login(client)
    resp = client.post(
        reverse("moderation:reports"),
        {"target_type": "USER", "target_id": str(target.id), "reason": "HARASSMENT", "detail": "Sent threats."},
        content_type="application/json",
    )
    assert resp.status_code == 201
    assert Report.objects.count() == 1


def test_cannot_report_self(client):
    reporter = make_user()
    login(client)
    resp = client.post(
        reverse("moderation:reports"),
        {"target_type": "USER", "target_id": str(reporter.id), "reason": "SPAM"},
        content_type="application/json",
    )
    assert resp.status_code == 400


def test_report_nonexistent_target_rejected(client):
    make_user()
    login(client)
    import uuid

    resp = client.post(
        reverse("moderation:reports"),
        {"target_type": "USER", "target_id": str(uuid.uuid4()), "reason": "SPAM"},
        content_type="application/json",
    )
    assert resp.status_code == 400


def test_report_against_service(client):
    provider = make_user(role="PROVIDER")
    category = ServiceCategory.objects.create(name="Cleaning", slug="cleaning")
    listing = Service.objects.create(provider=provider, category=category, title="Clean", description="x", price=50, status=ServiceStatus.PUBLISHED)
    reporter = make_user()
    login(client)
    resp = client.post(
        reverse("moderation:reports"),
        {"target_type": "SERVICE", "target_id": str(listing.id), "reason": "FRAUD", "detail": "Never showed up."},
        content_type="application/json",
    )
    assert resp.status_code == 201


# --- Staff-only listing/resolution ----------------------------------------------

def test_non_staff_cannot_list_reports():
    reporter = make_user()
    target = make_user(role="PROVIDER")
    moderation_services.create_report(reporter, target_type="USER", target_id=target.id, reason="SPAM")
    with pytest.raises(AccountNotEligibleError):
        moderation_services.list_reports(reporter, status_filter=None, target_type_filter=None)


def test_staff_can_list_and_resolve_report(client):
    reporter = make_user()
    target = make_user(role="PROVIDER")
    report = moderation_services.create_report(reporter, target_type="USER", target_id=target.id, reason="SPAM")

    staff = make_staff(email="admin@example.com", username="adminuser")
    login(client, "admin@example.com")

    resp = client.get(reverse("moderation:reports"), {"status": "OPEN"})
    assert resp.status_code == 200
    assert len(resp.json()["results"]) == 1

    resp2 = client.post(
        reverse("moderation:report-resolve", args=[report.id]),
        {"resolution": "DISMISSED", "note": "No policy violation found."},
        content_type="application/json",
    )
    assert resp2.status_code == 200
    assert resp2.json()["status"] == "DISMISSED"
    assert AuditLog.objects.filter(action="REPORT_DISMISSED").exists()


def test_cannot_resolve_report_twice():
    reporter = make_user()
    target = make_user(role="PROVIDER")
    report = moderation_services.create_report(reporter, target_type="USER", target_id=target.id, reason="SPAM")
    staff = make_staff(email="admin2@example.com", username="admin2user")
    moderation_services.resolve_report(staff, report.id, resolution="RESOLVED", note="Actioned.")
    with pytest.raises(DomainError):
        moderation_services.resolve_report(staff, report.id, resolution="DISMISSED", note="too late")


# --- Account suspend/ban/reinstate -----------------------------------------------

def test_suspend_account_revokes_sessions_and_blocks_login(client):
    target = make_user()
    login(client)  # creates a session for target
    assert UserSession.objects.filter(user=target, revoked_at__isnull=True).exists()

    staff = make_staff(email="admin3@example.com", username="admin3user")
    account_services.suspend_account(staff, target.id, reason="Repeated ToS violations.")

    target.refresh_from_db()
    assert target.status == AccountStatus.SUSPENDED
    assert not UserSession.objects.filter(user=target, revoked_at__isnull=True).exists()

    client.post(reverse("accounts:logout"))
    resp = login(client)
    assert resp.status_code == 400  # login blocked for non-ACTIVE accounts


def test_suspend_requires_reason():
    target = make_user()
    staff = make_staff(email="admin4@example.com", username="admin4user")
    with pytest.raises(DomainError):
        account_services.suspend_account(staff, target.id, reason="")


def test_non_staff_cannot_suspend_account():
    target = make_user()
    other = make_user(role="PROVIDER")
    with pytest.raises(AccountNotEligibleError):
        account_services.suspend_account(other, target.id, reason="trying to abuse this")


def test_ban_account_and_reinstate():
    target = make_user()
    staff = make_staff(email="admin5@example.com", username="admin5user")

    account_services.ban_account(staff, target.id, reason="Fraudulent activity confirmed.")
    target.refresh_from_db()
    assert target.status == AccountStatus.BANNED

    account_services.reinstate_account(staff, target.id, reason="Appeal successful.")
    target.refresh_from_db()
    assert target.status == AccountStatus.ACTIVE


def test_cannot_reinstate_active_account():
    target = make_user()
    staff = make_staff(email="admin6@example.com", username="admin6user")
    with pytest.raises(DomainError):
        account_services.reinstate_account(staff, target.id)


def test_suspend_account_endpoint_forbidden_for_non_staff(client):
    target = make_user()
    other = make_user(role="PROVIDER")
    login(client, "provider@example.com")
    resp = client.post(reverse("moderation:account-suspend", args=[target.id]), {"reason": "abuse"}, content_type="application/json")
    assert resp.status_code == 403


# --- Listing moderation ------------------------------------------------------------

def test_listing_suspend_requires_reason_and_logs_audit(client):
    provider = make_user(role="PROVIDER")
    category = ServiceCategory.objects.create(name="Tutoring", slug="tutoring")
    listing = Service.objects.create(provider=provider, category=category, title="Math help", description="x", price=30, status=ServiceStatus.PUBLISHED)

    staff = make_staff(email="admin7@example.com", username="admin7user")
    login(client, "admin7@example.com")

    resp = client.post(reverse("moderation:listing-suspend", args=[listing.id]), {"reason": ""}, content_type="application/json")
    assert resp.status_code == 400

    resp2 = client.post(reverse("moderation:listing-suspend", args=[listing.id]), {"reason": "Misleading pricing."}, content_type="application/json")
    assert resp2.status_code == 200
    assert resp2.json()["status"] == "SUSPENDED"
    assert AuditLog.objects.filter(action="LISTING_SUSPENDED").exists()

    resp3 = client.post(reverse("moderation:listing-unsuspend", args=[listing.id]), content_type="application/json")
    assert resp3.status_code == 200
    assert resp3.json()["status"] == "DRAFT"
    assert AuditLog.objects.filter(action="LISTING_UNSUSPENDED").exists()

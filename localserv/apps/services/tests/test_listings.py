import pytest
from django.urls import reverse

from apps.accounts.models import User
from apps.common.constants import ServiceStatus
from apps.services.models import Service, ServiceCategory

pytestmark = pytest.mark.django_db


def make_user(role="CUSTOMER", **kwargs):
    defaults = dict(email=f"{role.lower()}@example.com", username=f"{role.lower()}user", password="a-strong-password-1", role=role)
    defaults.update(kwargs)
    user = User.objects.create_user(**defaults)
    user.mark_email_verified()
    return user


def make_category(name="Plumbing"):
    return ServiceCategory.objects.create(name=name, slug=name.lower())


def login(client, email, password="a-strong-password-1"):
    return client.post(reverse("accounts:login"), {"email": email, "password": password}, content_type="application/json")


def test_only_provider_can_create_service(client):
    make_user(role="CUSTOMER")
    login(client, "customer@example.com")
    category = make_category()
    resp = client.post(
        reverse("services:list-create"),
        {"category_id": str(category.id), "title": "Fix sink", "description": "Leaky sink repair.", "price": "50.00"},
        content_type="application/json",
    )
    assert resp.status_code == 403


def test_provider_creates_service_as_draft(client):
    make_user(role="PROVIDER")
    login(client, "provider@example.com")
    category = make_category()
    resp = client.post(
        reverse("services:list-create"),
        {"category_id": str(category.id), "title": "Fix sink", "description": "Leaky sink repair.", "price": "50.00"},
        content_type="application/json",
    )
    assert resp.status_code == 201
    assert resp.json()["status"] == "DRAFT"


def test_negative_price_rejected(client):
    make_user(role="PROVIDER")
    login(client, "provider@example.com")
    category = make_category()
    resp = client.post(
        reverse("services:list-create"),
        {"category_id": str(category.id), "title": "Fix sink", "description": "x", "price": "-5.00"},
        content_type="application/json",
    )
    assert resp.status_code == 400


def test_draft_not_visible_to_others_but_visible_to_owner(client):
    provider = make_user(role="PROVIDER")
    category = make_category()
    service = Service.objects.create(provider=provider, category=category, title="Fix sink", description="x", price=50)

    resp_anon = client.get(reverse("services:detail", args=[service.id]))
    assert resp_anon.status_code == 404

    login(client, "provider@example.com")
    resp_owner = client.get(reverse("services:detail", args=[service.id]))
    assert resp_owner.status_code == 200


def test_publish_then_visible_publicly(client):
    provider = make_user(role="PROVIDER")
    category = make_category()
    service = Service.objects.create(provider=provider, category=category, title="Fix sink", description="x", price=50)

    login(client, "provider@example.com")
    resp = client.post(reverse("services:transition", args=[service.id]), {"to_status": "PUBLISHED"}, content_type="application/json")
    assert resp.status_code == 200

    client.post(reverse("accounts:logout"))
    resp2 = client.get(reverse("services:detail", args=[service.id]))
    assert resp2.status_code == 200


def test_cannot_skip_states(client):
    provider = make_user(role="PROVIDER")
    category = make_category()
    service = Service.objects.create(provider=provider, category=category, title="Fix sink", description="x", price=50)
    login(client, "provider@example.com")
    # DRAFT -> ARCHIVED is not an allowed direct transition
    resp = client.post(reverse("services:transition", args=[service.id]), {"to_status": "ARCHIVED"}, content_type="application/json")
    assert resp.status_code == 400


def test_non_owner_cannot_transition_or_edit(client):
    provider = make_user(role="PROVIDER")
    make_user(role="CUSTOMER")
    category = make_category()
    service = Service.objects.create(provider=provider, category=category, title="Fix sink", description="x", price=50)

    login(client, "customer@example.com")
    resp = client.post(reverse("services:transition", args=[service.id]), {"to_status": "PUBLISHED"}, content_type="application/json")
    assert resp.status_code == 403

    resp2 = client.patch(reverse("services:detail", args=[service.id]), {"title": "hacked"}, content_type="application/json")
    assert resp2.status_code == 403


def test_only_staff_can_suspend_service():
    from apps.services import services as svc

    provider = make_user(role="PROVIDER")
    other_provider = make_user(role="PROVIDER", email="other@example.com", username="otherprovider")
    category = make_category()
    service = Service.objects.create(provider=provider, category=category, title="Fix sink", description="x", price=50, status=ServiceStatus.PUBLISHED)

    from apps.common.exceptions import AccountNotEligibleError
    with pytest.raises(AccountNotEligibleError):
        svc.suspend_service(other_provider, service.id)

    staff = make_user(role="ADMIN", email="admin@example.com", username="adminuser")
    staff.is_staff = True
    staff.save()
    suspended = svc.suspend_service(staff, service.id, reason="Repeated customer complaints.")
    assert suspended.status == ServiceStatus.SUSPENDED


def test_discovery_only_shows_published(client):
    provider = make_user(role="PROVIDER")
    category = make_category()
    Service.objects.create(provider=provider, category=category, title="Draft one", description="x", price=50, status=ServiceStatus.DRAFT)
    Service.objects.create(provider=provider, category=category, title="Published one", description="x", price=50, status=ServiceStatus.PUBLISHED)

    resp = client.get(reverse("services:list-create"))
    titles = [r["title"] for r in resp.json()["results"]]
    assert titles == ["Published one"]


def test_mine_requires_auth(client):
    resp = client.get(reverse("services:list-create"), {"mine": "true"})
    assert resp.status_code == 403


def test_mine_shows_own_non_published_listings(client):
    provider = make_user(role="PROVIDER")
    category = make_category()
    Service.objects.create(provider=provider, category=category, title="Draft one", description="x", price=50, status=ServiceStatus.DRAFT)
    login(client, "provider@example.com")
    resp = client.get(reverse("services:list-create"), {"mine": "true"})
    assert resp.status_code == 200
    assert len(resp.json()["results"]) == 1

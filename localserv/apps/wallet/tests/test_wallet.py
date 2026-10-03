from decimal import Decimal

import pytest
from django.urls import reverse

from apps.accounts.models import User
from apps.common.exceptions import AccountNotEligibleError, DomainError
from apps.wallet import services as wallet_services
from apps.wallet.models import LedgerEntry, Wallet

pytestmark = pytest.mark.django_db


def make_user(role="CUSTOMER", **kwargs):
    defaults = dict(email=f"{role.lower()}@example.com", username=f"{role.lower()}user", password="a-strong-password-1", role=role)
    defaults.update(kwargs)
    user = User.objects.create_user(**defaults)
    user.mark_email_verified()
    return user


def login(client, email="customer@example.com", password="a-strong-password-1"):
    return client.post(reverse("accounts:login"), {"email": email, "password": password}, content_type="application/json")


def test_wallet_auto_created_with_zero_balance():
    user = make_user()
    assert Wallet.objects.filter(user=user).exists()
    assert user.wallet.balance == Decimal("0.00")


def test_deposit_increases_balance(client):
    make_user()
    login(client)
    resp = client.post(reverse("wallet:deposit-initiate"), {"amount": "100.00", "idempotency_key": "dep-1"}, content_type="application/json")
    assert resp.status_code == 201
    assert resp.json()["status"] == "SUCCEEDED"  # stub provider auto-completes
    assert wallet_services.get_balance(User.objects.get(email="customer@example.com")) == Decimal("100.00")


def test_deposit_rejects_amount_below_minimum(client):
    make_user()
    login(client)
    resp = client.post(reverse("wallet:deposit-initiate"), {"amount": "1.00", "idempotency_key": "dep-2"}, content_type="application/json")
    assert resp.status_code == 400


def test_deposit_idempotency_key_prevents_double_credit(client):
    make_user()
    login(client)
    payload = {"amount": "150.00", "idempotency_key": "retry-key-1"}
    resp1 = client.post(reverse("wallet:deposit-initiate"), payload, content_type="application/json")
    resp2 = client.post(reverse("wallet:deposit-initiate"), payload, content_type="application/json")
    assert resp1.status_code == 201
    assert resp2.status_code == 201
    assert resp1.json()["id"] == resp2.json()["id"]  # same intent returned, not a new one
    user = User.objects.get(email="customer@example.com")
    assert wallet_services.get_balance(user) == Decimal("150.00")  # not 300
    assert LedgerEntry.objects.filter(wallet__user=user, entry_type="TOKEN_DEPOSIT").count() == 1


def test_ledger_lists_entries(client):
    make_user()
    login(client)
    client.post(reverse("wallet:deposit-initiate"), {"amount": "120.00", "idempotency_key": "dep-3"}, content_type="application/json")
    resp = client.get(reverse("wallet:ledger"))
    assert resp.status_code == 200
    assert len(resp.json()["results"]) == 1


def test_wallet_balance_cannot_go_negative_via_admin_adjustment():
    staff = make_user(role="ADMIN", email="admin@example.com", username="adminuser")
    staff.is_staff = True
    staff.save()
    target = make_user()

    with pytest.raises(DomainError):
        wallet_services.admin_adjust_wallet(staff, target, amount=Decimal("-10.00"), reason="test debit with no balance")


def test_non_staff_cannot_admin_adjust():
    target = make_user()
    other = make_user(role="CUSTOMER", email="other@example.com", username="otheruser")
    with pytest.raises(AccountNotEligibleError):
        wallet_services.admin_adjust_wallet(other, target, amount=Decimal("10.00"), reason="not allowed")


def test_admin_adjustment_requires_reason():
    staff = make_user(role="ADMIN", email="admin2@example.com", username="admin2user")
    staff.is_staff = True
    staff.save()
    target = make_user(email="target@example.com", username="targetuser")
    with pytest.raises(DomainError):
        wallet_services.admin_adjust_wallet(staff, target, amount=Decimal("10.00"), reason="")


def test_admin_adjustment_creates_audit_log():
    from apps.common.models import AuditLog

    staff = make_user(role="ADMIN", email="admin3@example.com", username="admin3user")
    staff.is_staff = True
    staff.save()
    target = make_user(email="target2@example.com", username="target2user")
    wallet_services.admin_adjust_wallet(staff, target, amount=Decimal("25.00"), reason="Goodwill credit")
    assert AuditLog.objects.filter(action="WALLET_ADMIN_ADJUSTMENT", target_user=target).exists()


def test_admin_adjust_endpoint_forbidden_for_non_staff(client):
    make_user()
    target = make_user(email="target3@example.com", username="target3user")
    login(client)
    resp = client.post(
        reverse("wallet:admin-adjust"),
        {"user_id": str(target.id), "amount": "10.00", "reason": "test"},
        content_type="application/json",
    )
    assert resp.status_code == 403

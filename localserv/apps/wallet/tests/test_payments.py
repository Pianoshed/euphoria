import hashlib
import hmac
import json
from datetime import timedelta
from decimal import Decimal

import pytest
from django.conf import settings
from django.urls import reverse
from django.utils import timezone

from apps.accounts.models import User
from apps.common.exceptions import AccountNotEligibleError, DomainError, InsufficientBalanceError
from apps.wallet import payment_services, services as wallet_services
from apps.wallet.models import PaymentIntent, PaymentWebhookEvent, PayoutAccount, WithdrawalRequest

pytestmark = pytest.mark.django_db


def make_payout_account(user, *, backdated=True):
    """Most withdrawal tests aren't testing the cooldown itself, so
    default to a backdated account that's already past
    PAYOUT_ACCOUNT_COOLDOWN. auto_now_add ignores an assigned
    created_at at creation time, so it's set via a follow-up update()."""
    account = PayoutAccount.objects.create(user=user, label="GTBank", masked_reference="****1234")
    if backdated:
        PayoutAccount.objects.filter(id=account.id).update(
            created_at=timezone.now() - payment_services.PAYOUT_ACCOUNT_COOLDOWN - timedelta(minutes=1)
        )
        account.refresh_from_db()
    return account



def make_user(role="CUSTOMER", **kwargs):
    defaults = dict(email=f"{role.lower()}@example.com", username=f"{role.lower()}user", password="a-strong-password-1", role=role)
    defaults.update(kwargs)
    user = User.objects.create_user(**defaults)
    user.mark_email_verified()
    return user


def login(client, email="customer@example.com", password="a-strong-password-1"):
    return client.post(reverse("accounts:login"), {"email": email, "password": password}, content_type="application/json")


def sign(body: bytes) -> str:
    secret = settings.STUB_PAYMENT_WEBHOOK_SECRET.encode()
    return hmac.new(secret, body, hashlib.sha256).hexdigest()


# --- Deposit initiation (stub provider auto-completes) ---------------------------

def test_initiate_deposit_below_minimum_rejected(client):
    make_user()
    login(client)
    resp = client.post(reverse("wallet:deposit-initiate"), {"amount": "50.00", "idempotency_key": "k1"}, content_type="application/json")
    assert resp.status_code == 400


def test_initiate_deposit_credits_wallet_via_stub(client):
    make_user()
    login(client)
    resp = client.post(reverse("wallet:deposit-initiate"), {"amount": "200.00", "idempotency_key": "k2"}, content_type="application/json")
    assert resp.status_code == 201
    assert resp.json()["status"] == "SUCCEEDED"
    user = User.objects.get(email="customer@example.com")
    assert wallet_services.get_balance(user) == Decimal("200.00")


def test_initiate_deposit_idempotency_key_reused_by_different_user_rejected(client):
    make_user()
    other = make_user(role="PROVIDER")
    login(client)
    client.post(reverse("wallet:deposit-initiate"), {"amount": "150.00", "idempotency_key": "shared-key"}, content_type="application/json")
    with pytest.raises(DomainError):
        payment_services.initiate_deposit(other, amount=Decimal("150.00"), idempotency_key="shared-key")


def test_list_payment_intents(client):
    make_user()
    login(client)
    client.post(reverse("wallet:deposit-initiate"), {"amount": "150.00", "idempotency_key": "k3"}, content_type="application/json")
    resp = client.get(reverse("wallet:deposit-list"))
    assert resp.status_code == 200
    assert len(resp.json()["results"]) == 1


# --- Webhook: signature verification, idempotency, amount trust boundary ---------

def _pending_intent(user, amount=Decimal("300.00"), provider_reference="stub_dep_test1"):
    return PaymentIntent.objects.create(
        user=user, amount=amount, provider="stub", provider_reference=provider_reference,
        status="PENDING", idempotency_key=f"manual-{provider_reference}",
    )


def test_webhook_rejects_invalid_signature(client):
    user = make_user()
    _pending_intent(user)
    body = json.dumps({"event_id": "evt1", "provider_reference": "stub_dep_test1", "status": "succeeded", "amount": "300.00"}).encode()
    resp = client.post(
        reverse("wallet:deposit-webhook"), data=body, content_type="application/json",
        HTTP_X_STUB_SIGNATURE="not-the-right-signature",
    )
    assert resp.status_code == 400
    intent = PaymentIntent.objects.get(provider_reference="stub_dep_test1")
    assert intent.status == "PENDING"  # untouched
    assert wallet_services.get_balance(user) == Decimal("0.00")


def test_webhook_valid_signature_credits_wallet(client):
    user = make_user()
    _pending_intent(user, amount=Decimal("300.00"), provider_reference="stub_dep_test2")
    body = json.dumps({"event_id": "evt2", "provider_reference": "stub_dep_test2", "status": "succeeded", "amount": "300.00"}).encode()
    resp = client.post(
        reverse("wallet:deposit-webhook"), data=body, content_type="application/json",
        HTTP_X_STUB_SIGNATURE=sign(body),
    )
    assert resp.status_code == 200
    assert resp.json()["status"] == "SUCCEEDED"
    assert wallet_services.get_balance(user) == Decimal("300.00")


def test_webhook_replay_does_not_double_credit(client):
    user = make_user()
    _pending_intent(user, amount=Decimal("300.00"), provider_reference="stub_dep_test3")
    body = json.dumps({"event_id": "evt3", "provider_reference": "stub_dep_test3", "status": "succeeded", "amount": "300.00"}).encode()
    sig = sign(body)
    resp1 = client.post(reverse("wallet:deposit-webhook"), data=body, content_type="application/json", HTTP_X_STUB_SIGNATURE=sig)
    resp2 = client.post(reverse("wallet:deposit-webhook"), data=body, content_type="application/json", HTTP_X_STUB_SIGNATURE=sig)
    assert resp1.status_code == 200
    assert resp2.status_code == 200
    assert wallet_services.get_balance(user) == Decimal("300.00")  # not 600
    assert PaymentWebhookEvent.objects.filter(provider_event_id="evt3").count() == 1


def test_webhook_unknown_provider_reference_rejected(client):
    make_user()
    body = json.dumps({"event_id": "evt4", "provider_reference": "does-not-exist", "status": "succeeded", "amount": "300.00"}).encode()
    resp = client.post(reverse("wallet:deposit-webhook"), data=body, content_type="application/json", HTTP_X_STUB_SIGNATURE=sign(body))
    assert resp.status_code == 400


def test_webhook_failed_status_marks_intent_failed_without_crediting(client):
    user = make_user()
    _pending_intent(user, amount=Decimal("300.00"), provider_reference="stub_dep_test5")
    body = json.dumps({"event_id": "evt5", "provider_reference": "stub_dep_test5", "status": "failed", "amount": "300.00"}).encode()
    resp = client.post(reverse("wallet:deposit-webhook"), data=body, content_type="application/json", HTTP_X_STUB_SIGNATURE=sign(body))
    assert resp.status_code == 200
    assert resp.json()["status"] == "FAILED"
    assert wallet_services.get_balance(user) == Decimal("0.00")


def test_webhook_no_auth_required_but_signature_is_the_real_gate(client):
    """The endpoint must be reachable without a session (it's a
    server-to-server call), but that's exactly why signature
    verification -- not Django auth -- is the actual security
    boundary; this test hits it with zero session cookies at all."""
    user = make_user()
    _pending_intent(user, amount=Decimal("50.00"), provider_reference="stub_dep_test6")
    body = json.dumps({"event_id": "evt6", "provider_reference": "stub_dep_test6", "status": "succeeded", "amount": "50.00"}).encode()
    from django.test import Client

    anon_client = Client()
    resp = anon_client.post(reverse("wallet:deposit-webhook"), data=body, content_type="application/json", HTTP_X_STUB_SIGNATURE=sign(body))
    assert resp.status_code == 200
    assert wallet_services.get_balance(user) == Decimal("50.00")


# --- Payout accounts ---------------------------------------------------------------

def test_add_payout_account_masks_and_discards_raw_number(client):
    make_user()
    login(client)
    resp = client.post(
        reverse("wallet:payout-accounts"),
        {"label": "GTBank", "raw_account_number": "0123456789"},
        content_type="application/json",
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["masked_reference"] == "****6789"
    assert "raw_account_number" not in body
    assert "0123456789" not in json.dumps(body)

    account = PayoutAccount.objects.get(id=body["id"])
    # the full number was never persisted anywhere on the row
    for field in account._meta.fields:
        value = getattr(account, field.name)
        assert "0123456789" not in str(value)


def test_add_payout_account_rejects_short_number(client):
    make_user()
    login(client)
    resp = client.post(
        reverse("wallet:payout-accounts"), {"label": "GTBank", "raw_account_number": "12"}, content_type="application/json"
    )
    assert resp.status_code == 400


def test_list_payout_accounts(client):
    user = make_user()
    login(client)
    client.post(reverse("wallet:payout-accounts"), {"label": "GTBank", "raw_account_number": "0123456789"}, content_type="application/json")
    resp = client.get(reverse("wallet:payout-accounts"))
    assert resp.status_code == 200
    assert len(resp.json()) == 1


# --- Withdrawals -----------------------------------------------------------------

def test_withdrawal_requires_correct_password(client):
    user = make_user()
    wallet_services.deposit(user, amount=Decimal("1000.00"))
    account = make_payout_account(user)
    login(client)
    resp = client.post(
        reverse("wallet:withdrawals"),
        {"amount": "500.00", "payout_account_id": str(account.id), "current_password": "wrong-password", "idempotency_key": "w1"},
        content_type="application/json",
    )
    assert resp.status_code == 400
    assert wallet_services.get_balance(user) == Decimal("1000.00")  # untouched


def test_withdrawal_below_minimum_rejected(client):
    user = make_user()
    wallet_services.deposit(user, amount=Decimal("1000.00"))
    account = make_payout_account(user)
    login(client)
    resp = client.post(
        reverse("wallet:withdrawals"),
        {"amount": "10.00", "payout_account_id": str(account.id), "current_password": "a-strong-password-1", "idempotency_key": "w2"},
        content_type="application/json",
    )
    assert resp.status_code == 400


def test_withdrawal_insufficient_balance_creates_no_row():
    user = make_user()
    wallet_services.deposit(user, amount=Decimal("600.00"))
    account = make_payout_account(user)
    with pytest.raises(InsufficientBalanceError):
        payment_services.request_withdrawal(
            user, amount=Decimal("5000.00"), payout_account_id=account.id,
            current_password="a-strong-password-1", idempotency_key="w3",
        )
    assert wallet_services.get_balance(user) == Decimal("600.00")
    assert not WithdrawalRequest.objects.filter(idempotency_key="w3").exists()


def test_withdrawal_debits_immediately_and_completes(client):
    user = make_user()
    wallet_services.deposit(user, amount=Decimal("1000.00"))
    account = make_payout_account(user)
    login(client)
    resp = client.post(
        reverse("wallet:withdrawals"),
        {"amount": "500.00", "payout_account_id": str(account.id), "current_password": "a-strong-password-1", "idempotency_key": "w4"},
        content_type="application/json",
    )
    assert resp.status_code == 201
    assert resp.json()["status"] == "COMPLETED"
    assert resp.json()["payout_account"]["masked_reference"] == "****1234"
    assert wallet_services.get_balance(user) == Decimal("500.00")


def test_withdrawal_rejected_during_payout_account_cooldown(client):
    user = make_user()
    wallet_services.deposit(user, amount=Decimal("1000.00"))
    fresh_account = make_payout_account(user, backdated=False)  # just added, still in cooldown
    login(client)
    resp = client.post(
        reverse("wallet:withdrawals"),
        {"amount": "500.00", "payout_account_id": str(fresh_account.id), "current_password": "a-strong-password-1", "idempotency_key": "w-cooldown"},
        content_type="application/json",
    )
    assert resp.status_code == 403
    assert wallet_services.get_balance(user) == Decimal("1000.00")  # untouched


def test_cannot_withdraw_to_another_users_payout_account():
    user = make_user()
    other = make_user(role="PROVIDER")
    wallet_services.deposit(user, amount=Decimal("1000.00"))
    other_account = make_payout_account(other)
    with pytest.raises(DomainError):
        payment_services.request_withdrawal(
            user, amount=Decimal("500.00"), payout_account_id=other_account.id,
            current_password="a-strong-password-1", idempotency_key="w-idor",
        )
    assert wallet_services.get_balance(user) == Decimal("1000.00")  # untouched


def test_second_withdrawal_after_balance_exhausted_fails_cleanly():
    """No real thread race here (see README's known-gaps note on SQLite
    vs PostgreSQL locking), but this proves the guard: once a
    withdrawal has debited the full balance, an immediately-following
    request for more than what's left is rejected, not double-spent."""
    user = make_user()
    wallet_services.deposit(user, amount=Decimal("600.00"))
    account = make_payout_account(user)
    payment_services.request_withdrawal(
        user, amount=Decimal("600.00"), payout_account_id=account.id,
        current_password="a-strong-password-1", idempotency_key="w5a",
    )
    with pytest.raises(InsufficientBalanceError):
        payment_services.request_withdrawal(
            user, amount=Decimal("600.00"), payout_account_id=account.id,
            current_password="a-strong-password-1", idempotency_key="w5b",
        )
    assert wallet_services.get_balance(user) == Decimal("0.00")


def test_withdrawal_idempotency_key_replay_returns_same_request():
    user = make_user()
    wallet_services.deposit(user, amount=Decimal("1000.00"))
    account = make_payout_account(user)
    first = payment_services.request_withdrawal(
        user, amount=Decimal("500.00"), payout_account_id=account.id,
        current_password="a-strong-password-1", idempotency_key="w6",
    )
    second = payment_services.request_withdrawal(
        user, amount=Decimal("500.00"), payout_account_id=account.id,
        current_password="a-strong-password-1", idempotency_key="w6",
    )
    assert first.id == second.id
    assert wallet_services.get_balance(user) == Decimal("500.00")  # debited once, not twice


# --- Withdrawal reversal (staff-only) ---------------------------------------------

def test_only_staff_can_reverse_withdrawal():
    user = make_user()
    wallet_services.deposit(user, amount=Decimal("1000.00"))
    account = make_payout_account(user)
    withdrawal = payment_services.request_withdrawal(
        user, amount=Decimal("500.00"), payout_account_id=account.id,
        current_password="a-strong-password-1", idempotency_key="w7",
    )
    other = make_user(role="PROVIDER")
    with pytest.raises(AccountNotEligibleError):
        payment_services.reverse_withdrawal(other, withdrawal.id, reason="not staff")


def test_staff_reversal_credits_wallet_back_and_logs_audit():
    from apps.common.models import AuditLog

    user = make_user()
    wallet_services.deposit(user, amount=Decimal("1000.00"))
    account = make_payout_account(user)
    withdrawal = payment_services.request_withdrawal(
        user, amount=Decimal("500.00"), payout_account_id=account.id,
        current_password="a-strong-password-1", idempotency_key="w8",
    )
    assert wallet_services.get_balance(user) == Decimal("500.00")

    staff = make_user(role="ADMIN", email="admin@example.com", username="adminuser")
    staff.is_staff = True
    staff.save()

    reversed_withdrawal = payment_services.reverse_withdrawal(staff, withdrawal.id, reason="Provider payout failed after the fact.")
    assert reversed_withdrawal.status == "REVERSED"
    assert wallet_services.get_balance(user) == Decimal("1000.00")
    assert AuditLog.objects.filter(action="WITHDRAWAL_REVERSED", target_user=user).exists()


def test_cannot_reverse_a_withdrawal_twice():
    user = make_user()
    wallet_services.deposit(user, amount=Decimal("1000.00"))
    account = make_payout_account(user)
    withdrawal = payment_services.request_withdrawal(
        user, amount=Decimal("500.00"), payout_account_id=account.id,
        current_password="a-strong-password-1", idempotency_key="w9",
    )
    staff = make_user(role="ADMIN", email="admin2@example.com", username="admin2user")
    staff.is_staff = True
    staff.save()
    payment_services.reverse_withdrawal(staff, withdrawal.id, reason="first reversal")
    with pytest.raises(DomainError):
        payment_services.reverse_withdrawal(staff, withdrawal.id, reason="second attempt")
    assert wallet_services.get_balance(user) == Decimal("1000.00")  # not double-credited

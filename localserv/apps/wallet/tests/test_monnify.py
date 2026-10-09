import hashlib
import hmac
import json
from decimal import Decimal
from unittest import mock

import pytest
from django.core.cache import cache
from django.urls import reverse

from apps.accounts.models import User
from apps.common.exceptions import DomainError
from apps.wallet import payment_services, services as wallet_services
from apps.wallet.models import PaymentIntent
from apps.wallet.providers import MonnifyProvider, get_provider

SECRET = "test-monnify-secret"


@pytest.fixture(autouse=True)
def monnify_settings(settings):
    settings.PAYMENT_PROVIDER = "monnify"
    settings.MONNIFY_API_KEY = "MK_TEST_KEY"
    settings.MONNIFY_SECRET_KEY = SECRET
    settings.MONNIFY_CONTRACT_CODE = "1234567890"
    settings.MONNIFY_BASE_URL = "https://sandbox.monnify.com"
    settings.MONNIFY_REDIRECT_URL = "https://app.example.com/wallet?deposit=return"
    cache.clear()
    yield
    cache.clear()


def sign(body: bytes) -> str:
    return hmac.new(SECRET.encode(), body, hashlib.sha512).hexdigest()


def event(reference="EUPH-abc", txn="MNFY|01|20260101000000|000001", amount=300, status="PAID", event_type="SUCCESSFUL_TRANSACTION"):
    return json.dumps({
        "eventType": event_type,
        "eventData": {
            "transactionReference": txn,
            "paymentReference": reference,
            "amountPaid": amount,
            "totalPayable": amount,
            "paymentStatus": status,
            "currency": "NGN",
        },
    }).encode()


def fake_post(login_ok=True, checkout="https://sandbox.monnify.com/checkout/MNFY|1"):
    """Stand-in for requests.post: first the login call, then init-transaction."""
    def _post(url, **kwargs):
        resp = mock.Mock()
        resp.raise_for_status = mock.Mock()
        if url.endswith("/api/v1/auth/login"):
            resp.json.return_value = {"responseBody": {"accessToken": "tok123", "expiresIn": 3000}}
        else:
            resp.json.return_value = {"responseBody": {"checkoutUrl": checkout, "transactionReference": "MNFY|1"}}
        return resp
    return _post


def make_user(role="CUSTOMER"):
    user = User.objects.create_user(
        email=f"{role.lower()}@example.com", username=f"{role.lower()}user",
        password="a-strong-password-1", role=role,
    )
    user.mark_email_verified()
    return user


# --- Provider (no database) -----------------------------------------------------

def test_get_provider_selects_monnify():
    assert isinstance(get_provider(), MonnifyProvider)


def test_signature_valid_and_invalid():
    p = MonnifyProvider()
    body = event()
    assert p.verify_webhook_signature(headers={"monnify-signature": sign(body)}, body=body)
    assert not p.verify_webhook_signature(headers={"monnify-signature": "nope"}, body=body)
    assert not p.verify_webhook_signature(headers={}, body=body)
    # a body altered after signing must fail
    assert not p.verify_webhook_signature(headers={"monnify-signature": sign(body)}, body=body + b" ")


def test_signature_never_verifies_with_empty_secret(settings):
    settings.MONNIFY_SECRET_KEY = ""
    body = event()
    empty_sig = hmac.new(b"", body, hashlib.sha512).hexdigest()
    assert not MonnifyProvider().verify_webhook_signature(headers={"monnify-signature": empty_sig}, body=body)


def test_parse_paid_event():
    parsed = MonnifyProvider().parse_webhook_event(body=event(reference="EUPH-1", txn="T1", amount=300))
    assert parsed == {"event_id": "T1", "provider_reference": "EUPH-1", "status": "succeeded", "amount": Decimal("300")}


def test_parse_unpaid_event_is_failed():
    assert MonnifyProvider().parse_webhook_event(body=event(status="FAILED"))["status"] == "failed"


def test_parse_other_event_types_are_ignored():
    assert MonnifyProvider().parse_webhook_event(body=event(event_type="SUCCESSFUL_DISBURSEMENT")) == {"status": "ignored"}


def test_parse_malformed_payload_rejected():
    with pytest.raises(DomainError):
        MonnifyProvider().parse_webhook_event(body=b"not json")
    with pytest.raises(DomainError):
        MonnifyProvider().parse_webhook_event(body=b'{"eventType": "SUCCESSFUL_TRANSACTION", "eventData": {}}')


def test_initiate_deposit_sends_expected_payload_and_returns_checkout_url():
    user = mock.Mock(email="a@example.com", username="alice")
    with mock.patch("apps.wallet.providers.requests.post", side_effect=fake_post()) as post:
        result = MonnifyProvider().initiate_deposit(user=user, amount=Decimal("500.00"), idempotency_key="k")
    assert result["provider_reference"].startswith("EUPH-")
    assert result["client_action"]["checkout_url"].startswith("https://sandbox.monnify.com/checkout/")
    login_call, init_call = post.call_args_list
    assert login_call.kwargs["auth"] == ("MK_TEST_KEY", SECRET)
    sent = init_call.kwargs["json"]
    assert sent["amount"] == 500.0 and sent["currencyCode"] == "NGN"
    assert sent["contractCode"] == "1234567890" and sent["paymentReference"] == result["provider_reference"]
    assert init_call.kwargs["headers"]["Authorization"] == "Bearer tok123"


def test_access_token_is_cached_between_calls():
    user = mock.Mock(email="a@example.com", username="alice")
    with mock.patch("apps.wallet.providers.requests.post", side_effect=fake_post()) as post:
        MonnifyProvider().initiate_deposit(user=user, amount=Decimal("500"), idempotency_key="k1")
        MonnifyProvider().initiate_deposit(user=user, amount=Decimal("500"), idempotency_key="k2")
    logins = [c for c in post.call_args_list if c.args[0].endswith("/auth/login")]
    assert len(logins) == 1


def test_gateway_failure_becomes_domain_error():
    import requests
    user = mock.Mock(email="a@example.com", username="alice")
    with mock.patch("apps.wallet.providers.requests.post", side_effect=requests.ConnectionError("boom")):
        with pytest.raises(DomainError):
            MonnifyProvider().initiate_deposit(user=user, amount=Decimal("500"), idempotency_key="k")


# --- Full flow (database) ---------------------------------------------------------

@pytest.mark.django_db
def test_initiate_deposit_creates_pending_intent_with_checkout_url_and_no_credit():
    user = make_user()
    with mock.patch("apps.wallet.providers.requests.post", side_effect=fake_post()):
        intent = payment_services.initiate_deposit(user, amount=Decimal("500.00"), idempotency_key="m1")
    assert intent.status == "PENDING" and intent.provider == "monnify"
    assert intent.checkout_url.startswith("https://sandbox.monnify.com/checkout/")
    assert wallet_services.get_balance(user) == Decimal("0.00")


@pytest.fixture(autouse=True)
def _provider_confirms_payment():
    """Deposits are re-verified with Monnify before crediting; default to 'confirmed' (override per test)."""
    with mock.patch.object(MonnifyProvider, "verify_deposit", return_value={"paid": True, "amount": Decimal("1000000")}):
        yield


@pytest.mark.django_db
def test_webhook_not_confirmed_by_provider_is_not_credited(client):
    user = make_user()
    _pending(user)
    with mock.patch.object(MonnifyProvider, "verify_deposit", return_value={"paid": False, "amount": Decimal("0")}):
        resp = _post_webhook(client, event(reference="EUPH-abc", amount=300))
    assert resp.status_code == 400
    assert wallet_services.get_balance(user) == Decimal("0.00")


@pytest.mark.django_db
def test_webhook_provider_lookup_down_is_retried_not_credited(client):
    user = make_user()
    _pending(user)
    with mock.patch.object(MonnifyProvider, "verify_deposit", side_effect=DomainError("down")):
        resp = _post_webhook(client, event(reference="EUPH-abc", amount=300))
    assert resp.status_code == 400
    assert wallet_services.get_balance(user) == Decimal("0.00")


def _pending(user, reference="EUPH-abc", amount="300.00"):
    return PaymentIntent.objects.create(
        user=user, amount=Decimal(amount), provider="monnify", provider_reference=reference,
        status="PENDING", idempotency_key=f"idem-{reference}",
    )


def _post_webhook(client, body, signature=None):
    return client.post(
        reverse("wallet:deposit-webhook"), data=body, content_type="application/json",
        HTTP_MONNIFY_SIGNATURE=sign(body) if signature is None else signature,
    )


@pytest.mark.django_db
def test_webhook_credits_wallet(client):
    user = make_user()
    _pending(user)
    resp = _post_webhook(client, event(reference="EUPH-abc", amount=300))
    assert resp.status_code == 200 and resp.json()["status"] == "SUCCEEDED"
    assert wallet_services.get_balance(user) == Decimal("300.00")


@pytest.mark.django_db
def test_webhook_bad_signature_rejected(client):
    user = make_user()
    _pending(user)
    resp = _post_webhook(client, event(reference="EUPH-abc"), signature="bad")
    assert resp.status_code == 400
    assert wallet_services.get_balance(user) == Decimal("0.00")


@pytest.mark.django_db
def test_webhook_replay_does_not_double_credit(client):
    user = make_user()
    _pending(user)
    body = event(reference="EUPH-abc", amount=300)
    assert _post_webhook(client, body).status_code == 200
    assert _post_webhook(client, body).status_code == 200
    assert wallet_services.get_balance(user) == Decimal("300.00")


@pytest.mark.django_db
def test_webhook_underpayment_is_not_credited(client):
    user = make_user()
    _pending(user, amount="300.00")
    resp = _post_webhook(client, event(reference="EUPH-abc", amount=100))
    assert resp.status_code == 200
    assert resp.json()["status"] == "FAILED"
    assert wallet_services.get_balance(user) == Decimal("0.00")


@pytest.mark.django_db
def test_webhook_other_event_type_is_acknowledged_and_ignored(client):
    user = make_user()
    _pending(user)
    resp = _post_webhook(client, event(event_type="SUCCESSFUL_DISBURSEMENT"))
    assert resp.status_code == 200 and resp.json() == {"detail": "ignored"}
    assert wallet_services.get_balance(user) == Decimal("0.00")

import hashlib
from datetime import timedelta
import hmac
import json
from decimal import Decimal
from unittest import mock

import pytest
import requests
from cryptography.fernet import Fernet
from django.core.cache import cache
from django.urls import reverse
from django.utils import timezone

from apps.accounts.models import User
from apps.common.exceptions import DomainError
from apps.wallet import crypto, payment_services, services as wallet_services
from apps.wallet.models import PayoutAccount, WithdrawalRequest
from apps.wallet.providers import MonnifyProvider, PayoutRejected

SECRET = "test-monnify-secret"
ACCT = "0123456789"
PASSWORD = "a-strong-password-1"


@pytest.fixture(autouse=True)
def cfg(settings):
    settings.PAYMENT_PROVIDER = "monnify"
    settings.MONNIFY_API_KEY = "MK_TEST_KEY"
    settings.MONNIFY_SECRET_KEY = SECRET
    settings.MONNIFY_CONTRACT_CODE = "1234567890"
    settings.MONNIFY_BASE_URL = "https://sandbox.monnify.com"
    settings.MONNIFY_SOURCE_ACCOUNT_NUMBER = "9999999999"
    settings.PAYOUT_ENCRYPTION_KEYS = Fernet.generate_key().decode()
    cache.clear()
    cache.set(MonnifyProvider.TOKEN_CACHE_KEY, "tok", 300)  # skip the login call
    yield
    cache.clear()


def sign(body):
    return hmac.new(SECRET.encode(), body, hashlib.sha512).hexdigest()


def resp(status=200, body=None):
    r = mock.Mock(status_code=status)
    r.json.return_value = body if body is not None else {}
    r.raise_for_status = mock.Mock()
    return r


def fake_withdrawal(amount="1000.00", ref="EUPW-1"):
    return mock.Mock(amount=Decimal(amount), provider_reference=ref)


DEST = {"account_number": ACCT, "bank_code": "058"}


# --- crypto -------------------------------------------------------------------------
def test_seal_roundtrip_and_ciphertext_hides_number():
    token = crypto.seal({"id": "x", "n": ACCT, "b": "058"})
    assert ACCT not in token
    assert crypto.unseal(token)["n"] == ACCT


def test_unseal_rejects_tampering_and_wrong_key(settings):
    token = crypto.seal({"id": "x", "n": ACCT, "b": "058"})
    with pytest.raises(crypto.SealError):
        crypto.unseal(token[:-4] + "AAAA")
    settings.PAYOUT_ENCRYPTION_KEYS = Fernet.generate_key().decode()
    with pytest.raises(crypto.SealError):
        crypto.unseal(token)


def test_key_rotation_old_tokens_still_open(settings):
    old = settings.PAYOUT_ENCRYPTION_KEYS
    token = crypto.seal({"id": "x", "n": ACCT, "b": "058"})
    new = Fernet.generate_key().decode()
    settings.PAYOUT_ENCRYPTION_KEYS = f"{new},{old}"
    assert crypto.unseal(token)["n"] == ACCT
    rotated = crypto.rotate(token)
    settings.PAYOUT_ENCRYPTION_KEYS = new  # old key dropped
    assert crypto.unseal(rotated)["n"] == ACCT


# --- provider: payout --------------------------------------------------------------------
def _payout(response=None, exc=None):
    with mock.patch("apps.wallet.providers.requests.post", side_effect=exc, return_value=response) as post:
        try:
            return MonnifyProvider().initiate_payout(withdrawal=fake_withdrawal(), destination=DEST), post
        finally:
            pass


def test_payout_success_sends_expected_payload():
    result, post = _payout(resp(200, {"responseBody": {"status": "SUCCESS"}}))
    assert result == {"provider_reference": "EUPW-1", "status": "completed"}
    sent = post.call_args.kwargs["json"]
    assert sent["reference"] == "EUPW-1" and sent["destinationAccountNumber"] == ACCT
    assert sent["destinationBankCode"] == "058" and sent["sourceAccountNumber"] == "9999999999"
    assert post.call_args.args[0].endswith("/api/v2/disbursements/single")


def test_payout_pending_stays_processing():
    result, _ = _payout(resp(200, {"responseBody": {"status": "PENDING"}}))
    assert result["status"] == "processing"


def test_payout_timeout_is_unknown_not_failure():
    result, _ = _payout(exc=requests.Timeout("slow"))
    assert result["status"] == "processing"


def test_payout_5xx_is_unknown_not_failure():
    result, _ = _payout(resp(502, {}))
    assert result["status"] == "processing"


def test_payout_4xx_is_definite_rejection():
    with pytest.raises(PayoutRejected):
        _payout(resp(400, {"responseMessage": "Invalid account"}))


def test_payout_rejection_message_does_not_leak_provider_text():
    with pytest.raises(PayoutRejected) as e:
        _payout(resp(400, {"responseMessage": "Insufficient wallet balance 12345.00"}))
    assert "12345" not in str(e.value)


def test_payout_otp_required_is_rejected():
    with pytest.raises(PayoutRejected):
        _payout(resp(200, {"responseBody": {"status": "OTP_EMAIL_SENT"}}))


def test_payout_without_destination_is_rejected():
    with pytest.raises(PayoutRejected):
        MonnifyProvider().initiate_payout(withdrawal=fake_withdrawal(), destination=None)


def test_payout_401_clears_cached_token():
    with pytest.raises(PayoutRejected):
        _payout(resp(401, {}))
    assert cache.get(MonnifyProvider.TOKEN_CACHE_KEY) is None


def test_parse_payout_events():
    def ev(t, amount=1000):
        return json.dumps({"eventType": t, "eventData": {"reference": "EUPW-1", "amount": amount}}).encode()
    p = MonnifyProvider()
    assert p.parse_payout_webhook_event(body=ev("SUCCESSFUL_DISBURSEMENT"))["status"] == "succeeded"
    assert p.parse_payout_webhook_event(body=ev("FAILED_DISBURSEMENT"))["status"] == "failed"
    assert p.parse_payout_webhook_event(body=ev("REVERSED_DISBURSEMENT"))["status"] == "reversed"
    assert p.parse_payout_webhook_event(body=ev("SUCCESSFUL_TRANSACTION")) == {"status": "ignored"}


def test_get_payout_status_never_guesses_failure():
    p = MonnifyProvider()
    with mock.patch("apps.wallet.providers.requests.get", return_value=resp(404, {})):
        assert p.get_payout_status(reference="r") == "unknown"
    with mock.patch("apps.wallet.providers.requests.get", side_effect=requests.Timeout()):
        assert p.get_payout_status(reference="r") == "unknown"
    with mock.patch("apps.wallet.providers.requests.get", return_value=resp(200, {"responseBody": {"status": "FAILED"}})):
        assert p.get_payout_status(reference="r") == "failed"


# --- full flow (database) ---------------------------------------------------------------
BANKS = [{"code": "058", "name": "GTBank"}]


def make_user():
    u = User.objects.create_user(email="c@example.com", username="cuser", password=PASSWORD, role="CUSTOMER")
    u.mark_email_verified()
    return u


def funded_user(amount="5000.00"):
    u = make_user()
    wallet_services.deposit(u, amount=Decimal(amount), idempotency_key="seed", note="seed")
    return u


def add_account(user, age_hours=48):
    with mock.patch.object(MonnifyProvider, "list_banks", return_value=BANKS), \
         mock.patch.object(MonnifyProvider, "resolve_account", return_value="ADA OBI"):
        acct = payment_services.add_payout_account(user, label="x", raw_account_number=ACCT, bank_code="058")
    PayoutAccount.objects.filter(id=acct.id).update(created_at=timezone.now() - timedelta(hours=age_hours))
    return PayoutAccount.objects.get(id=acct.id)


def withdraw_req(user, acct, key="w1", amount="1000.00", password=PASSWORD):
    return payment_services.request_withdrawal(
        user, amount=Decimal(amount), payout_account_id=acct.id, current_password=password, idempotency_key=key
    )


@pytest.mark.django_db
def test_add_account_stores_only_ciphertext():
    acct = add_account(make_user())
    assert acct.masked_reference == "****6789" and acct.account_name == "ADA OBI"
    assert ACCT not in acct.destination_ciphertext
    assert ACCT not in " ".join(str(getattr(acct, f.name)) for f in acct._meta.fields if f.name != "destination_ciphertext")


@pytest.mark.django_db
def test_add_account_rejects_bad_input_and_duplicates():
    u = make_user()
    with mock.patch.object(MonnifyProvider, "list_banks", return_value=BANKS):
        with pytest.raises(DomainError):
            payment_services.add_payout_account(u, label="", raw_account_number="123", bank_code="058")
        with pytest.raises(DomainError):
            payment_services.add_payout_account(u, label="", raw_account_number=ACCT, bank_code="999")
    add_account(u)
    with mock.patch.object(MonnifyProvider, "list_banks", return_value=BANKS), \
         mock.patch.object(MonnifyProvider, "resolve_account", return_value="ADA OBI"):
        with pytest.raises(DomainError):
            payment_services.add_payout_account(u, label="", raw_account_number=ACCT, bank_code="058")


@pytest.mark.django_db
def test_withdrawal_success_via_webhook():
    u = funded_user(); acct = add_account(u)
    with mock.patch.object(MonnifyProvider, "initiate_payout", return_value={"provider_reference": "x", "status": "processing"}):
        w = withdraw_req(u, acct)
    assert w.status == "PROCESSING" and w.provider_reference.startswith("EUPW-")
    assert wallet_services.get_balance(u) == Decimal("4000.00")
    body = json.dumps({"eventType": "SUCCESSFUL_DISBURSEMENT", "eventData": {"reference": w.provider_reference, "amount": 1000}}).encode()
    payment_services.process_payout_webhook(headers={"monnify-signature": sign(body)}, body=body)
    assert WithdrawalRequest.objects.get(id=w.id).status == "COMPLETED"
    assert wallet_services.get_balance(u) == Decimal("4000.00")


@pytest.mark.django_db
def test_failed_webhook_refunds_exactly_once_even_if_replayed_and_redelivered_as_new_event():
    u = funded_user(); acct = add_account(u)
    with mock.patch.object(MonnifyProvider, "initiate_payout", return_value={"provider_reference": "x", "status": "processing"}):
        w = withdraw_req(u, acct)
    for t in ("FAILED_DISBURSEMENT", "FAILED_DISBURSEMENT", "REVERSED_DISBURSEMENT"):
        body = json.dumps({"eventType": t, "eventData": {"reference": w.provider_reference, "amount": 1000}}).encode()
        payment_services.process_payout_webhook(headers={"monnify-signature": sign(body)}, body=body)
    assert WithdrawalRequest.objects.get(id=w.id).status == "REVERSED"
    assert wallet_services.get_balance(u) == Decimal("5000.00")  # refunded once, not 3 times


@pytest.mark.django_db
def test_definite_rejection_refunds_immediately_and_raises():
    u = funded_user(); acct = add_account(u)
    with mock.patch.object(MonnifyProvider, "initiate_payout", side_effect=PayoutRejected("nope")):
        with pytest.raises(DomainError):
            withdraw_req(u, acct)
    assert wallet_services.get_balance(u) == Decimal("5000.00")
    assert WithdrawalRequest.objects.get().status == "REVERSED"


@pytest.mark.django_db
def test_unexpected_error_leaves_processing_and_keeps_debit():
    u = funded_user(); acct = add_account(u)
    with mock.patch.object(MonnifyProvider, "initiate_payout", side_effect=RuntimeError("boom")):
        w = withdraw_req(u, acct)
    assert w.status == "PROCESSING"
    assert wallet_services.get_balance(u) == Decimal("4000.00")  # NOT refunded on a guess


@pytest.mark.django_db
def test_replay_same_key_does_not_pay_twice():
    u = funded_user(); acct = add_account(u)
    with mock.patch.object(MonnifyProvider, "initiate_payout", return_value={"provider_reference": "x", "status": "processing"}) as p:
        a = withdraw_req(u, acct); b = withdraw_req(u, acct)
    assert a.id == b.id and p.call_count == 1
    assert wallet_services.get_balance(u) == Decimal("4000.00")


@pytest.mark.django_db
def test_withdrawal_guards():
    u = funded_user(); acct = add_account(u)
    with pytest.raises(DomainError):
        withdraw_req(u, acct, key="a", password="wrong")
    with pytest.raises(DomainError):
        withdraw_req(u, acct, key="b", amount="100")  # below minimum
    young = add_account(make_user_other(), age_hours=0)
    with pytest.raises(Exception):
        withdraw_req(u, young, key="c")  # someone else's account
    assert wallet_services.get_balance(u) == Decimal("5000.00")


def make_user_other():
    u = User.objects.create_user(email="o@example.com", username="ouser", password=PASSWORD, role="CUSTOMER")
    u.mark_email_verified()
    return u


@pytest.mark.django_db
def test_new_account_cooldown_blocks_withdrawal():
    u = funded_user(); acct = add_account(u, age_hours=0)
    with pytest.raises(Exception):
        withdraw_req(u, acct)
    assert wallet_services.get_balance(u) == Decimal("5000.00")


@pytest.mark.django_db
def test_daily_limit(settings):
    u = funded_user("900000.00"); acct = add_account(u)
    with mock.patch.object(MonnifyProvider, "initiate_payout", return_value={"provider_reference": "x", "status": "processing"}):
        withdraw_req(u, acct, key="a", amount="400000")
        with pytest.raises(DomainError):
            withdraw_req(u, acct, key="b", amount="200000")


@pytest.mark.django_db
def test_password_lockout_after_repeated_failures():
    u = funded_user(); acct = add_account(u)
    for i in range(5):
        with pytest.raises(DomainError):
            withdraw_req(u, acct, key=f"k{i}", password="wrong")
    with pytest.raises(DomainError) as e:
        withdraw_req(u, acct, key="ok")  # even the right password is refused while locked
    assert "Too many" in str(e.value)


@pytest.mark.django_db
def test_tampered_ciphertext_refuses_and_refunds():
    u = funded_user(); acct = add_account(u)
    other = add_account(make_user_other())
    PayoutAccount.objects.filter(id=acct.id).update(destination_ciphertext=other.destination_ciphertext)
    with pytest.raises(DomainError):
        withdraw_req(u, PayoutAccount.objects.get(id=acct.id))
    assert wallet_services.get_balance(u) == Decimal("5000.00")


@pytest.mark.django_db
def test_payout_webhook_bad_signature_and_wrong_amount(client):
    u = funded_user(); acct = add_account(u)
    with mock.patch.object(MonnifyProvider, "initiate_payout", return_value={"provider_reference": "x", "status": "processing"}):
        w = withdraw_req(u, acct)
    body = json.dumps({"eventType": "FAILED_DISBURSEMENT", "eventData": {"reference": w.provider_reference, "amount": 1000}}).encode()
    r = client.post(reverse("wallet:withdrawal-webhook"), data=body, content_type="application/json", HTTP_MONNIFY_SIGNATURE="bad")
    assert r.status_code == 400
    wrong = json.dumps({"eventType": "FAILED_DISBURSEMENT", "eventData": {"reference": w.provider_reference, "amount": 5}}).encode()
    client.post(reverse("wallet:withdrawal-webhook"), data=wrong, content_type="application/json", HTTP_MONNIFY_SIGNATURE=sign(wrong))
    assert WithdrawalRequest.objects.get(id=w.id).status == "PROCESSING"
    assert wallet_services.get_balance(u) == Decimal("4000.00")


@pytest.mark.django_db
def test_reconcile():
    u = funded_user(); acct = add_account(u)
    with mock.patch.object(MonnifyProvider, "initiate_payout", return_value={"provider_reference": "x", "status": "processing"}):
        w1 = withdraw_req(u, acct, key="a"); w2 = withdraw_req(u, acct, key="b")
    WithdrawalRequest.objects.update(created_at=timezone.now() - timedelta(hours=1))
    answers = {w1.provider_reference: "completed", w2.provider_reference: "unknown"}
    with mock.patch.object(MonnifyProvider, "get_payout_status", side_effect=lambda reference: answers[reference]):
        counts = payment_services.reconcile_withdrawals()
    assert counts["completed"] == 1 and counts["needs_review"] == 1
    assert WithdrawalRequest.objects.get(id=w2.id).status == "PROCESSING"  # unknown is never refunded

"""
Payment provider abstraction. The rest of apps.wallet talks only to
this interface, never to a specific gateway's SDK -- swapping in a
real provider (Paystack, Flutterwave, Stripe) means implementing
PaymentProvider and pointing get_provider() at it; nothing in
payment_services.py, views.py, or the models should need to change.

StubProvider never makes a network call -- deposits "succeed"
synchronously at initiation time and payouts complete immediately,
which lets the full flow be exercised without external infrastructure.
Must never be selected outside dev/test -- see get_provider().
"""
from __future__ import annotations

import abc
import hashlib
import hmac
import json
import logging
import sys
import uuid
from decimal import Decimal, InvalidOperation

import requests
from django.conf import settings
from django.core.cache import cache
from django.core.exceptions import ImproperlyConfigured

from apps.common.exceptions import DomainError

logger = logging.getLogger(__name__)


class PayoutRejected(DomainError):
    """The provider DEFINITELY did not send the money (validation error, auth error, bad config,
    explicit failure). The caller may safely refund the wallet. Anything ambiguous -- timeouts,
    5xx, unparseable replies -- is NOT this: it is reported as status "processing" instead, because
    refunding a transfer that actually went out would lose real money."""


class PaymentProvider(abc.ABC):
    name: str
    # True when payouts need the real bank account number + bank code (so we must collect,
    # verify and encrypt them). The stub doesn't, which keeps the old masked-only flow working.
    requires_destination: bool = False

    @abc.abstractmethod
    def initiate_deposit(self, *, user, amount: Decimal, idempotency_key: str) -> dict:
        """Returns {"provider_reference": str, "client_action": dict}."""

    @abc.abstractmethod
    def verify_webhook_signature(self, *, headers, body: bytes) -> bool:
        """Never process a webhook whose signature doesn't verify."""

    @abc.abstractmethod
    def parse_webhook_event(self, *, body: bytes) -> dict:
        """Deposit events. Returns {"event_id", "provider_reference", "status", "amount"} or
        {"status": "ignored"}."""

    def verify_deposit(self, *, transaction_reference: str) -> dict | None:
        """Ask the provider directly whether this transaction was really paid, so a credit never
        rests on the webhook body alone. Returns {"paid": bool, "amount": Decimal}, or None when the
        provider has no such lookup (the stub). Raises DomainError if the provider can't be reached,
        so the webhook is retried instead of crediting on a guess."""
        return None

    @abc.abstractmethod
    def initiate_payout(self, *, withdrawal, destination: dict | None = None) -> dict:
        """Returns {"provider_reference": str, "status": "completed" | "processing"}.
        Raises PayoutRejected only when the provider definitely did not send the money."""

    @abc.abstractmethod
    def parse_payout_webhook_event(self, *, body: bytes) -> dict:
        """Returns {"event_id", "provider_reference", "status": "succeeded"|"failed"|"reversed",
        "amount"} or {"status": "ignored"}."""

    @abc.abstractmethod
    def get_payout_status(self, *, reference: str) -> str:
        """Returns "completed" | "failed" | "processing" | "unknown". Used by reconciliation."""

    @abc.abstractmethod
    def list_banks(self) -> list[dict]:
        """Returns [{"code": str, "name": str}, ...]."""

    @abc.abstractmethod
    def resolve_account(self, *, account_number: str, bank_code: str) -> str:
        """Returns the account holder's name, or raises DomainError if the account doesn't exist."""


class StubProvider(PaymentProvider):
    name = "stub"
    requires_destination = False

    def initiate_deposit(self, *, user, amount: Decimal, idempotency_key: str) -> dict:
        return {
            "provider_reference": f"stub_dep_{uuid.uuid4().hex[:16]}",
            "client_action": {"auto_completed": True},
        }

    def verify_webhook_signature(self, *, headers, body: bytes) -> bool:
        secret = (getattr(settings, "STUB_PAYMENT_WEBHOOK_SECRET", "") or "").encode()
        if not secret:
            return False  # never "verify" against an empty key
        expected = hmac.new(secret, body, hashlib.sha256).hexdigest()
        provided = headers.get("X-Stub-Signature", "")
        return hmac.compare_digest(expected, provided)

    def parse_webhook_event(self, *, body: bytes) -> dict:
        try:
            data = json.loads(body)
            return {
                "event_id": data["event_id"],
                "provider_reference": data["provider_reference"],
                "status": data["status"],
                "amount": Decimal(str(data["amount"])),
            }
        except (ValueError, KeyError, TypeError, InvalidOperation) as exc:
            raise DomainError("Malformed webhook payload.") from exc

    def initiate_payout(self, *, withdrawal, destination: dict | None = None) -> dict:
        return {"provider_reference": f"stub_payout_{uuid.uuid4().hex[:16]}", "status": "completed"}

    def parse_payout_webhook_event(self, *, body: bytes) -> dict:
        try:
            data = json.loads(body)
            return {
                "event_id": data["event_id"],
                "provider_reference": data["provider_reference"],
                "status": data["status"],
                "amount": Decimal(str(data["amount"])),
            }
        except (ValueError, KeyError, TypeError, InvalidOperation) as exc:
            raise DomainError("Malformed webhook payload.") from exc

    def get_payout_status(self, *, reference: str) -> str:
        return "completed"

    def list_banks(self) -> list[dict]:
        return [{"code": "000", "name": "Stub Bank"}]

    def resolve_account(self, *, account_number: str, bank_code: str) -> str:
        return "Stub Account Holder"


class MonnifyProvider(PaymentProvider):
    """
    Monnify: hosted checkout for deposits, single transfers (disbursements) for payouts.

    Deposits: login (Basic apiKey:secretKey -> bearer token, cached) -> init-transaction ->
    redirect the user to `checkoutUrl` -> Monnify POSTs SUCCESSFUL_TRANSACTION to our webhook,
    signed with HMAC-SHA512 (key = the Monnify secret key) in `monnify-signature`.

    Payouts: POST /api/v2/disbursements/single from our disbursement wallet
    (MONNIFY_SOURCE_ACCOUNT_NUMBER). The final result arrives on the disbursement webhook
    (SUCCESSFUL_DISBURSEMENT / FAILED_DISBURSEMENT / REVERSED_DISBURSEMENT), signed the same way.

    `provider_reference` is OUR reference for the attempt (PaymentIntent: paymentReference;
    withdrawal: the disbursement `reference`). Webhooks carry it back.
    """

    name = "monnify"
    requires_destination = True
    TOKEN_CACHE_KEY = "monnify:access_token"
    BANKS_CACHE_KEY = "monnify:banks"
    BANKS_CACHE_SECONDS = 24 * 60 * 60
    TIMEOUT = 15

    # Single-transfer statuses we treat as "the money is on its way / done / not sent".
    _PAYOUT_DONE = {"SUCCESS", "COMPLETED"}
    _PAYOUT_PENDING = {"PENDING", "AWAITING_PROCESSING", "IN_PROGRESS", "PROCESSING"}
    _PAYOUT_FAILED = {"FAILED", "EXPIRED", "REVERSED", "CANCELLED"}

    # -- helpers ---------------------------------------------------------------
    @staticmethod
    def _base() -> str:
        return settings.MONNIFY_BASE_URL.rstrip("/")

    def _token(self) -> str:
        token = cache.get(self.TOKEN_CACHE_KEY)
        if token:
            return token
        try:
            resp = requests.post(
                f"{self._base()}/api/v1/auth/login",
                auth=(settings.MONNIFY_API_KEY, settings.MONNIFY_SECRET_KEY),
                timeout=self.TIMEOUT,
            )
            resp.raise_for_status()
            body = resp.json()["responseBody"]
            token, expires_in = body["accessToken"], int(body.get("expiresIn", 300))
        except (requests.RequestException, KeyError, ValueError) as exc:
            raise DomainError("Payment provider is unavailable. Please try again shortly.") from exc
        cache.set(self.TOKEN_CACHE_KEY, token, max(expires_in - 60, 30))
        return token

    def _auth(self) -> dict:
        return {"Authorization": f"Bearer {self._token()}"}

    # -- deposits --------------------------------------------------------------
    def initiate_deposit(self, *, user, amount: Decimal, idempotency_key: str) -> dict:
        reference = f"EUPH-{uuid.uuid4().hex}"
        payload = {
            "amount": float(Decimal(amount).quantize(Decimal("0.01"))),
            "customerName": getattr(user, "username", "") or user.email,
            "customerEmail": user.email,
            "paymentReference": reference,
            "paymentDescription": "Euphoria wallet top-up",
            "currencyCode": "NGN",
            "contractCode": settings.MONNIFY_CONTRACT_CODE,
            "redirectUrl": settings.MONNIFY_REDIRECT_URL,
        }
        try:
            resp = requests.post(
                f"{self._base()}/api/v1/merchant/transactions/init-transaction",
                json=payload,
                headers=self._auth(),
                timeout=self.TIMEOUT,
            )
            resp.raise_for_status()
            checkout_url = resp.json()["responseBody"]["checkoutUrl"]
        except (requests.RequestException, KeyError, ValueError) as exc:
            raise DomainError("Could not start the payment. Please try again shortly.") from exc
        return {"provider_reference": reference, "client_action": {"checkout_url": checkout_url}}

    def verify_webhook_signature(self, *, headers, body: bytes) -> bool:
        secret = (settings.MONNIFY_SECRET_KEY or "").encode()
        if not secret:
            return False  # never "verify" against an empty key
        expected = hmac.new(secret, body, hashlib.sha512).hexdigest()
        provided = headers.get("monnify-signature") or headers.get("Monnify-Signature") or ""
        return hmac.compare_digest(expected, provided.strip().lower())

    def parse_webhook_event(self, *, body: bytes) -> dict:
        try:
            data = json.loads(body)
            event_type = data.get("eventType")
            event = data["eventData"]
        except (ValueError, KeyError, AttributeError) as exc:
            raise DomainError("Malformed webhook payload.") from exc

        if event_type != "SUCCESSFUL_TRANSACTION":
            return {"status": "ignored"}  # refund/settlement/disbursement events, if routed here
        try:
            amount = Decimal(str(event["amountPaid"]))
            paid = event.get("paymentStatus") == "PAID" and event.get("currency", "NGN") == "NGN"
            return {
                "event_id": event["transactionReference"],
                "provider_reference": event["paymentReference"],
                "status": "succeeded" if paid else "failed",
                "amount": amount,
            }
        except (KeyError, InvalidOperation) as exc:
            raise DomainError("Malformed webhook payload.") from exc

    def verify_deposit(self, *, transaction_reference: str) -> dict | None:
        from urllib.parse import quote
        try:
            resp = requests.get(
                f"{self._base()}/api/v2/transactions/{quote(transaction_reference, safe='')}",
                headers=self._auth(), timeout=self.TIMEOUT,
            )
            resp.raise_for_status()
            body = resp.json()["responseBody"]
            return {"paid": str(body.get("paymentStatus", "")).upper() == "PAID",
                    "amount": Decimal(str(body["amountPaid"]))}
        except (requests.RequestException, KeyError, ValueError, TypeError, InvalidOperation) as exc:
            raise DomainError("Could not confirm the payment with the provider yet.") from exc

    # -- bank list / account check ---------------------------------------------------
    def list_banks(self) -> list[dict]:
        cached = cache.get(self.BANKS_CACHE_KEY)
        if cached:
            return cached
        try:
            resp = requests.get(f"{self._base()}/api/v1/banks", headers=self._auth(), timeout=self.TIMEOUT)
            resp.raise_for_status()
            banks = sorted(
                ({"code": str(b["code"]), "name": b["name"]} for b in resp.json()["responseBody"]),
                key=lambda b: b["name"],
            )
        except (requests.RequestException, KeyError, ValueError, TypeError) as exc:
            raise DomainError("Could not load the bank list. Please try again shortly.") from exc
        cache.set(self.BANKS_CACHE_KEY, banks, self.BANKS_CACHE_SECONDS)
        return banks

    def resolve_account(self, *, account_number: str, bank_code: str) -> str:
        try:
            resp = requests.get(
                f"{self._base()}/api/v1/disbursements/account/validate",
                params={"accountNumber": account_number, "bankCode": bank_code},
                headers=self._auth(),
                timeout=self.TIMEOUT,
            )
        except requests.RequestException as exc:
            raise DomainError("Could not verify the account right now. Please try again shortly.") from exc
        if 400 <= resp.status_code < 500:
            raise DomainError("We couldn't find that account. Check the number and the bank.")
        try:
            resp.raise_for_status()
            name = (resp.json()["responseBody"]["accountName"] or "").strip()
        except (requests.RequestException, KeyError, ValueError, TypeError) as exc:
            raise DomainError("Could not verify the account right now. Please try again shortly.") from exc
        if not name:
            raise DomainError("We couldn't find that account. Check the number and the bank.")
        return name

    # -- payouts ---------------------------------------------------------------
    def initiate_payout(self, *, withdrawal, destination: dict | None = None) -> dict:
        reference = withdrawal.provider_reference
        if not destination or not destination.get("account_number") or not destination.get("bank_code"):
            raise PayoutRejected("Payout destination is missing.")
        if not settings.MONNIFY_SOURCE_ACCOUNT_NUMBER:
            raise PayoutRejected("MONNIFY_SOURCE_ACCOUNT_NUMBER is not configured.")

        payload = {
            "amount": float(Decimal(withdrawal.amount).quantize(Decimal("0.01"))),
            "reference": reference,
            "narration": "Euphoria wallet withdrawal",
            "destinationBankCode": destination["bank_code"],
            "destinationAccountNumber": destination["account_number"],
            "currency": "NGN",
            "sourceAccountNumber": settings.MONNIFY_SOURCE_ACCOUNT_NUMBER,
        }

        # Nothing has been sent until the POST below, so a login failure is a clean rejection.
        try:
            headers = self._auth()
        except DomainError as exc:
            raise PayoutRejected(str(exc)) from exc

        try:
            resp = requests.post(
                f"{self._base()}/api/v2/disbursements/single", json=payload, headers=headers, timeout=self.TIMEOUT
            )
        except requests.RequestException:
            # Timeout / connection drop AFTER we may have reached Monnify: outcome unknown.
            logger.warning("Monnify payout %s: no response, leaving PROCESSING for reconciliation.", reference)
            return {"provider_reference": reference, "status": "processing"}

        if resp.status_code >= 500:
            logger.warning("Monnify payout %s: HTTP %s, leaving PROCESSING.", reference, resp.status_code)
            return {"provider_reference": reference, "status": "processing"}

        try:
            body = resp.json()
        except ValueError:
            body = None

        if resp.status_code == 401:
            cache.delete(self.TOKEN_CACHE_KEY)  # stale token; the next call logs in again
            raise PayoutRejected("Payment provider rejected our credentials.")

        if resp.status_code >= 400:
            message = ((body or {}).get("responseMessage") or "") if isinstance(body, dict) else ""
            if "duplicate" in message.lower():
                return {"provider_reference": reference, "status": "processing"}  # already exists there
            # Provider text can mention our wallet balance etc., so it goes to the log, never to the user.
            logger.error("Monnify payout %s rejected: HTTP %s %s", reference, resp.status_code, message)
            raise PayoutRejected(f"Provider rejected the transfer ({resp.status_code}).")

        if not isinstance(body, dict):
            return {"provider_reference": reference, "status": "processing"}
        status = str((body.get("responseBody") or {}).get("status") or "").upper()
        if status in self._PAYOUT_DONE:
            return {"provider_reference": reference, "status": "completed"}
        if status == "OTP_EMAIL_SENT":
            logger.error(
                "Monnify payout %s needs OTP authorisation. Turn off OTP for API transfers on the "
                "disbursement wallet in the Monnify dashboard.", reference,
            )
            raise PayoutRejected("Provider requires OTP authorisation for transfers.")
        if status in self._PAYOUT_FAILED:
            raise PayoutRejected(f"Provider reported the transfer as {status}.")
        # PENDING / AWAITING_PROCESSING / anything we don't recognise: wait for the webhook.
        return {"provider_reference": reference, "status": "processing"}

    def parse_payout_webhook_event(self, *, body: bytes) -> dict:
        try:
            data = json.loads(body)
            event_type = data.get("eventType")
            event = data["eventData"]
        except (ValueError, KeyError, AttributeError) as exc:
            raise DomainError("Malformed webhook payload.") from exc

        statuses = {
            "SUCCESSFUL_DISBURSEMENT": "succeeded",
            "FAILED_DISBURSEMENT": "failed",
            "REVERSED_DISBURSEMENT": "reversed",
        }
        if event_type not in statuses:
            return {"status": "ignored"}
        try:
            reference = event["reference"]
            return {
                "event_id": f"{event_type}:{reference}",
                "provider_reference": reference,
                "status": statuses[event_type],
                "amount": Decimal(str(event["amount"])),
            }
        except (KeyError, InvalidOperation) as exc:
            raise DomainError("Malformed webhook payload.") from exc

    def get_payout_status(self, *, reference: str) -> str:
        try:
            resp = requests.get(
                f"{self._base()}/api/v2/disbursements/single/summary",
                params={"reference": reference},
                headers=self._auth(),
                timeout=self.TIMEOUT,
            )
            if resp.status_code != 200:
                return "unknown"  # includes "not found": never guess that money did NOT leave
            status = str(resp.json()["responseBody"]["status"]).upper()
        except (requests.RequestException, DomainError, KeyError, ValueError, TypeError):
            return "unknown"
        if status in self._PAYOUT_DONE:
            return "completed"
        if status in self._PAYOUT_FAILED:
            return "failed"
        if status in self._PAYOUT_PENDING:
            return "processing"
        return "unknown"


def _running_tests() -> bool:
    return "pytest" in sys.modules or (len(sys.argv) > 1 and sys.argv[1] == "test")


def get_provider() -> PaymentProvider:
    name = getattr(settings, "PAYMENT_PROVIDER", "stub")
    if name == "monnify":
        return MonnifyProvider()
    if name == "stub":
        # The stub auto-credits wallets with no real money. It must never run in production.
        if not (settings.DEBUG or getattr(settings, "ALLOW_STUB_PAYMENTS", False) or _running_tests()):
            raise ImproperlyConfigured(
                "PAYMENT_PROVIDER='stub' is only allowed with DEBUG=True, ALLOW_STUB_PAYMENTS=True or under tests. "
                "Set PAYMENT_PROVIDER='monnify' in production."
            )
        return StubProvider()
    raise ImproperlyConfigured(f"Unknown PAYMENT_PROVIDER {name!r}.")

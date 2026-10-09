import logging
import re
import uuid
from datetime import timedelta
from decimal import Decimal

from django.conf import settings
from django.core.cache import cache
from django.db import IntegrityError, transaction
from django.db.models import Sum
from django.utils import timezone

from apps.common.constants import AccountRole, LedgerEntryType, PaymentIntentStatus, WithdrawalStatus
from apps.common.exceptions import AccountNotEligibleError, DomainError
from apps.common.models import AuditAction, AuditLog
from apps.common.utils import clamp_page_size

from . import emails
from .models import PaymentIntent, PaymentWebhookEvent, PayoutAccount, Wallet, WithdrawalRequest
from . import crypto
from .providers import PayoutRejected, get_provider
from .services import _is_staff, deposit as _credit_wallet, reverse_withdrawal_credit, withdraw

# Placeholder business rules -- not deeply configurable yet, same
# spirit as this project's other "known gaps" notes.
MIN_DEPOSIT = Decimal("100.00")
MIN_WITHDRAWAL = Decimal("500.00")
logger = logging.getLogger(__name__)

# Settings-driven so they can be tuned without a deploy of code. The cooldown default is 24h
# (was 30 min): it is the main brake on "attacker takes over an account, adds their own bank
# account, drains the wallet".
PAYOUT_ACCOUNT_COOLDOWN = timedelta(hours=getattr(settings, "PAYOUT_ACCOUNT_COOLDOWN_HOURS", 24))
MAX_DAILY_WITHDRAWAL = Decimal(str(getattr(settings, "MAX_DAILY_WITHDRAWAL", "500000.00")))
MAX_PAYOUT_ACCOUNTS = int(getattr(settings, "MAX_PAYOUT_ACCOUNTS", 5))
PASSWORD_MAX_FAILURES = 5
PASSWORD_LOCK_SECONDS = 15 * 60
NUBAN = re.compile(r"^\d{10}$")
BANK_CODE = re.compile(r"^\d{2,6}$")


# ---------------------------------------------------------------------------
# Deposits -- replaces the Phase 5 placeholder DepositView. The
# critical difference: a wallet is NEVER credited off the caller's
# own say-so. initiate_deposit only creates a PENDING record and asks
# the provider to start payment; the actual credit happens exclusively
# in _complete_deposit, reached either by a verified provider webhook
# (process_deposit_webhook) or, for the stub provider only, a
# synchronous "auto-completed" response at initiation (there being no
# real gateway to redirect to in dev/test).
# ---------------------------------------------------------------------------
@transaction.atomic
def initiate_deposit(user, *, amount: Decimal, idempotency_key: str) -> PaymentIntent:
    if amount < MIN_DEPOSIT:
        raise DomainError(f"Minimum deposit is {MIN_DEPOSIT}.")

    existing = PaymentIntent.objects.filter(idempotency_key=idempotency_key).first()
    if existing is not None:
        if existing.user_id != user.id:
            raise DomainError("Invalid idempotency key.")
        return existing  # replaying the same request returns the same intent, never double-charges

    provider = get_provider()
    try:
        with transaction.atomic():  # savepoint: a unique-key clash must not poison the outer transaction
            intent = PaymentIntent.objects.create(
                user=user, amount=amount, provider=provider.name,
                status=PaymentIntentStatus.PENDING, idempotency_key=idempotency_key,
            )
    except IntegrityError:
        # Two simultaneous requests with the same key: the other one won. Return its intent.
        existing = PaymentIntent.objects.get(idempotency_key=idempotency_key)
        if existing.user_id != user.id:
            raise DomainError("Invalid idempotency key.")
        return existing
    result = provider.initiate_deposit(user=user, amount=amount, idempotency_key=idempotency_key)
    intent.provider_reference = result["provider_reference"]
    intent.checkout_url = result.get("client_action", {}).get("checkout_url", "")
    intent.save(update_fields=["provider_reference", "checkout_url", "updated_at"])

    if result.get("client_action", {}).get("auto_completed"):
        # _complete_deposit re-fetches under select_for_update and
        # returns the UPDATED row -- must reassign, not discard, or
        # the caller gets back a stale in-memory object still showing
        # PENDING even though the DB row was already marked SUCCEEDED.
        intent = _complete_deposit(intent, provider_event_id=f"auto_{intent.id}")

    return intent


@transaction.atomic
def _complete_deposit(intent: PaymentIntent, *, provider_event_id: str, allow_failed: bool = False) -> PaymentIntent:
    intent = PaymentIntent.objects.select_for_update().get(id=intent.id)
    # `allow_failed` is only set by a signed webhook that confirms the FULL amount was paid: a
    # customer who really paid must be credited even if we had earlier marked the intent FAILED
    # (e.g. an out-of-order "failed" attempt event, or a short payment that was topped up).
    ok = (PaymentIntentStatus.PENDING, PaymentIntentStatus.FAILED) if allow_failed else (PaymentIntentStatus.PENDING,)
    if intent.status not in ok:
        return intent  # already processed -- idempotent no-op, not an error; webhooks legitimately retry

    event, created = PaymentWebhookEvent.objects.get_or_create(
        provider=intent.provider, provider_event_id=provider_event_id,
        defaults={"payment_intent": intent, "payload_summary": {"amount": str(intent.amount)}},
    )
    if not created:
        return intent  # duplicate webhook delivery -- already handled

    _credit_wallet(
        intent.user, amount=intent.amount,
        idempotency_key=f"deposit:{intent.idempotency_key}",
        note=f"Deposit via {intent.provider} ({intent.provider_reference}).",
    )

    intent.status = PaymentIntentStatus.SUCCEEDED
    intent.failure_reason = ""
    intent.save(update_fields=["status", "failure_reason", "updated_at"])
    return intent


@transaction.atomic
def process_deposit_webhook(*, headers, body: bytes) -> PaymentIntent | None:
    provider = get_provider()
    if not provider.verify_webhook_signature(headers=headers, body=body):
        raise DomainError("Invalid webhook signature.")

    event_data = provider.parse_webhook_event(body=body)
    if event_data["status"] == "ignored":
        return None  # a valid, signed event we don't act on (acknowledged with 200 by the view)

    try:
        intent = PaymentIntent.objects.select_for_update().get(
            provider_reference=event_data["provider_reference"]
        )
    except PaymentIntent.DoesNotExist as exc:
        raise DomainError("Unknown payment intent.") from exc

    if event_data["status"] == "succeeded":
        # Never credit more than was actually paid. The webhook is signed, but the amount in it
        # is still what the provider says was collected, so compare it to what we asked for.
        if event_data["amount"] < intent.amount:
            if intent.status == PaymentIntentStatus.PENDING:
                intent.status = PaymentIntentStatus.FAILED
                intent.failure_reason = (
                    f"Amount paid ({event_data['amount']}) is less than expected ({intent.amount}). "
                    "Needs manual reconciliation."
                )
                intent.save(update_fields=["status", "failure_reason", "updated_at"])
            return intent
        if intent.status in (PaymentIntentStatus.PENDING, PaymentIntentStatus.FAILED):
            confirmed = provider.verify_deposit(transaction_reference=event_data["event_id"])
            if confirmed is not None and (not confirmed["paid"] or confirmed["amount"] < intent.amount):
                logger.error("Deposit webhook for intent %s not confirmed by provider: %s", intent.id, confirmed)
                raise DomainError("Payment could not be confirmed with the provider.")
        return _complete_deposit(intent, provider_event_id=event_data["event_id"], allow_failed=True)

    if event_data["status"] == "failed":
        if intent.status == PaymentIntentStatus.PENDING:
            intent.status = PaymentIntentStatus.FAILED
            intent.failure_reason = "Provider reported failure."
            intent.save(update_fields=["status", "failure_reason", "updated_at"])
        return intent

    raise DomainError("Unrecognized webhook event status.")


def list_payment_intents(user, *, page_size=None):
    qs = PaymentIntent.objects.filter(user=user).order_by("-created_at")
    return qs, clamp_page_size(page_size)


# ---------------------------------------------------------------------------
# Payout accounts. With a real provider the full account number + bank code are required for
# every transfer, so they are collected ONCE here, checked against the bank (name lookup), and
# stored only as a sealed (encrypted) blob -- see apps.wallet.crypto. They are never returned by
# any API, never logged, and never copied into any plain column. With the stub provider the old
# behaviour is kept: only the masked reference is stored.
# ---------------------------------------------------------------------------
def add_payout_account(user, *, label: str, raw_account_number: str, bank_code: str = "") -> PayoutAccount:
    provider = get_provider()
    label = (label or "").strip()
    raw = (raw_account_number or "").strip()
    bank_code = (bank_code or "").strip()

    if not provider.requires_destination:
        if not label:
            raise DomainError("A label is required (e.g. 'GTBank').")
        if len(raw) < 4:
            raise DomainError("Account number is too short.")
        return PayoutAccount.objects.create(user=user, label=label, masked_reference=f"****{raw[-4:]}")

    if not NUBAN.match(raw):
        raise DomainError("Account number must be exactly 10 digits.")
    if not BANK_CODE.match(bank_code):
        raise DomainError("Choose a bank.")
    banks = {b["code"]: b["name"] for b in provider.list_banks()}
    if bank_code not in banks:
        raise DomainError("Choose a bank from the list.")

    if PayoutAccount.objects.filter(user=user, is_active=True).count() >= MAX_PAYOUT_ACCOUNTS:
        raise DomainError(f"You can have at most {MAX_PAYOUT_ACCOUNTS} payout accounts.")

    fingerprint = crypto.fingerprint(bank_code, raw)
    if PayoutAccount.objects.filter(user=user, destination_fingerprint=fingerprint).exists():
        raise DomainError("You've already added this account.")

    account_name = provider.resolve_account(account_number=raw, bank_code=bank_code)

    account = PayoutAccount(
        user=user, label=banks[bank_code], masked_reference=f"****{raw[-4:]}", bank_code=bank_code,
        account_name=account_name, destination_fingerprint=fingerprint,
    )
    account.destination_ciphertext = crypto.seal({"id": str(account.id), "n": raw, "b": bank_code})
    try:
        with transaction.atomic():
            account.save()
    except IntegrityError as exc:  # concurrent duplicate add
        raise DomainError("You've already added this account.") from exc

    logger.info("Payout account %s added for user %s (%s).", account.id, user.id, account.masked_reference)
    return account


def _destination_for(account: PayoutAccount) -> dict:
    """Decrypt and verify a payout destination. Raises crypto.SealError if anything is off."""
    if not account.destination_ciphertext:
        raise crypto.SealError("No stored destination.")
    data = crypto.unseal(account.destination_ciphertext)
    if data.get("id") != str(account.id) or data.get("b") != account.bank_code:
        raise crypto.SealError("Stored destination does not match this account.")
    return {"account_number": data["n"], "bank_code": data["b"]}


def list_payout_accounts(user):
    return PayoutAccount.objects.filter(user=user, is_active=True).order_by("-created_at")


def list_banks():
    return get_provider().list_banks()


# ---------------------------------------------------------------------------
# Withdrawals -- sensitive action, requires the current password re-entered.
#
# ORDER OF OPERATIONS (this matters for real money):
#   1. one transaction: validate, debit the wallet, create the row as PROCESSING -> COMMIT
#   2. call the provider OUTSIDE any transaction
#   3. settle the row in a new transaction (COMPLETED / refund / leave PROCESSING)
# The old code called the provider inside the debit transaction, so any exception after the
# transfer was sent (e.g. the confirmation email) would roll the debit back while the money
# had already left. The view must therefore NOT be wrapped in ATOMIC_REQUESTS (see views.py).
# ---------------------------------------------------------------------------
def _check_password(user, password: str) -> None:
    key = f"withdrawal-pw-fail:{user.id}"
    if (cache.get(key) or 0) >= PASSWORD_MAX_FAILURES:
        raise DomainError("Too many incorrect password attempts. Try again in 15 minutes.")
    if not user.check_password(password):
        cache.add(key, 0, PASSWORD_LOCK_SECONDS)
        try:
            cache.incr(key)
        except ValueError:
            cache.set(key, 1, PASSWORD_LOCK_SECONDS)
        raise DomainError("Current password is incorrect.")
    cache.delete(key)


def verify_password(user, password: str, otp_code: str = "") -> None:
    """Public re-auth check (rate-limited). Call BEFORE reserving any money for a sensitive action."""
    _check_password(user, password)
    _check_otp(user, otp_code)


def _check_otp(user, otp_code: str) -> None:
    """When the user has 2FA on, a withdrawal also needs a current authenticator code."""
    if not user.two_factor_enabled:
        return
    key = f"withdrawal-otp-fail:{user.id}"
    if (cache.get(key) or 0) >= PASSWORD_MAX_FAILURES:
        raise DomainError("Too many incorrect codes. Try again in 15 minutes.")
    from apps.accounts.services import _totp_valid
    if not _totp_valid(user, (otp_code or "").strip()):
        cache.add(key, 0, PASSWORD_LOCK_SECONDS)
        try:
            cache.incr(key)
        except ValueError:
            cache.set(key, 1, PASSWORD_LOCK_SECONDS)
        raise DomainError("A valid authenticator code is required to withdraw.")
    cache.delete(key)


def request_withdrawal(
    user, *, amount: Decimal, payout_account_id, current_password: str, idempotency_key: str, source: str = "WALLET",
    earning_allocations=None, otp_code: str = ""
) -> WithdrawalRequest:
    _check_password(user, current_password)
    _check_otp(user, otp_code)
    if source not in {"WALLET", "EARNINGS"}:
        raise DomainError("Invalid withdrawal source.")
    withdrawal, created = _create_withdrawal(
        user, amount=amount, payout_account_id=payout_account_id, idempotency_key=idempotency_key, source=source, earning_allocations=earning_allocations or []
    )
    if not created:
        return withdrawal  # replay of the same request: never pay twice
    return _dispatch_payout(withdrawal.id)


@transaction.atomic
def _create_withdrawal(user, *, amount, payout_account_id, idempotency_key, source="WALLET", earning_allocations=None):
    if amount < MIN_WITHDRAWAL:
        raise DomainError(f"Minimum withdrawal is {MIN_WITHDRAWAL}.")

    # Serialize every withdrawal attempt of this user on their wallet row BEFORE reading anything.
    # Without this, two concurrent requests both read the same "withdrawn in last 24h" total, both
    # pass the daily limit, and both go through (the balance check alone was locked, the limit wasn't).
    Wallet.objects.select_for_update().get_or_create(user=user)

    existing = WithdrawalRequest.objects.filter(idempotency_key=idempotency_key).first()
    if existing is not None:
        if existing.user_id != user.id:
            raise DomainError("Invalid idempotency key.")
        if existing.amount != amount or str(existing.payout_account_id) != str(payout_account_id):
            raise DomainError("This idempotency key was already used for a different withdrawal.")
        return existing, False

    try:
        payout_account = PayoutAccount.objects.get(id=payout_account_id, user=user, is_active=True)
    except PayoutAccount.DoesNotExist as exc:
        raise DomainError("Payout account not found.") from exc

    provider = get_provider()
    if provider.requires_destination and not payout_account.destination_ciphertext:
        raise DomainError("This payout account was saved before withdrawals were enabled. Please add it again.")

    if timezone.now() - payout_account.created_at < PAYOUT_ACCOUNT_COOLDOWN:
        raise AccountNotEligibleError(
            f"This payout account was added too recently. Please wait {PAYOUT_ACCOUNT_COOLDOWN} before using it."
        )

    since = timezone.now() - timedelta(hours=24)
    recent = (
        WithdrawalRequest.objects.filter(user=user, created_at__gte=since)
        .exclude(status=WithdrawalStatus.REVERSED)
        .aggregate(total=Sum("amount"))["total"]
        or Decimal("0")
    )
    if recent + amount > MAX_DAILY_WITHDRAWAL:
        raise DomainError(f"Daily withdrawal limit is {MAX_DAILY_WITHDRAWAL}.")

    if source == "WALLET":
        # Raises InsufficientBalanceError (and rolls everything back) if the customer
        # spending balance cannot cover the withdrawal.
        withdraw(
            user, amount=amount, idempotency_key=f"withdrawal:{idempotency_key}",
            note=f"Withdrawal to {payout_account.label} {payout_account.masked_reference}.",
        )
    else:
        # Planner earnings have already been reserved by apps.economy.services.
        # Never debit the customer wallet for an earnings payout.
        from apps.economy.models import PlannerEarning
        # The allocations come from the server (economy.withdraw_earnings), never from the client.
        # Prove they really are reserved for this user and add up to exactly the payout amount.
        total = Decimal("0")
        for a in earning_allocations or []:
            e = PlannerEarning.objects.select_for_update().filter(id=a["earning_id"], planner=user).first()
            take = Decimal(str(a["amount"]))
            if e is None or take <= 0 or e.reserved_amount < take:
                raise DomainError("Insufficient available planner earnings.")
            total += take
        if total != amount:
            raise DomainError("Insufficient available planner earnings.")

    try:
        withdrawal = WithdrawalRequest.objects.create(
            user=user, amount=amount, source=source, earning_allocations=earning_allocations or [], payout_account=payout_account, status=WithdrawalStatus.PROCESSING,
            idempotency_key=idempotency_key, provider=provider.name,
            provider_reference=f"EUPW-{uuid.uuid4().hex}",  # OUR reference: also Monnify's idempotency key
        )
    except IntegrityError as exc:  # two simultaneous requests with the same key; the other one won
        raise DomainError("This withdrawal is already being processed.") from exc
    return withdrawal, True


def _dispatch_payout(withdrawal_id) -> WithdrawalRequest:
    withdrawal = WithdrawalRequest.objects.select_related("payout_account", "user").get(id=withdrawal_id)
    provider = get_provider()

    destination = None
    if provider.requires_destination:
        try:
            destination = _destination_for(withdrawal.payout_account)
        except crypto.SealError:
            logger.error("Payout destination for account %s failed verification.", withdrawal.payout_account_id)
            _refund(withdrawal.id, reason="Payout details could not be verified.")
            raise DomainError("This payout account can't be used. Please add it again. You were not charged.")

    try:
        result = provider.initiate_payout(withdrawal=withdrawal, destination=destination)
    except PayoutRejected as exc:
        _refund(withdrawal.id, reason=str(exc)[:250])
        raise DomainError("The withdrawal couldn't be sent. You were not charged. Please try again later.")
    except Exception:  # noqa: BLE001 -- outcome unknown: never refund on a guess
        logger.exception("Payout %s: unexpected error, leaving PROCESSING for reconciliation.", withdrawal.id)
        return withdrawal

    if result.get("status") == "completed":
        withdrawal, _ = _mark_completed(withdrawal.id)
    return withdrawal


@transaction.atomic
def _mark_completed(withdrawal_id):
    w = WithdrawalRequest.objects.select_for_update().get(id=withdrawal_id)
    if w.status != WithdrawalStatus.PROCESSING:
        return w, False
    if w.source == "EARNINGS":
        from apps.economy.services import finalize_earning_withdrawal
        finalize_earning_withdrawal(amount=w.amount, user=w.user, reservation_key=w.idempotency_key, success=True, allocations=w.earning_allocations)
    w.status = WithdrawalStatus.COMPLETED
    w.completed_at = timezone.now()
    w.save(update_fields=["status", "completed_at", "updated_at"])
    transaction.on_commit(lambda: _notify_completed(w.id))
    return w, True


def _notify_completed(withdrawal_id):
    try:
        w = WithdrawalRequest.objects.select_related("user").get(id=withdrawal_id)
        emails.send_withdrawal_confirmation_email(w.user, w)
    except Exception:  # noqa: BLE001 -- a failed email must never affect money
        logger.exception("Withdrawal confirmation email failed for %s", withdrawal_id)


@transaction.atomic
def _refund(withdrawal_id, *, reason: str, allowed=(WithdrawalStatus.PROCESSING,)):
    """Credit the wallet back, exactly once, and mark the withdrawal REVERSED."""
    w = WithdrawalRequest.objects.select_for_update().get(id=withdrawal_id)
    if w.status not in allowed:
        return w, False
    if w.source == "EARNINGS":
        if w.status == WithdrawalStatus.COMPLETED:
            # Money already counted as withdrawn (bank reversed it later): put it back as available.
            from apps.economy.services import reverse_earning_withdrawal
            reverse_earning_withdrawal(user=w.user, amount=w.amount, allocations=w.earning_allocations)
        else:
            from apps.economy.services import finalize_earning_withdrawal
            finalize_earning_withdrawal(amount=w.amount, user=w.user, reservation_key=w.idempotency_key,
                                        success=False, allocations=w.earning_allocations)
    else:
        reverse_withdrawal_credit(
            w.user, amount=w.amount, idempotency_key=f"withdrawal-refund:{w.id}",
            note=f"Refund of withdrawal {w.id}: {reason}",
        )
    w.status = WithdrawalStatus.REVERSED
    w.failure_reason = reason[:255]
    w.save(update_fields=["status", "failure_reason", "updated_at"])
    return w, True


# -- payout webhook -------------------------------------------------------------------
@transaction.atomic
def process_payout_webhook(*, headers, body: bytes) -> WithdrawalRequest | None:
    provider = get_provider()
    if not provider.verify_webhook_signature(headers=headers, body=body):
        raise DomainError("Invalid webhook signature.")
    event = provider.parse_payout_webhook_event(body=body)
    if event["status"] == "ignored":
        return None

    try:
        w = WithdrawalRequest.objects.select_for_update().get(
            provider=provider.name, provider_reference=event["provider_reference"]
        )
    except WithdrawalRequest.DoesNotExist as exc:
        raise DomainError("Unknown withdrawal.") from exc

    if event["amount"] != w.amount:
        # Signed but wrong amount: don't move money either way, flag for a human.
        logger.error("Payout webhook amount mismatch for %s: got %s, expected %s", w.id, event["amount"], w.amount)
        return w

    _, created = PaymentWebhookEvent.objects.get_or_create(
        provider=provider.name, provider_event_id=event["event_id"],
        defaults={"payload_summary": {"withdrawal_id": str(w.id), "status": event["status"]}},
    )
    if not created:
        return w  # duplicate delivery

    if event["status"] == "succeeded":
        w, _ = _mark_completed(w.id)
    elif event["status"] == "failed":
        w, _ = _refund(w.id, reason="Provider reported the transfer failed.")
    elif event["status"] == "reversed":
        # A transfer that was COMPLETED can still be reversed by the bank later.
        w, _ = _refund(
            w.id, reason="Provider reversed the transfer.",
            allowed=(WithdrawalStatus.PROCESSING, WithdrawalStatus.COMPLETED),
        )
    return w


# -- reconciliation (for transfers whose outcome we never heard about) --------------------
def reconcile_withdrawals(*, older_than_minutes: int = 10) -> dict:
    """Ask the provider about PROCESSING withdrawals older than the threshold. Safe to re-run.
    Only refunds on an explicit "failed" from the provider; "unknown" is left for a human."""
    provider = get_provider()
    cutoff = timezone.now() - timedelta(minutes=older_than_minutes)
    counts = {"completed": 0, "refunded": 0, "still_processing": 0, "needs_review": 0}
    stuck = WithdrawalRequest.objects.filter(
        status=WithdrawalStatus.PROCESSING, provider=provider.name, created_at__lt=cutoff
    ).exclude(provider_reference="")
    for w in stuck:
        status = provider.get_payout_status(reference=w.provider_reference)
        if status == "completed":
            _mark_completed(w.id)
            counts["completed"] += 1
        elif status == "failed":
            _refund(w.id, reason="Provider reported the transfer failed.")
            counts["refunded"] += 1
        elif status == "processing":
            counts["still_processing"] += 1
        else:
            counts["needs_review"] += 1
            logger.warning("Withdrawal %s: provider status unknown, needs manual review.", w.id)
    return counts


def list_withdrawals(user, *, page_size=None):
    qs = WithdrawalRequest.objects.filter(user=user).order_by("-created_at")
    return qs, clamp_page_size(page_size)


@transaction.atomic
def reverse_withdrawal(staff_user, withdrawal_id, *, reason: str) -> WithdrawalRequest:
    """Staff-only: credits the funds back for a COMPLETED withdrawal (Sec 15's WITHDRAWAL_REVERSAL).
    WARNING: with a real provider a COMPLETED transfer has already left your Monnify wallet.
    Only use this after confirming with the provider that the money came back (Monnify's own
    reversal webhook does this automatically); otherwise you refund money twice."""
    if not _is_staff(staff_user):
        raise AccountNotEligibleError("Only staff can reverse a withdrawal.")
    if not reason.strip():
        raise DomainError("A reason is required to reverse a withdrawal.")

    withdrawal = WithdrawalRequest.objects.select_for_update().get(id=withdrawal_id)
    if withdrawal.status != WithdrawalStatus.COMPLETED:
        raise DomainError(f"Cannot reverse a withdrawal in status {withdrawal.status}.")

    if withdrawal.source == "EARNINGS":
        from apps.economy.services import reverse_earning_withdrawal
        reverse_earning_withdrawal(user=withdrawal.user, amount=withdrawal.amount, allocations=withdrawal.earning_allocations)
    else:
        reverse_withdrawal_credit(
            withdrawal.user, amount=withdrawal.amount,
            idempotency_key=f"withdrawal-refund:{withdrawal.id}",  # same key as automatic refunds: can't double-refund
            note=f"Reversal of withdrawal {withdrawal.id}: {reason}",
        )

    withdrawal.status = WithdrawalStatus.REVERSED
    withdrawal.reversed_by = staff_user
    withdrawal.failure_reason = reason
    withdrawal.save(update_fields=["status", "reversed_by", "failure_reason", "updated_at"])

    AuditLog.objects.create(
        actor=staff_user, action=AuditAction.WITHDRAWAL_REVERSED, target_user=withdrawal.user,
        amount=withdrawal.amount, reason=reason, metadata={"withdrawal_id": str(withdrawal.id)},
    )
    return withdrawal

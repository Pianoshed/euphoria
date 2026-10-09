from decimal import Decimal
import uuid

from django.db import models, transaction
from django.utils import timezone

from apps.common.constants import AccountRole, EscrowStatus, LedgerEntryType
from apps.common.exceptions import AccountNotEligibleError, DomainError, InsufficientBalanceError, InvalidStateTransitionError
from apps.common.models import AuditAction, AuditLog
from apps.common.utils import clamp_page_size

from .models import Escrow, LedgerEntry, PromotionalCredit, Wallet


def _is_staff(user) -> bool:
    return bool(user.is_staff or user.role in (AccountRole.MODERATOR, AccountRole.ADMIN))


def get_balance(user) -> Decimal:
    wallet, _ = Wallet.objects.get_or_create(user=user)
    return wallet.balance


def list_ledger(user, *, page_size=None):
    qs = LedgerEntry.objects.filter(wallet__user=user).order_by("-created_at")
    return qs, clamp_page_size(page_size)


def _existing_entry_for_key(wallet: Wallet, idempotency_key: str | None) -> LedgerEntry | None:
    if not idempotency_key:
        return None
    return LedgerEntry.objects.filter(wallet=wallet, idempotency_key=idempotency_key).first()


# --- Deposits ----------------------------------------------------------------------
#
# This function itself is fine and stays: it's the low-level "credit
# the wallet + write the ledger entry" primitive, used internally by
# apps.wallet.payment_services._complete_deposit once a provider
# webhook has actually verified. What no longer exists is a public,
# self-serve API endpoint that let a client call this directly on
# their own say-so (the Phase 5 placeholder) -- see
# apps.wallet.urls for the removal note.

@transaction.atomic
def deposit(user, *, amount: Decimal, idempotency_key: str = "", note: str = "") -> LedgerEntry:
    if amount <= 0:
        raise DomainError("Deposit amount must be positive.")

    wallet, _ = Wallet.objects.select_for_update().get_or_create(user=user)
    existing = _existing_entry_for_key(wallet, idempotency_key)
    if existing:
        return existing

    new_balance = wallet.balance + amount
    wallet.balance = new_balance
    wallet.save(update_fields=["balance", "updated_at"])
    return LedgerEntry.objects.create(
        wallet=wallet,
        entry_type=LedgerEntryType.TOKEN_DEPOSIT,
        amount=amount,
        balance_after=new_balance,
        idempotency_key=idempotency_key,
        note=note or "Deposit.",
    )


# --- Escrow --------------------------------------------------------------------------
#
# These are called from within apps.bookings.services' already-locked,
# already-role-checked booking transition functions -- they don't
# re-check who's allowed to fund/release/refund a booking, that's the
# caller's job. What they own is the money movement itself: locking
# the right wallet, checking balance, writing the ledger entry and the
# escrow row atomically.

@transaction.atomic
def hold_escrow(customer, *, booking, idempotency_key: str = "") -> Escrow:
    """Hold a booking amount using paid wallet value only.

    Euphoria Plan bookings use hold_escrow_for_plan so promotional credits can be
    consumed separately and remain non-withdrawable. Existing service bookings keep
    this original paid-wallet-only path.
    """
    wallet, _ = Wallet.objects.select_for_update().get_or_create(user=customer)
    existing = _existing_entry_for_key(wallet, idempotency_key)
    if existing:
        return Escrow.objects.get(booking=booking)
    amount = booking.gross_amount or booking.agreed_price
    if wallet.balance < amount:
        raise InsufficientBalanceError("Insufficient wallet balance to fund this booking.")
    new_balance = wallet.balance - amount
    wallet.balance = new_balance
    wallet.save(update_fields=["balance", "updated_at"])
    LedgerEntry.objects.create(
        wallet=wallet, entry_type=LedgerEntryType.ESCROW_HOLD, amount=-amount,
        balance_after=new_balance, booking=booking, idempotency_key=idempotency_key,
        note=f"Escrow hold for booking {booking.id}",
    )
    return Escrow.objects.create(booking=booking, amount=amount, paid_amount=amount)


def _sync_promotional_balance_locked(wallet):
    now = timezone.now()
    active_total = PromotionalCredit.objects.filter(
        user=wallet.user, remaining_amount__gt=0
    ).filter(models.Q(expires_at__isnull=True) | models.Q(expires_at__gt=now)).aggregate(
        total=models.Sum("remaining_amount")
    )["total"] or Decimal("0")
    active_total = active_total.quantize(Decimal("0.01"))
    if wallet.promotional_balance != active_total:
        wallet.promotional_balance = active_total
        wallet.save(update_fields=["promotional_balance", "updated_at"])
    return active_total


@transaction.atomic
def grant_promotional_credit(user, *, amount: Decimal, expires_at=None, plan=None, category=None,
                            source="PROMOTION", reference=None, metadata=None) -> PromotionalCredit:
    amount = Decimal(amount).quantize(Decimal("0.01"))
    if amount <= 0:
        raise DomainError("Promotional credit amount must be positive.")
    if expires_at is not None and expires_at <= timezone.now():
        raise DomainError("Promotional credit expiry must be in the future.")
    reference = reference or f"promo:{uuid.uuid4()}"
    credit = PromotionalCredit.objects.create(
        user=user, original_amount=amount, remaining_amount=amount, expires_at=expires_at,
        plan=plan, category=category, source=source, reference=reference, metadata=metadata or {}
    )
    wallet, _ = Wallet.objects.select_for_update().get_or_create(user=user)
    _sync_promotional_balance_locked(wallet)
    LedgerEntry.objects.create(
        wallet=wallet, entry_type=LedgerEntryType.PROMOTIONAL_CREDIT, amount=amount,
        balance_after=wallet.balance, idempotency_key=f"promo-grant:{reference}",
        note=f"Promotional credit: {source}",
    )
    return credit


@transaction.atomic
def hold_escrow_for_plan(customer, *, booking, plan, idempotency_key: str = "") -> Escrow:
    """Fund a plan using promotional value first, then paid wallet value.

    The escrow records exactly which promotional grants were consumed, allowing an
    accurate refund without ever making promotional value withdrawable.
    """
    wallet, _ = Wallet.objects.select_for_update().get_or_create(user=customer)
    existing = _existing_entry_for_key(wallet, idempotency_key)
    if existing:
        return Escrow.objects.get(booking=booking)
    amount = booking.gross_amount or booking.agreed_price
    if amount <= 0:
        raise DomainError("Booking amount must be positive.")

    _sync_promotional_balance_locked(wallet)
    now = timezone.now()
    credits = list(PromotionalCredit.objects.select_for_update().filter(
        user=customer, remaining_amount__gt=0
    ).filter(models.Q(expires_at__isnull=True) | models.Q(expires_at__gt=now)).filter(
        models.Q(plan__isnull=True) | models.Q(plan=plan)
    ).filter(
        models.Q(category__isnull=True) | models.Q(category_id=plan.category_id)
    ).order_by("expires_at", "created_at"))

    promo_remaining = amount
    allocations = []
    for credit in credits:
        if promo_remaining <= 0:
            break
        take = min(credit.remaining_amount, promo_remaining)
        credit.remaining_amount = (credit.remaining_amount - take).quantize(Decimal("0.01"))
        credit.save(update_fields=["remaining_amount", "updated_at"])
        allocations.append({"credit_id": str(credit.id), "amount": str(take)})
        promo_remaining = (promo_remaining - take).quantize(Decimal("0.01"))

    promotional_amount = amount - promo_remaining
    paid_amount = promo_remaining
    if wallet.balance < paid_amount:
        # Roll back promotional allocations in the same transaction before raising.
        for allocation in allocations:
            credit = PromotionalCredit.objects.select_for_update().get(id=allocation["credit_id"])
            credit.remaining_amount = (credit.remaining_amount + Decimal(allocation["amount"])).quantize(Decimal("0.01"))
            credit.save(update_fields=["remaining_amount", "updated_at"])
        raise InsufficientBalanceError("Insufficient wallet balance and promotional credits to fund this booking.")

    wallet.balance = (wallet.balance - paid_amount).quantize(Decimal("0.01"))
    wallet.save(update_fields=["balance", "updated_at"])
    LedgerEntry.objects.create(
        wallet=wallet, entry_type=LedgerEntryType.ESCROW_HOLD, amount=-paid_amount,  # paid part only: promo lives in PromotionalCredit
        balance_after=wallet.balance, booking=booking, idempotency_key=idempotency_key,
        note=f"Plan escrow hold: paid={paid_amount} promotional={promotional_amount}",
    )
    escrow = Escrow.objects.create(
        booking=booking, amount=amount, paid_amount=paid_amount,
        promotional_amount=promotional_amount, promotional_allocations=allocations,
        status=EscrowStatus.HELD,
    )
    _sync_promotional_balance_locked(wallet)
    return escrow


def promotional_balance(user):
    wallet, _ = Wallet.objects.get_or_create(user=user)
    with transaction.atomic():
        wallet = Wallet.objects.select_for_update().get(user=user)
        return _sync_promotional_balance_locked(wallet)


@transaction.atomic
def release_escrow(booking) -> Escrow:
    """Legacy escrow release path kept for non-economy bookings.

    Euphoria Plan bookings are settled through apps.economy.services.settle_booking,
    which releases escrow without crediting the provider's customer wallet. This
    function therefore remains for existing service bookings only.
    """
    escrow = Escrow.objects.select_for_update().get(booking=booking)
    if escrow.status != EscrowStatus.HELD:
        raise InvalidStateTransitionError("This escrow is not currently held.")

    wallet, _ = Wallet.objects.select_for_update().get_or_create(user=booking.provider)
    new_balance = wallet.balance + escrow.amount
    wallet.balance = new_balance
    wallet.save(update_fields=["balance", "updated_at"])
    LedgerEntry.objects.create(
        wallet=wallet,
        entry_type=LedgerEntryType.ESCROW_RELEASE,
        amount=escrow.amount,
        balance_after=new_balance,
        booking=booking,
        idempotency_key=f"legacy-escrow-release:{booking.id}",
        note=f"Escrow release for booking {booking.id}",
    )
    escrow.status = EscrowStatus.RELEASED
    escrow.released_at = timezone.now()
    escrow.save(update_fields=["status", "released_at", "updated_at"])
    return escrow


@transaction.atomic
def refund_escrow(booking) -> Escrow:
    escrow = Escrow.objects.select_for_update().get(booking=booking)
    if escrow.status != EscrowStatus.HELD:
        raise InvalidStateTransitionError("This escrow is not currently held.")

    wallet, _ = Wallet.objects.select_for_update().get_or_create(user=booking.customer)
    paid_amount = Decimal(escrow.paid_amount or 0)
    promotional_amount = Decimal(escrow.promotional_amount or 0)
    if paid_amount + promotional_amount == 0:
        # Escrow created before paid/promotional tracking existed (columns default to 0): it was
        # funded entirely from the paid wallet, so refund the full amount rather than nothing.
        paid_amount = Decimal(escrow.amount)

    if paid_amount:
        wallet.balance = (wallet.balance + paid_amount).quantize(Decimal("0.01"))
    wallet.save(update_fields=["balance", "updated_at"])
    LedgerEntry.objects.create(
        wallet=wallet, entry_type=LedgerEntryType.ESCROW_REFUND, amount=paid_amount,  # matches the balance change
        balance_after=wallet.balance, booking=booking,
        idempotency_key=f"escrow-refund:{booking.id}",
        note=f"Plan escrow refund: paid={paid_amount} promotional={promotional_amount}",
    )

    # Restore promotional value to the exact grants originally consumed. Expired grants
    # retain their original expiry; they therefore cannot be revived as indefinitely valid cash-equivalent value.
    for allocation in escrow.promotional_allocations or []:
        credit = PromotionalCredit.objects.select_for_update().get(id=allocation["credit_id"])
        credit.remaining_amount = (credit.remaining_amount + Decimal(allocation["amount"])).quantize(Decimal("0.01"))
        credit.save(update_fields=["remaining_amount", "updated_at"])
    _sync_promotional_balance_locked(wallet)

    escrow.status = EscrowStatus.REFUNDED
    escrow.refunded_at = timezone.now()
    escrow.save(update_fields=["status", "refunded_at", "updated_at"])
    return escrow


# --- Withdrawals (Phase 6 calls these; Phase 5's ledger primitives
# live here alongside deposit/hold_escrow/etc. for consistency) -----------------------

@transaction.atomic
def withdraw(user, *, amount: Decimal, idempotency_key: str = "", note: str = "") -> LedgerEntry:
    if amount <= 0:
        raise DomainError("Withdrawal amount must be positive.")

    wallet, _ = Wallet.objects.select_for_update().get_or_create(user=user)
    existing = _existing_entry_for_key(wallet, idempotency_key)
    if existing:
        return existing

    if wallet.balance < amount:
        raise InsufficientBalanceError("Insufficient wallet balance for this withdrawal.")

    new_balance = wallet.balance - amount
    wallet.balance = new_balance
    wallet.save(update_fields=["balance", "updated_at"])
    return LedgerEntry.objects.create(
        wallet=wallet,
        entry_type=LedgerEntryType.WITHDRAWAL,
        amount=-amount,
        balance_after=new_balance,
        idempotency_key=idempotency_key,
        note=note or "Withdrawal.",
    )


@transaction.atomic
def reverse_withdrawal_credit(user, *, amount: Decimal, idempotency_key: str = "", note: str = "") -> LedgerEntry:
    """Credits funds back after a staff-initiated withdrawal reversal.
    Uses its own entry_type (WITHDRAWAL_REVERSAL) rather than reusing
    `deposit()` -- these are semantically different events even though
    both credit the wallet, and the ledger should say which happened."""
    if amount <= 0:
        raise DomainError("Reversal amount must be positive.")

    wallet, _ = Wallet.objects.select_for_update().get_or_create(user=user)
    existing = _existing_entry_for_key(wallet, idempotency_key)
    if existing:
        return existing

    new_balance = wallet.balance + amount
    wallet.balance = new_balance
    wallet.save(update_fields=["balance", "updated_at"])
    return LedgerEntry.objects.create(
        wallet=wallet,
        entry_type=LedgerEntryType.WITHDRAWAL_REVERSAL,
        amount=amount,
        balance_after=new_balance,
        idempotency_key=idempotency_key,
        note=note,
    )


# --- Staff-only manual adjustment ------------------------------------------------------

@transaction.atomic
def admin_adjust_wallet(staff_user, target_user, *, amount: Decimal, reason: str) -> LedgerEntry:
    if not _is_staff(staff_user):
        raise AccountNotEligibleError("Only staff can manually adjust a wallet.")
    if staff_user.pk == target_user.pk:
        # Segregation of duties: nobody can mint or burn money in their own wallet.
        raise AccountNotEligibleError("Staff cannot adjust their own wallet.")
    if not reason.strip():
        raise DomainError("A reason is required for a manual wallet adjustment.")
    if amount == 0:
        raise DomainError("Adjustment amount cannot be zero.")

    wallet, _ = Wallet.objects.select_for_update().get_or_create(user=target_user)
    new_balance = wallet.balance + amount
    if new_balance < 0:
        raise DomainError("This adjustment would result in a negative balance.")

    wallet.balance = new_balance
    wallet.save(update_fields=["balance", "updated_at"])
    entry = LedgerEntry.objects.create(
        wallet=wallet,
        entry_type=LedgerEntryType.ADMIN_ADJUSTMENT,
        amount=amount,
        balance_after=new_balance,
        note=reason,
    )
    AuditLog.objects.create(
        actor=staff_user,
        action=AuditAction.WALLET_ADMIN_ADJUSTMENT,
        target_user=target_user,
        amount=amount,
        reason=reason,
    )
    return entry

# --- Transaction-economy wallet movements -----------------------------------------
# These helpers are deliberately kept in the canonical wallet service so every
# balance-changing customer-wallet movement still uses the same row lock + ledger.

@transaction.atomic
def credit_refund(user, *, amount: Decimal, booking, idempotency_key: str, note: str = "") -> LedgerEntry:
    if amount <= 0:
        raise DomainError("Refund amount must be positive.")
    wallet, _ = Wallet.objects.select_for_update().get_or_create(user=user)
    existing = _existing_entry_for_key(wallet, idempotency_key)
    if existing:
        return existing
    new_balance = wallet.balance + amount
    wallet.balance = new_balance
    wallet.save(update_fields=["balance", "updated_at"])
    return LedgerEntry.objects.create(
        wallet=wallet,
        entry_type=LedgerEntryType.PLAN_REFUND,
        amount=amount,
        balance_after=new_balance,
        booking=booking,
        idempotency_key=idempotency_key,
        note=note or "Plan refund.",
    )


@transaction.atomic
def credit_plan_refund(user, *, amount: Decimal, booking, promotional_amount: Decimal,
                       promotional_allocations=None, idempotency_key: str, note: str = "") -> LedgerEntry:
    """Refund a plan using the same paid/promotional composition used at purchase."""
    amount = Decimal(amount).quantize(Decimal("0.01"))
    promotional_amount = min(amount, Decimal(promotional_amount or 0)).quantize(Decimal("0.01"))
    paid_amount = (amount - promotional_amount).quantize(Decimal("0.01"))
    wallet, _ = Wallet.objects.select_for_update().get_or_create(user=user)
    existing = _existing_entry_for_key(wallet, idempotency_key)
    if existing:
        return existing
    if paid_amount:
        wallet.balance = (wallet.balance + paid_amount).quantize(Decimal("0.01"))
        wallet.save(update_fields=["balance", "updated_at"])
    else:
        wallet.save(update_fields=["updated_at"])
    for allocation in promotional_allocations or []:
        credit = PromotionalCredit.objects.select_for_update().get(id=allocation["credit_id"])
        credit.remaining_amount = (credit.remaining_amount + Decimal(allocation["amount"])).quantize(Decimal("0.01"))
        credit.save(update_fields=["remaining_amount", "updated_at"])
    _sync_promotional_balance_locked(wallet)
    return LedgerEntry.objects.create(
        wallet=wallet, entry_type=LedgerEntryType.PLAN_REFUND, amount=paid_amount,  # matches the balance change
        balance_after=wallet.balance, booking=booking, idempotency_key=idempotency_key,
        note=note or f"Plan refund: paid={paid_amount} promotional={promotional_amount}",
    )


@transaction.atomic
def debit_gift(user, *, amount: Decimal, idempotency_key: str, note: str = "") -> LedgerEntry:
    if amount <= 0:
        raise DomainError("Gift amount must be positive.")
    wallet, _ = Wallet.objects.select_for_update().get_or_create(user=user)
    existing = _existing_entry_for_key(wallet, idempotency_key)
    if existing:
        return existing
    if wallet.balance < amount:
        raise InsufficientBalanceError("Insufficient wallet balance for this gift.")
    new_balance = wallet.balance - amount
    wallet.balance = new_balance
    wallet.save(update_fields=["balance", "updated_at"])
    return LedgerEntry.objects.create(
        wallet=wallet,
        entry_type=LedgerEntryType.GIFT_DEBIT,
        amount=-amount,
        balance_after=new_balance,
        idempotency_key=idempotency_key,
        note=note or "Gift sent.",
    )


@transaction.atomic
def credit_gift(user, *, amount: Decimal, idempotency_key: str, note: str = "") -> LedgerEntry:
    if amount <= 0:
        raise DomainError("Gift amount must be positive.")
    wallet, _ = Wallet.objects.select_for_update().get_or_create(user=user)
    existing = _existing_entry_for_key(wallet, idempotency_key)
    if existing:
        return existing
    new_balance = wallet.balance + amount
    wallet.balance = new_balance
    wallet.save(update_fields=["balance", "updated_at"])
    return LedgerEntry.objects.create(
        wallet=wallet,
        entry_type=LedgerEntryType.GIFT_CREDIT,
        amount=amount,
        balance_after=new_balance,
        idempotency_key=idempotency_key,
        note=note or "Gift received.",
    )


@transaction.atomic
def credit_gift_refund(user, *, amount: Decimal, idempotency_key: str, note: str = "") -> LedgerEntry:
    # A declined gift returns the sender's own funds. It is still a gift-credit
    # movement, but the idempotency key makes it impossible to return twice.
    return credit_gift(user, amount=amount, idempotency_key=idempotency_key, note=note or "Declined gift returned.")


# --- Promo codes -------------------------------------------------------------------
import secrets
from datetime import timedelta

from django.core.cache import cache
from django.db import IntegrityError

from apps.common.constants import AccountStatus

from .models import PromoCode, PromoRedemption

PROMO_MAX_FAILURES = 8          # wrong/invalid codes tried in the window before a short lock (stops guessing codes)
PROMO_LOCK_SECONDS = 15 * 60
_PROMO_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no 0/O/1/I


def normalize_promo_code(code: str) -> str:
    return "".join((code or "").split()).upper()


def generate_promo_code(prefix: str = "EUPH") -> str:
    for _ in range(20):
        candidate = f"{prefix}-" + "".join(secrets.choice(_PROMO_ALPHABET) for _ in range(6))
        if not PromoCode.objects.filter(code=candidate).exists():
            return candidate
    raise DomainError("Could not generate a unique code. Try again.")


def create_promo_code(staff_user, *, name, amount, code="", max_redemptions=None, starts_at=None, valid_until=None,
                      credit_valid_days=None, plan=None, category=None) -> PromoCode:
    if not _is_staff(staff_user):
        raise AccountNotEligibleError("Only staff can create promo codes.")
    amount = Decimal(amount).quantize(Decimal("0.01"))
    if amount <= 0:
        raise DomainError("The amount must be positive.")
    if valid_until is not None and valid_until <= timezone.now():
        raise DomainError("The end date must be in the future.")
    code = normalize_promo_code(code) or generate_promo_code()
    if PromoCode.objects.filter(code=code).exists():
        raise DomainError("That code already exists.")
    return PromoCode.objects.create(
        code=code, name=name.strip(), amount=amount, max_redemptions=max_redemptions, starts_at=starts_at,
        valid_until=valid_until, credit_valid_days=credit_valid_days, plan=plan, category=category, created_by=staff_user,
    )


def _promo_fail(user, message="That code isn't valid."):
    key = f"promo-fail:{user.id}"
    cache.add(key, 0, PROMO_LOCK_SECONDS)
    try:
        cache.incr(key)
    except ValueError:
        cache.set(key, 1, PROMO_LOCK_SECONDS)
    raise DomainError(message)


@transaction.atomic
def redeem_promo_code(user, code: str) -> PromotionalCredit:
    """Turn a promo code into platform credit for `user`, once per person. Never touches the paid balance."""
    if (cache.get(f"promo-fail:{user.id}") or 0) >= PROMO_MAX_FAILURES:
        raise DomainError("Too many invalid codes. Try again in 15 minutes.")
    if user.status != AccountStatus.ACTIVE or not user.email_verified:
        raise AccountNotEligibleError("Verify your email to redeem a promo code.")

    code = normalize_promo_code(code)
    if not code:
        raise DomainError("Enter a promo code.")
    promo = PromoCode.objects.select_for_update().filter(code=code).first()
    now = timezone.now()
    # One generic message for unknown / switched-off / not-started / expired, so codes can't be probed.
    if (promo is None or not promo.is_active or (promo.starts_at and promo.starts_at > now)
            or (promo.valid_until and promo.valid_until <= now)):
        _promo_fail(user)
    if PromoRedemption.objects.filter(promo_code=promo, user=user).exists():
        raise DomainError("You've already used this code.")
    if promo.max_redemptions is not None and promo.redeemed_count >= promo.max_redemptions:
        _promo_fail(user, "This code has been fully claimed.")

    expires_at = now + timedelta(days=promo.credit_valid_days) if promo.credit_valid_days else None
    credit = grant_promotional_credit(
        user, amount=promo.amount, expires_at=expires_at, plan=promo.plan, category=promo.category,
        source=promo.name[:80], reference=f"promo-code:{promo.id}:{user.id}",
        metadata={"promo_code": promo.code, "promo_id": str(promo.id)},
    )
    try:
        with transaction.atomic():
            PromoRedemption.objects.create(promo_code=promo, user=user, credit=credit)
    except IntegrityError as exc:  # two simultaneous taps: the other one won
        raise DomainError("You've already used this code.") from exc
    promo.redeemed_count += 1
    promo.save(update_fields=["redeemed_count", "updated_at"])
    cache.delete(f"promo-fail:{user.id}")
    return credit

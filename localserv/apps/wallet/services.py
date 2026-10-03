from decimal import Decimal

from django.db import transaction
from django.utils import timezone

from apps.common.constants import AccountRole, EscrowStatus, LedgerEntryType
from apps.common.exceptions import AccountNotEligibleError, DomainError, InsufficientBalanceError, InvalidStateTransitionError
from apps.common.models import AuditAction, AuditLog
from apps.common.utils import clamp_page_size

from .models import Escrow, LedgerEntry, Wallet


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
    wallet, _ = Wallet.objects.select_for_update().get_or_create(user=customer)

    existing = _existing_entry_for_key(wallet, idempotency_key)
    if existing:
        return Escrow.objects.get(booking=booking)

    amount = booking.agreed_price
    if wallet.balance < amount:
        raise InsufficientBalanceError("Insufficient wallet balance to fund this booking.")

    new_balance = wallet.balance - amount
    wallet.balance = new_balance
    wallet.save(update_fields=["balance", "updated_at"])
    LedgerEntry.objects.create(
        wallet=wallet,
        entry_type=LedgerEntryType.ESCROW_HOLD,
        amount=-amount,
        balance_after=new_balance,
        booking=booking,
        idempotency_key=idempotency_key,
        note=f"Escrow hold for booking {booking.id}",
    )
    return Escrow.objects.create(booking=booking, amount=amount, status=EscrowStatus.HELD)


@transaction.atomic
def release_escrow(booking) -> Escrow:
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
    new_balance = wallet.balance + escrow.amount
    wallet.balance = new_balance
    wallet.save(update_fields=["balance", "updated_at"])
    LedgerEntry.objects.create(
        wallet=wallet,
        entry_type=LedgerEntryType.ESCROW_REFUND,
        amount=escrow.amount,
        balance_after=new_balance,
        booking=booking,
        note=f"Escrow refund for booking {booking.id}",
    )
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

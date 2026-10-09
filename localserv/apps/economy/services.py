from datetime import timedelta
from decimal import Decimal, ROUND_HALF_UP

from django.conf import settings
from django.db import IntegrityError, transaction
from django.db.models import Sum
from django.utils import timezone

from apps.common.constants import AccountRole, BookingStatus
from apps.common.exceptions import AccountNotEligibleError, DomainError, InvalidStateTransitionError
from apps.common.models import AuditLog
from apps.wallet import services as wallet_services

from .models import EarningStatus, GiftStatus, GiftTransaction, PlatformFeeSetting, PlannerEarning, TransactionOrder, TransactionStatus

MONEY_Q = Decimal("0.01")
DEFAULT_FEE_RATE = Decimal(str(getattr(settings, "DEFAULT_PLATFORM_FEE_RATE", "15.00")))


def money(value):
    return Decimal(value).quantize(MONEY_Q, rounding=ROUND_HALF_UP)


def resolve_fee_rate(plan) -> Decimal:
    # Plan-specific setting wins, then category setting, then global default.
    if getattr(plan, "platform_fee_rate", None) is not None:
        return Decimal(plan.platform_fee_rate)
    category_rate = (
        PlatformFeeSetting.objects.filter(category_id=plan.category_id, is_active=True)
        .order_by("-created_at")
        .values_list("rate", flat=True)
        .first()
    )
    if category_rate is not None:
        return Decimal(category_rate)
    global_rate = (
        PlatformFeeSetting.objects.filter(category__isnull=True, is_active=True)
        .order_by("-created_at")
        .values_list("rate", flat=True)
        .first()
    )
    return Decimal(global_rate if global_rate is not None else DEFAULT_FEE_RATE)


def snapshot_financials(*, plan, quantity: int):
    if quantity < 1:
        raise DomainError("Quantity must be at least 1.")
    unit_price = money(plan.price)
    gross = money(unit_price * quantity)
    fee_rate = resolve_fee_rate(plan)
    fee = money(gross * fee_rate / Decimal("100"))
    planner_amount = money(gross - fee)
    return unit_price, gross, fee_rate, fee, planner_amount


def _active_reservation_statuses():
    return [
        BookingStatus.PENDING,
        BookingStatus.ACCEPTED,
        BookingStatus.FUNDED,
        BookingStatus.IN_PROGRESS,
        BookingStatus.COMPLETED,
        BookingStatus.RELEASED,
        BookingStatus.DISPUTED,
    ]


def available_plan_slots(plan):
    if plan.capacity is None:
        return None
    from apps.bookings.models import Booking
    used = Booking.objects.filter(service=plan, status__in=_active_reservation_statuses()).aggregate(total=Sum("quantity"))["total"] or 0
    return max(0, plan.capacity - int(used))


@transaction.atomic
def create_order_for_booking(*, booking, quantity: int, idempotency_key: str):
    existing = TransactionOrder.objects.filter(idempotency_key=idempotency_key).first()
    if existing:
        if existing.buyer_id != booking.customer_id or existing.booking_id != booking.id:
            raise DomainError("Invalid idempotency key.")
        return existing

    plan = booking.service
    unit_price, gross, fee_rate, fee, planner_amount = snapshot_financials(plan=plan, quantity=quantity)
    return TransactionOrder.objects.create(
        buyer=booking.customer,
        planner=booking.provider,
        plan=plan,
        booking=booking,
        quantity=quantity,
        unit_price=unit_price,
        gross_amount=gross,
        platform_fee_rate=fee_rate,
        platform_fee_amount=fee,
        planner_amount=planner_amount,
        idempotency_key=idempotency_key,
        status=TransactionStatus.PENDING,
    )


@transaction.atomic
def settle_booking(booking_id):
    from apps.bookings.models import Booking

    order = TransactionOrder.objects.select_for_update().select_related("booking", "planner").get(booking_id=booking_id)
    booking = Booking.objects.select_for_update().get(id=booking_id)
    if order.status == TransactionStatus.SETTLED:
        return order
    if booking.status not in (BookingStatus.COMPLETED, BookingStatus.DISPUTED):
        raise InvalidStateTransitionError("This booking is not eligible for settlement.")

    from apps.wallet.models import Escrow
    escrow = Escrow.objects.select_for_update().get(booking=booking)
    if escrow.status != "HELD":
        if escrow.status == "RELEASED" and order.status == TransactionStatus.SETTLED:
            return order
        raise InvalidStateTransitionError("Escrow is not held for settlement.")
    if escrow.amount != order.gross_amount:
        raise DomainError("Escrow amount does not match the transaction snapshot.")

    earning, _ = PlannerEarning.objects.select_for_update().get_or_create(
        order=order,
        defaults={
            "planner": order.planner,
            "gross_amount": order.gross_amount,
            "platform_fee": order.platform_fee_amount,
            "net_amount": order.planner_amount,
        },
    )
    if earning.status == EarningStatus.PAID_OUT:
        raise DomainError("This earning has already been paid out.")
    earning.status = EarningStatus.AVAILABLE
    earning.available_at = earning.available_at or timezone.now()
    earning.settled_at = timezone.now()
    earning.save(update_fields=["status", "available_at", "settled_at", "updated_at"])

    escrow.status = "RELEASED"
    escrow.released_at = timezone.now()
    escrow.save(update_fields=["status", "released_at", "updated_at"])
    order.status = TransactionStatus.SETTLED
    order.settled_at = timezone.now()
    order.save(update_fields=["status", "settled_at", "updated_at"])
    return order


@transaction.atomic
def refund_booking(booking_id, *, amount=None, reason=""):
    from apps.bookings.models import Booking
    from apps.wallet.models import Escrow

    order = TransactionOrder.objects.select_for_update().get(booking_id=booking_id)
    booking = Booking.objects.select_for_update().get(id=booking_id)
    refund_amount = money(order.gross_amount - order.refunded_amount) if amount is None else money(amount)
    if refund_amount <= 0 or refund_amount > order.gross_amount - order.refunded_amount:
        raise DomainError("Invalid refund amount.")

    escrow = Escrow.objects.select_for_update().get(booking=booking)
    if escrow.status == "HELD":
        if refund_amount != escrow.amount:
            raise DomainError("Partial refunds from held escrow are not supported by this path.")
        wallet_services.refund_escrow(booking)
    elif order.status == TransactionStatus.SETTLED:
        earning = PlannerEarning.objects.select_for_update().get(order=order)
        # The customer is refunded the GROSS amount, but the planner only ever received the NET
        # amount (gross minus the platform fee). Claw back the planner's proportional share only;
        # the platform absorbs its own fee. (Comparing the planner's balance with the gross refund
        # made every post-settlement refund fail whenever a fee applied.)
        planner_share = money(refund_amount * order.planner_amount / order.gross_amount) if order.gross_amount else Decimal("0")
        available = earning.available_balance
        if available < planner_share:
            raise DomainError("Planner earnings are no longer sufficient for an automatic post-settlement refund; manual reconciliation is required.")
        earning.refunded_amount = money(earning.refunded_amount + planner_share)
        if earning.withdrawn_amount + earning.refunded_amount >= earning.net_amount:
            earning.status = EarningStatus.REFUNDED
            earning.reversed_at = timezone.now()
        earning.save(update_fields=["refunded_amount", "status", "reversed_at", "updated_at"])
        # Preserve the original funding composition. Promotional value is returned as
        # promotional value (not cash-equivalent wallet balance), while the paid portion
        # returns to the paid wallet balance. For partial refunds, use the original funding
        # ratio and never restore more promotional value than was originally consumed.
        original_promo = money(escrow.promotional_amount or 0)
        already_promo_refunded = money(escrow.promotional_refunded_amount or 0)
        original_gross = money(escrow.amount)
        promo_refund = money(refund_amount * original_promo / original_gross) if original_gross else Decimal("0")
        promo_refund = min(promo_refund, money(original_promo - already_promo_refunded))
        allocations = []
        if promo_refund > 0 and escrow.promotional_allocations:
            remaining = promo_refund
            skip = already_promo_refunded
            for allocation in escrow.promotional_allocations:
                if remaining <= 0:
                    break
                original_alloc = Decimal(allocation["amount"])
                if skip >= original_alloc:
                    skip = money(skip - original_alloc)
                    continue
                available_alloc = money(original_alloc - skip)
                skip = Decimal("0")
                take = min(available_alloc, remaining)
                if take > 0:
                    allocations.append({"credit_id": allocation["credit_id"], "amount": str(take)})
                    remaining = money(remaining - take)
        escrow.promotional_refunded_amount = money(already_promo_refunded + promo_refund)
        escrow.save(update_fields=["promotional_refunded_amount", "updated_at"])
        wallet_services.credit_plan_refund(
            booking.customer, amount=refund_amount, booking=booking,
            promotional_amount=promo_refund, promotional_allocations=allocations,
            idempotency_key=f"refund:{order.id}:{order.refunded_amount}:{refund_amount}",
            note=reason or "Booking refund",
        )
    else:
        raise InvalidStateTransitionError("This transaction cannot be refunded in its current state.")

    order.refunded_amount = money(order.refunded_amount + refund_amount)
    order.status = TransactionStatus.REFUNDED if order.refunded_amount == order.gross_amount else TransactionStatus.PARTIALLY_REFUNDED
    order.save(update_fields=["refunded_amount", "status", "updated_at"])
    return order


def earnings_summary(user):
    qs = PlannerEarning.objects.filter(planner=user)
    pending = qs.filter(status=EarningStatus.PENDING).aggregate(v=Sum("net_amount"))["v"] or Decimal("0")
    available = sum((e.available_balance for e in qs.filter(status=EarningStatus.AVAILABLE)), Decimal("0"))
    settled = qs.filter(status__in=[EarningStatus.AVAILABLE, EarningStatus.PAID_OUT, EarningStatus.REFUNDED]).aggregate(v=Sum("net_amount"))["v"] or Decimal("0")
    return {"pending": money(pending), "available": money(available), "settled": money(settled)}


def available_earnings(user):
    return PlannerEarning.objects.filter(planner=user, status=EarningStatus.AVAILABLE).order_by("created_at")


@transaction.atomic
def withdraw_earnings(user, *, amount: Decimal, idempotency_key: str):
    amount = money(amount)
    if amount <= 0:
        raise DomainError("Withdrawal amount must be positive.")
    # A reservation is separate from withdrawn money. It prevents two concurrent
    # payout requests from spending the same earnings while the external provider
    # is still processing the first request.
    earnings = list(
        PlannerEarning.objects.select_for_update()
        .filter(planner=user, status=EarningStatus.AVAILABLE)
        .order_by("created_at")
    )
    total = sum((e.available_balance for e in earnings), Decimal("0"))
    if total < amount:
        raise DomainError("Insufficient available planner earnings.")
    remaining = amount
    allocations = []
    for earning in earnings:
        if remaining <= 0:
            break
        take = min(earning.available_balance, remaining)
        if take:
            earning.reserved_amount = money(earning.reserved_amount + take)
            earning.reservation_key = idempotency_key
            earning.save(update_fields=["reserved_amount", "reservation_key", "updated_at"])
            allocations.append((earning.id, take))
            remaining = money(remaining - take)
    return allocations


@transaction.atomic
def finalize_earning_withdrawal(*, amount: Decimal, user, reservation_key: str, success: bool, allocations=None):
    """Settle a reservation made by withdraw_earnings: on success the reserved money becomes
    withdrawn; on failure it goes back to available.

    Pass `allocations` ([{"earning_id", "amount"}], stored on the WithdrawalRequest) whenever you
    have them. Matching by `reservation_key` alone is unsafe: two in-flight payouts that reserve
    from the same earning row would overwrite each other's key and neither could be settled."""
    amount = money(amount)
    remaining = amount
    if allocations:
        rows = []
        for a in allocations:
            earning = PlannerEarning.objects.select_for_update().get(id=a["earning_id"], planner=user)
            rows.append((earning, money(Decimal(str(a["amount"])))))
    else:
        rows = [(e, None) for e in PlannerEarning.objects.select_for_update()
                .filter(planner=user, reserved_amount__gt=0, reservation_key=reservation_key).order_by("created_at")]
    for earning, wanted in rows:
        if remaining <= 0:
            break
        take = min(earning.reserved_amount, remaining if wanted is None else min(wanted, remaining))
        if not take:
            continue
        earning.reserved_amount = money(earning.reserved_amount - take)
        if success:
            earning.withdrawn_amount = money(earning.withdrawn_amount + take)
            if earning.withdrawn_amount >= earning.net_amount - earning.refunded_amount:
                earning.status = EarningStatus.PAID_OUT
        if earning.reserved_amount == 0 and earning.reservation_key == reservation_key:
            earning.reservation_key = ""
        earning.save(update_fields=["reserved_amount", "withdrawn_amount", "status", "reservation_key", "updated_at"])
        remaining = money(remaining - take)
    if remaining != 0:
        raise DomainError("Planner earning withdrawal reservation could not be reconciled.")


@transaction.atomic
def reverse_earning_withdrawal(*, user, amount: Decimal, allocations):
    """Undo a payout that already completed (bank reversal / staff reversal): the money returns to
    the planner's earnings as available balance."""
    remaining = money(amount)
    for a in allocations or []:
        earning = PlannerEarning.objects.select_for_update().get(id=a["earning_id"], planner=user)
        taken = money(Decimal(str(a["amount"])))
        if taken > earning.withdrawn_amount:
            raise DomainError("Planner earning payout reversal exceeds the recorded payout.")
        earning.withdrawn_amount = money(earning.withdrawn_amount - taken)
        if earning.status == EarningStatus.PAID_OUT:
            earning.status = EarningStatus.AVAILABLE
        earning.save(update_fields=["withdrawn_amount", "status", "updated_at"])
        remaining = money(remaining - taken)
    if remaining != 0:
        raise DomainError("Planner earning payout reversal could not be reconciled.")


def restore_earning_allocations(allocations, idempotency_key: str):
    # Reservation rollback before a WithdrawalRequest exists. The DB row lock makes
    # this safe against a concurrent payout attempt.
    with transaction.atomic():
        for earning_id, amount in allocations:
            earning = PlannerEarning.objects.select_for_update().get(id=earning_id)
            earning.reserved_amount = money(max(Decimal("0"), earning.reserved_amount - amount))
            if earning.reserved_amount == 0 and earning.reservation_key == idempotency_key:
                earning.reservation_key = ""
            earning.save(update_fields=["reserved_amount", "reservation_key", "updated_at"])


GIFT_TTL = timedelta(days=int(getattr(settings, "GIFT_EXPIRY_DAYS", 7)))


@transaction.atomic
def create_gift(sender, *, recipient, amount: Decimal, message: str = "", idempotency_key: str):
    if sender.id == recipient.id:
        raise DomainError("You cannot gift yourself.")
    amount = money(amount)
    if amount <= 0:
        raise DomainError("Gift amount must be positive.")
    existing = GiftTransaction.objects.filter(idempotency_key=idempotency_key).first()
    if existing:
        if existing.sender_id != sender.id or existing.recipient_id != recipient.id or existing.amount != amount:
            raise DomainError("Invalid idempotency key.")
        return existing
    wallet_services.debit_gift(sender, amount=amount, idempotency_key=f"gift-send:{idempotency_key}", note=f"Gift to {recipient.username}")
    try:
        with transaction.atomic():
            # Gifts expire: otherwise money would sit in limbo forever if the recipient never answers.
            return GiftTransaction.objects.create(
                sender=sender, recipient=recipient, amount=amount, message=(message or "")[:500],
                idempotency_key=idempotency_key, expires_at=timezone.now() + GIFT_TTL)
    except IntegrityError:  # a concurrent request with the same key won; the debit above was idempotent
        return GiftTransaction.objects.get(idempotency_key=idempotency_key)


def _expire_gift_locked(gift):
    """Return an expired, still-pending gift to the sender. Caller holds the row lock."""
    wallet_services.credit_gift_refund(gift.sender, amount=gift.amount, idempotency_key=f"gift-expire:{gift.id}", note=f"Expired gift {gift.id}")
    gift.status = GiftStatus.EXPIRED
    gift.save(update_fields=["status", "updated_at"])


@transaction.atomic
def expire_stale_gifts() -> int:
    """Run on a schedule (cron / management command). Refunds every pending gift past its expiry."""
    n = 0
    for gift in GiftTransaction.objects.select_for_update().select_related("sender").filter(
            status=GiftStatus.PENDING, expires_at__isnull=False, expires_at__lte=timezone.now()):
        _expire_gift_locked(gift)
        n += 1
    return n


def accept_gift(user, gift_id):
    # The expiry branch must COMMIT its refund before raising, so it cannot raise inside the atomic block.
    with transaction.atomic():
        gift = GiftTransaction.objects.select_for_update().select_related("sender").get(id=gift_id)
        if gift.recipient_id != user.id:
            raise AccountNotEligibleError("Only the recipient can accept this gift.")
        if gift.status != GiftStatus.PENDING:
            raise InvalidStateTransitionError("This gift is no longer pending.")
        expired = bool(gift.expires_at and gift.expires_at <= timezone.now())
        if expired:
            _expire_gift_locked(gift)
        else:
            wallet_services.credit_gift(user, amount=gift.amount, idempotency_key=f"gift-receive:{gift.id}", note=f"Gift from {gift.sender.username}")
            gift.status = GiftStatus.ACCEPTED
            gift.accepted_at = timezone.now()
            gift.save(update_fields=["status", "accepted_at", "updated_at"])
    if expired:
        raise InvalidStateTransitionError("This gift has expired and was returned to the sender.")
    return gift


@transaction.atomic
def decline_gift(user, gift_id):
    gift = GiftTransaction.objects.select_for_update().get(id=gift_id)
    if gift.recipient_id != user.id:
        raise AccountNotEligibleError("Only the recipient can decline this gift.")
    if gift.status != GiftStatus.PENDING:
        raise InvalidStateTransitionError("This gift is no longer pending.")
    # Return to sender rather than burning funds.
    wallet_services.credit_gift_refund(gift.sender, amount=gift.amount, idempotency_key=f"gift-decline:{gift.id}", note=f"Declined gift {gift.id}")
    gift.status = GiftStatus.DECLINED
    gift.declined_at = timezone.now()
    gift.save(update_fields=["status", "declined_at", "updated_at"])
    return gift

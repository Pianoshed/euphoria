import uuid

from django.conf import settings
from django.db import models

from apps.common.constants import EscrowStatus, LedgerEntryType, PaymentIntentStatus, WithdrawalStatus
from apps.common.models import BaseModel


class Wallet(models.Model):
    """
    One wallet per user. `balance` is a cached running total -- the
    real source of truth is the sum of this wallet's LedgerEntry rows
    -- but it is NEVER mutated on its own (no bare `wallet.balance +=
    amount; wallet.save()` anywhere in this codebase). Every mutation
    happens inside the same atomic transaction, under the same row
    lock (select_for_update), as the LedgerEntry that justifies it.
    See apps.wallet.services for every place balance is touched.

    NOTE on units: the original spec calls for integer "token units"
    for the internal ledger, separate from Decimal fiat amounts. This
    codebase instead uses Decimal throughout, matching the Decimal
    prices already used by apps.services.Service/apps.bookings.Booking
    -- introducing a second unit system (tokens) with its own
    conversion rate to the marketplace's listed prices isn't something
    this project has an actual exchange rate for, and would be
    invented complexity. Decimal is still exact (never float) and
    every invariant the spec cares about (auditability, atomicity,
    no negative balances) is upheld the same way. If Phase 6's real
    payment-provider integration introduces an actual token economy
    with its own conversion rate, that's the point to revisit this.
    """

    user = models.OneToOneField(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, primary_key=True, related_name="wallet")
    balance = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    # Promotional credits are tracked separately from paid wallet value. They are
    # spendable on eligible Euphoria plans but are never withdrawable.
    promotional_balance = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "wallet_wallet"
        constraints = [
            models.CheckConstraint(condition=models.Q(balance__gte=0), name="wallet_balance_non_negative"),
            models.CheckConstraint(condition=models.Q(promotional_balance__gte=0), name="wallet_promotional_balance_non_negative"),
        ]

    def __str__(self):
        return f"Wallet({self.user_id}) = {self.balance}"


class LedgerEntry(models.Model):
    """Append-only. Never updated, never deleted. `amount` is signed
    (positive = credit, negative = debit); `balance_after` is a point-
    in-time snapshot for audit, recorded at write time under the same
    wallet row lock that updated Wallet.balance -- so it's always
    consistent with the wallet's balance as of that moment."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    wallet = models.ForeignKey(Wallet, on_delete=models.PROTECT, related_name="ledger_entries")
    entry_type = models.CharField(max_length=30, choices=LedgerEntryType.choices)
    amount = models.DecimalField(max_digits=12, decimal_places=2)
    balance_after = models.DecimalField(max_digits=12, decimal_places=2)
    booking = models.ForeignKey(
        "bookings.Booking", on_delete=models.PROTECT, null=True, blank=True, related_name="ledger_entries"
    )
    idempotency_key = models.CharField(max_length=100, blank=True)
    note = models.CharField(max_length=255, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "wallet_ledger_entry"
        ordering = ["-created_at"]
        constraints = [
            # A given idempotency key can only be used once per wallet
            # -- the DB is the backstop even if application logic has
            # a bug that skips the pre-check.
            models.UniqueConstraint(
                fields=["wallet", "idempotency_key"],
                condition=~models.Q(idempotency_key=""),
                name="unique_wallet_idempotency_key",
            ),
        ]
        indexes = [models.Index(fields=["wallet", "created_at"])]

    def __str__(self):
        return f"{self.entry_type} {self.amount} (wallet {self.wallet_id})"


class Escrow(BaseModel):
    """One escrow per booking, created the moment the booking is
    funded. `amount` always equals the booking's `agreed_price` at
    funding time -- never recalculated."""

    booking = models.OneToOneField("bookings.Booking", on_delete=models.PROTECT, related_name="escrow")
    amount = models.DecimalField(max_digits=12, decimal_places=2)
    status = models.CharField(max_length=10, choices=EscrowStatus.choices, default=EscrowStatus.HELD)
    released_at = models.DateTimeField(null=True, blank=True)
    refunded_at = models.DateTimeField(null=True, blank=True)
    paid_amount = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    promotional_amount = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    promotional_allocations = models.JSONField(default=list, blank=True)
    promotional_refunded_amount = models.DecimalField(max_digits=12, decimal_places=2, default=0)

    class Meta(BaseModel.Meta):
        db_table = "wallet_escrow"
        constraints = [
            models.CheckConstraint(condition=models.Q(amount__gt=0), name="escrow_amount_positive"),
        ]

    def __str__(self):
        return f"Escrow({self.booking_id}) = {self.amount} [{self.status}]"


class PaymentIntent(BaseModel):
    """
    A user's attempt to fund their wallet from an external payment
    provider (Phase 6). `idempotency_key` is client-supplied (e.g. a
    UUID generated once per "Pay" button press) so a retried POST
    (double-click, network retry) can never create two intents.

    Wallet crediting NEVER happens directly off this row's creation --
    only `payment_services.process_deposit_webhook`, after verifying
    the provider's signature, moves an intent to SUCCEEDED and writes
    the corresponding LedgerEntry. This is deliberately the opposite
    of the Phase 5 placeholder `services.deposit()` view, which
    trusted the caller's own say-so -- see that view's removal note
    in apps.wallet.urls.
    """

    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="payment_intents")
    amount = models.DecimalField(max_digits=12, decimal_places=2)
    provider = models.CharField(max_length=30)
    provider_reference = models.CharField(max_length=100, blank=True, default="", db_index=True)
    status = models.CharField(max_length=12, choices=PaymentIntentStatus.choices, default=PaymentIntentStatus.PENDING)
    idempotency_key = models.CharField(max_length=100, unique=True)
    failure_reason = models.CharField(max_length=255, blank=True, default="")
    # Hosted-checkout URL from the provider (empty for the stub, which auto-completes).
    checkout_url = models.URLField(max_length=500, blank=True, default="")

    class Meta(BaseModel.Meta):
        db_table = "wallet_payment_intent"
        constraints = [
            models.CheckConstraint(condition=models.Q(amount__gt=0), name="payment_intent_amount_positive"),
        ]

    def __str__(self):
        return f"PaymentIntent {self.id} ({self.status})"


class PaymentWebhookEvent(models.Model):
    """
    Idempotency record for processed provider webhook events -- a
    webhook is never trusted or processed twice just because it hit
    the endpoint again (providers routinely retry on timeout). Written
    inside the SAME atomic transaction as the actual wallet crediting
    (see payment_services._complete_deposit), so a duplicate delivery
    either finds the row already there and no-ops, or the whole thing
    rolls back together -- never a partial credit.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    provider = models.CharField(max_length=30)
    provider_event_id = models.CharField(max_length=150)
    payment_intent = models.ForeignKey(
        PaymentIntent, on_delete=models.SET_NULL, null=True, blank=True, related_name="webhook_events"
    )
    payload_summary = models.JSONField(default=dict, blank=True)
    processed_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "wallet_payment_webhook_event"
        constraints = [
            models.UniqueConstraint(fields=["provider", "provider_event_id"], name="unique_provider_webhook_event"),
        ]

    def __str__(self):
        return f"{self.provider}:{self.provider_event_id}"


class PromotionalCredit(BaseModel):
    """Non-cash promotional value. It can only be spent on eligible Euphoria plans.

    Paid wallet balance and promotional balance are deliberately separate: promotional
    value is never withdrawable and never used to fund gifts. Remaining value is tracked
    per grant so expiry and auditability are preserved.
    """
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="promotional_credits")
    original_amount = models.DecimalField(max_digits=12, decimal_places=2)
    remaining_amount = models.DecimalField(max_digits=12, decimal_places=2)
    expires_at = models.DateTimeField(null=True, blank=True)
    plan = models.ForeignKey("services.Service", on_delete=models.PROTECT, null=True, blank=True, related_name="promotional_credits")
    category = models.ForeignKey("services.ServiceCategory", on_delete=models.PROTECT, null=True, blank=True, related_name="promotional_credits")
    non_transferable = models.BooleanField(default=True)
    non_withdrawable = models.BooleanField(default=True)
    source = models.CharField(max_length=80, default="PROMOTION")
    reference = models.CharField(max_length=120, unique=True)
    metadata = models.JSONField(default=dict, blank=True)

    class Meta(BaseModel.Meta):
        db_table = "wallet_promotional_credit"
        constraints = [
            models.CheckConstraint(condition=models.Q(original_amount__gt=0), name="promo_original_positive"),
            models.CheckConstraint(condition=models.Q(remaining_amount__gte=0), name="promo_remaining_non_negative"),
            models.CheckConstraint(condition=models.Q(remaining_amount__lte=models.F("original_amount")), name="promo_remaining_lte_original"),
        ]
        indexes = [models.Index(fields=["user", "expires_at"]), models.Index(fields=["user", "remaining_amount"]) ]



class PromoCode(BaseModel):
    """A code a person types in to receive platform (promotional) credit. Created by staff only.

    Redeeming never touches the paid balance: it grants a PromotionalCredit, which is spendable on
    plans only and is never withdrawable. Each person can redeem a given code once (see PromoRedemption).
    """
    code = models.CharField(max_length=40, unique=True)  # always stored upper-case
    name = models.CharField(max_length=80, help_text="Shown to the person who redeems it, e.g. 'Welcome gift'.")
    amount = models.DecimalField(max_digits=12, decimal_places=2)
    max_redemptions = models.PositiveIntegerField(null=True, blank=True, help_text="Empty = unlimited.")
    redeemed_count = models.PositiveIntegerField(default=0)
    starts_at = models.DateTimeField(null=True, blank=True)
    valid_until = models.DateTimeField(null=True, blank=True, help_text="The code stops working after this. Empty = never.")
    credit_valid_days = models.PositiveIntegerField(null=True, blank=True, help_text="How long the credit lasts once redeemed. Empty = no expiry.")
    plan = models.ForeignKey("services.Service", on_delete=models.PROTECT, null=True, blank=True, related_name="promo_codes")
    category = models.ForeignKey("services.ServiceCategory", on_delete=models.PROTECT, null=True, blank=True, related_name="promo_codes")
    is_active = models.BooleanField(default=True)
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="promo_codes_created")

    class Meta(BaseModel.Meta):
        db_table = "wallet_promo_code"
        constraints = [models.CheckConstraint(condition=models.Q(amount__gt=0), name="promo_code_amount_positive")]

    def __str__(self):
        return self.code


class PromoRedemption(BaseModel):
    promo_code = models.ForeignKey(PromoCode, on_delete=models.PROTECT, related_name="redemptions")
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="promo_redemptions")
    credit = models.OneToOneField(PromotionalCredit, on_delete=models.PROTECT, related_name="redemption")

    class Meta(BaseModel.Meta):
        db_table = "wallet_promo_redemption"
        constraints = [models.UniqueConstraint(fields=["promo_code", "user"], name="promo_redeem_once_per_user")]


class PayoutAccount(BaseModel):
    """
    A withdrawal destination. The raw account/card number the user
    enters is NEVER persisted -- only a caller-supplied `label` (e.g.
    "GTBank") and a `masked_reference` derived server-side (last 4
    digits only, e.g. "****1234"). See
    apps.wallet.payment_services.add_payout_account for where the
    masking happens and the raw input is discarded.

    `created_at` (from BaseModel) doubles as the start of a cooldown
    window before this account can be used for a withdrawal --
    request_withdrawal enforces PAYOUT_ACCOUNT_COOLDOWN against it.
    This limits the blast radius of an account takeover that adds a
    fresh payout destination and immediately tries to drain funds to
    it (Sec 15: "Consider a cooling period after changing payout
    information").
    """

    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="payout_accounts")
    label = models.CharField(max_length=100)
    masked_reference = models.CharField(max_length=30)
    is_active = models.BooleanField(default=True)

    # Real-provider payouts (Monnify). The account number and bank code are stored ONLY inside
    # `destination_ciphertext` (Fernet, bound to this row's id -- see apps.wallet.crypto). Never
    # add this field to a serializer, admin form, log line or error message. `bank_code` is kept
    # in the clear for display/filtering only; payouts use the sealed copy.
    bank_code = models.CharField(max_length=10, blank=True, default="")
    account_name = models.CharField(max_length=150, blank=True, default="")  # as resolved by the bank
    destination_ciphertext = models.TextField(blank=True, default="", editable=False)
    destination_fingerprint = models.CharField(max_length=64, blank=True, default="", editable=False)

    class Meta(BaseModel.Meta):
        db_table = "wallet_payout_account"
        constraints = [
            models.UniqueConstraint(
                fields=["user", "destination_fingerprint"],
                condition=~models.Q(destination_fingerprint=""),
                name="unique_user_payout_destination",
            ),
        ]

    def __str__(self):
        return f"{self.label} {self.masked_reference}"


class WithdrawalRequest(BaseModel):
    """
    Sensitive action -- created only via payment_services.request_withdrawal,
    which requires the current password re-entered (same reauth
    pattern as apps.accounts.services.disable_2fa).

    Lifecycle with a real provider: the wallet is debited and the row is created as PROCESSING
    in one transaction (committed BEFORE any call to the provider); the provider is then called;
    the row becomes COMPLETED on a success webhook, or REVERSED (wallet refunded, once) on a
    failed/reversed webhook or a definite rejection. A transfer whose outcome is unknown stays
    PROCESSING until the webhook or the reconcile_withdrawals command settles it. The stub
    provider completes synchronously.
    """

    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="withdrawal_requests")
    payout_account = models.ForeignKey(PayoutAccount, on_delete=models.PROTECT, related_name="withdrawal_requests")
    amount = models.DecimalField(max_digits=12, decimal_places=2)
    source = models.CharField(max_length=20, default="WALLET")
    earning_allocations = models.JSONField(default=list, blank=True)
    status = models.CharField(max_length=20, choices=WithdrawalStatus.choices, default=WithdrawalStatus.REQUESTED)
    idempotency_key = models.CharField(max_length=100, unique=True)
    provider = models.CharField(max_length=30, blank=True, default="")
    provider_reference = models.CharField(max_length=100, blank=True, default="", db_index=True)
    failure_reason = models.CharField(max_length=255, blank=True, default="")
    reversed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )
    completed_at = models.DateTimeField(null=True, blank=True)

    class Meta(BaseModel.Meta):
        db_table = "wallet_withdrawal_request"
        constraints = [
            models.CheckConstraint(condition=models.Q(amount__gt=0), name="withdrawal_amount_positive"),
        ]

    def __str__(self):
        return f"Withdrawal {self.id} ({self.status})"

from decimal import Decimal

from rest_framework import serializers

from .models import LedgerEntry, PaymentIntent, PayoutAccount, PromoCode, WithdrawalRequest


class WalletBalanceSerializer(serializers.Serializer):
    balance = serializers.DecimalField(max_digits=12, decimal_places=2)
    promotional_balance = serializers.DecimalField(max_digits=12, decimal_places=2, required=False, default=Decimal("0.00"))
    total_usable = serializers.DecimalField(max_digits=12, decimal_places=2, required=False, default=Decimal("0.00"))


class DepositSerializer(serializers.Serializer):
    amount = serializers.DecimalField(max_digits=12, decimal_places=2, min_value=Decimal("0.01"))
    idempotency_key = serializers.CharField(max_length=100, required=False, allow_blank=True)


class LedgerEntrySerializer(serializers.ModelSerializer):
    class Meta:
        model = LedgerEntry
        fields = ["id", "entry_type", "amount", "balance_after", "booking", "note", "created_at"]
        read_only_fields = fields


class AdminAdjustSerializer(serializers.Serializer):
    user_id = serializers.UUIDField()
    amount = serializers.DecimalField(max_digits=12, decimal_places=2)
    reason = serializers.CharField(max_length=500)

    def validate_amount(self, value):
        if value == 0:
            raise serializers.ValidationError("Adjustment amount cannot be zero.")
        return value


# --- Phase 6: payments -------------------------------------------------------------

class DepositInitiateSerializer(serializers.Serializer):
    amount = serializers.DecimalField(max_digits=12, decimal_places=2, min_value=Decimal("0.01"))
    idempotency_key = serializers.CharField(max_length=100)


class PaymentIntentSerializer(serializers.ModelSerializer):
    class Meta:
        model = PaymentIntent
        fields = ["id", "amount", "provider", "status", "provider_reference", "checkout_url", "failure_reason", "created_at"]
        read_only_fields = fields


class PayoutAccountCreateSerializer(serializers.Serializer):
    label = serializers.CharField(max_length=100)
    # write_only: this is the raw account number, accepted only to
    # derive a masked reference from -- it is never stored as-is and
    # never appears in any response. See
    # apps.wallet.payment_services.add_payout_account.
    raw_account_number = serializers.CharField(max_length=64, write_only=True)
    # Required when the active provider needs real payout details (Monnify); ignored by the stub.
    bank_code = serializers.CharField(max_length=10, required=False, allow_blank=True, default="")


class PayoutAccountSerializer(serializers.ModelSerializer):
    class Meta:
        model = PayoutAccount
        # Explicit allow-list: never add destination_ciphertext / fingerprint here.
        fields = ["id", "label", "masked_reference", "bank_code", "account_name", "created_at"]
        read_only_fields = fields


class BankSerializer(serializers.Serializer):
    code = serializers.CharField()
    name = serializers.CharField()


class WithdrawalCreateSerializer(serializers.Serializer):
    amount = serializers.DecimalField(max_digits=12, decimal_places=2, min_value=Decimal("0.01"))
    payout_account_id = serializers.UUIDField()
    current_password = serializers.CharField(write_only=True)
    otp_code = serializers.CharField(write_only=True, required=False, allow_blank=True, max_length=10, default="")
    idempotency_key = serializers.CharField(max_length=100)


class WithdrawalSerializer(serializers.ModelSerializer):
    payout_account = PayoutAccountSerializer(read_only=True)

    class Meta:
        model = WithdrawalRequest
        fields = [
            "id", "amount", "source", "payout_account", "status", "provider",
            "provider_reference", "failure_reason", "completed_at", "created_at",
        ]
        read_only_fields = fields


class WithdrawalReverseSerializer(serializers.Serializer):
    reason = serializers.CharField(max_length=500)


# --- promo codes -------------------------------------------------------------------

class PromoRedeemSerializer(serializers.Serializer):
    code = serializers.CharField(max_length=60, trim_whitespace=True)


class PromoCodeCreateSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=80)
    amount = serializers.DecimalField(max_digits=12, decimal_places=2, min_value=Decimal("0.01"))
    code = serializers.CharField(max_length=40, required=False, allow_blank=True, default="")  # blank = auto-generate
    max_redemptions = serializers.IntegerField(min_value=1, required=False, allow_null=True, default=None)
    starts_at = serializers.DateTimeField(required=False, allow_null=True, default=None)
    valid_until = serializers.DateTimeField(required=False, allow_null=True, default=None)
    credit_valid_days = serializers.IntegerField(min_value=1, max_value=3650, required=False, allow_null=True, default=None)
    plan_id = serializers.UUIDField(required=False, allow_null=True, default=None)
    category_id = serializers.UUIDField(required=False, allow_null=True, default=None)


class PromoCodeUpdateSerializer(serializers.Serializer):
    """Staff can switch a code off/on, move its end date, or change its cap. The amount never changes after creation."""
    is_active = serializers.BooleanField(required=False)
    valid_until = serializers.DateTimeField(required=False, allow_null=True)
    max_redemptions = serializers.IntegerField(min_value=1, required=False, allow_null=True)


class PromoCodeSerializer(serializers.ModelSerializer):
    plan_title = serializers.CharField(source="plan.title", read_only=True, default=None)
    category_name = serializers.CharField(source="category.name", read_only=True, default=None)

    class Meta:
        model = PromoCode
        fields = ["id", "code", "name", "amount", "max_redemptions", "redeemed_count", "starts_at", "valid_until",
                  "credit_valid_days", "plan", "plan_title", "category", "category_name", "is_active", "created_at"]
        read_only_fields = fields

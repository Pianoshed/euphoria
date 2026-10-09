from decimal import Decimal

from rest_framework import serializers

from .models import GiftTransaction, PlannerEarning, TransactionOrder


class OrderSerializer(serializers.ModelSerializer):
    class Meta:
        model = TransactionOrder
        fields = ["id", "buyer", "planner", "plan", "booking", "quantity", "unit_price", "gross_amount", "platform_fee_rate", "platform_fee_amount", "planner_amount", "currency", "payment_source", "status", "created_at", "updated_at", "settled_at", "refunded_amount"]
        read_only_fields = fields


class EarningSerializer(serializers.ModelSerializer):
    available_balance = serializers.DecimalField(max_digits=12, decimal_places=2, read_only=True)

    class Meta:
        model = PlannerEarning
        fields = ["id", "order", "gross_amount", "platform_fee", "net_amount", "status", "withdrawn_amount", "refunded_amount", "reserved_amount", "available_balance", "available_at", "settled_at", "reversed_at", "created_at"]
        read_only_fields = fields


class EarningWithdrawalSerializer(serializers.Serializer):
    amount = serializers.DecimalField(max_digits=12, decimal_places=2, min_value=Decimal("0.01"))
    idempotency_key = serializers.CharField(max_length=100)
    payout_account_id = serializers.UUIDField()
    current_password = serializers.CharField(write_only=True, trim_whitespace=False)
    otp_code = serializers.CharField(write_only=True, required=False, allow_blank=True, max_length=10, default="")


class GiftCreateSerializer(serializers.Serializer):
    recipient_id = serializers.UUIDField()
    amount = serializers.DecimalField(max_digits=12, decimal_places=2, min_value=Decimal("0.01"))
    message = serializers.CharField(max_length=500, allow_blank=True, required=False)
    idempotency_key = serializers.CharField(max_length=100)


class GiftSerializer(serializers.ModelSerializer):
    class Meta:
        model = GiftTransaction
        fields = ["id", "sender", "recipient", "amount", "message", "status", "expires_at", "accepted_at", "declined_at", "reference", "created_at"]
        read_only_fields = fields


class PromotionalCreditSerializer(serializers.Serializer):
    user_id = serializers.UUIDField()
    amount = serializers.DecimalField(max_digits=12, decimal_places=2, min_value=Decimal("0.01"))
    expires_at = serializers.DateTimeField(required=False, allow_null=True)
    plan_id = serializers.UUIDField(required=False, allow_null=True)
    category_id = serializers.UUIDField(required=False, allow_null=True)
    source = serializers.CharField(max_length=80, required=False, default="PROMOTION")
    reference = serializers.CharField(max_length=120, required=False, allow_blank=True)


class PromotionalCreditGrantResponseSerializer(serializers.Serializer):
    id = serializers.UUIDField()
    user_id = serializers.UUIDField()
    amount = serializers.DecimalField(max_digits=12, decimal_places=2)
    remaining_amount = serializers.DecimalField(max_digits=12, decimal_places=2)
    expires_at = serializers.DateTimeField(allow_null=True)
    source = serializers.CharField()
    reference = serializers.CharField()
    created_at = serializers.DateTimeField()

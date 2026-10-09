from decimal import Decimal

from rest_framework import serializers

from apps.common.constants import ServiceStatus

from .models import Review, Service, ServiceCategory


class ServiceCategorySerializer(serializers.ModelSerializer):
    class Meta:
        model = ServiceCategory
        fields = ["id", "name", "slug", "description", "icon"]
        read_only_fields = fields


class ServiceCreateSerializer(serializers.Serializer):
    category_id = serializers.UUIDField()
    title = serializers.CharField(max_length=100)
    description = serializers.CharField(max_length=3000)
    price = serializers.DecimalField(max_digits=10, decimal_places=2, min_value=Decimal("0"))
    service_area = serializers.CharField(max_length=100, allow_blank=True, required=False)
    is_plan = serializers.BooleanField(required=False, default=False)
    capacity = serializers.IntegerField(min_value=1, required=False, allow_null=True)
    scheduled_at = serializers.DateTimeField(required=False, allow_null=True)
    location = serializers.CharField(max_length=255, allow_blank=True, required=False)
    cancellation_policy = serializers.ChoiceField(choices=["FULL_REFUND", "PARTIAL_REFUND", "NO_REFUND"], required=False)
    platform_fee_rate = serializers.DecimalField(max_digits=7, decimal_places=4, min_value=Decimal("0"), max_value=Decimal("100"), required=False, allow_null=True)


class ServiceUpdateSerializer(serializers.Serializer):
    category_id = serializers.UUIDField(required=False)
    title = serializers.CharField(max_length=100, required=False)
    description = serializers.CharField(max_length=3000, required=False)
    price = serializers.DecimalField(max_digits=10, decimal_places=2, min_value=Decimal("0"), required=False)
    service_area = serializers.CharField(max_length=100, allow_blank=True, required=False)
    is_plan = serializers.BooleanField(required=False)
    capacity = serializers.IntegerField(min_value=1, required=False, allow_null=True)
    scheduled_at = serializers.DateTimeField(required=False, allow_null=True)
    location = serializers.CharField(max_length=255, allow_blank=True, required=False)
    cancellation_policy = serializers.ChoiceField(choices=["FULL_REFUND", "PARTIAL_REFUND", "NO_REFUND"], required=False)
    platform_fee_rate = serializers.DecimalField(max_digits=7, decimal_places=4, min_value=Decimal("0"), max_value=Decimal("100"), required=False, allow_null=True)

    def validate(self, attrs):
        if not attrs:
            raise serializers.ValidationError("No updatable fields were provided.")
        return attrs


class ServiceTransitionSerializer(serializers.Serializer):
    to_status = serializers.ChoiceField(choices=[s.value for s in ServiceStatus])


class ServiceProviderSerializer(serializers.Serializer):
    id = serializers.UUIDField()
    username = serializers.CharField()


class ServiceSerializer(serializers.ModelSerializer):
    provider = ServiceProviderSerializer(read_only=True)
    category = ServiceCategorySerializer(read_only=True)

    class Meta:
        model = Service
        fields = [
            "id", "provider", "category", "title", "description",
            "price", "service_area", "is_plan", "capacity", "scheduled_at", "location",
            "cancellation_policy", "platform_fee_rate", "status", "created_at", "updated_at",
        ]
        read_only_fields = fields


class ServiceListQuerySerializer(serializers.Serializer):
    category_id = serializers.UUIDField(required=False)
    provider_id = serializers.UUIDField(required=False)
    mine = serializers.BooleanField(required=False, default=False)
    q = serializers.CharField(required=False, allow_blank=True, max_length=100)
    ordering = serializers.CharField(required=False, allow_blank=True)
    page_size = serializers.IntegerField(required=False, min_value=1, max_value=100)


class ReviewCreateSerializer(serializers.Serializer):
    rating = serializers.IntegerField(min_value=1, max_value=5)
    comment = serializers.CharField(max_length=1000, allow_blank=True, required=False)


class ReviewSerializer(serializers.ModelSerializer):
    reviewer_username = serializers.CharField(source="reviewer.username", read_only=True)

    class Meta:
        model = Review
        fields = ["id", "booking", "service", "reviewer_username", "rating", "comment", "created_at"]
        read_only_fields = fields
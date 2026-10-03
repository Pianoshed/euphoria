from decimal import Decimal

from rest_framework import serializers

from apps.common.constants import ServiceStatus

from .models import Review, Service, ServiceCategory


class ServiceCategorySerializer(serializers.ModelSerializer):
    class Meta:
        model = ServiceCategory
        fields = ["id", "name", "slug", "description"]
        read_only_fields = fields


class ServiceCreateSerializer(serializers.Serializer):
    category_id = serializers.UUIDField()
    title = serializers.CharField(max_length=100)
    description = serializers.CharField(max_length=3000)
    price = serializers.DecimalField(max_digits=10, decimal_places=2, min_value=Decimal("0"))
    service_area = serializers.CharField(max_length=100, allow_blank=True, required=False)


class ServiceUpdateSerializer(serializers.Serializer):
    category_id = serializers.UUIDField(required=False)
    title = serializers.CharField(max_length=100, required=False)
    description = serializers.CharField(max_length=3000, required=False)
    price = serializers.DecimalField(max_digits=10, decimal_places=2, min_value=Decimal("0"), required=False)
    service_area = serializers.CharField(max_length=100, allow_blank=True, required=False)

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
            "price", "service_area", "status", "created_at", "updated_at",
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
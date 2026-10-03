from rest_framework import serializers

from apps.common.constants import BookingStatus

from .models import Booking, BookingEvent


class BookingCreateSerializer(serializers.Serializer):
    service_id = serializers.UUIDField()
    note_from_customer = serializers.CharField(max_length=500, allow_blank=True, required=False)
    scheduled_for = serializers.DateTimeField(required=False, allow_null=True)


class BookingTransitionSerializer(serializers.Serializer):
    to_status = serializers.ChoiceField(choices=[s.value for s in BookingStatus])
    note = serializers.CharField(max_length=500, allow_blank=True, required=False)


class BookingPartySerializer(serializers.Serializer):
    id = serializers.UUIDField()
    username = serializers.CharField()


class BookingSerializer(serializers.ModelSerializer):
    customer = BookingPartySerializer(read_only=True)
    provider = BookingPartySerializer(read_only=True)
    service_title = serializers.CharField(source="service.title", read_only=True)

    class Meta:
        model = Booking
        fields = [
            "id", "service", "service_title", "customer", "provider", "status",
            "agreed_price", "note_from_customer", "scheduled_for", "completed_at",
            "created_at", "updated_at",
        ]
        read_only_fields = fields


class BookingEventSerializer(serializers.ModelSerializer):
    actor_username = serializers.CharField(source="actor.username", read_only=True, default=None)

    class Meta:
        model = BookingEvent
        fields = ["id", "actor_username", "from_status", "to_status", "note", "created_at"]
        read_only_fields = fields


class BookingListQuerySerializer(serializers.Serializer):
    role = serializers.ChoiceField(choices=["customer", "provider"], required=False)
    status = serializers.ChoiceField(choices=[s.value for s in BookingStatus], required=False)
    page_size = serializers.IntegerField(required=False, min_value=1, max_value=100)


class DisputeResolveSerializer(serializers.Serializer):
    resolution = serializers.ChoiceField(choices=["RELEASE", "REFUND"])
    reason = serializers.CharField(max_length=500, allow_blank=True, required=False)

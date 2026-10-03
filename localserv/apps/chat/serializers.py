from rest_framework import serializers

from . import services
from .models import Conversation, Message


class MessageSerializer(serializers.ModelSerializer):
    attachment_url = serializers.SerializerMethodField()

    class Meta:
        model = Message
        fields = ["id", "conversation", "sender", "body", "attachment_url", "created_at", "edited_at", "is_deleted"]
        read_only_fields = fields

    def get_attachment_url(self, obj):
        if not obj.has_attachment:
            return None
        request = self.context.get("request")
        url = obj.attachment.file.url
        return request.build_absolute_uri(url) if request else url


class SendMessageSerializer(serializers.Serializer):
    # Neither is individually required -- apps.chat.services.send_message
    # enforces "at least one of body/attachment" itself, since that's a
    # cross-field rule more naturally expressed there than here.
    body = serializers.CharField(max_length=services.MAX_MESSAGE_LENGTH, required=False, allow_blank=True)
    attachment = serializers.ImageField(required=False)


class EditMessageSerializer(serializers.Serializer):
    body = serializers.CharField(max_length=services.MAX_MESSAGE_LENGTH)


class StartConversationSerializer(serializers.Serializer):
    target_user_id = serializers.UUIDField()


class ConversationSerializer(serializers.ModelSerializer):
    other_user_id = serializers.SerializerMethodField()
    unread_count = serializers.SerializerMethodField()
    last_message = serializers.SerializerMethodField()

    class Meta:
        model = Conversation
        fields = ["id", "booking", "other_user_id", "unread_count", "last_message", "created_at", "updated_at"]
        read_only_fields = fields

    def get_other_user_id(self, obj):
        request = self.context.get("request")
        if not request:
            return None
        return obj.other_participant_id(request.user)

    def get_unread_count(self, obj):
        request = self.context.get("request")
        if not request:
            return 0
        return services.unread_count(obj, request.user)

    def get_last_message(self, obj):
        last = obj.messages.order_by("-created_at").first()
        if last is None:
            return None
        return {
            "body": None if last.is_deleted else last.body,
            "sender_id": str(last.sender_id),
            "created_at": last.created_at,
        }

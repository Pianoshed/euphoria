from rest_framework import serializers

from . import services
from .models import CallLog, Conversation, ConversationMember, Message


class MessageSerializer(serializers.ModelSerializer):
    attachment_url = serializers.SerializerMethodField()
    attachment_type = serializers.SerializerMethodField()
    duration = serializers.SerializerMethodField()
    attachment_view_once = serializers.SerializerMethodField()
    attachment_viewed = serializers.SerializerMethodField()
    pinned = serializers.SerializerMethodField()

    class Meta:
        model = Message
        fields = [
            "id", "conversation", "sender", "body",
            "attachment_url", "attachment_type", "duration", "attachment_view_once", "attachment_viewed",
            "pinned", "created_at", "updated_at", "edited_at", "is_deleted",
        ]
        read_only_fields = fields

    def get_attachment_url(self, obj):
        attachment = services.get_message_attachment(obj)
        # View-once photos never expose a direct URL (see /view-once/ endpoint).
        if attachment is None or attachment.view_once or not attachment.file:
            return None
        request = self.context.get("request")
        url = attachment.file.url
        return request.build_absolute_uri(url) if request else url

    def get_attachment_type(self, obj):
        attachment = services.get_message_attachment(obj)
        return attachment.kind if attachment else None

    def get_duration(self, obj):
        attachment = services.get_message_attachment(obj)
        return attachment.duration_seconds if attachment else None

    def get_attachment_view_once(self, obj):
        attachment = services.get_message_attachment(obj)
        return bool(attachment and attachment.view_once)

    def get_attachment_viewed(self, obj):
        attachment = services.get_message_attachment(obj)
        return bool(attachment and attachment.viewed_at)

    def get_pinned(self, obj):
        return obj.pinned_at is not None and not obj.is_deleted


class SendMessageSerializer(serializers.Serializer):
    # Neither is individually required -- apps.chat.services.send_message
    # enforces "at least one of body/attachment" itself, since that's a
    # cross-field rule more naturally expressed there than here.
    body = serializers.CharField(max_length=services.MAX_MESSAGE_LENGTH, required=False, allow_blank=True)
    # A FileField (not ImageField) because a voice note is audio; the real validation of
    # both kinds (signature sniffing, size caps) happens in apps.chat.media_utils.
    attachment = serializers.FileField(required=False)
    view_once = serializers.BooleanField(required=False, default=False)
    attachment_type = serializers.ChoiceField(choices=["image", "audio"], required=False, default="image")
    duration = serializers.FloatField(required=False, allow_null=True, min_value=0, max_value=3600)


class EditMessageSerializer(serializers.Serializer):
    body = serializers.CharField(max_length=services.MAX_MESSAGE_LENGTH)


class StartConversationSerializer(serializers.Serializer):
    # Direct chat: target_user_id. Group chat: member_ids (+ optional title).
    target_user_id = serializers.UUIDField(required=False)
    member_ids = serializers.ListField(
        child=serializers.UUIDField(), required=False, allow_empty=False, max_length=services.GROUP_MAX_MEMBERS
    )
    title = serializers.CharField(max_length=80, required=False, allow_blank=True)

    def validate(self, attrs):
        if bool(attrs.get("target_user_id")) == bool(attrs.get("member_ids")):
            raise serializers.ValidationError("Send either target_user_id (one person) or member_ids (a group).")
        return attrs


class AddMembersSerializer(serializers.Serializer):
    user_ids = serializers.ListField(child=serializers.UUIDField(), allow_empty=False, max_length=services.GROUP_MAX_MEMBERS)


class RenameGroupSerializer(serializers.Serializer):
    title = serializers.CharField(max_length=80, allow_blank=True)


class MoodSerializer(serializers.Serializer):
    # "" clears your mood.
    mood = serializers.ChoiceField(choices=list(ConversationMember.Mood.values), allow_blank=True)


class ConversationSerializer(serializers.ModelSerializer):
    other_user_id = serializers.SerializerMethodField()
    members = serializers.SerializerMethodField()
    my_role = serializers.SerializerMethodField()
    unread_count = serializers.SerializerMethodField()
    last_message = serializers.SerializerMethodField()
    pinned_messages = serializers.SerializerMethodField()

    class Meta:
        model = Conversation
        fields = [
            "id", "booking", "is_group", "title", "other_user_id", "members", "my_role",
            "unread_count", "last_message", "pinned_messages", "created_at", "updated_at",
        ]
        read_only_fields = fields

    def get_other_user_id(self, obj):
        request = self.context.get("request")
        if not request:
            return None
        return obj.other_participant_id(request.user)

    def get_members(self, obj):
        if not obj.is_group:
            return []
        out = []
        for m in obj.members.order_by("created_at"):
            mood = services.member_mood(m)  # None once it has faded
            out.append({
                "user_id": str(m.user_id), "role": m.role,
                "mood": mood, "mood_set_at": m.mood_set_at if mood else None,
            })
        return out

    def get_pinned_messages(self, obj):
        # Only on the detail view (context["detail"]) so the conversation LIST stays light.
        if not obj.is_group or not self.context.get("detail"):
            return []
        return [services.serialize_pinned(m) for m in services.list_pinned_messages(obj)]

    def get_my_role(self, obj):
        request = self.context.get("request")
        return services.member_role(obj, request.user) if request else None

    def get_unread_count(self, obj):
        request = self.context.get("request")
        if not request:
            return 0
        return services.unread_count(obj, request.user)

    def get_last_message(self, obj):
        last = obj.messages.order_by("-created_at").first()
        if last is None:
            return None
        attachment = None if last.is_deleted else services.get_message_attachment(last)
        return {
            "body": None if last.is_deleted else last.body,
            "attachment_type": attachment.kind if attachment else None,
            "sender_id": str(last.sender_id),
            "created_at": last.created_at,
        }


class CallLogSerializer(serializers.ModelSerializer):
    caller_username = serializers.CharField(source="caller.username", read_only=True)
    callee_username = serializers.CharField(source="callee.username", read_only=True)

    class Meta:
        model = CallLog
        fields = [
            "id", "conversation", "caller", "caller_username", "callee", "callee_username",
            "mode", "outcome", "started_at", "answered_at", "ended_at", "duration_seconds",
        ]
        read_only_fields = fields

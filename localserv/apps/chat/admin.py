from django.contrib import admin

from .models import Conversation, ConversationParticipantState, Message, MessageAttachment


@admin.register(Conversation)
class ConversationAdmin(admin.ModelAdmin):
    list_display = ["id", "user_a", "user_b", "booking", "created_at", "updated_at"]
    search_fields = ["user_a__username", "user_b__username"]
    readonly_fields = ["id", "user_a", "user_b", "booking", "created_at", "updated_at"]

    def has_add_permission(self, request):
        return False


@admin.register(Message)
class MessageAdmin(admin.ModelAdmin):
    """Read-only -- staff can inspect message history (e.g. for a
    dispute or abuse report) but must never edit content on a user's
    behalf. Moderation actions (removal) belong to the moderation
    phase, not ad-hoc admin edits here."""

    list_display = ["id", "conversation", "sender", "created_at", "is_deleted"]
    list_filter = ["is_deleted"]
    search_fields = ["conversation__id", "sender__username"]
    readonly_fields = [f.name for f in Message._meta.fields]

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False


@admin.register(ConversationParticipantState)
class ConversationParticipantStateAdmin(admin.ModelAdmin):
    list_display = ["conversation", "user", "last_read_at"]
    readonly_fields = ["id", "conversation", "user", "created_at", "updated_at"]

    def has_add_permission(self, request):
        return False


@admin.register(MessageAttachment)
class MessageAttachmentAdmin(admin.ModelAdmin):
    list_display = ["message", "original_filename", "size_bytes", "created_at"]
    readonly_fields = [f.name for f in MessageAttachment._meta.fields]

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

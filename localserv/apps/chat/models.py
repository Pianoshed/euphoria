import uuid

from django.conf import settings
from django.db import models

from apps.common.models import BaseModel


class Conversation(BaseModel):
    """
    Direct (exactly 2 participants) conversation only -- matches the
    master spec's "direct conversations" requirement, not group chat.
    `user_a`/`user_b` are stored in a canonical order (see
    apps.chat.services._ordered_pair) so the same two users can never
    end up with two separate conversation rows.

    Optionally tied to a booking for context (e.g. "message the
    provider about this booking"), but not required -- users can also
    just message each other directly, subject to the target's
    who_can_message privacy setting (apps.accounts.models.ProfilePrivacy).
    """

    user_a = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="+")
    user_b = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="+")
    booking = models.ForeignKey(
        "bookings.Booking", on_delete=models.SET_NULL, null=True, blank=True, related_name="conversations"
    )

    class Meta(BaseModel.Meta):
        db_table = "chat_conversation"
        constraints = [
            models.UniqueConstraint(fields=["user_a", "user_b"], name="unique_conversation_pair"),
            models.CheckConstraint(condition=~models.Q(user_a=models.F("user_b")), name="conversation_not_self"),
        ]
        indexes = [models.Index(fields=["user_a"]), models.Index(fields=["user_b"])]

    def is_participant(self, user) -> bool:
        return user is not None and user.is_authenticated and user.id in (self.user_a_id, self.user_b_id)

    def other_participant_id(self, user):
        return self.user_b_id if user.id == self.user_a_id else self.user_a_id

    def __str__(self):
        return f"Conversation({self.user_a_id}, {self.user_b_id})"


class ConversationParticipantState(BaseModel):
    """
    Per-user mutable state for a conversation (currently just
    last-read timestamp). Kept as its own table rather than fields on
    Conversation, matching this project's established pattern of
    splitting per-user mutable state from shared object state (see
    Profile vs ProfilePrivacy).

    This is what stands in for the master spec's separate
    "ReadReceipt" model: a single per-conversation "read up to this
    time" timestamp is sufficient for a 2-person conversation and is
    far cheaper than a row per message per participant, which adds
    granularity nothing here actually needs.
    """

    conversation = models.ForeignKey(Conversation, on_delete=models.CASCADE, related_name="participant_states")
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="+")
    last_read_at = models.DateTimeField(null=True, blank=True)

    class Meta(BaseModel.Meta):
        db_table = "chat_conversation_participant_state"
        constraints = [
            models.UniqueConstraint(fields=["conversation", "user"], name="unique_participant_state"),
        ]

    def __str__(self):
        return f"ReadState({self.conversation_id}, {self.user_id})"


class Message(BaseModel):
    """
    Soft-deleted (never hard-deleted, so conversation history/order
    doesn't develop holes) and editable within no fixed time window
    (kept simple for this phase -- a real deployment would likely cap
    edit_window like the disputed-booking window, flagged as a
    possible follow-up, not solved here).

    `has_attachment` is denormalized (rather than just checking
    `hasattr(message, 'attachment')`) specifically so the DB-level
    CheckConstraint below can enforce "body or attachment, not
    neither" without needing a cross-table constraint -- a message
    with only an image and no caption is valid, but an empty message
    with nothing at all is not.
    """

    conversation = models.ForeignKey(Conversation, on_delete=models.CASCADE, related_name="messages")
    sender = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="+")
    body = models.CharField(max_length=4000, blank=True)
    has_attachment = models.BooleanField(default=False)
    edited_at = models.DateTimeField(null=True, blank=True)
    is_deleted = models.BooleanField(default=False)
    deleted_at = models.DateTimeField(null=True, blank=True)

    class Meta(BaseModel.Meta):
        db_table = "chat_message"
        indexes = [models.Index(fields=["conversation", "created_at"])]
        constraints = [
            models.CheckConstraint(
                condition=~models.Q(body="") | models.Q(is_deleted=True) | models.Q(has_attachment=True),
                name="message_body_not_empty_unless_deleted_or_has_attachment",
            ),
        ]

    def __str__(self):
        return f"Message({self.id}) in {self.conversation_id}"


def message_attachment_upload_path(instance, filename):
    # Server-generated path/filename, same reasoning as
    # apps.accounts.models.avatar_upload_path -- never trust the
    # client's filename or extension.
    return f"chat_attachments/{instance.message.conversation_id}/{uuid.uuid4().hex}.jpg"


class MessageAttachment(BaseModel):
    """One image attachment per message. Images only for now (see
    apps.chat.media_utils for the same signature-verification +
    EXIF-stripping treatment avatars get) -- a document/PDF attachment
    type is a reasonable follow-up but isn't built here."""

    message = models.OneToOneField(Message, on_delete=models.CASCADE, related_name="attachment")
    file = models.ImageField(upload_to=message_attachment_upload_path)
    original_filename = models.CharField(max_length=255, blank=True)
    size_bytes = models.PositiveIntegerField()

    class Meta(BaseModel.Meta):
        db_table = "chat_message_attachment"

    def __str__(self):
        return f"Attachment for message {self.message_id}"

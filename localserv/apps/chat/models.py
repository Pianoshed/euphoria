import os
import uuid

from django.conf import settings
from django.db import models
from django.utils import timezone

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

    # Direct chats set user_a/user_b. Group chats leave both NULL and use ConversationMember.
    user_a = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="+", null=True, blank=True)
    user_b = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="+", null=True, blank=True)
    is_group = models.BooleanField(default=False)
    title = models.CharField(max_length=80, blank=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )
    booking = models.ForeignKey(
        "bookings.Booking", on_delete=models.SET_NULL, null=True, blank=True, related_name="conversations"
    )
    # Groups only: an admin can share a link containing this code. Opening it lets someone ASK to join;
    # an admin still has to approve. Null until an admin creates a link; resetting it kills the old link.
    invite_code = models.CharField(max_length=32, null=True, blank=True, unique=True)

    class Meta(BaseModel.Meta):
        db_table = "chat_conversation"
        constraints = [
            models.UniqueConstraint(fields=["user_a", "user_b"], name="unique_conversation_pair"),
            models.CheckConstraint(condition=~models.Q(user_a=models.F("user_b")), name="conversation_not_self"),
            models.CheckConstraint(
                condition=models.Q(is_group=True) | (models.Q(user_a__isnull=False) & models.Q(user_b__isnull=False)),
                name="direct_conversation_has_both_users",
            ),
        ]
        indexes = [models.Index(fields=["user_a"]), models.Index(fields=["user_b"])]

    def is_participant(self, user) -> bool:
        if user is None or not user.is_authenticated:
            return False
        if self.is_group:
            return self.members.filter(user_id=user.id).exists()
        return user.id in (self.user_a_id, self.user_b_id)

    def other_participant_id(self, user):
        """The other person in a DIRECT chat. Groups have no single 'other' (returns None)."""
        if self.is_group:
            return None
        return self.user_b_id if user.id == self.user_a_id else self.user_a_id

    def participant_ids(self) -> list:
        if self.is_group:
            return list(self.members.values_list("user_id", flat=True))
        return [self.user_a_id, self.user_b_id]

    def __str__(self):
        return f"Conversation({self.user_a_id}, {self.user_b_id})"


class ConversationMember(BaseModel):
    """Membership row for GROUP conversations (direct chats don't use it).
    Leaving or being removed deletes the row, so is_participant() is a plain existence check."""

    class Role(models.TextChoices):
        ADMIN = "admin", "Admin"
        MEMBER = "member", "Member"

    conversation = models.ForeignKey(Conversation, on_delete=models.CASCADE, related_name="members")
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="+")
    role = models.CharField(max_length=6, choices=Role.choices, default=Role.MEMBER)

    class Mood(models.TextChoices):
        HAPPY = "happy", "Happy"   # yellow
        CALM = "calm", "Calm"      # green
        MEH = "meh", "Bleh"        # grey
        LOW = "low", "Low"         # blue
        UPSET = "upset", "Upset"   # red

    # A quiet "colour splash" for this person IN THIS GROUP. It never creates a message, never
    # bumps the conversation's order, and the API treats it as unset after MOOD_TTL (24h).
    mood = models.CharField(max_length=5, choices=Mood.choices, blank=True, default="")
    mood_set_at = models.DateTimeField(null=True, blank=True)

    class Meta(BaseModel.Meta):
        db_table = "chat_conversation_member"
        constraints = [
            models.UniqueConstraint(fields=["conversation", "user"], name="unique_conversation_member"),
        ]
        indexes = [models.Index(fields=["user"])]

    def __str__(self):
        return f"Member({self.conversation_id}, {self.user_id}, {self.role})"


class GroupJoinRequest(BaseModel):
    """Someone who opened a group's invite link and asked to join. A group admin approves or declines.
    One row per (group, person): asking again after a decline re-opens the same row."""

    class Status(models.TextChoices):
        PENDING = "pending", "Pending"
        APPROVED = "approved", "Approved"
        DECLINED = "declined", "Declined"

    conversation = models.ForeignKey(Conversation, on_delete=models.CASCADE, related_name="join_requests")
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="+")
    status = models.CharField(max_length=8, choices=Status.choices, default=Status.PENDING)
    decided_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )
    decided_at = models.DateTimeField(null=True, blank=True)

    class Meta(BaseModel.Meta):
        db_table = "chat_group_join_request"
        constraints = [
            models.UniqueConstraint(fields=["conversation", "user"], name="unique_group_join_request"),
        ]
        indexes = [models.Index(fields=["conversation", "status"], name="chat_joinreq_conv_status_idx")]

    def __str__(self):
        return f"JoinRequest({self.conversation_id}, {self.user_id}, {self.status})"


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
    # Group chats: a pinned message stays in a bar at the top of the chat (see services.pin_message).
    pinned_at = models.DateTimeField(null=True, blank=True)
    pinned_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )

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
    # The extension comes from OUR sniffed type (see media_utils), never the client's filename.
    ext = os.path.splitext(filename)[1].lower()
    if ext not in (".jpg", ".webm", ".ogg", ".m4a", ".mp3", ".wav"):
        ext = ".jpg"
    return f"chat_attachments/{instance.message.conversation_id}/{uuid.uuid4().hex}{ext}"


class MessageAttachment(BaseModel):
    """One attachment per message: an image (signature-verified and
    re-encoded, EXIF stripped -- see apps.chat.media_utils) or a short
    voice note (signature-sniffed, size- and length-capped). A document/PDF
    type is a reasonable follow-up but isn't built here."""

    class Kind(models.TextChoices):
        IMAGE = "image", "Image"
        AUDIO = "audio", "Voice note"

    kind = models.CharField(max_length=5, choices=Kind.choices, default=Kind.IMAGE)
    # Voice notes only: length in whole seconds, as reported by the recorder (clamped server-side).
    duration_seconds = models.PositiveSmallIntegerField(null=True, blank=True)

    message = models.OneToOneField(Message, on_delete=models.CASCADE, related_name="attachment")
    # blank=True: the file is removed once a view-once photo has been opened.
    file = models.FileField(upload_to=message_attachment_upload_path, blank=True)
    original_filename = models.CharField(max_length=255, blank=True)
    size_bytes = models.PositiveIntegerField()
    # View-once: the recipient can open it a single time, then the file is deleted.
    view_once = models.BooleanField(default=False)
    viewed_at = models.DateTimeField(null=True, blank=True)

    class Meta(BaseModel.Meta):
        db_table = "chat_message_attachment"

    def __str__(self):
        return f"Attachment for message {self.message_id}"


class CallLog(BaseModel):
    """
    One row per voice/video call, written by the SERVER from the call signaling
    (apps.chat.call_consumers -> apps.chat.call_logs), never by a browser, so the times
    can't be edited by a client. It holds metadata only: who, when, how long. No audio or
    video ever touches the server.

    A row is "open" (ended_at is NULL) while it rings or is in progress. At most one open
    row per conversation (see the constraint), so a call can't be logged twice.
    `duration_seconds` is talk time: answered_at -> ended_at. Calls that were never
    answered have 0.
    """

    class Mode(models.TextChoices):
        VOICE = "voice", "Voice"
        VIDEO = "video", "Video"

    class Outcome(models.TextChoices):
        RINGING = "ringing", "Ringing"
        IN_PROGRESS = "in_progress", "In progress"
        COMPLETED = "completed", "Answered"
        NO_ANSWER = "no_answer", "No answer"
        DECLINED = "declined", "Declined"
        BUSY = "busy", "Busy"
        CANCELLED = "cancelled", "Cancelled"
        FAILED = "failed", "Failed"

    # SET_NULL: the audit row outlives a deleted conversation. PROTECT on the people, same
    # as Message.sender, so history can't vanish with a user.
    conversation = models.ForeignKey(Conversation, on_delete=models.SET_NULL, null=True, blank=True, related_name="calls")
    caller = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="+")
    callee = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="+")
    mode = models.CharField(max_length=5, choices=Mode.choices)
    outcome = models.CharField(max_length=12, choices=Outcome.choices, default=Outcome.RINGING)
    started_at = models.DateTimeField(default=timezone.now)
    answered_at = models.DateTimeField(null=True, blank=True)
    ended_at = models.DateTimeField(null=True, blank=True)
    duration_seconds = models.PositiveIntegerField(default=0)
    # The caller's SDP offer, kept only while the call is ringing so a callee who is not on the
    # chat page yet can still receive it. Cleared the moment the call is answered or ends.
    offer_sdp = models.TextField(blank=True, default="")

    class Meta(BaseModel.Meta):
        db_table = "chat_call_log"
        indexes = [
            models.Index(fields=["caller", "-started_at"], name="chat_call_caller_idx"),
            models.Index(fields=["callee", "-started_at"], name="chat_call_callee_idx"),
            models.Index(fields=["-started_at"], name="chat_call_started_idx"),
        ]
        constraints = [
            models.UniqueConstraint(
                fields=["conversation"],
                condition=models.Q(ended_at__isnull=True),
                name="one_open_call_per_conversation",
            ),
        ]

    def __str__(self):
        return f"Call({self.caller_id} -> {self.callee_id}, {self.outcome})"


class GroupCall(BaseModel):
    """
    One row per call in a GROUP conversation. Group calls are a mesh: every browser connects
    straight to every other browser, and the server (apps.chat.group_call_consumers) only relays
    signaling, exactly like 1-to-1 calls. Nothing is recorded; this row keeps who started it,
    when, how long it ran and the most people on it at once.

    Open (ended_at NULL) while anyone is still on it; at most one open call per group.
    """

    class Mode(models.TextChoices):
        VOICE = "voice", "Voice"
        VIDEO = "video", "Video"

    conversation = models.ForeignKey(Conversation, on_delete=models.SET_NULL, null=True, blank=True, related_name="group_calls")
    started_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="+")
    mode = models.CharField(max_length=5, choices=Mode.choices, default=Mode.VIDEO)
    started_at = models.DateTimeField(default=timezone.now)
    ended_at = models.DateTimeField(null=True, blank=True)
    peak_participants = models.PositiveSmallIntegerField(default=0)
    duration_seconds = models.PositiveIntegerField(default=0)

    class Meta(BaseModel.Meta):
        db_table = "chat_group_call"
        indexes = [models.Index(fields=["-started_at"], name="chat_gcall_started_idx")]
        constraints = [
            models.UniqueConstraint(
                fields=["conversation"], condition=models.Q(ended_at__isnull=True), name="one_open_group_call_per_conversation"
            ),
        ]

    def __str__(self):
        return f"GroupCall({self.conversation_id}, {self.mode})"


class GroupCallParticipant(BaseModel):
    """A seat on a group call. Open (left_at NULL) while the person is on it."""

    call = models.ForeignKey(GroupCall, on_delete=models.CASCADE, related_name="participants")
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="+")
    joined_at = models.DateTimeField(default=timezone.now)
    left_at = models.DateTimeField(null=True, blank=True)

    class Meta(BaseModel.Meta):
        db_table = "chat_group_call_participant"
        constraints = [
            models.UniqueConstraint(
                fields=["call", "user"], condition=models.Q(left_at__isnull=True), name="one_open_seat_per_user_per_group_call"
            ),
        ]

    def __str__(self):
        return f"Seat({self.call_id}, {self.user_id})"

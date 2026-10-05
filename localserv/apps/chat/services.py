from django.core.cache import cache
from django.core.exceptions import ObjectDoesNotExist
from django.db import transaction
from django.db.models import Q
from django.utils import timezone

from apps.accounts.models import ProfilePrivacy, User
from apps.accounts.services import is_blocked_between
from apps.common.constants import ContactPermission
from apps.common.exceptions import AccountNotEligibleError, DomainError
from apps.common.utils import clamp_page_size

from .media_utils import clamp_voice_duration, process_message_attachment, process_voice_upload
from .models import Conversation, ConversationParticipantState, Message, MessageAttachment

MAX_MESSAGE_LENGTH = 4000

# Mirrors the DRF "messages" throttle scope (120/min, see
# config.settings.base) so the WebSocket send path is bound by the
# same budget as the REST send path -- DRF's throttle classes are
# HTTP-request-scoped and can't reach a Channels consumer directly.
WS_MESSAGE_RATE_LIMIT = 120
WS_MESSAGE_RATE_WINDOW_SECONDS = 60


def _ordered_pair(user_a_id, user_b_id):
    return (user_a_id, user_b_id) if str(user_a_id) < str(user_b_id) else (user_b_id, user_a_id)


# ---------------------------------------------------------------------------
# Conversations
# ---------------------------------------------------------------------------
@transaction.atomic
def start_or_get_conversation(initiator: User, target_user_id) -> Conversation:
    if str(initiator.id) == str(target_user_id):
        raise DomainError("You cannot start a conversation with yourself.")

    target = User.objects.filter(id=target_user_id).first()
    if target is None:
        raise DomainError("User not found.")

    if is_blocked_between(initiator.id, target.id):
        # Same "don't confirm a block exists either way" posture as
        # apps.accounts.services.get_public_profile.
        raise DomainError("Unable to start a conversation with this user.")

    a_id, b_id = _ordered_pair(initiator.id, target.id)
    existing = Conversation.objects.filter(user_a_id=a_id, user_b_id=b_id).first()
    if existing:
        return existing

    # who_can_message is only checked when STARTING a new conversation
    # -- once one exists, changing the setting doesn't retroactively
    # cut off an existing thread (blocking is the active, continuously
    # re-checked mechanism for that; see send_message and the
    # WebSocket connect() handshake).
    privacy = ProfilePrivacy.objects.filter(user_id=target.id).first()
    who_can_message = privacy.who_can_message if privacy else ContactPermission.EVERYONE
    if who_can_message == ContactPermission.NOBODY:
        raise AccountNotEligibleError("This user is not accepting messages.")

    return Conversation.objects.create(user_a_id=a_id, user_b_id=b_id)


def list_conversations(user, *, page_size=None):
    qs = Conversation.objects.filter(Q(user_a=user) | Q(user_b=user)).order_by("-updated_at")
    return qs, clamp_page_size(page_size)


def get_conversation_for_user(conversation_id, user) -> Conversation | None:
    """Returns None for both "doesn't exist" and "exists but you're
    not a participant" -- callers surface both as 404, never 403, so
    this endpoint can't be used to probe which conversation IDs are
    real (Sec 27 enumeration protection)."""
    conversation = Conversation.objects.filter(id=conversation_id).first()
    if conversation is None or not conversation.is_participant(user):
        return None
    return conversation


# ---------------------------------------------------------------------------
# Messages
# ---------------------------------------------------------------------------
@transaction.atomic
def send_message(
    conversation: Conversation,
    sender: User,
    *,
    body: str = "",
    attachment=None,
    view_once: bool = False,
    attachment_type: str = MessageAttachment.Kind.IMAGE,
    duration=None,
) -> Message:
    if not conversation.is_participant(sender):
        raise DomainError("You are not a participant in this conversation.")

    other_id = conversation.other_participant_id(sender)
    if is_blocked_between(sender.id, other_id):
        raise AccountNotEligibleError("You cannot message this user.")

    body = (body or "").strip()
    if not body and not attachment:
        raise DomainError("A message needs text, an attachment, or both.")
    if len(body) > MAX_MESSAGE_LENGTH:
        raise DomainError(f"Message must be under {MAX_MESSAGE_LENGTH} characters.")

    message = Message.objects.create(
        conversation=conversation, sender=sender, body=body, has_attachment=bool(attachment)
    )
    if attachment:
        if attachment_type == MessageAttachment.Kind.AUDIO:
            processed, ext = process_voice_upload(attachment)
            message_attachment = MessageAttachment(
                message=message,
                kind=MessageAttachment.Kind.AUDIO,
                original_filename=(attachment.name or "")[:255],
                size_bytes=attachment.size,
                view_once=False,  # view-once is a photo feature
                duration_seconds=clamp_voice_duration(duration),
            )
            message_attachment.file.save(f"voice.{ext}", processed, save=True)
        else:
            processed = process_message_attachment(attachment)
            message_attachment = MessageAttachment(
                message=message,
                original_filename=(attachment.name or "")[:255],
                size_bytes=attachment.size,
                view_once=bool(view_once),
            )
            message_attachment.file.save("attachment.jpg", processed, save=True)
    conversation.save(update_fields=["updated_at"])  # bumps conversation list ordering
    return message


def edit_message(message: Message, user: User, *, body: str) -> Message:
    if message.sender_id != user.id:
        raise AccountNotEligibleError("You can only edit your own messages.")
    if message.is_deleted:
        raise DomainError("Cannot edit a deleted message.")

    body = (body or "").strip()
    if not body:
        raise DomainError("Message body cannot be empty.")
    if len(body) > MAX_MESSAGE_LENGTH:
        raise DomainError(f"Message must be under {MAX_MESSAGE_LENGTH} characters.")

    message.body = body
    message.edited_at = timezone.now()
    message.save(update_fields=["body", "edited_at", "updated_at"])
    return message


def delete_message(message: Message, user: User) -> Message:
    if message.sender_id != user.id:
        raise AccountNotEligibleError("You can only delete your own messages.")

    _purge_attachment(message)  # remove the image file too, not just hide it

    message.is_deleted = True
    message.deleted_at = timezone.now()
    message.body = ""  # don't retain deleted content at rest
    message.has_attachment = False
    message.save(update_fields=["is_deleted", "deleted_at", "body", "has_attachment", "updated_at"])
    return message


def get_message_attachment(message: Message):
    """The message's MessageAttachment, or None."""
    if not message.has_attachment:
        return None
    try:
        return message.attachment
    except ObjectDoesNotExist:
        return None


def _purge_attachment(message: Message) -> None:
    try:
        attachment = message.attachment
    except ObjectDoesNotExist:
        return
    if attachment.file:
        try:
            attachment.file.delete(save=False)
        except OSError:
            pass  # file already gone (e.g. wiped by a redeploy); still drop the row
    attachment.delete()


def consume_view_once(message_id, user):
    """Returns (message, image_bytes) for a view-once photo -- exactly once.

    Only the recipient can open it. The file is deleted from storage in the same
    transaction that records viewed_at, so a second open always fails."""
    with transaction.atomic():
        message = Message.objects.select_related("conversation").filter(id=message_id).first()
        if message is None or message.is_deleted or not message.conversation.is_participant(user):
            raise Message.DoesNotExist
        try:
            attachment = MessageAttachment.objects.select_for_update().get(message=message, view_once=True)
        except MessageAttachment.DoesNotExist:
            raise Message.DoesNotExist from None

        if message.sender_id == user.id:
            raise DomainError("You can't open a view-once photo you sent.")
        if attachment.viewed_at is not None or not attachment.file:
            raise DomainError("This photo has already been opened.")

        try:
            attachment.file.open("rb")
            try:
                data = attachment.file.read()
            finally:
                attachment.file.close()
        except OSError:
            data = None

        try:
            attachment.file.delete(save=False)
        except OSError:
            pass
        attachment.file = ""
        attachment.viewed_at = timezone.now()
        attachment.save(update_fields=["file", "viewed_at", "updated_at"])

    if data is None:
        raise DomainError("This photo is no longer available.")
    return message, data


def list_messages(conversation: Conversation, *, page_size=None):
    qs = conversation.messages.order_by("-created_at")
    return qs, clamp_page_size(page_size)


def mark_read(conversation: Conversation, user: User) -> None:
    if not conversation.is_participant(user):
        raise DomainError("You are not a participant in this conversation.")
    ConversationParticipantState.objects.update_or_create(
        conversation=conversation, user=user, defaults={"last_read_at": timezone.now()},
    )


def unread_count(conversation: Conversation, user: User) -> int:
    state = ConversationParticipantState.objects.filter(conversation=conversation, user=user).first()
    qs = conversation.messages.exclude(sender=user).filter(is_deleted=False)
    if state and state.last_read_at:
        qs = qs.filter(created_at__gt=state.last_read_at)
    return qs.count()


# ---------------------------------------------------------------------------
# WebSocket support
# ---------------------------------------------------------------------------
def check_and_increment_ws_rate_limit(user) -> bool:
    """Returns True (and counts this call) if the user is still under
    budget, False if they've hit the per-minute limit. A best-effort
    limiter (the get-then-set below isn't atomic under heavy
    concurrency) -- acceptable here since this is defense-in-depth
    alongside the "messages" DRF throttle scope on the REST send path,
    not the sole abuse control."""
    key = f"chat:ws_rate:{user.id}"
    count = cache.get(key)
    if count is None:
        cache.set(key, 1, timeout=WS_MESSAGE_RATE_WINDOW_SECONDS)
        return True
    if count >= WS_MESSAGE_RATE_LIMIT:
        return False
    try:
        cache.incr(key)
    except ValueError:
        cache.set(key, 1, timeout=WS_MESSAGE_RATE_WINDOW_SECONDS)
    return True


def serialize_message_for_broadcast(conversation: Conversation, message: Message) -> dict:
    attachment = get_message_attachment(message)
    view_once = bool(attachment and attachment.view_once)
    attachment_url = None
    # View-once photos never expose a direct URL; they're fetched through the
    # authenticated /view-once/ endpoint instead.
    if attachment and attachment.file and not view_once:
        attachment_url = attachment.file.url
    return {
        "type": "message",
        "id": str(message.id),
        "conversation_id": str(conversation.id),
        "sender_id": str(message.sender_id),
        "body": message.body,
        "attachment_url": attachment_url,
        "attachment_type": attachment.kind if attachment else None,
        "duration": attachment.duration_seconds if attachment else None,
        "attachment_view_once": view_once,
        "attachment_viewed": bool(attachment and attachment.viewed_at),
        "created_at": message.created_at.isoformat(),
    }


def broadcast_event(conversation: Conversation, payload: dict) -> None:
    """Best-effort live push of a non-message event (deleted / viewed)."""
    import logging

    from asgiref.sync import async_to_sync
    from channels.layers import get_channel_layer

    channel_layer = get_channel_layer()
    if channel_layer is None:
        return
    try:
        async_to_sync(channel_layer.group_send)(
            f"conversation_{conversation.id}", {"type": "chat.message", "payload": payload}
        )
    except Exception:
        logging.getLogger("apps").warning("Failed to broadcast event %s", payload.get("type"), exc_info=True)


def broadcast_message(conversation: Conversation, message: Message) -> None:
    """Pushes a message to any WebSocket-connected participants. Called
    from BOTH the REST send-message view and (indirectly, since the
    consumer calls send_message then does this itself) the WS path,
    so a client using either transport sees identical live delivery.
    A missing/unreachable channel layer (e.g. Redis down, or some test
    setups) degrades to "REST send still persisted fine, just no live
    push" rather than failing the request -- this requires actually
    catching the channel layer's own connection errors, not just
    checking for a None layer (a configured-but-unreachable Redis
    still returns a real layer object; the failure only surfaces when
    group_send is awaited)."""
    import logging

    from asgiref.sync import async_to_sync
    from channels.layers import get_channel_layer

    logger = logging.getLogger("apps")

    channel_layer = get_channel_layer()
    if channel_layer is None:
        return
    payload = serialize_message_for_broadcast(conversation, message)
    try:
        async_to_sync(channel_layer.group_send)(
            f"conversation_{conversation.id}", {"type": "chat.message", "payload": payload}
        )
    except Exception:
        # Live push is best-effort -- the message is already
        # persisted by this point (send_message already committed).
        # Never let a channel-layer/broker outage turn into a 500 on
        # an otherwise-successful send.
        logger.warning("Failed to broadcast message %s to channel layer", message.id, exc_info=True)

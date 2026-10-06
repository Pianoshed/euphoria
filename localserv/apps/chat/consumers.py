import time

from channels.db import database_sync_to_async
from channels.generic.websocket import AsyncJsonWebsocketConsumer

from apps.common.constants import AccountStatus
from apps.common.exceptions import DomainError

from . import services

# Close codes (4000-4999 is the app-defined range per the WS spec):
CLOSE_UNAUTHENTICATED = 4401
CLOSE_ACCOUNT_NOT_ACTIVE = 4403
CLOSE_NOT_FOUND_OR_NOT_PARTICIPANT = 4404
CLOSE_BLOCKED = 4403


class ChatConsumer(AsyncJsonWebsocketConsumer):
    """
    Connection sequence (Sec 8 of the master spec, applied literally):
    authenticate -> verify participant -> verify account status ->
    verify block relationship -> allow connection. Every check is
    re-run at connect time even though it was already true when the
    conversation was created, because block state and account status
    can both change after that point.
    """

    async def connect(self):
        user = self.scope["user"]
        conversation_id = self.scope["url_route"]["kwargs"]["conversation_id"]

        if user is None or not user.is_authenticated:
            await self.close(code=CLOSE_UNAUTHENTICATED)
            return

        if getattr(user, "status", None) != AccountStatus.ACTIVE:
            await self.close(code=CLOSE_ACCOUNT_NOT_ACTIVE)
            return

        conversation = await self._get_conversation_for_user(conversation_id, user)
        if conversation is None:
            # Same non-distinguishing posture as the REST 404 --
            # "doesn't exist" and "not yours" look identical here too.
            await self.close(code=CLOSE_NOT_FOUND_OR_NOT_PARTICIPANT)
            return

        # Blocking is a one-to-one check; a group has no single "other" person.
        if not conversation.is_group:
            other_id = conversation.other_participant_id(user)
            if await self._is_blocked(user.id, other_id):
                await self.close(code=CLOSE_BLOCKED)
                return

        self.conversation = conversation
        self.user = user
        self._last_typing = 0.0
        self.group_name = f"conversation_{conversation.id}"
        await self.channel_layer.group_add(self.group_name, self.channel_name)
        await self.accept()

    async def disconnect(self, code):
        if hasattr(self, "group_name"):
            await self.channel_layer.group_discard(self.group_name, self.channel_name)

    async def receive_json(self, content, **kwargs):
        if content.get("type") == "typing":
            # "X is typing...": relayed to everyone else, at most once every 1.5 s per person.
            now = time.monotonic()
            if now - self._last_typing >= 1.5:
                self._last_typing = now
                await self.channel_layer.group_send(self.group_name, {
                    "type": "chat.typing", "user_id": str(self.user.id), "sender_channel": self.channel_name,
                })
            return

        if content.get("type") != "message":
            await self.send_json({"type": "error", "detail": "Unknown message type."})
            return

        if not await self._check_rate_limit(self.user):
            await self.send_json({"type": "error", "detail": "You're sending messages too quickly. Slow down."})
            return

        try:
            message = await self._send_message(self.conversation, self.user, content.get("body", ""))
        except DomainError as exc:
            detail = getattr(exc, "detail", str(exc))
            await self.send_json({"type": "error", "detail": str(detail)})
            return

        payload = await self._serialize_for_broadcast(self.conversation, message)
        await self.channel_layer.group_send(self.group_name, {"type": "chat.message", "payload": payload})

    async def chat_message(self, event):
        payload = event["payload"]
        # Someone was removed from this group: close THEIR socket so they stop receiving messages.
        if payload.get("type") == "member_removed" and str(payload.get("user_id")) == str(self.user.id):
            await self.send_json(payload)
            await self.close(code=CLOSE_NOT_FOUND_OR_NOT_PARTICIPANT)
            return
        await self.send_json(payload)

    async def chat_typing(self, event):
        if event["sender_channel"] == self.channel_name:
            return
        await self.send_json({"type": "typing", "user_id": event["user_id"]})

    # --- sync ORM access, wrapped for the async consumer ---------------------------

    @database_sync_to_async
    def _get_conversation_for_user(self, conversation_id, user):
        return services.get_conversation_for_user(conversation_id, user)

    @database_sync_to_async
    def _is_blocked(self, user_id, other_id):
        from apps.accounts.services import is_blocked_between

        return is_blocked_between(user_id, other_id)

    @database_sync_to_async
    def _check_rate_limit(self, user):
        return services.check_and_increment_ws_rate_limit(user)

    @database_sync_to_async
    def _send_message(self, conversation, user, body):
        return services.send_message(conversation, user, body=body)

    @database_sync_to_async
    def _serialize_for_broadcast(self, conversation, message):
        return services.serialize_message_for_broadcast(conversation, message)

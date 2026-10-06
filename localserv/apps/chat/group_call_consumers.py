import logging
import time
import uuid
from collections import deque

from channels.db import database_sync_to_async
from channels.generic.websocket import AsyncJsonWebsocketConsumer

from apps.common.constants import AccountStatus

from . import group_calls, services
from .call_consumers import CallConsumer, inbox_group
from .consumers import (
    CLOSE_ACCOUNT_NOT_ACTIVE,
    CLOSE_NOT_FOUND_OR_NOT_PARTICIPANT,
    CLOSE_UNAUTHENTICATED,
)

log = logging.getLogger("apps")

SIGNALS = {"offer", "answer", "ice"}
MAX_SIGNALS_PER_MINUTE = 900  # a mesh of 8 trades a lot of ICE; this only stops abuse
RATE_WINDOW_SECONDS = 60


class GroupCallConsumer(AsyncJsonWebsocketConsumer):
    """
    WebRTC signaling for a call inside a GROUP chat (/ws/gcall/<conversation_id>/).

    It is a mesh: everyone connects to everyone, and this socket only relays offers, answers and
    ICE between named people. Rules that keep it simple:
      * Connecting does not put you on the call. The browser sends {"type": "join", "mode"}.
      * The newcomer sends an offer to each person already on the call; nobody else ever offers
        first, so two people can never offer to each other at once.
      * Disconnecting (or {"type": "leave"}) takes you off the call and tells everyone.
      * Two people who have blocked each other are never connected to each other.
    Media never touches the server, and nothing is recorded.
    """

    async def connect(self):
        user = self.scope["user"]
        conversation_id = self.scope["url_route"]["kwargs"]["conversation_id"]
        self.call_id = None
        if user is None or not user.is_authenticated:
            return await self.close(code=CLOSE_UNAUTHENTICATED)
        if getattr(user, "status", None) != AccountStatus.ACTIVE:
            return await self.close(code=CLOSE_ACCOUNT_NOT_ACTIVE)
        conversation = await database_sync_to_async(services.get_conversation_for_user)(conversation_id, user)
        if conversation is None or not conversation.is_group:
            return await self.close(code=CLOSE_NOT_FOUND_OR_NOT_PARTICIPANT)
        self.conversation = conversation
        self.user = user
        self.group_name = f"gcall_{conversation.id}"
        self._sent_at = deque()
        await self.channel_layer.group_add(self.group_name, self.channel_name)
        await self.accept()

    async def disconnect(self, code):
        if getattr(self, "call_id", None):
            await self._leave()
        if hasattr(self, "group_name"):
            await self.channel_layer.group_discard(self.group_name, self.channel_name)

    async def receive_json(self, content, **kwargs):
        if not isinstance(content, dict):
            return await self._error("Invalid call message.")
        kind = content.get("type")
        if kind not in SIGNALS | {"join", "leave"}:
            return await self._error("Unknown call message type.")
        if not self._within_rate_limit():
            return await self._error("Too many call signals. Slow down.")

        if kind == "join":
            return await self._join(content.get("mode"))
        if kind == "leave":
            if self.call_id:
                await self._leave()
            return None
        if not self.call_id:
            return await self._error("Join the call first.")

        to = content.get("to")
        try:
            to = str(uuid.UUID(str(to)))
        except (ValueError, AttributeError):
            return await self._error("Invalid call message.")
        if to == str(self.user.id):
            return None
        payload = CallConsumer._clean_payload(kind, content)
        if payload is None:
            return await self._error("Invalid call message.")
        if kind == "offer" and not await self._can_offer(to):
            return None  # removed from the group, or blocked: silently dropped
        payload["from"] = str(self.user.id)
        await self.channel_layer.group_send(
            self.group_name,
            {"type": "gcall.signal", "payload": payload, "to": to, "sender_channel": self.channel_name},
        )
        return None

    # --- join / leave ----------------------------------------------------------------

    async def _join(self, mode):
        if self.call_id:
            return await self._error("You are already on this call.")
        mode = mode if mode in ("voice", "video") else "video"
        if not await database_sync_to_async(self.conversation.is_participant)(self.user):
            return await self.close(code=CLOSE_NOT_FOUND_OR_NOT_PARTICIPANT)
        try:
            call, peers, created, replaced = await database_sync_to_async(group_calls.join)(
                self.conversation, self.user, mode
            )
        except group_calls.CallFull:
            return await self.send_json({"type": "full", "max": group_calls.MAX_PARTICIPANTS})
        except Exception:
            log.warning("Group call join failed", exc_info=True)
            return await self._error("Could not join the call. Try again.")

        self.call_id = str(call.id)
        me = str(self.user.id)
        if replaced:
            await self.channel_layer.group_send(
                self.group_name, {"type": "gcall.replaced", "user_id": me, "keep_channel": self.channel_name}
            )
        peers = await database_sync_to_async(self._without_blocked)(peers)
        await self.send_json({"type": "joined", "call_id": self.call_id, "mode": call.mode, "peers": peers})
        await self.channel_layer.group_send(
            self.group_name,
            {"type": "gcall.peer", "payload": {"type": "peer-joined", "user_id": me}, "sender_channel": self.channel_name},
        )
        await self._tell_chat()
        if created:
            await self._ring_members(call)

    async def _leave(self):
        call_id, self.call_id = self.call_id, None
        me = str(self.user.id)
        ended = await database_sync_to_async(group_calls.leave)(call_id, self.user.id)
        await self.channel_layer.group_send(
            self.group_name,
            {"type": "gcall.peer", "payload": {"type": "peer-left", "user_id": me}, "sender_channel": self.channel_name},
        )
        await self._tell_chat()
        if ended:
            await self._stop_ringing()

    # --- group events ----------------------------------------------------------------

    async def gcall_signal(self, event):
        if not self.call_id or event["to"] != str(self.user.id) or event["sender_channel"] == self.channel_name:
            return
        payload = event["payload"]
        if payload["type"] == "offer" and await self._is_blocked(payload["from"]):
            return
        await self.send_json(payload)

    async def gcall_peer(self, event):
        if not self.call_id or event["sender_channel"] == self.channel_name:
            return
        payload = event["payload"]
        if payload["type"] == "peer-joined" and await self._is_blocked(payload["user_id"]):
            return
        await self.send_json(payload)

    async def gcall_replaced(self, event):
        """The same person joined from another tab or device: this one steps off."""
        if event["user_id"] != str(self.user.id) or event["keep_channel"] == self.channel_name or not self.call_id:
            return
        self.call_id = None  # so disconnect() does not take the NEW seat away
        await self.send_json({"type": "replaced"})
        await self.close()

    # --- helpers ---------------------------------------------------------------------

    async def _tell_chat(self):
        """The chat page of this group shows a 'call in progress' bar; tell it to refresh."""
        try:
            await self.channel_layer.group_send(
                f"conversation_{self.conversation.id}",
                {"type": "chat.message", "payload": {"type": "group_call_changed"}},
            )
        except Exception:
            log.warning("Could not tell the chat about a group call change", exc_info=True)

    async def _member_ids(self):
        ids = await database_sync_to_async(self.conversation.participant_ids)()
        return [str(i) for i in ids if str(i) != str(self.user.id)]

    async def _ring_members(self, call):
        try:
            for uid in await self._member_ids():
                await self.channel_layer.group_send(inbox_group(uid), {
                    "type": "call.incoming", "conversation_id": str(self.conversation.id),
                    "caller_id": str(self.user.id), "mode": call.mode,
                    "group": True, "title": self.conversation.title or "Group call",
                })
        except Exception:
            log.warning("Group call ring failed", exc_info=True)

    async def _stop_ringing(self):
        try:
            for uid in await self._member_ids():
                await self.channel_layer.group_send(
                    inbox_group(uid), {"type": "call.ended", "conversation_id": str(self.conversation.id)}
                )
        except Exception:
            log.warning("Group call stop-ring failed", exc_info=True)

    async def _error(self, detail):
        await self.send_json({"type": "error", "detail": detail})

    def _within_rate_limit(self) -> bool:
        now = time.monotonic()
        while self._sent_at and now - self._sent_at[0] > RATE_WINDOW_SECONDS:
            self._sent_at.popleft()
        if len(self._sent_at) >= MAX_SIGNALS_PER_MINUTE:
            return False
        self._sent_at.append(now)
        return True

    async def _can_offer(self, to) -> bool:
        return await database_sync_to_async(self._can_offer_sync)(to)

    def _can_offer_sync(self, to) -> bool:
        from apps.accounts.services import is_blocked_between

        return self.conversation.is_participant(self.user) and not is_blocked_between(self.user.id, to)

    async def _is_blocked(self, other_id) -> bool:
        return await database_sync_to_async(self._is_blocked_sync)(other_id)

    def _is_blocked_sync(self, other_id) -> bool:
        from apps.accounts.services import is_blocked_between

        return bool(is_blocked_between(self.user.id, other_id))

    def _without_blocked(self, peer_ids):
        return [p for p in peer_ids if not self._is_blocked_sync(p)]

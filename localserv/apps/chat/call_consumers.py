import logging
import time
from collections import deque

from channels.db import database_sync_to_async
from channels.generic.websocket import AsyncJsonWebsocketConsumer

from apps.common.constants import AccountStatus

from . import call_logs, services
from .consumers import (
    CLOSE_ACCOUNT_NOT_ACTIVE,
    CLOSE_BLOCKED,
    CLOSE_NOT_FOUND_OR_NOT_PARTICIPANT,
    CLOSE_UNAUTHENTICATED,
)

# Signal types a client may send. The server only checks shape and size, then relays to the
# other participant. It does not interpret ICE candidates, and reads an SDP for just one thing:
# whether it has a video line, which tells a voice call from a video call (see call_logs).
SDP_TYPES = {"offer", "answer"}
BARE_TYPES = {"reject", "hangup", "busy"}
ALLOWED_TYPES = SDP_TYPES | BARE_TYPES | {"ice"}

MAX_SDP_LENGTH = 20_000
MAX_CANDIDATE_LENGTH = 2_000
MAX_SIGNALS_PER_MINUTE = 240  # a call needs a few dozen; this only stops abuse
RATE_WINDOW_SECONDS = 60


class CallConsumer(AsyncJsonWebsocketConsumer):
    """
    WebRTC signaling for one-to-one video calls inside a conversation.

    Media never touches the server: the browsers connect to each other (or via
    a TURN relay) and use this socket only to swap offers, answers and ICE
    candidates. It lives on its own group, separate from the chat group, so
    chat sockets never receive call traffic.

    The connect checks are the same as ChatConsumer's (authenticated, active,
    participant, not blocked). A block is also re-checked on every new offer,
    because a block can be created while the socket is open.

    Every call is also written to the call log (apps.chat.call_logs) from the signals that pass
    through here. That is the audit trail: the server sees the offer, the answer and the hangup
    itself, so nobody's browser can change who called whom, when, or for how long.
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
            await self.close(code=CLOSE_NOT_FOUND_OR_NOT_PARTICIPANT)
            return

        self.other_id = conversation.other_participant_id(user)
        if await self._is_blocked(user.id, self.other_id):
            await self.close(code=CLOSE_BLOCKED)
            return

        self.conversation = conversation
        self.user = user
        self.group_name = f"call_{conversation.id}"
        self._sent_at = deque()
        await self.channel_layer.group_add(self.group_name, self.channel_name)
        await self.accept()

    async def disconnect(self, code):
        if hasattr(self, "group_name"):
            await self.channel_layer.group_discard(self.group_name, self.channel_name)

    async def receive_json(self, content, **kwargs):
        if not isinstance(content, dict):
            await self._error("Invalid call message.")
            return

        kind = content.get("type")
        if kind not in ALLOWED_TYPES:
            await self._error("Unknown call message type.")
            return

        if not self._within_rate_limit():
            await self._error("Too many call signals. Slow down.")
            return

        payload = self._clean_payload(kind, content)
        if payload is None:
            await self._error("Invalid call message.")
            return

        if kind == "offer" and await self._is_blocked(self.user.id, self.other_id):
            await self.close(code=CLOSE_BLOCKED)
            return

        await self._log_signal(kind, payload)

        payload["from"] = str(self.user.id)
        await self.channel_layer.group_send(
            self.group_name,
            {"type": "call.signal", "payload": payload, "sender_channel": self.channel_name},
        )

    async def call_signal(self, event):
        # The sender's own socket never gets its signal echoed back.
        if event["sender_channel"] == self.channel_name:
            return
        await self.send_json(event["payload"])

    # --- helpers -------------------------------------------------------------------

    async def _log_signal(self, kind, payload):
        """Keep the call log in step with the signaling. Never raises: a logging problem must
        not stop a call (the call_logs functions also catch and log their own errors)."""
        try:
            if kind == "offer":
                await database_sync_to_async(call_logs.start_call)(
                    self.conversation, self.user.id, self.other_id, payload["sdp"]
                )
            elif kind == "answer":
                await database_sync_to_async(call_logs.record_answer)(self.conversation.id, self.user.id)
            elif kind in BARE_TYPES:
                await database_sync_to_async(call_logs.record_end)(self.conversation.id, self.user.id, kind)
        except Exception:
            logging.getLogger("apps").warning("Call log update failed", exc_info=True)

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

    @staticmethod
    def _clean_payload(kind, content):
        """Returns a new dict containing only fields we expect, or None if the
        message is malformed. Nothing from the client is forwarded verbatim."""
        if kind in SDP_TYPES:
            sdp = content.get("sdp")
            if not isinstance(sdp, str) or not sdp or len(sdp) > MAX_SDP_LENGTH:
                return None
            return {"type": kind, "sdp": sdp}

        if kind == "ice":
            candidate = content.get("candidate")
            if candidate is None:  # end-of-candidates marker
                return {"type": "ice", "candidate": None}
            if not isinstance(candidate, dict):
                return None
            text = candidate.get("candidate")
            if not isinstance(text, str) or len(text) > MAX_CANDIDATE_LENGTH:
                return None
            mid = candidate.get("sdpMid")
            index = candidate.get("sdpMLineIndex")
            fragment = candidate.get("usernameFragment")
            if mid is not None and not isinstance(mid, str):
                return None
            if index is not None and (not isinstance(index, int) or isinstance(index, bool)):
                return None
            if fragment is not None and not isinstance(fragment, str):
                return None
            return {
                "type": "ice",
                "candidate": {
                    "candidate": text,
                    "sdpMid": mid,
                    "sdpMLineIndex": index,
                    "usernameFragment": fragment,
                },
            }

        return {"type": kind}  # reject / hangup / busy carry no data

    # --- sync ORM access, wrapped for the async consumer ---------------------------

    @database_sync_to_async
    def _get_conversation_for_user(self, conversation_id, user):
        return services.get_conversation_for_user(conversation_id, user)

    @database_sync_to_async
    def _is_blocked(self, user_id, other_id):
        from apps.accounts.services import is_blocked_between

        return is_blocked_between(user_id, other_id)

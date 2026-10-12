"""Tiny "something changed" hints pushed to a user's site-wide inbox socket (/ws/calls/inbox/).

Why this exists: the site used to poll the server every 15-60 s per signed-in user to learn about new
messages, wallet credits and missed calls. With this, the server tells the browser the moment it happens
and the browser only polls as a slow safety net.

Rules for everything sent through here:
  * A hint carries NO content (no message text, no amounts): just a type and, for chat, a conversation id.
    The browser fetches details over the normal authenticated API if it needs them.
  * Sent only AFTER the database transaction commits, so a browser that reacts by fetching never sees old data.
  * Best-effort. If Redis / the channel layer is down the request that caused the event must still succeed;
    the browser's slow reconcile poll covers the gap.
"""
import asyncio
import logging

from django.core.cache import cache
from django.db import transaction

log = logging.getLogger("apps")


def _send(user_ids, payload, forget_unread):
    from asgiref.sync import async_to_sync
    from channels.layers import get_channel_layer

    from .call_consumers import inbox_group  # imported late: call_consumers imports services

    if forget_unread:
        try:
            # services.unread_summary() caches counts for 5 s; drop that so the next fetch is not stale.
            cache.delete_many([f"chat:unread:{uid}" for uid in user_ids])
        except Exception:
            log.warning("Could not clear unread cache", exc_info=True)

    layer = get_channel_layer()
    if layer is None:
        return

    async def _all():
        # In parallel, one loop entry: a 20-member group used to cost 20 sequential Redis round trips
        # inside the sender's request (and, for WebSocket messages, inside the shared DB thread).
        results = await asyncio.gather(
            *(layer.group_send(inbox_group(uid), {"type": "inbox.event", "payload": payload}) for uid in user_ids),
            return_exceptions=True,
        )
        failed = [r for r in results if isinstance(r, Exception)]
        if failed:
            # Channel layer unreachable / full: the browser's slow reconcile poll covers the gap.
            log.warning("Inbox push failed for %d of %d recipients (%s): %r",
                        len(failed), len(user_ids), payload.get("type"), failed[0])

    try:
        async_to_sync(_all)()
    except Exception:
        log.warning("Inbox push failed (%s)", payload.get("type"), exc_info=True)


def push_to_users(user_ids, payload, *, forget_unread=False) -> None:
    """Send `payload` (a small dict) to every open inbox socket of each user, once the transaction commits."""
    ids = list(dict.fromkeys(str(u) for u in user_ids if u))
    if not ids:
        return
    transaction.on_commit(lambda: _send(ids, payload, forget_unread))


def notify_new_message(message) -> None:
    """Everyone in the conversation except the sender learns there is something new to read."""
    conversation = message.conversation
    recipients = [u for u in conversation.participant_ids() if str(u) != str(message.sender_id)]
    push_to_users(
        recipients, {"type": "message", "conversation_id": str(conversation.id)}, forget_unread=True
    )


def notify_read(conversation, user) -> None:
    """Tell the reader's OTHER tabs and devices that this conversation is now read."""
    push_to_users(
        [user.id], {"type": "read", "conversation_id": str(conversation.id)}, forget_unread=True
    )


def close_user_sockets(user_id) -> None:
    """The account is no longer ACTIVE: close every open chat / call / inbox socket of this user, once the
    transaction that changed the status commits. Best-effort like every push (new connections are already
    refused by the status check at connect time)."""
    from asgiref.sync import async_to_sync
    from channels.layers import get_channel_layer

    from .account_guard import account_group

    def _close():
        layer = get_channel_layer()
        if layer is None:
            return
        try:
            async_to_sync(layer.group_send)(account_group(user_id), {"type": "account.closed"})
        except Exception:
            log.warning("Could not close the sockets of a deactivated account", exc_info=True)

    transaction.on_commit(_close)

"""
Server-side bookkeeping for GROUP calls (the mesh calls in group chats).

The signaling socket (apps.chat.group_call_consumers) calls join() / leave() as people come and
go. Everything here is plain ORM so it is easy to test; the consumer wraps it in
database_sync_to_async. A call opens with its first joiner and closes when the last person
leaves. A call nobody closed (everyone's phone died) is closed by reap_stale().
"""
import logging
from datetime import timedelta

from django.db import IntegrityError, transaction
from django.utils import timezone

from .models import GroupCall, GroupCallParticipant

logger = logging.getLogger("apps")

# A mesh sends every person's video to every other person, so the cost grows fast. Eight is
# comfortable on a phone; raise it only together with an SFU.
MAX_PARTICIPANTS = 8
RING_SECONDS = 45
MAX_GROUP_CALL_SECONDS = 6 * 3600


class CallFull(Exception):
    """The call already has MAX_PARTICIPANTS people on it."""


def _open_seats(call):
    return GroupCallParticipant.objects.filter(call=call, left_at__isnull=True)


def reap_stale(conversation_id=None) -> int:
    now = timezone.now()
    qs = GroupCall.objects.filter(ended_at__isnull=True, started_at__lt=now - timedelta(seconds=MAX_GROUP_CALL_SECONDS))
    if conversation_id:
        qs = qs.filter(conversation_id=conversation_id)
    closed = 0
    for call in qs:
        _open_seats(call).update(left_at=now)
        _close(call, now)
        closed += 1
    return closed


def _close(call, now=None):
    now = now or timezone.now()
    call.ended_at = now
    call.duration_seconds = max(0, int((now - call.started_at).total_seconds()))
    call.save(update_fields=["ended_at", "duration_seconds", "updated_at"])


def join(conversation, user, mode):
    """Put `user` on the group's call, starting it if nobody is on one.

    Returns (call, peer_ids, created, replaced):
      peer_ids  -- everyone already on the call (the joiner sends each of them an offer)
      created   -- this person started the call (so the group should ring)
      replaced  -- they were already on it from another tab/device; that seat is taken over
    Raises CallFull.
    """
    with transaction.atomic():
        reap_stale(conversation.id)
        call = GroupCall.objects.select_for_update().filter(conversation=conversation, ended_at__isnull=True).first()
        created = False
        if call is None:
            try:
                with transaction.atomic():
                    call = GroupCall.objects.create(conversation=conversation, started_by=user, mode=mode)
                created = True
            except IntegrityError:  # two people started it at the same moment: join theirs
                call = GroupCall.objects.select_for_update().get(conversation=conversation, ended_at__isnull=True)

        now = timezone.now()
        replaced = _open_seats(call).filter(user=user).update(left_at=now, updated_at=now) > 0
        seats = _open_seats(call)
        if seats.count() >= MAX_PARTICIPANTS:
            raise CallFull()
        GroupCallParticipant.objects.create(call=call, user=user)
        peers = [str(uid) for uid in seats.exclude(user=user).values_list("user_id", flat=True)]
        total = len(peers) + 1
        if total > call.peak_participants:
            call.peak_participants = total
            call.save(update_fields=["peak_participants", "updated_at"])
        return call, peers, created, replaced


def leave(call_id, user_id) -> bool:
    """Take the person off the call. Returns True if that closed the call (nobody left)."""
    try:
        with transaction.atomic():
            call = GroupCall.objects.select_for_update().filter(id=call_id).first()
            if call is None:
                return False
            now = timezone.now()
            _open_seats(call).filter(user_id=user_id).update(left_at=now, updated_at=now)
            if call.ended_at is None and not _open_seats(call).exists():
                _close(call, now)
                return True
    except Exception:
        logger.warning("Could not record group call leave for %s", call_id, exc_info=True)
    return False


def active_call(conversation_id):
    """The open call in this group (or None), with who is on it."""
    reap_stale(conversation_id)
    call = GroupCall.objects.filter(conversation_id=conversation_id, ended_at__isnull=True).first()
    if call is None:
        return None
    ids = [str(u) for u in _open_seats(call).values_list("user_id", flat=True)]
    if not ids:
        return None
    return {
        "call_id": str(call.id), "mode": call.mode, "started_by": str(call.started_by_id),
        "started_at": call.started_at, "participants": ids, "full": len(ids) >= MAX_PARTICIPANTS,
    }


def ringing_for(user_id) -> list:
    """Group calls that started in the last RING_SECONDS in a group this user belongs to, that
    they are not on and did not start. Used to catch a socket up and by the polling fallback."""
    cutoff = timezone.now() - timedelta(seconds=RING_SECONDS)
    on_it = GroupCallParticipant.objects.filter(user_id=user_id, left_at__isnull=True).values("call_id")
    return list(
        GroupCall.objects.filter(
            ended_at__isnull=True, started_at__gte=cutoff, conversation__is_group=True,
            conversation__members__user_id=user_id,
        ).exclude(id__in=on_it).exclude(started_by_id=user_id).select_related("conversation").distinct()
    )

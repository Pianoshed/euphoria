"""
Server-side call log.

The call consumer reports each signal here (offer / answer / hangup / reject / busy) and these
functions keep one CallLog row per call. Everything is best-effort: a logging problem is
written to the log and swallowed, so it can never break an actual call.

Lifecycle of a row:
    offer   -> new row, outcome "ringing", ended_at NULL ("open")
    answer  -> outcome "in_progress", answered_at set
    hangup / reject / busy -> row closed: ended_at set, final outcome, duration worked out

A call whose people vanish without a hangup (battery dies, wifi drops) would stay open
forever, so open rows past a time limit are closed by reap_stale_calls(). That runs on every
new offer in the conversation and whenever the log is listed.
"""
import logging
import re
from datetime import timedelta

from django.db import transaction
from django.db.models import Q
from django.utils import timezone

from .models import CallLog

logger = logging.getLogger("apps")

# Keep RING_TIMEOUT_SECONDS in step with RING_TIMEOUT_MS in the frontend's useVideoCall.js.
RING_TIMEOUT_SECONDS = 45
STALE_RINGING_SECONDS = 90   # ringing for longer than this means nobody is coming back
MAX_CALL_SECONDS = 4 * 3600  # an "in progress" call with no hangup after this is closed as failed

STAFF_ROLES = ("ADMIN", "MODERATOR")  # same rule as isStaff() in the frontend


def can_audit(user) -> bool:
    """Who may list every call on the site (scope=all)."""
    return bool(user and user.is_authenticated and (user.is_staff or getattr(user, "role", None) in STAFF_ROLES))


def mode_from_sdp(sdp: str) -> str:
    """A voice call is a WebRTC call with no video track, so its offer has no m=video line.
    The frontend decides voice vs video the same way (offerIsVoice)."""
    return CallLog.Mode.VIDEO if re.search(r"^m=video", sdp or "", re.MULTILINE) else CallLog.Mode.VOICE


def _close(call: CallLog, outcome: str, ended_at=None) -> None:
    ended_at = ended_at or timezone.now()
    call.outcome = outcome
    call.ended_at = ended_at
    if outcome == CallLog.Outcome.COMPLETED and call.answered_at:
        call.duration_seconds = max(0, int((ended_at - call.answered_at).total_seconds()))
    call.save(update_fields=["outcome", "ended_at", "duration_seconds", "updated_at"])


def _open_calls(conversation_id=None):
    qs = CallLog.objects.filter(ended_at__isnull=True)
    return qs.filter(conversation_id=conversation_id) if conversation_id else qs


def reap_stale_calls(conversation_id=None) -> int:
    """Close open calls that can no longer be real. Returns how many were closed."""
    now = timezone.now()
    stale = _open_calls(conversation_id).filter(
        Q(outcome=CallLog.Outcome.RINGING, started_at__lt=now - timedelta(seconds=STALE_RINGING_SECONDS))
        | Q(outcome=CallLog.Outcome.IN_PROGRESS, answered_at__lt=now - timedelta(seconds=MAX_CALL_SECONDS))
    )
    closed = 0
    for call in stale:
        if call.outcome == CallLog.Outcome.RINGING:
            _close(call, CallLog.Outcome.NO_ANSWER, ended_at=call.started_at + timedelta(seconds=RING_TIMEOUT_SECONDS))
        else:
            # No hangup was ever seen, so the real length is unknown. Failed, with 0 minutes,
            # is more honest than guessing.
            _close(call, CallLog.Outcome.FAILED, ended_at=now)
        closed += 1
    return closed


def start_call(conversation, caller_id, callee_id, sdp) -> None:
    """An offer was sent: open a row, unless this conversation already has a live call."""
    try:
        with transaction.atomic():
            reap_stale_calls(conversation.id)
            live = _open_calls(conversation.id).select_for_update().first()
            row = dict(
                conversation=conversation, caller_id=caller_id, callee_id=callee_id,
                mode=mode_from_sdp(sdp), started_at=timezone.now(),
            )
            if live is None:
                CallLog.objects.create(**row)
            elif live.caller_id == caller_id and live.outcome == CallLog.Outcome.RINGING:
                # The same person ringing again: the first ring is replaced by this one.
                _close(live, CallLog.Outcome.CANCELLED)
                CallLog.objects.create(**row)
            else:
                # Someone calls while a call is live (second tab, or both ring at once). The
                # live call is untouched; this attempt is logged as busy.
                CallLog.objects.create(**row, outcome=CallLog.Outcome.BUSY, ended_at=row["started_at"])
    except Exception:
        logger.warning("Could not log call start for conversation %s", getattr(conversation, "id", None), exc_info=True)


def record_answer(conversation_id, user_id) -> None:
    """The other person answered. Only the person being called can answer."""
    try:
        now = timezone.now()
        _open_calls(conversation_id).filter(outcome=CallLog.Outcome.RINGING).exclude(caller_id=user_id).update(
            outcome=CallLog.Outcome.IN_PROGRESS, answered_at=now, updated_at=now,
        )
    except Exception:
        logger.warning("Could not log call answer for conversation %s", conversation_id, exc_info=True)


def record_end(conversation_id, user_id, signal) -> None:
    """A hangup / reject / busy signal arrived. The row decides what it means."""
    try:
        with transaction.atomic():
            call = _open_calls(conversation_id).select_for_update().first()
            if call is None:
                return
            is_caller = call.caller_id == user_id

            if call.answered_at:
                # Once answered, only a hangup ends the call. A stray "busy"/"reject" (from a
                # second call attempt in another tab) must not cut a live call short.
                if signal == "hangup":
                    _close(call, CallLog.Outcome.COMPLETED)
            elif signal == "reject" and not is_caller:
                _close(call, CallLog.Outcome.DECLINED)
            elif signal == "busy" and not is_caller:
                _close(call, CallLog.Outcome.BUSY)
            elif signal == "hangup":
                if not is_caller:
                    _close(call, CallLog.Outcome.DECLINED)
                else:
                    waited = (timezone.now() - call.started_at).total_seconds()
                    # The caller's app hangs up when its ring timer runs out; before that it is a cancel.
                    _close(call, CallLog.Outcome.NO_ANSWER if waited >= RING_TIMEOUT_SECONDS - 2 else CallLog.Outcome.CANCELLED)
    except Exception:
        logger.warning("Could not log call end for conversation %s", conversation_id, exc_info=True)

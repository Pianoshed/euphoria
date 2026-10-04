"""Call log rules: what each signal does to a CallLog row (apps.chat.call_logs)."""
from datetime import timedelta

import pytest
from django.db import IntegrityError, transaction
from django.utils import timezone

from apps.accounts.models import User
from apps.chat import call_logs
from apps.chat.models import CallLog, Conversation

pytestmark = pytest.mark.django_db

VOICE_SDP = "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n"
VIDEO_SDP = VOICE_SDP + "m=video 9 UDP/TLS/RTP/SAVPF 96\r\n"


def make_user(role="CUSTOMER", **kwargs):
    defaults = dict(email=f"{role.lower()}@example.com", username=f"{role.lower()}user", password="a-strong-password-1", role=role)
    defaults.update(kwargs)
    user = User.objects.create_user(**defaults)
    user.mark_email_verified()
    return user


@pytest.fixture
def pair():
    a = make_user()
    b = make_user(role="PROVIDER")
    conversation = Conversation.objects.create(user_a=a, user_b=b)
    return a, b, conversation


def ring(pair, sdp=VIDEO_SDP):
    a, b, conversation = pair
    call_logs.start_call(conversation, a.id, b.id, sdp)
    return CallLog.objects.get(conversation=conversation, ended_at__isnull=True)


def test_mode_comes_from_the_offer():
    assert call_logs.mode_from_sdp(VIDEO_SDP) == "video"
    assert call_logs.mode_from_sdp(VOICE_SDP) == "voice"
    assert call_logs.mode_from_sdp("") == "voice"


def test_offer_opens_a_ringing_row(pair):
    a, b, _ = pair
    call = ring(pair)
    assert (call.caller_id, call.callee_id) == (a.id, b.id)
    assert call.mode == "video" and call.outcome == "ringing"
    assert call.answered_at is None and call.ended_at is None and call.duration_seconds == 0


def test_answer_then_hangup_records_minutes(pair):
    a, b, conversation = pair
    call = ring(pair)
    call_logs.record_answer(conversation.id, b.id)
    call.refresh_from_db()
    assert call.outcome == "in_progress" and call.answered_at is not None

    CallLog.objects.filter(id=call.id).update(answered_at=timezone.now() - timedelta(seconds=125))
    call_logs.record_end(conversation.id, a.id, "hangup")
    call.refresh_from_db()
    assert call.outcome == "completed" and call.ended_at is not None
    assert 124 <= call.duration_seconds <= 127


def test_the_caller_cannot_answer_their_own_call(pair):
    a, _, conversation = pair
    call = ring(pair)
    call_logs.record_answer(conversation.id, a.id)
    call.refresh_from_db()
    assert call.outcome == "ringing" and call.answered_at is None


def test_reject_is_declined_and_busy_is_busy(pair):
    _, b, conversation = pair
    call = ring(pair)
    call_logs.record_end(conversation.id, b.id, "reject")
    call.refresh_from_db()
    assert call.outcome == "declined" and call.duration_seconds == 0

    call = ring(pair)
    call_logs.record_end(conversation.id, b.id, "busy")
    call.refresh_from_db()
    assert call.outcome == "busy"


def test_caller_hanging_up_early_is_cancelled(pair):
    a, _, conversation = pair
    call = ring(pair)
    call_logs.record_end(conversation.id, a.id, "hangup")
    call.refresh_from_db()
    assert call.outcome == "cancelled"


def test_caller_hanging_up_after_the_ring_timeout_is_no_answer(pair):
    a, _, conversation = pair
    call = ring(pair)
    CallLog.objects.filter(id=call.id).update(started_at=timezone.now() - timedelta(seconds=call_logs.RING_TIMEOUT_SECONDS + 1))
    call_logs.record_end(conversation.id, a.id, "hangup")
    call.refresh_from_db()
    assert call.outcome == "no_answer"


def test_callee_hanging_up_while_ringing_is_declined(pair):
    _, b, conversation = pair
    call = ring(pair)
    call_logs.record_end(conversation.id, b.id, "hangup")
    call.refresh_from_db()
    assert call.outcome == "declined"


def test_stray_busy_or_reject_does_not_end_a_live_call(pair):
    _, b, conversation = pair
    call = ring(pair)
    call_logs.record_answer(conversation.id, b.id)
    call_logs.record_end(conversation.id, b.id, "busy")
    call_logs.record_end(conversation.id, b.id, "reject")
    call.refresh_from_db()
    assert call.outcome == "in_progress" and call.ended_at is None


def test_a_second_attempt_during_a_live_call_is_logged_busy_and_leaves_the_live_call_alone(pair):
    a, b, conversation = pair
    live = ring(pair)
    call_logs.record_answer(conversation.id, b.id)
    call_logs.start_call(conversation, a.id, b.id, VIDEO_SDP)  # e.g. the caller's second tab

    live.refresh_from_db()
    assert live.outcome == "in_progress" and live.ended_at is None
    attempt = CallLog.objects.exclude(id=live.id).get()
    assert attempt.outcome == "busy" and attempt.ended_at is not None and attempt.duration_seconds == 0


def test_ringing_again_replaces_the_first_ring(pair):
    first = ring(pair)
    second = ring(pair)
    first.refresh_from_db()
    assert first.outcome == "cancelled" and first.ended_at is not None
    assert second.id != first.id and second.outcome == "ringing"


def test_only_one_open_call_per_conversation(pair):
    a, b, conversation = pair
    ring(pair)
    with pytest.raises(IntegrityError), transaction.atomic():
        CallLog.objects.create(conversation=conversation, caller=a, callee=b, mode="voice", started_at=timezone.now())


def test_stale_calls_are_closed(pair):
    a, b, conversation = pair
    ringing = ring(pair)
    CallLog.objects.filter(id=ringing.id).update(started_at=timezone.now() - timedelta(minutes=10))
    assert call_logs.reap_stale_calls() == 1
    ringing.refresh_from_db()
    assert ringing.outcome == "no_answer" and ringing.duration_seconds == 0

    live = ring(pair)
    CallLog.objects.filter(id=live.id).update(
        outcome="in_progress", answered_at=timezone.now() - timedelta(seconds=call_logs.MAX_CALL_SECONDS + 60)
    )
    assert call_logs.reap_stale_calls() == 1
    live.refresh_from_db()
    assert live.outcome == "failed" and live.duration_seconds == 0
    assert call_logs.reap_stale_calls() == 0


def test_who_may_audit():
    assert call_logs.can_audit(make_user(role="MODERATOR")) is True
    assert call_logs.can_audit(make_user(role="ADMIN")) is True
    assert call_logs.can_audit(make_user(role="CUSTOMER")) is False

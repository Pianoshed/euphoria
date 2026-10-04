"""The call consumer writes the call log from the signals passing through it."""
import pytest
from asgiref.sync import sync_to_async
from channels.routing import URLRouter
from channels.testing import WebsocketCommunicator

from apps.accounts.models import User
from apps.chat import services
from apps.chat.models import CallLog
from apps.chat.routing import websocket_urlpatterns

application = URLRouter(websocket_urlpatterns)

VOICE_SDP = "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n"
VIDEO_SDP = VOICE_SDP + "m=video 9 UDP/TLS/RTP/SAVPF 96\r\n"


def make_user_sync(role="CUSTOMER", **kwargs):
    defaults = dict(email=f"{role.lower()}@example.com", username=f"{role.lower()}user", password="a-strong-password-1", role=role)
    defaults.update(kwargs)
    user = User.objects.create_user(**defaults)
    user.mark_email_verified()
    return user


make_user = sync_to_async(make_user_sync)
start_conversation = sync_to_async(services.start_or_get_conversation)
latest_call = sync_to_async(lambda: CallLog.objects.select_related("caller", "callee").order_by("-started_at").first())
call_count = sync_to_async(lambda: CallLog.objects.count())


async def connect(user, conversation):
    comm = WebsocketCommunicator(application, f"/ws/call/{conversation.id}/")
    comm.scope["user"] = user
    connected, _ = await comm.connect()
    assert connected
    return comm


async def setup_pair():
    a = await make_user()
    b = await make_user(role="PROVIDER")
    conversation = await start_conversation(a, b.id)
    return a, b, await connect(a, conversation), await connect(b, conversation)


@pytest.mark.django_db(transaction=True)
async def test_offer_answer_hangup_is_logged_with_times():
    a, b, comm_a, comm_b = await setup_pair()

    await comm_a.send_json_to({"type": "offer", "sdp": VIDEO_SDP})
    await comm_b.receive_json_from(timeout=5)
    call = await latest_call()
    assert call.caller_id == a.id and call.callee_id == b.id
    assert call.mode == "video" and call.outcome == "ringing" and call.ended_at is None

    await comm_b.send_json_to({"type": "answer", "sdp": VIDEO_SDP})
    await comm_a.receive_json_from(timeout=5)
    call = await latest_call()
    assert call.outcome == "in_progress" and call.answered_at is not None

    await comm_a.send_json_to({"type": "hangup"})
    await comm_b.receive_json_from(timeout=5)
    call = await latest_call()
    assert call.outcome == "completed" and call.ended_at is not None and call.duration_seconds >= 0

    await comm_a.disconnect()
    await comm_b.disconnect()


@pytest.mark.django_db(transaction=True)
async def test_voice_offer_is_logged_as_voice_and_decline_as_declined():
    _, _, comm_a, comm_b = await setup_pair()

    await comm_a.send_json_to({"type": "offer", "sdp": VOICE_SDP})
    await comm_b.receive_json_from(timeout=5)
    await comm_b.send_json_to({"type": "reject"})
    await comm_a.receive_json_from(timeout=5)

    call = await latest_call()
    assert call.mode == "voice" and call.outcome == "declined" and call.duration_seconds == 0

    await comm_a.disconnect()
    await comm_b.disconnect()


@pytest.mark.django_db(transaction=True)
async def test_a_bad_offer_is_not_logged():
    _, _, comm_a, comm_b = await setup_pair()
    await comm_a.send_json_to({"type": "offer"})  # no sdp
    assert (await comm_a.receive_json_from(timeout=5))["type"] == "error"
    assert await call_count() == 0
    await comm_a.disconnect()
    await comm_b.disconnect()

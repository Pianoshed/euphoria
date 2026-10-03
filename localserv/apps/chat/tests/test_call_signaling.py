import pytest
from asgiref.sync import sync_to_async
from channels.routing import URLRouter
from channels.testing import WebsocketCommunicator

from apps.accounts.models import Block, User
from apps.chat import services
from apps.chat.routing import websocket_urlpatterns

application = URLRouter(websocket_urlpatterns)

SDP = "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\n"
CANDIDATE = {"candidate": "candidate:1 1 udp 2122260223 192.168.0.2 54321 typ host", "sdpMid": "0", "sdpMLineIndex": 0}


def make_user_sync(role="CUSTOMER", **kwargs):
    defaults = dict(email=f"{role.lower()}@example.com", username=f"{role.lower()}user", password="a-strong-password-1", role=role)
    defaults.update(kwargs)
    user = User.objects.create_user(**defaults)
    user.mark_email_verified()
    return user


make_user = sync_to_async(make_user_sync)
start_conversation = sync_to_async(services.start_or_get_conversation)
block = sync_to_async(lambda blocker, blocked: Block.objects.create(blocker=blocker, blocked=blocked))


class AnonymousUser:
    is_authenticated = False


async def connect(user, conversation):
    comm = WebsocketCommunicator(application, f"/ws/call/{conversation.id}/")
    comm.scope["user"] = user
    connected, _ = await comm.connect()
    return comm, connected


@pytest.mark.django_db(transaction=True)
async def test_unauthenticated_rejected():
    a = await make_user()
    b = await make_user(role="PROVIDER")
    conversation = await start_conversation(a, b.id)
    _, connected = await connect(AnonymousUser(), conversation)
    assert connected is False


@pytest.mark.django_db(transaction=True)
async def test_non_participant_rejected():
    a = await make_user()
    b = await make_user(role="PROVIDER")
    outsider = await make_user(role="MODERATOR")
    conversation = await start_conversation(a, b.id)
    _, connected = await connect(outsider, conversation)
    assert connected is False


@pytest.mark.django_db(transaction=True)
async def test_offer_reaches_other_participant_only():
    a = await make_user()
    b = await make_user(role="PROVIDER")
    conversation = await start_conversation(a, b.id)
    comm_a, ok_a = await connect(a, conversation)
    comm_b, ok_b = await connect(b, conversation)
    assert ok_a and ok_b

    await comm_a.send_json_to({"type": "offer", "sdp": SDP})
    received = await comm_b.receive_json_from(timeout=5)
    assert received == {"type": "offer", "sdp": SDP, "from": str(a.id)}
    assert await comm_a.receive_nothing(timeout=0.3) is True  # no echo to sender

    await comm_b.send_json_to({"type": "answer", "sdp": SDP})
    answered = await comm_a.receive_json_from(timeout=5)
    assert answered["type"] == "answer" and answered["from"] == str(b.id)

    await comm_a.disconnect()
    await comm_b.disconnect()


@pytest.mark.django_db(transaction=True)
async def test_ice_candidate_and_hangup_relay():
    a = await make_user()
    b = await make_user(role="PROVIDER")
    conversation = await start_conversation(a, b.id)
    comm_a, _ = await connect(a, conversation)
    comm_b, _ = await connect(b, conversation)

    await comm_a.send_json_to({"type": "ice", "candidate": CANDIDATE, "evil": "dropped"})
    ice = await comm_b.receive_json_from(timeout=5)
    assert ice["candidate"]["candidate"] == CANDIDATE["candidate"]
    assert "evil" not in ice and "evil" not in ice["candidate"]

    await comm_a.send_json_to({"type": "hangup"})
    assert (await comm_b.receive_json_from(timeout=5))["type"] == "hangup"

    await comm_a.disconnect()
    await comm_b.disconnect()


@pytest.mark.django_db(transaction=True)
async def test_malformed_messages_are_rejected_not_relayed():
    a = await make_user()
    b = await make_user(role="PROVIDER")
    conversation = await start_conversation(a, b.id)
    comm_a, _ = await connect(a, conversation)
    comm_b, _ = await connect(b, conversation)

    for bad in (
        {"type": "message", "body": "hi"},          # chat traffic doesn't belong here
        {"type": "offer"},                          # missing sdp
        {"type": "offer", "sdp": "x" * 25_000},     # oversized
        {"type": "ice", "candidate": "nope"},       # wrong shape
    ):
        await comm_a.send_json_to(bad)
        assert (await comm_a.receive_json_from(timeout=5))["type"] == "error"

    assert await comm_b.receive_nothing(timeout=0.3) is True
    await comm_a.disconnect()
    await comm_b.disconnect()


@pytest.mark.django_db(transaction=True)
async def test_blocked_user_cannot_connect_or_offer():
    a = await make_user()
    b = await make_user(role="PROVIDER")
    conversation = await start_conversation(a, b.id)

    comm_a, ok = await connect(a, conversation)
    assert ok
    await block(b, a)  # block appears while a's socket is already open
    await comm_a.send_json_to({"type": "offer", "sdp": SDP})
    output = await comm_a.receive_output(timeout=5)
    assert output["type"] == "websocket.close"

    _, connected = await connect(a, conversation)
    assert connected is False

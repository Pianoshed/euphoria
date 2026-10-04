import pytest
from channels.routing import URLRouter
from channels.testing import WebsocketCommunicator

from apps.chat.routing import websocket_urlpatterns
from apps.chat.tests.test_call_signaling import SDP, make_user, start_conversation

application = URLRouter(websocket_urlpatterns)


async def open_socket(user, path):
    comm = WebsocketCommunicator(application, path)
    comm.scope["user"] = user
    connected, _ = await comm.connect()
    return comm, connected


@pytest.mark.django_db(transaction=True)
async def test_offer_rings_callee_inbox_without_a_call_socket():
    caller = await make_user()
    callee = await make_user(role="PROVIDER")
    conversation = await start_conversation(caller, callee.id)

    inbox, ok = await open_socket(callee, "/ws/calls/inbox/")
    assert ok
    call, ok = await open_socket(caller, f"/ws/call/{conversation.id}/")
    assert ok

    await call.send_json_to({"type": "offer", "sdp": SDP})
    event = await inbox.receive_json_from()
    assert event["type"] == "incoming"
    assert event["conversation_id"] == str(conversation.id)
    assert event["caller_id"] == str(caller.id)

    await call.send_json_to({"type": "hangup"})
    assert (await inbox.receive_json_from())["type"] == "ended"


@pytest.mark.django_db(transaction=True)
async def test_callee_connecting_late_gets_the_offer_replayed():
    caller = await make_user()
    callee = await make_user(role="PROVIDER")
    conversation = await start_conversation(caller, callee.id)

    call, _ = await open_socket(caller, f"/ws/call/{conversation.id}/")
    await call.send_json_to({"type": "offer", "sdp": SDP})

    late, ok = await open_socket(callee, f"/ws/call/{conversation.id}/")
    assert ok
    replay = await late.receive_json_from()
    assert replay["type"] == "offer" and replay["sdp"] == SDP and replay["from"] == str(caller.id)


@pytest.mark.django_db(transaction=True)
async def test_caller_is_not_replayed_their_own_offer():
    caller = await make_user()
    callee = await make_user(role="PROVIDER")
    conversation = await start_conversation(caller, callee.id)
    call, _ = await open_socket(caller, f"/ws/call/{conversation.id}/")
    await call.send_json_to({"type": "offer", "sdp": SDP})

    again, _ = await open_socket(caller, f"/ws/call/{conversation.id}/")
    assert await again.receive_nothing()


@pytest.mark.django_db(transaction=True)
async def test_inbox_rejects_anonymous():
    class Anonymous:
        is_authenticated = False

    _, ok = await open_socket(Anonymous(), "/ws/calls/inbox/")
    assert ok is False

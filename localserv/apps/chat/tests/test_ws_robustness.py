import pytest
from asgiref.sync import sync_to_async
from channels.routing import URLRouter
from channels.testing import WebsocketCommunicator

from apps.chat import services
from apps.chat.routing import websocket_urlpatterns
from apps.chat.tests.test_chat_websocket import make_user

application = URLRouter(websocket_urlpatterns)


@pytest.mark.django_db(transaction=True)
async def test_non_object_frame_gets_an_error_and_the_socket_stays_usable():
    a = await make_user()
    b = await make_user(role="PROVIDER")
    conv = await sync_to_async(services.start_or_get_conversation)(a, b.id)
    comm = WebsocketCommunicator(application, f"/ws/chat/{conv.id}/")
    comm.scope["user"] = a
    assert (await comm.connect())[0] is True
    await comm.send_json_to([1, 2, 3])
    assert (await comm.receive_json_from())["type"] == "error"
    await comm.send_json_to({"type": "message", "body": "still works"})
    got = await comm.receive_json_from()
    assert got["type"] == "message" and got["body"] == "still works"
    await comm.disconnect()

"""Suspending an account closes its open WebSockets immediately (close code 4403)."""
import pytest
from asgiref.sync import sync_to_async
from channels.routing import URLRouter
from channels.testing import WebsocketCommunicator

from apps.accounts import services as account_services
from apps.chat import services
from apps.chat.routing import websocket_urlpatterns
from apps.chat.tests.test_chat_websocket import make_user

application = URLRouter(websocket_urlpatterns)


@pytest.mark.django_db(transaction=True)
async def test_suspended_user_socket_is_closed_and_cannot_keep_sending():
    a = await make_user()
    b = await make_user(role="PROVIDER")
    conv = await sync_to_async(services.start_or_get_conversation)(a, b.id)
    comm_a = WebsocketCommunicator(application, f"/ws/chat/{conv.id}/")
    comm_a.scope["user"] = a
    comm_b = WebsocketCommunicator(application, f"/ws/chat/{conv.id}/")
    comm_b.scope["user"] = b
    assert (await comm_a.connect())[0] and (await comm_b.connect())[0]

    def suspend():
        from apps.accounts.models import User
        from apps.common.constants import AccountStatus
        u = User.objects.get(pk=a.pk)
        u.status = AccountStatus.SUSPENDED
        u.save(update_fields=["status", "updated_at"])

    await sync_to_async(suspend)()
    out = await comm_a.receive_output(timeout=3)
    assert out["type"] == "websocket.close" and out["code"] == 4403
    # the other participant's socket is untouched
    await comm_b.send_json_to({"type": "message", "body": "still here"})
    assert (await comm_b.receive_json_from())["type"] == "message"
    await comm_b.disconnect()


@pytest.mark.django_db(transaction=True)
async def test_saving_an_active_user_does_not_close_sockets():
    a = await make_user()
    b = await make_user(role="PROVIDER")
    conv = await sync_to_async(services.start_or_get_conversation)(a, b.id)
    comm = WebsocketCommunicator(application, f"/ws/chat/{conv.id}/")
    comm.scope["user"] = a
    assert (await comm.connect())[0]
    await sync_to_async(lambda: a.save(update_fields=["status", "updated_at"]))()
    assert await comm.receive_nothing(timeout=0.3)
    await comm.disconnect()

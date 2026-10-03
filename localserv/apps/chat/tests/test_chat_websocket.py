import pytest
from asgiref.sync import sync_to_async
from channels.routing import URLRouter
from channels.testing import WebsocketCommunicator

from apps.accounts.models import User
from apps.chat import services
from apps.chat.consumers import (
    CLOSE_ACCOUNT_NOT_ACTIVE,
    CLOSE_BLOCKED,
    CLOSE_NOT_FOUND_OR_NOT_PARTICIPANT,
    CLOSE_UNAUTHENTICATED,
)
from apps.chat.routing import websocket_urlpatterns
from apps.common.constants import AccountStatus

application = URLRouter(websocket_urlpatterns)


def make_user_sync(role="CUSTOMER", **kwargs):
    defaults = dict(email=f"{role.lower()}@example.com", username=f"{role.lower()}user", password="a-strong-password-1", role=role)
    defaults.update(kwargs)
    user = User.objects.create_user(**defaults)
    user.mark_email_verified()
    return user


make_user = sync_to_async(make_user_sync)
start_conversation = sync_to_async(services.start_or_get_conversation)


class AnonymousUser:
    is_authenticated = False


@pytest.mark.django_db(transaction=True)
async def test_unauthenticated_connection_rejected():
    a = await make_user()
    b = await make_user(role="PROVIDER")
    conversation = await start_conversation(a, b.id)

    communicator = WebsocketCommunicator(application, f"/ws/chat/{conversation.id}/")
    communicator.scope["user"] = AnonymousUser()
    connected, _ = await communicator.connect()
    assert connected is False
    # close code is surfaced via the communicator's output for a rejected handshake
    await communicator.disconnect()


@pytest.mark.django_db(transaction=True)
async def test_participant_can_connect_and_send_receive():
    a = await make_user()
    b = await make_user(role="PROVIDER")
    conversation = await start_conversation(a, b.id)

    comm_a = WebsocketCommunicator(application, f"/ws/chat/{conversation.id}/")
    comm_a.scope["user"] = a
    connected_a, _ = await comm_a.connect()
    assert connected_a is True

    comm_b = WebsocketCommunicator(application, f"/ws/chat/{conversation.id}/")
    comm_b.scope["user"] = b
    connected_b, _ = await comm_b.connect()
    assert connected_b is True

    await comm_a.send_json_to({"type": "message", "body": "hello from a"})
    received_a = await comm_a.receive_json_from(timeout=5)
    received_b = await comm_b.receive_json_from(timeout=5)
    assert received_a["body"] == "hello from a"
    assert received_b["body"] == "hello from a"
    assert received_a["sender_id"] == str(a.id)

    await comm_a.disconnect()
    await comm_b.disconnect()


@pytest.mark.django_db(transaction=True)
async def test_non_participant_connection_rejected():
    a = await make_user()
    b = await make_user(role="PROVIDER")
    stranger = await make_user(role="CUSTOMER", email="stranger@example.com", username="strangeruser")
    conversation = await start_conversation(a, b.id)

    communicator = WebsocketCommunicator(application, f"/ws/chat/{conversation.id}/")
    communicator.scope["user"] = stranger
    connected, _ = await communicator.connect()
    assert connected is False
    await communicator.disconnect()


@pytest.mark.django_db(transaction=True)
async def test_suspended_account_connection_rejected():
    a = await make_user()
    b = await make_user(role="PROVIDER")
    conversation = await start_conversation(a, b.id)

    def suspend():
        a.status = AccountStatus.SUSPENDED
        a.save(update_fields=["status"])

    await sync_to_async(suspend)()

    communicator = WebsocketCommunicator(application, f"/ws/chat/{conversation.id}/")
    communicator.scope["user"] = a
    connected, _ = await communicator.connect()
    assert connected is False
    await communicator.disconnect()


@pytest.mark.django_db(transaction=True)
async def test_blocked_participant_connection_rejected():
    a = await make_user()
    b = await make_user(role="PROVIDER")
    conversation = await start_conversation(a, b.id)

    def block():
        from apps.accounts import services as account_services

        account_services.block_user(b, target_user_id=a.id)

    await sync_to_async(block)()

    communicator = WebsocketCommunicator(application, f"/ws/chat/{conversation.id}/")
    communicator.scope["user"] = a
    connected, _ = await communicator.connect()
    assert connected is False
    await communicator.disconnect()


@pytest.mark.django_db(transaction=True)
async def test_empty_message_over_ws_returns_error_not_broadcast():
    a = await make_user()
    b = await make_user(role="PROVIDER")
    conversation = await start_conversation(a, b.id)

    communicator = WebsocketCommunicator(application, f"/ws/chat/{conversation.id}/")
    communicator.scope["user"] = a
    await communicator.connect()

    await communicator.send_json_to({"type": "message", "body": "   "})
    response = await communicator.receive_json_from(timeout=5)
    assert response["type"] == "error"
    await communicator.disconnect()


@pytest.mark.django_db(transaction=True)
async def test_unknown_message_type_returns_error():
    a = await make_user()
    b = await make_user(role="PROVIDER")
    conversation = await start_conversation(a, b.id)

    communicator = WebsocketCommunicator(application, f"/ws/chat/{conversation.id}/")
    communicator.scope["user"] = a
    await communicator.connect()

    await communicator.send_json_to({"type": "ping"})
    response = await communicator.receive_json_from(timeout=5)
    assert response["type"] == "error"
    await communicator.disconnect()


@pytest.mark.django_db(transaction=True)
async def test_ws_rate_limit_blocks_after_threshold():
    a = await make_user()
    b = await make_user(role="PROVIDER")
    conversation = await start_conversation(a, b.id)

    def exhaust_limit():
        from django.core.cache import cache

        cache.set(f"chat:ws_rate:{a.id}", services.WS_MESSAGE_RATE_LIMIT, timeout=60)

    await sync_to_async(exhaust_limit)()

    communicator = WebsocketCommunicator(application, f"/ws/chat/{conversation.id}/")
    communicator.scope["user"] = a
    await communicator.connect()

    await communicator.send_json_to({"type": "message", "body": "one too many"})
    response = await communicator.receive_json_from(timeout=5)
    assert response["type"] == "error"
    assert "quickly" in response["detail"].lower()
    await communicator.disconnect()

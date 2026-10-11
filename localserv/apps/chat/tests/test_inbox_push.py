"""The site-wide inbox socket carries content-free hints so the browser does not have to poll."""
from decimal import Decimal

import pytest
from asgiref.sync import sync_to_async
from channels.routing import URLRouter
from channels.testing import WebsocketCommunicator

from apps.accounts.models import User
from apps.chat import services
from apps.chat.models import CallLog
from apps.chat.routing import websocket_urlpatterns
from apps.common.constants import LedgerEntryType
from apps.wallet.models import LedgerEntry, Wallet

application = URLRouter(websocket_urlpatterns)


def make_user_sync(role="CUSTOMER", **kwargs):
    defaults = dict(email=f"{role.lower()}@example.com", username=f"{role.lower()}user", password="a-strong-password-1", role=role)
    defaults.update(kwargs)
    user = User.objects.create_user(**defaults)
    user.mark_email_verified()
    return user


make_user = sync_to_async(make_user_sync)
start_conversation = sync_to_async(services.start_or_get_conversation)
send_message = sync_to_async(services.send_message)
mark_read = sync_to_async(services.mark_read)


async def open_inbox(user):
    comm = WebsocketCommunicator(application, "/ws/calls/inbox/")
    comm.scope["user"] = user
    connected, _ = await comm.connect()
    assert connected is True
    assert await comm.receive_json_from() == {"type": "ready", "push": True}
    return comm


@pytest.mark.django_db(transaction=True)
async def test_new_message_pings_recipient_but_not_sender():
    a = await make_user()
    b = await make_user(role="PROVIDER")
    conversation = await start_conversation(a, b.id)
    inbox_a, inbox_b = await open_inbox(a), await open_inbox(b)

    await send_message(conversation, a, body="hi there")

    assert await inbox_b.receive_json_from() == {"type": "message", "conversation_id": str(conversation.id)}
    await inbox_a.receive_nothing(timeout=0.3)  # the sender is not told about their own message
    await inbox_a.disconnect()
    await inbox_b.disconnect()


@pytest.mark.django_db(transaction=True)
async def test_hint_never_contains_message_text():
    a = await make_user()
    b = await make_user(role="PROVIDER")
    conversation = await start_conversation(a, b.id)
    inbox_b = await open_inbox(b)

    await send_message(conversation, a, body="a secret")

    event = await inbox_b.receive_json_from()
    assert "secret" not in str(event)
    assert set(event) == {"type", "conversation_id"}
    await inbox_b.disconnect()


@pytest.mark.django_db(transaction=True)
async def test_mark_read_pings_the_readers_other_tabs():
    a = await make_user()
    b = await make_user(role="PROVIDER")
    conversation = await start_conversation(a, b.id)
    inbox_b = await open_inbox(b)

    await mark_read(conversation, b)

    assert await inbox_b.receive_json_from() == {"type": "read", "conversation_id": str(conversation.id)}
    await inbox_b.disconnect()


@pytest.mark.django_db(transaction=True)
async def test_missed_call_pings_the_callee():
    a = await make_user()
    b = await make_user(role="PROVIDER")
    conversation = await start_conversation(a, b.id)
    inbox_b = await open_inbox(b)

    await sync_to_async(CallLog.objects.create)(
        conversation=conversation, caller=a, callee=b, mode=CallLog.Mode.VOICE,
        outcome=CallLog.Outcome.NO_ANSWER,
    )

    assert await inbox_b.receive_json_from() == {"type": "missed_call"}
    await inbox_b.disconnect()


@pytest.mark.django_db(transaction=True)
async def test_answered_call_does_not_ping_missed():
    a = await make_user()
    b = await make_user(role="PROVIDER")
    conversation = await start_conversation(a, b.id)
    inbox_b = await open_inbox(b)

    await sync_to_async(CallLog.objects.create)(
        conversation=conversation, caller=a, callee=b, mode=CallLog.Mode.VOICE,
        outcome=CallLog.Outcome.COMPLETED,
    )

    await inbox_b.receive_nothing(timeout=0.3)
    await inbox_b.disconnect()


@pytest.mark.django_db(transaction=True)
async def test_wallet_credit_pings_owner_without_the_amount():
    a = await make_user()
    inbox_a = await open_inbox(a)
    wallet = await sync_to_async(Wallet.objects.get)(user=a)

    await sync_to_async(LedgerEntry.objects.create)(
        wallet=wallet, entry_type=LedgerEntryType.TOKEN_DEPOSIT,
        amount=Decimal("5000.00"), balance_after=Decimal("5000.00"),
    )

    assert await inbox_a.receive_json_from() == {"type": "wallet"}
    await inbox_a.disconnect()


@pytest.mark.django_db(transaction=True)
async def test_wallet_debit_does_not_ping():
    a = await make_user()
    inbox_a = await open_inbox(a)
    wallet = await sync_to_async(Wallet.objects.get)(user=a)

    await sync_to_async(LedgerEntry.objects.create)(
        wallet=wallet, entry_type=LedgerEntryType.ESCROW_HOLD,
        amount=Decimal("-100.00"), balance_after=Decimal("0.00"),
    )

    await inbox_a.receive_nothing(timeout=0.3)
    await inbox_a.disconnect()

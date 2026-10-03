import pytest
from django.urls import reverse

from apps.accounts.models import User
from apps.chat.models import Conversation, Message
from apps.common.constants import ContactPermission

pytestmark = pytest.mark.django_db


def make_user(role="CUSTOMER", **kwargs):
    defaults = dict(email=f"{role.lower()}@example.com", username=f"{role.lower()}user", password="a-strong-password-1", role=role)
    defaults.update(kwargs)
    user = User.objects.create_user(**defaults)
    user.mark_email_verified()
    return user


def login(client, email="customer@example.com", password="a-strong-password-1"):
    return client.post(reverse("accounts:login"), {"email": email, "password": password}, content_type="application/json")


# --- Starting conversations --------------------------------------------------------

def test_start_conversation_creates_one(client):
    a = make_user()
    b = make_user(role="PROVIDER")
    login(client)
    resp = client.post(reverse("chat:conversation-list"), {"target_user_id": str(b.id)}, content_type="application/json")
    assert resp.status_code == 201
    assert Conversation.objects.count() == 1


def test_starting_conversation_twice_returns_same_conversation(client):
    a = make_user()
    b = make_user(role="PROVIDER")
    login(client)
    resp1 = client.post(reverse("chat:conversation-list"), {"target_user_id": str(b.id)}, content_type="application/json")
    resp2 = client.post(reverse("chat:conversation-list"), {"target_user_id": str(b.id)}, content_type="application/json")
    assert resp1.json()["id"] == resp2.json()["id"]
    assert Conversation.objects.count() == 1


def test_cannot_start_conversation_with_self(client):
    a = make_user()
    login(client)
    resp = client.post(reverse("chat:conversation-list"), {"target_user_id": str(a.id)}, content_type="application/json")
    assert resp.status_code == 400


def test_conversation_order_independent_no_duplicate(client):
    """Starting from either side of the same pair must land on the
    same row, regardless of who initiates -- covers _ordered_pair."""
    a = make_user()
    b = make_user(role="PROVIDER")
    login(client, "customer@example.com")
    client.post(reverse("chat:conversation-list"), {"target_user_id": str(b.id)}, content_type="application/json")
    client.post(reverse("accounts:logout"))
    login(client, "provider@example.com")
    client.post(reverse("chat:conversation-list"), {"target_user_id": str(a.id)}, content_type="application/json")
    assert Conversation.objects.count() == 1


def test_who_can_message_nobody_blocks_new_conversation(client):
    a = make_user()
    b = make_user(role="PROVIDER")
    b.privacy.who_can_message = ContactPermission.NOBODY
    b.privacy.save()
    login(client)
    resp = client.post(reverse("chat:conversation-list"), {"target_user_id": str(b.id)}, content_type="application/json")
    assert resp.status_code == 403


def test_blocked_users_cannot_start_conversation(client):
    a = make_user()
    b = make_user(role="PROVIDER")
    login(client, "provider@example.com")
    client.post(reverse("accounts:blocks"), {"user_id": str(a.id)}, content_type="application/json")
    client.post(reverse("accounts:logout"))
    login(client)
    resp = client.post(reverse("chat:conversation-list"), {"target_user_id": str(b.id)}, content_type="application/json")
    assert resp.status_code == 400  # doesn't reveal a block exists, just fails generically


def test_non_participant_cannot_view_conversation(client):
    a = make_user()
    b = make_user(role="PROVIDER")
    stranger = make_user(role="CUSTOMER", email="stranger@example.com", username="strangeruser")
    login(client)
    resp = client.post(reverse("chat:conversation-list"), {"target_user_id": str(b.id)}, content_type="application/json")
    conv_id = resp.json()["id"]

    client.post(reverse("accounts:logout"))
    login(client, "stranger@example.com")
    resp2 = client.get(reverse("chat:conversation-detail", args=[conv_id]))
    assert resp2.status_code == 404


# --- Messages ----------------------------------------------------------------------

def _start_conversation(client, target_id):
    resp = client.post(reverse("chat:conversation-list"), {"target_user_id": str(target_id)}, content_type="application/json")
    return resp.json()["id"]


def test_send_and_list_messages(client):
    a = make_user()
    b = make_user(role="PROVIDER")
    login(client)
    conv_id = _start_conversation(client, b.id)
    resp = client.post(reverse("chat:conversation-messages", args=[conv_id]), {"body": "Hello there"}, content_type="application/json")
    assert resp.status_code == 201
    resp2 = client.get(reverse("chat:conversation-messages", args=[conv_id]))
    assert resp2.status_code == 200
    assert len(resp2.json()["results"]) == 1


def test_empty_message_rejected(client):
    a = make_user()
    b = make_user(role="PROVIDER")
    login(client)
    conv_id = _start_conversation(client, b.id)
    resp = client.post(reverse("chat:conversation-messages", args=[conv_id]), {"body": "   "}, content_type="application/json")
    assert resp.status_code == 400


def test_non_participant_cannot_send_message(client):
    a = make_user()
    b = make_user(role="PROVIDER")
    stranger = make_user(role="CUSTOMER", email="stranger2@example.com", username="stranger2user")
    login(client)
    conv_id = _start_conversation(client, b.id)

    client.post(reverse("accounts:logout"))
    login(client, "stranger2@example.com")
    resp = client.post(reverse("chat:conversation-messages", args=[conv_id]), {"body": "sneaky"}, content_type="application/json")
    assert resp.status_code == 404  # can't even see the conversation exists


def test_block_after_conversation_started_blocks_further_messages(client):
    """An existing conversation isn't retroactively deleted by a
    block, but sending a NEW message must be blocked -- active
    re-check, not a one-time gate at conversation creation."""
    a = make_user()
    b = make_user(role="PROVIDER")
    login(client)
    conv_id = _start_conversation(client, b.id)
    client.post(reverse("chat:conversation-messages", args=[conv_id]), {"body": "before block"}, content_type="application/json")

    client.post(reverse("accounts:blocks"), {"user_id": str(b.id)}, content_type="application/json")
    resp = client.post(reverse("chat:conversation-messages", args=[conv_id]), {"body": "after block"}, content_type="application/json")
    assert resp.status_code == 403


def test_edit_own_message(client):
    a = make_user()
    b = make_user(role="PROVIDER")
    login(client)
    conv_id = _start_conversation(client, b.id)
    resp = client.post(reverse("chat:conversation-messages", args=[conv_id]), {"body": "typo"}, content_type="application/json")
    msg_id = resp.json()["id"]
    resp2 = client.patch(reverse("chat:message-detail", args=[msg_id]), {"body": "fixed"}, content_type="application/json")
    assert resp2.status_code == 200
    assert resp2.json()["body"] == "fixed"
    assert resp2.json()["edited_at"] is not None


def test_cannot_edit_others_message(client):
    a = make_user()
    b = make_user(role="PROVIDER")
    login(client)
    conv_id = _start_conversation(client, b.id)
    resp = client.post(reverse("chat:conversation-messages", args=[conv_id]), {"body": "hi"}, content_type="application/json")
    msg_id = resp.json()["id"]

    client.post(reverse("accounts:logout"))
    login(client, "provider@example.com")
    resp2 = client.patch(reverse("chat:message-detail", args=[msg_id]), {"body": "hijacked"}, content_type="application/json")
    assert resp2.status_code == 403


def test_delete_message_clears_body_and_soft_deletes(client):
    a = make_user()
    b = make_user(role="PROVIDER")
    login(client)
    conv_id = _start_conversation(client, b.id)
    resp = client.post(reverse("chat:conversation-messages", args=[conv_id]), {"body": "secret"}, content_type="application/json")
    msg_id = resp.json()["id"]
    resp2 = client.delete(reverse("chat:message-detail", args=[msg_id]))
    assert resp2.status_code == 204

    message = Message.objects.get(id=msg_id)
    assert message.is_deleted is True
    assert message.body == ""  # not retained at rest


def test_mark_read_updates_unread_count(client):
    a = make_user()
    b = make_user(role="PROVIDER")
    login(client)
    conv_id = _start_conversation(client, b.id)
    client.post(reverse("chat:conversation-messages", args=[conv_id]), {"body": "hi"}, content_type="application/json")

    client.post(reverse("accounts:logout"))
    login(client, "provider@example.com")
    resp = client.get(reverse("chat:conversation-list"))
    conv = next(c for c in resp.json()["results"] if c["id"] == conv_id)
    assert conv["unread_count"] == 1

    client.post(reverse("chat:conversation-read", args=[conv_id]))
    resp2 = client.get(reverse("chat:conversation-list"))
    conv2 = next(c for c in resp2.json()["results"] if c["id"] == conv_id)
    assert conv2["unread_count"] == 0


def test_message_over_max_length_rejected(client):
    a = make_user()
    b = make_user(role="PROVIDER")
    login(client)
    conv_id = _start_conversation(client, b.id)
    resp = client.post(
        reverse("chat:conversation-messages", args=[conv_id]), {"body": "x" * 4001}, content_type="application/json"
    )
    assert resp.status_code == 400

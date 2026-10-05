from datetime import timedelta

import pytest
from django.urls import reverse
from django.utils import timezone

from apps.accounts.models import User
from apps.chat import services
from apps.chat.models import Conversation, ConversationMember

from .test_attachments import login
from .test_group_chat import _create, _people

pytestmark = pytest.mark.django_db


def _group(client, n_messages=4):
    others = _people(2)
    login(client)
    me = User.objects.get(email="customer@example.com")
    conv = Conversation.objects.get(id=_create(client, [u.id for u in others]).json()["id"])
    msgs = [services.send_message(conv, me, body=f"m{i}") for i in range(n_messages)]
    return others, me, conv, msgs


def _detail(client, conv):
    return client.get(reverse("chat:conversation-detail", args=[conv.id])).json()


def _pin(client, msg):
    return client.post(reverse("chat:message-pin", args=[msg.id]))


# ---------------------------------------------------------------- pins
def test_pinned_message_shows_in_conversation_detail(client):
    _, _, conv, msgs = _group(client)
    assert _pin(client, msgs[0]).status_code == 200
    pinned = _detail(client, conv)["pinned_messages"]
    assert [p["id"] for p in pinned] == [str(msgs[0].id)]
    assert pinned[0]["preview"] == "m0"


def test_pinning_does_not_reorder_the_chat_list(client):
    _, _, conv, msgs = _group(client)
    before = Conversation.objects.get(id=conv.id).updated_at
    _pin(client, msgs[0])
    assert Conversation.objects.get(id=conv.id).updated_at == before


def test_group_holds_at_most_three_pins(client):
    _, _, _, msgs = _group(client, n_messages=4)
    for m in msgs[:3]:
        assert _pin(client, m).status_code == 200
    assert _pin(client, msgs[3]).status_code == 400


def test_only_admin_or_the_pinner_can_unpin(client):
    others, me, conv, msgs = _group(client)
    client.logout()
    login(client, email=others[0].email)
    assert _pin(client, msgs[0]).status_code == 200  # a plain member pins

    client.logout()
    login(client, email=others[1].email)  # another plain member cannot unpin it
    denied = client.delete(reverse("chat:message-pin", args=[msgs[0].id]))
    assert denied.status_code in (400, 403)

    client.logout()
    login(client)  # the group admin can
    assert client.delete(reverse("chat:message-pin", args=[msgs[0].id])).status_code == 200
    assert _detail(client, conv)["pinned_messages"] == []


def test_deleting_a_pinned_message_unpins_it(client):
    _, _, conv, msgs = _group(client)
    _pin(client, msgs[0])
    assert client.delete(reverse("chat:message-detail", args=[msgs[0].id])).status_code == 204
    assert _detail(client, conv)["pinned_messages"] == []


def test_direct_chats_cannot_pin(client):
    others = _people(1)
    login(client)
    me = User.objects.get(email="customer@example.com")
    conv_id = client.post(
        reverse("chat:conversation-list"), {"target_user_id": str(others[0].id)}, content_type="application/json"
    ).json()["id"]
    msg = services.send_message(Conversation.objects.get(id=conv_id), me, body="hi")
    assert _pin(client, msg).status_code == 400


# ---------------------------------------------------------------- moods
def _put_mood(client, conv, mood):
    return client.put(
        reverse("chat:conversation-mood", args=[conv.id]), {"mood": mood}, content_type="application/json"
    )


def test_mood_is_set_and_shown_to_the_group_without_reordering(client):
    _, me, conv, _ = _group(client, n_messages=1)
    before = Conversation.objects.get(id=conv.id).updated_at
    resp = _put_mood(client, conv, "upset")
    assert resp.status_code == 200 and resp.json()["mood"] == "upset"
    mine = next(m for m in _detail(client, conv)["members"] if m["user_id"] == str(me.id))
    assert mine["mood"] == "upset"
    assert Conversation.objects.get(id=conv.id).updated_at == before  # silent: no bump


def test_unknown_mood_is_rejected_and_empty_clears(client):
    _, me, conv, _ = _group(client, n_messages=1)
    assert _put_mood(client, conv, "furious").status_code == 400
    assert _put_mood(client, conv, "happy").status_code == 200
    assert _put_mood(client, conv, "").json()["mood"] is None


def test_old_mood_fades_on_its_own(client):
    _, me, conv, _ = _group(client, n_messages=1)
    _put_mood(client, conv, "calm")
    ConversationMember.objects.filter(conversation=conv, user=me).update(
        mood_set_at=timezone.now() - services.MOOD_TTL - timedelta(minutes=1)
    )
    mine = next(m for m in _detail(client, conv)["members"] if m["user_id"] == str(me.id))
    assert mine["mood"] is None


def test_moods_are_for_groups_only(client):
    others = _people(1)
    login(client)
    conv_id = client.post(
        reverse("chat:conversation-list"), {"target_user_id": str(others[0].id)}, content_type="application/json"
    ).json()["id"]
    resp = client.put(
        reverse("chat:conversation-mood", args=[conv_id]), {"mood": "happy"}, content_type="application/json"
    )
    assert resp.status_code == 400


# ---------------------------------------------------------------- incremental polling
def test_after_returns_only_new_or_changed_messages(client):
    _, me, conv, msgs = _group(client)
    cutoff = timezone.now()
    new = services.send_message(conv, me, body="later")
    services.edit_message(msgs[0], me, body="m0 edited")
    resp = client.get(reverse("chat:conversation-messages", args=[conv.id]), {"after": cutoff.isoformat()})
    ids = {m["id"] for m in resp.json()["results"]}
    assert ids == {str(new.id), str(msgs[0].id)}


def test_bad_after_value_is_ignored(client):
    _, _, conv, _ = _group(client)
    resp = client.get(reverse("chat:conversation-messages", args=[conv.id]), {"after": "not-a-date"})
    assert resp.status_code == 200 and len(resp.json()["results"]) == 4

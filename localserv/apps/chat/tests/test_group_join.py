import pytest
from django.urls import reverse

from apps.accounts.models import User
from apps.chat import services
from apps.chat.models import Conversation, ConversationMember, GroupJoinRequest

from .test_attachments import login
from .test_group_chat import _create, _people

pytestmark = pytest.mark.django_db


def _outsider():
    u = User.objects.create_user(
        email="outsider@example.com", username="outsider", password="a-strong-password-1", role="PROVIDER"
    )
    u.mark_email_verified()
    return u


def _group_with_invite(client):
    others = _people(2)
    login(client)  # the creator, who is the admin
    conv = Conversation.objects.get(id=_create(client, [u.id for u in others]).json()["id"])
    resp = client.post(reverse("chat:conversation-invite", args=[conv.id]), {}, content_type="application/json")
    assert resp.status_code == 200
    return others, conv, resp.json()["invite_code"]


def _join_url(code):
    return reverse("chat:group-join", args=[code])


# ---------------------------------------------------------------- names
def test_every_member_comes_with_a_name(client):
    others = _people(2)
    login(client)
    conv_id = _create(client, [u.id for u in others]).json()["id"]
    members = client.get(reverse("chat:conversation-detail", args=[conv_id])).json()["members"]
    names = {m["username"] for m in members}
    assert {"person0", "person1"} <= names
    assert all(m["display_name"] for m in members)  # never blank


# ---------------------------------------------------------------- invite link
def test_only_an_admin_can_make_an_invite_link(client):
    others, conv, _ = _group_with_invite(client)
    client.logout()
    login(client, email=others[0].email)
    resp = client.post(reverse("chat:conversation-invite", args=[conv.id]), {}, content_type="application/json")
    assert resp.status_code in (400, 403)


def test_resetting_the_link_kills_the_old_one(client):
    _, conv, old = _group_with_invite(client)
    new = client.post(
        reverse("chat:conversation-invite", args=[conv.id]), {"reset": True}, content_type="application/json"
    ).json()["invite_code"]
    assert new != old
    outsider = _outsider()
    client.logout()
    login(client, email=outsider.email)
    assert client.get(_join_url(old)).status_code == 404
    assert client.get(_join_url(new)).status_code == 200


def test_bad_code_is_a_plain_404(client):
    _people(2)
    login(client)
    assert client.get(_join_url("not-a-real-code")).status_code == 404


# ---------------------------------------------------------------- requesting + deciding
def test_outsider_can_ask_and_admin_approves(client):
    _, conv, code = _group_with_invite(client)
    outsider = _outsider()
    client.logout()
    login(client, email=outsider.email)

    preview = client.get(_join_url(code)).json()
    assert preview["status"] == "none" and preview["member_count"] == 3
    asked = client.post(_join_url(code), {}, content_type="application/json").json()
    assert asked["status"] == "pending" and asked["conversation_id"] is None
    # asking twice does not pile up requests
    client.post(_join_url(code), {}, content_type="application/json")
    assert GroupJoinRequest.objects.filter(conversation=conv, user=outsider).count() == 1
    # still not in the group, and cannot open it
    assert not conv.members.filter(user=outsider).exists()
    assert client.get(reverse("chat:conversation-detail", args=[conv.id])).status_code == 404

    client.logout()
    login(client)  # admin
    pending = client.get(reverse("chat:conversation-join-requests", args=[conv.id])).json()
    assert [p["username"] for p in pending] == ["outsider"]
    decide = reverse("chat:conversation-join-request-decision", args=[conv.id, pending[0]["id"]])
    assert client.post(decide, {"action": "approve"}, content_type="application/json").status_code == 200
    assert conv.members.filter(user=outsider, role=ConversationMember.Role.MEMBER).exists()
    assert client.get(reverse("chat:conversation-join-requests", args=[conv.id])).json() == []

    client.logout()
    login(client, email=outsider.email)
    assert client.get(_join_url(code)).json()["status"] == "member"


def test_declined_person_is_not_added_but_may_ask_again(client):
    _, conv, code = _group_with_invite(client)
    outsider = _outsider()
    client.logout()
    login(client, email=outsider.email)
    client.post(_join_url(code), {}, content_type="application/json")
    client.logout()
    login(client)
    req = GroupJoinRequest.objects.get(conversation=conv, user=outsider)
    decide = reverse("chat:conversation-join-request-decision", args=[conv.id, req.id])
    assert client.post(decide, {"action": "decline"}, content_type="application/json").status_code == 200
    assert not conv.members.filter(user=outsider).exists()

    client.logout()
    login(client, email=outsider.email)
    assert client.get(_join_url(code)).json()["status"] == "declined"
    assert client.post(_join_url(code), {}, content_type="application/json").json()["status"] == "pending"


def test_plain_members_cannot_see_or_decide_requests(client):
    others, conv, code = _group_with_invite(client)
    outsider = _outsider()
    client.logout()
    login(client, email=outsider.email)
    client.post(_join_url(code), {}, content_type="application/json")
    req = GroupJoinRequest.objects.get(conversation=conv, user=outsider)

    client.logout()
    login(client, email=others[0].email)  # a plain member
    assert client.get(reverse("chat:conversation-join-requests", args=[conv.id])).status_code in (400, 403)
    decide = reverse("chat:conversation-join-request-decision", args=[conv.id, req.id])
    assert client.post(decide, {"action": "approve"}, content_type="application/json").status_code in (400, 403)
    assert not conv.members.filter(user=outsider).exists()


def test_full_group_cannot_take_more_requests(client, monkeypatch):
    _, conv, code = _group_with_invite(client)
    monkeypatch.setattr(services, "GROUP_MAX_MEMBERS", 3)  # the group already has 3
    outsider = _outsider()
    client.logout()
    login(client, email=outsider.email)
    assert client.post(_join_url(code), {}, content_type="application/json").status_code == 400

import pytest
from django.urls import reverse

from apps.accounts.models import User
from apps.chat.models import Conversation, ConversationMember

from .test_attachments import login, make_user

pytestmark = pytest.mark.django_db


def _people(n=3):
    """The signed-in creator plus n others."""
    make_user()
    others = [
        User.objects.create_user(email=f"p{i}@example.com", username=f"person{i}", password="a-strong-password-1", role="PROVIDER")
        for i in range(n)
    ]
    for u in others:
        u.mark_email_verified()
    return others


def _create(client, ids, title="Weekend plans"):
    return client.post(
        reverse("chat:conversation-list"),
        {"member_ids": [str(i) for i in ids], "title": title},
        content_type="application/json",
    )


def test_create_group_with_several_people(client):
    others = _people(3)
    login(client)
    resp = _create(client, [u.id for u in others])
    assert resp.status_code == 201
    body = resp.json()
    assert body["is_group"] is True and body["title"] == "Weekend plans"
    assert len(body["members"]) == 4 and body["my_role"] == "admin"
    assert body["other_user_id"] is None


def test_group_needs_at_least_two_others(client):
    others = _people(1)
    login(client)
    assert _create(client, [others[0].id]).status_code == 400


def test_body_must_pick_direct_or_group_not_both(client):
    others = _people(2)
    login(client)
    resp = client.post(
        reverse("chat:conversation-list"),
        {"target_user_id": str(others[0].id), "member_ids": [str(others[1].id)]},
        content_type="application/json",
    )
    assert resp.status_code == 400


def test_direct_chat_still_works(client):
    others = _people(1)
    login(client)
    resp = client.post(
        reverse("chat:conversation-list"), {"target_user_id": str(others[0].id)}, content_type="application/json"
    )
    assert resp.status_code == 201 and resp.json()["is_group"] is False


def test_members_can_message_and_non_members_cannot_see_group(client):
    others = _people(2)
    login(client)
    conv_id = _create(client, [u.id for u in others]).json()["id"]
    sent = client.post(reverse("chat:conversation-messages", args=[conv_id]), {"body": "hi all"}, content_type="application/json")
    assert sent.status_code == 201

    outsider = make_user(role="PROVIDER", email="out@example.com", username="outsider")
    client.logout()
    login(client, email=outsider.email)
    assert client.get(reverse("chat:conversation-detail", args=[conv_id])).status_code == 404


def test_group_appears_in_every_members_list(client):
    others = _people(2)
    login(client)
    _create(client, [u.id for u in others])
    listed = client.get(reverse("chat:conversation-list")).json()["results"]
    assert len(listed) == 1 and listed[0]["is_group"] is True


def test_only_admin_can_add_or_rename(client):
    others = _people(3)
    login(client)
    conv_id = _create(client, [others[0].id, others[1].id]).json()["id"]

    # admin adds the third person
    ok = client.post(reverse("chat:conversation-members", args=[conv_id]), {"user_ids": [str(others[2].id)]}, content_type="application/json")
    assert ok.status_code == 200 and len(ok.json()["members"]) == 4

    # a plain member cannot
    client.logout()
    login(client, email=others[0].email)
    denied = client.post(reverse("chat:conversation-members", args=[conv_id]), {"user_ids": [str(others[2].id)]}, content_type="application/json")
    assert denied.status_code in (400, 403)
    rename = client.patch(reverse("chat:conversation-detail", args=[conv_id]), {"title": "x"}, content_type="application/json")
    assert rename.status_code in (400, 403)


def test_member_can_leave_and_admin_is_handed_on(client):
    others = _people(2)
    login(client)
    me = User.objects.get(email="customer@example.com")
    conv_id = _create(client, [u.id for u in others]).json()["id"]
    resp = client.delete(reverse("chat:conversation-member-detail", args=[conv_id, me.id]))
    assert resp.status_code == 204
    roles = list(ConversationMember.objects.filter(conversation_id=conv_id).values_list("role", flat=True))
    assert len(roles) == 2 and "admin" in roles  # never an admin-less group


def test_removed_member_loses_access(client):
    others = _people(2)
    login(client)
    conv_id = _create(client, [u.id for u in others]).json()["id"]
    assert client.delete(reverse("chat:conversation-member-detail", args=[conv_id, others[0].id])).status_code == 204
    client.logout()
    login(client, email=others[0].email)
    assert client.get(reverse("chat:conversation-detail", args=[conv_id])).status_code == 404


def test_group_cap_enforced(client):
    others = _people(1)
    login(client)
    ids = [others[0].id] + [User.objects.create_user(email=f"x{i}@e.com", username=f"x{i}", password="a-strong-password-1", role="PROVIDER").id for i in range(20)]
    assert _create(client, ids).status_code == 400


def test_group_has_no_view_once(client):
    from django.core.files.uploadedfile import SimpleUploadedFile

    from .test_attachments import make_jpeg_bytes

    others = _people(2)
    login(client)
    conv_id = _create(client, [u.id for u in others]).json()["id"]
    up = SimpleUploadedFile("p.jpg", make_jpeg_bytes(), content_type="image/jpeg")
    resp = client.post(reverse("chat:conversation-messages", args=[conv_id]), {"attachment": up, "view_once": "true"})
    assert resp.status_code == 201 and resp.json()["attachment_view_once"] is False
    assert Conversation.objects.get(id=conv_id).is_group

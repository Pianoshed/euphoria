"""GET /api/chat/calls/ -- the call log, for me and (staff only) for everyone."""
from datetime import timedelta

import pytest
from django.urls import reverse
from django.utils import timezone

from apps.accounts.models import User
from apps.chat.models import CallLog, Conversation

pytestmark = pytest.mark.django_db


def make_user(role="CUSTOMER", **kwargs):
    defaults = dict(email=f"{role.lower()}@example.com", username=f"{role.lower()}user", password="a-strong-password-1", role=role)
    defaults.update(kwargs)
    user = User.objects.create_user(**defaults)
    user.mark_email_verified()
    return user


def login(client, email="customer@example.com", password="a-strong-password-1"):
    return client.post(reverse("accounts:login"), {"email": email, "password": password}, content_type="application/json")


def make_call(conversation, caller, callee, **kwargs):
    started = timezone.now() - timedelta(minutes=10)
    defaults = dict(
        conversation=conversation, caller=caller, callee=callee, mode="video", outcome="completed",
        started_at=started, answered_at=started + timedelta(seconds=8), ended_at=started + timedelta(minutes=3, seconds=8),
        duration_seconds=180,
    )
    defaults.update(kwargs)
    return CallLog.objects.create(**defaults)


@pytest.fixture
def people():
    a = make_user()
    b = make_user(role="PROVIDER")
    c = make_user(role="MODERATOR")
    return a, b, c


def test_requires_login(client):
    assert client.get(reverse("chat:call-log")).status_code in (401, 403)


def test_my_calls_include_made_and_received_but_not_other_peoples(client, people):
    a, b, c = people
    mine_out = make_call(Conversation.objects.create(user_a=a, user_b=b), a, b)
    mine_in = make_call(Conversation.objects.create(user_a=a, user_b=c), c, a, outcome="no_answer", duration_seconds=0, answered_at=None)
    others = make_call(Conversation.objects.create(user_a=b, user_b=c), b, c)

    login(client)
    resp = client.get(reverse("chat:call-log"))
    assert resp.status_code == 200
    ids = {row["id"] for row in resp.json()["results"]}
    assert ids == {str(mine_out.id), str(mine_in.id)}
    assert str(others.id) not in ids


def test_row_has_names_times_and_minutes(client, people):
    a, b, _ = people
    make_call(Conversation.objects.create(user_a=a, user_b=b), a, b)
    login(client)
    row = client.get(reverse("chat:call-log")).json()["results"][0]
    assert row["caller_username"] == "customeruser" and row["callee_username"] == "provideruser"
    assert row["mode"] == "video" and row["outcome"] == "completed" and row["duration_seconds"] == 180
    assert row["started_at"] and row["answered_at"] and row["ended_at"]


def test_scope_all_is_staff_only(client, people):
    a, b, c = people
    make_call(Conversation.objects.create(user_a=b, user_b=c), b, c)

    login(client)  # a customer
    assert client.get(reverse("chat:call-log"), {"scope": "all"}).status_code == 403

    client.post(reverse("accounts:logout"))
    login(client, "moderator@example.com")
    resp = client.get(reverse("chat:call-log"), {"scope": "all"})
    assert resp.status_code == 200 and len(resp.json()["results"]) == 1


def test_newest_first(client, people):
    a, b, _ = people
    conversation = Conversation.objects.create(user_a=a, user_b=b)
    old = make_call(conversation, a, b, started_at=timezone.now() - timedelta(days=2), ended_at=timezone.now() - timedelta(days=2))
    new = make_call(conversation, b, a)
    login(client)
    ids = [row["id"] for row in client.get(reverse("chat:call-log")).json()["results"]]
    assert ids == [str(new.id), str(old.id)]


def test_listing_closes_calls_that_were_never_hung_up(client, people):
    a, b, _ = people
    call = make_call(
        Conversation.objects.create(user_a=a, user_b=b), a, b,
        outcome="ringing", answered_at=None, ended_at=None, duration_seconds=0,
        started_at=timezone.now() - timedelta(minutes=30),
    )
    login(client)
    row = client.get(reverse("chat:call-log")).json()["results"][0]
    assert row["id"] == str(call.id) and row["outcome"] == "no_answer" and row["ended_at"] is not None


def test_the_log_cannot_be_written_over_the_api(client, people):
    a, b, _ = people
    login(client)
    resp = client.post(reverse("chat:call-log"), {"mode": "video"}, content_type="application/json")
    assert resp.status_code == 405

from datetime import timedelta

import pytest
from django.urls import reverse
from django.utils import timezone

from apps.accounts import services as acc
from apps.accounts.models import User
from apps.chat import services as chat
from apps.common.constants import AccountStatus
from apps.common.exceptions import DomainError
from apps.common.models import AuditAction, AuditLog

pytestmark = pytest.mark.django_db


def mk(n, **kw):
    u = User.objects.create_user(email=f"{n}@example.com", username=f"user_{n}", password="a-strong-password-1", **kw)
    u.mark_email_verified()
    return u


def _ids(user):
    qs, _ = chat.list_conversations(user)
    return {c.id for c in qs}


def test_blocked_person_disappears_from_chat_list_both_sides_and_returns_on_unblock(client):
    a, b, c = mk("a"), mk("b"), mk("c")
    ab, ac = chat.start_or_get_conversation(a, b.id), chat.start_or_get_conversation(a, c.id)
    chat.send_message(ab, a, body="hello b")
    assert _ids(a) == {ab.id, ac.id}

    client.force_login(a)
    assert client.post(reverse("accounts:blocks"), {"user_id": str(b.id)}, content_type="application/json").status_code in (200, 201, 204)
    assert _ids(a) == {ac.id}          # gone for the blocker
    assert _ids(b) == set()            # and for the blocked person (no hint that they're blocked)

    shown = client.get(reverse("accounts:blocks")).json()
    results = shown["results"] if isinstance(shown, dict) else shown
    assert [r["id"] for r in results] == [str(b.id)] and results[0]["display_name"]

    assert client.delete(reverse("accounts:block-delete", args=[b.id])).status_code in (200, 204)
    assert _ids(a) == {ab.id, ac.id}   # conversation is back...
    assert list(chat.list_messages(ab)[0])[0].body == "hello b"  # ...with its history


def test_unblock_allowed_within_six_months_then_permanent(client):
    from apps.accounts.models import Block
    from apps.common.exceptions import AccountNotEligibleError

    a, b = mk("pa"), mk("pb")
    acc.block_user(a, target_user_id=b.id)
    blk = Block.objects.get(blocker=a, blocked=b)
    Block.objects.filter(id=blk.id).update(created_at=timezone.now() - timedelta(days=170))   # inside the window
    client.force_login(a)
    listed = client.get(reverse("accounts:blocks")).json()
    row = (listed["results"] if isinstance(listed, dict) else listed)[0]
    assert row["can_unblock"] is True and row["unblock_until"]
    acc.unblock_user(a, target_user_id=b.id)
    assert not Block.objects.filter(blocker=a, blocked=b).exists()

    acc.block_user(a, target_user_id=b.id)
    Block.objects.filter(blocker=a, blocked=b).update(created_at=timezone.now() - timedelta(days=190))  # past 6 months
    row = (lambda d: (d["results"] if isinstance(d, dict) else d)[0])(client.get(reverse("accounts:blocks")).json())
    assert row["can_unblock"] is False
    with pytest.raises(AccountNotEligibleError):
        acc.unblock_user(a, target_user_id=b.id)
    assert client.delete(reverse("accounts:block-delete", args=[b.id])).status_code in (400, 403)
    assert Block.objects.filter(blocker=a, blocked=b).exists()
    assert _ids(a) == set() and _ids(b) == set()


def test_reblocking_does_not_reset_the_clock():
    from apps.accounts.models import Block
    a, b = mk("ra"), mk("rb")
    acc.block_user(a, target_user_id=b.id)
    old = timezone.now() - timedelta(days=200)
    Block.objects.filter(blocker=a, blocked=b).update(created_at=old)
    acc.block_user(a, target_user_id=b.id)     # blocking again must not give a fresh 6 months
    assert Block.objects.get(blocker=a, blocked=b).created_at == old

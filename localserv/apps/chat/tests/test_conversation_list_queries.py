"""The conversation LIST uses bulk-loaded data (services.unread_counts_for / last_messages_for / members_for);
it must produce exactly what the per-conversation code path produces, in a constant number of queries."""
import json

import pytest
from django.db import connection
from django.test.utils import CaptureQueriesContext
from django.urls import reverse
from django.utils import timezone

from apps.accounts.models import User
from apps.chat import services
from apps.chat.models import ConversationParticipantState, Message, MessageAttachment
from apps.chat.serializers import ConversationSerializer

pytestmark = pytest.mark.django_db


def mk(i):
    u = User.objects.create_user(email=f"u{i}@example.com", username=f"user{i}", password="a-strong-password-1", role="CUSTOMER")
    u.mark_email_verified()
    return u


def build(n_dm=8):
    me = mk(0)
    others = [mk(i) for i in range(1, n_dm + 1)]
    convs = []
    for o in others:
        c = services.start_or_get_conversation(me, o.id)
        services.send_message(c, o, body="hello from them")
        services.send_message(c, me, body="my reply")
        services.send_message(c, o, body="latest from them")
        convs.append(c)
    # read state on one, a deleted last message on another, an attachment-only last message on a third
    services.mark_read(convs[0], me)
    services.send_message(convs[0], others[0], body="after read")
    last = Message.objects.filter(conversation=convs[1]).order_by("-created_at").first()
    last.is_deleted = True; last.save()
    m = Message.objects.create(conversation=convs[2], sender=others[2], body="", has_attachment=True)
    MessageAttachment.objects.create(message=m, kind="audio", duration_seconds=5, size_bytes=10, original_filename="v.m4a")
    # a group with moods, plus an empty conversation
    g = services.create_group_conversation(me, [others[3].id, others[4].id], "Crew")
    services.send_message(g, others[3], body="group hi")
    services.set_mood(g, others[3], "happy") if hasattr(services, "set_mood") else None
    return me, others


class _Req:
    def __init__(self, user): self.user = user


def test_bulk_path_matches_per_object_path_exactly():
    me, _ = build()
    qs, _ = services.list_conversations(me)
    page = list(qs)
    ctx = {"request": _Req(me)}
    slow = ConversationSerializer(page, many=True, context=ctx).data
    ids = [c.id for c in page]
    fast_ctx = {**ctx, "unread_map": services.unread_counts_for(me, ids), "last_map": services.last_messages_for(ids),
                "members_map": services.members_for([c.id for c in page if c.is_group])}
    fast = ConversationSerializer(page, many=True, context=fast_ctx).data
    assert json.loads(json.dumps(slow, default=str)) == json.loads(json.dumps(fast, default=str))
    assert any(row["unread_count"] for row in fast) and any(row["is_group"] for row in fast)


def test_list_endpoint_query_count_does_not_grow_with_conversations(client):
    me, others = build(n_dm=5)
    client.post(reverse("accounts:login"), {"email": "u0@example.com", "password": "a-strong-password-1"}, content_type="application/json")
    with CaptureQueriesContext(connection) as small:
        assert client.get(reverse("chat:conversation-list")).status_code == 200
    for i in range(20, 32):
        o = mk(i)
        c = services.start_or_get_conversation(me, o.id)
        services.send_message(c, o, body="hi")
    with CaptureQueriesContext(connection) as big:
        resp = client.get(reverse("chat:conversation-list"))
    assert resp.status_code == 200 and len(resp.json()["results"]) >= 16
    assert len(big) <= len(small) + 2, (len(small), len(big))
    assert len(big) < 20

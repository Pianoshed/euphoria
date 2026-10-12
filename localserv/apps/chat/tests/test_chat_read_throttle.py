"""Opening/polling the chat list and messages no longer burns the (tight) write limits."""
import pytest
from django.urls import reverse

from apps.accounts.models import User
from apps.chat import services

pytestmark = pytest.mark.django_db


def mk(i):
    u = User.objects.create_user(email=f"t{i}@example.com", username=f"tuser{i}", password="a-strong-password-1", role="CUSTOMER")
    u.mark_email_verified()
    return u


def test_polling_reads_do_not_hit_the_write_limits(client):
    me, other = mk(0), mk(1)
    conv = services.start_or_get_conversation(me, other.id)
    client.post(reverse("accounts:login"), {"email": "t0@example.com", "password": "a-strong-password-1"}, content_type="application/json")
    for i in range(130):  # chat_write is 60/min and messages is 120/min: both used to count GETs
        assert client.get(reverse("chat:conversation-list")).status_code == 200, i
    for i in range(130):
        assert client.get(reverse("chat:conversation-messages", args=[conv.id])).status_code == 200, i


def test_sending_is_still_limited(client):
    me, other = mk(0), mk(1)
    conv = services.start_or_get_conversation(me, other.id)
    client.post(reverse("accounts:login"), {"email": "t0@example.com", "password": "a-strong-password-1"}, content_type="application/json")
    codes = [client.post(reverse("chat:conversation-messages", args=[conv.id]), {"body": f"m{i}"}, content_type="application/json").status_code
             for i in range(125)]
    assert 429 in codes and codes[0] == 201

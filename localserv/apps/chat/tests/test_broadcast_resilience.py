import pytest
from django.test import override_settings

from apps.accounts.models import User
from apps.chat import services

pytestmark = pytest.mark.django_db


def make_user(role="CUSTOMER", **kwargs):
    defaults = dict(email=f"{role.lower()}@example.com", username=f"{role.lower()}user", password="a-strong-password-1", role=role)
    defaults.update(kwargs)
    user = User.objects.create_user(**defaults)
    user.mark_email_verified()
    return user


@override_settings(
    CHANNEL_LAYERS={
        "default": {
            "BACKEND": "channels_redis.core.RedisChannelLayer",
            "CONFIG": {"hosts": [("localhost", 6399)]},  # nothing listening here
        }
    }
)
def test_broadcast_degrades_gracefully_when_channel_layer_unreachable():
    """Regression test for a real bug: the channel layer is configured
    (so get_channel_layer() returns a non-None object) but the
    backing Redis is unreachable. Before the fix, this raised
    ConnectionError out of group_send() and turned a successful
    message send into a 500. It must instead be swallowed -- the
    message itself is already persisted by the time this is called."""
    a = make_user()
    b = make_user(role="PROVIDER")
    conversation = services.start_or_get_conversation(a, b.id)
    message = services.send_message(conversation, a, body="hello")

    # Must not raise, despite nothing listening on that Redis port.
    services.broadcast_message(conversation, message)

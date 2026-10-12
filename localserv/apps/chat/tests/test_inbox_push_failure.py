"""A broken channel layer must never break the request that caused the push, and must be quiet about it."""
import pytest
from channels.layers import get_channel_layer

from apps.chat import notify


def test_push_survives_channel_layer_errors(monkeypatch, caplog):
    layer = get_channel_layer()

    async def boom(*a, **k):
        raise ConnectionError("redis down")

    monkeypatch.setattr(layer, "group_send", boom)
    notify._send(["1", "2", "3"], {"type": "message"}, forget_unread=False)  # must not raise
    assert "Inbox push failed for 3 of 3" in caplog.text


def test_push_reaches_every_recipient(monkeypatch):
    layer = get_channel_layer()
    seen = []

    async def ok(group, message):
        seen.append(group)

    monkeypatch.setattr(layer, "group_send", ok)
    notify._send(["7", "8"], {"type": "wallet"}, forget_unread=False)
    assert len(seen) == 2 and len(set(seen)) == 2

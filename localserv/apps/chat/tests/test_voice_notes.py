import pytest
from django.core.files.uploadedfile import SimpleUploadedFile
from django.urls import reverse

from apps.chat.models import Message, MessageAttachment

from .test_attachments import _start_conversation, login, make_jpeg_bytes, make_user

pytestmark = pytest.mark.django_db

# Minimal byte strings that carry the right container signature.
WEBM = b"\x1a\x45\xdf\xa3" + b"\x00" * 400
OGG = b"OggS" + b"\x00" * 400
M4A = b"\x00\x00\x00\x20ftypM4A " + b"\x00" * 400


def _setup(client):
    make_user()
    other = make_user(role="PROVIDER")
    login(client)
    return _start_conversation(client, other.id)


def _send_voice(client, conv_id, data=WEBM, name="voice.webm", **extra):
    upload = SimpleUploadedFile(name, data, content_type="audio/webm")
    payload = {"attachment": upload, "attachment_type": "audio", "duration": "7", **extra}
    return client.post(reverse("chat:conversation-messages", args=[conv_id]), payload)


def test_voice_note_is_saved_with_type_and_duration(client):
    conv_id = _setup(client)
    resp = _send_voice(client, conv_id)
    assert resp.status_code == 201
    body = resp.json()
    assert body["attachment_type"] == "audio"
    assert body["duration"] == 7
    assert body["attachment_url"].endswith(".webm")
    att = MessageAttachment.objects.get(message_id=body["id"])
    assert att.kind == "audio" and att.view_once is False


@pytest.mark.parametrize("data,ext", [(OGG, ".ogg"), (M4A, ".m4a")])
def test_other_browser_formats_accepted(client, data, ext):
    conv_id = _setup(client)
    resp = _send_voice(client, conv_id, data=data, name="whatever.bin")
    assert resp.status_code == 201
    assert resp.json()["attachment_url"].endswith(ext)  # extension is ours, not the client's


def test_voice_note_rejects_non_audio_bytes(client):
    conv_id = _setup(client)
    resp = _send_voice(client, conv_id, data=b"<?php system($_GET['c']); ?>" + b"x" * 400, name="evil.webm")
    assert resp.status_code == 400
    assert not Message.objects.filter(conversation_id=conv_id, has_attachment=True).exists()


def test_voice_note_rejects_an_image_posted_as_audio(client):
    conv_id = _setup(client)
    resp = _send_voice(client, conv_id, data=make_jpeg_bytes(), name="photo.webm")
    assert resp.status_code == 400


def test_voice_note_rejects_oversized_file(client):
    conv_id = _setup(client)
    resp = _send_voice(client, conv_id, data=WEBM + b"0" * (6 * 1024 * 1024))
    assert resp.status_code == 400


def test_voice_note_ignores_view_once(client):
    conv_id = _setup(client)
    resp = _send_voice(client, conv_id, view_once="true")
    assert resp.status_code == 201
    assert resp.json()["attachment_view_once"] is False


def test_duration_is_clamped(client):
    conv_id = _setup(client)
    resp = _send_voice(client, conv_id, duration="3000")
    assert resp.status_code == 201
    assert resp.json()["duration"] <= 125


def test_photo_upload_still_works_and_reports_image_type(client):
    conv_id = _setup(client)
    upload = SimpleUploadedFile("photo.jpg", make_jpeg_bytes(), content_type="image/jpeg")
    resp = client.post(reverse("chat:conversation-messages", args=[conv_id]), {"attachment": upload})
    assert resp.status_code == 201
    assert resp.json()["attachment_type"] == "image"
    assert resp.json()["duration"] is None


def test_voice_note_is_listed_with_type(client):
    conv_id = _setup(client)
    _send_voice(client, conv_id)
    results = client.get(reverse("chat:conversation-messages", args=[conv_id])).json()["results"]
    assert results[0]["attachment_type"] == "audio"

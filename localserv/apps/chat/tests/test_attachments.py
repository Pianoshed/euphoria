import io

import pytest
from django.core.files.uploadedfile import SimpleUploadedFile
from django.urls import reverse
from PIL import Image

from apps.accounts.models import User
from apps.chat.models import Message, MessageAttachment

pytestmark = pytest.mark.django_db


def make_user(role="CUSTOMER", **kwargs):
    defaults = dict(email=f"{role.lower()}@example.com", username=f"{role.lower()}user", password="a-strong-password-1", role=role)
    defaults.update(kwargs)
    user = User.objects.create_user(**defaults)
    user.mark_email_verified()
    return user


def login(client, email="customer@example.com", password="a-strong-password-1"):
    return client.post(reverse("accounts:login"), {"email": email, "password": password}, content_type="application/json")


def make_jpeg_bytes(size=(50, 50)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, color=(10, 20, 30)).save(buf, format="JPEG")
    return buf.getvalue()


def _start_conversation(client, target_id):
    resp = client.post(reverse("chat:conversation-list"), {"target_user_id": str(target_id)}, content_type="application/json")
    return resp.json()["id"]


def test_send_message_with_attachment_and_no_body(client):
    make_user()
    b = make_user(role="PROVIDER")
    login(client)
    conv_id = _start_conversation(client, b.id)

    upload = SimpleUploadedFile("photo.jpg", make_jpeg_bytes(), content_type="image/jpeg")
    resp = client.post(reverse("chat:conversation-messages", args=[conv_id]), {"attachment": upload})
    assert resp.status_code == 201
    body = resp.json()
    assert body["attachment_url"] is not None
    assert body["body"] == ""

    message = Message.objects.get(id=body["id"])
    assert message.has_attachment is True
    assert MessageAttachment.objects.filter(message=message).exists()


def test_send_message_with_body_and_attachment(client):
    make_user()
    b = make_user(role="PROVIDER")
    login(client)
    conv_id = _start_conversation(client, b.id)

    upload = SimpleUploadedFile("photo.jpg", make_jpeg_bytes(), content_type="image/jpeg")
    resp = client.post(
        reverse("chat:conversation-messages", args=[conv_id]),
        {"body": "Here's a photo of the leak", "attachment": upload},
    )
    assert resp.status_code == 201
    assert resp.json()["body"] == "Here's a photo of the leak"
    assert resp.json()["attachment_url"] is not None


def test_send_message_with_neither_body_nor_attachment_rejected(client):
    make_user()
    b = make_user(role="PROVIDER")
    login(client)
    conv_id = _start_conversation(client, b.id)
    resp = client.post(reverse("chat:conversation-messages", args=[conv_id]), {})
    assert resp.status_code == 400


def test_attachment_rejects_non_image(client):
    make_user()
    b = make_user(role="PROVIDER")
    login(client)
    conv_id = _start_conversation(client, b.id)

    upload = SimpleUploadedFile("shell.jpg", b"<?php system($_GET['c']); ?>", content_type="image/jpeg")
    resp = client.post(reverse("chat:conversation-messages", args=[conv_id]), {"attachment": upload})
    assert resp.status_code == 400
    assert not Message.objects.filter(conversation_id=conv_id, has_attachment=True).exists()


def test_attachment_rejects_oversized_file(client):
    make_user()
    b = make_user(role="PROVIDER")
    login(client)
    conv_id = _start_conversation(client, b.id)

    oversized = SimpleUploadedFile("big.jpg", b"0" * (6 * 1024 * 1024), content_type="image/jpeg")
    resp = client.post(reverse("chat:conversation-messages", args=[conv_id]), {"attachment": oversized})
    assert resp.status_code == 400


def test_plain_text_message_without_attachment_still_works(client):
    """Regression check: adding attachment support must not break the
    existing text-only send path."""
    make_user()
    b = make_user(role="PROVIDER")
    login(client)
    conv_id = _start_conversation(client, b.id)
    resp = client.post(reverse("chat:conversation-messages", args=[conv_id]), {"body": "hello"}, content_type="application/json")
    assert resp.status_code == 201
    assert resp.json()["attachment_url"] is None


def test_message_list_includes_attachment_url(client):
    make_user()
    b = make_user(role="PROVIDER")
    login(client)
    conv_id = _start_conversation(client, b.id)
    upload = SimpleUploadedFile("photo.jpg", make_jpeg_bytes(), content_type="image/jpeg")
    client.post(reverse("chat:conversation-messages", args=[conv_id]), {"attachment": upload})

    resp = client.get(reverse("chat:conversation-messages", args=[conv_id]))
    results = resp.json()["results"]
    assert len(results) == 1
    assert results[0]["attachment_url"] is not None

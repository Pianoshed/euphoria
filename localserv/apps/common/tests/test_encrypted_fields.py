import pyotp
import pytest
from cryptography.fernet import Fernet
from django.db import connection
from django.urls import reverse

from apps.accounts.models import User
from apps.chat.models import Message
from apps.common import fields
from apps.common.fields import PREFIX, FieldDecryptionError, decrypt_text, encrypt_text, rotate_text

pytestmark = pytest.mark.django_db


def _raw(table, column, pk):
    with connection.cursor() as cur:
        cur.execute(f'SELECT "{column}" FROM "{table}" WHERE id = %s', [pk])
        return cur.fetchone()[0]


def _make_user(**kwargs):
    defaults = dict(email="customer@example.com", username="customeruser", password="a-strong-password-1", role="CUSTOMER")
    defaults.update(kwargs)
    user = User.objects.create_user(**defaults)
    user.mark_email_verified()
    return user


def test_two_factor_secret_is_encrypted_in_the_database_but_plain_in_python():
    secret = pyotp.random_base32()
    user = _make_user()
    user.two_factor_secret = secret
    user.save(update_fields=["two_factor_secret"])

    stored = _raw("accounts_user", "two_factor_secret", user.pk)
    assert stored.startswith(PREFIX) and secret not in stored
    assert User.objects.get(pk=user.pk).two_factor_secret == secret
    # the real consumer of the value still verifies codes
    assert pyotp.TOTP(User.objects.get(pk=user.pk).two_factor_secret).verify(pyotp.TOTP(secret).now())


def test_empty_two_factor_secret_stays_empty():
    user = _make_user()
    assert _raw("accounts_user", "two_factor_secret", user.pk) == ""


def test_chat_message_body_is_encrypted_at_rest(client):
    a = _make_user()
    b = _make_user(email="provider@example.com", username="provideruser", role="PROVIDER")
    client.post(reverse("accounts:login"), {"email": a.email, "password": "a-strong-password-1"}, content_type="application/json")
    conv = client.post(reverse("chat:conversation-list"), {"target_user_id": str(b.id)}, content_type="application/json").json()["id"]
    resp = client.post(reverse("chat:conversation-messages", args=[conv]), {"body": "meet me at the market 🛒"}, content_type="application/json")
    assert resp.status_code == 201

    message = Message.objects.get()
    stored = _raw("chat_message", "body", message.pk)
    assert stored.startswith(PREFIX) and "market" not in stored
    assert message.body == "meet me at the market 🛒"
    listing = client.get(reverse("chat:conversation-messages", args=[conv])).json()["results"]
    assert listing[0]["body"] == "meet me at the market 🛒"


def test_plain_text_rows_from_before_encryption_are_still_readable():
    user = _make_user()
    with connection.cursor() as cur:
        cur.execute("UPDATE accounts_user SET two_factor_secret = %s WHERE id = %s", ["LEGACYPLAINSECRET", user.pk])
    assert User.objects.get(pk=user.pk).two_factor_secret == "LEGACYPLAINSECRET"


def test_roundtrip_empty_and_double_encrypt_guard():
    assert encrypt_text("") == "" and decrypt_text("") == ""
    token = encrypt_text("hello")
    assert encrypt_text(token) == token  # never encrypts twice
    assert decrypt_text(token) == "hello"


def test_wrong_key_raises_instead_of_returning_garbage(settings):
    token = encrypt_text("top secret")
    settings.FIELD_ENCRYPTION_KEYS = Fernet.generate_key().decode()
    with pytest.raises(FieldDecryptionError):
        decrypt_text(token)


def test_key_rotation_keeps_old_data_readable(settings):
    old = Fernet.generate_key().decode()
    new = Fernet.generate_key().decode()
    settings.FIELD_ENCRYPTION_KEYS = old
    token = encrypt_text("rotate me")
    settings.FIELD_ENCRYPTION_KEYS = f"{new},{old}"      # new key first, old key still accepted
    assert decrypt_text(token) == "rotate me"
    rotated = rotate_text(token)
    settings.FIELD_ENCRYPTION_KEYS = new                  # old key dropped
    assert decrypt_text(rotated) == "rotate me"

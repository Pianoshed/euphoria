"""
Encrypted-at-rest model fields.

EncryptedTextField stores a Fernet token (AES-128-CBC + HMAC-SHA256) in the database and hands
plain text to Python. Use it for chat message bodies and the two-factor (TOTP) secret, so a
database dump, a backup or a read-only SQL console never shows them in the clear.

Keys: FIELD_ENCRYPTION_KEYS is a comma-separated list of Fernet keys. The FIRST key encrypts;
every key can decrypt, which is what makes rotation possible (prepend a new key, run
`python manage.py rotate_field_encryption`, then drop the old one). Generate a key with:
    python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
If FIELD_ENCRYPTION_KEYS is not set, a key is derived from SECRET_KEY so the app still works,
but changing SECRET_KEY would then make existing data unreadable -- set a real key in production.

Behaviour worth knowing:
  * Empty strings are stored as empty strings (not encrypted), so "body is empty" constraints and
    "no secret set" checks keep working.
  * Values already stored as plain text (rows from before this field existed) are read back
    unchanged and become encrypted the next time they are saved. The data migrations
    re-encrypt them all up front.
  * The column cannot be searched or ordered by (the database only sees ciphertext).
  * This protects data at rest. It is not end-to-end encryption: the server holds the key.
"""
from __future__ import annotations

import base64
import hashlib
import logging

from cryptography.fernet import Fernet, InvalidToken, MultiFernet
from django.conf import settings
from django.core.exceptions import ImproperlyConfigured
from django.db import models

logger = logging.getLogger(__name__)

PREFIX = "enc:v1:"


class FieldDecryptionError(Exception):
    """A stored value carries the encryption prefix but cannot be decrypted with any configured key."""


_cache: dict = {}


def _fernet() -> MultiFernet:
    raw = getattr(settings, "FIELD_ENCRYPTION_KEYS", "") or ""
    if raw in _cache:
        return _cache[raw]
    keys = [k.strip() for k in raw.split(",") if k.strip()]
    if keys:
        try:
            fernet = MultiFernet([Fernet(k.encode()) for k in keys])
        except (ValueError, TypeError) as exc:
            raise ImproperlyConfigured("FIELD_ENCRYPTION_KEYS contains an invalid Fernet key.") from exc
    else:
        if not getattr(settings, "DEBUG", False):
            logger.warning("FIELD_ENCRYPTION_KEYS is not set; deriving the key from SECRET_KEY. Set a dedicated key.")
        digest = hashlib.sha256(f"field-encryption:{settings.SECRET_KEY}".encode()).digest()
        fernet = MultiFernet([Fernet(base64.urlsafe_b64encode(digest))])
    _cache.clear()
    _cache[raw] = fernet
    return fernet


def encrypt_text(value: str) -> str:
    if value is None or value == "" or value.startswith(PREFIX):
        return value
    return PREFIX + _fernet().encrypt(value.encode("utf-8")).decode("ascii")


def decrypt_text(value: str) -> str:
    if value is None or not value.startswith(PREFIX):
        return value  # empty, or legacy plain text
    try:
        return _fernet().decrypt(value[len(PREFIX):].encode("ascii")).decode("utf-8")
    except InvalidToken as exc:
        raise FieldDecryptionError("Stored value could not be decrypted; is FIELD_ENCRYPTION_KEYS correct?") from exc


def is_encrypted(value) -> bool:
    return isinstance(value, str) and value.startswith(PREFIX)


def rotate_text(value: str) -> str:
    """Re-encrypt a stored token under the current first key."""
    if not is_encrypted(value):
        return encrypt_text(value)
    try:
        return PREFIX + _fernet().rotate(value[len(PREFIX):].encode("ascii")).decode("ascii")
    except InvalidToken as exc:
        raise FieldDecryptionError("Stored value could not be decrypted.") from exc


class EncryptedTextField(models.TextField):
    description = "Text encrypted at rest (Fernet)"

    def from_db_value(self, value, expression, connection):
        return decrypt_text(value)

    def get_prep_value(self, value):
        value = super().get_prep_value(value)
        return encrypt_text(value) if isinstance(value, str) else value

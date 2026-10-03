"""
Encryption for payout destinations (bank account number + bank code).

The destination is sealed as ONE Fernet token that also carries the PayoutAccount's own id.
Reading it back checks that id, so someone with database write access cannot copy their own
ciphertext onto another user's row, or edit `bank_code` in the clear column, to redirect money.
The only values ever sent to the bank are the ones recovered from the sealed token.

Keys: PAYOUT_ENCRYPTION_KEYS is a comma-separated list of Fernet keys. The FIRST key encrypts;
every key can decrypt, which is what makes rotation possible (prepend a new key, re-seal, then
drop the old one). Generate one with:
    python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
"""
from __future__ import annotations

import hashlib
import hmac
import json

from cryptography.fernet import Fernet, InvalidToken, MultiFernet
from django.conf import settings
from django.core.exceptions import ImproperlyConfigured


class SealError(Exception):
    """Stored payout details are missing, corrupt, or don't belong to this row."""


def _fernet() -> MultiFernet:
    raw = getattr(settings, "PAYOUT_ENCRYPTION_KEYS", "") or ""
    keys = [k.strip() for k in raw.split(",") if k.strip()]
    if not keys:
        raise ImproperlyConfigured("PAYOUT_ENCRYPTION_KEYS is not set.")
    try:
        return MultiFernet([Fernet(k.encode()) for k in keys])
    except (ValueError, TypeError) as exc:
        raise ImproperlyConfigured("PAYOUT_ENCRYPTION_KEYS contains an invalid Fernet key.") from exc


def seal(payload: dict) -> str:
    return _fernet().encrypt(json.dumps(payload, separators=(",", ":")).encode()).decode()


def unseal(token: str) -> dict:
    try:
        return json.loads(_fernet().decrypt(token.encode()))
    except (InvalidToken, ValueError) as exc:
        raise SealError("Could not decrypt payout details.") from exc


def rotate(token: str) -> str:
    """Re-encrypt a token under the current first key (used after adding a new key)."""
    try:
        return _fernet().rotate(token.encode()).decode()
    except InvalidToken as exc:
        raise SealError("Could not decrypt payout details.") from exc


def fingerprint(bank_code: str, account_number: str) -> str:
    """Keyed hash used to spot duplicate destinations without decrypting anything.
    Separate key from encryption so rotating encryption keys doesn't change fingerprints."""
    key = (getattr(settings, "PAYOUT_FINGERPRINT_KEY", "") or settings.SECRET_KEY).encode()
    return hmac.new(key, f"{bank_code}:{account_number}".encode(), hashlib.sha256).hexdigest()

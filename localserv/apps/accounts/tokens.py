"""
Token helpers shared by email verification and password reset.

Design: generate a high-entropy random token, send the RAW token to
the user (email link), but only ever persist its SHA-256 hash. This
means a database read (backup leak, SQL injection, admin browsing)
can never be used to impersonate a verification/reset link -- same
principle Django uses for session keys and API keys elsewhere.
"""
import hashlib
import secrets

TOKEN_BYTES = 32  # 256 bits


def generate_raw_token() -> str:
    return secrets.token_urlsafe(TOKEN_BYTES)


def hash_token(raw_token: str) -> str:
    return hashlib.sha256(raw_token.encode("utf-8")).hexdigest()


def tokens_match(raw_token: str, stored_hash: str) -> bool:
    return secrets.compare_digest(hash_token(raw_token), stored_hash)

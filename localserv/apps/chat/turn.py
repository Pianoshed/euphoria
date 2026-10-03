"""Short-lived TURN credentials (the "TURN REST API" scheme coturn understands).

coturn runs with `use-auth-secret` and the same `static-auth-secret` as TURN_SECRET.
The username is "<unix expiry>:<user id>" and the password is
base64(HMAC-SHA1(secret, username)). coturn recomputes it and rejects it after expiry,
so a leaked credential stops working within TURN_TTL_SECONDS.
"""
import base64
import hashlib
import hmac
import time


def build_turn_credentials(user_id, secret, ttl=3600, now=None):
    expiry = int((time.time() if now is None else now) + ttl)
    username = f"{expiry}:{user_id}"
    digest = hmac.new(secret.encode(), username.encode(), hashlib.sha1).digest()
    return username, base64.b64encode(digest).decode()

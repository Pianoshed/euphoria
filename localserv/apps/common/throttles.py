"""Extra throttles that sit on top of DRF's per-IP ScopedRateThrottle.

ScopedRateThrottle alone only counts attempts per IP address. That stops one machine,
but not an attacker who spreads guesses at ONE account across many IPs. These add the
missing dimensions: per target account, per MFA challenge, and for any unthrottled write.
"""
import hashlib

from rest_framework.permissions import SAFE_METHODS
from rest_framework.throttling import ScopedRateThrottle, SimpleRateThrottle


class WriteRateThrottle(SimpleRateThrottle):
    """Default cap on every write request (POST/PUT/PATCH/DELETE), per user or per IP.

    Reads are never counted, so polling endpoints are unaffected. Views that set their
    own throttle_classes opt out of this default (they already have a tighter scope).
    """

    scope = "write_default"

    def get_cache_key(self, request, view):
        if request.method in SAFE_METHODS:
            return None
        user = getattr(request, "user", None)
        ident = f"u{user.pk}" if user is not None and user.is_authenticated else self.get_ident(request)
        return self.cache_format % {"scope": self.scope, "ident": ident}


class WriteScopedRateThrottle(ScopedRateThrottle):
    """ScopedRateThrottle that only counts writes (POST/PUT/PATCH/DELETE).

    Plain ScopedRateThrottle also counts GETs, so a list+create view with a 60/hour
    "*_write" scope would lock users out of simply viewing the list after 60 page loads.
    """

    def allow_request(self, request, view):
        if request.method in SAFE_METHODS:
            return True
        return super().allow_request(request, view)


class _BodyFieldThrottle(SimpleRateThrottle):
    """Throttle on a value in the request body (hashed, so no raw emails in the cache)."""

    field = ""

    def get_cache_key(self, request, view):
        data = request.data
        value = data.get(self.field) if hasattr(data, "get") else None
        if not isinstance(value, str) or not value.strip():
            return None
        digest = hashlib.sha256(value.strip().lower().encode()).hexdigest()
        return self.cache_format % {"scope": self.scope, "ident": digest}


class LoginEmailThrottle(_BodyFieldThrottle):
    """Limits attempts against one email no matter how many IPs they come from."""

    scope = "login_email"
    field = "email"


class MfaChallengeThrottle(_BodyFieldThrottle):
    """Limits code guesses against one MFA challenge (a 6-digit code is only 1M options)."""

    scope = "mfa_challenge"
    field = "challenge"

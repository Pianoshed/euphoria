import logging
import time

logger = logging.getLogger("apps")

SENSITIVE_KEYS = {
    "password",
    "password1",
    "password2",
    "old_password",
    "new_password",
    "token",
    "access",
    "refresh",
    "secret",
    "authorization",
    "card_number",
    "cvv",
}


def _scrub(data):
    if not isinstance(data, dict):
        return data
    return {k: ("***" if k.lower() in SENSITIVE_KEYS else v) for k, v in data.items()}


class RequestLoggingMiddleware:
    """Logs method/path/status/duration only -- never bodies or headers,
    so secrets can never leak into logs through this path."""

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        start = time.monotonic()
        response = self.get_response(request)
        duration_ms = (time.monotonic() - start) * 1000
        logger.info(
            "%s %s -> %s (%.1fms)",
            request.method,
            request.path,
            response.status_code,
            duration_ms,
        )
        return response


class SecurityHeadersMiddleware:
    """Adds the headers that stop this API (and anything it serves from /media/) from being framed,
    sniffed into a different file type, or used to run script on your origin.

    - API JSON: a CSP of `default-src 'none'` plus `frame-ancestors 'none'`: it can never be framed or run script.
    - /media/ files (avatars, chat photos, voice notes, status clips): `nosniff` + CSP `sandbox`, so even a file that
      slipped through validation as the wrong type cannot execute as a page on your origin.
    - Authenticated API responses are `no-store`, so a shared computer's cache never keeps someone's wallet or chats.
    Put it right after Django's SecurityMiddleware in MIDDLEWARE.
    """

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        response = self.get_response(request)
        path = request.path
        response.setdefault("X-Content-Type-Options", "nosniff")
        response.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
        response.setdefault("Permissions-Policy", "camera=(), geolocation=(), payment=(), usb=()")
        response.setdefault("Cross-Origin-Resource-Policy", "same-site")
        if path.startswith("/media/"):
            response.setdefault("Content-Security-Policy", "default-src 'none'; sandbox; frame-ancestors 'none'")
        elif path.startswith("/api/") or path.startswith("/healthz"):
            response.setdefault("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
            if request.method != "OPTIONS" and not response.has_header("Cache-Control"):
                response["Cache-Control"] = "no-store"
        return response

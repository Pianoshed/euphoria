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

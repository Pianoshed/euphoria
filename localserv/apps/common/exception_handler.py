"""
Friendly replacement for DRF's "Request was throttled. Expected available in N seconds."

Wraps DRF's default handler, so every other error (400, 403, DomainError, ...) behaves
exactly as before. Only throttled (429) responses change:

    {"detail": "You've tried this a few too many times. Please wait about 45 minutes and try again.",
     "code": "throttled",
     "retry_after": 2655}

`retry_after` (seconds) lets the frontend show a countdown. DRF still sets the standard
Retry-After header too.

Turn it on in settings/base.py, inside REST_FRAMEWORK:
    "EXCEPTION_HANDLER": "apps.common.exception_handler.api_exception_handler",
"""
import math

from rest_framework.exceptions import Throttled
from rest_framework.views import exception_handler


def _wait_phrase(seconds: int) -> str:
    if seconds < 60:
        return "a moment"
    minutes = math.ceil(seconds / 60)
    if minutes < 60:
        return f"about {minutes} minute{'s' if minutes != 1 else ''}"
    hours = max(1, round(minutes / 60))
    return f"about {hours} hour{'s' if hours != 1 else ''}"


def api_exception_handler(exc, context):
    response = exception_handler(exc, context)

    if isinstance(exc, Throttled) and response is not None:
        retry_after = math.ceil(exc.wait) if exc.wait else None
        phrase = _wait_phrase(retry_after) if retry_after else "a little while"
        response.data = {
            "detail": f"You've tried this a few too many times. Please wait {phrase} and try again.",
            "code": "throttled",
            "retry_after": retry_after,
        }

    return response

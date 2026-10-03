def whitelist_ordering(requested: str, allowed: list[str], default: str) -> str:
    """Never let clients pass an arbitrary DB field/expression into
    .order_by(). Only fields explicitly whitelisted by the view are
    permitted; anything else silently falls back to `default`."""
    if not requested:
        return default
    field = requested.lstrip("-")
    if field not in allowed:
        return default
    return requested


def clamp_page_size(requested, default: int = 20, maximum: int = 100) -> int:
    try:
        size = int(requested)
    except (TypeError, ValueError):
        return default
    return max(1, min(size, maximum))


def get_client_ip(request) -> str | None:
    """Best-effort client IP. X-Forwarded-For is only trustworthy when
    the app sits behind a reverse proxy that sets/overwrites it (as
    configured in deployment) -- otherwise it's client-controlled and
    should not be used for security decisions, only diagnostics/audit."""
    forwarded = request.META.get("HTTP_X_FORWARDED_FOR")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.META.get("REMOTE_ADDR")

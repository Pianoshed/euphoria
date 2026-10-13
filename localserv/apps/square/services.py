import logging
import threading
from datetime import timedelta

from django.conf import settings
from django.core.cache import cache
from django.db import connection
from django.db.models import Q
from django.utils import timezone

from .models import Status

logger = logging.getLogger("apps")


def purge_expired(batch_size: int = 500) -> int:
    """Hard-delete every status older than STATUS_RETENTION_HOURS (default 24h): its file, its row, and
    (via CASCADE) its reactions and "seen" marks. Queries already hide expired rows; this frees disk and DB.

    A row is purged when EITHER its expires_at has passed OR it was created more than the retention window
    ago, so a wrong/edited expires_at can never keep a status alive. Works in batches so a big backlog
    never loads everything into memory or holds one huge transaction. Safe to re-run."""
    now = timezone.now()
    hours = getattr(settings, "STATUS_RETENTION_HOURS", 24)
    due = Q(expires_at__lte=now) | Q(created_at__lte=now - timedelta(hours=hours))
    storage = Status._meta.get_field("file").storage
    total = 0
    while True:
        batch = list(Status.objects.filter(due).values_list("pk", "file")[:batch_size])
        if not batch:
            return total
        for _pk, name in batch:
            if name:
                try:
                    storage.delete(name)
                except OSError:
                    logger.warning("Could not delete status file %s", name, exc_info=True)
        Status.objects.filter(pk__in=[pk for pk, _ in batch]).delete()
        total += len(batch)


def purge_in_background(every_seconds: int = 900) -> None:
    """Free replacement for a paid cron job. Call this from a frequently used view: at most once per
    `every_seconds` (shared across all processes through the cache) it starts a background thread that
    deletes expired statuses (files + rows) and old chat videos. Never blocks or breaks the request."""
    try:
        if not cache.add("purge_expired_media:lock", 1, every_seconds):
            return  # someone already ran it recently
    except Exception:  # cache down: skip this time, try again on a later request
        return

    def _run():
        try:
            purge_expired()
            from apps.chat import services as chat_services  # lazy import avoids a circular import

            chat_services.purge_old_chat_media(
                days=settings.CHAT_MEDIA_RETENTION_DAYS, kinds=settings.CHAT_MEDIA_PURGE_KINDS
            )
        except Exception:
            logger.exception("Background media purge failed")
        finally:
            connection.close()  # this thread opened its own DB connection; don't leak it

    threading.Thread(target=_run, name="purge-expired-media", daemon=True).start()

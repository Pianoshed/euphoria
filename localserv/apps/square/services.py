import logging
import threading
from datetime import timedelta

from django.conf import settings
from django.core.cache import cache
from django.db import connection
from django.db.models import Q
from django.utils import timezone

from .models import Status, StatusSlide

logger = logging.getLogger("apps")


def purge_expired(batch_size: int = 500) -> int:
    """Hard-delete every status older than STATUS_RETENTION_HOURS (default 24h): its file(s) (single file, slideshow
    cover and every slide), its row, and
    (via CASCADE) its reactions and "seen" marks. Queries already hide expired rows; this frees disk and DB.

    A row is purged when EITHER its expires_at has passed OR it was created more than the retention window
    ago, so a wrong/edited expires_at can never keep a status alive. Works in batches so a big backlog
    never loads everything into memory or holds one huge transaction. Safe to re-run."""
    now = timezone.now()
    hours = getattr(settings, "STATUS_RETENTION_HOURS", 24)
    due = Q(expires_at__lte=now) | Q(created_at__lte=now - timedelta(hours=hours))
    storage = Status._meta.get_field("file").storage
    total = 0
    stuck = set()  # rows whose files could not be deleted this run: kept (so the files are never orphaned), retried next run
    while True:
        batch = list(Status.objects.filter(due).exclude(pk__in=stuck).values_list("pk", "file", "cover")[:batch_size])
        if not batch:
            return total
        slide_files = {}
        for sid, name in StatusSlide.objects.filter(status_id__in=[pk for pk, _f, _c in batch]).values_list("status_id", "file"):
            slide_files.setdefault(sid, []).append(name)  # slideshow pictures
        done = []
        for pk, f, c in batch:
            try:
                for name in [n for n in (f, c, *slide_files.get(pk, [])) if n]:
                    storage.delete(name)  # deleting a missing object is fine; R2 deletes are free
            except Exception:  # bucket/network errors are botocore errors, not OSError: one bad file must not stall the purge
                logger.warning("Could not delete files of status %s; will retry on the next run", pk, exc_info=True)
                stuck.add(pk)
                continue
            done.append(pk)
        if done:
            Status.objects.filter(pk__in=done).delete()
            total += len(done)


def delete_status(status: Status) -> bool:
    """Permanently delete one status for its creator: every file (single file, cover, each slide) and then the row
    (reactions and "seen" marks go with it via CASCADE). Nothing is kept or recoverable afterwards.

    If the bucket refuses a delete, the row is NOT dropped (that would orphan the files, since purging works from DB
    rows). Instead it is expired on the spot, so every query already hides it, and purge_expired() retries the files
    on its next run. Returns True when everything is gone, False when clean-up was left for the purge."""
    storage = Status._meta.get_field("file").storage
    names = [n for n in (status.file.name, status.cover.name) if n]
    names += list(StatusSlide.objects.filter(status_id=status.pk).values_list("file", flat=True))
    try:
        for name in names:
            storage.delete(name)  # deleting a missing object is fine
    except Exception:  # botocore errors are not OSError
        logger.warning("Could not delete files of status %s; hidden now, the purge will retry", status.pk, exc_info=True)
        Status.objects.filter(pk=status.pk).update(expires_at=timezone.now())
        return False
    status.delete()
    return True


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

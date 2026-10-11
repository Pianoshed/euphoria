import logging
from datetime import timedelta

from django.conf import settings
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

from django.utils import timezone

from .models import Status


def purge_expired() -> int:
    """Delete expired statuses and their files. Run this on a schedule (cron, Celery beat or a
    management command every ~15 minutes). Queries already hide expired rows; this frees disk."""
    count = 0
    for s in Status.objects.filter(expires_at__lte=timezone.now()):
        if s.file:
            s.file.delete(save=False)
        s.delete()
        count += 1
    return count

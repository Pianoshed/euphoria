from django.conf import settings
from django.core.management.base import BaseCommand

from apps.chat import services as chat_services
from apps.square import services as square_services


class Command(BaseCommand):
    help = ("Enforce retention: delete status posts older than 24h (files + rows) and chat media older than "
            "CHAT_MEDIA_RETENTION_DAYS (default 14 days). Run every 15 minutes (cron). Safe to re-run.")

    def add_arguments(self, parser):
        parser.add_argument("--chat-days", type=int, default=settings.CHAT_MEDIA_RETENTION_DAYS)
        parser.add_argument("--chat-kinds", nargs="+", default=list(settings.CHAT_MEDIA_PURGE_KINDS))

    def handle(self, *args, **opts):
        statuses = square_services.purge_expired()
        media = chat_services.purge_old_chat_media(days=opts["chat_days"], kinds=opts["chat_kinds"])
        self.stdout.write(f"statuses_deleted={statuses}, chat_media_deleted={media}")

from django.core.management.base import BaseCommand

from apps.economy.services import expire_stale_gifts


class Command(BaseCommand):
    help = "Return pending gifts past their expiry to the sender. Run hourly (cron / Render cron job). Safe to re-run."

    def handle(self, *args, **opts):
        self.stdout.write(f"Expired {expire_stale_gifts()} gift(s).")

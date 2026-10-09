from django.core.management.base import BaseCommand

from apps.bookings import services


class Command(BaseCommand):
    help = ("Auto-release COMPLETED bookings the customer never confirmed, and auto-refund FUNDED/IN_PROGRESS "
            "bookings the provider never finished. Run daily (cron). Safe to re-run.")

    def add_arguments(self, parser):
        parser.add_argument("--release-after-days", type=int, default=7)
        parser.add_argument("--refund-after-days", type=int, default=14)

    def handle(self, *args, **opts):
        r = services.settle_stale_bookings(release_after_days=opts["release_after_days"], refund_after_days=opts["refund_after_days"])
        self.stdout.write(", ".join(f"{k}={v}" for k, v in r.items()))

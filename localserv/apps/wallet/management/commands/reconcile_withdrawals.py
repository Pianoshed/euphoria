from django.core.management.base import BaseCommand

from apps.wallet import payment_services


class Command(BaseCommand):
    help = (
        "Settle PROCESSING withdrawals whose webhook never arrived by asking the provider. "
        "Refunds only on an explicit 'failed'. Run every ~10 minutes (Render cron job)."
    )

    def add_arguments(self, parser):
        parser.add_argument("--older-than", type=int, default=10, help="minutes (default 10)")

    def handle(self, *args, **opts):
        counts = payment_services.reconcile_withdrawals(older_than_minutes=opts["older_than"])
        self.stdout.write(", ".join(f"{k}={v}" for k, v in counts.items()))

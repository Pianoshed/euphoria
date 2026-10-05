from django.conf import settings
from django.core.mail import send_mail
from django.core.management.base import BaseCommand


class Command(BaseCommand):
    help = "Send one test email, to check the email settings. Usage: python manage.py send_test_email you@example.com"

    def add_arguments(self, parser):
        parser.add_argument("to")

    def handle(self, *args, **options):
        self.stdout.write(f"Backend: {settings.EMAIL_BACKEND}")
        self.stdout.write(f"From:    {settings.DEFAULT_FROM_EMAIL}")
        sent = send_mail(
            "Euphoria test email",
            "If you can read this, email sending works.",
            settings.DEFAULT_FROM_EMAIL,
            [options["to"]],
            fail_silently=False,
        )
        self.stdout.write(self.style.SUCCESS(f"Sent {sent} email(s). Check the inbox (and spam)."))

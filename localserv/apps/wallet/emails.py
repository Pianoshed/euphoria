"""
Transactional emails for wallet/payment events.

NOTE: sends synchronously via Django's configured EMAIL_BACKEND, same
as apps.accounts.emails -- Celery is listed in requirements.txt but
not wired into this project yet (see the top-level README's "Known
gaps" section). Not solved here either, to stay consistent with how
the rest of the codebase currently handles this.
"""
from django.conf import settings
from django.core.mail import send_mail


def send_withdrawal_confirmation_email(user, withdrawal) -> None:
    send_mail(
        subject="Withdrawal confirmation",
        message=(
            f"Hi {user.username},\n\n"
            f"Your withdrawal of {withdrawal.amount} to {withdrawal.payout_account.label} "
            f"{withdrawal.payout_account.masked_reference} has been processed.\n\n"
            "If this wasn't you, contact support immediately."
        ),
        from_email=settings.DEFAULT_FROM_EMAIL,
        recipient_list=[user.email],
        fail_silently=False,
    )

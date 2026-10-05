"""
Transactional emails for auth flows.

NOTE: sends synchronously via Django's configured EMAIL_BACKEND for
now (console backend in dev). Phase 9/infra hardening should move
this behind a Celery task so a slow SMTP call never blocks a request
-- deliberately not solved here to keep this phase focused on auth
correctness.
"""
from django.conf import settings
from django.core.mail import send_mail


def _frontend_link(path: str, raw_token: str) -> str:
    """Build a link to a page of the React site. FRONTEND_URL comes from settings
    (e.g. http://localhost:5173 in dev, https://yourdomain.com in production)."""
    base = getattr(settings, "FRONTEND_URL", "http://localhost:5173").rstrip("/")
    return f"{base}{path}?token={raw_token}"


def send_verification_email(user, raw_token: str) -> None:
    link = _frontend_link("/verify-email", raw_token)
    send_mail(
        subject="Verify your email address",
        message=(
            f"Hi {user.username},\n\n"
            f"Confirm your email address by visiting:\n{link}\n\n"
            "This link expires in 24 hours. If you didn't create an "
            "account, you can ignore this email."
        ),
        from_email=settings.DEFAULT_FROM_EMAIL,
        recipient_list=[user.email],
        fail_silently=False,
    )


def send_password_reset_email(user, raw_token: str) -> None:
    link = _frontend_link("/password-reset/confirm", raw_token)
    send_mail(
        subject="Reset your password",
        message=(
            f"Hi {user.username},\n\n"
            f"Reset your password by visiting:\n{link}\n\n"
            "This link expires in 1 hour. If you didn't request this, "
            "you can safely ignore this email -- your password will "
            "not be changed."
        ),
        from_email=settings.DEFAULT_FROM_EMAIL,
        recipient_list=[user.email],
        fail_silently=False,
    )


def send_security_alert_email(user, subject: str, body: str) -> None:
    send_mail(
        subject=subject,
        message=body,
        from_email=settings.DEFAULT_FROM_EMAIL,
        recipient_list=[user.email],
        fail_silently=False,
    )

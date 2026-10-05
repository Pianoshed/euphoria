from django.core.exceptions import ImproperlyConfigured

from .base import *  # noqa: F401,F403
from .base import BREVO_API_KEY, PAYMENT_PROVIDER, env

DEBUG = False

if PAYMENT_PROVIDER == "stub":
    raise ImproperlyConfigured(
        "PAYMENT_PROVIDER=stub (which auto-completes deposits/withdrawals with no real "
        "money movement) must never run in production. Set PAYMENT_PROVIDER to a real "
        "provider once one is integrated (see apps.wallet.providers)."
    )

CSRF_TRUSTED_ORIGINS = env.list("CSRF_TRUSTED_ORIGINS", default=[])

# Only meaningful because deploy/nginx/app.conf is the one setting
# this header, on every request, unconditionally -- if a client could
# reach Django directly (bypassing nginx) it could spoof this and
# fool SECURE_SSL_REDIRECT into thinking a plain HTTP request was
# already HTTPS. Never set this unless the app is provably only
# reachable through that proxy (e.g. it's not exposed to the internet
# on its own port).
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")

SESSION_COOKIE_SECURE = True
CSRF_COOKIE_SECURE = True

SECURE_SSL_REDIRECT = True
SECURE_HSTS_SECONDS = 31536000
SECURE_HSTS_INCLUDE_SUBDOMAINS = True
SECURE_HSTS_PRELOAD = True
SECURE_CONTENT_TYPE_NOSNIFF = True
SECURE_REFERRER_POLICY = "same-origin"
X_FRAME_OPTIONS = "DENY"

# Brevo's API when BREVO_API_KEY is set (base.py picks that backend); otherwise plain SMTP.
if not BREVO_API_KEY:
    EMAIL_BACKEND = "django.core.mail.backends.smtp.EmailBackend"

# --- Structured (JSON) logging for log aggregation ---------------------------
# Same handlers/loggers as base.py's dev-friendly LOGGING, just a
# different formatter -- keeps this override small rather than
# duplicating the whole LOGGING dict.
LOGGING["formatters"]["json"] = {"()": "apps.common.log_formatters.JSONFormatter"}
LOGGING["handlers"]["console"]["formatter"] = "json"

# --- Optional error tracking (Sentry) -----------------------------------------
# No-ops entirely if SENTRY_DSN isn't set -- sentry-sdk is imported
# lazily here so it's only a hard dependency if this block actually
# runs, and a missing/misconfigured DSN never breaks startup.
SENTRY_DSN = env("SENTRY_DSN", default="")
if SENTRY_DSN:
    import sentry_sdk
    from sentry_sdk.integrations.django import DjangoIntegration

    sentry_sdk.init(
        dsn=SENTRY_DSN,
        integrations=[DjangoIntegration()],
        traces_sample_rate=env.float("SENTRY_TRACES_SAMPLE_RATE", default=0.0),
        environment=env("SENTRY_ENVIRONMENT", default="production"),
        # Never send request bodies/headers -- same principle as the
        # request-logging middleware's own scrubbing: an error-tracking
        # SaaS is one more place passwords/tokens/payout details must
        # never end up.
        send_default_pii=False,
    )

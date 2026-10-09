from .base import *  # noqa: F401,F403
from .base import RESEND_API_KEY, LOGGING, env

# STAGING / DEMO ONLY. Fake money, stub payments. Never point real users,
# real payment credentials, or the production database at this.
DEBUG = False

# Deliberately NOT importing from .prod: that triggers the stub guard.
PAYMENT_PROVIDER = "stub"
ALLOW_STUB_PAYMENTS = True  # required now: the stub is otherwise refused outside DEBUG/tests

CSRF_TRUSTED_ORIGINS = env.list("CSRF_TRUSTED_ORIGINS", default=[])

# Render's load balancer sets X-Forwarded-Proto on every request, and the
# service isn't reachable except through it. Without this line,
# SECURE_SSL_REDIRECT causes an infinite redirect loop.
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")

SESSION_COOKIE_SECURE = True
CSRF_COOKIE_SECURE = True

# Frontend and backend are on different onrender.com domains, so the
# session cookie is cross-site. Needed for login and WebSocket auth.
SESSION_COOKIE_SAMESITE = "None"
CSRF_COOKIE_SAMESITE = "None"

SECURE_SSL_REDIRECT = True
SECURE_HSTS_SECONDS = 3600  # short on purpose for staging; avoid long HSTS on throwaway domains
SECURE_CONTENT_TYPE_NOSNIFF = True
SECURE_REFERRER_POLICY = "same-origin"
X_FRAME_OPTIONS = "DENY"

# Real email through Resend when RESEND_API_KEY is set (base.py picks the backend); otherwise just print emails in the log.
if not RESEND_API_KEY:
    EMAIL_BACKEND = "django.core.mail.backends.console.EmailBackend"

LOGGING["formatters"]["json"] = {"()": "apps.common.log_formatters.JSONFormatter"}
LOGGING["handlers"]["console"]["formatter"] = "json"

STORAGES = {
    "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
    "staticfiles": {"BACKEND": "whitenoise.storage.CompressedManifestStaticFilesStorage"},
}
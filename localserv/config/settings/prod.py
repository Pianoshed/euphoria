from django.core.exceptions import ImproperlyConfigured

from .base import *  # noqa: F401,F403
from .base import RESEND_API_KEY, PAYMENT_PROVIDER, env

DEBUG = False

if PAYMENT_PROVIDER == "stub":
    raise ImproperlyConfigured(
        "PAYMENT_PROVIDER=stub (which auto-completes deposits/withdrawals with no real "
        "money movement) must never run in production. Set PAYMENT_PROVIDER to a real "
        "provider once one is integrated (see apps.wallet.providers)."
    )

if PAYMENT_PROVIDER == "monnify":
    from .base import (MONNIFY_API_KEY, MONNIFY_BASE_URL, MONNIFY_CONTRACT_CODE, MONNIFY_REDIRECT_URL,
                       MONNIFY_SECRET_KEY, MONNIFY_SOURCE_ACCOUNT_NUMBER, PAYOUT_ENCRYPTION_KEYS)
    _missing = [k for k, v in {
        "MONNIFY_API_KEY": MONNIFY_API_KEY, "MONNIFY_SECRET_KEY": MONNIFY_SECRET_KEY,
        "MONNIFY_CONTRACT_CODE": MONNIFY_CONTRACT_CODE, "MONNIFY_REDIRECT_URL": MONNIFY_REDIRECT_URL,
        "MONNIFY_SOURCE_ACCOUNT_NUMBER": MONNIFY_SOURCE_ACCOUNT_NUMBER, "PAYOUT_ENCRYPTION_KEYS": PAYOUT_ENCRYPTION_KEYS,
    }.items() if not v]
    if _missing:
        raise ImproperlyConfigured(f"PAYMENT_PROVIDER=monnify but these are not set: {', '.join(_missing)}")
    if "sandbox" in MONNIFY_BASE_URL:
        raise ImproperlyConfigured("Production is pointing at the Monnify SANDBOX. Set MONNIFY_BASE_URL=https://api.monnify.com")
elif PAYMENT_PROVIDER != "monnify":
    raise ImproperlyConfigured(f"Unknown PAYMENT_PROVIDER {PAYMENT_PROVIDER!r} for production.")

# Chat messages and 2FA secrets are encrypted at rest. A key derived from SECRET_KEY would make that data
# unreadable if SECRET_KEY ever changed, so production must have its own, valid key.
from .base import FIELD_ENCRYPTION_KEYS  # noqa: E402

_field_keys = [k.strip() for k in FIELD_ENCRYPTION_KEYS.split(",") if k.strip()]
if not _field_keys:
    raise ImproperlyConfigured(
        "FIELD_ENCRYPTION_KEYS is not set. Generate one with: "
        "python -c \"from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())\""
    )
from cryptography.fernet import Fernet  # noqa: E402

for _key in _field_keys:
    try:
        Fernet(_key.encode())
    except (ValueError, TypeError) as exc:
        raise ImproperlyConfigured("FIELD_ENCRYPTION_KEYS contains an invalid Fernet key.") from exc

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

# Resend's API when RESEND_API_KEY is set (base.py picks that backend); otherwise plain SMTP.
if not RESEND_API_KEY:
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
# ======================================================================
# SECURITY HARDENING -- paste at the BOTTOM of config/settings/prod.py
# (after the CSRF_TRUSTED_ORIGINS line, so the checks see the final values)
# ======================================================================

# --- 1. Refuse to boot with unsafe host/origin config -----------------
if not ALLOWED_HOSTS or "*" in ALLOWED_HOSTS:  # noqa: F405
    raise ImproperlyConfigured("DJANGO_ALLOWED_HOSTS must list the real API host(s) -- not empty, not '*'.")

for _name, _origins in {
    "CORS_ALLOWED_ORIGINS": CORS_ALLOWED_ORIGINS,  # noqa: F405  (also used by the WebSocket OriginValidator in asgi.py)
    "CSRF_TRUSTED_ORIGINS": CSRF_TRUSTED_ORIGINS,
}.items():
    if not _origins or any(o.strip() == "*" or o.startswith("http://") for o in _origins):
        raise ImproperlyConfigured(f"{_name} must be a non-empty list of https:// origins (no '*', no http://).")

# --- 2. CORS: your own frontend only, API paths only -------------------
CORS_ALLOW_ALL_ORIGINS = False
CORS_ALLOW_CREDENTIALS = True
CORS_URLS_REGEX = r"^/api/.*$"

# --- 3. Cookies / HTTPS (most of this is already above; kept so it's explicit) ---
SESSION_COOKIE_SECURE = True
CSRF_COOKIE_SECURE = True  # required anyway if SAMESITE=None
SESSION_COOKIE_HTTPONLY = True
CSRF_COOKIE_HTTPONLY = False  # the React app must read it to send X-CSRFToken
# SameSite comes from env (base.py). Pick ONE setup:
#   a) Same site (best, works on Safari): app.example.com + api.example.com, Lax,
#      SESSION_COOKIE_DOMAIN=.example.com  CSRF_COOKIE_DOMAIN=.example.com
#   b) Two *.onrender.com hosts: SESSION_COOKIE_SAMESITE=None  CSRF_COOKIE_SAMESITE=None
#      (works on Chrome/Firefox, Safari will still drop the cookie)
if SESSION_COOKIE_SAMESITE not in ("Lax", "None", "Strict"):  # noqa: F405
    raise ImproperlyConfigured("SESSION_COOKIE_SAMESITE must be Lax, None or Strict.")

# --- 4. Argon2 (hasher list is in base.py; this fails at boot if the package is missing) ---
try:
    import argon2  # noqa: F401
except ImportError as exc:
    raise ImproperlyConfigured("argon2-cffi is not installed. Add `argon2-cffi` to requirements.txt.") from exc

# --- 5. Throttles: cap anonymous traffic + make sure every scope has a rate ---
REST_FRAMEWORK = {  # noqa: F405
    **REST_FRAMEWORK,  # noqa: F405
    "DEFAULT_THROTTLE_CLASSES": [
        *REST_FRAMEWORK["DEFAULT_THROTTLE_CLASSES"],  # noqa: F405
        "rest_framework.throttling.AnonRateThrottle",
    ],
    "DEFAULT_THROTTLE_RATES": {
        **REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"],  # noqa: F405
        # Per IP, logged-out requests only. Generous because mobile networks share IPs.
        "anon": env("THROTTLE_ANON", default="120/min"),
        # Add any scope the checker script reports as missing, e.g.:
        # "profile_write": "60/hour",
    },
}

# --- 6. API docs and schema: admins only (they are public by default) ---
SPECTACULAR_SETTINGS = {  # noqa: F405
    **SPECTACULAR_SETTINGS,  # noqa: F405
    "SERVE_PERMISSIONS": ["rest_framework.permissions.IsAdminUser"],
    "SERVE_AUTHENTICATION": ["rest_framework.authentication.SessionAuthentication"],
}

"""
Base settings shared by dev/prod. Do not put environment-specific
values here directly -- read them via env.
"""
from decimal import Decimal
from pathlib import Path

import environ

BASE_DIR = Path(__file__).resolve().parent.parent.parent

env = environ.Env()
environ.Env.read_env(str(BASE_DIR / ".env"))

SECRET_KEY = env("DJANGO_SECRET_KEY")
DEBUG = env.bool("DJANGO_DEBUG", default=False)
ALLOWED_HOSTS = env.list("DJANGO_ALLOWED_HOSTS", default=[])

AUTH_USER_MODEL = "accounts.User"

INSTALLED_APPS = [
    "daphne",  # must precede django.contrib.staticfiles so `runserver` auto-serves ASGI/WS
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "channels",
    "rest_framework",
    "corsheaders",
    "drf_spectacular",
    "apps.common.apps.CommonConfig",
    "apps.accounts.apps.AccountsConfig",
    "apps.services.apps.ServicesConfig",
    "apps.bookings.apps.BookingsConfig",
    "apps.wallet.apps.WalletConfig",
    "apps.economy.apps.EconomyConfig",
    "apps.moderation.apps.ModerationConfig",
    "apps.chat.apps.ChatConfig",
    "apps.square",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "whitenoise.middleware.WhiteNoiseMiddleware",  # serves collected static files (admin CSS/JS)
    "corsheaders.middleware.CorsMiddleware",
    "apps.common.middleware.SlidingSessionMiddleware",  # sliding idle timeout, ~1 write/min (see class)
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
    "apps.common.middleware.RequestLoggingMiddleware",
]

ROOT_URLCONF = "config.urls"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [BASE_DIR / "templates"],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.debug",
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]

WSGI_APPLICATION = "config.wsgi.application"
ASGI_APPLICATION = "config.asgi.application"

DATABASES = {
    "default": env.db("DATABASE_URL"),
}
# Keep False: a withdrawal must commit its wallet debit BEFORE the bank transfer is sent.
DATABASES["default"]["ATOMIC_REQUESTS"] = False

# --- DB connection hygiene ----------------------------------------------------------------
# Three ways to get connections right under ASGI, in order of preference:
#  1. In-process pool (needs psycopg 3 + `psycopg[pool]`, Django 5.1+). Used automatically when installed:
#     CONN_MAX_AGE is forced to 0 and at most DB_POOL_MAX_SIZE (default 10) connections are open PER PROCESS,
#     so (processes x pool size) must stay below the Postgres max_connections. Set DB_POOL_MAX_SIZE=0 to disable.
#  2. PgBouncer in front of Postgres: DB_USE_PGBOUNCER=1. Use it TOGETHER with option 1: the in-app pool keeps a few
#     connections to PgBouncer open (cheap for sockets), PgBouncer multiplexes all processes onto few Postgres connections.
#  3. Neither: CONN_MAX_AGE=60 as before. WARNING: under ASGI every HTTP request runs in its own thread, so
#     those connections are never reused or closed and pile up (measured: 60 concurrent requests left 60 open).
# Do NOT set CONN_MAX_AGE=0 without 1 or 2: every chat-socket database call would then open a brand-new
# connection (measured: 524 of 570 socket connects failed and message round trips took ~18 s).
_USE_PGBOUNCER = env.bool("DB_USE_PGBOUNCER", default=False)
try:
    import psycopg  # noqa: F401
    import psycopg_pool  # noqa: F401
    _POOL_AVAILABLE = True
except ImportError:
    _POOL_AVAILABLE = False
try:
    import psycopg  # noqa: F401
    _PSYCOPG3 = True
except ImportError:
    _PSYCOPG3 = False
_db_pool_max = env.int("DB_POOL_MAX_SIZE", default=10 if _POOL_AVAILABLE else 0)  # also in front of PgBouncer
if _db_pool_max and not _POOL_AVAILABLE:
    raise ImportError("DB_POOL_MAX_SIZE is set but psycopg 3 / psycopg_pool is not installed. pip install 'psycopg[binary,pool]'")
_DB_CONN_MAX_AGE_DEFAULT = 0 if (_USE_PGBOUNCER or _db_pool_max) else 60
DATABASES["default"]["CONN_MAX_AGE"] = env.int("DB_CONN_MAX_AGE", default=_DB_CONN_MAX_AGE_DEFAULT)
if _db_pool_max:
    DATABASES["default"]["CONN_MAX_AGE"] = 0  # Django refuses CONN_MAX_AGE together with a pool
if _USE_PGBOUNCER and not _db_pool_max:
    import warnings

    warnings.warn(
        "DB_USE_PGBOUNCER=1 without the in-app pool: every chat-socket database call opens a new connection "
        "to PgBouncer, which makes WebSockets very slow. Install 'psycopg[binary,pool]' and keep DB_POOL_MAX_SIZE > 0.",
        RuntimeWarning,
    )
if "postgresql" in DATABASES["default"].get("ENGINE", "") and not (_db_pool_max or _USE_PGBOUNCER):
    import warnings

    warnings.warn(
        "Postgres connections are persistent (CONN_MAX_AGE=60) with no pool: under ASGI they pile up. "
        "Install 'psycopg[binary,pool]' (automatic pool) or set DB_USE_PGBOUNCER=1.", RuntimeWarning,
    )
# Drop dead connections (e.g. after a Render Postgres restart) instead of reusing them. Django 4.1+.
DATABASES["default"]["CONN_HEALTH_CHECKS"] = True
if "postgresql" in DATABASES["default"].get("ENGINE", ""):
    _db_opts = DATABASES["default"].setdefault("OPTIONS", {})
    _db_opts.update({
        "connect_timeout": 10,
        # TCP keepalives: Render's network layer silently drops idle TCP flows. Without keepalives the
        # next query on a pooled connection fails with "server closed the connection unexpectedly".
        "keepalives": 1,
        "keepalives_idle": 30,
        "keepalives_interval": 10,
        "keepalives_count": 5,
    })
    if _db_pool_max:
        _db_opts["pool"] = {
            "min_size": min(env.int("DB_POOL_MIN_SIZE", default=2), _db_pool_max),
            "max_size": _db_pool_max,
            "timeout": env.int("DB_POOL_TIMEOUT", default=10),
        }
    if _USE_PGBOUNCER:
        DATABASES["default"]["DISABLE_SERVER_SIDE_CURSORS"] = True
        if _PSYCOPG3:
            # psycopg 3 prepares a statement on the server after 5 runs; in PgBouncer transaction mode the next
            # run may land on a different server connection ("prepared statement does not exist"). PgBouncer
            # older than 1.21 cannot track prepared statements at all, so switch them off.
            _db_opts["prepare_threshold"] = None
        # Startup `options` are rejected by PgBouncer transaction mode. Set the same timeouts per role instead:
        #   ALTER ROLE <app_user> SET statement_timeout='30s';
        #   ALTER ROLE <app_user> SET idle_in_transaction_session_timeout='30s';
    else:
        # A stuck query / a transaction left open (e.g. waiting on a slow bank API) is killed by Postgres
        # instead of pinning a connection and its row locks forever.
        _db_opts["options"] = "-c statement_timeout=30000 -c idle_in_transaction_session_timeout=30000"

CACHES = {
    "default": {
        "BACKEND": "django_redis.cache.RedisCache",
        "LOCATION": env("REDIS_URL"),
        "OPTIONS": {"CLIENT_CLASS": "django_redis.client.DefaultClient"},
    }
}

import sys

if "test" in sys.argv:
    CACHES = {
        "default": {
            "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
        }
    }

# Channel layer (WebSocket fan-out). Every value below defaults to what channels_redis already uses.
#  * CHANNEL_LAYER_MAX_CONNECTIONS: size of the Redis connection pool PER PROCESS. Newer redis-py versions
#    default to 100, so a burst of >100 simultaneous socket connects/sends fails with "Too many connections"
#    (reproduced at ~570 simultaneous connects). Raise it, but keep it under your Redis plan's client limit.
#  * CHANNEL_LAYER_CAPACITY: messages queued per socket before the oldest are dropped (slow clients).
_channel_host = {"address": env("REDIS_URL")}
if env.int("CHANNEL_LAYER_MAX_CONNECTIONS", default=0):
    _channel_host["max_connections"] = env.int("CHANNEL_LAYER_MAX_CONNECTIONS")
CHANNEL_LAYERS = {
    "default": {
        "BACKEND": "channels_redis.core.RedisChannelLayer",
        "CONFIG": {
            "hosts": [_channel_host],
            "capacity": env.int("CHANNEL_LAYER_CAPACITY", default=100),
            "expiry": env.int("CHANNEL_LAYER_EXPIRY", default=60),
        },
    }
}

# --- Password hashing: Argon2 first ---
PASSWORD_HASHERS = [
    "django.contrib.auth.hashers.Argon2PasswordHasher",
    "django.contrib.auth.hashers.PBKDF2PasswordHasher",
]

AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator", "OPTIONS": {"min_length": 10}},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]

LANGUAGE_CODE = "en-us"
TIME_ZONE = "Africa/Lagos"
USE_I18N = True
USE_TZ = True

STATIC_URL = "static/"
STATIC_ROOT = BASE_DIR / "staticfiles"
# Only register the project-level static dir if it exists (avoids the
# staticfiles.W004 warning when there are no custom static files).
STATICFILES_DIRS = [BASE_DIR / "static"] if (BASE_DIR / "static").is_dir() else []

MEDIA_URL = "media/"
MEDIA_ROOT = BASE_DIR / "media"

# --- Uploaded files: avatars, chat photos / voice / video, statuses ----------------------------------
# Default: the local `media/` folder. On Render that folder is wiped on EVERY deploy and restart (a
# persistent disk needs a paid service and ties the app to a single instance). To keep files for good, set
# MEDIA_S3_BUCKET to any S3-compatible bucket (Cloudflare R2, Supabase Storage S3, Backblaze B2, AWS S3).
# Needs `django-storages[s3]` in requirements. Env vars:
#   MEDIA_S3_BUCKET, MEDIA_S3_ACCESS_KEY_ID, MEDIA_S3_SECRET_ACCESS_KEY,
#   MEDIA_S3_ENDPOINT_URL (R2 / Supabase / B2: their S3 endpoint; leave empty for AWS), MEDIA_S3_REGION (default "auto"),
#   MEDIA_S3_SIGNED_URLS (default True: private bucket, links expire after MEDIA_S3_URL_EXPIRE_SECONDS, default 3600).
_media_bucket = env("MEDIA_S3_BUCKET", default="")
if _media_bucket:
    try:
        import storages  # noqa: F401
    except ImportError as exc:
        raise ImportError("MEDIA_S3_BUCKET is set but django-storages is missing: pip install 'django-storages[s3]'") from exc
    STORAGES = {
        "default": {
            "BACKEND": "storages.backends.s3.S3Storage",
            "OPTIONS": {
                "bucket_name": _media_bucket,
                "access_key": env("MEDIA_S3_ACCESS_KEY_ID"),
                "secret_key": env("MEDIA_S3_SECRET_ACCESS_KEY"),
                "endpoint_url": env("MEDIA_S3_ENDPOINT_URL", default="") or None,
                "region_name": env("MEDIA_S3_REGION", default="auto"),
                "signature_version": "s3v4",
                "querystring_auth": env.bool("MEDIA_S3_SIGNED_URLS", default=True),
                "querystring_expire": env.int("MEDIA_S3_URL_EXPIRE_SECONDS", default=3600),
                "file_overwrite": False,  # never replace someone else's file with the same name
                "default_acl": None,
            },
        },
        "staticfiles": {"BACKEND": "django.contrib.staticfiles.storage.StaticFilesStorage"},  # unchanged
    }

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

# --- DRF ---
REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": [
        "rest_framework.authentication.SessionAuthentication",
    ],
    "DEFAULT_PERMISSION_CLASSES": [
        "rest_framework.permissions.IsAuthenticated",
    ],
    "DEFAULT_PAGINATION_CLASS": "rest_framework.pagination.PageNumberPagination",
    "PAGE_SIZE": 20,
    "DEFAULT_THROTTLE_CLASSES": [
        "rest_framework.throttling.ScopedRateThrottle",
        # Caps every write on views that don't set their own throttle (square, profile, avatar, blocks...).
        "apps.common.throttles.WriteRateThrottle",
    ],
    # How many reverse proxies sit in front of Django. DRF then reads the client IP from
    # the right place in X-Forwarded-For. Without it, anyone can dodge every per-IP
    # throttle by sending a made-up X-Forwarded-For header on each request.
    "NUM_PROXIES": env.int("NUM_PROXIES", default=1),
    "DEFAULT_THROTTLE_RATES": {
        # Per IP. Mobile networks put many people behind one IP, so 10/hour locked real users out; the
        # per-email limit below is the real guard against password guessing.
        # Logged-out requests, per IP (used by AnonRateThrottle on public views).
        "anon": "120/min",
        "login": "30/hour",
        "device_takeover": "30/hour",
        "login_email": "20/hour",
        "mfa_challenge": "8/hour",
        "write_default": "120/min",
        "password_reset": "5/hour",
        "password_reset_confirm": "20/hour",
        "registration": "10/hour",
        "email_verification": "10/hour",
        "two_factor": "20/hour",
        "service_write": "60/hour",
        "booking_write": "60/hour",
        "wallet_write": "60/hour",
        "payment_webhook": "120/min",
        "messages": "120/min",
        "chat_write": "60/min",
        "chat_read": "600/min",  # reads on the chat list/message views (writes use chat_write / messages)
        "moderation_write": "60/hour",
        "ice_servers": "30/min",
    },
    "DEFAULT_SCHEMA_CLASS": "drf_spectacular.openapi.AutoSchema",
    "EXCEPTION_HANDLER": "apps.common.exception_handler.api_exception_handler",
}

SPECTACULAR_SETTINGS = {
    "TITLE": "Local Services Marketplace API",
    "DESCRIPTION": "API for connecting customers with local service providers.",
    "VERSION": "0.1.0",
}

# --- CORS ---
CORS_ALLOWED_ORIGINS = env.list("CORS_ALLOWED_ORIGINS", default=[])
CSRF_TRUSTED_ORIGINS = env.list("CSRF_TRUSTED_ORIGINS", default=["http://localhost:5173"])
CORS_ALLOW_CREDENTIALS = True

# --- Google sign-in ---
# Must match the OAuth client ID the frontend uses, or token verification
# fails on the audience check. Confirm this name matches what
# apps/accounts/services.py reads.
GOOGLE_CLIENT_ID = env("GOOGLE_CLIENT_ID", default="")

# --- Video calls (TURN) ---
GROUP_CALL_MAX_PARTICIPANTS = env.int("GROUP_CALL_MAX_PARTICIPANTS", default=4)
STUN_URL = env("STUN_URL", default="stun:stun.l.google.com:19302")
TURN_URLS = env.list("TURN_URLS", default=[])
TURN_SECRET = env("TURN_SECRET", default="")
TURN_TTL_SECONDS = env.int("TURN_TTL_SECONDS", default=3600)

# --- Cookies / sessions (tightened further in prod.py) ---
SESSION_COOKIE_HTTPONLY = True
CSRF_COOKIE_HTTPONLY = False  # JS needs to read this to send the header
# Safari (iPhone/Mac) refuses cookies from an API on a different site than the page, whatever SameSite says.
# The reliable fix is to serve the app and the API from the SAME site (app.example.com + api.example.com), and
# for those two settings to share the parent domain. Both are env-driven so no code change is needed:
#   SESSION_COOKIE_DOMAIN=.example.com   CSRF_COOKIE_DOMAIN=.example.com
SESSION_COOKIE_SAMESITE = env("SESSION_COOKIE_SAMESITE", default="Lax")
CSRF_COOKIE_SAMESITE = env("CSRF_COOKIE_SAMESITE", default="Lax")
SESSION_COOKIE_DOMAIN = env("SESSION_COOKIE_DOMAIN", default=None) or None
CSRF_COOKIE_DOMAIN = env("CSRF_COOKIE_DOMAIN", default=None) or None

# Log out when the browser closes, and after N idle minutes either way.
# While a tab is open, the presence pings keep the session alive (sliding expiry).
SESSION_EXPIRE_AT_BROWSER_CLOSE = True
SESSION_COOKIE_AGE = env.int("SESSION_IDLE_MINUTES", default=15) * 60
SESSION_SAVE_EVERY_REQUEST = False  # replaced by SlidingSessionMiddleware: one write per minute, not per request
SESSION_REFRESH_SECONDS = env.int("SESSION_REFRESH_SECONDS", default=60)
CSRF_COOKIE_AGE = None  # default is 1 year; None = cookie dies with the browser

# --- Payments (Phase 6) ---
PAYMENT_PROVIDER = env("PAYMENT_PROVIDER", default="stub")
DEFAULT_PLATFORM_FEE_RATE = Decimal(env("DEFAULT_PLATFORM_FEE_RATE", default="15.00"))
STUB_PAYMENT_WEBHOOK_SECRET = env("STUB_PAYMENT_WEBHOOK_SECRET", default="stub-secret-change-me")
# The stub provider is refused unless this is True (or DEBUG / tests). Only staging.py turns it on.
ALLOW_STUB_PAYMENTS = False

# Monnify (real payments). All empty by default; prod.py refuses to start without them when PAYMENT_PROVIDER=monnify.
MONNIFY_BASE_URL = env("MONNIFY_BASE_URL", default="https://sandbox.monnify.com")  # live: https://api.monnify.com
MONNIFY_API_KEY = env("MONNIFY_API_KEY", default="")
MONNIFY_SECRET_KEY = env("MONNIFY_SECRET_KEY", default="")
MONNIFY_CONTRACT_CODE = env("MONNIFY_CONTRACT_CODE", default="")
MONNIFY_REDIRECT_URL = env("MONNIFY_REDIRECT_URL", default="")
MONNIFY_SOURCE_ACCOUNT_NUMBER = env("MONNIFY_SOURCE_ACCOUNT_NUMBER", default="")

# Encrypts stored bank details. Comma-separated Fernet keys; the FIRST encrypts, all decrypt (for rotation).
# Generate: python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
PAYOUT_ENCRYPTION_KEYS = env("PAYOUT_ENCRYPTION_KEYS", default="")
PAYOUT_FINGERPRINT_KEY = env("PAYOUT_FINGERPRINT_KEY", default="")  # falls back to SECRET_KEY if empty

# Encrypts chat message text and two-factor secrets at rest (apps.common.fields.EncryptedTextField).
# Comma-separated Fernet keys; the FIRST encrypts, all decrypt (for rotation: prepend a new key, run
# `python manage.py rotate_field_encryption`, then drop the old one). Generate one with:
#   python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
# If empty, a key is derived from SECRET_KEY (fine for dev/tests; prod.py refuses to start without a real key).
# KEEP A BACKUP OF THIS KEY: without it, stored messages cannot be read.
FIELD_ENCRYPTION_KEYS = env("FIELD_ENCRYPTION_KEYS", default="")

# Business limits (all optional)
PAYOUT_ACCOUNT_COOLDOWN_HOURS = env.int("PAYOUT_ACCOUNT_COOLDOWN_HOURS", default=24)
MAX_DAILY_WITHDRAWAL = env("MAX_DAILY_WITHDRAWAL", default="500000.00")
MAX_PAYOUT_ACCOUNTS = env.int("MAX_PAYOUT_ACCOUNTS", default=5)
GIFT_EXPIRY_DAYS = env.int("GIFT_EXPIRY_DAYS", default=7)

# --- Data retention (enforced by `manage.py purge_expired_media`, run every 15 min) ---
# Status posts (apps.square) live 24h. Rows AND files are deleted once they pass this age.
STATUS_RETENTION_HOURS = env.int("STATUS_RETENTION_HOURS", default=24)
# Chat media of these kinds is deleted this many days after it was sent. Chat has no "video" kind yet
# (only "image" and "audio"); add "image" / "audio" here (comma-separated) to expire those as well.
CHAT_MEDIA_RETENTION_DAYS = env.int("CHAT_MEDIA_RETENTION_DAYS", default=14)
CHAT_MEDIA_PURGE_KINDS = env.list("CHAT_MEDIA_PURGE_KINDS", default=["video"])


# --- Email ---
# Where the React site lives. Used to build the links inside emails (verify email, reset password).
FRONTEND_URL = env("FRONTEND_URL", default="http://localhost:5173")

# With RESEND_API_KEY set, email goes out through Resend's HTTP API (works on hosts that block SMTP).
# Without it, dev/staging print emails in the log and prod falls back to SMTP (see each settings file).
RESEND_API_KEY = env("RESEND_API_KEY", default="")
if RESEND_API_KEY:
    INSTALLED_APPS += ["anymail"]
    EMAIL_BACKEND = "anymail.backends.resend.EmailBackend"
    ANYMAIL = {"RESEND_API_KEY": RESEND_API_KEY}
EMAIL_TIMEOUT = env.int("EMAIL_TIMEOUT", default=10)  # seconds: a slow mail service must not hang a request

EMAIL_HOST = env("EMAIL_HOST", default="")
EMAIL_PORT = env.int("EMAIL_PORT", default=587)
EMAIL_HOST_USER = env("EMAIL_HOST_USER", default="")
EMAIL_HOST_PASSWORD = env("EMAIL_HOST_PASSWORD", default="")
EMAIL_USE_TLS = env.bool("EMAIL_USE_TLS", default=True)
DEFAULT_FROM_EMAIL = env("DEFAULT_FROM_EMAIL", default="no-reply@example.com")

# --- Logging: never log secrets/passwords ---
LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {
        "verbose": {
            "format": "{asctime} {levelname} {name} {message}",
            "style": "{",
        },
    },
    "handlers": {
        "console": {"class": "logging.StreamHandler", "formatter": "verbose"},
    },
    "root": {"handlers": ["console"], "level": "INFO"},
    "loggers": {
        "django": {"handlers": ["console"], "level": "INFO", "propagate": False},
        "django.security": {"handlers": ["console"], "level": "WARNING", "propagate": False},
        "apps": {"handlers": ["console"], "level": "INFO", "propagate": False},
    },
}


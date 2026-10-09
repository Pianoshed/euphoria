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
    "django.contrib.sessions.middleware.SessionMiddleware",
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
DATABASES["default"].setdefault("CONN_MAX_AGE", 60)
# Drop dead connections (e.g. after a Render Postgres restart) instead of reusing them. Django 4.1+.
DATABASES["default"]["CONN_HEALTH_CHECKS"] = True

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

CHANNEL_LAYERS = {
    "default": {
        "BACKEND": "channels_redis.core.RedisChannelLayer",
        "CONFIG": {"hosts": [env("REDIS_URL")]},
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
SESSION_SAVE_EVERY_REQUEST = True
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


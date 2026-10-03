from .base import *  # noqa: F401,F403

DEBUG = True

EMAIL_BACKEND = "django.core.mail.backends.console.EmailBackend"

SESSION_COOKIE_SECURE = False
CSRF_COOKIE_SECURE = False

CSRF_TRUSTED_ORIGINS = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
]
GOOGLE_CLIENT_ID = env("GOOGLE_CLIENT_ID")
GOOGLE_CLIENT_SECRET = env("GOOGLE_CLIENT_SECRET")
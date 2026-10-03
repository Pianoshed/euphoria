# syntax=docker/dockerfile:1

# --- Builder: compile wheels for anything needing a C toolchain ------------
FROM python:3.12-slim AS builder

WORKDIR /build

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libpq-dev \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip wheel --no-cache-dir --wheel-dir /wheels -r requirements.txt

# --- Runtime: slim image, no compilers, non-root user ----------------------
FROM python:3.12-slim AS runtime

# libpq5 (not -dev) is the runtime-only Postgres client library psycopg needs.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq5 \
    curl \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd --gid 1000 app && useradd --uid 1000 --gid app --shell /bin/bash --create-home app

WORKDIR /app

COPY --from=builder /wheels /wheels
COPY requirements.txt .
RUN pip install --no-cache-dir --no-index --find-links=/wheels -r requirements.txt \
    && rm -rf /wheels

COPY --chown=app:app . .

RUN mkdir -p /app/staticfiles /app/media && chown -R app:app /app/staticfiles /app/media

USER app

ENV DJANGO_SETTINGS_MODULE=config.settings.prod \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -f http://localhost:8000/healthz/ || exit 1

# Daphne serves both HTTP and WebSocket from the same ASGI app -- see
# config/asgi.py. Migrations and collectstatic are run as separate,
# explicit one-off steps (see DEPLOYMENT.md), never automatically in
# this entrypoint -- an image starting up should never silently alter
# the database or its own static files as a side effect of a restart.
CMD ["daphne", "-b", "0.0.0.0", "-p", "8000", "config.asgi:application"]

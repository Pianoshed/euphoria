# Deployment Runbook

This covers running this project with `docker-compose.prod.yml` on a
single host. It is a reasonable starting point, not a full
cloud-native setup -- see the "What this isn't" section at the bottom
for what a real production environment should add on top.

## First deploy

1. Provision a host, install Docker + Docker Compose.
2. Copy `.env.example` to `.env` and fill in every value -- at minimum:
   `DJANGO_SECRET_KEY` (long, random, unique to this environment),
   `DJANGO_ALLOWED_HOSTS` (your real domain), `CSRF_TRUSTED_ORIGINS`,
   `POSTGRES_PASSWORD`, `PAYMENT_PROVIDER` (a real one -- `prod.py`
   refuses to start with `stub`), `STUB_PAYMENT_WEBHOOK_SECRET` (or
   your real provider's webhook secret, once one is integrated).
3. Point DNS at the host.
4. `docker compose -f docker-compose.prod.yml --env-file .env up -d --build`
5. Run migrations (see below) -- **the app container does NOT run
   migrations automatically on startup**. That's intentional: a
   container restarting (crash, redeploy, autoscaling event) should
   never silently alter the schema as a side effect.
6. `docker compose -f docker-compose.prod.yml exec app python manage.py collectstatic --noinput`
7. `docker compose -f docker-compose.prod.yml exec app python manage.py createsuperuser`
8. Check `https://your-domain/healthz/` returns `200` with
   `{"status": "ok", ...}`.

## Routine deploys

```bash
git pull
docker compose -f docker-compose.prod.yml --env-file .env up -d --build app
docker compose -f docker-compose.prod.yml exec app python manage.py migrate
docker compose -f docker-compose.prod.yml exec app python manage.py collectstatic --noinput
curl -f https://your-domain/healthz/
```

Order matters: bring the new `app` image up first, THEN migrate. A
migration should be written to be safe to run against the previous
code version still serving traffic for the few seconds this takes
(the classic "expand, deploy, contract" pattern for anything more
involved than adding a nullable column -- not something this project's
migrations have needed yet, but worth knowing before writing one that
renames or drops a column a running process still reads).

## Rollback

```bash
git checkout <previous-tag-or-commit>
docker compose -f docker-compose.prod.yml --env-file .env up -d --build app
```

**Migrations are the hard part of a rollback**, not the code. Rolling
back application code is just redeploying an older image. Rolling
back a migration means running `python manage.py migrate <app>
<previous_migration_name>` -- which only works cleanly if the
migration you're undoing didn't drop a column or table containing
data you still need. Before writing a migration that removes anything,
ask whether last week's now-rolled-back-to code will still work
against a database that already has it removed -- if not, split it
into two deploys (stop reading the column first, drop it in a later
release once you're confident there's no rollback path back to code
that needs it).

## Database migrations -- specific guidance for this schema

- Every model in this project uses a UUID primary key generated
  application-side (`default=uuid.uuid4`), so adding a new table is
  always additive and safe.
- `LedgerEntry`, `BookingEvent`, `AuditLog`, and `PaymentWebhookEvent`
  are append-only by design (see their docstrings/admin
  `has_change_permission`) -- a migration should never need to alter
  historical rows in these tables. If one ever seems to need to,
  that's a sign the migration is solving the wrong problem.
- Run `python manage.py migrate --check` in CI before merging (not
  yet wired into any CI config in this repo -- there isn't one yet;
  add this check when one is set up) to catch a missing migration
  file before it reaches a deploy.

## Backups

```bash
./deploy/scripts/backup_db.sh
```

Schedule it (cron/systemd timer), e.g. daily at 03:00:
```
0 3 * * * /path/to/localserv/deploy/scripts/backup_db.sh >> /var/log/localserv-backup.log 2>&1
```

Restore:
```bash
gunzip -c backups/localserv_2026-01-01_030000.sql.gz | \
    docker compose -f docker-compose.prod.yml exec -T db psql -U "$POSTGRES_USER" "$POSTGRES_DB"
```

**If the database is a managed service** (RDS, Cloud SQL, etc.),
prefer its native automated-backup/point-in-time-recovery feature
over this script -- use the script only for a supplementary off-site
copy, not as the primary backup mechanism. This script has no offsite
replication of its own; pair it with syncing `$BACKUP_DIR` to object
storage if it's the only backup you have.

Test the restore path periodically against a throwaway database --
an untested backup is not a backup.

## Health checks & monitoring

- `GET /healthz/` -- checks database and cache connectivity, returns
  `200`/`{"status": "ok"}` or `503`/`{"status": "degraded", ...}`.
  Point your load balancer's health check and any uptime monitor at
  this. It deliberately never reveals *why* a dependency is down in
  the response body (see its docstring) -- pair it with real log
  aggregation (below) for the "why".
- The Docker image itself has a `HEALTHCHECK` (see `Dockerfile`)
  using the same endpoint, so `docker ps` / your orchestrator's own
  health status reflects it too.
- Structured JSON logs in production (see `config/settings/prod.py`)
  are meant to be shipped somewhere queryable -- CloudWatch Logs,
  Loki, ELK, etc. This repo doesn't set up log shipping itself (that's
  infra-specific); point your container runtime's log driver at
  whichever aggregator you use.
- Set `SENTRY_DSN` (see `.env.example`) to get exception tracking with
  no code changes -- it's a no-op if unset.

## What this isn't

This gets a single-host Docker Compose deployment running safely. It
does not include, and a real production environment should add:

- **A CDN/WAF in front of nginx** for real volumetric DDoS absorption
  -- nginx here helps, but the app's own rate-limiting docs are
  explicit that it isn't a substitute for one.
- **A managed database** with automated backups/PITR/failover, rather
  than a single Postgres container on the same host as the app.
- **Multiple app replicas** behind a real load balancer, rather than
  nginx proxying to a single `app` container -- the `upstream app {}`
  block in `deploy/nginx/app.conf` is ready for more `server` lines,
  but nothing here auto-scales or auto-heals a dead container the way
  Kubernetes/ECS/etc would.
- **Object storage (S3-compatible) for `media/`** rather than a local
  Docker volume, once running more than one app replica -- a local
  volume is only visible to the container that wrote to it.
- **A CI pipeline** running the test suite, `pip-audit`, and
  `manage.py check --deploy` on every change before it reaches this
  runbook at all.

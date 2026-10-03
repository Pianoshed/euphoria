#!/usr/bin/env bash
#
# Backs up the Postgres database used by docker-compose.prod.yml.
#
# This is a reasonable starting point for a self-hosted deployment,
# NOT a replacement for a managed database's automated backups
# (RDS/Cloud SQL/etc snapshots, point-in-time recovery). If the
# database is on a managed service, prefer that service's native
# backup/PITR feature over this script and use this only as a
# supplementary off-site copy.
#
# Usage: ./deploy/scripts/backup_db.sh
# Schedule via cron, e.g.: 0 3 * * * /path/to/backup_db.sh >> /var/log/localserv-backup.log 2>&1
#
# Restore: gunzip -c backups/localserv_2026-01-01_030000.sql.gz | \
#   docker compose -f docker-compose.prod.yml exec -T db psql -U "$POSTGRES_USER" "$POSTGRES_DB"

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
BACKUP_DIR="${BACKUP_DIR:-$PROJECT_ROOT/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"

# shellcheck disable=SC1091
[ -f "$PROJECT_ROOT/.env" ] && source "$PROJECT_ROOT/.env"

POSTGRES_DB="${POSTGRES_DB:?POSTGRES_DB is required (set in .env)}"
POSTGRES_USER="${POSTGRES_USER:?POSTGRES_USER is required (set in .env)}"

mkdir -p "$BACKUP_DIR"
timestamp="$(date -u +%Y-%m-%d_%H%M%S)"
outfile="$BACKUP_DIR/localserv_${timestamp}.sql.gz"

echo "Backing up '$POSTGRES_DB' to $outfile ..."
docker compose -f "$PROJECT_ROOT/docker-compose.prod.yml" exec -T db \
    pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" | gzip > "$outfile"

echo "Backup complete: $(du -h "$outfile" | cut -f1)"

echo "Pruning backups older than $RETENTION_DAYS days ..."
find "$BACKUP_DIR" -name 'localserv_*.sql.gz' -mtime "+$RETENTION_DAYS" -print -delete

echo "Done."

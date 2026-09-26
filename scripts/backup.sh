#!/usr/bin/env bash
# Antu Boutique CRM — nightly backup (PRD §4.18: "Nightly pg_dump backup —
# non-negotiable", §7: retention 14 days, to a separate location).
#
# What it does, in order:
#   1. pg_dump the database (custom format, compressed) and check the dump
#      can be read back (pg_restore --list).
#   2. tar the uploads folder (product photos, order reference images,
#      invoices, receipts) — the database points at those files.
#   3. Optionally copy both off the server (rclone), if BACKUP_RCLONE_REMOTE is set.
#   4. Delete local (and remote) backups older than BACKUP_RETENTION_DAYS —
#      only after today's dump succeeded, so a failing backup never eats the
#      last good ones.
#   5. Report the run to the app (POST /api/cron/backup-report), success or
#      failure. Settings shows it; admins see a banner after 48 h without one.
#
# It only ever READS the database. It never restores, drops or resets
# anything (CLAUDE.md rule 11) — restoring is a manual, owner-approved step
# into a NEW database; see docs/BACKUPS.md.
#
# Usage:   scripts/backup.sh [path/to/.env]      (default: the app's .env)
# Crontab: 0 21 * * * /srv/antu-crm/scripts/backup.sh >> /var/log/antu-backup.log 2>&1
#          (21:00 UTC = 03:00 Dhaka, the quietest hour)
#
# Settings it reads (from the env file or the environment):
#   DIRECT_URL              the Neon *direct* (non-pooler) connection string
#   BACKUP_DIR              where backups go, e.g. /var/backups/antu-crm (required)
#   UPLOAD_DIR              the app's uploads folder (as in the app's .env)
#   CRON_SECRET             to report the run to the app
#   BACKUP_REPORT_URL       the app's base URL (default: NEXTAUTH_URL)
#   BACKUP_RETENTION_DAYS   default 14
#   BACKUP_RCLONE_REMOTE    optional, e.g. "b2:antu-backups" — copies off the server
#   PG_DUMP / PG_RESTORE    optional paths to a pg_dump/pg_restore at least as new
#                           as the server (Neon runs PostgreSQL 18)

set -Eeuo pipefail
umask 077

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${1:-$APP_DIR/.env}"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

DB_URL="${DIRECT_URL:-${DATABASE_URL:-}}"
BACKUP_DIR="${BACKUP_DIR:-}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
REPORT_BASE="${BACKUP_REPORT_URL:-${NEXTAUTH_URL:-}}"
PG_DUMP="${PG_DUMP:-pg_dump}"
PG_RESTORE="${PG_RESTORE:-pg_restore}"
UPLOADS="${UPLOAD_DIR:-./public/uploads}"
[[ "$UPLOADS" = /* ]] || UPLOADS="$APP_DIR/${UPLOADS#./}"

STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
HOST="$(hostname -s 2>/dev/null || hostname)"
DUMP_FILE="antu-db-$STAMP.dump"
UPLOADS_FILE="antu-uploads-$STAMP.tar.gz"
LOG_FILE="$(mktemp -t antu-backup.XXXXXX)"
LOCK_DIR="${BACKUP_DIR:-/tmp}/.antu-backup.lock"
REPORTED=0

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

size_of() { wc -c <"$1" | tr -d ' '; }

# Builds the JSON with node (always on the app server) so an error message
# with quotes or newlines can't break it.
report() {
  local ok="$1" error="${2:-}"
  REPORTED=1
  if [[ -z "$REPORT_BASE" || -z "${CRON_SECRET:-}" ]]; then
    log "WARN: BACKUP_REPORT_URL/NEXTAUTH_URL or CRON_SECRET not set — the app won't know about this run"
    return 0
  fi
  local body
  body="$(
    OK="$ok" ERR="$error" STARTED_AT="$STARTED_AT" HOST="$HOST" DUMP_FILE="${DUMP_DONE:-}" DUMP_BYTES="${DUMP_BYTES:-}" \
    UP_FILE="${UPLOADS_DONE:-}" UP_BYTES="${UPLOADS_BYTES:-}" OFFSITE="${OFFSITE:-off}" PRUNED="${PRUNED:-0}" KEPT="${KEPT:-}" \
    node -e '
      const e = process.env, n = (v) => (v === undefined || v === "" ? undefined : Number(v));
      const r = { ok: e.OK === "true", startedAt: e.STARTED_AT, finishedAt: new Date().toISOString(), host: e.HOST || undefined,
        file: e.DUMP_FILE || undefined, sizeBytes: n(e.DUMP_BYTES), uploadsFile: e.UP_FILE || undefined, uploadsBytes: n(e.UP_BYTES),
        offsite: e.OFFSITE, pruned: n(e.PRUNED), kept: n(e.KEPT), error: e.ERR ? e.ERR.slice(-1900) : undefined };
      process.stdout.write(JSON.stringify(r));'
  )"
  if curl -fsS -m 30 -X POST -H "Authorization: Bearer $CRON_SECRET" -H "Content-Type: application/json" \
    --data "$body" "${REPORT_BASE%/}/api/cron/backup-report" >/dev/null; then
    log "Reported to the app"
  else
    log "WARN: could not report to the app (is it running?) — Settings will show this backup as missing"
  fi
}

fail() {
  local message="$1"
  log "BACKUP FAILED: $message"
  [[ $REPORTED -eq 1 ]] || report false "$message"
  exit 1
}

on_error() {
  local detail
  detail="$(tail -n 5 "$LOG_FILE" 2>/dev/null | tr '\n' ' ')"
  fail "step failed at line $1${detail:+: $detail}"
}
trap 'on_error $LINENO' ERR
trap 'rm -f "$LOG_FILE"; rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

# ── Checks ────────────────────────────────────────────────────────────────
[[ -n "$BACKUP_DIR" ]] || fail "BACKUP_DIR is not set"
[[ -n "$DB_URL" ]] || fail "DIRECT_URL (or DATABASE_URL) is not set"
[[ "$RETENTION_DAYS" =~ ^[0-9]+$ && "$RETENTION_DAYS" -ge 1 ]] || fail "BACKUP_RETENTION_DAYS must be a whole number of days"
command -v "$PG_DUMP" >/dev/null || fail "pg_dump not found (install postgresql-client-18, or set PG_DUMP)"
command -v "$PG_RESTORE" >/dev/null || fail "pg_restore not found (set PG_RESTORE)"
mkdir -p "$BACKUP_DIR"
mkdir "$LOCK_DIR" 2>/dev/null || { REPORTED=1; log "Another backup is still running — skipping"; trap - EXIT; exit 0; }

# pg_dump refuses a server newer than itself; say so plainly instead.
if command -v psql >/dev/null; then
  SERVER_MAJOR="$(psql "$DB_URL" -Atc 'show server_version_num' 2>>"$LOG_FILE" | cut -c1-2 || true)"
  CLIENT_MAJOR="$("$PG_DUMP" --version | sed -E 's/[^0-9]*([0-9]+).*/\1/')"
  if [[ -n "$SERVER_MAJOR" && "$CLIENT_MAJOR" -lt "$SERVER_MAJOR" ]]; then
    fail "pg_dump $CLIENT_MAJOR is older than the database (PostgreSQL $SERVER_MAJOR) — install postgresql-client-$SERVER_MAJOR"
  fi
fi

# ── 1. Database ───────────────────────────────────────────────────────────
log "Dumping the database to $BACKUP_DIR/$DUMP_FILE"
"$PG_DUMP" --format=custom --compress=9 --no-owner --no-privileges --file="$BACKUP_DIR/$DUMP_FILE.part" "$DB_URL" 2>>"$LOG_FILE"
"$PG_RESTORE" --list "$BACKUP_DIR/$DUMP_FILE.part" >/dev/null 2>>"$LOG_FILE"
mv "$BACKUP_DIR/$DUMP_FILE.part" "$BACKUP_DIR/$DUMP_FILE"
DUMP_DONE="$DUMP_FILE"
DUMP_BYTES="$(size_of "$BACKUP_DIR/$DUMP_FILE")"
[[ "$DUMP_BYTES" -gt 0 ]] || fail "the dump is empty"
log "Database dump OK ($DUMP_BYTES bytes)"

# ── 2. Uploads ────────────────────────────────────────────────────────────
if [[ -d "$UPLOADS" ]]; then
  tar -czf "$BACKUP_DIR/$UPLOADS_FILE.part" -C "$(dirname "$UPLOADS")" "$(basename "$UPLOADS")" 2>>"$LOG_FILE"
  mv "$BACKUP_DIR/$UPLOADS_FILE.part" "$BACKUP_DIR/$UPLOADS_FILE"
  UPLOADS_DONE="$UPLOADS_FILE"
  UPLOADS_BYTES="$(size_of "$BACKUP_DIR/$UPLOADS_FILE")"
  log "Uploads archived ($UPLOADS_BYTES bytes)"
else
  log "WARN: uploads folder $UPLOADS not found — skipped"
fi

# ── 3. Off the server ─────────────────────────────────────────────────────
OFFSITE="off"
if [[ -n "${BACKUP_RCLONE_REMOTE:-}" ]]; then
  if command -v rclone >/dev/null &&
    rclone copy "$BACKUP_DIR" "$BACKUP_RCLONE_REMOTE" --include "antu-*-$STAMP.*" 2>>"$LOG_FILE" &&
    rclone delete "$BACKUP_RCLONE_REMOTE" --include "antu-*" --min-age "${RETENTION_DAYS}d" 2>>"$LOG_FILE"; then
    OFFSITE="copied"
    log "Copied to $BACKUP_RCLONE_REMOTE"
  else
    OFFSITE="failed"
    log "WARN: off-server copy to $BACKUP_RCLONE_REMOTE failed"
  fi
fi

# ── 4. Retention (only after a good dump) ─────────────────────────────────
PRUNED="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'antu-*' -mtime "+$((RETENTION_DAYS - 1))" -print | wc -l | tr -d ' ')"
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'antu-*' -mtime "+$((RETENTION_DAYS - 1))" -delete
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'antu-*.part' -mmin +720 -delete
KEPT="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'antu-db-*.dump' | wc -l | tr -d ' ')"
log "Retention: removed $PRUNED old file(s), $KEPT database backup(s) kept"

# ── 5. Tell the app ───────────────────────────────────────────────────────
if [[ "$OFFSITE" == "failed" ]]; then
  report false "Backed up on the server ($DUMP_FILE), but the off-server copy to $BACKUP_RCLONE_REMOTE failed: $(tail -n 3 "$LOG_FILE" | tr '\n' ' ')"
  exit 1
fi
report true
log "Backup complete"

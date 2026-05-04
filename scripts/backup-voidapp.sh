#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  ./scripts/backup-voidapp.sh [--no-archive]

Environment:
  VOIDAPP_ENV_FILE=/path/to/VOID0000-api/.env
  VOIDAPP_BACKUP_DIR=/path/to/backup-root
  VOIDAPP_BACKUP_SKIP_POSTGRES=1
  VOIDAPP_BACKUP_SKIP_SCYLLA=1
  VOIDAPP_BACKUP_SKIP_MINIO=1
  VOIDAPP_BACKUP_SKIP_VALKEY=1
  VOIDAPP_MINIO_DATA_DIR=/path/to/minio-data

What it backs up:
  - PostgreSQL with pg_dump custom format
  - ScyllaDB tables with cqlsh COPY
  - MinIO buckets with mc mirror, or local minio-data fallback
  - Valkey RDB snapshot when valkey-cli/redis-cli supports it

Notes:
  This is a simple hobby-server backup helper. For huge Scylla datasets, replace
  the cqlsh COPY part with proper Scylla snapshots/backup tooling.
USAGE
}

NO_ARCHIVE=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --no-archive)
      NO_ARCHIVE=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="${VOIDAPP_ENV_FILE:-$APP_ROOT/VOID0000-api/.env}"
BACKUP_ROOT="${VOIDAPP_BACKUP_DIR:-$HOME/voidapp-backups}"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_NAME="voidapp-$TIMESTAMP"
BACKUP_DIR="$BACKUP_ROOT/$BACKUP_NAME"
WARNINGS_FILE="$BACKUP_DIR/WARNINGS.txt"
MANIFEST_FILE="$BACKUP_DIR/MANIFEST.txt"

mkdir -p "$BACKUP_DIR"
: > "$WARNINGS_FILE"

log() {
  printf '[backup] %s\n' "$*"
}

warn() {
  printf '[backup] WARN: %s\n' "$*" >&2
  printf '%s\n' "$*" >> "$WARNINGS_FILE"
}

have_cmd() {
  command -v "$1" >/dev/null 2>&1
}

source_env_file() {
  if [ ! -f "$ENV_FILE" ]; then
    warn "Env file not found: $ENV_FILE. Falling back to process/default env values."
    return
  fi

  set -a
  # Strip CRLF safely so env files edited on Windows do not break bash source.
  # shellcheck disable=SC1090
  source <(sed 's/\r$//' "$ENV_FILE")
  set +a
}

write_manifest() {
  {
    echo "backup_name=$BACKUP_NAME"
    echo "created_at_utc=$TIMESTAMP"
    echo "host=$(hostname)"
    echo "app_root=$APP_ROOT"
    echo "env_file=$ENV_FILE"
    echo "git_commit=$(git -C "$APP_ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
    echo "git_branch=$(git -C "$APP_ROOT" branch --show-current 2>/dev/null || echo unknown)"
    echo "postgres_database=${PGDATABASE:-unset}"
    echo "scylla_keyspace=${SCYLLA_KEYSPACE:-voidapp}"
    echo "minio_buckets=${MINIO_BUCKET:-avatars} ${MINIO_GROUP_AVATAR_BUCKET:-group-avatars} ${MINIO_ATTACH_BUCKET:-chat-attachments}"
    echo "valkey_host=${VALKEY_HOST:-127.0.0.1}"
  } > "$MANIFEST_FILE"
}

backup_postgres() {
  if [ "${VOIDAPP_BACKUP_SKIP_POSTGRES:-0}" = "1" ]; then
    warn "Skipping PostgreSQL backup because VOIDAPP_BACKUP_SKIP_POSTGRES=1."
    return
  fi

  if ! have_cmd pg_dump; then
    warn "pg_dump not found. PostgreSQL backup skipped."
    return
  fi

  local out_dir="$BACKUP_DIR/postgres"
  mkdir -p "$out_dir"

  local host="${PGHOST:-127.0.0.1}"
  local port="${PGPORT:-5432}"
  local user="${PGUSER:-postgres}"
  local database="${PGDATABASE:-void-app}"
  local password="${PGPASSWORD:-}"

  log "Backing up PostgreSQL database $database..."
  PGPASSWORD="$password" pg_dump \
    -h "$host" \
    -p "$port" \
    -U "$user" \
    -d "$database" \
    -Fc \
    -f "$out_dir/$database.dump"

  PGPASSWORD="$password" pg_dump \
    -h "$host" \
    -p "$port" \
    -U "$user" \
    -d "$database" \
    --schema-only \
    -f "$out_dir/schema.sql"

  if have_cmd pg_dumpall; then
    PGPASSWORD="$password" pg_dumpall \
      -h "$host" \
      -p "$port" \
      -U "$user" \
      --globals-only \
      -f "$out_dir/globals.sql" || warn "pg_dumpall --globals-only failed. Database dump still exists."
  fi
}

backup_scylla() {
  if [ "${VOIDAPP_BACKUP_SKIP_SCYLLA:-0}" = "1" ]; then
    warn "Skipping Scylla backup because VOIDAPP_BACKUP_SKIP_SCYLLA=1."
    return
  fi

  if ! have_cmd cqlsh; then
    warn "cqlsh not found. Scylla backup skipped."
    return
  fi

  local out_dir="$BACKUP_DIR/scylla"
  mkdir -p "$out_dir"

  local host="${SCYLLA_HOST:-127.0.0.1}"
  host="${host%%,*}"
  local port="${SCYLLA_PORT:-9042}"
  local keyspace="${SCYLLA_KEYSPACE:-voidapp}"
  local tables=(
    messages
    message_edits
    message_reactions
    user_reactions
    reaction_counts
  )

  log "Backing up Scylla keyspace $keyspace with cqlsh COPY..."
  cqlsh "$host" "$port" -e "DESCRIBE KEYSPACE $keyspace;" > "$out_dir/schema.cql" || {
    warn "Could not export Scylla schema for $keyspace."
  }

  local table
  for table in "${tables[@]}"; do
    local csv="$out_dir/$table.csv"
    log "Exporting Scylla table $keyspace.$table..."
    if ! cqlsh "$host" "$port" -e "COPY $keyspace.$table TO '$csv' WITH HEADER = TRUE;"; then
      warn "Scylla export failed for $keyspace.$table."
    fi
  done
}

backup_minio() {
  if [ "${VOIDAPP_BACKUP_SKIP_MINIO:-0}" = "1" ]; then
    warn "Skipping MinIO backup because VOIDAPP_BACKUP_SKIP_MINIO=1."
    return
  fi

  local out_dir="$BACKUP_DIR/minio"
  mkdir -p "$out_dir"

  local bucket_avatar="${MINIO_BUCKET:-avatars}"
  local bucket_group="${MINIO_GROUP_AVATAR_BUCKET:-group-avatars}"
  local bucket_attach="${MINIO_ATTACH_BUCKET:-chat-attachments}"

  if have_cmd mc; then
    local endpoint="${MINIO_URL:-http://${MINIO_ENDPOINT:-127.0.0.1}:${MINIO_PORT:-9000}}"
    local access_key="${MINIO_ACCESS_KEY:-minioadmin}"
    local secret_key="${MINIO_SECRET_KEY:-minioadmin}"
    local alias_name="voidapp-backup-$TIMESTAMP"

    log "Backing up MinIO buckets with mc mirror..."
    mc alias set "$alias_name" "$endpoint" "$access_key" "$secret_key" >/dev/null

    local bucket
    for bucket in "$bucket_avatar" "$bucket_group" "$bucket_attach"; do
      log "Mirroring MinIO bucket $bucket..."
      if ! mc mirror --overwrite "$alias_name/$bucket" "$out_dir/$bucket"; then
        warn "MinIO mirror failed for bucket $bucket."
      fi
    done

    mc alias remove "$alias_name" >/dev/null 2>&1 || true
    return
  fi

  local minio_data_dir="${VOIDAPP_MINIO_DATA_DIR:-$APP_ROOT/minio-data}"
  if [ -d "$minio_data_dir" ] && have_cmd rsync; then
    warn "mc command not found. Falling back to raw local MinIO data copy from $minio_data_dir."
    rsync -a "$minio_data_dir/" "$out_dir/raw-minio-data/"
    return
  fi

  warn "Could not back up MinIO. Install mc or set VOIDAPP_MINIO_DATA_DIR to a readable local data directory."
}

valkey_cli() {
  if have_cmd valkey-cli; then
    printf 'valkey-cli'
    return
  fi

  if have_cmd redis-cli; then
    printf 'redis-cli'
    return
  fi
}

backup_valkey() {
  if [ "${VOIDAPP_BACKUP_SKIP_VALKEY:-0}" = "1" ]; then
    warn "Skipping Valkey backup because VOIDAPP_BACKUP_SKIP_VALKEY=1."
    return
  fi

  local cli
  cli="$(valkey_cli || true)"
  if [ -z "$cli" ]; then
    warn "valkey-cli/redis-cli not found. Valkey backup skipped."
    return
  fi

  local out_dir="$BACKUP_DIR/valkey"
  mkdir -p "$out_dir"

  local host="${VALKEY_HOST:-127.0.0.1}"
  local port="${VALKEY_PORT:-6379}"

  log "Capturing Valkey metadata..."
  "$cli" -h "$host" -p "$port" INFO > "$out_dir/info.txt" || warn "Could not capture Valkey INFO."
  "$cli" -h "$host" -p "$port" CONFIG GET '*' > "$out_dir/config.txt" || warn "Could not capture Valkey CONFIG."

  if "$cli" --help 2>&1 | grep -q -- '--rdb'; then
    log "Requesting Valkey RDB stream backup..."
    "$cli" -h "$host" -p "$port" --rdb "$out_dir/dump.rdb" || warn "Valkey --rdb backup failed."
  else
    warn "$cli does not advertise --rdb support. Valkey data file was not copied."
  fi
}

create_archive() {
  if [ "$NO_ARCHIVE" -eq 1 ]; then
    log "Skipping archive because --no-archive was provided."
    return
  fi

  local archive="$BACKUP_ROOT/$BACKUP_NAME.tar.gz"
  log "Creating archive $archive..."
  tar -C "$BACKUP_ROOT" -czf "$archive" "$BACKUP_NAME"
  sha256sum "$archive" > "$archive.sha256"
}

source_env_file

: "${PGHOST:=127.0.0.1}"
: "${PGPORT:=5432}"
: "${PGUSER:=postgres}"
: "${PGDATABASE:=void-app}"
: "${SCYLLA_HOST:=127.0.0.1}"
: "${SCYLLA_PORT:=9042}"
: "${SCYLLA_KEYSPACE:=voidapp}"
: "${MINIO_ENDPOINT:=127.0.0.1}"
: "${MINIO_PORT:=9000}"
: "${VALKEY_HOST:=127.0.0.1}"
: "${VALKEY_PORT:=6379}"

write_manifest
backup_postgres
backup_scylla
backup_minio
backup_valkey
create_archive

log "Backup directory: $BACKUP_DIR"
if [ "$NO_ARCHIVE" -eq 0 ]; then
  log "Backup archive:   $BACKUP_ROOT/$BACKUP_NAME.tar.gz"
fi

if [ -s "$WARNINGS_FILE" ]; then
  log "Backup completed with warnings. Read: $WARNINGS_FILE"
else
  rm -f "$WARNINGS_FILE"
  log "Backup completed without warnings."
fi

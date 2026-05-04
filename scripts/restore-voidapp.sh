#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  ./scripts/restore-voidapp.sh --backup PATH --dry-run --all
  ./scripts/restore-voidapp.sh --backup PATH --postgres --scylla --minio --yes

Backup PATH can be:
  - a backup directory, like ~/voidapp-backups/voidapp-YYYYMMDDTHHMMSSZ
  - a .tar.gz archive made by scripts/backup-voidapp.sh

Service choices:
  --all
  --postgres
  --scylla
  --minio
  --valkey

Safety:
  --dry-run              Show what would happen without changing data.
  --yes                  Actually run restore commands without prompt.
  --allow-running-app    Do not block if PM2 apps appear online.
  --truncate-scylla      TRUNCATE Scylla tables before COPY FROM.

Environment:
  VOIDAPP_ENV_FILE=/path/to/VOID0000-api/.env
  VOIDAPP_MINIO_ALIAS=voidapp-restore-local

Notes:
  Restore is destructive when pointed at live data. Prefer testing on a throwaway
  machine or Docker stack first.
USAGE
}

BACKUP_PATH=""
RESTORE_POSTGRES=0
RESTORE_SCYLLA=0
RESTORE_MINIO=0
RESTORE_VALKEY=0
DRY_RUN=0
YES=0
ALLOW_RUNNING_APP=0
TRUNCATE_SCYLLA=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --backup)
      BACKUP_PATH="${2:-}"
      shift 2
      ;;
    --all)
      RESTORE_POSTGRES=1
      RESTORE_SCYLLA=1
      RESTORE_MINIO=1
      RESTORE_VALKEY=1
      shift
      ;;
    --postgres)
      RESTORE_POSTGRES=1
      shift
      ;;
    --scylla)
      RESTORE_SCYLLA=1
      shift
      ;;
    --minio)
      RESTORE_MINIO=1
      shift
      ;;
    --valkey)
      RESTORE_VALKEY=1
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --yes)
      YES=1
      shift
      ;;
    --allow-running-app)
      ALLOW_RUNNING_APP=1
      shift
      ;;
    --truncate-scylla)
      TRUNCATE_SCYLLA=1
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
TMP_DIR=""

cleanup() {
  if [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ]; then
    rm -rf "$TMP_DIR"
  fi
}
trap cleanup EXIT

log() {
  printf '[restore] %s\n' "$*"
}

fail() {
  printf '[restore] ERROR: %s\n' "$*" >&2
  exit 1
}

have_cmd() {
  command -v "$1" >/dev/null 2>&1
}

shell_quote() {
  printf '%q' "$1"
}

source_env_file() {
  if [ ! -f "$ENV_FILE" ]; then
    log "Env file not found: $ENV_FILE. Falling back to process/default env values."
    return
  fi

  set -a
  # Strip CRLF safely so env files edited on Windows do not break bash source.
  # shellcheck disable=SC1090
  source <(sed 's/\r$//' "$ENV_FILE")
  set +a
}

resolve_backup_dir() {
  [ -n "$BACKUP_PATH" ] || fail "Missing --backup PATH."

  if [ -d "$BACKUP_PATH" ]; then
    BACKUP_DIR="$(cd "$BACKUP_PATH" && pwd)"
    return
  fi

  if [ -f "$BACKUP_PATH" ] && [[ "$BACKUP_PATH" == *.tar.gz ]]; then
    TMP_DIR="$(mktemp -d)"
    log "Extracting backup archive to temporary directory..."
    tar -C "$TMP_DIR" -xzf "$BACKUP_PATH"
    local first_dir
    first_dir="$(find "$TMP_DIR" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
    [ -n "$first_dir" ] || fail "Archive did not contain a backup directory."
    BACKUP_DIR="$first_dir"
    return
  fi

  fail "Backup path is not a directory or .tar.gz archive: $BACKUP_PATH"
}

run_cmd() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '[restore] DRY RUN:'
    local arg
    for arg in "$@"; do
      printf ' %q' "$arg"
    done
    printf '\n'
    return 0
  fi

  "$@"
}

run_cmd_masked() {
  local display_cmd="$1"
  shift

  if [ "$DRY_RUN" -eq 1 ]; then
    printf '[restore] DRY RUN: %s\n' "$display_cmd"
    return 0
  fi

  "$@"
}

require_component_selection() {
  if [ "$RESTORE_POSTGRES" -eq 0 ] &&
     [ "$RESTORE_SCYLLA" -eq 0 ] &&
     [ "$RESTORE_MINIO" -eq 0 ] &&
     [ "$RESTORE_VALKEY" -eq 0 ]; then
    fail "Choose at least one service: --postgres, --scylla, --minio, --valkey, or --all."
  fi
}

check_running_app() {
  if [ "$ALLOW_RUNNING_APP" -eq 1 ] || [ "$DRY_RUN" -eq 1 ]; then
    return
  fi

  if ! have_cmd pm2; then
    log "pm2 not found. Skipping running app check."
    return
  fi

  local online_count
  online_count="$(pm2 jlist 2>/dev/null | node -e '
const fs = require("fs");
let apps = [];
try { apps = JSON.parse(fs.readFileSync(0, "utf8")); } catch {}
const expected = new Set([
  "voidapp-api",
  "voidapp-message-service",
  "voidapp-conversation-service",
  "voidapp-social-profile-service",
  "voidapp-gateway-phoenix",
  "voidapp-worker-service",
]);
console.log(apps.filter((app) => expected.has(app.name) && app.pm2_env?.status === "online").length);
' || echo 0)"

  if [ "${online_count:-0}" -gt 0 ]; then
    fail "PM2 app services look online. Stop them first, or pass --allow-running-app if this is intentional."
  fi
}

confirm_restore() {
  if [ "$DRY_RUN" -eq 1 ] || [ "$YES" -eq 1 ]; then
    return
  fi

  cat >&2 <<EOF
This will restore data into configured services.

Backup:       $BACKUP_DIR
Postgres DB:  ${PGDATABASE:-void-app}
Scylla:       ${SCYLLA_KEYSPACE:-voidapp}
MinIO:        ${MINIO_ENDPOINT:-127.0.0.1}:${MINIO_PORT:-9000}
Valkey:       ${VALKEY_HOST:-127.0.0.1}:${VALKEY_PORT:-6379}

Type RESTORE to continue:
EOF

  local answer
  read -r answer
  [ "$answer" = "RESTORE" ] || fail "Restore cancelled."
}

restore_postgres() {
  if [ "$RESTORE_POSTGRES" -ne 1 ]; then
    return 0
  fi
  have_cmd pg_restore || fail "pg_restore not found."

  local database="${PGDATABASE:-void-app}"
  local dump="$BACKUP_DIR/postgres/$database.dump"
  if [ ! -f "$dump" ]; then
    local fallback
    fallback="$(find "$BACKUP_DIR/postgres" -maxdepth 1 -name '*.dump' -type f 2>/dev/null | head -n 1)"
    [ -n "$fallback" ] || fail "No PostgreSQL .dump file found in $BACKUP_DIR/postgres."
    dump="$fallback"
  fi

  log "Restoring PostgreSQL from $dump into $database..."
  export PGPASSWORD="${PGPASSWORD:-}"
  run_cmd pg_restore \
    -h "${PGHOST:-127.0.0.1}" \
    -p "${PGPORT:-5432}" \
    -U "${PGUSER:-postgres}" \
    -d "$database" \
    --clean \
    --if-exists \
    --no-owner \
    --no-privileges \
    "$dump"
}

restore_scylla() {
  if [ "$RESTORE_SCYLLA" -ne 1 ]; then
    return 0
  fi
  have_cmd cqlsh || fail "cqlsh not found."

  local host="${SCYLLA_HOST:-127.0.0.1}"
  host="${host%%,*}"
  local port="${SCYLLA_PORT:-9042}"
  local keyspace="${SCYLLA_KEYSPACE:-voidapp}"
  local schema="$BACKUP_DIR/scylla/schema.cql"
  local tables=(
    messages
    message_edits
    message_reactions
    user_reactions
    reaction_counts
  )

  [ -d "$BACKUP_DIR/scylla" ] || fail "Scylla backup folder not found: $BACKUP_DIR/scylla"

  if [ -f "$schema" ]; then
    log "Restoring Scylla schema from $schema..."
    run_cmd cqlsh "$host" "$port" -f "$schema"
  else
    log "Scylla schema.cql not found. Assuming schema already exists."
  fi

  local table
  if [ "$TRUNCATE_SCYLLA" -eq 1 ]; then
    for table in "${tables[@]}"; do
      log "Truncating Scylla table $keyspace.$table..."
      run_cmd cqlsh "$host" "$port" -e "TRUNCATE $keyspace.$table;"
    done
  fi

  for table in "${tables[@]}"; do
    local csv="$BACKUP_DIR/scylla/$table.csv"
    if [ ! -f "$csv" ]; then
      log "Skipping missing Scylla CSV: $csv"
      continue
    fi

    log "Importing Scylla table $keyspace.$table from $csv..."
    run_cmd cqlsh "$host" "$port" -e "COPY $keyspace.$table FROM '$csv' WITH HEADER = TRUE;"
  done
}

restore_minio() {
  if [ "$RESTORE_MINIO" -ne 1 ]; then
    return 0
  fi
  have_cmd mc || fail "mc command not found."

  local minio_dir="$BACKUP_DIR/minio"
  [ -d "$minio_dir" ] || fail "MinIO backup folder not found: $minio_dir"

  local endpoint="${MINIO_URL:-http://${MINIO_ENDPOINT:-127.0.0.1}:${MINIO_PORT:-9000}}"
  local access_key="${MINIO_ACCESS_KEY:-minioadmin}"
  local secret_key="${MINIO_SECRET_KEY:-minioadmin}"
  local alias_name="${VOIDAPP_MINIO_ALIAS:-voidapp-restore-local}"
  local buckets=(
    "${MINIO_BUCKET:-avatars}"
    "${MINIO_GROUP_AVATAR_BUCKET:-group-avatars}"
    "${MINIO_ATTACH_BUCKET:-chat-attachments}"
  )

  log "Preparing MinIO alias $alias_name for $endpoint..."
  run_cmd_masked "mc alias set $alias_name $endpoint ******** ********" \
    mc alias set "$alias_name" "$endpoint" "$access_key" "$secret_key"

  local bucket
  for bucket in "${buckets[@]}"; do
    if [ ! -d "$minio_dir/$bucket" ]; then
      log "Skipping missing MinIO bucket backup: $minio_dir/$bucket"
      continue
    fi

    log "Restoring MinIO bucket $bucket..."
    run_cmd mc mb --ignore-existing "$alias_name/$bucket"
    run_cmd mc mirror --overwrite "$minio_dir/$bucket" "$alias_name/$bucket"
  done
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

restore_valkey() {
  if [ "$RESTORE_VALKEY" -ne 1 ]; then
    return 0
  fi

  local rdb="$BACKUP_DIR/valkey/dump.rdb"
  [ -f "$rdb" ] || fail "Valkey dump not found: $rdb"

  local cli
  cli="$(valkey_cli || true)"

  cat <<EOF
[restore] Valkey restore is intentionally not automatic.
[restore] Backup RDB: $rdb
[restore]
[restore] Safer default for VOID: leave Valkey empty and let sessions/cache rebuild.
[restore] If you truly need it, stop Valkey, copy dump.rdb into Valkey's configured dir, then start Valkey.
EOF

  if [ -n "$cli" ]; then
    log "Current Valkey config dir/dbfilename, if reachable:"
    run_cmd "$cli" -h "${VALKEY_HOST:-127.0.0.1}" -p "${VALKEY_PORT:-6379}" CONFIG GET dir
    run_cmd "$cli" -h "${VALKEY_HOST:-127.0.0.1}" -p "${VALKEY_PORT:-6379}" CONFIG GET dbfilename
  fi
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

require_component_selection
resolve_backup_dir

[ -f "$BACKUP_DIR/MANIFEST.txt" ] || log "MANIFEST.txt not found. Continuing, but verify this is a VOID backup."

log "Backup directory: $BACKUP_DIR"
check_running_app
confirm_restore
restore_postgres
restore_scylla
restore_minio
restore_valkey

if [ "$DRY_RUN" -eq 1 ]; then
  log "Dry run complete. No data was changed."
else
  log "Restore commands completed. Run migrations and health checks before trusting the app."
fi

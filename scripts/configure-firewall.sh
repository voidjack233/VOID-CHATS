#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  sudo ./scripts/configure-firewall.sh
  ./scripts/configure-firewall.sh --dry-run

This configures a simple UFW edge firewall for a direct Nginx setup:

Allowed inbound:
  - 22/tcp   SSH
  - 80/tcp   HTTP
  - 443/tcp  HTTPS

Default:
  - deny inbound
  - allow outbound

Notes:
  - Run this from a real terminal where you can enter sudo password.
  - SSH is allowed before enabling UFW to avoid locking yourself out.
  - If you use Cloudflared only, you may not need public 80/443 at all.
USAGE
}

DRY_RUN=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
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

log() {
  printf '[firewall] %s\n' "$*"
}

run_cmd() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '[firewall] DRY RUN:'
    local arg
    for arg in "$@"; do
      printf ' %q' "$arg"
    done
    printf '\n'
    return 0
  fi

  "$@"
}

if ! command -v ufw >/dev/null 2>&1; then
  echo "ufw is not installed." >&2
  exit 1
fi

if [ "$DRY_RUN" -ne 1 ] && [ "${EUID:-$(id -u)}" -ne 0 ]; then
  echo "Run with sudo: sudo ./scripts/configure-firewall.sh" >&2
  exit 1
fi

log "Setting default firewall policy..."
run_cmd ufw default deny incoming
run_cmd ufw default allow outgoing

log "Allowing public edge ports..."
run_cmd ufw allow 22/tcp comment 'VOID SSH'
run_cmd ufw allow 80/tcp comment 'VOID HTTP Nginx'
run_cmd ufw allow 443/tcp comment 'VOID HTTPS Nginx'

log "Removing common accidental public service allows if they exist..."
for port in 3001 3002 3004 3005 4001 5432 6379 9000 9001 9042; do
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '[firewall] DRY RUN: ufw --force delete allow %s/tcp || true\n' "$port"
  else
    ufw --force delete allow "$port/tcp" >/dev/null 2>&1 || true
  fi
done

log "Enabling UFW..."
run_cmd ufw --force enable

log "Final status:"
run_cmd ufw status verbose

log "If MinIO or backend ports still show ALLOW from Anywhere, remove those rules manually with: sudo ufw status numbered"

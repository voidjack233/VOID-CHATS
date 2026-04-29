#!/usr/bin/env bash
set -euo pipefail

LINES="${VOIDAPP_LOG_LINES:-120}"
FOLLOW=0
STREAM="--nostream"
FILTER=""

usage() {
  cat <<'USAGE'
Usage:
  ./scripts/view-logs.sh [service] [--follow] [--lines N] [--err|--out]

Services:
  all | api | messages | conversations | social | gateway | worker

Examples:
  ./scripts/view-logs.sh
  ./scripts/view-logs.sh api
  ./scripts/view-logs.sh messages --follow
  ./scripts/view-logs.sh gateway --lines 200 --err
USAGE
}

SERVICE="all"

while [ "$#" -gt 0 ]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --follow|-f)
      FOLLOW=1
      STREAM=""
      shift
      ;;
    --lines)
      LINES="${2:-}"
      if ! [[ "$LINES" =~ ^[0-9]+$ ]]; then
        echo "Expected a number after --lines" >&2
        exit 2
      fi
      shift 2
      ;;
    --err|--out)
      FILTER="$1"
      shift
      ;;
    all|api|messages|conversations|social|gateway|worker)
      SERVICE="$1"
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if ! command -v pm2 >/dev/null 2>&1; then
  echo "pm2 command was not found" >&2
  exit 1
fi

case "$SERVICE" in
  all) PM2_TARGET="" ;;
  api) PM2_TARGET="voidapp-api" ;;
  messages) PM2_TARGET="voidapp-message-service" ;;
  conversations) PM2_TARGET="voidapp-conversation-service" ;;
  social) PM2_TARGET="voidapp-social-profile-service" ;;
  gateway) PM2_TARGET="voidapp-gateway-phoenix" ;;
  worker) PM2_TARGET="voidapp-worker-service" ;;
esac

if [ "$FOLLOW" -eq 1 ]; then
  echo "Streaming PM2 logs for ${SERVICE}..."
else
  echo "Showing last ${LINES} PM2 log lines for ${SERVICE}..."
fi

if [ -n "$PM2_TARGET" ]; then
  pm2 logs "$PM2_TARGET" --lines "$LINES" --timestamp $STREAM $FILTER
else
  pm2 logs --lines "$LINES" --timestamp $STREAM $FILTER
fi

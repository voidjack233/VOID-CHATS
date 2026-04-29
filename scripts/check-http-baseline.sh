#!/usr/bin/env bash
set -euo pipefail

TARGET="${1:-http://127.0.0.1:3001/health}"
REQUESTS="${VOIDAPP_LOAD_REQUESTS:-100}"
CONCURRENCY="${VOIDAPP_LOAD_CONCURRENCY:-10}"

usage() {
  cat <<'USAGE'
Usage:
  ./scripts/check-http-baseline.sh [url]

Environment:
  VOIDAPP_LOAD_REQUESTS=100
  VOIDAPP_LOAD_CONCURRENCY=10

Examples:
  ./scripts/check-http-baseline.sh
  ./scripts/check-http-baseline.sh http://127.0.0.1:3002/health
  VOIDAPP_LOAD_REQUESTS=500 VOIDAPP_LOAD_CONCURRENCY=25 ./scripts/check-http-baseline.sh http://127.0.0.1:3005/health
USAGE
}

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  usage
  exit 0
fi

if ! command -v ab >/dev/null 2>&1; then
  echo "ApacheBench 'ab' was not found." >&2
  echo "Install apache2-utils first, or use another load tool." >&2
  exit 1
fi

if ! [[ "$REQUESTS" =~ ^[0-9]+$ ]] || ! [[ "$CONCURRENCY" =~ ^[0-9]+$ ]]; then
  echo "VOIDAPP_LOAD_REQUESTS and VOIDAPP_LOAD_CONCURRENCY must be numbers." >&2
  exit 2
fi

if [ "$CONCURRENCY" -gt "$REQUESTS" ]; then
  echo "Concurrency cannot be greater than requests." >&2
  exit 2
fi

echo "HTTP baseline check"
echo "  target:      $TARGET"
echo "  requests:    $REQUESTS"
echo "  concurrency: $CONCURRENCY"
echo

ab -n "$REQUESTS" -c "$CONCURRENCY" "$TARGET"

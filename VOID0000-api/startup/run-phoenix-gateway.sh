#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="$ROOT_DIR/void_gateway"
ENV_FILE="$ROOT_DIR/.env"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source <(sed 's/\r$//' "$ENV_FILE")
  set +a
fi

export MIX_ENV="${MIX_ENV:-prod}"
export GATEWAY_PORT="${GATEWAY_PORT:-4001}"

cd "$APP_DIR"
exec mix phx.server

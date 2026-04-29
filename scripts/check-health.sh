#!/usr/bin/env bash
set -u

# Basic VOIDAPP health check.
#
# Manual run:
#   ./scripts/check-health.sh
#
# Optional alert webhook:
#   VOIDAPP_ALERT_WEBHOOK_URL="https://discord.com/api/webhooks/..." ./scripts/check-health.sh
#
# Cron example:
#   */5 * * * * cd /home/void0000/Desktop/VOIDAPP && VOIDAPP_ALERT_WEBHOOK_URL="..." ./scripts/check-health.sh >> /tmp/voidapp-health.log 2>&1

TIMEOUT="${VOIDAPP_MONITOR_TIMEOUT:-5}"
DISK_WARN_PERCENT="${VOIDAPP_MONITOR_DISK_WARN_PERCENT:-90}"
STATE_FILE="${VOIDAPP_MONITOR_STATE_FILE:-/tmp/voidapp-monitor.state}"
ALERT_WEBHOOK_URL="${VOIDAPP_ALERT_WEBHOOK_URL:-}"
ALERT_WEBHOOK_TYPE="${VOIDAPP_ALERT_WEBHOOK_TYPE:-discord}"

PUBLIC_URLS="${VOIDAPP_MONITOR_PUBLIC_URLS:-https://void0000.online/ https://api.void0000.online/health}"
LOCAL_URLS="${VOIDAPP_MONITOR_LOCAL_URLS:-http://127.0.0.1:3001/health http://127.0.0.1:3002/health http://127.0.0.1:3004/health http://127.0.0.1:3005/health http://127.0.0.1:4001/health}"
EXPECTED_PM2="${VOIDAPP_MONITOR_PM2:-voidapp-gateway-phoenix voidapp-api voidapp-message-service voidapp-conversation-service voidapp-social-profile-service voidapp-worker-service}"
DISK_PATHS="${VOIDAPP_MONITOR_DISK_PATHS:-/ /home /var/www}"

HOSTNAME_VALUE="$(hostname)"
RUN_AT="$(date -Is)"
failures=()
okays=()

record_ok() {
  okays+=("$1")
}

record_failure() {
  failures+=("$1")
}

check_url() {
  local label="$1"
  local url="$2"
  local status

  status="$(curl -sS -o /dev/null -w "%{http_code}" --max-time "$TIMEOUT" "$url" 2>/dev/null || true)"

  if [[ "$status" =~ ^[0-9]+$ ]] && [ "$status" -ge 200 ] && [ "$status" -lt 400 ]; then
    record_ok "$label $url returned HTTP $status"
  else
    record_failure "$label $url returned HTTP ${status:-000}"
  fi
}

check_pm2() {
  if ! command -v pm2 >/dev/null 2>&1; then
    record_failure "pm2 command was not found"
    return
  fi

  local report
  report="$(pm2 jlist 2>/dev/null | EXPECTED_PM2="$EXPECTED_PM2" node -e '
const fs = require("fs");
const input = fs.readFileSync(0, "utf8");
const expected = (process.env.EXPECTED_PM2 || "").split(/\s+/).filter(Boolean);

let apps;
try {
  apps = JSON.parse(input);
} catch (error) {
  console.log(`FAIL pm2 jlist could not be parsed: ${error.message}`);
  process.exit(0);
}

const byName = new Map(apps.map((app) => [app.name, app]));
for (const name of expected) {
  const app = byName.get(name);
  if (!app) {
    console.log(`FAIL ${name} is missing from PM2`);
    continue;
  }

  const status = app.pm2_env?.status || "unknown";
  const restarts = app.pm2_env?.restart_time ?? 0;
  const pid = app.pid || "none";

  if (status !== "online") {
    console.log(`FAIL ${name} is ${status} in PM2`);
    continue;
  }

  console.log(`OK ${name} online pid=${pid} restarts=${restarts}`);
}
')"

  while IFS= read -r line; do
    [ -z "$line" ] && continue
    case "$line" in
      OK\ *) record_ok "${line#OK }" ;;
      FAIL\ *) record_failure "${line#FAIL }" ;;
      *) record_failure "unexpected PM2 monitor output: $line" ;;
    esac
  done <<< "$report"
}

check_disk() {
  local path used

  for path in $DISK_PATHS; do
    if [ ! -e "$path" ]; then
      record_failure "disk path $path does not exist"
      continue
    fi

    used="$(df -P "$path" 2>/dev/null | awk 'NR == 2 { gsub(/%/, "", $5); print $5 }')"
    if [[ ! "$used" =~ ^[0-9]+$ ]]; then
      record_failure "could not read disk usage for $path"
      continue
    fi

    if [ "$used" -ge "$DISK_WARN_PERCENT" ]; then
      record_failure "disk usage for $path is ${used}% (limit ${DISK_WARN_PERCENT}%)"
    else
      record_ok "disk usage for $path is ${used}%"
    fi
  done
}

send_alert() {
  local message="$1"

  if [ -z "$ALERT_WEBHOOK_URL" ]; then
    return 0
  fi

  local payload
  case "$ALERT_WEBHOOK_TYPE" in
    slack)
      payload="$(MESSAGE="$message" node -e 'console.log(JSON.stringify({ text: process.env.MESSAGE.slice(0, 3000) }))')"
      ;;
    *)
      payload="$(MESSAGE="$message" node -e 'console.log(JSON.stringify({ content: process.env.MESSAGE.slice(0, 1900) }))')"
      ;;
  esac

  curl -fsS \
    -X POST \
    -H 'Content-Type: application/json' \
    -d "$payload" \
    "$ALERT_WEBHOOK_URL" >/dev/null 2>&1 || true
}

for url in $PUBLIC_URLS; do
  check_url "public" "$url"
done

for url in $LOCAL_URLS; do
  check_url "local" "$url"
done

check_pm2
check_disk

mkdir -p "$(dirname "$STATE_FILE")"

echo "VOIDAPP monitor check at $RUN_AT on $HOSTNAME_VALUE"
for line in "${okays[@]}"; do
  echo "OK   $line"
done

if [ "${#failures[@]}" -eq 0 ]; then
  previous_state="$(cat "$STATE_FILE" 2>/dev/null || true)"
  if [[ "$previous_state" == fail:* ]]; then
    send_alert "VOIDAPP RECOVERED on $HOSTNAME_VALUE at $RUN_AT"
  fi
  echo "ok" > "$STATE_FILE"
  echo "Result: OK"
  exit 0
fi

echo
for line in "${failures[@]}"; do
  echo "FAIL $line"
done

signature="$(printf '%s\n' "${failures[@]}" | sha256sum | awk '{ print $1 }')"
current_state="fail:$signature"
previous_state="$(cat "$STATE_FILE" 2>/dev/null || true)"

if [ "$current_state" != "$previous_state" ]; then
  alert_body="VOIDAPP MONITOR FAILED on $HOSTNAME_VALUE at $RUN_AT"
  for line in "${failures[@]}"; do
    alert_body="$alert_body
- $line"
  done
  send_alert "$alert_body"
fi

echo "$current_state" > "$STATE_FILE"
echo "Result: FAILED"
exit 1

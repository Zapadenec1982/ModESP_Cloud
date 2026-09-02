#!/bin/bash
# ModESP Cloud — platform alert to Telegram.
#
# Called by modesp-alert@<unit>.service (OnFailure= of the backend and every
# timer-driven service). The argument is the failed unit's name; anything that
# does not look like a unit name is sent verbatim, so a smoke test is simply:
#   systemctl start 'modesp-alert@smoke-test.service'
#
# Configuration (backend/.env): TELEGRAM_BOT_TOKEN (the alarm bot) and
# PLATFORM_ALERT_CHAT_ID (a group the bot was added to). PLATFORM_ALERT_BOT_TOKEN
# overrides the token if a separate bot is preferred. Not configured → exits 0
# after a journal line, so a missing chat id never masks the original failure.
set -uo pipefail

ENV_FILE="${MODESP_ENV_FILE:-/opt/modesp-cloud/backend/.env}"

env_value() {
  local key="$1" line
  [ -r "$ENV_FILE" ] || return 0
  line=$(grep -E "^${key}=" "$ENV_FILE" | tail -n 1 || true)
  line="${line#*=}"; line="${line%\"}"; line="${line#\"}"; line="${line%\'}"; line="${line#\'}"
  printf '%s' "$line"
}

TOKEN="${PLATFORM_ALERT_BOT_TOKEN:-$(env_value PLATFORM_ALERT_BOT_TOKEN)}"
[ -n "$TOKEN" ] || TOKEN="$(env_value TELEGRAM_BOT_TOKEN)"
CHAT="${PLATFORM_ALERT_CHAT_ID:-$(env_value PLATFORM_ALERT_CHAT_ID)}"

if [ -z "$TOKEN" ] || [ -z "$CHAT" ]; then
  echo "alert-telegram: PLATFORM_ALERT_CHAT_ID / TELEGRAM_BOT_TOKEN not set — alert for '$*' not sent" >&2
  exit 0
fi

HOST=$(hostname -f 2>/dev/null || hostname)
STAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
ARG="${1:-}"

if [[ "$ARG" =~ \.(service|timer|mount|socket)$ ]]; then
  LOG=$(journalctl -u "$ARG" -n 15 --no-pager -o cat 2>/dev/null | tail -c 1500)
  TEXT="❌ ${ARG} failed on ${HOST}
${STAMP}

${LOG:-<no journal lines>}"
else
  TEXT="ℹ️ ${HOST} ${STAMP}
$*"
fi

curl -sS -m 15 -o /dev/null -w '' -X POST "https://api.telegram.org/bot${TOKEN}/sendMessage" \
  --data-urlencode "chat_id=${CHAT}" \
  --data-urlencode "text=${TEXT}" \
  --data-urlencode "disable_web_page_preview=true" \
  || { echo "alert-telegram: Telegram API call failed" >&2; exit 1; }
echo "alert-telegram: sent (${#TEXT} chars) to chat ${CHAT}"

#!/usr/bin/env bash
# Alert hook: one interface for every operations alert (T-035).
#
#   echo "message" | pt-alert.sh <INFO|WARN|CRIT|RESOLVED> <source>
#
# Always writes the alert to stdout (the systemd journal when run from a unit, tag pt-alert).
# If PT_ALERT_WEBHOOK_URL is set (environment, or the root-owned file PT_ALERT_ENV_FILE, default
# /etc/pt-ops/alert.env, mode 0640), it also POSTs JSON to that URL:
#   {"text": "...", "severity": "...", "source": "...", "host": "...", "time": "..."}
# "text" makes it work unchanged with Slack/Mattermost/Rocket.Chat-style incoming webhooks; any
# self-hosted receiver can use the other fields. No third-party service is assumed.
#
# The URL usually contains a token, so it is passed to curl through a config on stdin, never on
# the command line. HTTPS only, unless PT_ALERT_ALLOW_HTTP=1 (local testing).
# Messages must not contain secrets or personal data: every caller in deploy/ops prints only
# states, counts, ages and identifiers.
#
# Exit codes: 0 delivered (or no webhook configured); 1 webhook delivery failed; 2 usage error.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=deploy/ops/lib.sh
. "$HERE/lib.sh"
pt_read_config "${PT_OPS_ENV:-/etc/pt-ops/ops.env}"
pt_defaults

SEV=${1:-}
SRC=${2:-}
[[ $SEV =~ ^(INFO|WARN|CRIT|RESOLVED)$ && $SRC =~ ^[A-Za-z0-9_.@:-]{1,80}$ ]] ||
  { echo "usage: echo msg | pt-alert.sh INFO|WARN|CRIT|RESOLVED <source>" >&2; exit 2; }
MSG=$(head -c 3500 || true)
HOST=$(hostname)
NOW=$(pt_ts)

printf '%s pt-alert %s [%s] %s: %s\n' "$NOW" "$SEV" "$HOST" "$SRC" "${MSG//$'\n'/ | }"

URL=${PT_ALERT_WEBHOOK_URL:-}
if [[ -z $URL ]]; then pt_read_secret "$PT_ALERT_ENV_FILE" PT_ALERT_WEBHOOK_URL URL 2>/dev/null || true; fi
[[ -n $URL ]] || exit 0
if [[ $URL != https://* && ${PT_ALERT_ALLOW_HTTP:-0} != 1 ]]; then
  echo "pt-alert: webhook URL must be https:// (not sent)" >&2
  exit 1
fi

json_escape() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\n'/\\n}
  s=${s//$'\t'/\\t}
  s=${s//$'\r'/}
  # Drop any other control characters.
  printf '%s' "$s" | tr -d '\000-\010\013\014\016-\037'
}

tmp=$(mktemp "${TMPDIR:-/tmp}/pt-alert.XXXXXX")
trap 'rm -f "$tmp"' EXIT
text="[$SEV] $HOST $SRC: $MSG"
printf '{"text":"%s","severity":"%s","source":"%s","host":"%s","time":"%s"}' \
  "$(json_escape "$text")" "$SEV" "$SRC" "$(json_escape "$HOST")" "$NOW" >"$tmp"

proto="=https"
[[ ${PT_ALERT_ALLOW_HTTP:-0} == 1 ]] && proto="=http,https"
if printf 'url = "%s"\n' "${URL//\"/}" | curl -sS -K - --proto "$proto" --max-time 10 --retry 2 --retry-delay 2 \
  -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' --data-binary "@$tmp" >"$tmp.code" 2>/dev/null &&
  [[ $(cat "$tmp.code") =~ ^2[0-9][0-9]$ ]]; then
  rm -f "$tmp.code"
  exit 0
fi
echo "pt-alert: webhook delivery failed (HTTP $(cat "$tmp.code" 2>/dev/null || echo none))" >&2
rm -f "$tmp.code"
exit 1

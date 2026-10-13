#!/usr/bin/env bash
# Health check for the whole stack (T-035). Read-only: it never changes the chain or the database.
#
#   pt-health.sh            print one line per check: OK|WARN|CRIT|N/A <check>: <detail>
#   pt-health.sh --alert    also send a de-duplicated alert through pt-alert.sh when the state
#                           changes (or every PT_ALERT_REPEAT_MIN minutes while not OK), and a
#                           RESOLVED message when it returns to OK
#
# Checks: validators (height progress, peers, lag), indexer (lag, halt), outbox (stuck, review),
# signer (pending approvals), reconciliation (gate, last run age and result), anchoring (last
# confirmed anchor age, failures), backups (age), disk, memory, swap, systemd units, HTTP.
# Nothing secret is printed: only states, counts, ages and block numbers.
# N/A means the component is not installed or not migrated here (e.g. anchoring on the demo).
#
# Exit codes (monitoring convention): 0 OK, 1 WARN, 2 CRIT, 3 the check itself failed.
set -uo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=deploy/ops/lib.sh
. "$HERE/lib.sh"
pt_init
trap 'echo "CRIT health: check script error at line $LINENO"; exit 3' ERR

ALERT=0
[[ ${1:-} == --alert ]] && ALERT=1

RPC_URLS=${PT_RPC_URLS:-http://127.0.0.1:8545 http://127.0.0.1:8546 http://127.0.0.1:8547 http://127.0.0.1:8548}
SAMPLE_S=${PT_CHAIN_SAMPLE_SECONDS:-6}
NODE_LAG_WARN=${PT_NODE_LAG_WARN:-5}
INDEXER_LAG_WARN=${PT_INDEXER_LAG_WARN:-60}
INDEXER_LAG_CRIT=${PT_INDEXER_LAG_CRIT:-900}
OUTBOX_LEASE_STUCK_MIN=${PT_OUTBOX_LEASE_STUCK_MIN:-10}
OUTBOX_PENDING_WARN_MIN=${PT_OUTBOX_PENDING_WARN_MIN:-15}
SIGNER_PENDING_WARN_MIN=${PT_SIGNER_PENDING_WARN_MIN:-60}
RECON_MAX_AGE_H=${PT_RECON_MAX_AGE_H:-26}
ANCHOR_WARN_MIN=${PT_ANCHOR_WARN_MIN:-150}
ANCHOR_CRIT_MIN=${PT_ANCHOR_CRIT_MIN:-360}
BACKUP_WARN_H=${PT_BACKUP_WARN_H:-26}
BACKUP_CRIT_H=${PT_BACKUP_CRIT_H:-50}
DISK_WARN=${PT_DISK_WARN_PCT:-80}
DISK_CRIT=${PT_DISK_CRIT_PCT:-90}
MEM_WARN=${PT_MEM_AVAIL_WARN_PCT:-10}
SWAP_WARN=${PT_SWAP_WARN_PCT:-50}
SWAP_CRIT=${PT_SWAP_CRIT_PCT:-85}
HTTP_CHECKS=${PT_HTTP_CHECKS:-http://127.0.0.1/login=200}
REPEAT_MIN=${PT_ALERT_REPEAT_MIN:-60}
for v in SAMPLE_S NODE_LAG_WARN INDEXER_LAG_WARN INDEXER_LAG_CRIT OUTBOX_LEASE_STUCK_MIN OUTBOX_PENDING_WARN_MIN \
  SIGNER_PENDING_WARN_MIN RECON_MAX_AGE_H ANCHOR_WARN_MIN ANCHOR_CRIT_MIN BACKUP_WARN_H BACKUP_CRIT_H DISK_WARN \
  DISK_CRIT MEM_WARN SWAP_WARN SWAP_CRIT REPEAT_MIN; do
  [[ ${!v} =~ ^[0-9]{1,6}$ ]] || { echo "CRIT health: threshold $v is not a whole number"; exit 3; }
done

LINES=()
add() { LINES+=("$(printf '%-4s %s' "$1" "$2")"); }

# ------------------------------------------------------------------ chain
rpc() { # url method -> hex result or empty
  curl -s --max-time 3 -H 'Content-Type: application/json' \
    --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$2\",\"params\":[]}" "$1" 2>/dev/null |
    sed -n 's/.*"result":"\(0x[0-9a-fA-F]*\)".*/\1/p'
}
declare -A H1=() H2=() PEERS=()
CHAIN_MAX=""
check_chain() {
  local u h p n=0 down=0 max1=0 max2=0 tolerate lag
  for u in $RPC_URLS; do
    n=$((n + 1))
    h=$(rpc "$u" eth_blockNumber)
    if [[ -z $h ]]; then H1[$u]=""; continue; fi
    H1[$u]=$((h))
    p=$(rpc "$u" net_peerCount)
    PEERS[$u]=$((${p:-0x0}))
    ((H1[$u] > max1)) && max1=${H1[$u]}
  done
  ((n)) || { add N/A "chain: no RPC endpoints configured"; return; }
  sleep "$SAMPLE_S"
  for u in $RPC_URLS; do
    [[ -n ${H1[$u]} ]] || continue
    h=$(rpc "$u" eth_blockNumber)
    [[ -n $h ]] && H2[$u]=$((h)) && ((H2[$u] > max2)) && max2=${H2[$u]}
  done
  tolerate=$(((n - 1) / 3)) # QBFT/BFT: tolerates f faulty of n = 3f + 1
  for u in $RPC_URLS; do
    if [[ -z ${H1[$u]} ]]; then
      down=$((down + 1))
      add WARN "validator ${u##*:}: not reachable"
      continue
    fi
    lag=$((max2 - ${H2[$u]:-${H1[$u]}}))
    if ((PEERS[$u] < n - 1)); then
      add WARN "validator ${u##*:}: height ${H2[$u]:-${H1[$u]}}, peers ${PEERS[$u]} (expected $((n - 1)))"
    elif ((lag > NODE_LAG_WARN)); then
      add WARN "validator ${u##*:}: $lag blocks behind (height ${H2[$u]:-?})"
    else
      add OK "validator ${u##*:}: height ${H2[$u]:-${H1[$u]}}, peers ${PEERS[$u]}"
    fi
  done
  if ((down > tolerate)); then
    add CRIT "chain: $down of $n validators down; BFT tolerates $tolerate, the chain cannot finalize blocks"
  elif ((max1 == 0)); then
    add CRIT "chain: no validator answered"
  elif ((max2 <= max1)); then
    add CRIT "chain: no new block in ${SAMPLE_S} s (height $max1): chain halted"
  else
    add OK "chain: producing blocks (height $max2, +$((max2 - max1)) in ${SAMPLE_S} s, $((n - down))/$n validators up)"
  fi
  CHAIN_MAX=$max2
}

# ------------------------------------------------------------------ database
DB=${PT_HEALTH_DB:-${PT_PG_DATABASES%% *}}
check_db() {
  local out key a b c d e
  pt_pg_setup
  if ! "$(pt_pg pg_isready)" -q 2>/dev/null; then
    add CRIT "postgres: not reachable at $PT_PG_HOST:$PT_PG_PORT"
    return
  fi
  # One read-only session; every block is skipped when its schema is not migrated here.
  out=$("$(pt_pg psql)" -X -q -At -F '|' -v ON_ERROR_STOP=1 -d "$DB" 2>&1 <<SQL
BEGIN READ ONLY;
SET LOCAL statement_timeout = '20s';
SELECT 'pg|' || count(*) || '|' || current_setting('max_connections') FROM pg_stat_activity;
SELECT to_regclass('chain.cursors') IS NOT NULL AS has_chain,
       to_regclass('outbox.commands') IS NOT NULL AS has_outbox,
       to_regclass('signer.requests') IS NOT NULL AS has_signer,
       to_regprocedure('recon.payout_gate()') IS NOT NULL AS has_recon,
       to_regclass('anchor.anchors') IS NOT NULL AS has_anchor \gset
\if :has_chain
SELECT 'idx|' || deployment || '|' || block_number || '|' || CASE WHEN halted_at IS NOT NULL THEN 't' ELSE 'f' END || '|' ||
       extract(epoch FROM now() - updated_at)::bigint || '|' || left(regexp_replace(coalesce(halt_reason, ''), '[|\n\r]', ' ', 'g'), 160)
FROM chain.cursors ORDER BY deployment;
\endif
\if :has_outbox
SELECT 'outbox|' || count(*) FILTER (WHERE status = 'review') || '|' ||
       count(*) FILTER (WHERE status IN ('claimed', 'submitted') AND lease_until < now() - make_interval(mins => $OUTBOX_LEASE_STUCK_MIN)) || '|' ||
       count(*) FILTER (WHERE status = 'pending' AND available_at < now() - make_interval(mins => $OUTBOX_PENDING_WARN_MIN)) || '|' ||
       count(*) FILTER (WHERE status IN ('pending', 'claimed', 'submitted'))
FROM outbox.commands WHERE status IN ('pending', 'claimed', 'submitted', 'review');
\endif
\if :has_signer
SELECT 'signer|' || count(*) || '|' || coalesce(extract(epoch FROM now() - min(created_at))::bigint, 0) || '|' ||
       count(*) FILTER (WHERE expires_at < now() + interval '2 hours')
FROM signer.requests WHERE status = 'pending_approval';
\endif
\if :has_recon
-- Booleans concatenated into text read 'true'/'false' (not 't'/'f'), so they are mapped explicitly.
SELECT 'recon|' || CASE WHEN allowed THEN 't' ELSE 'f' END || '|' || CASE WHEN frozen THEN 't' ELSE 'f' END || '|' || coalesce(last_status, 'none') || '|' ||
       coalesce(extract(epoch FROM now() - last_finished)::bigint, -1) || '|' || left(regexp_replace(coalesce(reason, ''), '[|\n\r]', ' ', 'g'), 160)
FROM recon.payout_gate();
\endif
\if :has_anchor
SELECT 'anchor|' || count(*) || '|' || coalesce(extract(epoch FROM now() - max(confirmed_at))::bigint, -1) || '|' ||
       count(*) FILTER (WHERE status = 'failed' AND created_at > now() - interval '24 hours') || '|' ||
       count(*) FILTER (WHERE status IN ('recorded', 'sent') AND created_at < now() - interval '30 minutes')
FROM anchor.anchors;
\endif
COMMIT;
SQL
  ) || {
    add CRIT "postgres: health query failed on $DB: ${out:0:200}"
    return
  }
  local seen_idx=0 seen_outbox=0 seen_signer=0 seen_recon=0 seen_anchor=0
  while IFS='|' read -r key a b c d e; do
    key=${key%$'\r'} e=${e%$'\r'} d=${d%$'\r'} c=${c%$'\r'} b=${b%$'\r'}
    case $key in
    pg)
      if ((a * 100 >= b * 85)); then add WARN "postgres: $a of $b connections in use"; else add OK "postgres: $a/$b connections"; fi
      ;;
    idx)
      seen_idx=1
      if [[ $c == t ]]; then
        add CRIT "indexer $a: HALTED at block $b ($e); see docs/runbooks/indexer-halt.md"
      elif [[ -n $CHAIN_MAX ]] && ((CHAIN_MAX - b > INDEXER_LAG_CRIT)); then
        add CRIT "indexer $a: $((CHAIN_MAX - b)) blocks behind (cursor $b, last batch ${d}s ago)"
      elif [[ -n $CHAIN_MAX ]] && ((CHAIN_MAX - b > INDEXER_LAG_WARN)); then
        add WARN "indexer $a: $((CHAIN_MAX - b)) blocks behind (cursor $b, last batch ${d}s ago)"
      else
        add OK "indexer $a: cursor $b${CHAIN_MAX:+, lag $((CHAIN_MAX - b))}"
      fi
      ;;
    outbox)
      seen_outbox=1
      if ((b > 0)); then
        add CRIT "outbox: $b command(s) with an expired lease > ${OUTBOX_LEASE_STUCK_MIN} min (worker died mid-send?)"
      elif ((a > 0)); then
        add WARN "outbox: $a command(s) in review (operator decision needed)"
      elif ((c > 0)); then
        add WARN "outbox: $c pending command(s) older than ${OUTBOX_PENDING_WARN_MIN} min (worker not running?)"
      else
        add OK "outbox: $d open, none stuck"
      fi
      ;;
    signer)
      seen_signer=1
      if ((a > 0 && b > SIGNER_PENDING_WARN_MIN * 60)); then
        add WARN "signer: $a request(s) waiting for approval, oldest $((b / 60)) min, $c expiring within 2 h"
      else
        add OK "signer: $a pending approval(s)"
      fi
      ;;
    recon)
      seen_recon=1
      if [[ $b == t ]]; then
        add CRIT "recon: payouts FROZEN ($e); see docs/runbooks/reconciliation-freeze.md"
      elif [[ $c == none ]]; then
        add WARN "recon: no reconciliation run yet; payouts not allowed"
      elif [[ $c == error ]]; then
        add CRIT "recon: last run ended in error $((d / 3600)) h ago; payouts not allowed"
      elif ((d > RECON_MAX_AGE_H * 3600)); then
        add WARN "recon: last run $((d / 3600)) h old (> ${RECON_MAX_AGE_H} h); payouts not allowed until a new passed run"
      elif [[ $a == t ]]; then
        add OK "recon: last run $c $((d / 3600)) h ago, payouts allowed"
      else
        add WARN "recon: payouts not allowed (last run $c, $e)"
      fi
      ;;
    anchor)
      seen_anchor=1
      if ((a == 0)); then
        add N/A "anchor: no anchors recorded in $DB (job not running here)"
      elif ((d > 0)); then
        add WARN "anchor: $d failed anchor(s) in the last 24 h; see docs/runbooks/anchor-alarm.md"
      elif ((e > 0)); then
        add WARN "anchor: an anchor is open > 30 min (not confirmed)"
      elif ((b < 0 || b > ANCHOR_CRIT_MIN * 60)); then
        add CRIT "anchor: last confirmed anchor $((b / 60)) min ago"
      elif ((b > ANCHOR_WARN_MIN * 60)); then
        add WARN "anchor: last confirmed anchor $((b / 60)) min ago"
      else
        add OK "anchor: last confirmed anchor $((b / 60)) min ago"
      fi
      ;;
    esac
  done <<<"$out"
  ((seen_idx)) || add N/A "indexer: no cursor in $DB (not migrated or never run)"
  ((seen_outbox)) || add N/A "outbox: not migrated in $DB"
  ((seen_signer)) || add N/A "signer: not migrated in $DB"
  ((seen_recon)) || add N/A "recon: not migrated in $DB"
  ((seen_anchor)) || add N/A "anchor: not migrated in $DB"
}

# ------------------------------------------------------------------ backups and scheduled jobs
state_field() { # file field
  [[ -r $PT_STATE_DIR/$1 ]] || return 1
  tr ' ' '\n' <"$PT_STATE_DIR/$1" | sed -n "s/^$2=//p" | head -1
}
check_backups() {
  local at age
  if [[ ${PT_BACKUP_EXPECTED:-0} != 1 ]]; then
    add N/A "backup: not scheduled on this host (PT_BACKUP_EXPECTED=0)"
    return
  fi
  at=$(state_field backup-db.last at || true)
  [[ $at =~ ^[0-9]+$ ]] || { add CRIT "backup: no successful backup recorded"; return; }
  age=$((($(date +%s) - at) / 3600))
  if ((age >= BACKUP_CRIT_H)); then
    add CRIT "backup: last successful backup ${age} h ago"
  elif ((age >= BACKUP_WARN_H)); then
    add WARN "backup: last successful backup ${age} h ago"
  else
    add OK "backup: last set $(state_field backup-db.last set) (${age} h ago)"
  fi
}

# ------------------------------------------------------------------ host
check_host() {
  local fs pct total avail swt swf used
  for fs in / "$PT_BACKUP_DIR"; do
    [[ -d $fs ]] || continue
    pct=$(df --output=pcent "$fs" | tail -1 | tr -dc '0-9')
    [[ -n $pct ]] || continue
    if ((pct >= DISK_CRIT)); then
      add CRIT "disk $fs: ${pct}% used"
    elif ((pct >= DISK_WARN)); then
      add WARN "disk $fs: ${pct}% used"
    else
      add OK "disk $fs: ${pct}% used"
    fi
  done
  if [[ -r /proc/meminfo ]]; then
    total=$(awk '/^MemTotal:/{print $2}' /proc/meminfo)
    avail=$(awk '/^MemAvailable:/{print $2}' /proc/meminfo)
    swt=$(awk '/^SwapTotal:/{print $2}' /proc/meminfo)
    swf=$(awk '/^SwapFree:/{print $2}' /proc/meminfo)
    if [[ -n $total && -n $avail && $total -gt 0 ]]; then
      pct=$((avail * 100 / total))
      if ((pct < MEM_WARN)); then add WARN "memory: ${pct}% available"; else add OK "memory: ${pct}% available ($((avail / 1024)) MB)"; fi
    fi
    if [[ -n $swt && $swt -gt 0 ]]; then
      used=$(((swt - swf) * 100 / swt))
      if ((used >= SWAP_CRIT)); then
        add CRIT "swap: ${used}% used"
      elif ((used >= SWAP_WARN)); then
        add WARN "swap: ${used}% used"
      else
        add OK "swap: ${used}% used"
      fi
    fi
  fi
}

check_units() {
  local u st
  if ! command -v systemctl >/dev/null 2>&1; then
    add N/A "systemd: not available on this host"
    return
  fi
  while read -r u _; do
    [[ -n $u ]] || continue
    st=$(systemctl is-active "$u" 2>/dev/null || true)
    if [[ $st == active ]]; then add OK "unit $u: active"; else add CRIT "unit $u: $st"; fi
  done < <(systemctl list-unit-files --no-legend --state=enabled 'pt-*.service' 'pt-*.timer' 2>/dev/null)
  while read -r u _; do
    [[ -n $u ]] || continue
    add CRIT "unit $u: failed (journalctl -u $u)"
  done < <(systemctl list-units --no-legend --plain --state=failed 'pt-*' 2>/dev/null)
}

check_http() {
  local item url want got
  for item in $HTTP_CHECKS; do
    url=${item%=*}
    want=${item##*=}
    got=$(curl -s -o /dev/null -w '%{http_code} %{time_total}' --max-time 10 "$url" 2>/dev/null || true)
    if [[ ${got%% *} == "$want" ]]; then
      add OK "http $url: ${got%% *} in ${got##* } s"
    else
      add CRIT "http $url: got ${got%% *} (want $want)"
    fi
  done
}

check_chain
check_db
check_backups
check_host
check_units
check_http
trap - ERR

crit=0 warn=0 ok=0 na=0
for l in "${LINES[@]}"; do
  case $l in CRIT*) crit=$((crit + 1)) ;; WARN*) warn=$((warn + 1)) ;; OK*) ok=$((ok + 1)) ;; *) na=$((na + 1)) ;; esac
done
status=OK code=0
((warn)) && status=WARN code=1
((crit)) && status=CRIT code=2
printf '%s\n' "${LINES[@]}"
echo "pt-health: $status ($crit crit, $warn warn, $ok ok, $na n/a) host=$(hostname) at=$(pt_ts)"

# ------------------------------------------------------------------ de-duplicated alerting
if ((ALERT)); then
  problems=$(printf '%s\n' "${LINES[@]}" | grep -E '^(CRIT|WARN)' || true)
  # The digest covers WHICH checks are failing at which severity, not the changing numbers.
  digest=$(printf '%s\n' "$problems" | sed -E 's/^(CRIT|WARN) +([^:]+):.*/\1 \2/' | sha256sum | cut -c1-16)
  last=$(cat "$PT_STATE_DIR/health.alert" 2>/dev/null || echo "OK 0 0")
  read -r last_status last_digest last_at <<<"$last"
  now=$(date +%s)
  # State is recorded only after a delivered alert, so a failed webhook is retried on the next run.
  if [[ $status == OK ]]; then
    if [[ $last_status == OK ]] ||
      printf 'All checks OK again (%s ok, %s n/a).\n' "$ok" "$na" | pt_alert RESOLVED pt-health; then
      pt_state_write health.alert "OK 0 $now"
    fi
  elif [[ $digest != "$last_digest" || $((now - ${last_at:-0})) -ge $((REPEAT_MIN * 60)) ]]; then
    if printf '%s\n' "$problems" | pt_alert "$status" pt-health; then
      pt_state_write health.alert "$status $digest $now"
    fi
  fi
fi
exit "$code"

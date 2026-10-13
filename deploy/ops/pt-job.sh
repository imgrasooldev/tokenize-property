#!/usr/bin/env bash
# Runs one scheduled backend job and fails LOUDLY (T-034 operational part).
#
#   pt-job.sh <npm script> [-- args...]
#
# Allowed scripts (an allow-list, so a unit can never be pointed at anything else):
#   recon             daily reconciliation; exit 1 = findings (blocking ones freeze payouts), 2 = error
#   anchor:verify     daily check of every public anchor against Besu and the ledger; 1 = mismatch
#   indexer:verify    rebuild-and-compare of the read model; 1 = difference
#   signer:audit kyc:audit bank:audit   audit hash chains; non-zero = problem
#   recon:status indexer:status anchor:status   read-only status (for drills)
#
# Runs `npm run --silent <script>` in PT_REPO/backend with a timeout, keeps the output in the
# journal (stdout) and in PT_STATE_DIR/logs (last 60 runs), records the result for pt-health.sh,
# and exits with the job's own code: systemd marks the unit failed, OnFailure= sends the alert
# (pt-unit-failed.sh) and pt-health.sh keeps reporting the failed unit until the next good run.
# Outside systemd set PT_JOB_ALERT=1 to alert directly.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=deploy/ops/lib.sh
. "$HERE/lib.sh"
pt_init

JOB=${1:-}
shift || true
[[ ${1:-} == -- ]] && shift
case $JOB in
recon | anchor:verify | indexer:verify | signer:audit | kyc:audit | bank:audit | recon:status | indexer:status | anchor:status) ;;
*) pt_die 2 "job not in the allow-list: '${JOB}'" ;;
esac
for a in "$@"; do [[ $a =~ ^--?[a-z][a-z0-9-]*$|^[0-9]{1,6}$ ]] || pt_die 2 "argument not allowed: $a"; done

NAME=${JOB//:/-}
TIMEOUT=${PT_JOB_TIMEOUT_SECONDS:-1800}
LOGS="$PT_STATE_DIR/logs"
mkdir -p "$LOGS"
LOG="$LOGS/$NAME-$(date -u +%Y%m%dT%H%M%SZ).log"
pt_lock "job-$NAME"
command -v npm >/dev/null 2>&1 || pt_die 2 "npm not found in PATH"
[[ -d $PT_REPO/backend/node_modules ]] || pt_die 2 "backend dependencies are not installed ($PT_REPO/backend)"

pt_log "job $JOB starting (timeout ${TIMEOUT}s)"
t0=$(date +%s)
set +e
(cd "$PT_REPO/backend" && timeout --kill-after=30 "$TIMEOUT" npm run --silent "$JOB" -- "$@") 2>&1 | tee "$LOG"
rc=${PIPESTATUS[0]}
set -e
dur=$(($(date +%s) - t0))
pt_state_write "job-$NAME.last" "exit=$rc at=$(date +%s) duration=$dur log=${LOG##*/}"
# Keep the newest 60 logs of this job.
find "$LOGS" -maxdepth 1 -name "$NAME-*.log" -printf '%f\n' | sort -r | tail -n +61 | while read -r f; do rm -f -- "$LOGS/$f"; done

if ((rc == 0)); then
  pt_log "job $JOB passed in ${dur}s"
  exit 0
fi
case "$JOB:$rc" in
recon:1) what="reconciliation found discrepancies; blocking findings FREEZE payouts (docs/runbooks/reconciliation-freeze.md)" ;;
recon:2) what="reconciliation could not complete (error); payouts stay blocked after 26 h (docs/runbooks/reconciliation-freeze.md)" ;;
anchor:verify:1) what="public anchor MISMATCH: private chain or ledger differs from what was anchored (docs/runbooks/anchor-alarm.md)" ;;
indexer:verify:1) what="read model differs from the chain (docs/runbooks/indexer-halt.md)" ;;
*:124 | *:137) what="timed out after ${TIMEOUT}s" ;;
*) what="failed" ;;
esac
# Printed last, so it is in the journal lines the OnFailure= alert (pt-unit-failed.sh) carries.
pt_err "job $JOB exit $rc after ${dur}s: $what"
if [[ ${PT_JOB_ALERT:-0} == 1 ]]; then # outside systemd (cron, by hand): alert directly
  {
    echo "$JOB exit $rc after ${dur}s: $what"
    echo "--- last lines (full log: $LOG)"
    tail -n 25 "$LOG"
  } | pt_alert CRIT "job-$NAME" || true
fi
exit "$rc"

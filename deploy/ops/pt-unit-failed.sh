#!/usr/bin/env bash
# OnFailure= backstop: any pt-* unit that fails (crash, timeout, non-zero exit) raises an alert,
# even if its own script never got to send one.
#   pt-unit-failed.sh <unit name>        (run by pt-ops-alert@<unit>.service)
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
UNIT=${1:-}
[[ $UNIT =~ ^pt-[A-Za-z0-9@_.-]+$ ]] || { echo "usage: pt-unit-failed.sh <pt-* unit>" >&2; exit 2; }
{
  echo "unit $UNIT failed: $(systemctl show -p Result -p ExecMainStatus --value "$UNIT" 2>/dev/null | paste -sd' ' -)"
  echo "--- journal (last 20 lines): journalctl -u $UNIT"
  journalctl -u "$UNIT" -n 20 --no-pager -o cat 2>/dev/null || echo "(journal not readable)"
} | "$HERE/pt-alert.sh" CRIT "$UNIT"

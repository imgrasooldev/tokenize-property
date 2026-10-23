#!/usr/bin/env bash
# Rollback switch for T-012 (per-service database roles, migration 0029) on the demo server.
#
#   bash deploy/demo-server/db-login.sh status
#   bash deploy/demo-server/db-login.sh admin <unit>...   # roll a unit back to the admin login
#   bash deploy/demo-server/db-login.sh own <unit>...     # back to the service's own login (default)
#
# "admin" writes a systemd drop-in that blanks the unit's <PREFIX>_PG_USER/_PASSWORD (environment
# beats backend/.env.local) and sets PT_DB_ADMIN_FALLBACK=1, which the services honour only for a
# loopback database outside production; then it restarts the unit. "own" removes the drop-in. The
# drop-ins live in /etc/systemd/system/<unit>.d/ and survive deploys (update.sh warns while any
# exists). Use it only to restore service while a missing grant is fixed in a new migration.
set -euo pipefail

DROPIN=20-db-admin-fallback.conf

prefix_of() { # unit -> env prefix of the service login it uses
  case $1 in
  pt-indexer) echo INDEXER ;;
  pt-signer) echo SIGNER ;;
  pt-outbox) echo OUTBOX ;;
  pt-kyc) echo KYC ;;
  pt-offboarding) echo OFFBOARDING ;;
  pt-bank-payees) echo BANK ;;
  pt-anchor | pt-anchor-verify) echo ANCHOR ;;
  pt-console) echo CONSOLE ;;
  pt-recon) echo RECON ;;
  pt-audit-chains) echo AUDIT ;;
  *) return 1 ;;
  esac
}

usage() {
  echo "usage: db-login.sh status | admin <unit>... | own <unit>..." >&2
  exit 2
}

cmd=${1:-}
[[ $# -gt 0 ]] && shift
case $cmd in
status)
  found=0
  for d in /etc/systemd/system/pt-*.service.d; do
    [[ -f $d/$DROPIN ]] || continue
    unit=${d##*/}
    echo "${unit%.service.d}: ADMIN login (rollback drop-in present)"
    found=1
  done
  [[ $found == 1 ]] || echo "every service uses its own database login"
  ;;
admin | own)
  [[ $# -gt 0 ]] || usage
  for unit in "$@"; do
    p=$(prefix_of "$unit") || {
      echo "unknown unit: $unit" >&2
      exit 2
    }
    dir=/etc/systemd/system/$unit.service.d
    if [[ $cmd == admin ]]; then
      sudo mkdir -p "$dir"
      printf '[Service]\n# T-012 rollback (deploy/demo-server/db-login.sh): admin login until the missing grant is fixed.\nEnvironment=%s_PG_USER=\nEnvironment=%s_PG_PASSWORD=\nEnvironment=PT_DB_ADMIN_FALLBACK=1\n' "$p" "$p" |
        sudo tee "$dir/$DROPIN" >/dev/null
    else
      sudo rm -f "$dir/$DROPIN"
    fi
  done
  sudo systemctl daemon-reload
  for unit in "$@"; do
    # Timer-driven jobs (pt-recon, pt-anchor-verify, pt-audit-chains) pick it up on their next run.
    if sudo systemctl is-active --quiet "$unit"; then sudo systemctl restart "$unit"; fi
    echo "$unit: $([[ $cmd == admin ]] && echo "admin login (rollback)" || echo "own login")"
  done
  ;;
*) usage ;;
esac

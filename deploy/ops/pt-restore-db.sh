#!/usr/bin/env bash
# Restore a backup set into a NEW scratch database and prove it is complete and untampered (T-035).
#
#   pt-restore-db.sh --set <dir | set-id | latest> [--db property_token] [--target pt_restore_x]
#                    [--keep] [--globals] [--report-dir DIR]
#
# Safety rules (enforced):
#   - Only ever creates a database whose name starts with pt_restore_, and refuses if it exists.
#     A real disaster recovery restores here too, then a DBA renames it (docs/runbooks/backup-restore.md).
#   - Never writes to any other database. --globals (fresh cluster only) creates missing roles.
#   - Decryption needs the OFFLINE private key (operator's GnuPG/smartcard, or PT_RESTORE_AGE_IDENTITY).
#
# Verification (all must pass):
#   1. SHA256SUMS of the set           5. signer.verify_audit()   empty
#   2. pg_restore in ONE transaction    6. recon.verify_audit()    empty
#   3. ledger.verify_chain()  empty     7. kyc.verify_audit(), bank.verify_audit() empty (if present)
#   4. ledger.verify_balances() empty   8. migrations and EXACT row counts per table = manifest
# A function whose schema is not migrated in that database is reported SKIP (not a pass).
#
# Exit codes: 0 all checks passed; 1 a check failed; 2 usage, environment or restore error.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=deploy/ops/lib.sh
. "$HERE/lib.sh"
pt_init

SET="" DB="" TARGET="" KEEP=0 GLOBALS=0 REPORT_DIR=""
while (($#)); do
  case $1 in
  --set) SET=${2:?}; shift 2 ;;
  --db) DB=${2:?}; shift 2 ;;
  --target) TARGET=${2:?}; shift 2 ;;
  --keep) KEEP=1; shift ;;
  --globals) GLOBALS=1; shift ;;
  --report-dir) REPORT_DIR=${2:?}; shift 2 ;;
  -h | --help) sed -n '2,22p' "$0"; exit 0 ;;
  *) pt_die 2 "unknown argument: $1" ;;
  esac
done
[[ -n $SET ]] || pt_die 2 "--set is required (a set directory, a set id or 'latest')"

# ------------------------------------------------------------------ locate and check the set
if [[ $SET == latest ]]; then
  SET=$(find "$PT_BACKUP_DIR/sets" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' 2>/dev/null | grep -E '^[0-9]{8}T[0-9]{6}Z$' | sort | tail -1)
  [[ -n $SET ]] || pt_die 2 "no backup sets in $PT_BACKUP_DIR/sets"
fi
[[ -d $SET ]] || SET="$PT_BACKUP_DIR/sets/$SET"
[[ -d $SET && -f $SET/manifest.txt && -f $SET/SHA256SUMS ]] || pt_die 2 "not a backup set: $SET"
SET=$(cd "$SET" && pwd)
MANIFEST="$SET/manifest.txt"
mval() { grep -m1 "^$1=" "$MANIFEST" | cut -d= -f2- || true; }
[[ $(mval format) == pt-backup-v1 ]] || pt_die 2 "unknown manifest format"
SET_ID=$(mval set_id)
if [[ -z $DB ]]; then read -r DB _ <<<"$(mval databases)"; fi
pt_valid_dbname "$DB" || pt_die 2 "invalid --db"
DUMP_FILE=$(mval "db.$DB.file")
[[ -n $DUMP_FILE && -f $SET/$DUMP_FILE ]] || pt_die 2 "database $DB is not in set $SET_ID"
TARGET=${TARGET:-pt_restore_${DB}_$(date -u +%Y%m%d%H%M%S)}
[[ $TARGET =~ ^pt_restore_[a-z0-9_]{1,51}$ ]] || pt_die 2 "--target must match pt_restore_[a-z0-9_]+ (max 63 chars)"
REPORT_DIR=${REPORT_DIR:-$PT_BACKUP_DIR/drills}
mkdir -p "$REPORT_DIR" 2>/dev/null || REPORT_DIR="$PT_TMP"
REPORT="$REPORT_DIR/drill-$SET_ID-$DB-$(date -u +%Y%m%dT%H%M%SZ).txt"

FAILS=0
SKIPS=0
say() { printf '%s\n' "$*" | tee -a "$REPORT"; }
result() { # PASS|FAIL|SKIP|INFO name detail
  say "$(printf '%-4s %-26s %s' "$1" "$2" "$3")"
  case $1 in FAIL) FAILS=$((FAILS + 1)) ;; SKIP) SKIPS=$((SKIPS + 1)) ;; esac
}

: >"$REPORT"
say "restore drill  set=$SET_ID db=$DB target=$TARGET started=$(pt_ts) host=$(hostname)"
say "backup created=$(mval created_utc) host=$(mval host) commit=$(mval repo_commit) pg=$(mval pg_server_version)"

if (cd "$SET" && sha256sum --quiet --strict -c SHA256SUMS >/dev/null 2>&1); then
  result PASS checksums "SHA256SUMS ok ($(wc -l <"$SET/SHA256SUMS" | tr -d ' ') files)"
else
  result FAIL checksums "SHA256SUMS mismatch: the set is corrupt or was modified"
  pt_die 1 "refusing to restore a set that fails its checksums (report: $REPORT)"
fi

# ------------------------------------------------------------------ restore
pt_pg_setup
"$(pt_pg pg_isready)" -q || pt_die 2 "PostgreSQL is not reachable at $PT_PG_HOST:$PT_PG_PORT"
exists=$(pt_psql postgres -c "SELECT count(*) FROM pg_database WHERE datname = '$TARGET'" | tr -d '\r')
[[ $exists == 0 ]] || pt_die 2 "database $TARGET already exists; choose another --target"

if ((GLOBALS)); then
  # Fresh cluster only: errors for roles that already exist are expected and reported, not fatal.
  pt_decrypt "$SET/$(mval globals.file)" | "$(pt_pg psql)" -X -q -d postgres -v ON_ERROR_STOP=0 >/dev/null 2>"$PT_TMP/globals.err" || true
  result INFO globals "applied; $(grep -c ERROR "$PT_TMP/globals.err" || true) statements reported errors (existing roles); set service passwords from the secret store"
fi

pt_psql postgres -c "CREATE DATABASE \"$TARGET\" TEMPLATE template0 ENCODING 'UTF8'"
CREATED=1
if ((!KEEP)); then
  pt_on_exit "[[ \${CREATED:-0} == 1 ]] && \"\$(pt_pg psql)\" -X -q -d postgres -c 'DROP DATABASE \"$TARGET\"' >/dev/null 2>&1 && echo 'scratch database $TARGET dropped'"
fi

t0=$(date +%s)
if pt_decrypt "$SET/$DUMP_FILE" | "$(pt_pg pg_restore)" -d "$TARGET" --exit-on-error --single-transaction --no-password 2>"$PT_TMP/restore.err"; then
  result PASS restore "pg_restore in one transaction, $(($(date +%s) - t0)) s"
else
  result FAIL restore "pg_restore failed: $(head -c 600 "$PT_TMP/restore.err" | tr '\n' ' ')"
  say "summary: FAILED (restore did not complete) report=$REPORT"
  exit 1
fi

# ------------------------------------------------------------------ verification
q() { pt_psql "$TARGET" -c "$1" | tr -d '\r'; }

want_migr=$(mval "db.$DB.migrations")
got_migr=$(q "SELECT CASE WHEN to_regclass('public.schema_migrations') IS NULL THEN '' ELSE (SELECT string_agg(name, ',' ORDER BY name) FROM public.schema_migrations) END")
if [[ $want_migr == "$got_migr" ]]; then
  result PASS migrations "${got_migr##*,} ($(tr ',' '\n' <<<"$got_migr" | grep -c .) applied)"
else
  result FAIL migrations "manifest [$want_migr] vs restored [$got_migr]"
fi

verify_fn() { # schema.function label
  local fn=$1 n detail
  if [[ $(q "SELECT to_regprocedure('$fn()') IS NOT NULL") != t ]]; then
    result SKIP "$fn()" "not present in this database (schema not migrated)"
    return
  fi
  n=$(q "SELECT count(*) FROM $fn()")
  if [[ $n == 0 ]]; then
    result PASS "$fn()" "no problems"
  else
    detail=$(q "SELECT string_agg(t::text, ' ; ') FROM (SELECT * FROM $fn() LIMIT 3) t")
    result FAIL "$fn()" "$n problem rows, first: ${detail:0:400}"
  fi
}
verify_fn ledger.verify_chain
verify_fn ledger.verify_balances
verify_fn signer.verify_audit
verify_fn recon.verify_audit
verify_fn kyc.verify_audit
verify_fn bank.verify_audit

# Exact row counts per table, compared with the counts taken inside the dump's snapshot.
declare -A want=()
while IFS= read -r line; do
  kv=${line#rows."$DB".}
  want[${kv%=*}]=${kv##*=}
done < <(grep "^rows\.$DB\." "$MANIFEST")
COUNT_SQL="SELECT format('%s.%s', n.nspname, c.relname) || '=' ||
  (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', n.nspname, c.relname), false, true, '')))[1]::text
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%' ORDER BY 1"
declare -A got=()
total=0
while IFS= read -r line; do
  [[ -n $line ]] || continue
  got[${line%=*}]=${line##*=}
  total=$((total + ${line##*=}))
done < <(q "$COUNT_SQL")
mism=()
for t in "${!want[@]}"; do [[ ${got[$t]:-missing} == "${want[$t]}" ]] || mism+=("$t want ${want[$t]} got ${got[$t]:-missing}"); done
for t in "${!got[@]}"; do [[ -n ${want[$t]:-} ]] || mism+=("$t not in manifest"); done
if ((${#want[@]} == 0)); then
  result FAIL row-counts "manifest has no row counts for $DB"
elif ((${#mism[@]} == 0)); then
  result PASS row-counts "${#got[@]} tables, $total rows, all equal to the manifest"
else
  result FAIL row-counts "${#mism[@]} differences: ${mism[*]:0:5}"
fi
for t in ledger.journal ledger.postings signer.audit recon.runs recon.audit chain.events kyc.subjects bank.payout_batches outbox.commands anchor.anchors; do
  [[ -n ${got[$t]:-} ]] && say "     rows $t = ${got[$t]}"
done

if [[ $(q "SELECT to_regprocedure('ledger.chain_head()') IS NOT NULL") == t ]]; then
  result INFO ledger-head "$(q "SELECT 'journal ' || journal_id || ' hash ' || hash FROM ledger.chain_head()")"
fi
if [[ $(q "SELECT to_regprocedure('recon.payout_gate()') IS NOT NULL") == t ]]; then
  result INFO payout-gate "$(q "SELECT 'allowed=' || allowed || ' frozen=' || frozen || ' last_run=' || coalesce(last_status, 'none') FROM recon.payout_gate()")"
fi

if ((FAILS)); then
  say "summary: FAILED ($FAILS failed, $SKIPS skipped) finished=$(pt_ts) report=$REPORT"
  exit 1
fi
say "summary: PASSED ($SKIPS skipped) finished=$(pt_ts) report=$REPORT$( ((KEEP)) && echo " (database $TARGET kept)")"
exit 0

#!/usr/bin/env bash
# Encrypted PostgreSQL backup (T-035).
#
#   pt-backup-db.sh                 back up every database in PT_PG_DATABASES, check, prune
#   pt-backup-db.sh --db NAME       back up one database (repeatable)
#   pt-backup-db.sh --no-prune      keep every set
#   pt-backup-db.sh --check-only    only verify the SHA-256 manifests of the stored sets
#   pt-backup-db.sh --prune-dry-run show what retention would delete, delete nothing
#
# What a backup set is (PT_BACKUP_DIR/sets/<UTC id>/):
#   <db>.dump.gpg       pg_dump custom format (compressed), encrypted to the PUBLIC recipient key
#   globals.sql.gpg     roles and grants (pg_dumpall --globals-only --no-role-passwords): no password
#                       hashes, so service passwords are re-set from the secret store after a restore
#   manifest.txt        set id, versions, recipient fingerprint, migrations, exact row counts per table
#   SHA256SUMS          checksums of every file above (integrity without the private key)
#
# The dump and the row counts come from ONE exported snapshot (REPEATABLE READ), so the restore drill
# can compare counts exactly. Plaintext never touches the disk: pg_dump | encrypt > file. The .env
# files and keystores are NOT in the set (separate custody, docs/runbooks/backup-restore.md).
#
# Exit codes: 0 ok; 1 backup written but a follow-up failed (integrity sweep, offsite copy);
#             2 backup failed or configuration error; 3 another run holds the lock.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=deploy/ops/lib.sh
. "$HERE/lib.sh"
pt_init

KEEP_DAILY=${PT_BACKUP_KEEP_DAILY:-7}
KEEP_WEEKLY=${PT_BACKUP_KEEP_WEEKLY:-4}
KEEP_MONTHLY=${PT_BACKUP_KEEP_MONTHLY:-12}
KEEP_HOURS=${PT_BACKUP_KEEP_HOURS:-48}
MIN_FREE_MB=${PT_BACKUP_MIN_FREE_MB:-1024}
SETS="$PT_BACKUP_DIR/sets"

DBS=()
PRUNE=1
PRUNE_DRY=0
CHECK_ONLY=0
while (($#)); do
  case $1 in
  --db) DBS+=("${2:?--db needs a name}"); shift 2 ;;
  --no-prune) PRUNE=0; shift ;;
  --prune-dry-run) PRUNE_DRY=1; shift ;;
  --check-only) CHECK_ONLY=1; shift ;;
  -h | --help) sed -n '2,25p' "$0"; exit 0 ;;
  *) pt_die 2 "unknown argument: $1" ;;
  esac
done
if ((${#DBS[@]} == 0)); then read -r -a DBS <<<"$PT_PG_DATABASES"; fi
for db in "${DBS[@]}"; do pt_valid_dbname "$db" || pt_die 2 "invalid database name: $db"; done

# ------------------------------------------------------------------ integrity sweep
check_sets() {
  local bad=0 n=0 s
  [[ -d $SETS ]] || { pt_log "no sets yet in $SETS"; return 0; }
  for s in "$SETS"/*/; do
    s=${s%/}
    [[ ${s##*/} =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || continue
    n=$((n + 1))
    if [[ ! -f $s/SHA256SUMS ]] || ! (cd "$s" && sha256sum --quiet --strict -c SHA256SUMS >/dev/null 2>&1); then
      pt_err "integrity check FAILED for set ${s##*/}"
      bad=$((bad + 1))
    fi
  done
  pt_log "integrity: $n sets checked, $bad failed"
  return $((bad > 0))
}

# ------------------------------------------------------------------ retention (GFS)
prune() {
  local -a ids
  local -A keep=() day=() week=() month=()
  local id d w m nd=0 nw=0 nm=0
  mapfile -t ids < <(find "$SETS" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' 2>/dev/null | grep -E '^[0-9]{8}T[0-9]{6}Z$' | sort -r)
  ((${#ids[@]})) || return 0
  for id in "${ids[@]}"; do # newest first: the first set seen per day/week/month is that period's newest
    d=${id:0:8}
    m=${id:0:6}
    w=$(date -u -d "${id:0:4}-${id:4:2}-${id:6:2}" +%G%V)
    if [[ -z ${day[$d]:-} ]] && ((nd < KEEP_DAILY)); then day[$d]=1; nd=$((nd + 1)); keep[$id]=1; fi
    if [[ -z ${week[$w]:-} ]] && ((nw < KEEP_WEEKLY)); then week[$w]=1; nw=$((nw + 1)); keep[$id]=1; fi
    if [[ -z ${month[$m]:-} ]] && ((nm < KEEP_MONTHLY)); then month[$m]=1; nm=$((nm + 1)); keep[$id]=1; fi
  done
  keep[${ids[0]}]=1 # never delete the newest set
  # Every set younger than KEEP_HOURS stays too, so an ad-hoc backup taken before a deploy or a
  # migration is not collapsed into "one per day" by the next scheduled run.
  local now age
  now=$(date -u +%s)
  for id in "${ids[@]}"; do
    age=$((now - $(date -u -d "${id:0:4}-${id:4:2}-${id:6:2} ${id:9:2}:${id:11:2}:${id:13:2}" +%s)))
    ((age < KEEP_HOURS * 3600)) && keep[$id]=1
  done
  for id in "${ids[@]}"; do
    [[ -n ${keep[$id]:-} ]] && continue
    if ((PRUNE_DRY)); then
      pt_log "retention: would delete set $id"
    else
      rm -rf -- "${SETS:?}/$id"
      pt_log "retention: deleted set $id"
    fi
  done
  # Leftovers of crashed runs (never complete sets) older than a day.
  find "$SETS" -mindepth 1 -maxdepth 1 -type d -name '.partial-*' -mmin +1440 -exec rm -rf -- {} + 2>/dev/null || true
  pt_log "retention: keeping ${#keep[@]} of ${#ids[@]} sets (all < ${KEEP_HOURS} h, daily $KEEP_DAILY, weekly $KEEP_WEEKLY, monthly $KEEP_MONTHLY)"
}

if ((CHECK_ONLY)); then
  check_sets && exit 0 || exit 1
fi
if ((PRUNE_DRY)); then
  prune
  exit 0
fi

# ------------------------------------------------------------------ preflight
pt_require_encryption
EXT=$(pt_enc_ext)
mkdir -p "$SETS"
chmod 700 "$PT_BACKUP_DIR" "$SETS" 2>/dev/null || true
free_mb=$(df -B1M --output=avail "$SETS" | tail -1 | tr -dc '0-9')
((free_mb >= MIN_FREE_MB)) || pt_die 2 "only ${free_mb} MB free in $SETS (need $MIN_FREE_MB)"
pt_lock backup-db
pt_pg_setup
"$(pt_pg pg_isready)" -q || pt_die 2 "PostgreSQL is not reachable at $PT_PG_HOST:$PT_PG_PORT"

ID=$(date -u +%Y%m%dT%H%M%SZ)
WORK="$SETS/.partial-$ID"
mkdir -m 700 "$WORK"
pt_on_exit "[[ -d '$WORK' ]] && rm -rf '$WORK'"
MANIFEST="$WORK/manifest.txt"
{
  echo "format=pt-backup-v1"
  echo "set_id=$ID"
  echo "created_utc=$(pt_ts)"
  echo "host=$(hostname)"
  echo "repo_commit=$(git -C "$PT_REPO" rev-parse HEAD 2>/dev/null || echo unknown)"
  echo "encryption=$PT_BACKUP_ENCRYPTION"
  echo "recipient=$(pt_recipient_id)"
  echo "pg_server_version=$(pt_psql postgres -c 'SHOW server_version' | tr -d '\r')"
  echo "pg_dump_version=$("$(pt_pg pg_dump)" --version | tr -d '\r')"
} >"$MANIFEST"

# Reads lines from the snapshot session until the sentinel; strips CR (psql on Windows).
read_until() { # sentinel out_array
  local -n _out=$2
  local line
  _out=()
  while IFS= read -r -t 60 line <&"${SNAP[0]}"; do
    line=${line%$'\r'}
    [[ $line == "$1" ]] && return 0
    _out+=("$line")
  done
  return 1
}

COUNT_SQL="SELECT format('%s.%s', n.nspname, c.relname) || '=' ||
  (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', n.nspname, c.relname), false, true, '')))[1]::text
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'
ORDER BY 1;"

dump_db() { # db
  local db=$1
  local snap out="$WORK/$db.dump.$EXT" t0 migr r
  local -a lines rows
  t0=$(date +%s)
  coproc SNAP { "$(pt_pg psql)" -X -q -At -v ON_ERROR_STOP=1 -d "$db" 2>&1; }
  {
    echo "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;"
    echo "SELECT pg_export_snapshot();"
    echo "SELECT '--END1--';"
  } >&"${SNAP[1]}"
  read_until --END1-- lines || pt_die 2 "$db: could not open a snapshot session"
  snap=${lines[-1]:-}
  [[ $snap =~ ^[0-9A-F]+-[0-9A-F]+-[0-9]+$ ]] || pt_die 2 "$db: unexpected snapshot reply: ${lines[*]:0:2}"
  # Row counts and migrations inside the SAME snapshot as the dump.
  {
    echo "$COUNT_SQL"
    echo "SELECT '--END2--';"
    echo "SELECT CASE WHEN to_regclass('public.schema_migrations') IS NULL THEN '' ELSE (SELECT string_agg(name, ',' ORDER BY name) FROM public.schema_migrations) END;"
    echo "SELECT '--END3--';"
  } >&"${SNAP[1]}"
  read_until --END2-- lines || pt_die 2 "$db: row counts failed"
  rows=("${lines[@]}")
  read_until --END3-- lines || pt_die 2 "$db: migration list failed"
  migr=${lines[0]:-}
  "$(pt_pg pg_dump)" -d "$db" --format=custom --compress=6 --snapshot="$snap" --no-password | pt_encrypt >"$out" ||
    pt_die 2 "$db: pg_dump or encryption failed"
  echo "COMMIT;" >&"${SNAP[1]}"
  snap_w=${SNAP[1]}
  exec {snap_w}>&- # close the coproc input so psql ends the snapshot session
  wait "$SNAP_PID" 2>/dev/null || true
  [[ -s $out ]] || pt_die 2 "$db: empty dump"
  {
    echo "db.$db.file=${out##*/}"
    echo "db.$db.bytes=$(wc -c <"$out" | tr -d ' ')"
    echo "db.$db.migrations=$migr"
    echo "db.$db.tables=${#rows[@]}"
    for r in "${rows[@]}"; do echo "rows.$db.$r"; done
  } >>"$MANIFEST"
  pt_log "$db: ${#rows[@]} tables, $(wc -c <"$out" | tr -d ' ') bytes encrypted, $(($(date +%s) - t0)) s"
}

for db in "${DBS[@]}"; do dump_db "$db"; done

"$(pt_pg pg_dumpall)" -l postgres --globals-only --no-role-passwords --no-password | pt_encrypt >"$WORK/globals.sql.$EXT" ||
  pt_die 2 "globals dump failed"
echo "globals.file=globals.sql.$EXT" >>"$MANIFEST"
echo "databases=${DBS[*]}" >>"$MANIFEST"

(cd "$WORK" && find . -maxdepth 1 -type f ! -name SHA256SUMS -printf '%f\n' | sort | xargs sha256sum -- >SHA256SUMS)
(cd "$WORK" && sha256sum --quiet --strict -c SHA256SUMS) || pt_die 2 "checksum self-test failed"
mv "$WORK" "$SETS/$ID"
pt_state_write backup-db.last "set=$ID at=$(date +%s) ok=1"
pt_log "backup set $ID complete ($SETS/$ID)"

rc=0
check_sets || rc=1
((PRUNE)) && prune

if [[ -n ${PT_OFFSITE_HOOK:-} ]]; then
  if [[ -x $PT_OFFSITE_HOOK ]]; then
    if "$PT_OFFSITE_HOOK" "$SETS/$ID"; then
      pt_state_write backup-offsite.last "set=$ID at=$(date +%s) ok=1"
      pt_log "offsite copy done"
    else
      pt_err "offsite hook failed for set $ID"
      rc=1
    fi
  else
    pt_err "PT_OFFSITE_HOOK is set but not executable"
    rc=1
  fi
fi
exit "$rc"

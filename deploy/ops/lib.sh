# shellcheck shell=bash
# Shared helpers for the operations scripts in deploy/ops (sourced, never executed).
#
# Rules every script follows:
#   - Never print, log or store a secret. Passwords reach PostgreSQL through a private pgpass file
#     in a mode-0700 temporary directory that is removed on exit; .env files are never sourced,
#     only the single password line is read.
#   - Configuration comes from /etc/pt-ops/ops.env (non-secret KEY=VALUE, parsed, not sourced) or
#     the environment. The environment wins.
#   - Exit codes: 0 ok, 1 check failed / warning, 2 critical or usage error (per script header).

PT_OPS_VERSION=1

pt_ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
pt_log() { printf '%s %s\n' "$(pt_ts)" "$*"; }
pt_warn() { printf '%s WARN %s\n' "$(pt_ts)" "$*" >&2; }
pt_err() { printf '%s ERROR %s\n' "$(pt_ts)" "$*" >&2; }
pt_die() { # code message
  pt_err "$2"
  exit "$1"
}

# ------------------------------------------------------------------ configuration
# Reads PT_* keys from a KEY=VALUE file without executing it. Existing environment values win.
pt_read_config() { # file
  local file=$1 line key val
  [[ -r $file ]] || return 0
  while IFS= read -r line || [[ -n $line ]]; do
    line=${line%$'\r'}
    [[ $line =~ ^(PT_[A-Z0-9_]+)=(.*)$ ]] || continue
    key=${BASH_REMATCH[1]}
    val=${BASH_REMATCH[2]}
    if [[ $val =~ ^\"(.*)\"$ || $val =~ ^\'(.*)\'$ ]]; then val=${BASH_REMATCH[1]}; fi
    if [[ -z ${!key+x} ]]; then
      printf -v "$key" '%s' "$val"
      export "${key?}"
    fi
  done <"$file"
}

# Reads ONE key's value from a KEY=VALUE secrets file (e.g. backend/.env.local) into the named
# variable, without sourcing the file and without the value ever appearing in a command line.
pt_read_secret() { # file key out_var
  local file=$1 key=$2 line found=""
  [[ -r $file ]] || return 1
  while IFS= read -r line || [[ -n $line ]]; do
    line=${line%$'\r'}
    if [[ $line == "$key="* ]]; then found=${line#*=}; fi
  done <"$file"
  [[ -n $found ]] || return 1
  printf -v "$3" '%s' "$found"
}

pt_defaults() {
  local here repo_guess
  here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
  PT_OPS_DIR=${PT_OPS_DIR:-$here}
  repo_guess=$(cd "$here/../.." 2>/dev/null && pwd || true)
  if [[ -z ${PT_REPO:-} ]]; then
    if [[ -n $repo_guess && -d $repo_guess/backend && -d $repo_guess/chain ]]; then PT_REPO=$repo_guess; else PT_REPO=/home/ubuntu/property-token; fi
  fi
  PT_PG_HOST=${PT_PG_HOST:-127.0.0.1}
  PT_PG_PORT=${PT_PG_PORT:-5433}
  PT_PG_USER=${PT_PG_USER:-pt_admin}
  PT_PG_DATABASES=${PT_PG_DATABASES:-property_token}
  PT_PG_PASSWORD_FILE=${PT_PG_PASSWORD_FILE:-$PT_REPO/backend/.env.local}
  PT_PG_PASSWORD_KEY=${PT_PG_PASSWORD_KEY:-PG_ADMIN_PASSWORD}
  PT_BACKUP_DIR=${PT_BACKUP_DIR:-/var/backups/pt}
  PT_BACKUP_ENCRYPTION=${PT_BACKUP_ENCRYPTION:-gpg}
  PT_BACKUP_RECIPIENT_FILE=${PT_BACKUP_RECIPIENT_FILE:-/etc/pt-ops/backup-recipient.asc}
  PT_STATE_DIR=${PT_STATE_DIR:-/var/lib/pt-ops}
  PT_ALERT_ENV_FILE=${PT_ALERT_ENV_FILE:-/etc/pt-ops/alert.env}
  export PT_OPS_DIR PT_REPO PT_PG_HOST PT_PG_PORT PT_PG_USER PT_PG_DATABASES PT_PG_PASSWORD_FILE \
    PT_PG_PASSWORD_KEY PT_BACKUP_DIR PT_BACKUP_ENCRYPTION PT_BACKUP_RECIPIENT_FILE PT_STATE_DIR PT_ALERT_ENV_FILE
}

# ------------------------------------------------------------------ private temp dir and cleanup
PT_CLEANUP=()
pt_on_exit() { PT_CLEANUP+=("$*"); }
pt_cleanup() {
  local i
  for ((i = ${#PT_CLEANUP[@]} - 1; i >= 0; i--)); do eval "${PT_CLEANUP[i]}" || true; done
}

pt_init() {
  umask 077
  pt_read_config "${PT_OPS_ENV:-/etc/pt-ops/ops.env}"
  pt_defaults
  PT_TMP=$(mktemp -d "${TMPDIR:-/tmp}/pt-ops.XXXXXX")
  chmod 700 "$PT_TMP"
  pt_on_exit "rm -rf '$PT_TMP'"
  trap pt_cleanup EXIT
  trap 'exit 130' INT TERM
  mkdir -p "$PT_STATE_DIR" 2>/dev/null || true
}

# Native Windows programs (local drills in Git Bash) need Windows paths in environment variables.
pt_native_path() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi
}

# One instance per lock name: flock where available, an atomic mkdir otherwise.
pt_lock() { # name
  local name=$1
  mkdir -p "$PT_STATE_DIR"
  if command -v flock >/dev/null 2>&1; then
    exec {PT_LOCK_FD}>"$PT_STATE_DIR/$name.lock"
    flock -n "$PT_LOCK_FD" || pt_die 3 "another $name run holds the lock"
  else
    mkdir "$PT_STATE_DIR/$name.lockdir" 2>/dev/null || pt_die 3 "another $name run holds the lock ($PT_STATE_DIR/$name.lockdir)"
    pt_on_exit "rmdir '$PT_STATE_DIR/$name.lockdir'"
  fi
}

# ------------------------------------------------------------------ PostgreSQL
pt_pg_bindir() {
  local d
  for d in "${PT_PG_BINDIR:-}" "$PT_REPO/backend/tools/pgsql/bin" /usr/lib/postgresql/18/bin; do
    [[ -n $d ]] || continue
    if [[ -x $d/pg_dump || -x $d/pg_dump.exe ]]; then
      printf '%s' "$d"
      return 0
    fi
  done
  return 1
}

pt_pg() { # tool -> full path
  local dir
  dir=$(pt_pg_bindir) || pt_die 2 "PostgreSQL client tools not found (set PT_PG_BINDIR)"
  if [[ -x $dir/$1.exe ]]; then printf '%s' "$dir/$1.exe"; else printf '%s' "$dir/$1"; fi
}

# Exports PGHOST/PGPORT/PGUSER and a private PGPASSFILE. The password never enters argv or the
# environment of any process.
pt_pg_setup() {
  local pw="" pass esc
  export PGHOST=$PT_PG_HOST PGPORT=$PT_PG_PORT PGUSER=$PT_PG_USER PGCONNECT_TIMEOUT=10
  export PGAPPNAME=${PGAPPNAME:-pt-ops}
  unset PGPASSWORD
  if [[ -n ${PT_PG_PASSFILE:-} ]]; then
    [[ -r $PT_PG_PASSFILE ]] || pt_die 2 "PT_PG_PASSFILE is not readable"
    PGPASSFILE=$(pt_native_path "$PT_PG_PASSFILE")
    export PGPASSFILE
    return 0
  fi
  pt_read_secret "$PT_PG_PASSWORD_FILE" "$PT_PG_PASSWORD_KEY" pw ||
    pt_die 2 "no $PT_PG_PASSWORD_KEY in $PT_PG_PASSWORD_FILE (or set PT_PG_PASSFILE)"
  esc=${pw//\\/\\\\}
  esc=${esc//:/\\:}
  pass="$PT_TMP/pgpass"
  (umask 077 && printf '%s:%s:*:%s:%s\n' "$PT_PG_HOST" "$PT_PG_PORT" "$PT_PG_USER" "$esc" >"$pass")
  pw="" esc=""
  PGPASSFILE=$(pt_native_path "$pass")
  export PGPASSFILE
}

pt_psql() { # db, then psql args; never reads ~/.psqlrc
  local db=$1
  shift
  "$(pt_pg psql)" -X -q -At -v ON_ERROR_STOP=1 -d "$db" "$@"
}

pt_valid_dbname() { [[ $1 =~ ^[a-z_][a-z0-9_]{0,62}$ ]]; }

# ------------------------------------------------------------------ encryption (public key only)
pt_enc_ext() { case $PT_BACKUP_ENCRYPTION in gpg) printf 'gpg' ;; age) printf 'age' ;; *) return 1 ;; esac; }

pt_require_encryption() {
  local f=$PT_BACKUP_RECIPIENT_FILE
  case $PT_BACKUP_ENCRYPTION in
  gpg) command -v gpg >/dev/null 2>&1 || pt_die 2 "gpg not installed" ;;
  age) command -v age >/dev/null 2>&1 || pt_die 2 "age not installed (apt-get install age)" ;;
  *) pt_die 2 "PT_BACKUP_ENCRYPTION must be gpg or age" ;;
  esac
  [[ -s $f ]] || pt_die 2 "backup recipient (public key) missing: $f"
  # The private key must stay offline: refuse a file that contains one.
  if grep -q -e 'PRIVATE KEY' -e 'AGE-SECRET-KEY' "$f"; then
    pt_die 2 "$f contains a PRIVATE key; only the public recipient may be on this host"
  fi
  if [[ $PT_BACKUP_ENCRYPTION == gpg ]]; then
    mkdir -p "$PT_TMP/gnupg" && chmod 700 "$PT_TMP/gnupg"
    pt_on_exit "gpgconf --homedir '$PT_TMP/gnupg' --kill all >/dev/null 2>&1"
    gpg --homedir "$PT_TMP/gnupg" --batch --quiet --show-keys --with-colons "$f" 2>/dev/null | grep -q '^pub:' ||
      pt_die 2 "$f is not an OpenPGP public key"
  fi
}

pt_recipient_id() {
  case $PT_BACKUP_ENCRYPTION in
  gpg) gpg --homedir "$PT_TMP/gnupg" --batch --quiet --show-keys --with-colons "$PT_BACKUP_RECIPIENT_FILE" 2>/dev/null |
    awk -F: '$1=="fpr"{print $10; exit}' ;;
  age) grep -m1 '^age1' "$PT_BACKUP_RECIPIENT_FILE" ;;
  esac
}

pt_encrypt() { # stdin -> stdout
  case $PT_BACKUP_ENCRYPTION in
  gpg) gpg --homedir "$PT_TMP/gnupg" --batch --no-tty --quiet --trust-model always --compress-algo none \
    --recipient-file "$PT_BACKUP_RECIPIENT_FILE" --encrypt ;;
  age) age --encrypt -R "$PT_BACKUP_RECIPIENT_FILE" ;;
  esac
}

# Decryption needs the OFFLINE private key: the operator's GnuPG home / smartcard, or an age
# identity file brought to the restore host for the drill and removed afterwards.
pt_decrypt() { # file -> stdout
  case $1 in
  *.gpg)
    if [[ -n ${PT_RESTORE_GNUPGHOME:-} ]]; then
      gpg --homedir "$PT_RESTORE_GNUPGHOME" --quiet --decrypt "$1"
    else
      gpg --quiet --decrypt "$1"
    fi
    ;;
  *.age)
    [[ -r ${PT_RESTORE_AGE_IDENTITY:-} ]] || pt_die 2 "set PT_RESTORE_AGE_IDENTITY to the offline age identity file"
    age --decrypt -i "$PT_RESTORE_AGE_IDENTITY" "$1"
    ;;
  *) pt_die 2 "unknown encrypted file type: $1" ;;
  esac
}

# ------------------------------------------------------------------ misc
pt_sha256() { sha256sum "$1" | awk '{print $1}'; }

pt_alert() { # severity source ; message on stdin
  "$PT_OPS_DIR/pt-alert.sh" "$1" "$2"
}

# Writes "key=value" state atomically.
pt_state_write() { # name content
  local f="$PT_STATE_DIR/$1"
  printf '%s\n' "$2" >"$f.tmp" && mv -f "$f.tmp" "$f"
}

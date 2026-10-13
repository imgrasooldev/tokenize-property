#!/usr/bin/env bash
# Installs the operations pack on the demo server (idempotent; safe to re-run after every update).
#
#   sudo bash deploy/ops/install.sh [--recipient <public-key file>] [--enable <list>] [--disable <list>]
#
#   <list> is comma-separated: health, backup, recon, anchor-verify, audit-chains
#
# What it does:
#   - copies the scripts to /usr/local/lib/pt-ops (root-owned: a later `git checkout` by update.sh,
#     or the CI deploy key, can never change a running or scheduled ops script)
#   - installs the systemd units and timers from deploy/ops/systemd (all timers stay OFF unless
#     listed in --enable; already enabled timers stay enabled)
#   - creates /etc/pt-ops/ops.env and /etc/pt-ops/alert.env from the examples if they are missing
#     (never overwrites them), /var/backups/pt (0700) and /var/lib/pt-ops (0700), owned by ubuntu
#   - with --recipient: installs the backup PUBLIC key after checking it is a public key only
# It never starts a backup, a job or a validator snapshot by itself.
#
# Hook-in later (lead): provision.sh may call `bash "$APP/deploy/ops/install.sh"` after its
# "systemd units" step; update.sh may call `sudo bash deploy/ops/install.sh` after the nginx step
# so script fixes reach /usr/local/lib/pt-ops on every deploy (timers keep their state).
set -euo pipefail
[[ $(id -u) == 0 ]] || { echo "run as root: sudo bash deploy/ops/install.sh" >&2; exit 2; }
SRC=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
APP_USER=${PT_APP_USER:-ubuntu}
LIB=/usr/local/lib/pt-ops
ETC=/etc/pt-ops
UNITS=/etc/systemd/system

RECIPIENT="" ENABLE="" DISABLE=""
while (($#)); do
  case $1 in
  --recipient) RECIPIENT=${2:?}; shift 2 ;;
  --enable) ENABLE=${2:?}; shift 2 ;;
  --disable) DISABLE=${2:?}; shift 2 ;;
  -h | --help) sed -n '2,22p' "$0"; exit 0 ;;
  *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

timer_of() {
  case $1 in
  health) echo pt-ops-health.timer ;;
  backup) echo pt-backup-db.timer ;;
  recon) echo pt-recon.timer ;;
  anchor-verify) echo pt-anchor-verify.timer ;;
  audit-chains) echo pt-audit-chains.timer ;;
  *) echo "unknown timer '$1' (health, backup, recon, anchor-verify, audit-chains)" >&2; return 1 ;;
  esac
}
# Validate the lists before changing anything.
for n in ${ENABLE//,/ } ${DISABLE//,/ }; do timer_of "$n" >/dev/null; done

echo "== tools"
for t in gpg sha256sum curl flock systemctl; do command -v "$t" >/dev/null || { echo "missing tool: $t" >&2; exit 2; }; done
[[ -x /usr/lib/postgresql/18/bin/pg_dump ]] || echo "warning: /usr/lib/postgresql/18/bin/pg_dump not found (set PT_PG_BINDIR in $ETC/ops.env)"

echo "== scripts -> $LIB (root-owned)"
install -d -o root -g root -m 0755 "$LIB"
for f in lib.sh pt-alert.sh pt-backup-db.sh pt-besu-snapshot.sh pt-health.sh pt-job.sh pt-restore-db.sh pt-unit-failed.sh; do
  install -o root -g root -m 0755 "$SRC/$f" "$LIB/$f"
done
chmod 0644 "$LIB/lib.sh"

echo "== configuration in $ETC (existing files are kept)"
install -d -o root -g root -m 0755 "$ETC"
[[ -f $ETC/ops.env ]] || install -o root -g root -m 0644 "$SRC/ops.env.example" "$ETC/ops.env"
[[ -f $ETC/alert.env ]] || install -o root -g "$APP_USER" -m 0640 "$SRC/alert.env.example" "$ETC/alert.env"
chown root:"$APP_USER" "$ETC/alert.env" && chmod 0640 "$ETC/alert.env"

if [[ -n $RECIPIENT ]]; then
  [[ -s $RECIPIENT ]] || { echo "recipient file missing: $RECIPIENT" >&2; exit 2; }
  if grep -q -e 'PRIVATE KEY' -e 'AGE-SECRET-KEY' "$RECIPIENT"; then
    echo "REFUSED: $RECIPIENT contains a PRIVATE key. Only the public key may be on the server." >&2
    exit 2
  fi
  if grep -q '^age1' "$RECIPIENT"; then
    install -o root -g root -m 0644 "$RECIPIENT" "$ETC/backup-recipient.txt"
    echo "age recipient installed: set PT_BACKUP_ENCRYPTION=age and PT_BACKUP_RECIPIENT_FILE=$ETC/backup-recipient.txt in $ETC/ops.env"
  else
    g=$(mktemp -d)
    if ! gpg --homedir "$g" --batch --quiet --show-keys --with-colons "$RECIPIENT" 2>/dev/null | grep -q '^pub:'; then
      rm -rf "$g"
      echo "not an OpenPGP public key: $RECIPIENT" >&2
      exit 2
    fi
    fpr=$(gpg --homedir "$g" --batch --quiet --show-keys --with-colons "$RECIPIENT" | awk -F: '$1=="fpr"{print $10; exit}')
    gpgconf --homedir "$g" --kill all >/dev/null 2>&1 || true
    rm -rf "$g"
    install -o root -g root -m 0644 "$RECIPIENT" "$ETC/backup-recipient.asc"
    echo "backup recipient installed: $fpr (verify this fingerprint with the key custodian)"
  fi
fi

echo "== directories"
install -d -o "$APP_USER" -g "$APP_USER" -m 0700 /var/backups/pt /var/lib/pt-ops

echo "== systemd units (timers OFF unless enabled)"
for u in "$SRC"/systemd/*.service "$SRC"/systemd/*.timer; do
  install -o root -g root -m 0644 "$u" "$UNITS/${u##*/}"
done
systemctl daemon-reload
for n in ${DISABLE//,/ }; do
  t=$(timer_of "$n")
  systemctl disable --now "$t" >/dev/null 2>&1 || true
  echo "disabled $t"
done
for n in ${ENABLE//,/ }; do
  t=$(timer_of "$n")
  if [[ $n == backup ]] && [[ ! -s $ETC/backup-recipient.asc && ! -s $ETC/backup-recipient.txt ]]; then
    echo "REFUSED to enable backups: no backup recipient installed (use --recipient <public key>)" >&2
    exit 2
  fi
  systemctl enable --now "$t" >/dev/null
  echo "enabled $t"
  # From now on the health check reports a missing or old backup.
  [[ $n == backup ]] && sed -i 's/^PT_BACKUP_EXPECTED=0$/PT_BACKUP_EXPECTED=1/' "$ETC/ops.env"
done

echo "== state"
systemctl list-timers --all --no-pager 'pt-*' || true
echo "install done. Configuration: $ETC/ops.env (non-secret), $ETC/alert.env (webhook). Docs: docs/OPERATIONS.md"

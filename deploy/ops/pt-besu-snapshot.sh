#!/usr/bin/env bash
# Encrypted data snapshot of ONE Besu validator, never more than one at a time (T-035).
#
#   pt-besu-snapshot.sh <node number 1-4> [--dry-run]
#
# QBFT with 4 validators finalizes blocks while 3 are up. This script therefore refuses to start
# unless ALL validators are up, fully peered and producing blocks; stops only the chosen node;
# checks that the other three still produce blocks (restarts at once and aborts otherwise);
# archives chain/data/node<N> (chain database only: the node key lives in chain/network/generated
# and is NOT copied); restarts the node and waits until it has caught up and re-peered.
# A trap restarts the node on any exit after it was stopped.
#
# Output: PT_BACKUP_DIR/besu/<UTC id>-node<N>.tar.gz.<gpg|age> + .sha256 (newest PT_BESU_KEEP kept).
# Demo topology (4 validators on one host, chain/net.py). Production validators run on separate
# hosts by separate organisations; each operator snapshots its own node (docs/runbooks/backup-restore.md).
#
# Exit codes: 0 done; 1 node did not catch up in time (it is running; investigate); 2 refused or failed.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=deploy/ops/lib.sh
. "$HERE/lib.sh"
pt_init

NODE=${1:-}
DRY=0
[[ ${2:-} == --dry-run ]] && DRY=1
[[ $NODE =~ ^[1-4]$ ]] || pt_die 2 "usage: pt-besu-snapshot.sh <1-4> [--dry-run]"
# Restarting the validator as root would leave root-owned chain files and a root JVM.
[[ $(id -u) != 0 ]] || pt_die 2 "run as the app user (ubuntu), not root"
NODES=4
RPC_BASE=8545
KEEP=${PT_BESU_KEEP:-4}
CATCHUP_S=${PT_BESU_CATCHUP_SECONDS:-600}
DATA="$PT_REPO/chain/data/node$NODE"
OUT_DIR="$PT_BACKUP_DIR/besu"
PY=${PT_PYTHON:-python3}

rpc() { # port method -> integer or empty
  local hex
  hex=$(curl -s --max-time 3 -H 'Content-Type: application/json' \
    --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$2\",\"params\":[]}" "http://127.0.0.1:$1" 2>/dev/null |
    sed -n 's/.*"result":"\(0x[0-9a-fA-F]*\)".*/\1/p')
  [[ -n $hex ]] && echo $((hex))
}
height() { rpc "$((RPC_BASE + $1 - 1))" eth_blockNumber; }
peers() { rpc "$((RPC_BASE + $1 - 1))" net_peerCount; }
max_other_height() {
  local i h m=0
  for ((i = 1; i <= NODES; i++)); do
    ((i == NODE)) && continue
    h=$(height "$i" || true)
    [[ -n $h ]] && ((h > m)) && m=$h
  done
  echo "$m"
}

# ------------------------------------------------------------------ preconditions (read-only)
[[ -d $DATA ]] || pt_die 2 "no data directory $DATA"
for ((i = 1; i <= NODES; i++)); do
  h=$(height "$i" || true)
  p=$(peers "$i" || true)
  [[ -n $h ]] || pt_die 2 "node$i is not answering: never stop a validator while another one is down"
  ((p >= NODES - 1)) || pt_die 2 "node$i has $p peers (need $((NODES - 1))): network not fully meshed"
  pt_log "node$i: height $h, peers $p"
done
before=$(max_other_height)
sleep 5
after=$(max_other_height)
((after > before)) || pt_die 2 "chain is not producing blocks; refusing"
if ((DRY)); then
  pt_log "dry run: all $NODES validators healthy; node$NODE could be snapshotted now"
  exit 0
fi

pt_require_encryption
EXT=$(pt_enc_ext)
mkdir -p "$OUT_DIR"
pt_lock besu-snapshot
ID=$(date -u +%Y%m%dT%H%M%SZ)
OUT="$OUT_DIR/$ID-node$NODE.tar.gz.$EXT"

STOPPED=0
restart_node() {
  if ((STOPPED)); then
    pt_log "starting node$NODE"
    (cd "$PT_REPO" && "$PY" chain/net.py start "node$NODE") || pt_err "node$NODE start failed: start it by hand NOW"
    STOPPED=0
  fi
}
pt_on_exit restart_node

pt_log "stopping node$NODE (the other $((NODES - 1)) keep finalizing)"
STOPPED=1
(cd "$PT_REPO" && "$PY" chain/net.py stop "node$NODE")
sleep 2
before=$(max_other_height)
sleep 8
after=$(max_other_height)
if ((after <= before)); then
  pt_err "the remaining validators stopped producing blocks; restarting node$NODE and aborting"
  exit 2
fi
pt_log "chain still producing blocks without node$NODE (height $after)"

t0=$(date +%s)
tar -C "$PT_REPO/chain/data" --exclude='besu.pid' --exclude='besu.log' --exclude='*.log' -czf - "node$NODE" |
  pt_encrypt >"$OUT.partial" || pt_die 2 "archive or encryption failed"
mv "$OUT.partial" "$OUT"
(cd "$OUT_DIR" && sha256sum -- "${OUT##*/}" >"${OUT##*/}.sha256")
pt_log "snapshot $OUT ($(wc -c <"$OUT" | tr -d ' ') bytes, $(($(date +%s) - t0)) s)"

restart_node
deadline=$(($(date +%s) + CATCHUP_S))
while (($(date +%s) < deadline)); do
  h=$(height "$NODE" || true)
  p=$(peers "$NODE" || true)
  m=$(max_other_height)
  if [[ -n $h && -n $p ]] && ((p >= NODES - 1 && m - h <= 2)); then
    pt_log "node$NODE back: height $h (others $m), peers $p"
    find "$OUT_DIR" -maxdepth 1 -name "*-node$NODE.tar.gz.*" ! -name '*.sha256' -printf '%f\n' | sort -r | tail -n +$((KEEP + 1)) |
      while read -r f; do rm -f -- "$OUT_DIR/$f" "$OUT_DIR/$f.sha256"; done
    exit 0
  fi
  sleep 5
done
pt_err "node$NODE did not catch up within ${CATCHUP_S}s (height ${h:-none}, others $m, peers ${p:-none})"
exit 1

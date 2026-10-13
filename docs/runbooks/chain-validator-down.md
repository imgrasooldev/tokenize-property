# Runbook: validator down or chain halted

QBFT with 4 validators finalizes blocks while at least 3 are up (tolerates f = 1). One validator
down = SEV3 (redundancy gone). Two or more down, or no new blocks = SEV1 (chain halted: no
mints, transfers, freezes or distributions; investors still see the last state). Threat model CH-2.

## Trigger

- `pt-health`: `validator 854x: not reachable | N blocks behind | peers P` (WARN) or
  `chain: no new block ... chain halted` / `N of 4 validators down` (CRIT).
- `indexer` lag growing with the chain height not moving.
- Live Demo Console shows a node stopped.

## Immediate actions

1. Do **not** stop any other validator. Do not run `python chain/net.py reset` (it deletes chain data).
2. Check what is down (read-only):
   ```bash
   python3 chain/net.py status                      # height, peers, validators per node
   sudo /usr/local/lib/pt-ops/pt-health.sh | grep -E 'validator|chain|swap|memory|disk'
   ```
3. If 2+ validators are down (halt): the outbox, signer and anchor job keep their records and retry
   later; no command is lost. Tell the IC; consider pausing nothing (a halted chain cannot move
   tokens anyway).

## Diagnosis

```bash
tail -n 100 chain/data/node2/besu.log                # per node; look for OutOfMemory, "Unable to", database errors
journalctl -k --since -2h | grep -i -E 'oom|killed process'   # OOM killer (4 GB demo box)
free -m; swapon --show; df -h / /var/backups/pt
timedatectl                                          # QBFT needs synchronized clocks
sudo systemctl status pt-stack --no-pager
curl -s -X POST -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"qbft_getValidatorsByBlockNumber","params":["latest"]}' http://127.0.0.1:8545
```

Common causes on the demo server: memory pressure (four JVMs, PostgreSQL and Next.js on 4 GB +
swap), disk full, a node stopped from the console and not restarted, an unclean shutdown.

## Decision points

| Situation | Action |
|---|---|
| One node down, others fine | Restart that node only: `python3 chain/net.py start node2`; wait for it to catch up (`net.py status`) |
| Node restarts and crashes again with a database error | Treat its data as corrupt: stop it, move `chain/data/node2` aside (do not delete), restore its latest snapshot (backup-restore runbook, Besu section) or let it resync from peers with an empty data dir; restart |
| 2+ nodes down | Restart them **one at a time**, waiting for each to answer before the next; blocks resume when 3 are up |
| OOM kills | Restart nodes one at a time; stop the console (`sudo systemctl stop pt-console`) to free memory; raise the swap or RAM (owner) |
| Disk full | Free space (old logs, old Besu snapshots in `/var/backups/pt/besu`), never chain data; then restart |
| Clock skew | `sudo timedatectl set-ntp true`; restart affected nodes one at a time |
| All data lost on all nodes (host lost) | SEV1 disaster: restore validators from the latest snapshots of each node (backup-restore runbook), then verify against the public anchors (`npm run anchor:verify`) |

## Recovery verification

- `python3 chain/net.py status`: all 4 nodes, same height (± 2), 3 peers each.
- `pt-health.sh`: `chain: producing blocks`.
- `npm run indexer:status`: cursor moving, not halted (an indexer halt after a chain incident is
  its own runbook: [indexer-halt.md](indexer-halt.md)).
- Outbox commands that waited during the halt are confirmed (`pt-health` outbox line OK).

## Production differences

Each validator belongs to a different organisation (platform, trustee, auditor, backup) on its own
host. The operator of the failed node restores it; nobody else can. Replacing a lost validator key
is a validator-set vote (`qbft_proposeValidatorVote` by a majority of validators), agreed between
the organisations and recorded as a governance decision.

## Post-incident record

Incident record per [incident-response.md](incident-response.md): which nodes, how long the chain
was degraded or halted, root cause (memory, disk, crash), and whether the demo server's single host
risk (OPERATIONS.md section 9) needs action.

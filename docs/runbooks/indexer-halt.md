# Runbook: indexer halted (hash or chain mismatch) and indexer lag

The indexer (ADR 0006) follows the chain into the read model (schema `chain`) and **halts on any
mismatch** (rule C-6): a parent hash that does not link, a log whose block hash differs, a wrong
chain ID, a broken contract invariant. A halt is fail-closed by design: the read model stops, and
reconciliation turns a halted or differing indexer into a blocking finding that freezes payouts.
Threat model D-3. Severity: SEV2 (SEV1 if the cause may be a rewritten chain).

## Trigger

- `pt-health`: `indexer <deployment>: HALTED at block N (<reason>)` (CRIT) or `N blocks behind`.
- The indexer process exits with code 3; `chain_alert` NOTIFY.
- `npm run indexer:verify` exits 1 (read model differs from the contracts).
- Reconciliation finding about the indexer.

## Immediate actions

1. Do **not** clear the halt, edit `chain.*` rows, or reset anything. The halt is evidence.
2. Record the halt reason and block:
   ```bash
   cd ~/property-token/backend
   npm run indexer:status                  # cursor, lag, halt state and reason
   python3 ../chain/net.py status          # current chain height per validator
   ```
3. Payouts are blocked by the next reconciliation anyway; tell the payout approvers not to approve
   batches until this is closed.

## Diagnosis

```sql
-- read-only, as an operator
SELECT deployment, block_number, block_hash, halted_at, halt_reason FROM chain.cursors;
SELECT * FROM chain.halts ORDER BY id DESC LIMIT 10;
SELECT number, hash, parent_hash FROM chain.blocks ORDER BY number DESC LIMIT 5;
```

```bash
# What the chain says now for the cursor block (compare with chain.cursors.block_hash)
curl -s -X POST -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_getBlockByNumber","params":["0x<cursor hex>",false]}' http://127.0.0.1:8545
npm run indexer:verify                     # independent rebuild vs contracts at a pinned block
npm run anchor:verify                      # where anchoring runs: does the chain still match the public anchors?
```

## Decision points

| Cause | Meaning | Action |
|---|---|---|
| Local/demo chain was reset (`net.py reset`, new genesis) | The read model follows a chain that no longer exists | **Dev and demo only:** `npm run indexer:reset-local -- --yes`, then let it catch up. Never in production |
| Chain mismatch on a chain that was NOT reset | History was rewritten, or the indexer was pointed at another network | **SEV1.** Run `anchor:verify`: a mismatch against the public anchors means validators rewrote history (CH-1): follow [anchor-alarm.md](anchor-alarm.md) and [incident-response.md](incident-response.md); consider pausing the token |
| Wrong `CHAIN_RPC_URL`, `CHAIN_ID` or `INDEXER_DEPLOYMENT_FILE` | Configuration error | Fix the configuration; the halt still needs the clear below |
| Invariant violation (negative balance, refId twice, illegal state transition) | Either a contract bug or a decoder bug | SEV1 until proven otherwise; keep halted; involve the contracts lead; compare with `indexer:verify` |
| Indexer lag without halt | Process down, RPC slow, DB slow | Restart the indexer service; check validators and PostgreSQL; lag above `PT_INDEXER_LAG_CRIT` blocks makes reconciliation stale |

**Rebuild, do not patch.** The usual repair after the cause is understood is to rebuild the read
model into a fresh database (or schema) from the chain and switch to it after `indexer:verify`
passes. Clearing a halt in place (`chain.clear_halt(deployment, operator, reason)`) is an
administrator action with a recorded reason, done only when the cause is understood and the data
up to the cursor is proven correct; it must be agreed by two people (maker-checker, recorded in the
incident).

## Recovery verification

- `npm run indexer:status`: not halted, lag small and shrinking.
- `npm run indexer:verify`: exit 0.
- `npm run recon`: passes (or only known, accepted findings); payout gate per
  [reconciliation-freeze.md](reconciliation-freeze.md).

## Post-incident record

Halt reason, block, cause, whether history was rewritten (anchor result), how the read model was
rebuilt, who approved the clear, and the threat model update if a new cause was found.

# Runbook: anchor alarm and anchor verification mismatch

Every hour the anchor job commits the finalized Besu block hash and the ledger head to the public
chain (ADR 0008); `npm run anchor:verify` re-checks every public anchor against Besu and an
independent recomputation of the ledger from its rows. A mismatch means the private chain or the
ledger is no longer what was anchored: history was rewritten (CH-1) or the ledger was edited, even
with a full re-hash by a superuser (D-1). Severity: **SEV1** for a mismatch; SEV2 for anchors that
stopped.

Today anchoring runs against a local Anvil stand-in (chain 586650), not on the demo server; the
public L2 is pending the owner (T-033).

## Trigger

- `npm run anchor` (service) exits with code 3 (`AnchorAlarm`): the contract and the database
  disagree (unknown anchor on chain, rotated or stolen key, revert, missing contract, wrong chain).
- `pt-anchor-verify.service` failed (exit 1 = `MISMATCH`).
- `pt-health`: `anchor: last confirmed anchor N min ago` (stopped) or `failed anchor(s)`.

## Immediate actions

1. **Never "fix" an alarm by deleting or editing anchor records** (A-1, A-4); they are evidence.
2. Stop the anchor service so it does not keep retrying with a possibly stolen key.
3. Preserve evidence: `sudo systemctl start pt-backup-db.service` (ad-hoc backup), copy the anchor
   output and `npm run anchor:status`.
4. For a verify MISMATCH: tell the IC (SEV1). If the private chain may be rewritten or the ledger
   tampered with, **pause the token** ([key-compromise.md](key-compromise.md) "Pause") and stop
   payouts (do not approve batches).

## Diagnosis

```bash
cd ~/property-token/backend
npm run anchor:verify          # lists each problem: which anchor, which block, chain or ledger
npm run anchor:status          # last records, status, tx hashes
python3 ../chain/anchor.py status   # stand-in: height, contract, last anchored block
npm run recon -- --json        # ledger chain, balances, signer/recon audit chains
```

```sql
SELECT id, besu_block, besu_block_hash, ledger_journal_id, ledger_head_hash, status, failure, tx_hash
FROM anchor.anchors ORDER BY id DESC LIMIT 10;
SELECT count(*) FROM ledger.verify_chain();   -- 0 does NOT prove anything after a full re-hash;
                                              -- anchor:verify is the independent check
```

## Decision points

| `anchor:verify` says | Meaning | Action |
|---|---|---|
| Besu block hash differs at an anchored block | Private chain history rewritten (validator collusion or a reset) | SEV1; involve all validator operators and the trustee; the public anchors are the reference; restore validators from snapshots older than the divergence if needed |
| Ledger recomputation differs | Ledger rows edited/deleted after anchoring (possibly re-hashed) | SEV1 insider/DBA incident; restore-drill backups older and newer than the anchor to find when it changed (each drill prints `ledger.chain_head`); compare journals row by row; data-breach and key-compromise runbooks as applicable |
| Anchor on chain unknown to the database, or from another key | Anchor key used outside the service | [key-compromise.md](key-compromise.md) "anchor key": rotate with `StateAnchor.setAnchorer` by the anchor owner Safe |
| Reverts, gas cap, RPC errors; anchors simply stopped | Operational | Fix RPC/funding/gas settings (`ANCHOR_MAX_GAS_PRICE_WEI`), restart; the job resumes and re-broadcasts the same signed bytes (A-3) |

## Recovery verification

- `npm run anchor:verify` exit 0 across all anchors.
- New anchors confirmed hourly (`pt-health` anchor OK).
- If paused: unpause only by the Admin Safe after the IC and trustee agree.

## Post-incident record

Which anchors failed, the first divergent block or journal, root cause, who had access, key
rotations performed (with transaction hashes), threat model update (CH-1, D-1).

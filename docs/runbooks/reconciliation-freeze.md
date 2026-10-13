# Runbook: reconciliation freeze and maker-checker unfreeze

Daily reconciliation (ADR 0007) compares chain, ledger and bank in one snapshot. Any **blocking**
finding freezes payouts in the same transaction (R-2). Payouts are allowed only when not frozen
AND the latest run passed AND it is younger than 26 hours (R-4, `recon.payouts_allowed()`).
Nothing unfreezes by itself; an unfreeze needs two different operators, after a later passed run
(R-3). Severity: SEV2 (SEV1 if the finding shows value moved wrongly).

## Trigger

- `pt-recon.service` failed (exit 1 = findings, 2 = error) → OnFailure alert with the last lines.
- `pt-health`: `recon: payouts FROZEN (...)`, `last run ended in error`, `last run N h old`.
- A payout batch refused at approval or submission because the gate is closed (B-5).

## Immediate actions

1. Do not try to "make the run pass" by editing data. Never age, delete or edit `recon.*` rows:
   `recon.verify_audit()` detects it.
2. Read the state:
   ```bash
   cd ~/property-token/backend
   npm run recon:status            # gate, latest runs, open unfreeze requests, audit chain
   npm run recon -- --json         # a fresh run with every finding (writes a new run; findings freeze again if blocking)
   ```
   Use `--no-verify` only to save time while iterating; the run that unfreezes must include the
   indexer verify.
3. Tell the payout approvers that batches wait.

## Diagnosis: what each finding family means

| Finding | Usually means | Where to look |
|---|---|---|
| `integrity.ledger_chain`, `integrity.signer_audit`, `integrity.recon_audit`, `integrity.ledger_balances` | Tampering or a database fault | **SEV1**: [incident-response.md](incident-response.md); restore-drill the last backup to compare; `npm run anchor:verify` |
| `integrity.indexer_halted`, `integrity.indexer_verify`, `integrity.indexer_lag` | Read model halted, differs or is behind | [indexer-halt.md](indexer-halt.md) |
| `integrity.outbox_stuck`, `integrity.outbox_waiting` | Chain commands not finishing | [payout-incident.md](payout-incident.md) "stuck commands" |
| `issuance.orphan_mint`, `issuance.paid_not_minted`, `issuance.minted_not_settled`, `issuance.*_mismatch` | A mint without its subscription, money without a mint, wrong amount or wallet | Ledger journals `web:sub:*` / `sub:*` vs `chain.issuances`; outbox commands by ref |
| `supply.*`, `holdings.*` | Chain totals or balances differ from the read model | `indexer:verify`; chain views |
| `rent.missing_ledger`, `rent.total_mismatch`, `rent.statement_hash_mismatch`, `rent.payout_*` | Distribution not booked, or booked differently than published on chain, or payout not matching | `chain.distributions`, ledger `rent:*` journals, `bank.payout_batches` |
| `rent.payout_held` (warning) | Some investors' shares are held (no active account, KYC) | [payout-incident.md](payout-incident.md) "held payouts" |
| `cash.*` | Bank statement vs ledger: missing or extra lines, wrong amounts, stale or missing statement | Imported statements (`npm run recon:import-bank`), `bank.credits`, suspense |

**Known state today (demo and local):** every `flow.py` mint is an `issuance.orphan_mint` and every
finalized distribution a `rent.missing_ledger`, because no producer books those journals yet (Step
5h). A run there FAILS and freezes payouts: correct, not an incident. Do not enable
`pt-recon.timer` on the demo until 5h is deployed, or accept the daily alert as expected.

## Decision points

| Situation | Decision |
|---|---|
| Finding is a real discrepancy | Fix the cause through the normal, audited paths (book the missing journal through the service with an idempotency key, import the missing statement, finish the outbox command). Never by direct SQL |
| Finding is a known historical difference | Needs the owner-approved "accepted exceptions" list (two approvers, MEMORY open decision). Until that exists, the freeze stays |
| Run ended in `error` | Fix the environment (RPC, database, deployment file) and run again |
| Run is passed but older than 26 h | Run `npm run recon`; nothing else is needed |

## Maker-checker unfreeze

Only after a **later run passed** (the request is bound to the current freeze and expires after
24 h):

```bash
npm run recon -- --json                                              # must pass (exit 0)
npm run recon:unfreeze -- --request ops-ali "<what was wrong, what fixed it, incident id>"   # maker
npm run recon:unfreeze -- --approve <requestId> ops-sara "<independent check done>"         # checker, a different person
npm run recon:status                                                 # gate: allowed
```

The checker verifies independently (reads the findings and the fix), not just the maker's note.
Reject with `--reject <requestId> <operator> "<reason>"` if not convinced. In production this
happens in the operations portal (Step 6) as `pt_recon_operator`, with FIDO2 login.

## Recovery verification

- `npm run recon:status`: not frozen, latest run passed, younger than 26 h, audit chain intact.
- `pt-health`: recon OK; `pt-recon.service` succeeded at its next scheduled run.

## Post-incident record

Run ids, findings, root cause, fix, maker and checker names and reasons (they are also in the
audit chain), time payouts were blocked.

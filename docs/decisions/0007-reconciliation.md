# ADR 0007: Reconciliation (chain, ledger, bank) and the payout freeze

- Status: Accepted (owner approved the Step 5f plan 2026-10-12; reviewed and merged by the lead 2026-10-12; passing on the demo server 2026-10-13)
- Date: 2026-10-12
- Builds on: ADR 0003 (ledger), ADR 0004 (outbox), ADR 0005 (signing service, maker-checker), ADR 0006 (indexer; a `verify` mismatch must freeze payouts)
- Addresses: threats M-2 (insider changes payout amounts), M-6 (tokens without payment, payment without tokens, double charge or mint), D-1 and D-3 (tampered ledger, drifting read model)

## Context

Three records describe the same money and the same ownership:

1. the **chain**: who holds tokens, which refIds were minted, which rent distributions were published, finalized and paid (read through the indexer's read model, ADR 0006);
2. the **ledger**: payments, settlements, refunds, rent bookings and payouts (append-only, hash-chained, ADR 0003);
3. the **bank**: what really arrived in and left the trustee's escrow account (Raast).

Each record protects itself (hash chains, append-only tables, compare-and-set, maker-checker). None of them can see whether it still agrees with the other two. A bug, a crash between two steps, an insider or a tampered database can make them disagree without any single record looking wrong. The threat model's answer to M-2 is a daily three-way reconciliation that **freezes payouts on any mismatch**. ADR 0006 adds that an `indexer:verify` mismatch is such a mismatch.

There is no real bank integration yet (Step 5g), and the web prototype does not write rent into the ledger. This step therefore also fixes the conventions producers must follow and a mock bank statement format.

## Decision

**Package `@pt/recon`** and **migration `0006_recon.sql`** (schema `recon`).

### A run

1. `recon.start_run` records the run (one at a time; a run still "running" after an hour is closed as `error`).
2. One **REPEATABLE READ** snapshot of the database: read model, ledger, outbox, bank statements, webdemo subscriptions (read-only, when present), and the three integrity verifications (`ledger.verify_chain()`, `signer.verify_audit()`, `recon.verify_audit()`).
3. The **pinned block P** is the read model's cursor in that snapshot. The read model is exactly the chain at P (ADR 0006, C-1), so every chain comparison uses P: `totalSupply` and `balanceOf` of every read-model holder are read from the contracts **at block P**.
4. Optionally the indexer's full `verify` (rebuild from the chain + contract views). Its problems become findings.
5. The checks run as **pure functions** of that data (no I/O, no clock: ages are measured from the snapshot's `now()`), so the same data always gives the same findings.
6. `recon.complete_run` stores all findings and the result **in one transaction**. The database derives the status: `passed` (no blocking finding) or `failed`. Any blocking finding **freezes payouts in the same transaction**. A run that cannot load its data ends as `error`.

### Checks

| Area | Check | Severity | Reads |
|---|---|---|---|
| Issuance (M-6) | `orphan_mint`: a mint refId without a paid subscription | blocking | `chain.issuances`, ledger `sub:*` / `web:sub:*` journals |
| | `paid_not_minted`, `minted_not_settled`, `settled_without_mint`: a step not completed within the SLA (default 30 min) | blocking | same, plus block times |
| | `refunded_but_minted`, `settled_and_refunded`, `unpaid_settlement`, `settlement_mismatch` (settled/refunded ≠ paid), `duplicate_payment` | blocking | ledger |
| | `amount_mismatch`, `wallet_mismatch`: minted amount or wallet differs from the request | blocking | outbox `issuance.mint` payloads, else `webdemo.subscriptions` |
| | `command_without_payment`, `duplicate_command` | blocking | outbox |
| | `unverified_amount` (nothing to compare the mint with), `burn_not_reconciled` (no redemption convention yet) | warning | |
| Supply | `chain_vs_read_model`, `holdings_sum`, `issuance_net` (mints − burns = totalSupply) | blocking | contract at P, read model |
| Holdings | `balance_mismatch` (balanceOf at P ≠ read model), `missing_holder` (known balances ≠ totalSupply) | blocking | contract at P, read model |
| Cash | `opening_mismatch`, `closing_mismatch` (ledger balance at the PKT day cut-off ≠ bank), `statement_gap` (missing day or opening ≠ previous closing) | blocking | `recon.bank_*`, ledger postings on the mapped account |
| | `unmatched_bank_line`, `unmatched_ledger_entry`, `duplicate_ledger_entry`, `duplicate_bank_line`, `amount_mismatch`: every bank line matches exactly one ledger posting by (reference, direction) and amount, and vice versa | blocking | same |
| | `not_configured`, `no_statement`, `statement_stale` | warning | |
| Rent (M-2) | `missing_ledger` (finalized or paid, not booked), `statement_hash_mismatch`, `total_mismatch`, `booked_after_reject`, `orphan_ledger`, `payout_premature` (before finalization), `payout_missing`, `payout_batch_mismatch`, `payout_amount_mismatch` | blocking | `chain.distributions`, ledger `rent:*` journals |
| | `payout_not_recorded` (paid in the ledger, `recordPayout` not yet on chain) | warning | |
| Integrity | `ledger_chain`, `signer_audit`, `recon_audit`: hash chains broken | blocking | the verify functions |
| | `indexer_halted`, `indexer_verify` (ADR 0006) | blocking | `chain.cursors`, `verify` |
| | `outbox_stuck`: a `submitted` or `review` command older than the SLA (on-chain outcome unknown) | blocking | `outbox.commands` |
| | `indexer_lag` (> 300 blocks), `outbox_waiting` (`pending`/`claimed` older than the SLA, e.g. waiting for approval) | warning | |

The bank side of a rent payout is checked by the cash check (the payout journal's reference must match a bank debit line), so rent is three-way: chain ↔ ledger here, ledger ↔ bank there. At most 500 findings per check are listed; the rest are counted.

### Conventions (producers must follow them)

| Journal idempotency key | Meaning | `external_ref` |
|---|---|---|
| `web:sub:<uuid>:paid\|settled\|refunded` | web prototype subscription; refId = `keccak256("property-token:subscription:<uuid>")` (same as `web/src/lib/invest-rules.ts`, checked by a test) | bank reference / mint tx / bank reference |
| `sub:<refId>:paid\|settled\|refunded` | backend subscriptions (Step 5g on) | same |
| `rent:distribution:<token>:<id>` | rent booked when the distribution is finalized | the statement hash |
| `rent:payout:<token>:<id>` | the bank payout batch; credits the bank account | the batch reference |

`paid` debits a bank account; `refunded` credits it with the same reference (matched by direction). For the mock bank, `recordPayout(id, payoutBatchHash)` uses `payoutBatchHash = keccak256(utf8(batch reference))`; for a batch submitted through the bank service it is `0x` + SHA-256 of the bank file ([ADR 0009](0009-kyc-and-bank.md); reconciliation checks it).

### Mock bank statement (`pt-mock-bank-v1`)

JSON Lines: a header (`account`, `statementDate` as a PKT business day, `currency` PKR, `openingPaisa`, `closingPaisa`), one `line` per movement (`valueDate`, signed `amountPaisa`, `reference`, `counterparty`, running `balancePaisa`) and a trailer with the line count. Amounts are integer strings. The parser is strict (unknown fields, JSON numbers, decimals, control characters, impossible dates, wrong running balances are refused). Format details: `backend/packages/recon/src/bank.ts`.

### Rules enforced by the database

| Rule | What it guarantees |
|---|---|
| R-1 | Runs, findings, statements, gate events and the audit log are append-only. A run finishes once; its findings are written in the same call |
| R-2 | A blocking finding freezes payouts in the same transaction. Nothing unfreezes automatically, not even a later passed run |
| R-3 | Unfreezing is maker-checker: a request and an approval by **different** operators, each with a reason of 10–500 characters. The request is bound to the current freeze (a newer freeze makes it stale), expires after 24 hours, and can be approved only after a run that passed **after** the freezing run |
| R-4 | `recon.payouts_allowed()` is deny-by-default: true only if not frozen **and** the latest finished run passed **and** it finished less than 26 hours ago. An `error` run does not freeze but keeps payouts denied |
| R-5 | A statement is imported once (same content → same id; other content for the same account and day → refused). Opening + lines = each running balance = closing. A reference is used once per account and direction |
| R-6 | Hash-chained audit of every action. `recon.verify_audit()` recomputes every finished run with its findings and every imported statement, and finds gate events, runs or statements without their audit entry (direct inserts). Timestamps in digests are formatted in UTC, so the result does not depend on the session's TimeZone |
| R-7 | `pt_recon_writer` runs and imports; `pt_recon_operator` registers bank accounts, imports and decides unfreezes; `pt_recon_reader` reads. `pt_signer` and `pt_outbox_worker` may only call the gate |

### Where the gate is enforced

No payout path exists yet. The signing service now asks the gate for every kind named `payout.*`, `rent.*` or `distribution.*`, both when a request arrives and again when it is signed (payouts may be frozen after an approval). The kind list is deny-by-default: a future payout kind cannot skip the gate. If the gate cannot be read, the request fails and nothing is signed. The bank payout service (Step 5g, [ADR 0009](0009-kyc-and-bank.md)) checks the gate in the database at batch approval and again at submission, and for every suspense return.

### Commands

`npm run recon` (exit 0 no findings, 1 findings, 2 error), `recon:import-bank`, `recon:register-account`, `recon:status`, `recon:unfreeze -- --request | --approve | --reject`, `recon:bench`. Production runs it daily (and before every payout batch) as a login role holding `pt_recon_writer` plus the read roles of the other schemas; unfreezing belongs in the operations portal (Step 6), with SSO identities instead of typed operator names.

## What each check can read today (honest gaps)

- **Bank:** only the mock format; no real bank yet (5g). Until a statement is imported, cash is reported as `not_configured` / `no_statement` (warnings).
- **Rent in the ledger:** nothing writes the `rent:*` journals yet. The web prototype and `chain/rent.py` publish distributions on chain only, and the Demo Console's rent cycle uses keys not linked to a distribution. On the local network every finalized or paid distribution is therefore reported as `rent.missing_ledger` (blocking): correct, because nothing proves those amounts against the ledger.
- **Mints without a ledger payment:** `chain/flow.py` mints directly for the demo, so those refIds are `issuance.orphan_mint` on the local network. This is the intended behaviour; an "accepted exceptions" list (with maker-checker) is an open question.
- **Expected mint amounts:** from outbox `issuance.mint` commands; for the web prototype from `webdemo.subscriptions` (read-only). Another source of truth for subscriptions comes with 5g/5h.
- **Burns:** no redemption convention yet, reported as warnings.
- **One deployment per run**, like the indexer.
- **Not in this step:** anchoring of the ledger and audit heads on a public chain (5f-2), real bank (5g), website on the read model (5h).

## Measured (this laptop, 2026-10-12)

| What | Result |
|---|---|
| Real local chain (44,463 blocks, 116 mints, 39 holders, 3 distributions), full run incl. indexer `verify` with 213 contract reads | 10.9 s, of which `verify` 10.7 s; snapshot 52 ms, contract reads at P 59 ms, checks 29 ms |
| Synthetic (`npm run recon:bench`), 2,000 subscriptions / 4,000 journals / 2,000 mints / 2,000 bank lines | run without verify 0.7–1.1 s, with verify 2.0 s |
| Synthetic, 10,000 subscriptions / 20,000 journals / 10,000 mints / 2,000 holders / 10,000 bank lines | run without verify 2.4–3.7 s (snapshot 2.1–3.2 s, checks 0.14–0.48 s), with verify 6.6 s |

The database snapshot dominates at size (it includes `ledger.verify_chain()`, which walks the journal one row at a time in PL/pgSQL). Daily runs are far within budget.

Found while measuring: building the 20,000 bench journals took 287 s (about 14 ms per journal at the end, 4.6 ms at 4,000). `ledger.post_journal`'s overdraft check (L-6) sums every posting of each touched account, so writes to a hot account such as the escrow bank account get slower linearly with its history. Not a reconciliation problem, but it will matter for the ledger at production volume (a running-balance table or a balance snapshot would fix it): open question for the lead.

## Consequences

- Payouts can only happen after a fresh, clean reconciliation; any mismatch stops them until two people look at it.
- Producers of ledger entries must use the conventions above; otherwise reconciliation reports their entries as unmatched.
- `signer.verify_audit()` hashes timestamps in the session's TimeZone (found while building R-6): run under a different TimeZone it reports every row as changed. Recon reads it in the cluster default (Asia/Karachi). A fix needs a new migration and a re-hash plan; see open questions.
- Open questions: accepted-exception list for known historical differences (e.g. demo mints); who may register bank accounts in production (single operator today, audited); real bank batch-hash definition (5g); scheduling and alert wiring (`NOTIFY recon_alert`) in production.

## Amendment 2026-10-13: offerings (spec S-02, migration 0015, T-020)

**Problem (spec finding).** S-02 mints only at completion, for paid subscriptions (specs README §3, decision 1). Under the original rule `issuance.paid_not_minted` measured the SLA from the `sub:<refId>:paid` journal, so every normal open or funded offering would raise a blocking finding 30 minutes after the first payment and freeze all payouts for weeks.

**Change.** For a refId that belongs to an S-02 offering subscription (`offering.recon_subscriptions`), the paid → minted SLA starts when the offering's mint commands are enqueued (`offering.offerings.mint_started_at`, set by `offering.start_minting` once the completion record is approved), not at payment and not at L13. Before that a paid subscription is an allocation, not a finding. A subscription in `refund_pending`, `blocked` or `disputed` is not expected to be minted at all. RefIds that are not offering subscriptions (web prototype `web:sub:*`, earlier backend subscriptions) keep the payment-based SLA. Proven by `recon/test/offering-checks.test.ts` (pure) and `offering/test/recon.test.ts` (real loader: a live and a funded offering with two-hour-old payments raise no blocking finding; a mint window open for 45 minutes without a mint does).

**New checks** (`checkOfferings`, read from `offering.recon_subscriptions`, `offering.settings`, `offering.payment_anomalies` and `chain.tokens` for the deployment's token, only where migration 0015 exists):

| Check | Severity | Rule |
|---|---|---|
| `offering.over_hard_cap` | blocking | units held (reserved, paid, allocated, issued, refund pending, blocked, disputed) above the hard cap |
| `offering.ref_id_mismatch` | blocking | the stored refId is not `keccak256("property-token:subscription:<id>")` (the database cannot compute keccak) |
| `offering.state_mismatch` | blocking | a subscription's state and its ledger journals disagree (subscriptions vs escrow per subscription: e.g. Payment Confirmed needs `paid` and no `settled`/`refunded`) |
| `offering.escrow_mismatch` | blocking | per offering, paid − settled − refunded in the ledger ≠ the amounts of paid, unsettled, unrefunded subscriptions (money conserved) |
| `offering.paid_after_failure` / `offering.refund_overdue` | warning (both) | a paid subscription of a failed or refunding offering not yet refunded; `refund_overdue` after `refund_sla_hours` (48 h, OF-53) |
| `offering.mint_outside_window` | blocking | a `Minted` refId of an offering subscription before the mint window or in a state that may not be minted |
| `offering.allocation_mismatch` | blocking | a completed offering whose minted units differ from its settled units (minted = paid at completion) |
| `offering.cap_headroom` | blocking | while minting, trustee cap − totalSupply < units still to mint |
| `offering.payment_anomaly` | blocking | a matched credit reached a subscription that was no longer waiting for it (should be impossible; see the ADR 0009 amendment) |

Deviation from S-02 §8 ("blocking after the SLA"): `offering.refund_overdue` is a **warning**. Refunds need the payout gate (ADR 0009 B-9), a blocking finding freezes the gate, and the gate only reopens after a passing run, so a blocking overdue refund could never be cured (found in `offering/test/recon.test.ts`). The overdue refund is alerted every run instead. The S-02 checks `supply.register_mismatch` (needs the trustee's register attestation feed, S-07) and burn checks are not built yet.

## Amendment 2026-10-13: recovery and reversals (spec S-06 section 14.7, migration 0020, T-026)

| Check | Severity | Meaning |
|---|---|---|
| `recovery.unmatched` | blocking | a pending or executed RecoveryGuard request of this deployment that is not a recovery case's proposal (`recovery.recon_requests`) |
| `recovery.unmatched_cancelled` | warning | a cancelled request without a case (moved nothing; the local `chain/flow.py` scenario proposes and cancels one, so the demo server shows this warning, not a freeze) |
| `recovery.reversal_unmatched` | blocking | a ledger journal of kind `reversal` without its closed reversal case, or a closed case whose correcting journal is missing or of another kind |

Cash matching treats a journal reversed by a closed reversal case and its correcting journal as void (both, from the start: `voidedJournals`). Loaded only where the recovery schema exists. Not built yet: `compliance.freeze_unmatched`, `kyc.holder_unverified_unfrozen`, `issuance.reversed_not_resolved`.

## Amendment 2026-10-22: secondary transfers, phase 0 (S-04 section 16.8, migration 0028)

The rules are evaluated in the database (`transfer.reconcile(token)`) and mapped to findings by `checkTransfers`; loaded only where the transfer schema exists.

| Check | Severity | Meaning |
|---|---|---|
| `transfer.unapproved` | blocking | evaluated while the token is paused in the read model (phase 0; the demo network keeps its token unpaused for the demo market): a holder-to-holder `Transfer` from block `unapproved_from_block` on (the read model's head when 0028 was applied) that is neither in the transaction of an executed RecoveryGuard request linked to a transfer or recovery case, nor of a confirmed `token.transfer` command or settled demo-market trade |
| `transfer.settlement_mismatch` | blocking | an executed case without its exact movement, a settled case without its approved settlement (net = gross − fee − tax), or an `xfer:<id>:settled` journal without an executed case |
| `transfer.register_mismatch` | blocking | an executed case without its two trustee register entries |
| `transfer.escrow_residual` | blocking | a settled, cancelled or rejected sale with money left in its escrow, or an executed sale not settled within `escrow_residual_hours` |
| `transfer.paid_not_executed` | warning | a paid case neither executed nor refunded |
| `transfer.paid_not_executed_overdue` | blocking | the same after `paid_not_executed_hours` |

`recovery.unmatched` no longer reports a RecoveryGuard request that belongs to a transfer case (`transfer.recon_requests`). Ledger conventions: `xfer:<caseUuid>:paid` (bank → `transfer:<caseUuid>:escrow`, external reference = the buyer's Raast reference), `:fee`, `:tax`, `:settled` (external reference = the settlement reference `PTXFER-…`), `:refunded` (external reference = the buyer's original Raast reference).

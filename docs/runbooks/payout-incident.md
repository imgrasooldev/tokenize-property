# Runbook: payout incident (wrong batch, returned payments, held payouts, stuck commands)

Payouts are PKR bank transfers made by the trustee bank from a batch file (ADR 0009, B-5/B-6,
H-1..H-4). The chain only records the distribution and, later, the payout batch hash. Severity:
SEV1 if money was sent wrongly; SEV2 if a batch is wrong but not sent, or payments came back.

## Trigger

- An approver, the bank, the trustee or an investor reports a wrong or missing payout.
- Bank payout-return events (`bank.payout_returns`), `rent.payout_*` reconciliation findings,
  `rent.payout_held` warning.
- `pt-health`: outbox `expired lease` / `in review` / old `pending`.

## Immediate actions

1. Stop further sending: do not approve or submit any batch; stop the bank service and, if a
   chain-side record is involved, the signer. There is no one-command manual payout freeze yet
   (gap: OPERATIONS.md section 9); the reconciliation gate stays the automatic control.
2. If a wrong file reached the bank: call the bank **immediately** to stop or recall it. Whether
   Raast/IBFT payments can be recalled, and in what time, is a bank and legal question (LEGAL /
   BANK TO CONFIRM); speed matters.
3. Preserve evidence: ad-hoc DB backup; keep the submitted file (its SHA-256 is in
   `bank.payout_batches.file_sha256`).

## Diagnosis

```sql
SELECT id, reference, token, distribution_id, total_paisa, item_count, status, created_by, decided_by,
       decided_at, encode(file_sha256, 'hex') AS file_sha256, submitted_at
FROM bank.payout_batches ORDER BY id DESC LIMIT 10;
SELECT * FROM bank.batch_problems(<batch id>);          -- what the database would refuse now
SELECT batch_id, line_no, return_ref, reason, at FROM bank.payout_returns ORDER BY at DESC LIMIT 20;
```

```bash
cd ~/property-token/backend
npm run recon:status
npm run recon -- --json     # rent.payout_*, cash.* findings against the bank statement
npm run bank:audit          # batch and item digests intact (exit 3 on a problem)
```

## Decision points

| Situation | Action |
|---|---|
| Batch created, not approved, wrong | The checker rejects it (`bank.decide_payout_batch(<id>, <operator>, 'reject', '<reason ≥ 10 chars>')`, from the operations portal in production). A corrected batch can then be created (one live batch per distribution) |
| Batch approved, not submitted, wrong | Do not submit. Escalate to the lead: the database only allows edges defined in `0009/0010`; do not change rows by hand. Record the decision in the incident |
| Submitted and sent, wrong amounts or payees | SEV1. Amounts come from the finalized on-chain distribution and the ledger refuses overpaying (B-5), so check first whether the *distribution* was wrong (trustee may have needed to `reject` it in the 48 h window, SC-8). Recovery of money is between the trustee bank and recipients (legal); the ledger records corrections as new journals, never edits |
| Payments returned by the bank | Each return is booked once by `bank.book_payout_return` (the share is owed again). Find why (closed account, title mismatch), have the investor register a valid account (72 h cooling-off, B-4), then pay in a follow-up batch |
| Held payouts (`rent.payout_held`) | Expected when an investor has no active account or KYC is not verified (H-1). They stay owed; a follow-up batch pays each held share once, with the same maker-checker and gate (H-3) |
| Batch hash not recorded on chain (`rent.payout_not_recorded`) | The `rent.record_payout` command goes through the outbox and signer; see "stuck commands" |

### Stuck outbox commands

```sql
SELECT id, kind, status, attempts, lease_owner, lease_until, tx_hash, last_error, updated_at
FROM outbox.commands WHERE status IN ('claimed', 'submitted', 'review') ORDER BY updated_at;
SELECT * FROM outbox.stats();
```

- `claimed`/`submitted` with an expired lease: a worker died. Restart the worker; it decides from
  the database and then the chain (ADR 0004), never re-sends blindly.
- `review`: needs an operator decision `retry`, `fail` or `confirm` with a reason of at least 10
  characters (`outbox.operator_decide(id, operator, decision, reason)`, role `pt_outbox_operator`),
  after checking the chain for the transaction (`tx_hash`). Two people look at
  it: the operator decides, a second person checks the chain evidence (record both).
- Old `pending`: the worker is not running, or the signer is waiting for approvals
  (`npm run signer:decide -- <requestId> <operator> approve|reject "<reason>"`, two distinct
  approvers who are not the requester, S-3).

## Recovery verification

- `npm run recon` passes (no `rent.payout_*` or `cash.*` blocking findings).
- Bank statement for the day matches the ledger line by line.
- `npm run bank:audit` clean; outbox has no stuck or review commands.

## Post-incident record

Batch ids and references, amounts (PKR), affected subject ids (not names), bank case numbers,
money recovered or written off, approvers involved, control that failed or worked.

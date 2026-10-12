# F-04 to F-06: findings in our own code from the Step 5f review

| | |
|---|---|
| Component | Our migrations `0002_ledger.sql`, `0004_signer.sql`, `0005_indexer.sql` |
| Found | 2026-10-12, internal review during Step 5f (reconciliation) |
| Fixed | 2026-10-12, migration `0008_review_fixes.sql` (earlier migrations unchanged: they are applied on the demo server) |
| Status | Fixed and tested internally; to be confirmed by the external auditors |

Unlike F-01 to F-03, these are in **our** code.

## F-04: signer audit verification depended on the session TimeZone (severity: high, availability)

`signer.audit_digest` put a raw `timestamptz` into `jsonb`. Its text form carries the session's UTC offset (`10:00:00+05:00` in Karachi, `05:00:00+00:00` in UTC), so the same row hashed differently under another TimeZone. A verifier whose session TimeZone differed from the writer's saw every row as "content does not match its hash". Reconciliation treats that as tampering, a **blocking** finding, so payouts would have been frozen for no reason. The function was also wrongly labelled `IMMUTABLE`.

**Fix (RF-1):**
- New rows use digest **v2**, which formats the time in UTC (`YYYY-MM-DDTHH:MM:SS.ffffffZ`) and is domain-separated (`pt-signer-audit-v2`). A `digest_version` column marks each row (existing rows read as 1).
- Existing rows are **not re-hashed**: rewriting an append-only record would destroy what it proves. Instead `verify_audit()` recomputes the legacy digest under every real-world UTC offset (−12:00 to +14:00, 15-minute steps), after trying the session and cluster default first. A match under any offset proves the content is unchanged, because finding another content with the same SHA-256 is infeasible. Detection strength is unchanged; the TimeZone dependence is gone.
- The legacy function is relabelled `STABLE`.

**Tests** (`signer/test/audit-timezone.test.ts`): reproduce the bug on a database at migration 0007 (rows written in Karachi fail in UTC), upgrade, then verify under six TimeZones including ±half-hour and +14:00 zones; new v2 rows mixed with legacy rows; tampering in a legacy row and in a v2 row detected under every zone; verification leaves the session TimeZone unchanged; rows stay append-only.

## F-05: ledger write cost grew with account history (severity: medium, availability)

`ledger.post_journal`'s overdraft check (L-6) summed **every** posting of each touched account. Busy accounts (escrow) got slower with every journal: about 14 ms per journal at 20,000 journals, and the 10,000-subscription benchmark took 287 s.

**Fix (RF-2):**
- `ledger.account_balances` keeps a running balance per account, moved forward inside `post_journal` under the same writer lock and in the same transaction as the postings. The overdraft check reads only the touched rows.
- The table is forward-only: rows can only be updated together with a newer journal, never moved backwards, deleted or truncated (triggers, even for the admin).
- `ledger.verify_balances()` compares every running balance with the sum of its postings. Reconciliation calls it as the **blocking** check `integrity.ledger_balances`, so a tampered cache freezes payouts.
- The `ledger.balances` view now reads the running balance (no full-history `GROUP BY`).
- The upgrade backfills the running balances from existing postings under the writer lock.

**Tests** (`ledger/test/balances.test.ts`): backfill on data written by the old code; L-6 still enforced; a refused journal leaves no trace; property test (running balance = sum of postings for any sequence); forward-only protection; a rogue-DBA edit of the cache is exposed; write cost after 1,800 journals on one account stays within 2x of the start. In reconciliation, a tampered posting is now also reported as `integrity.ledger_balances`.

## F-06: missing fields passed validation; the indexer could silently skip events (severity: high, integrity)

Checks of the form `jsonb_typeof(x) <> 'array'` evaluate to NULL, not true, when `x` is NULL or missing, and PL/pgSQL treats a NULL condition as false. In `chain.apply_batch`, a NULL `p_events` therefore passed validation: the batch was accepted and the **cursor advanced past events that were never recorded**, silently corrupting the read model. Only the indexer role can call it, so one bug in the indexer would have been enough. In `ledger.post_journal`, postings with a missing `account` or `amount` passed the shape check and failed later on a constraint (an error, not silent corruption).

**Fix (RF-3):** `IS DISTINCT FROM` in both validations; `apply_batch` also requires `p_to_hash` and rejects blocks or events with missing number, hash, parent hash, timestamp, log index, block hash, address or transaction hash.

**Tests:** `indexer/test/indexer-db.test.ts` ("RF-3"): NULL events, NULL blocks, NULL target hash and six malformed shapes are refused and the cursor does not move, then the well-formed batch applies. `ledger/test/balances.test.ts` ("RF-3"): missing account, missing amount, null amount and NULL postings are refused by validation.

## Lessons

- In SQL validation, always use `IS DISTINCT FROM` (or explicit `IS NULL` checks); `<>` with a possibly missing value passes silently.
- Anything hashed must have one canonical text form, independent of session settings (TimeZone, DateStyle, locale). Format timestamps explicitly in UTC.
- Checks whose cost grows with history need a maintained aggregate plus an independent verifier.

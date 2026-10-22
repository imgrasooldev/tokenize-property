# Runbook: trustee portal (co-signing, distribution review, register)

The trustee (e.g. CDC) is independent: its officers hold no platform role and act only in the
trustee portal (`/trustee`, ADR 0011 section 12, migration 0023). Every decision needs the officer's
security key (step-up younger than 5 minutes), a reason and the digest of what the page showed.
Nothing here is sent to the chain by the portal: on-chain trustee actions (distribution `reject`,
RecoveryGuard, timelock cancel) are Trustee Safe transactions. Severity: SEV3 for a waiting
co-signature, SEV2 for a distribution rejected in the database but not on chain near the end of its
window, SEV1 for a register difference that shows units moved without the trustee.

## Trigger

- A mint waits in the outbox with `awaiting N approvals` and the operations page says "the trustee
  co-signs next" (platform approvals complete).
- `/trustee` overview: co-signatures waiting, distributions in the 48 h window, "rejected, not yet on
  chain", register differences, a failed reconciliation run.
- `pg_notify('trustee_alert', ...)` with `kind = distribution_rejected` (no subscriber wired yet:
  check the overview).

## Co-signing a signing request (mint above the threshold)

1. Open `/trustee/cosign`, then the request. Check the **exact call** (decoded from the calldata the
   signing service will sign: `IssuanceGuard.mint(to, amount, refId)`), the call hash, the platform
   approvals and the business reference (offering subscription or website order).
2. Check against the trustee's own records (subscription paid, register entry to be made, cap).
3. Co-sign or reject with a reason. A rejection is final; a new request is needed.
4. If the page says the signing service cannot be reached, nothing is decided: retry later (the
   ticket expires unused after 2 minutes). If it says "the transaction changed since you reviewed
   it", reload: the policy or request changed.
5. The 24-hour approval window still applies; an expired request is asked for again by the outbox.

## Voting on offering requests (S-02)

- `/trustee/cosign` lists S-02 requests whose rule needs the trustee: funding (L11), failure
  (L12/L15), extension (L10), completion start (L13: conditions precedent hashes), issuance batch
  (IB: lines, digest, "matches the allocations"), completion record (CMP: registered sale deed hash,
  completion payment batch reference and file hash), register confirmation (L14: total and register
  hash), suspension/cancellation/abort (L7/L8/L16), supplementary disclosure (SD).
- Check every hash against the document held by the trustee before approving. One rejection is
  final; the offering team must make a new request.
- On L14 approval the trustee's register in the database receives the units of every subscription
  (V18) in the same transaction; check `/trustee/register` afterwards (differences must be 0).

## Accepting a property for the trust (S-01 P8)

- Trustee > Property acceptance (`/trustee/properties`, migration 0026) lists Legal Approved
  properties. Check the structure (planned register, holding limit, unit rights), the trust deed
  SHA-256 against the deed the trustee holds and the committee's minutes hash, then accept (the
  property becomes Tokenization Ready) or decline. A decision on a structure is final: after a
  decline the legal head records a new structure. Steps and refusals: `portal-votes.md`.

## S-03: charges above the limit and the distribution pre-check

- **Charges (OP-21):** `/trustee/cosign` lists expenses and fees above the operations limit
  (`ops.settings.expense_ops_limit_paisa`, placeholder Rs 1,000,000). Check the invoice against the
  evidence SHA-256 and the budget, then approve or reject. The operations checker can approve only
  after the trustee approved; after a trustee rejection only "reject" remains.
- **Pre-check (D4):** once operations attached the statement of a calculation, recompute the Merkle
  root independently from the record block and the statement (net paisa per wallet is the leaf) and
  approve with that root, or reject (operations returns and recalculates). The operations checker
  can approve the calculation only after the pre-check; publishing on chain follows.

## Reviewing a rent distribution (48-hour window)

1. Open `/trustee/distributions`; items with "review due" are published and inside their window
   (from the publish block's time; the page shows when it closes).
2. Recompute the Merkle root independently from the record block's holdings and the statement
   (OP-SOD-2), never from the operations spreadsheet.
3. If it matches: approve and enter the recomputed root (refused if it differs).
4. If it does not match or the statement is wrong: **reject with a reason**. The database then
   refuses any payout batch and the `rent:wht` / `rent:distribution:<token>:<id>` booking for it. Then, **before
   the window closes**, execute `DistributionRegistry.reject(id, reason)` from the Trustee Safe; the
   overview shows "rejected, not yet on chain" until the indexer sees it.
5. If the window closed without the on-chain reject and operations finalised it on chain: payouts
   stay blocked in the database (by design). Escalate (SEV2): operations publishes a corrected
   distribution; never delete or edit the review row (append-only, audited).

## Register differences

1. `/trustee/register?token=...` shows every wallet where the trustee's register and the chain read
   model differ (pinned to the indexer's cursor block; if the indexer is halted the page says so:
   see [indexer-halt.md](indexer-halt.md) first).
2. Expected before go-live: tokens issued before Step 6d or outside offerings have no register
   entries. Record opening balances as **adjustments** with the SHA-256 of the register extract;
   a second trustee officer approves within 72 hours. No balance can go below zero.
3. A difference after a completed offering means units moved without the trustee (SEV1): freeze
   per [kyc-sanctions-offboarding.md](kyc-sanctions-offboarding.md) if needed, compare with
   `chain.issuances` and the outbox, and involve the incident lead
   ([incident-response.md](incident-response.md)).
4. Export the register (CSV with manifest and SHA256SUMS) for the trustee's files; the export is
   recorded in the trustee and admin audits before it is handed out.

## Reconciliation and recoveries (read-only)

- `/trustee/recon`: runs per day (PKT), findings and the run digest. A freeze is lifted by two
  platform officers after a passed run ([reconciliation-freeze.md](reconciliation-freeze.md)); the
  trustee reads the evidence.
- `/trustee/recoveries`: S-06 wallet-recovery and succession cases (read-only) and the RecoveryGuard
  requests on chain (48 h delay). Proposing and executing on chain stay Trustee Safe transactions.

## Checks after any trustee action

```sql
SELECT * FROM trustee.verify_audit();   -- empty
SELECT * FROM admin.verify_audit();     -- empty
SELECT * FROM signer.verify_audit();    -- empty
```

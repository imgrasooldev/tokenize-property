# Runbook: permitted secondary transfers, phase 0 (spec S-04)

Portal: PT Control `/transfers`; investors: website `/transfers`. Every rule is enforced by the database (migration 0028, spec S-04 section 16); this runbook is the order of work. Never move units, book escrow or pay a seller by hand.

## Services that must run

- Indexer (`npm run indexer`): balances, freezes, registry countries and the RecoveryGuard requests and executions come from the read model.
- Bank service (`npm run bank`) and the bank webhook: the buyer's payment is booked against the case's payment code.
- Outbox worker (`npm run outbox`) and signing service (`npm run signer`) with the policies `transfer.propose`, `transfer.execute`, `transfer.cancel` active (Trustee key; `signer:setup` activates local ones).
- `npm run transfer:tick -- --loop` (or "Refresh from chain" in PT Control): books payments into cases, cancels unpaid codes after the deadline, enqueues the proposal once the money is in escrow, links proposals to their requests, re-checks after the 48-hour delay and enqueues execute or cancel, follows executions and writes the trustee register.
- KYC re-screening (`npm run kyc:rescreen`): transfers need a sanctions screening that passed within 24 hours; stale screenings are queued automatically.
- Notifications worker (`npm run notify:run`): the seller's alert at every request, status changes, the buyer's payment instructions.
- Reconciliation (`npm run recon`) must have passed within 26 hours before any settlement or refund is approved.

## A transfer from request to settlement

1. **Request.** Either the seller requests on the website with the buyer's receive code (the buyer makes it under Transfers, valid 7 days, single use) and the buyer accepts by selecting the same signed agreement file, or the transfer desk (operations maker) opens the case in PT Control with both KYC subject ids (court orders always through the desk). The seller's contacts are alerted.
2. **Complete (T1).** Transfer desk: check the signed agreement (or court order) against the SHA-256 on the case, then "Complete". The checks run and are recorded; surveillance alerts open STR cases for compliance (tipping-off: never mention them to the investors).
3. **Decide (T3/T4).** One compliance officer and one trustee officer approve, different people, never the desk officer who opened or completed the case, never with a declared conflict ("Declare a conflict" on `/transfers` first if you know a party). Any failed check refuses the approval and names the check; a stale screening queues a re-screen: wait for it and approve again. One rejection ends the case; the investors see "not approved" only.
4. **Payment (T5/T7, sale only).** The buyer pays the exact amount from their registered account with the payment code within 72 hours. Wrong amount, wrong account or a late payment goes to suspense (handle under the bank suspense procedure). The tick books the payment, re-runs the checks and enqueues the proposal.
5. **On chain (T10).** The proposal is a RecoveryGuard ForcedTransfer signed with the Trustee key; it can be cancelled for 48 hours by the Admin or Trustee Safe. After the delay the tick re-runs the checks: all pass → `execute`; a hard failure → `cancel` (TR-11).
6. **Executed.** The case becomes `executed` only when the read model shows the request executed AND the exact movement (seller → buyer, units) in the same transaction. The trustee register gets −units for the seller and +units for the buyer.
7. **Settle (T12, sale only).** Operations maker: "Prepare settlement" (gross, platform fee, withholding at the `unit_disposal` rate for the seller's ATL status, net to the seller's active payout account). An operations checker who did not prepare it and did not open or complete the case approves; the journals are posted and the SHA-256 of the bank instruction recorded before the bank is instructed. The escrow is then zero.

Gifts, family and court-ordered transfers skip steps 4 and 7.

## Withdrawal, cancellation, failure, refund

- **Withdrawal (T2).** A party withdraws on the website (or the desk for a party who asked in writing) while no payment is booked. The payment code is cancelled under the bank's lock; a payment that won the race is booked and the withdrawal refused: then a compliance or trustee officer cancels instead.
- **Cancellation (T9).** A compliance or trustee officer cancels before execution with a reason. Unpaid → `cancelled`. Paid but not on chain → `refunding`. Proposed → `cancelling`: the on-chain request is cancelled first.
- **Execution failed (T11).** Three failed `execute` commands make the case `failed` and enqueue `cancel`. A failed or unknown command in `review` is never resolved by a refund.
- **Refund (T13/T14).** Only in `refunding`, which the database allows only when the request never reached the chain or the read model shows it cancelled. Operations maker prepares, operations checker approves (same separation as settlement); the exact credit returns under the buyer's original Raast reference.
- **Dispute (T15).** A claim after execution (fraud, mistake): a compliance officer marks the case disputed; the remedy is an S-06 case. A disputed sale is never settled automatically; its escrow stays until S-06 decides.

## Exit (S-05) and incidents

An exit record date, or an incident, blocks every transfer of the token: `transfer.open_block(token, 'exit'|'incident', ref, reason, actor)` (S-05 calls it; it shows on `/transfers`). Approvals, payment steps and executions are refused or cancelled while it is open; `transfer.close_block` lifts it.

## Reconciliation findings

- `transfer.unapproved` (blocking): a holder-to-holder movement without an approved case. Treat as a possible key compromise or a token unpaused outside a mint window: `key-compromise.md`, pause the token, find the transaction.
- `transfer.settlement_mismatch` / `transfer.register_mismatch` (blocking): the case, the chain and the register disagree. Do not settle; compare the case's `executed_tx` with the chain and the trustee register; corrections only by a trustee adjustment (two officers) or an S-06 case.
- `transfer.escrow_residual` (blocking): money left in a closed case's escrow, or a seller not settled within 72 hours of execution: prepare and approve the settlement.
- `transfer.paid_not_executed` (warning, blocking after 120 hours): a paid case stuck before execution: check the outbox, the signing service and the 48-hour delay; cancel and refund if it cannot execute.

## Settings

`transfer.settings` (database administrator only, every change audited): `lockup_months` (6), `price_band_ppm` (200,000 = ±20 %), `payment_hours` (72), `screening_max_age_hours` (24), `fee_ppm` (0, owner question Q-3), `paid_not_executed_hours`, `escrow_residual_hours`, `round_trip_days`, `max_cases_30d`, `receive_code_hours`, `request_acceptance_days`, `allowed_countries`, `max_execute_attempts`, `unapproved_from_block`. The withholding rates for `unit_disposal` are PLACEHOLDERS (`tax.rates`, LEGAL/TAX TO CONFIRM): settlements are refused while they are placeholders unless `ops.settings.allow_placeholder_rates` is true (local development only).

Audit: `npm run transfer:audit` verifies the hash chain (exit code 3 on a problem).

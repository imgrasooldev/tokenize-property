# Runbook: property sale, final distribution, redemption burns and closure (spec S-05)

Portal: PT Control `/exit`. Rules are enforced by the database (migration 0027, spec S-05 sections 14-16); this runbook is the order of work. Never burn, book or pay by hand.

## Services that must run

- Indexer (`npm run indexer`): publish/finalize/recordPayout, burns, supply, holdings and the trustee cap are read from the read model.
- Reconciliation (`npm run recon` with the bank statements imported): X12, payout batches and every burn need a clean gate.
- Bank service (payout batches, follow-up batches) and the trustee-escrow statements imported (`npm run recon:import-bank`).
- Outbox worker (`npm run outbox`) and signing service (`npm run signer`) with an active `issuance.burn` policy.
- `npm run exit:tick -- --loop` (or "Refresh from chain" in the portal): links the published distribution, follows reject/finalize, enqueues burns as lines become eligible, records burns (subscriptions redeemed, trustee register), moves to Paid Out.

## 1. Proposal to buyer (X1-X10)

1. Operations maker: "Open exit case" (token, offer, two independent valuations with SHA-256, estimated costs, whether the unit rights need an investor vote, rationale).
2. Committee: maker proposes X2 (vote) or X3 (no vote) with the minutes' SHA-256; an operations checker and a compliance officer vote. X1 rejects.
3. Vote (X2): the notice (SHA-256) and the vote record block are recorded; after the notice period the maker records the scrutineer's count (eligible units = supply at the vote record block, checked; quorum and majority checked); operations checker + trustee officer. Officers related to the buyer declare a conflict first (they then decide nothing on the case).
4. Trustee review: legal officer + trustee officer approve (X7: price not below the lower valuation unless the vote approved it; legal advice SHA-256; conflicts cleared) or refuse (X6).
5. Buyer: compliance + legal + trustee approve the cleared buyer and the signed agreement (X9: buyer case reference, checks SHA-256, agreement SHA-256, sale price, deposit, CP deadline) or the failure (X8). Collapse after signing: X10 (legal + trustee) with the deposit treatment.

## 2. Money in (proceeds, X11, X12)

1. Import the trustee-escrow statement. Operations maker: record the deposit and the proceeds from their statement lines (a credit the bank service put in suspense can be re-attributed). An operations checker approves each: journals `exit:<token>:deposit` / `exit:<token>:proceeds:<n>`.
2. Legal officer: X11 with the registered deed's SHA-256 (refused until the full price is booked).
3. Run reconciliation; operations checker: X12 (refused while proposals are pending or the gate is closed).

## 3. Waterfall (EX-10/11)

1. Operations maker: add lines (secured debt, transaction costs, sale taxes, payables, tenant deposits, one closure reserve; inflows: reserve release, undistributed rent), each with the evidence SHA-256; submit.
2. An operations checker checks; a trustee officer approves (three different people). All journals post on the trustee's approval.
3. When each line is paid from the escrow, import the statement and record the debit against the line (maker), operations checker approves (`exit:<token>:waterfall:<line>:paid`). Wind-up costs are spent from the closure reserve the same way.

## 4. Final distribution (EX-12/13)

1. Pause the token (PauseGuard) before the record date; operations maker announces the record date with the notice SHA-256 (at least 14 days ahead).
2. After the record date, on the exit service host: `npm run exit:run -- calculate <case> <recordBlock>` (a block with no movement after it), then `npm run exit:run -- attach <final>` (actor `EXIT_ACTOR`, never an officer's handle). `exit:run -- verify <final>` must print "documents consistent".
3. A trustee officer pre-checks with the root they recomputed; an operations checker approves (refused with placeholder tax rates in production).
4. The Ops Safe publishes on the DistributionRegistry (outside the platform). The tick links it (Final Published). The trustee may review/reject in the 48-hour window (Trustee > Distributions); a rejection returns the case to Waterfall and the calculation is redone.
5. After the window the Ops Safe finalizes; the tick moves the case to Final Finalized.

## 5. Redemption (X16, X17)

1. `npm run exit:run -- redeem <case>` (default burn rule `after_payment`; `after_finalization` only when legal confirmed early cancellation). An operations checker checks, a trustee officer approves: the final distribution is booked from the exit pool and the case is Redeeming.
2. Bank operators create, approve and submit the payout batch of the final distribution (held lines stay owed); record the payout on chain (`rent.record_payout`). The tick enqueues the burn of every paid line; the signing service signs `IssuanceGuard.burn` only for those.
3. Held lines (no payout account, not verified): pay them by follow-up batches when possible. To cancel the units before payment: maker proposes HR for the wallet; operations checker + trustee officer approve; the payable stays owed and provable.
4. When every line is burned, supply is 0 and the payout is recorded, the tick moves the case to Paid Out.

## 6. Closure (X18)

Needs: every final line paid (follow-up batches), exit pool 0, closure reserve 0, every waterfall line paid, supply 0, trustee cap 0 (timelock `setTrusteeCap(0)`), trustee register 0. Maker proposes X18 with the final accounts and wind-up SHA-256; operations checker + trustee officer approve. Contracts stay deployed (paused, supply 0) as evidence.

## Redemption windows (phase 0 queue, S-05 section 15)

Maker proposes a window (token, dates, NAV per unit with evidence, discount); an operations checker approves (cap = 10 % of supply). Investors request on the website (`/exit`, step-up). After it closes the maker proposes the outcome and a checker approves it: requests become recorded (declined for investors no longer verified; they see "under review"). Nothing is paid or burned.

## When something goes wrong

- **Burn command failed or in review:** never re-burn with another refId. Resolve from the chain (outbox review). A burn denied by the signer says why (`exit: ...`, gate, balance).
- **Reconciliation finding `issuance.orphan_burn` / `issuance.burn_amount_mismatch`:** a burn outside the batch: incident (key compromise runbook); payouts stay frozen.
- **`exit.burn_before_payment`:** a burn was signed for an unpaid line: stop the signer, investigate the policy and the database rule.
- **`exit.supply_not_zero` blocking:** burns stuck beyond 72 hours: check the outbox, signer gate and held lines (HR).
- **`exit.register_mismatch`:** the trustee register lacks the units of a burned wallet: two trustee officers record an adjustment with evidence.
- **Units moved after the record block** (calculation or batch refused): a recovery or transfer ran while transfer-closed; resolve the register (S-06) and choose a new record block.
- `npm run exit:audit` must report the chain intact.

# S-05: Sale, exit, redemption and closure

- Status: Draft for owner review (functional specification; no code yet)
- Date: 2026-10-13
- Lifecycle stages: 15 (sale and exit), 16 (redemption, burn and closure)
- Exceptions covered: sale collapses, partial exit, buyer default, investor without payout account at the final distribution
- Builds on: contract-spec §5.1 (IssuanceGuard.burn with single-use refId, I-11), §6.1 (DistributionRegistry), §6.2 (DocumentRegistry, `InvestorVote`), §10 (sale vote off chain), threat T-2, S-03 (distribution machinery, held payouts), [ADR 0007](../decisions/0007-reconciliation.md) (`issuance.burn_not_reconciled` today a warning)

## 1. Purpose and scope

Sell the property (or part of it) only with the approvals the unit rights require, receive the proceeds into trustee escrow, pay what the trust owes, distribute the rest to holders at a record block, cancel the units by burning them through `IssuanceGuard.burn` with a single-use refId, and close the trust, keeping every record for the retention period.

## 2. Actors and roles

| Role | Does |
|---|---|
| Sponsor / property manager / operations | May propose a sale with a rationale |
| Investment committee | Recommends or rejects the proposal |
| Independent valuer(s) | Current valuation for the fairness check |
| Investors | Vote when the unit rights require (S-01 OB-35) |
| Scrutineer (independent, e.g. the auditor) | Counts the vote |
| Trustee officer | Approves the sale, signs the sale deed as owner, approves the waterfall and final distribution |
| Legal reviewer | Buyer due diligence, sale agreement, transfer of title |
| Compliance officer | Buyer KYB/KYC, sanctions, source of funds, STR |
| Operations / finance maker and checker | Waterfall, final distribution, burns |
| Issuance Safe | Burns |

**SoD.** EX-SOD-1 the proposer cannot count the vote or approve the waterfall. EX-SOD-2 anyone related to the buyer is excluded from IC and trustee decisions (declared conflicts). EX-SOD-3 waterfall maker ≠ checker ≠ trustee approver.

## 3. State machine (exit)

```mermaid
stateDiagram-v2
    [*] --> Proposed
    Proposed --> Rejected: X1 IC rejects
    Proposed --> Vote_Open: X2 IC recommends, notice sent
    Proposed --> Trustee_Review: X3 no vote required
    Vote_Open --> Rejected: X4 vote fails
    Vote_Open --> Trustee_Review: X5 vote passes
    Trustee_Review --> Rejected: X6 trustee refuses
    Trustee_Review --> Buyer_DD: X7 trustee approves
    Buyer_DD --> Sale_Collapsed: X8 buyer fails checks
    Buyer_DD --> Contracted: X9 agreement signed, deposit received
    Contracted --> Sale_Collapsed: X10 buyer default / CP fails
    Contracted --> Completed_Sale: X11 deed registered, proceeds received
    Completed_Sale --> Waterfall: X12 proceeds reconciled
    Waterfall --> Final_Published: X13 final distribution published
    Final_Published --> Waterfall: X14 trustee rejects on chain
    Final_Published --> Final_Finalized: X15 window over
    Final_Finalized --> Redeeming: X16 booked, burns enqueued
    Redeeming --> Paid_Out: X17 supply 0, payouts submitted
    Paid_Out --> Closed: X18 held amounts resolved, trust wound up
    Sale_Collapsed --> [*]: property back to Operating
    Rejected --> [*]: property stays Operating
    Closed --> [*]
```

Property state: Operating → **Exit in Progress** from X7 to X17 → **Closed** at X18; back to Operating after X1/X4/X6/X8/X10.

| # | Guard | Actor | Maker-checker | Audit event |
|---|---|---|---|---|
| X1/X2/X3 | Proposal with offer, valuation, rationale, costs; X3 only if the unit rights need no vote | IC (quorum) | **Yes** | `exit.proposed` / `exit.ic_decided` |
| X4/X5 | Vote result per EX-3, counted by the scrutineer; result hash anchored as `InvestorVote` | Scrutineer + trustee | **Yes** | `exit.vote_result` |
| X6/X7 | Price ≥ EX-5; legal advice; conflicts cleared | Trustee | **Yes** | `exit.trustee_decided` |
| X8/X9 | Buyer KYB/KYC, sanctions, source of funds (EX-6); agreement hashed | Compliance + legal + trustee | **Yes** | `exit.buyer_checked` / `exit.contracted` |
| X10 | Default notice or CP deadline passed | Legal + trustee | **Yes** | `exit.collapsed` |
| X11 | Sale deed registered (hash); full price booked `exit:<token>:proceeds:<n>` | Legal + bank service | No | `exit.sale_completed` |
| X12 | Cash check clean for the proceeds; recon gate open | Finance | No | `exit.proceeds_reconciled` |
| X13 | Waterfall approved (EX-10); record date and block (EX-12); statement and tax schedule hashed; token paused | Finance maker + checker + trustee; Ops Safe publishes | **Yes** | `exit.final_published` |
| X14 | Trustee reject within 48 h | Trustee Safe | Safe threshold | `exit.final_rejected` |
| X15 | Window over | anyone | No | `exit.final_finalized` |
| X16 | Journals booked; one `issuance.burn` per holder wallet in an approved redemption batch | Ops maker + checker + trustee | **Yes** | `exit.redemption_started` |
| X17 | `totalSupply` = 0 in the read model; payout batch submitted; `recordPayout` confirmed | System | No | `exit.redeemed` |
| X18 | No held lines (or transferred per unclaimed rules); final accounts audited; trust wound up; archive sealed (EX-30) | Trustee + finance | **Yes** | `exit.closed` |

## 4. Business rules

- **EX-1** A sale needs: IC recommendation, investor approval if the unit rights require it, and trustee approval. The token never transfers title: title moves only by a registered sale deed signed by the trustee (or the SPV), threat T-2.
- **EX-3** Vote (off chain, contract-spec §10): eligible = holders at a vote record block announced in the notice; one unit one vote; quorum and majority per the trust deed (default proposal: 50 % quorum, 75 % of votes cast; LEGAL TO CONFIRM); voting through the portal with identity verification; notice period at least 21 days. The full result (per-wallet ballot list hashed, totals public) is anchored in DocumentRegistry as `InvestorVote`. Related parties (sponsor, buyer) do not vote, if the deed says so.
- **EX-5** Price not below the lower of two current independent valuations unless the vote approved a lower price explicitly.
- **EX-6** Buyer due diligence: KYB/KYC (as S-01), sanctions/PEP, source of funds, payment only from the buyer's own account (credit from any other account goes to suspense and is returned), STR assessment.
- **EX-7** Proceeds are paid by the buyer into trustee escrow (Raast/RTGS) against a payment code of new purpose `exit_proceeds` (bank change); a deposit is booked the same way and is refundable or forfeited per the agreement.
- **EX-10** **Waterfall** (order fixed by the trust deed, default): (1) secured debts and charges on the property; (2) transaction costs (brokerage, legal, duties, CVT, registration); (3) taxes payable by the trust on the sale (LEGAL TO CONFIRM capital gains treatment); (4) outstanding fees and vendor payables; (5) tenant deposits transferred to the buyer or refunded; (6) a closure reserve for wind-up costs and contingencies (released later as a final adjustment); (7) the remaining reserve released; (8) the remainder = distributable to holders, plus undistributed rent of the last period.
- **EX-11** The waterfall is maker-checker and trustee-approved; each line has evidence (invoice, tax computation, discharge letter hash).
- **EX-12** Final record date announced ≥ 10 business days before; the token is already paused (transfer-closed, S-04) so balances only change through RecoveryGuard; no transfer case may be executed after the record block (S-04 TR-10). Record block rule as S-03 OP-33.
- **EX-13** Entitlements: largest remainder on units at the record block (S-03 OP-35), WHT per S-03 OP-36/OP-40 with the income type of an exit distribution (LEGAL TO CONFIRM: capital gain vs dividend), Merkle leaf (wallet, net paisa), statement `pt-rent-statement-v2` with `kind: "final"`.
- **EX-14** **Burn after finalization, before or independent of payout (recommended).** Once the final distribution is finalized, each holder's entitlement is fixed on chain (root, total, proof) and in the ledger (`rent:payable:<subjectId>`). Every holder wallet's full balance at the record block is then burned: `IssuanceGuard.burn(wallet, balance, refId)` with `refId = keccak256("property-token:redemption:<token>:<distributionId>:<wallet>")`, outbox key `burn:<refId>`. Burns work while paused and on frozen balances (ERC-3643 `burn` unfreezes frozen amounts; verified in code, to be covered by a test). A held payout remains owed after the burn and is provable with the Merkle proof. LEGAL TO CONFIRM that units may be cancelled before every holder is paid (alternative: burn each wallet only after its line is paid; slower, keeps tokens alive for unclaimed lines).
- **EX-15** Burned units = balance at the record block for every wallet, exactly; Σ burns = `totalSupply` at the record block. After the last burn the trustee reduces `trusteeCap` to 0 through the timelock and records the register as closed.
- **EX-16** Partial exit (sale of part of the property, e.g. one floor): no burn; proceeds after the waterfall are distributed as a special distribution (S-03 machinery, `kind: "special"`); units stay outstanding with a reduced asset base; disclosed with an updated valuation. A partial **redemption** (cancelling a fraction of every holding) is not supported in v1 because units are whole numbers (open question Q-2).
- **EX-30** Closure: final audited accounts, final tax filings and certificates, trust deed termination or SPV wind-up, documents anchored (`AuditReport`, `Other`), the chain contracts left in place (paused, supply 0) as permanent evidence, read model and ledger archived; records kept at least 10 years (ADR 0009 decision 3, LEGAL TO CONFIRM).

## 5. Data to record

Exit case (proposal, valuations, IC decision, vote notice, ballots hash, result, trustee decision), buyer (KYB/KYC refs), sale agreement and deed hashes, proceeds receipts, waterfall lines with evidence, final record date/block, final statement and tax schedule hashes, on-chain distribution id, redemption batch (wallet, units, refId, outbox command, burn tx), payout batches, held lines, closure checklist with evidence.

## 6. Ledger journal conventions

| Journal key | Postings | `external_ref` |
|---|---|---|
| `exit:<token>:deposit` / `exit:<token>:proceeds:<n>` | Dr `bank:trustee-escrow`, Cr `exit:pool:<token>` (new, liability) | Raast/RTGS reference |
| `exit:<token>:waterfall:<line>` | Dr `exit:pool:<token>`, Cr the payable (`debt:payable:<lender>`, `vendor:payable:<id>`, `tax:payable:<token>`, `reserve:<token>:closure`) | evidence id |
| `exit:<token>:waterfall:<line>:paid` | Dr payable, Cr `bank:trustee-escrow` | batch reference |
| `exit:<token>:reserve-release` | Dr `reserve:<token>`, Cr `exit:pool:<token>` | approval id |
| `exit:<token>:capital-release` | Dr `property:<token>:capital`, Cr `property:<token>:acquisition` (asset derecognised; gain/loss to `property:<token>:capital`) | sale deed hash |
| `rent:wht:<token>:<id>` | Dr `exit:pool:<token>`, Cr `tax:wht-payable:<token>` | statement hash |
| `rent:distribution:<token>:<id>` | Dr `exit:pool:<token>`, Cr `rent:payable:<subjectId>` | statement hash |
| `rent:payout:<token>:<id>` (+ follow-ups) | payables → bank | `PTPAY-…` |

The final distribution deliberately keeps the `rent:` key family: reconciliation and the bank payout service match every DistributionRegistry distribution by `rent:distribution:<token>:<id>` and `rent:payable:<subjectId>`, so they work unchanged (open question Q-3).

Burns move no money; they are matched to the redemption batch (outbox `issuance.burn` payloads), not to a ledger journal.

## 7. On-chain actions and reconciliation

| Action | Contract | Signer path | Outbox kind / key |
|---|---|---|---|
| Anchor vote result, sale deed, final accounts | `DocumentRegistry.add` (`InvestorVote`, `TitleDeed`, `AuditReport`) | Ops Safe | `document.add` |
| Final distribution | `DistributionRegistry.publish / finalize / recordPayout` | Ops Safe | `rent.publish`, `rent.finalize`, `rent.record_payout` |
| Redemption | `IssuanceGuard.burn(wallet, units, refId)` | Issuance Safe | `issuance.burn` (policy new: only for a refId in an approved redemption batch of a finalized final distribution; recon gate required, open question Q-4) |
| Cap to 0 | `setTrusteeCap(0)` via timelock after supply = 0 | Admin Safe | not via outbox |

Reconciliation: replace the warning `issuance.burn_not_reconciled` with blocking checks `issuance.orphan_burn` (a `Burned` refId not in an approved redemption or reversal batch, S-06), `issuance.burn_amount_mismatch` (burned ≠ the wallet's balance at the final record block), `exit.supply_not_zero` (warning, blocking after the SLA once Redeeming), `exit.waterfall_mismatch` (exit pool not zero after the final distribution apart from the closure reserve).

## 8. Exceptions and alternative paths

| Case | Handling |
|---|---|
| Vote fails / trustee refuses | Property stays Operating; disclosure |
| Sale collapses (buyer fails checks, default, CP fails) | X8/X10; deposit forfeited or refunded per agreement; forfeited deposit to `exit:pool` then distributed as a special distribution or kept in reserve per the trust deed; costs incurred booked as expenses |
| Proceeds short or late | No final distribution until the full price is reconciled; partial receipts stay in `exit:pool` |
| Holder without payout account at the final distribution | Held line (S-03 OP-53), units still burned (EX-14); paid by follow-up; unclaimed rules after the legal period |
| Frozen or sanctioned holder | Entitlement computed; units burned (cancellation is required to close the register; LEGAL TO CONFIRM), payout held until S-06 releases it; funds of a designated person stay frozen |
| Deceased holder | Entitlement owed to the estate; paid to heirs per S-06 |
| Burn fails (unknown outcome) | Outbox review; never re-burn with another refId; resolve from chain |
| Error after finalization | Correct by an adjustment from the closure reserve before closing |

## 9. Notifications and disclosures

Sale proposal and rationale, vote notice (agenda, valuations, conflicts, how to vote), vote result, trustee decision, sale completion, waterfall summary, final record date (with "units will be cancelled after the final distribution"), statement and proof, payout or held status, final tax certificate, closure notice. Disclosure: exit is not guaranteed; illiquidity until exit; tax treatment of exit proceeds.

## 10. Regulatory assumptions (LEGAL TO CONFIRM)

1. Vote thresholds, notice periods and who votes (trust deed / REIT rules).
2. Tax on the sale (trust level) and on exit distributions (investor level), WHT sections and rates.
3. Whether units may be cancelled before all holders are paid (EX-14).
4. Unclaimed final distributions.
5. Retention period and the winding-up procedure for the trust or SPV.

## 11. Acceptance criteria

1. No burn without a finalized final distribution and an approved redemption batch; each refId burns once (I-11).
2. After redemption, `totalSupply` = 0, `trusteeCap` = 0, and every former holder's entitlement is either paid (bank line, `recordPayout`) or owed in `rent:payable:<subjectId>` and provable on chain.
3. Σ waterfall + Σ WHT + Σ net = proceeds + released reserves + undistributed rent, exactly.
4. Reconciliation clean through the whole exit, including the new burn checks.

## 12. Test plan

- **Unit:** waterfall order and arithmetic; vote quorum/majority at the boundaries; refId derivation.
- **Property-based:** random holders and frozen balances: Σ burns = supply at record block; entitlements exact; held lines owed after burn.
- **Integration (Besu):** paused token, final distribution, burns (including a fully frozen wallet and a partly frozen one) through outbox + signer; supply 0; `issuance.orphan_burn` on a burn outside the batch.
- **E2E (pilot rehearsal):** one property end to end on the local network: S-01 → S-02 → one S-03 period → S-05 exit, all reconciliation runs clean.

## 13. Open questions

- Q-1 Vote thresholds (50 % quorum, 75 % majority proposed) and notice (21 days).
- Q-2 Partial redemption (cancelling part of every holding) needed? Not supported in v1 (whole units).
- Q-3 Keep the `rent:` journal family for final distributions (recommended, no recon change) or introduce `dist:` with a recon change.
- Q-4 Should `issuance.burn` require the reconciliation gate like payout kinds? Recommended yes (signer change).
- Q-5 Burn timing: after finalization (recommended) or per wallet after payment.

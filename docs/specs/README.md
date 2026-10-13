# Functional specifications (lifecycle)

- Status: Draft for owner review (2026-10-13). Functional specifications only: no code, migration or contract changes come with them. Project rule: the spec (and, where behaviour of an existing component changes, a new ADR or contract-spec version) comes before the behaviour.
- Source: the owner's 16-stage lifecycle brief, aligned with the existing architecture (contract-spec v0.4, ADRs 0001–0009, migrations up to `0011_integration.sql`).

## 1. Index

| Spec | Title | Lifecycle stages | Exceptions |
|---|---|---|---|
| [S-01](S-01-owner-onboarding-and-due-diligence.md) | Owner onboarding and due diligence | 1 (property side), 2, 3, 4, 5 (structure) | Rejected title, duplicate property |
| [S-02](S-02-offering-lifecycle.md) | Offering lifecycle | 5 (rights), 6, 7, 8, 9, 10, 11 | Failed KYC/sanctioned at subscription, payment ok but allocation fails, offering fails |
| [S-03](S-03-property-operations-and-distributions.md) | Property operations and distributions | 12, 13 | Rent shortfall, tenant dispute, distribution rejected |
| [S-04](S-04-secondary-transfers.md) | Permitted secondary transfers | 14 | Failed, cancelled, disputed transfers |
| [S-05](S-05-exit-redemption-and-closure.md) | Exit, redemption and closure | 15, 16 | Sale collapses, partial exit |
| [S-06](S-06-recovery-inheritance-and-reversals.md) | Recovery, inheritance and reversals | cross-cutting | Lost wallet, deceased investor, payment reversal after allocation, sanctioned wallet |
| [S-07](S-07-public-verification-page.md) | Public verification page | cross-cutting (product #4) | Indexer halted, public chain unreachable |

Stage 1 (platform setup: chain, Safes, timelock, signer, indexer, reconciliation, anchor, KYC and bank) is already built in Steps 3–5 and is not re-specified. "Chain outage / contract incident" is handled in each spec's exceptions (outbox retries, PauseGuard, decisions from the chain, ADR 0004) and by the existing runbooks.

## 2. Lifecycle state mapping

| Brief's property state | Where |
|---|---|
| Property Draft → Submitted → Under Review → Legal Approved → Tokenization Ready | S-01 §3.2 (plus Rejected, Withdrawn, On Hold) |
| Offering Live → Funded | S-02 §4.1 (offering Live; Funded/Completing) |
| Operating | S-02 completion → S-03 |
| Exit in Progress → Closed | S-05 |

| Brief's investment state | Where |
|---|---|
| Investment Initiated → KYC Pending → Payment Pending → Payment Confirmed → Allocation Pending → Tokens Issued → Active → Redeemed | S-02 §4.2 (Payment Pending = reservation with a payment code; Active = register entry confirmed), Redeemed in S-05 |
| Rejected, Cancelled, Expired, Refund Pending, Refunded, Waitlisted, Issuance Review | S-02 §4.2 |
| Disputed, Blocked | S-02 entry, S-06 handling |

## 3. The key design difference: mint only after payment

The brief places "deploy and mint" before the offering. We deploy the token before the offering, but **mint only for a subscription whose payment is already booked in the ledger (`sub:<refId>:paid`), with a single-use refId (I-11), at completion of the purchase.** Reasons in S-02 §2: contracts never hold money so payment can only be proven off chain; one payment ↔ one mint is enforced by IssuanceGuard and reconciliation; a pre-minted treasury cannot exist under the 10 % MaxBalance limit and would be the most valuable key; refunds never need burns; and token, ledger and trustee register agree at every moment.

## 4. Conventions used in all specs

- **Rule IDs:** OB (S-01), OF (S-02), OP (S-03), TR (S-04), EX (S-05), RC (S-06), PV (S-07); `-SOD-n` for separation-of-duties rules. Transition IDs are per state machine (K, P, L, V, N, E, D, T, X, C). They do not collide with existing IDs (O-, S-, C-, R-, Y-, B-, H-, I-, A-, L-).
- **Maker-checker:** two different authenticated people (Step 6 portals: SSO + FIDO2); the requester never approves; reasons 10–500 characters; one rejection is final for that request (as ADR 0005 S-3 and ADR 0007 R-3).
- **Audit:** every transition appends one entry to a hash-chained, append-only audit log with UTC digests (F-04), verifiable like `kyc.verify_audit()`.
- **Money:** integer paisa; ledger journal keys are the idempotency keys; a money state change and its journal commit in one transaction; every money-out goes through a bank batch or return with maker-checker, the reconciliation gate (`recon.payouts_allowed()`) and record before send.
- **Chain:** writes only through the outbox (ADR 0004) and the signing service (ADR 0005); kinds named `<domain>.<action>`. Existing kinds: `issuance.mint`, `compliance.freeze`, `rent.record_payout`. Proposed new kinds are marked "proposed" in each spec; each needs a signer policy (deny by default).
- **LEGAL TO CONFIRM** marks every regulatory assumption; nothing marked so may be built as final behaviour without counsel's answer.
- **Personal data:** only KYC subject ids in business records; CNIC, names and IBANs stay in `@pt/kyc` / `@pt/bank` as keyed hashes and sealed values (ADR 0009 Y-1, B-4).

## 5. Reuse of existing components

| Component | Reused by |
|---|---|
| `IssuanceGuard` mint/burn with refId, trustee cap | S-02 (mint at completion, cap), S-05 (redemption burns), S-06 (reversal/succession burns) |
| `PauseGuard` | S-02 mint windows, S-04 transfer-closed mode |
| `FreezeGuard`, `kyc.enqueue_offboarding`, `compliance.freeze` | S-06 (sanctions, cases), S-04 checks |
| `RecoveryGuard` | S-04 off-market transfers, S-06 recovery and inheritance |
| `DistributionRegistry`, `chain/rent.py` leaf and largest remainder | S-03, S-05 final distribution, S-07 proofs |
| `DocumentRegistry` | S-01 anchoring, S-05 vote result and deed, S-06 evidence, S-07 |
| `StateAnchor`, `@pt/anchor` | S-07 |
| Outbox, signer (maker-checker, policies) | all chain writes |
| Indexer read model | S-02 settlement on `Minted`, S-03 record-block balances, S-04/S-06 matching, S-07 |
| Reconciliation and payout gate | every money-out; new checks listed in each spec |
| `@pt/kyc` (subjects, sanctions review) | S-01 persons, S-02 eligibility, S-06 |
| `@pt/bank` (payment codes, exact matching, suspense, payout accounts, batches, held payouts, mock bank) | S-02 subscriptions/refunds, S-03 rent/payouts, S-04 cash leg, S-05 proceeds |
| Web W3/W4 rules (refund only if mint provably never happened; DvP) | S-02, S-04 |

## 6. Changes these specs imply (each needs its own ADR or spec version before code)

1. **Signer:** issuance-batch fact for `issuance.mint`; new kinds `issuance.burn`, `document.add/supersede`, `rent.publish/finalize`, `token.pause`, `recovery.propose/execute/cancel`, `compliance.freeze_case`, `compliance.unfreeze`; gate on `issuance.burn` (ADR 0005 amendment).
2. **Bank:** subscription refund (return of a matched credit); batch kinds `completion`, `refund`, `vendor`; payment-intent purposes `tenant_deposit`, `transfer`, `exit_proceeds`; suspense re-attribution to rent invoices (ADR 0009 amendment).
3. **Reconciliation:** offering-aware `issuance.paid_not_minted`; new `offering.*`, `supply.register_mismatch`, `documents.*`, `rent.wht_mismatch`, `rent.statement_totals`, `rent.record_block_rule`, `tax.*`, `ops.*`, `transfer.*`, `exit.*`, `recovery.unmatched`, `kyc.holder_unverified_unfrozen`, burn checks replacing `issuance.burn_not_reconciled` (ADR 0007 amendment).
4. **Ledger accounts (new):** `property:<token>:capital`, `property:<token>:acquisition`, `reserve:<token>`, `vendor:payable:<id>`, `fees:payable:<id>`, `tax:wht-payable:<token>`, `tenant:<leaseId>:deposit`, `transfer:<id>:escrow`, `exit:pool:<token>`.
5. **KYC:** sealed CNIC for FBR ATL checks, if the owner chooses S-03 Q-2 (a).
6. **Contracts:** none required for the pilot. Optional later: DocumentRegistry with more `DocType`s (S-01 Q-5); a transfer-approval guard for Phase 1 (S-04 option C).
7. **New business schemas** (proposed, Step 6+): sponsors/properties/documents, offerings/subscriptions, operations (leases, invoices, expenses, distributions), transfer and case files; each with roles, append-only audit and maker-checker in the database, like 0009.

## 7. Proposed implementation order

After Step 5h (remaining: website on the read model, mints via outbox + signer, ledger producers so reconciliation passes on the demo chain) and the Step 6 portal shell (SSO, roles, maker-checker screens):

| # | Work | Depends on | Why this order |
|---|---|---|---|
| 1 | S-01 sponsor/property registry, document store with hashes, duplicate detection, reviews (ops-entered for the pilot) | Step 6 shell, `@pt/kyc` | Nothing can be offered without it; no money or chain risk |
| 2 | S-07 sections 3.1–3.3 (supply, documents, anchors) | indexer, anchor | Read-only, low risk, builds trust early |
| 3 | S-02 offering, reservations, refunds, completion, issuance batch, mint at completion | 1, 5h mint path, signer/bank amendments | Core of the pilot |
| 4 | S-06 cases (freeze, recovery, inheritance, sanctions, reversals) | 3 | Must exist before any investor holds units |
| 5 | S-03 operations, distributions with WHT, statements, certificates; S-07 §3.4 | 3, owner decisions on S-03 Q-1/Q-2 | First income period after completion |
| 6 | S-05 exit, final distribution, redemption burns, closure | 5 | Pilot must be proven end to end including redemption |
| 7 | S-04 Phase 0 off-market transfers | 4 (RecoveryGuard machinery) | Low volume; reuses S-06 |
| — | S-04 Phase 1 | regulatory approval | Later |

A **pilot rehearsal** on the local network (one property: S-01 → S-02 → one S-03 period → S-05 with all burns) with clean reconciliation is the gate before any external audit of these flows.

## 8. Decisions recommended to the owner

**Status (2026-10-13): adopted as working defaults by the lead under the owner's standing delegation ("go on with whatever you feel best"). The owner may override any row; items marked LEGAL TO CONFIRM stay open until legal confirms, and code must keep them configurable.**

| # | Decision | Recommendation | Spec |
|---|---|---|---|
| 1 | When to mint | At completion, only for paid subscriptions (single-use refId) | S-02 §2 |
| 2 | Oversubscription | First come, first served with time-limited reservations and a waitlist | S-02 OF-19 |
| 3 | Pilot raise | All-or-nothing (min raise = target = hard cap) | S-02 Q-1 |
| 4 | Trustee cap after completion | Reduce to issued units (supply = cap = register) | S-02 Q-6 |
| 5 | Transfers before approval | Token paused (`transfer-closed`); off-market transfers only as trustee forced transfers (48 h) | S-04 §2 |
| 6 | Merkle leaf | Net amount after WHT; tax detail in a private, hash-bound tax schedule | S-03 Q-1 |
| 7 | Filer status | Sealed CNIC for ATL checks (new ADR) | S-03 Q-2 |
| 8 | Final distribution journals | Keep `rent:` key family | S-05 Q-3 |
| 9 | Burn timing at exit | After the final distribution is finalized | S-05 Q-5 |
| 10 | Wallet custody | Custodial (HSM) for retail in the pilot | S-06 Q-1 |
| 11 | Reversal after completion | Replacement sale rather than burn-and-refund | S-06 Q-3 |
| 12 | Production signing of Safe-held functions | ADR: signer as one Safe owner, trustee co-signs in the Safe console | S-02 Q-8 |
| 13 | Accounting basis | Ledger = cash mirror of the trustee bank; accruals in operations | S-03 Q-6 |
| 14 | Escrow accounts | One per trust/property | S-02 Q-7 |
| 15 | Defaults | Reservation 24 h, grace 2 h, completion 60 days, one 30-day extension, lock-up 6 months, vote 50 %/75 % | S-02, S-04, S-05 |

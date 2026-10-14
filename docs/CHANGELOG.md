# Changelog

Built only from `git log` of `main` up to `41241b3` (60 commits). Dates are commit dates. Grouped by date and step; commit hashes in brackets.

## 2026-10-13

- T-026 / S-06 (branch `s-06-recovery`, not merged; migration 0020): lost-wallet recovery, succession and reversals of platform errors. Spec S-06 section 14 (build refinements and owner questions OQ-1..OQ-7) written first. Schema `recovery` (RV-1..RV-10): case state machines, two-officer approval by capacity (operations + compliance; legal + compliance; operations for reversals), 48-hour objection window with a `security.wallet_recovery_requested` notice, re-verification after opening, frozen-first, exact shares and largest-remainder allocation with a family settlement, reversible journal kinds and exact contra journals, KYC wallet rebinding only after an executed recovery, two-officer release, hash-chained audit. Signer kinds `recovery.freeze|unfreeze|add_key|propose|execute|cancel` (deny by default, `recovery.command_allowed`), admin signer client may create custodial wallets, `signer:setup` imports the dev Trustee key. `@pt/recovery` (`recovery:tick`, `recovery:audit`), KYC `reverify` and `POST /v1/reverify`. Recon: `recovery.unmatched`, `recovery.unmatched_cancelled`, `recovery.reversal_unmatched`, reversed pairs void for cash. Portal: role `legal_officer`, permissions `recovery.read|request|decide`, `/recovery` pages and five routes, audit source `recovery`. ADR 0005, 0007, 0011 amendments; runbook `recovery-succession.md`.
- T-005 / Step 6c (merged; migration 0019): compliance officer portal in `admin/` (dashboard with counts, SLA breaches and recent decisions; KYC review queue and cases; sanctions/PEP screening results and re-screening; freeze/unfreeze requests; STR case log with FMU export) and migration `0019_compliance.sql` (schema `compliance`, rules C-1..C-8: cases opened by screenings, two-officer high-risk decisions in SQL, PEP `accept_edd` clearance, compliance hold → KYC status `suspended`, freeze/unfreeze commands in the outbox, STR closure by two officers and export recorded before release, re-screen queue, CNIC/IBAN/phone refused in free text, officer names bound incl. KYC clearances, hash-chained `compliance.audit`). Signer kind `compliance.unfreeze`; KYC mock PEP list, `RescreenWorker`, `npm run kyc:rescreen`. ADR 0011 section 11. Tests: backend +17 (+1 preview check), admin db +140 (matrix) +6 (rules), HTTP matrix +166.
- T-044 (merged; migration 0018): investor offering screens on the website on top of `@pt/offering` (S-02). Pages `/offerings`, `/offerings/[id]`, `/subscriptions` (EN + Urdu, PKT times, integer paisa), server actions `reserveAction` and `cancelReservationAction`. Migration `0018_web_offering.sql` (WO-1..WO-6): the website role `pt_web` may execute six `offering.web_*` wrappers only; KYC gate in the database; `web:<id>` actors; investor reads scoped to one KYC subject with blocked/disputed shown as under review; payment instructions (code, amount, expiry, escrow account) from the backend. Tests: backend +33 (`offering/test/web.test.ts`), web +34 unit, +6 integration against a scratch database built by the backend's offering world.
- T-027 (branch `t-027-public-verification`, not merged): S-07 public verification page `/verify` (no sign-in, EN + Urdu). Read model figures as of the indexer cursor (halted indexer: "verification paused", no figures); DocumentRegistry records with a SHA-256 file check in the browser (Web Crypto, nothing uploaded); anchor commitment recomputed in the browser (`web/src/lib/anchor-commitment.ts`, a byte-identical copy of `@pt/anchor`'s, compared in CI); Merkle entitlement check in the browser plus `DistributionRegistry.verify` at the cursor block (public server action, rate-limited, nothing stored or logged); statement keccak check. Missing sources are labelled, never faked: trustee register attestation, anchor records and reconciliation status (no read grant for the website role yet), public anchor chain. Portfolio offers the entitlement text for the public check. `chain/document.py` records sample document hashes on the local network (Ops Safe dev key).
- T-020 (branch `t-020-offering`, not merged): S-02 backend. Migration `0015_offering.sql` (schema `offering`, rules OFR-1..OFR-9): L1..L18 and V1..V22 enforced by the database, maker-checker requests with four-party L3, FCFS reservations with payment codes expiring with them and a strict waitlist, payment → Payment Confirmed in the bank's transaction (trigger), extension with withdrawal, all-or-nothing failure with refunds to the sender (two bank operators, gate), issuance batch, mint commands only at completion, settlement from `Minted` events, hash-chained audit; bank amendment (cancelled payment codes, `bank.refund_credit`); package `@pt/offering` and CLI `offering:*`; reconciliation: `issuance.paid_not_minted` SLA starts at the mint window, new `offering.*` checks (ADR 0007 amendment); signer `requireOfferingBatch` (ADR 0005 amendment). 41 new tests incl. a racing-investor test (found and fixed a payment/cancel deadlock) and a mutation-checked fast-check model test.

- T-004 / Step 6b (branch, not merged): operations and approvals portal in `admin/` (inbox; signing requests with the exact decoded call and call hash, decided by the signing service through one-time tickets and its new admin-scoped client; payout batches with the reconciliation gate; unfreeze request and decision; S-01 requests), migration `0016_admin_approvals.sql` (permissions, officer-name binding, tickets, decision and read functions, S-01 duties linked to officer roles), signer `/v1/requests/preview` and `/v1/decide`, `npm run signer:admin-client`, ADR 0011 section 10. Tests: backend +15, admin db +78, HTTP matrix +89, e2e +2.

- T-028 (branch, not merged): notifications backend. Migration `0017_notify.sql` (schema `notify`, rules N-1..N-9, ADR 0013) and package `@pt/notify`: event catalogue with typed placeholders (security notices: new device, contact changed, payout account added/changed/active, KYC status, frozen/unfrozen, large transaction pending; transactional: reservation expiring, rent paid), contacts as keyed hash + sealed copy, consent (security notices cannot be switched off; undeliverable ones alert), versioned EN/UR SMS and e-mail templates, rendering with HTML escaping, Urdu RTL isolates and SMS segment limits, delivery worker (LISTEN/NOTIFY, leases, record before send, provider lookup after an unknown outcome, backoff, dead letters, rate limits), mock providers, CLI `notify:setup|run|status`. 38 tests incl. a property test against a reference model (two mutations checked). Producer wiring is a follow-up per module.
- T-021 (branch, not merged): S-01 backend. Migration `0014_property.sql` (schema `property`, rules PR-1..PR-9) and package `@pt/property`: sponsor KYB with keyed hashes and sealed name/address, the K1..K11 and P1..P14 state machines enforced by the database, maker-checker requests, duplicate detection (normalised property key incl. Urdu digits, deed, title-document hash, GPS 30 m), document metadata with supersede chains, reviews relying on current hashes, valuations with the 10 % rule, IC quorum, structure and trustee acceptance, hash-chained audit; operator CLI `property:*`; pure `documents.*` and `property.token_without_approval` checks for later recon wiring. 48 tests.
- Contracts: 5 tests proving agent actions while paused or frozen (mint refused; redemption burn, trustee forced transfer and burn of frozen tokens work; investor transfers blocked), as assumed by specs S-04/S-05/S-06; 137 forge tests.
- Functional specs S-01..S-07 merged (docs/specs).
- Documentation set from the code audit merged (docs/*.md).
**Step 5f review fixes and Step 5g**
- Fix Step 5f review findings F-04..F-06: migration 0008 (signer audit digest v2 in UTC, forward-only ledger running balances, `IS DISTINCT FROM` validation) [c986aa0]
- Step 5g: KYC and bank with mock providers and a mock bank (ADR 0009, migration 0009) [19e5cc6]
- Record the three Step 5g decisions in ADR 0009 and MEMORY.md [2fb13a3]

**Step 5h (parts 1-4)**
- Held payouts (migration 0010, ADR 0009 decision 2) [88d43cf]
- Signer kinds `compliance.freeze` and `rent.record_payout`; automatic offboarding (migration 0011) [246f2e9]
- Record paid distributions on chain through the outbox [07d03b2]

**Tests**
- Gate the signer speed test on the median on CI [41241b3]

## 2026-10-12

**Step 5c-5f-2 (backend)**
- Step 5c outbox with exactly-once execution on chain [4ed0721]
- Step 5d signing service, policy engine and maker-checker [ee3347e]
- Step 5e indexer and chain read model [2fdff6d], merged [0254836]; ADR 0006 accepted [23277dd]
- Step 5f reconciliation (chain, ledger, bank) and payout freeze [30ead63], merged [926f71d]
- Step 5f-2 public-chain anchoring on a local stand-in [22ff1dc], merged [f1254cd]
- Fix flaky backend CI and bind Besu P2P to localhost [0647031]; measure signer p99 over 200 samples [aa6133f]; `net.py stop` waits for shutdown [89e8e08]

**Website**
- v2 design across the investor website [06e5847], merged [ba5a21c]
- Explicit demo-signer opt-in for the IP demo server [3d8a0b9]

**Deploy and demo**
- `demo.py` also starts the Live Demo Console [c2674d4]
- Private IP demo server and GitHub deploy pipeline [33df872]; fixes [5b945e5, 29af57d, 22cc395, 06786dd, 761c0a9]; mockups published at `/mockups/` [7451ecc]; Ploi plain-server notes [e6cd7e0]

**Design and docs**
- Website redesign mockups v1-v12 [92e90a7]; full v2 mockup suite [c8d8481], PDF [693107f], mobile mockups [6a01bdd, c7ece59]
- MEMORY updates [62db941, f4c6550, f7ec167, b2471e5, af66c09]

## 2026-10-11

- W4 demo secondary market with real-time chart [ff0d36b]
- W5 hardening, end-to-end tests, speed and presenter tooling [c58bf69]

## 2026-10-10

- Step 5a backend foundation on PostgreSQL 18 [4b5060c]
- Step 5b ledger enforced inside PostgreSQL [fbf3c33]
- Live Demo Console [b0d01e9]
- Website W1 properties and live chain data, EN/Urdu [00c6b2f]; W2 demo login, sign-up, mock KYC, on-chain onboarding [52bf75c]; W3 invest, portfolio, rent self-verification [957cadf]
- MEMORY updates [73aeb43, 59e8145, be5a7b1, a27e5e5]

## 2026-10-08

- Project setup, stack decision, contract spec and threat model [a69fdee]
- Security standards baseline [40f6402]
- Step 3 contracts: guards, registries and tests on ERC-3643 4.1.3 [7db5f90]; compliance modules, DeployLib, EthTrust self-assessment [21d240a]
- Project memory and lifecycle PDF [afc252a]; owner preferences and log [6fbe9ed]
- Step 4 local 4-validator Besu QBFT network and end-to-end flow [442af53]

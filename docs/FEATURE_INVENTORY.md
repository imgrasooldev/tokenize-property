# Feature Inventory

- Audited commit: `main` @ `41241b3` (2026-10-13). Status words: **Done** (built and tested), **Partial** (some parts built), **Untested** (built, no automated test), **Missing** (no code).
- Test counts per file are **static counts** of `it(`/`test(` declarations (grep); parametrised tests run more often. Runtime totals from the lead's run on 2026-10-13: contracts forge 132/132; backend vitest 311 passed / 1 failed (36 files); web vitest 67/67; web Playwright e2e 11 tests (not in CI).
- Paths: `B/` = `backend/packages/`, `W/` = `web/src/`, `C/` = `contracts/`.

## 1. Lifecycle mapping

The owner's 16-stage lifecycle brief is not in the repository. The stages below are reconstructed from the lead's audit brief (**Assumption**).

| # | Lifecycle stage | Status | Where |
|---|---|---|---|
| 1 | Property owner / sponsor onboarding and KYB | Missing | none |
| 2 | Property submission and due diligence (title, valuation, legal states) | Missing | DocumentRegistry can hold document hashes (`C/src/registries/DocumentRegistry.sol`); no workflow |
| 3 | Legal structuring, trustee appointment | Missing (off-platform; Unknown) | none |
| 4 | Token deployment and go-live (timelock, trustee cap, unpause) | Done (contracts) | `C/script/DeployLib.sol`, `C/test/Deployment.t.sol` |
| 5 | Offering setup (dates, target, minimum, reservations, oversubscription, close/cancel/refund) | Missing | web has a static catalogue `W/lib/properties.ts` (1 live, 2 coming soon) |
| 6 | Investor onboarding and KYC | Partial | backend `@pt/kyc` (mocks); web inline mock |
| 7 | On-chain identity registration | Done (demo path) | `W/lib/server/onboarding.ts`, `C/src/guards/RegistrarGuard.sol` |
| 8 | Subscription payment (Raast) | Partial | backend `@pt/bank` (signed webhooks, payment codes); web uses a mock `RAAST-DEMO-*` reference |
| 9 | Allocation and minting | Partial | web via demo signer (Done, demo); backend outbox + signer `issuance.mint` (Done, not wired to web: 5h) |
| 10 | Portfolio, statements, tax certificates | Partial | `/portfolio` Done; statements/tax certificates Missing |
| 11 | Property operations (leases, invoices, arrears, expenses, reserves, management fee, net distributable, FBR withholding) | Missing | none |
| 12 | Rent distribution and payouts | Partial | publish via `chain/rent.py` (dev keys); payout batches, held payouts and on-chain payout record in backend |
| 13 | Secondary transfers | Partial (demo only) | `/market`, `W/lib/server/market.ts` |
| 14 | Compliance monitoring (rescreen, freeze, offboarding, recovery, inheritance) | Partial | rescreen + offboarding Done in backend; recovery in contracts only; inheritance Missing |
| 15 | Reconciliation, audit trail, anchoring, reporting | Partial | recon + anchor Done (local stand-in); regulatory reporting Missing |
| 16 | Exit: sale, redemption/burn, closure | Missing (workflow) | `IssuanceGuard.burn(from, amount, refId)` exists in contracts; no backend kind, no UI |

## 2. Features

### 2.1 Contracts and chain

| Feature | Status | Evidence (code; tests) | Depends on |
|---|---|---|---|
| ERC-3643 token suite (vendored T-REX 4.1.3, modules 4.1.6) | Done | `C/src/vendor/ERC3643Suite.sol`, `TrexModules.sol`; `C/test/Compliance.t.sol` (12) | submodules in `C/lib/` |
| IssuanceGuard: mint/burn with single-use `refId`, trustee cap | Done | `C/src/guards/IssuanceGuard.sol`; `IssuanceGuard.t.sol` (13) | timelock |
| PauseGuard (pauser pauses only; Admin Safe unpauses) | Done | `PauseGuard.sol`; `PauseAndFreeze.t.sol` (12) | |
| FreezeGuard (address and partial freeze with case id) | Done | `FreezeGuard.sol`; `PauseAndFreeze.t.sol` | Ops Safe |
| RecoveryGuard (wallet recovery, forced transfer, trustee execute) | Done (contracts only) | `RecoveryGuard.sol`; `RecoveryGuard.t.sol` (11) | Trustee Safe |
| RegistrarGuard (rate-limited investor registration) | Done | `RegistrarGuard.sol`; `RegistrarGuard.t.sol` (8) | |
| DistributionRegistry (publish, reject, finalize, recordPayout, Merkle verify) | Done | `DistributionRegistry.sol`; `Registries.t.sol` (19) | |
| DocumentRegistry (hash + URI, supersede) | Done (contracts only) | `DocumentRegistry.sol`; `Registries.t.sol` | |
| StateAnchor + commitment v1 | Done | `C/src/anchor/StateAnchor.sol`; `AnchorDeployment.t.sol` (11) | |
| Deploy library and handover checks | Done | `C/script/DeployLib.sol`, `Deploy.s.sol`, `DeployAnchor.s.sol`; `Deployment.t.sol` (14), `AdminAndEdges.t.sol` (27) | |
| Invariant tests; F-01 proof | Done | `C/test/invariant/TokenInvariants.t.sol` (9), `C/test/findings/OnchainIdRevocationBypass.t.sol` (4) | |
| Local Besu QBFT network (4 validators, chain 586586) | Done | `chain/net.py`; `chain/flow.py` (50 checks, not a CI job) | Besu 26.9 + JDK 25 |
| Anchor stand-in (Anvil 127.0.0.1:8650, chain 586650) | Done | `chain/anchor.py` | Foundry |
| Rent statement publisher | Done (dev tool) | `chain/rent.py` | dev keys |
| External audits, formal verification | Missing | MEMORY.md §3 "Pre-launch" | budget, owner |

### 2.2 Backend (`backend/packages/`)

| Feature | Status | Evidence (code; tests, static count) | Depends on |
|---|---|---|---|
| Config validation (zod, fail fast, refuses dev chain in production) | Done | `B/config/src/index.ts`; `config.test.ts` (4) | |
| Logger with redaction | Done | `B/logger/src/index.ts`; `logger.test.ts` (1) | |
| DB pool + migration runner (checksums, advisory lock) | Done | `B/db/src/migrate.ts`; `migrate.test.ts` (5) | PostgreSQL 18 |
| Typed ABIs, drift check in CI | Done | `B/contracts/src/abis.ts`; CI step "ABIs match the contracts" | `forge build` |
| Ledger (double entry, append-only, hash chain, running balances) | Done | `0002_ledger.sql`, `0008_review_fixes.sql`, `B/ledger/src/index.ts`; `ledger.test.ts` (13), `balances.test.ts` (8) | |
| Outbox (exactly-once on chain, leases, record-before-broadcast) | Done | `0003_outbox.sql`, `B/outbox/src/index.ts`; `outbox-db.test.ts` (14), `worker.test.ts` (10), `local-chain.test.ts` (2) | |
| Signing service (keystore, deny-by-default policy, maker-checker, nonces, audit, HMAC API) | Done | `0004_signer.sql`, `B/signer/src/*`; `service.test.ts` (11), `keystore-policy.test.ts` (6), `http.test.ts` (3), `audit-timezone.test.ts` (6), `kinds.test.ts` (4), `payout-gate.test.ts` (3), `e2e-chain.test.ts` (5), `e2e-offboarding.test.ts` (1) | outbox, recon gate |
| Signer kinds: `issuance.mint`, `compliance.freeze`, `rent.record_payout` | Done | `B/signer/src/policy.ts` `KINDS` | |
| Indexer and read model (`chain` schema) | Done | `0005_indexer.sql`, `B/indexer/src/*`; `indexer-db.test.ts` (14), `halt.test.ts` (6), `decode.test.ts` (7), `local-chain.test.ts` (1) | Besu |
| Reconciliation and payout freeze, maker-checker unfreeze | Done | `0006_recon.sql`, `B/recon/src/*`; `checks.test.ts` (28), `db.test.ts` (22), `property.test.ts` (3), `reconcile.test.ts` (4), `bank.test.ts` (2), `local-chain.test.ts` (1) | indexer |
| Public anchoring (local stand-in) | Done (L2 pending) | `0007_anchor.sql`, `B/anchor/src/*`; `anchorer.test.ts` (15), `anchor-db.test.ts` (7), `unit.test.ts` (6), `anvil.test.ts` (3) | owner's L2 choice |
| KYC service (peppered hashes, sealed name, derived status, sanctions maker-checker, rescreen) | Done (mock providers) | `0009_kyc_bank.sql`, `B/kyc/src/*`; `kyc-db.test.ts` (13), `providers.test.ts` (9) | real providers |
| Automatic offboarding (freeze command per lost verification) | Done | `0011_integration.sql` `kyc.enqueue_offboarding`, `B/kyc/src/offboarding.ts`; `offboarding.test.ts` (4), `e2e-offboarding.test.ts` (1) | signer, outbox |
| Bank: signed Raast webhooks, payment codes, suspense | Done (mock bank) | `B/bank/src/webhook.ts`, `service.ts`; `bank-db.test.ts` (18), `unit.test.ts` (4), `e2e-recon.test.ts` (4) | real bank API |
| Payout accounts (title match, 72 h cooling-off) | Done | `0009` `bank.payees`, `bank.register_payee` | KYC |
| Payout batches (maker-checker, recon gate, deterministic file, SHA-256 before send) | Done | `0009` `bank.payout_batches`, `B/bank/src/payout-file.ts` | recon |
| Held payouts and follow-up batches | Done | `0010_held_payouts.sql` | |
| On-chain payout record through outbox | Done | `0011` `bank.distribution_file_hash`; `BankServiceOptions.distributionRegistry` | signer |
| Sponsor KYB, property submission, duplicate detection, due diligence, IC, trustee acceptance (S-01) | Done in the backend (no UI; document anchoring and recon wiring later) | `0014_property.sql`, `B/property/src/*`; `property-db.test.ts` (35), `property-model.test.ts` (1), `rules.test.ts` (11), `cli.test.ts` (1) | `@pt/kyc`; Step 6 portals for screens |
| Offering lifecycle (S-02): terms and approvals, reservations with payment codes, FCFS + waitlist, payment matching, close/funded/failed, extension with withdrawal, refunds to sender, issuance batch, mint at completion, settlement | Done in the backend on branch `t-020-offering` (not on `main`; no UI; completion payment batch, OF-52 returned refunds, escrow per trust later) | `0015_offering.sql`, `B/offering/src/*`; `lifecycle.test.ts` (12), `db.test.ts` (4), `concurrency.test.ts` (2), `model.test.ts` (1), `recon.test.ts` (3), `cli.test.ts` (1), `unit.test.ts` (4); `recon/test/offering-checks.test.ts` (13) | `@pt/property`, `@pt/bank`, outbox, signer (`requireOfferingBatch`), indexer read model |
| Rent publish/finalize through backend | Missing | only `chain/rent.py` (dev keys) | 5h / ops portal |
| Ledger producers for `sub:*` / `rent:distribution:*` journals | Partial: `sub:<refId>:paid`, `:settled`, `:refunded` by the offering module (0015, branch); `rent:*` still missing | recon conventions `B/recon/src/conventions.ts` | 5h, T-022 |
| Burn / redemption kind in signer | Missing | `KINDS` has no burn | exit workflow |
| Live Demo Console | Done (local tool) | `B/demo-console/src/*`; no automated tests (Untested) | Besu, PostgreSQL |
| Production KeyProvider (HSM/MPC) | Missing | ADR 0005; only encrypted keystore | vendor choice |
| Notifications (SMS, email, push) | Missing | product-map §3 | |
| API gateway / auth service for investors (passkeys) | Missing | product-map §3; web shows "Coming soon" | |

### 2.3 Investor website (`web/`)

| Feature | Status | Evidence (code; tests, static count) | Depends on |
|---|---|---|---|
| Home, property list and detail with live chain data, EN/Urdu RTL | Done | `W/app/page.tsx`, `W/app/properties/*`, `W/lib/i18n.ts`; e2e `layout.spec.ts` | Besu |
| Public pulse API | Done | `W/app/api/chain/pulse/route.ts`, `W/lib/server/pulse.ts`; Untested by unit tests | |
| Demo personas sign-in, HMAC session cookie (8 h) | Done (demo; no passwords) | `W/app/actions/auth.ts`, `W/lib/server/session.ts`; e2e `security.spec.ts` | |
| Sign-up with inline mock KYC and real on-chain onboarding | Done (demo) | `W/app/actions/auth.ts` `signUp`, `W/lib/server/onboarding.ts`; e2e `signup-invest.spec.ts` | demo signer |
| Invest: mock Raast, ledger, mint, settle/refund/review, reconcile | Done (demo) | `W/lib/server/invest.ts`; `invest-rules.test.ts` (13), `invest.integration.test.ts` (7) | demo signer |
| Portfolio with three reconciliation checks | Done | `W/app/portfolio/page.tsx` | |
| Rent entitlement self-verification (Merkle) | Done | `W/lib/server/rent.ts`, `W/app/actions/rent.ts`; e2e `signup-invest.spec.ts` | `chain/rent.py` statements |
| Demo market (orders, escrow, matcher, DvP, SSE candles) | Done (demo only) | `W/lib/server/market.ts`, `W/app/api/market/[symbol]/stream/route.ts`; `market-rules.test.ts` (14), `market.integration.test.ts` (7), e2e `market.spec.ts` | SECP approval for real use |
| Rate limits | Done | `W/lib/server/rate-limit.ts`; `rate-limit.test.ts` (4) | |
| CSP with nonce, security headers | Done | `W/proxy.ts`; e2e `security.spec.ts` | |
| Website on outbox + signer + read model (retire demo signer) | Partial, in progress on a branch (5h) | `W/lib/server/demo-signer.ts` still used by 10 files | 5h |
| Passkey login, bank linking, tax certificate, AI features | Missing (labelled "Coming soon"/"Sample") | web/README.md "Design" | |
| Public verification page (S-07, T-027) | Partial (branch `t-027-public-verification`): supply/cap/pause/holders as of the cursor, DocumentRegistry list with a browser-only SHA-256 file check, anchor recomputation in the browser, entitlement check in the browser and on chain, EN + Urdu. Not yet real: trustee register attestation (Q-2, shown "not published"), anchor records and reconciliation status (the website role has no read grant: shown "not available"), public anchor chain (L2 pending, Q-1), anchor:verify result (not stored) | `W/app/verify/page.tsx`, `W/lib/server/verify.ts`, `W/lib/server/anchors.ts`, `W/lib/merkle.ts`, `W/lib/verify-rules.ts`, `W/components/verify/VerifyTools.tsx`, `W/app/actions/verify.ts`; tests `merkle.test.ts`, `verify-rules.test.ts`, `anchor-commitment.test.ts`, `verify.integration.test.ts`, e2e `verify.spec.ts`; demo documents `chain/document.py` | grants for `anchor`/`recon` reads (migration), trustee attestation format, L2 choice |

### 2.4 Internal portals, mobile, operations

| Feature | Status | Evidence |
|---|---|---|
| 6a internal portal foundation (WebAuthn, roles/SoD, audit viewer) | Done (merged 55d2c39) | `admin/`, ADR 0011, migration 0013 |
| 6b operations approvals: inbox; signer requests with the exact call (decoded calldata + call hash) decided by the signing service via one-time tickets; payout batches (gate, held lines, items digest); unfreeze request/decision; S-01 requests; step-up and reason on every decision; officer names bound to sessions; S-01 duties linked to officer roles | Built on a branch (T-004), not merged; needs 0015 (S-02) merged first | `admin/src/app/approvals/*`, `admin/src/app/api/approvals/*`, migration 0016, `backend/packages/signer/src/preview.ts`; tests: backend 15, admin db 78, HTTP matrix +89, e2e 2 |
| 6b not yet in the portal: payout batch creation and submission, bank statement import, suspense returns, outbox review decisions, signer policy changes, backup keys | Missing (CLI or service only) | ADR 0011 section 10 |
| 6c-6d compliance, trustee portals | Missing | product-map #5-7 |
| Multisig signing console (self-hosted Safe) | Missing | product-map #8 |
| Sponsor portal | Missing | product-map #9 |
| Flutter investor app | Missing | no `mobile/` folder |
| Demo server deploy (CI-gated) | Done | `.github/workflows/deploy-demo.yml`, `deploy/demo-server/*` |
| Indexer, recon, anchor, signer, bank services on the demo server | Missing | `deploy/demo-server/*.service` run only Besu, PostgreSQL, web, console |
| Monitoring, alerting, backups | Missing | deploy/demo-server/README.md "Not for real users" |

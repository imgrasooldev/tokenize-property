# Tasks

Prioritised roadmap from the audit of `main` @ `41241b3` (2026-10-13). Work **one task at a time**, in the order of §1, unless the owner says otherwise. Each step still needs the owner's gate approval (CLAUDE.md).

Fields: **P** priority (critical / high / medium / low), **C** complexity (S / M / L), **Dep** dependencies, **Files** likely files, **Accept** acceptance criteria, **Tests** required tests, **Risk** regressions to watch. **LE** = launch-essential for a SECP sandbox pilot; **Opt** = optional or later.

## 1. Order of work (top first)

| # | ID | Title | P | C | Type | LE/Opt |
|---|---|---|---|---|---|---|
| 1 | T-001 | Move tail-latency gates out of unit tests into benchmarks | high | S | bug | LE |
| 2 | T-002 | Step 5h: website on outbox + signer + read model (branch) | critical | L | feature | LE |
| 3 | T-003 | Step 6a: internal portal foundation (branch) | critical | L | feature | LE |
| 4 | T-010 | ADR for the real server stack (supersede ADR 0001 parts) | high | S | tech debt | LE |
| 5 | T-011 | Run Playwright e2e in CI | high | M | improvement | LE |
| 6 | T-004 | Step 6b: operations and approvals portal | critical | L | feature | LE |
| 7 | T-020 | Offering module | critical | L | feature | LE |
| 8 | T-022 | Rent publish/finalize and rent journals through the backend | critical | M | feature | LE |
| 9 | T-005 | Step 6c: compliance portal | critical | L | feature | LE |
| 10 | T-006 | Step 6d: trustee portal | critical | L | feature | LE |
| 11 | T-008 | Bring or retire schema `webdemo` (runtime DDL) | high | M | tech debt | LE |
| 12 | T-009 | Remove duplicate KYC and ledger code in web | high | M | tech debt | LE |
| 13 | T-012 | Web database access through least-privilege roles | high | S | improvement | LE |
| 14 | T-021 | Property owner onboarding (KYB), submission, due diligence | high | L | feature | LE |
| 15 | T-023 | Property operations: leases, invoices, arrears, expenses, reserves, fees | high | L | feature | LE |
| 16 | T-024 | FBR withholding tax, statements, tax certificates | high | M | feature | LE |
| 17 | T-030 | Investor passkey login and real sessions | high | M | feature | LE |
| 18 | T-031 | Real providers: NADRA, liveness, sanctions/PEP, bank/Raast | critical | L | feature | LE |
| 19 | T-032 | Production HSM/MPC KeyProvider | critical | L | feature | LE |
| 20 | T-033 | Public L2 anchoring | high | M | feature | LE |
| 21 | T-034 | Run indexer, recon, anchor, signer, bank as scheduled services with alerting | high | M | improvement | LE |
| 22 | T-025 | Exit: sale, redemption/burn, closure | high | L | feature | LE |
| 23 | T-026 | Inheritance and succession | medium | M | feature | LE |
| 24 | T-027 | Public verification page | high | M | feature | LE |
| 25 | T-028 | Notifications (SMS, email, push) | high | M | feature | LE |
| 26 | T-035 | Monitoring, backups, incident runbooks | high | M | improvement | LE |
| 27 | T-036 | Pilot rehearsal: one property end to end | critical | M | improvement | LE |
| 28 | T-037 | External audits (2), formal verification, pen test | critical | L | improvement | LE |
| 29 | T-013 | One short status source (MEMORY/README too long and stale) | medium | S | tech debt | LE |
| 30 | T-014 | Branch protection, signed commits, Semgrep in CI | high | S | improvement | LE |
| 31 | T-015 | Update ADR 0007/0009 status lines | low | S | tech debt | Opt |
| 32 | T-038 | Encrypted document vault | medium | M | feature | LE |
| 33 | T-039 | Multisig signing console (self-hosted Safe) | medium | M | feature | LE |
| 34 | T-040 | Flutter investor app | medium | L | feature | LE per product-map (owner may defer) |
| 35 | T-041 | Permitted secondary transfers beyond the demo | low | L | feature | Opt (needs SECP approval) |
| 36 | T-042 | Sponsor self-service portal | low | L | feature | Opt (product-map "Later") |
| 37 | T-043 | Tests for the Live Demo Console and pulse API | low | S | improvement | Opt |

## 2. Bugs

### T-001 Move tail-latency gates out of unit tests into benchmarks — DONE (2026-10-13: unit suite gates medians or generous bounds; full budgets in `npm run perf` / `npm run perf:signer` with PT_PERF_GATES=1 on a quiet machine)
- Outcome: `npm test` never fails because the machine is busy; latency budgets are still enforced where the environment is controlled.
- Evidence: lead's run 2026-10-13 backend 311 passed / 1 failed (signer p99 63 ms locally with a busy machine; CI #34, #48 failed on p99). Gates: `backend/packages/signer/test/service.test.ts:167-187` (p50/p99), `signer/test/e2e-chain.test.ts:139` (p50 < 200), `indexer/test/local-chain.test.ts:85` (p95 < 100), `indexer/test/indexer-db.test.ts:280` and `outbox/test/worker.test.ts:184` (elapsed < 1-1.5 s; review whether these are functional timeouts or speed gates).
- P high, C S, Dep none. Files: the tests above; new `backend/packages/signer/scripts/bench.ts` + `npm run signer:bench` (pattern: `indexer:bench`, `recon:bench`, `bank:bench`).
- Accept: unit tests keep only generous functional bounds (catching a 738 ms estimateGas regression); p50/p99 budgets live in bench scripts that print and exit non-zero over budget; documented in backend/README; `npm test` green 5 runs in a row under load (e.g. while `forge test` runs).
- Tests: bench scripts runnable locally; existing functional assertions unchanged.
- Risk: losing a regression signal; keep a median gate in the unit test.

## 3. In progress on branches (not on `main`)

### T-002 Step 5h: website on outbox + signer + indexer read model — DONE (merged c962432, 2026-10-13)
- Outcome: web mints/transfers through outbox + signer with maker-checker; reads holdings from schema `chain`; `web/src/lib/server/demo-signer.ts` retired (used by 10 files today); rent and `flow.py`-style mints booked in the ledger so reconciliation PASSES on the demo chain; demo-server services updated.
- P critical, C L, Dep 5a-5g (done). Files: `web/src/lib/server/*`, `backend/packages/{outbox,signer,indexer,recon}`, `deploy/demo-server/*`.
- Accept: `grep demo-signer web/src` empty; recon run on the local chain passes; e2e green; MEMORY/CURRENT_STATUS updated.
- Tests: web integration through the signer path; recon local-chain test expects pass; e2e.
- Risk: demo server downtime; double mint during migration of in-flight `webdemo` rows.

### T-003 Step 6a: internal portal foundation (`admin/`) — DONE (merged 55d2c39, 2026-10-13)
- Outcome: Next.js internal app with WebAuthn (FIDO2) sign-in, roles and separation of duties, audit viewer.
- P critical, C L, Dep none for scaffolding; 6b-6d depend on it. Files: new `admin/`, CI job.
- Accept: per branch plan; CI job added; README layout matches reality.
- Tests: auth, role/SoD denial cases, audit read-only.
- Risk: second Next.js app duplicating web code; keep shared code minimal.

## 4. Missing features

### T-004 Step 6b: operations and approvals portal
- Outcome: UI for maker-checker actions that are CLI-only today: signer approvals (`signer:decide`), payout batch create/decide/submit, follow-up batches, recon unfreeze request/approve, bank statement import, suspense returns.
- P critical, C L, Dep T-003. Files: `admin/`, calls into `@pt/bank`, `@pt/recon`, `@pt/signer`.
- Accept: every action needs two distinct operators where the DB requires it; DB refusals shown clearly; all actions in audit logs.
- Tests: role and SoD denials, same-operator refusal, gate-closed refusal, e2e for one payout cycle.
- Risk: bypassing DB rules from the UI; must call the SQL API functions only.

### T-005 Step 6c: compliance portal
- Outcome: KYC review queue, sanctions clearances (`decideClearance`, two officers), revoke, freeze/unfreeze cases, offboarding status, STR export to FMU.
- P critical, C L, Dep T-003, T-031 for real data. Files: `admin/`, `@pt/kyc`.
- Accept: no readable PII beyond what officers need; every decision audited; unfreeze is two-officer.
- Tests: PII scan of responses, maker-checker, audit chain verifies.
- Risk: PII exposure in logs or UI.

### T-006 Step 6d: trustee portal
- Outcome: trustee register view, co-sign issuance, review/reject distributions in the 48 h window, recovery requests, daily recon report.
- P critical, C L, Dep T-003, T-022, T-039.
- Accept / Tests: trustee-only access; reject path reflected on chain and in the read model.

### T-020 Offering module
- Outcome: offerings with open/close dates, target and minimum raise, per-investor min/max, reservations with expiry, oversubscription allocation, close, cancel with refunds, documents.
- P critical, C L, Dep T-002, T-004. Files: new migration `0012_offering.sql` (or next free number), backend package, web pages.
- Accept: state machine enforced in SQL; refunds only through `@pt/bank`; mints only after close and allocation; recon covers offering totals.
- Tests: property test for allocation (never over target, never above caps), expiry, cancel/refund, concurrency.
- Risk: mint before funds are final; double refund.

### T-021 Property owner onboarding (KYB), property submission, due diligence
- Status (2026-10-13): **backend done on branch `t-021-property-onboarding`**, not merged: migration `0014_property.sql` and `@pt/property` (service, CLI, pure consistency checks, 48 tests). Remaining: portal screens (Step 6), DocumentRegistry anchoring after deployment (OB-41, signer kind `document.add`), wiring `documents.*` / `property.token_without_approval` into `@pt/recon`, notifications, SLA clocks, the encrypted document vault; LEGAL TO CONFIRM values in `property.settings`.
- Outcome: sponsor/owner KYB, property record, document upload (hashes to DocumentRegistry), due-diligence states (title, valuation, legal, Shariah) with approvals.
- P high, C L, Dep T-003, T-038.
- Accept: no property can reach token deployment without all approvals recorded.
- Tests: state machine, maker-checker, document hash matches.

### T-022 Rent publish/finalize and rent journals through the backend
- Outcome: signer kinds for `DistributionRegistry.publish` (and finalize if not left to anyone), statement generation in the backend (replacing `chain/rent.py` for non-dev use), `rent:collected` / `rent:distribution:<token>:<id>` journals booked by a producer.
- P critical, C M, Dep T-002 (overlaps; confirm scope with the 5h branch first). Files: `backend/packages/signer/src/policy.ts`, new rent service, recon conventions.
- Accept: recon `rent.missing_ledger` no longer appears for new distributions; publish needs Ops Safe policy and recon gate.
- Tests: Merkle root/statement equality with the web verifier; policy denials; e2e on Besu.

### T-023 Property operations
- Outcome: leases, rent invoices, arrears, expenses, reserves, management fee, net distributable amount feeding T-022.
- P high, C L, Dep T-022. Accept: net distributable = collected - expenses - reserves - fees, all in the ledger; maker-checker on expenses.
- Tests: ledger balances per property, property tests on rounding (paisa).

### T-024 FBR withholding tax, statements and tax certificates
- Outcome: withholding per investor class on rent, investor statements, annual tax certificates.
- P high, C M, Dep T-023; legal/tax input (rates are Unknown in repo).
- Accept: tax journals reconcile; certificates match ledger. Tests: rate table edge cases, rounding.

### T-025 Exit: sale, redemption/burn, closure
- Outcome: sale proceeds distribution, redemption with `IssuanceGuard.burn(from, amount, refId)` through a new signer kind, token closure, final reconciliation.
- P high, C L, Dep T-022, T-006. Accept: burn only after payout recorded; supply reaches zero; recon passes. Tests: e2e on Besu, refId single use for burns.

### T-026 Inheritance and succession
- Outcome: legal-heir workflow using `RecoveryGuard` forced transfer with evidence hash, trustee execution, KYC of heirs.
- P medium, C M, Dep T-005, T-006. Tests: evidence required, 48 h delay respected, F-02 order (freeze, move, delete identity).

### T-027 Public verification page
- Outcome: public page: supply vs trustee register, document hashes, anchors, Merkle self-check for anyone.
- P high, C M, Dep T-033 for real anchors. Tests: values equal `chain` read model and contract views.

### T-028 Notifications
- Status (2026-10-13): **backend done on a branch** (not merged), Partial overall: migration `0017_notify.sql` (schema `notify`, N-1..N-9) and `@pt/notify` (catalogue, sealed contacts, consent, EN/UR templates, rendering, worker with record-before-send and provider lookup, retries, dead letters, rate limits, mock providers, CLI `notify:setup|run|status`), ADR 0013 Proposed; 38 tests. Numbered 0017 after the S-02 (0015) and 6b (0016) branches: merge those first, or the runner refuses the gap (the notify tests use a renumbered copy).
- Outcome: SMS/email/push for payments, payouts, account changes (B-4 alerts), freezes.
- P high, C M, Dep provider choice. Tests: every sensitive change triggers exactly one notification; no PII in payloads beyond policy.
- **Producer wiring (follow-ups, one per module; each calls `notify.enqueue` in the SAME transaction as its business change, preferably inside its own SQL function via `CREATE OR REPLACE` in that module's next migration, and grants `pt_notify_producer` to its service role; no `NOTIFY` listener as a substitute):**
  1. Bank, `bank.register_payee` (0009): `security.payout_account_added` (no previous account) or `security.payout_account_changed` (previous last4), `active_from` = registration + 72 h; key `bank:payee:<payeeId>`; recipient = the KYC subject.
  2. Bank, cooling-off end: periodic sweep over `bank.payees` with `active_from <= now()` and not superseded → `security.payout_account_active`; key `bank:payee-active:<payeeId>` (idempotent, so the sweep may repeat). Schedule with the other services (T-034).
  3. Bank, payout line paid (`bank.submit_payout_batch` / line confirmed, not returned): `rent.paid` (token, net amount in paisa, period); key `bank:payout:<batchId>:<line>`. Also a later `rent.held` kind for held lines (S-03 §10).
  4. KYC, `kyc.evaluate` and `kyc.revoke` (0009, where `kyc_alert` is raised): `security.kyc_status_changed` with the generic word only (verified, expired, action_required, closed); compliance to confirm the mapping from review/rejected/revoked so nothing tips off a sanctions match (S-06 §9). Key `kyc:decision:<decisionId>`.
  5. Freeze and unfreeze: `security.account_frozen` / `security.account_unfrozen` when the freeze is confirmed on chain (indexer read model, `chain.apply_batch` freeze actions, or the offboarding worker after the outbox confirms `compliance.freeze`), and from compliance cases (T-005); key `freeze:<txHash>:<logIndex>`. Mapping wallet → subject via `kyc.wallets`.
  6. Signer maker-checker: a request above the threshold waiting for approval (`DeferredError` path in `@pt/signer`) → `security.large_transaction_pending` for the investor whose custodial wallet it concerns (amount in paisa, reference = outbox command or request id without long digit runs); key `signer:approval:<requestId>`.
  7. Website sign-in (T-030, `web/`): `security.new_device_sign_in` (coarse device label, time) on a device not seen before; the contact and preference screens (contacts registered only after a one-time code to that contact).
  8. Offering (S-02, `backend/packages/offering`, migration 0015): `offering.reservation_expiring` 2 h before expiry (sweep); key `offering:reservation-expiring:<reservationId>`; further S-02 §10 kinds in a later notify migration.
  9. Officer notices (S-01 §9 reviews/IC/trustee, S-02/S-03 operations and trustee items) need new kinds and templates (category transactional, recipient type officer).
- Other follow-ups: real SMS and e-mail providers with idempotency keys and lookup (T-031); push (T-040); `notify:run` as a service and `notify_alert` to on-call (T-034, T-035); re-seal job for a `NOTIFY_DATA_KEY` rotation; retention rule for superseded contacts (legal).

### T-030 Investor passkey login
- Outcome: replace demo personas with WebAuthn passkeys (AAL2), device binding, session management.
- P high, C M, Dep T-002. Files: `web/src/app/actions/auth.ts`, `web/src/lib/server/session.ts`.
- Tests: forged/replayed assertions, session expiry, e2e.

### T-031 Real providers
- Outcome: adapters for NADRA Verisys, liveness vendor, sanctions/PEP service, trustee bank Raast and payout API behind the existing interfaces (`kyc/src/providers.ts`, `bank/src/webhook.ts`, `BankGateway`).
- P critical, C L, Dep contracts with providers (owner). Tests: contract tests against provider sandboxes; mocks keep running in CI.

### T-032 Production HSM/MPC KeyProvider
- Outcome: `KeyProvider` implementation for an HSM or MPC service; Safes on hardware wallets.
- P critical, C L, Dep vendor choice, T-033 for the anchor key. Tests: signing parity with keystore; key never exported.

### T-033 Public L2 anchoring
- Outcome: owner picks the L2; deploy `StateAnchor` via `DeployAnchor.s.sol`; `ANCHOR_ALLOW_CHAIN_ID` and confirmations set; production key provider.
- P high, C M, Dep owner decision, T-032.

### T-038 Encrypted document vault
- Outcome: storage for title deeds, valuations, KYC documents (ADR 0009 retention), hashes on chain.
- P medium, C M.

### T-039 Multisig signing console
- Outcome: self-hosted Safe{Wallet} for Admin/Trustee/Issuance/Ops Safes. P medium, C M.

### T-040 Flutter investor app
- Outcome: per product-map #3. P medium, C L, Dep T-030, a public API (none exists).

### T-041 Permitted secondary transfers
- Outcome: transfers between verified investors under SECP approval and a licensed intermediary. P low, C L, Opt.

### T-042 Sponsor self-service portal
- P low, C L, Opt (product-map "Later"); T-021 covers the operator-assisted path.

## 5. Improvements

### T-011 Run Playwright e2e in CI
- Outcome: CI job that starts PostgreSQL, a Besu (or Anvil-based) chain, deploys via DeployLib and runs `npm run test:e2e` (11 tests).
- P high, C M, Dep chain start on Linux runners (Besu + JDK 25 download with checksum). Files: `.github/workflows/ci.yml`, `web/playwright.config.ts` (uses `channel: msedge`; needs a Linux channel).
- Accept: e2e job green on main; artefacts uploaded on failure. Risk: long CI time; cold Turbopack compile (MEMORY: first run can time out).

### T-012 Web database access through least-privilege roles
- Outcome: web connects with a LOGIN role granted only the needed functions, not `PG_ADMIN_USER` (`web/src/lib/server/db.ts`).
- P high, C S (after T-002/T-008). Tests: web integration tests pass under the restricted role.

### T-034 Scheduled services with alerting
- Outcome: systemd (or equivalent) units for indexer, signer, outbox worker, bank, anchor; daily `recon` and `anchor:verify` with alerts; on the demo server first.
- P high, C M, Dep T-002.

### T-035 Monitoring, backups, runbooks
- P high, C M. Outcome: DB backups with restore test, chain data backups, uptime and on-chain alerts, runbooks for halts (`indexer` exit 3), `AnchorAlarm`, payout freeze.

### T-036 Pilot rehearsal: one property end to end
- Outcome: one sample property through every stage of FEATURE_INVENTORY §1 on the demo server with written evidence. P critical, C M, Dep most LE tasks.

### T-037 External audits and pen test
- Outcome: two independent smart-contract audits, formal verification provider, pen test of web/admin/backend. P critical, C L, Dep code freeze for contracts.

### T-014 Branch protection, signed commits, Semgrep
- Outcome: GitHub branch protection (2 reviews, CI required, signed commits), Dependabot, secret scanning (owner action); Semgrep job as named in security-standards §3. P high, C S. Note: 0 of 60 commits are signed today.

### T-043 Tests for demo console and pulse API
- P low, C S, Opt. Outcome: unit tests for Host/Origin/token checks in `demo-console/src/server.ts` and the pulse shape.

## 6. Tech debt

### T-008 Bring or retire schema `webdemo` (A2)
- Outcome: `webdemo` created by runtime DDL in `web/src/lib/server/db.ts` either moves to a numbered migration or is removed once 5h moves the web onto `kyc`/`bank`/`ledger`.
- P high, C M, Dep T-002. Accept: no `CREATE TABLE` in web runtime code. Risk: losing demo data on the demo server; plan a one-off migration.

### T-009 Remove duplicate KYC and ledger code in web (A3)
- Outcome: web uses `@pt/kyc`, `@pt/ledger`, `@pt/bank` (or an internal API) instead of `web/src/lib/server/{ledger,onboarding}.ts` and the inline mock NADRA in `web/src/app/actions/auth.ts` (two different mock rule sets today: web rejects CNICs ending 0; `@pt/kyc` mocks use last digit 0/8/9).
- P high, C M, Dep T-002.

### T-010 ADR for the real server stack (A1) — DONE (ADR 0012, 2026-10-13)
- Outcome: new ADR superseding ADR 0001's NestJS/Fastify, Redis read cache, Java 21, 202+WebSocket lines with what `main` does (node:http services, Next.js server actions, SSE, PostgreSQL queues) or a plan to adopt NestJS; ADR 0001 status updated.
- P high, C S. Accept: DECISIONS.md §2 has no "undocumented" rows.

### T-013 One short status source (A6)
- Outcome: CURRENT_STATUS.md is the short status; MEMORY.md and README keep links instead of long status lines; README layout fixed (`admin/`, `mobile/` listed but absent; step table stale: "121 tests", Step 5 list ends at 5f); backend/README "5h Planned" fixed; product-map build order refreshed. P medium, C S. Coordinate with whoever edits MEMORY.md.

### T-015 Update ADR 0007/0009 status lines — DONE (2026-10-13: 0007, 0009, 0010, 0011 Accepted; 0008 stays Proposed until the L2 is chosen)
- Both say "Proposed ... awaiting lead review" though merged. P low, C S. Owner/lead decides Accepted.

## 7. A1-A6 cross-reference

| Audit item | Task |
|---|---|
| A1 ADR 0001 stack vs code | T-010 |
| A2 `webdemo` runtime DDL | T-008 |
| A3 duplicate KYC/ledger in web | T-009 |
| A4 load-sensitive timing assertions | T-001 |
| A5 e2e not in CI | T-011 |
| A6 status buried in long lines | T-013 |

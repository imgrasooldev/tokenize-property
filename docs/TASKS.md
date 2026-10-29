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
| 38 | T-044 | Investor offering screens on the website (S-02) | critical | M | feature | LE |
| 39 | T-045 | Website: every element real (catalogue, payout accounts, documents, history, map, search, analyst, rule-based score) | high | L | feature | LE |
| 40 | T-047 | Website: real public-anchoring status (rail + `/verify#anchor`, migration 0025) | high | S | feature | LE |
| 41 | T-046 | PT Control screens for the remaining officer votes (committee, P8, platform L3) | high | M | feature | LE |
| 42 | T-048 | S-04 phase 0: permitted off-market transfers (desk, compliance + trustee, DvP, RecoveryGuard) | high | L | feature | LE (if SECP allows phase 0) |
| 43 | T-049 | Platform roles: platform owner (emergency payout hold), property manager, investor support (migration 0031) | high | M | feature | LE |

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
- Status (2026-10-13): **built on a branch, not merged** (ADR 0011 section 10, migration `0016_admin_approvals.sql`; merge S-02's 0015 first). Done: approvals inbox; signer requests decided by the signing service through a new admin-scoped HTTP client and one-time database tickets, with the exact call decoded from the calldata and bound by a call hash; payout batch decisions (gate, held lines, items digest); unfreeze request (maker) and decision (checker); S-01 maker-checker request decisions; reason + fresh step-up on every decision; officer names bound to sessions for signer approvals, unfreezes and payout batches; S-01 duties linked to officer roles; views and decisions audited. Not in the portal yet (still CLI/service): payout batch create and submit, follow-up batch creation, bank statement import, suspense returns, outbox review decisions. Tests: backend +15, admin db +78, HTTP matrix +89 (272), e2e +2 (approve flow with virtual keys).
- Outcome: UI for maker-checker actions that are CLI-only today: signer approvals (`signer:decide`), payout batch create/decide/submit, follow-up batches, recon unfreeze request/approve, bank statement import, suspense returns.
- P critical, C L, Dep T-003. Files: `admin/`, calls into `@pt/bank`, `@pt/recon`, `@pt/signer`.
- Accept: every action needs two distinct operators where the DB requires it; DB refusals shown clearly; all actions in audit logs.
- Tests: role and SoD denials, same-operator refusal, gate-closed refusal, e2e for one payout cycle.
- Risk: bypassing DB rules from the UI; must call the SQL API functions only.

### T-005 Step 6c: compliance portal
- Status (2026-10-13): **built on branch `step-6c-compliance-portal`, not merged** (ADR 0011 section 11, migration `0019_compliance.sql`; 0018 is reserved for parallel work and must be merged first or the backend runner refuses the gap). Done: KYC review queue and cases (automatic for possible sanctions/PEP matches and list hits, manual cases; approve/reject/request-more-info/escalate with reasons; high risk two officers in SQL; PEP acceptance `accept_edd`); screening results and re-screening queue run by the KYC service (`kyc:rescreen`); freeze/unfreeze maker-checker with reason codes, compliance hold (`suspended`), outbox → signer (`compliance.freeze`, new `compliance.unfreeze`); STR cases with append-only notes, two-officer closure, recorded FMU export (manual filing); dashboard (counts, SLA breaches, recent decisions); compliance audit chain in the audit viewer. Not yet: partial freezes, assisted payout-account changes, offboarding steps 2-3 in the portal, investor-facing wording of `suspended`/PEP (tipping-off), real PEP provider and goAML format, e2e browser spec for 6c.
- Outcome: KYC review queue, sanctions clearances (`decideClearance`, two officers), revoke, freeze/unfreeze cases, offboarding status, STR export to FMU.
- P critical, C L, Dep T-003, T-031 for real data. Files: `admin/`, `@pt/kyc`.
- Accept: no readable PII beyond what officers need; every decision audited; unfreeze is two-officer.
- Tests: PII scan of responses, maker-checker, audit chain verifies.
- Risk: PII exposure in logs or UI.

### T-006 Step 6d: trustee portal
- Status (2026-10-13): **built on branch `step-6d-trustee-portal`, not merged** (ADR 0011 section 12, migration `0023_trustee.sql`; 0020-0022 are reserved for parallel work and must be merged first or the backend runner refuses the gap). Done: trustee overview; trustee register (entries from V18 confirmations and two-officer adjustments) next to the read-model holders pinned to the cursor block, supply vs cap vs register, differences highlighted, export with SHA-256 evidence recorded before release; trustee co-signature in the signer's maker-checker for `issuance.mint` above the threshold (database-set requirement, capacity from the approver's role, ticket of capacity trustee redeemed by the signing service, call preview equal to the signed calldata; ADR 0005 amendment); trustee votes on S-02 requests (IB, CMP incl. completion payment batch, L3, L7, L8, L10..L16, SD) through `admin.decide_offering_request`; distribution review in the 48 h window (approve with the recomputed root or reject; a rejection blocks payout batches and the `rent:distribution` booking in SQL; S-03 amendment); daily reconciliation report (runs per day, findings, digest, gate); recovery requests from the read model with the S-06 hook `trustee.recovery_cases_json()`; trustee audit chain in the audit viewer; runbook `docs/runbooks/trustee-operations.md`. Tests: backend +6 (signer 4, offering 2) and 6b/web tests extended with the trustee step (full backend suite 547 passed + 13 skipped of 560 (indexer C-7 NOTIFY timing failed once in the full run and passes alone) with temporary uncommitted placeholders 0020-0022); admin unit/db 494 (353 + 141), HTTP matrix 601 (438 + 163), e2e 5/5 in Edge (the mint flow now ends with a trustee co-signature).
- 2026-10-22: main (0020 S-06, 0021 S-03, 0022 T-045, 1379147) merged into the branch; 0023 applies on top of 0022, shows S-06 cases read-only, wires S-03 OP-21 (charges above the limit) and D4 (pre-check) to the trustee, and blocks `rent:wht` of a rejected distribution. Lead-style check after merging main 1379147: backend typecheck/lint, `migrate -- --test` (0023 on top of 0022), vitest 656 passed + 13 skipped (chain not running); admin typecheck/lint, `npm test` 893/893, build, `test:http` 1048/1048; web typecheck/lint, 231 passed + 24 skipped.
- Lead decision 2026-10-22: offering votes under an officer's handle stay bound to portal sessions; `seed:catalog` (T-045) never casts a vote or decision under an officer's handle: it prepares everything up to the first vote (K4, investment committee, P8, L3), stops with outcome `waiting` and lists which votes officers must cast in PT Control (session + step-up), and writes nothing on a re-run while they are due. PT Control has screens for K4 (Approvals > Property & KYB) and the trustee's L3 vote (Trustee > Co-signing); investment committee votes, the P8 trustee acceptance and the non-trustee L3 votes have no screen yet, so the demo catalogue currently stops at the committee.
- Not yet: ~~PT Control screens for investment committee votes, the P8 trustee acceptance and non-trustee L3 votes~~ (built in T-046, branch `t-046-portal-votes`); trustee capacity in S-06 case decisions; on-chain Trustee Safe actions (reject, recovery) stay in the Safe console (T-039); trustee attestation feed / recon `supply.register_mismatch` (S-07 Q-2); S-06 case files (hook only); command-line trustee duty for non-officer names (break-glass) still open; requiring a trustee approval (not only no rejection) before booking (S-03 Q-7).
- Outcome: trustee register view, co-sign issuance, review/reject distributions in the 48 h window, recovery requests, daily recon report.
- P critical, C L, Dep T-003, T-022, T-039.
- Accept / Tests: trustee-only access; reject path reflected on chain and in the read model.

### T-020 Offering module
- Status (2026-10-13): **backend done on branch `t-020-offering`**, not merged: migration `0015_offering.sql`, `@pt/offering` (service, CLI), recon `offering.*` checks and the `paid_not_minted` amendment, signer `requireOfferingBatch`; S-02 §16 lists refinements and what is not built (completion payment batch OF-45, OF-52 returned refunds, escrow per trust, cap reduction, chain dry run, notifications, investor pages and portal screens). Merge after S-01 (0014); migration number 0015.
- Outcome: offerings with open/close dates, target and minimum raise, per-investor min/max, reservations with expiry, oversubscription allocation, close, cancel with refunds, documents.
- P critical, C L, Dep T-002, T-004. Files: new migration `0012_offering.sql` (or next free number), backend package, web pages.
- Accept: state machine enforced in SQL; refunds only through `@pt/bank`; mints only after close and allocation; recon covers offering totals.
- Tests: property test for allocation (never over target, never above caps), expiry, cancel/refund, concurrency.
- Risk: mint before funds are final; double refund.

### T-044 Investor offering screens (S-02 website)
- Status (2026-10-13): **Partial, on branch `t-021-offering-screens`** (named T-021 by the lead; T-021 is already the S-01 task, so the work is filed as T-044). Built: `/offerings`, `/offerings/[id]`, `/subscriptions`, server actions `reserveAction` / `cancelReservationAction`, migration `0018_web_offering.sql` (WO-1..WO-6). Tests: backend `offering/test/web.test.ts` (33: grants, KYC gate, actors, scoping, tipping-off, 29 denials), web `test/offering-rules.test.ts` (34 unit incl. EN/UR parity and the SQL message mapping) and `test/offering.integration.test.ts` (6, server actions against a scratch database; skipped without PostgreSQL).
- Remaining: browser check and a Playwright spec with a seeded live offering; withdrawal button for OF-22/OF-23 windows; supplementary disclosure acceptance; sophisticated-investor category (LEGAL TO CONFIRM); document download (T-038); trustee bank's real escrow IBAN/Raast alias (today the reconciliation account id is shown); a scheduler running `offering.tick` so reservations expire and the waitlist moves (T-034); notifications (`offering.reservation_expiring`, T-028).
- Dep T-020 (merged), T-028.

### T-045 Website: every element real
- Status (2026-10-13): **Partial (built and unit/integration tested), on branch `t-045-web-functional`**, migration `0022_web_account.sql` (merge 0020/0021 first). Built: record-backed catalogue and property pages, filters/sort/map, price and rent history, documents, trust structure, rule-based score, payout accounts via `bank:payees`, `/search`, analyst (grounded; Claude optional, ADR 0015 Proposed), portfolio summary, market states, `seed:catalog`.
- Remaining: browser check at 375 px EN/UR and Playwright specs for `/properties` filters, `/account` payout form, `/search`; enrol the 14 demo officers on the demo server so `seed:catalog` runs (list in the branch report; since 2026-10-22 it stops at every officer vote; with T-046 every vote has a PT Control screen and the click order to `approved` is in `docs/runbooks/portal-votes.md`); lease register (lease factor of the score has no data); `document.add` signer kind so offering documents are anchored by the platform; passkeys (T-030); Docs & Tax (S-03).
- Dep T-020, T-021, T-044.

### T-046 PT Control screens for the remaining officer votes
- Status (2026-10-22): **built on branch `t-046-portal-votes`, not merged** (migration `0026_portal_votes.sql`; merge the reserved 0025 first, the runner refuses the gap; ADR 0011 section 13, specs S-01 §16 and S-02 §18 changed first). Done: Operations > Investment committee (`/committees`: open a meeting and chair it, vote approve/reject/abstain with a reason or record a conflict, the chair closes with the minutes SHA-256; quorum, independence and OB-SOD-1 stay `property.cast_vote`/`close_ic`'s); Trustee > Property acceptance (`/trustee/properties`: P8 accept/decline of the latest structure, a structure is decided once); Operations > Offering approvals (`/approvals/offering`: platform votes on S-02 requests by duty, return to draft after a lapsed L3); binding triggers on `property.ic_votes`, `ic_meetings` (close) and `trustee_decisions` (open item 3 closed for these); refusals carry the SQLSTATE; permissions `committee.vote`, `offering.read`, `offering.decide`; `seed:catalog` prints the page for every due vote and stops with `blocked` after a committee "not approved" or a declined structure; demo walkthrough in `deploy/demo-server/README.md` and `docs/runbooks/portal-votes.md`.
- Tests: see ADR 0011 "Tests (T-046)"; seed test drives both demo properties to `approved` through the portal functions with real officer sessions. Branch run 2026-10-22: backend typecheck/lint, vitest 680 passed + 13 skipped (chain not running; with an uncommitted local 0025 placeholder); admin typecheck/lint, `npm test` 1005/1005, build, `test:http` 1174/1174.
- Remaining: Playwright e2e of the three screens (not run; no browser check yet); K4 / P-requests (`property.decide_request`) and the makers' own S-01 actions are not bound to sessions yet; `seed:catalog --token` takes one token for both properties; reaching `ready` needs the token (DeployLib), the trustee cap (timelock) and the documents anchored (`document.add` signer kind missing).
- Dep T-006, T-021, T-020, T-045.

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
- Status (2026-10-14): **Partial, on branch `s-03-operations-tax`** (migration 0021, `@pt/tax`, admin `/operations`): collections from bank lines, charges (expense, fees, reserve) with evidence hash and maker-checker, operating statement, calculation at the record block, statement v2, booking. Not built: leases, invoices and payment codes per invoice (OP-1..OP-16), arrears, budgets, fee formulas (fees are entered with evidence), vendor accounts and vendor payment batches, trustee approval above the limit (6d), D13 no-distribution record, record-block rule check (`rent.record_block_rule`), `ops.pool_residual`, `ops.expense_unapproved`, collections in the portal (CLI only), publish/finalize commands (T-022).
- Outcome: leases, rent invoices, arrears, expenses, reserves, management fee, net distributable amount feeding T-022.
- P high, C L, Dep T-022. Accept: net distributable = collected - expenses - reserves - fees, all in the ledger; maker-checker on expenses.
- Tests: ledger balances per property, property tests on rounding (paisa).

### T-024 FBR withholding tax, statements and tax certificates
- Status (2026-10-14): **Partial, on branch `s-03-operations-tax`** (migration 0021, ADR 0014 Proposed): versioned placeholder rates with two-officer changes, ATL filer checks (mock), WHT per line in integer paisa (round half up), Merkle leaf = net (format unchanged), WHT and remittance journals, certificate data, sealed CNIC + two-officer FBR filing export, `tax.reconcile` + recon `checkTax`. Not built: exemption certificates (OP-42), Zakat (OP-43), certificate PDF, investor statement pages, CNIC re-collection from investors (website), real ATL provider (T-031), remittance screens (CLI only), confirmed rates and FBR format (LEGAL/TAX).
- Outcome: withholding per investor class on rent, investor statements, annual tax certificates.
- P high, C M, Dep T-023; legal/tax input (rates are Unknown in repo).
- Accept: tax journals reconcile; certificates match ledger. Tests: rate table edge cases, rounding.

### T-025 Exit: sale, redemption/burn, closure
- Status (2026-10-22): **Partial, on branch `s-05-exit`** (migration `0027_exit.sql`, spec S-05 sections 14-16, ADR 0005/0007/0011 amendments, runbook `exit-redemption.md`). Built: exit cases X1-X18 with capacity decisions, proceeds from escrow statements, waterfall (maker/checker/trustee) and its payments, final distribution (S-03 arithmetic, WHT placeholders, statement + trustee pre-check), redemption batch with refIds, burn rule `after_payment` by default and held-line release, signer kind `issuance.burn` (deny by default, gate, refId re-derived), tick (publish/finalize/burns/Paid Out), closure, recon burn and exit checks, PT Control `/exit`, website `/exit` with the phase-0 redemption request queue. Not built / unverified: Besu run of real burns, Playwright e2e, InvestorVote/deed anchoring (`document.add`), exit_proceeds payment code, deposit refund payment, capital release journal, partial exit, binding investor redemption (S-05 EX-46). Owner questions in S-05 §16.4.
- Outcome: sale proceeds distribution, redemption with `IssuanceGuard.burn(from, amount, refId)` through a new signer kind, token closure, final reconciliation.
- P high, C L, Dep T-022, T-006. Accept: burn only after payout recorded; supply reaches zero; recon passes. Tests: e2e on Besu, refId single use for burns.

### T-026 Inheritance and succession (S-06: recovery, succession, reversals)
- Outcome: legal-heir workflow using `RecoveryGuard` forced transfer with evidence hash, trustee execution, KYC of heirs.
- P medium, C M, Dep T-005, T-006. Tests: evidence required, 48 h delay respected, F-02 order (freeze, move, delete identity).
- **Built on branch `s-06-recovery` (2026-10-13, not merged):** migration `0020_recovery.sql` (schema `recovery`, RV-1..RV-10), `@pt/recovery` (allocation twin, `recovery:tick`, `recovery:audit`), signer kinds `recovery.freeze|unfreeze|add_key|propose|execute|cancel` gated by `recovery.command_allowed`, KYC `reverify` + `POST /v1/reverify`, recon checks `recovery.*` and void reversal pairs in cash, portal `/recovery` with role `legal_officer`, spec S-06 section 14, runbook `recovery-succession.md`. Unit and DB tested; not run against Besu (48 h delay), no Playwright e2e.
- Remaining: payable transfer of held distributions to heirs (S-06 §6) and retiring the deceased's payout account (S-03 OP-53); cash-out of remainder units (RC-14); identity deletion after zero balance (RC-16); bank recalls RC-20..RC-24 and `issuance.burn` for reversals; recon checks `compliance.freeze_unmatched`, `kyc.holder_unverified_unfrozen`, `issuance.reversed_not_resolved`; one RecoveryGuard per token (policies are single-token today); trustee-officer step in 6d; T-045.

### T-045 Website follows the KYC wallet binding after a recovery
- Outcome: the website maps an investor to `kyc.wallets` (or is updated by the recovery) instead of `webdemo.investors.wallet_address`, so a recovered investor sees their new wallet. Branch/video re-verification screen calling `POST /v1/reverify`.
- P medium, C S, Dep T-026.

### T-027 Public verification page
- Outcome: public page: supply vs trustee register, document hashes, anchors, Merkle self-check for anyone.
- P high, C M, Dep T-033 for real anchors. Tests: values equal `chain` read model and contract views.
- Status (2026-10-13): **Partial, on branch `t-027-public-verification`** (awaiting lead review). Built per S-07: `/verify` (EN + Urdu), sections 3.1-3.4, section 6 halted path, disclosures, public `checkProofOnChain` action (rate `publicVerify`). Tests: unit (Merkle against `chain/rent.py` fixtures, commitment vector and byte-identity with `@pt/anchor`, file SHA-256, match/register/freshness/gate rules, EN/UR text parity), integration (view equals contract views at the cursor block; no grant on `anchor`/`recon` shown as such; on-chain proof and +1 paisa; no holder wallet or name in the view), e2e `verify.spec.ts`.
- Remaining before Done: (1) ~~a migration granting the website role read access to anchor components and to the latest reconciliation status only~~ done: reconciliation by 0022 (T-045), anchors by 0025 (T-047); (2) trustee register attestation source and format (S-07 Q-2) so PV-2 can turn green or show `supply.register_mismatch`; (3) public L2 and explorer links (Q-1, T-033); (4) store the latest `anchor:verify` result (with a scheduler, T-034) so PV-22 can show it; (5) public documents for download (PV-12) once a document store exists (T-038).

### T-047 Website: real public-anchoring status
- Outcome: the status rail and `/verify#anchor` show the real anchoring state instead of "Coming soon" / "not readable".
- Status (2026-10-22): **Partial (built and tested, not merged), branch `t-047-web-anchor-status`**. Migration `0025_web_anchor.sql` (WN-1..WN-4: `anchor.web_status()`, `anchor.web_recent(n)` for `pt_web` only, public values only, at most 20 rows, never failed anchors or failure reasons); rail "Anchored · block #N · X min ago" (amber after 2 x `ANCHOR_INTERVAL_SECONDS`, red "Failed", "Anchor (local stand-in)" on 586650) linking to `/verify#anchor`; `/verify` status, recent anchors with commitment, self-check filled from a chosen anchor. Tests: backend `db/test/web-anchor.test.ts` (14), web `anchor-rail.test.ts` (9) and `anchor.integration.test.ts` (4, as `pt_web_app` on a scratch database). Checked in a browser (desktop, 375 px, Urdu) against a scratch database with seeded anchors; not on the demo server.
- Remaining: Playwright `verify.spec.ts` run (updated, not run); explorer links once the public L2 is chosen (T-033); a stored `anchor:verify` result (T-034); a public JSON export of all anchor records.

### T-048 S-04 phase 0: permitted off-market transfers
- Status (2026-10-23): **Partial (built and tested, not merged), branch `s-04-transfers`**, migration `0028_transfers.sql` (on top of S-05's 0027, merged into the branch 2026-10-23). Spec S-04 section 16 written first; ADR 0005/0007/0009/0010/0011 amendments; threat M-13; runbook `transfers.md`. Schema `transfer` (cases, checks, decisions, codes, prices, conflicts, links, alerts, blocks, cash operations, audit), signer kinds `transfer.propose|execute|cancel`, `@pt/transfer` (`transfer:tick`, `transfer:audit`), recon `transfer.*`, PT Control `/transfers`, website `/transfers` (EN + Urdu).
- Tests: backend typecheck/lint, vitest 722 passed + 13 skipped (with a temporary uncommitted local 0027 placeholder; incl. `transfer/test/transfer.test.ts` 19, `signer/test/transfer-kinds.test.ts` 6, `recon/test/transfer-checks.test.ts` 3); admin typecheck/lint, `npm test` 1117/1117, build, `test:http` 1304/1304; web typecheck/lint, vitest 320 passed + 24 skipped (incl. transfer unit + integration 60), build.
- After merging main 2337afa (S-05 0027, Next.js 16.4.2) on 2026-10-23, no placeholder: backend typecheck/lint, `migrate -- --test` (0028 on top of 0027), vitest 761 passed + 13 skipped; admin typecheck/lint, `npm test` 1203/1203, build, `test:http` 1433/1433; web typecheck/lint, vitest 350 passed + 24 skipped, build.
- Remaining: owner questions S-04 TQ-1..TQ-6 and Q-1..Q-4; a demo-server unit for `transfer:tick` (T-034); the bank service sending settlement/refund instructions; trustee inbox co-signature of proposals (TQ-5); Playwright e2e and a browser check at 375 px (not done); a Besu run of the 48-hour path; phase 1 (T-041).
- Dep T-006, T-020, T-026, T-030; S-05 (0027, merged; exit hook `exit.exit_underway`).

### T-049 Platform roles (platform owner, property manager, investor support)
- Status (2026-10-29): **Partial (built and tested on branch `platform-roles-0031`, not merged)**, migration `0031_platform_roles.sql` (PR-1..PR-5), ADR 0011 addendum and ADR 0007 amendment 2026-10-29.
- `platform_owner`: reads the operational pages and places an emergency payout hold (one person, fresh step-up, reason); the hold is lifted only by the existing maker-checker unfreeze after a reconciliation run that started after it has passed. Decides nothing; no compliance or tax reads; compatible with `admin` and `support_agent` only.
- `property_manager`: reads properties and operating statements; holds no other role. `support_agent`: `/support` looks up one investor by the 8-character reference (masked CNIC, support-safe status, account age, wallet, recent notices; reviews, holds and reasons read "refer to compliance"); every lookup audited.
- Tests: admin typecheck/lint, unit 18, db `rules` + `read-matrix` 1509, `platform.test.ts` 8, build, `test:http` (see the MEMORY log).
- Remaining: the investor-visible reference on the website account page (so support can ask for it); scoping property managers to their own properties (today they read all); Playwright spec for `/support` and the hold form; owner to confirm the role set and who receives `platform_owner`.

### T-028 Notifications
- Status (2026-10-23): **producers built on branch `t-028-producers`, not merged** (migration `0030_notify_producers.sql` on top of 0029, ADR 0013 amendment 1, NP-1..NP-9). Producers 1-5 and 7-9 below are wired as deferred constraint triggers plus `notify.sweep` (reminders), and S-04/S-05/S-03/S-06-era modules on top (exit milestones, final distribution, burns, transfer checks, tax certificate, rent credited/held/returned, offering lifecycle, officer queues and alerts, SLA breaches, passkeys, new-device sign-in); marketing category with opt-in consents; no-tipping-off rules and a DB guard on investor templates; investor notification centre `/notifications` (EN/UR, `notify.web_*` for `pt_web`). Tests: backend `notify/test/producer-rules|producers-offering|producers-bank|producers-kyc-ops|producers-exit.test.ts`, `db/test/web-notify.test.ts`, transfer test assertion; web `notify-render.test.ts`, `notifications.integration.test.ts`. Remaining: item 6 (investor `large_transaction_pending`: signer amounts are token units), contact capture with one-time codes, real providers (T-031), `notify:run` as a demo-server unit (T-034), officer notification screen in PT Control, browser check at 375 px and a Playwright spec, quiet hours (owner).
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
- Status (2026-10-13): **built on branch `t-030-investor-passkeys`, not merged** (migration `0024_investor_passkeys.sql`, ADR 0010 section 8). Passkey registration, listing and revocation on `/account`; discoverable passkey sign-in on `/login`; database sessions (30 min idle, 12 h, 10 live, logout) for every sign-in path; step-up `requireRecentPasskey()` wired to offering reserve (from PKR 100,000) and cancel through session-bound SQL wrappers; lockout, rate limits, clone detection, hash-chained audit. Tests: backend `db/test/webauth.test.ts` 22, web unit 6 + integration 10 (software authenticator, scratch database), e2e `passkey.spec.ts` 2/2 in Edge with a virtual authenticator (`npm run test:e2e:passkey`, http://localhost:3102, database `pt_web_e2e`).
- **Merge order:** brought up to date with main (0020-0023) on 2026-10-22. After merging, `npm run migrate` (and `-- --test`) before the website starts: every page reads the session from `webauth`.
- Owner actions: a domain + TLS for the website, then `WEB_ORIGIN=https://<domain>` in `pt-web.service` and drop `WEB_PLAIN_HTTP`; then `UPDATE webauth.settings SET require_passkey = true` (as the database admin) so investors without a passkey must add one before sensitive actions; confirm the PKR 100,000 reserve threshold (`webauth.step_up_actions`).
- Not done (follow-ups): retire the demo personas (they still sign in without authentication); new-device sign-in notification (T-028 producer 7); account recovery without any passkey (S-06); an investor screen for active sessions; the bank service itself does not yet check the step-up (the website asks the database first; a step-up proof towards the bank service is a follow-up); an alert consumer for `webauth_alert` (T-034/T-035); retention for ended sessions and old audit rows.

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
- Status (2026-10-23): **Partial, branch `t-012-service-roles` (not merged; CI not yet run on GitHub).** CI jobs `admin-e2e` (all admin specs: auth, ops approvals, screens; virtual FIDO2 keys; test signing service; officers' browsers send their own X-Forwarded-For so a warm run does not trip the 10-enrolments-a-minute limit) and `web-e2e` (website passkey spec; virtual authenticator) on Ubuntu with Playwright's Chromium (`PW_BROWSER=chromium`, configs keep Edge locally), PostgreSQL 18 service container, browser cache per lockfile, traces uploaded on failure, 25 min job limit. **Local only (documented in OPERATIONS 5b):** the website's main e2e (sign-up/invest, market, verify, layout, security) needs the four-validator Besu chain, `flow.py` (60 s timelocks, validator outage) and cold compiles. Local runs (Edge, private PostgreSQL): admin e2e 5 passed + 1 skipped, web passkey e2e 2/2. Follow-up: an Anvil-based deployment path for the main e2e.

### T-012 Database access through least-privilege roles (website and every backend service)
- Outcome: web connects with a LOGIN role granted only the needed functions, not `PG_ADMIN_USER` (`web/src/lib/server/db.ts`).
- P high, C S (after T-002/T-008). Tests: web integration tests pass under the restricted role.
- Status (2026-10-23): website part done earlier (`pt_web_app`, 0012). **Backend services built on branch `t-012-service-roles` (not merged; ADR 0016 Proposed, migration `0029_service_roles.sql` on top of 0028).** Fifteen groups `pt_svc_*` (indexer, signer, outbox, kyc, offboarding, bank, anchor, recon, recovery, tax, notify, exit, transfer, audit, console), logins by `npm run db:service-roles`, fail-closed `serviceDbLogin` in every service CLI, reviewed privilege inventory per group, the services' own suites run under their logins (indexer, outbox, kyc, offboarding, bank, anchor, recon, recovery, signer, tax, notify, exit, transfer), demo server wiring and per-unit rollback (`deploy/demo-server/db-login.sh`). Tests (2026-10-23, private PostgreSQL): backend 813 passed + 13 skipped (incl. `db/test/service-roles.test.ts` 48 and config 8), `migrate -- --test` 29, admin 1203 + HTTP 1433 + build, web 350 + 24 skipped + build. Not done: operator CLIs still use the admin (ADR 0016 point 4); TLS and secret storage outside files for production; not yet deployed to the demo server.

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

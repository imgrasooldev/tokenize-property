# Current Status

Short handoff for the next session. Read this and [TASKS.md](TASKS.md) first; open other docs only when the task needs them.

## T-047 public-anchoring status on the website (2026-10-22, branch `t-047-web-anchor-status`, not merged; migration 0025)

- Rail and `/verify#anchor` show real anchors through `anchor.web_status()` / `anchor.web_recent()` (pt_web may execute only these in schema `anchor`). Chain 586650 is labelled as the local stand-in everywhere.
- After merging: `npm run migrate` (0025) on the demo server; `pt-web.service` now sets `ANCHOR_INTERVAL_SECONDS=900` (must match `pt-anchor.service`). Playwright e2e not run.

## T-030 investor passkeys (2026-10-13, branch `t-030-investor-passkeys`, not merged; migration 0024)

- Passkeys on the website (register/list/remove on `/account`, sign-in on `/login`), database-enforced sessions for every sign-in path, passkey step-up for offering reserve (from PKR 100,000) and cancel decided in SQL. ADR 0010 section 8.
- Up to date with main (0020-0023 merged in); after merging, `npm run migrate` before the website starts (pages read sessions from `webauth`).
- Passkeys are off on the plain-HTTP IP demo (the sign-in page says why). **Owner action:** domain + TLS, then `WEB_ORIGIN`, then `require_passkey` on. Demo personas still sign in without authentication.

## Latest update (2026-10-13, Step 6c merged)
## Latest update (2026-10-13, Step 6d built on a branch)

- **Step 6d (T-006) on branch `step-6d-trustee-portal`, not merged** (ADR 0011 section 12, migration `0023_trustee.sql`; merge the reserved 0020-0022 first, the backend runner refuses the gap). Trustee portal: register vs chain read model (pinned block, supply vs cap, differences, two-officer adjustments, SHA-256 export), co-signing (mints above the threshold now need a trustee officer in addition to the platform approvals, decided through the signing service; S-02 trustee votes), distribution review in the 48 h window (a rejection blocks booking and payout in SQL), daily reconciliation report, recovery requests (S-06 hook), trustee audit chain.
- 2026-10-22: main merged into the branch (0023 now on top of 0022); S-03 charges above the operations limit and calculation approvals now need the trustee (OP-21, D4). Lead-style check after merging main 1379147: backend typecheck/lint, `migrate -- --test` (0023 on top of 0022), vitest 656 passed + 13 skipped (chain not running); admin typecheck/lint, `npm test` 893/893, build, `test:http` 1048/1048; web typecheck/lint, 231 passed + 24 skipped.
- The demo catalogue seed (`seed:catalog`) now stops at every officer vote and lists it (K4 in PT Control; committee, P8 and non-trustee L3 votes have no screen yet).
- **Behaviour change on merge:** website mints above 10,000 tokens wait for a trustee officer's co-signature in the portal as well (demo: enrol a trustee officer).
- Owner to confirm: trustee co-signature threshold (above the platform threshold vs every mint), require a trustee approval before booking a distribution (S-03 Q-7), closing the command-line trustee duty.
## T-045 website functional (2026-10-22, branch `t-045-web-functional` merged up to main c55351d, not merged into main; migration 0022)

- Website shows records only: catalogue, filters/sort, Pakistan map, price/rent history, documents with SHA-256, trust structure, rule-based property score, payout accounts (bank service `bank:payees`), search and the grounded analyst (Claude optional, owner adds the key). Still labelled: passkey sign-in (T-030), Docs & Tax (S-03), anchoring status in the rail (lead).
- 0022 applies on top of S-06 (0020) and S-03 (0021). Demo catalogue (`seed:catalog`) runs only after an administrator enrols the demo officers in PT Control; until then it skips. Not seen in a browser; Playwright not run (see branch report).


## Latest update (2026-10-22, S-03 on a branch, brought up to date with main)

- **S-03 operations + FBR withholding (T-023/T-024) built on branch `s-03-operations-tax`, not merged** (migration `0021_operations_tax.sql`, applies on top of S-06's 0020; ADR 0014 Proposed: sealed CNIC for tax). Partial: see TASKS T-023/T-024 for what is not built. Tax rates are PLACEHOLDERS (LEGAL/TAX TO CONFIRM); approval of a distribution with them is refused unless `ops.settings.allow_placeholder_rates` (local dev only).

## Earlier update (2026-10-13, S-06 on branch `s-06-recovery`, not merged)

- **S-06 recovery / succession / reversals (T-026)** built on a branch: migration `0020_recovery.sql` (0021 is reserved for parallel work), signer kinds `recovery.*`, `@pt/recovery`, KYC re-verification, recon checks, portal `/recovery` with the new `legal_officer` role. Spec S-06 section 14 lists what is built and owner questions OQ-1..OQ-7 (notably: a lost custodial key cannot be recovered on chain with today's identities). Not run on Besu (48 h delay), no Playwright e2e; the website still shows the old wallet after a recovery (T-045).

## Earlier update (2026-10-13, Step 6c merged)

- **Step 6c (T-005) merged from branch `step-6c-compliance-portal`** (ADR 0011 section 11, migration `0019_compliance.sql`). Compliance portal: dashboard (counts, SLA breaches, recent decisions), KYC review queue (screenings open cases by themselves; high risk needs two compliance officers, enforced in SQL; PEP accepted only after EDD by two officers), sanctions/PEP results with re-screening run by the KYC service, freeze/unfreeze maker-checker (hold → KYC `suspended` → existing `compliance.freeze` policy; new signer kind `compliance.unfreeze`), STR case log (append-only notes, two-officer closure, export recorded before release, manual FMU filing). **Merge the reserved 0018 first** (no-gap rule; tests use `contiguousMigrations()`).
- Owner to confirm: investor wording for `suspended`/PEP (tipping-off), SLA values, PEP provider, goAML format.

## T-044 investor offering screens (2026-10-13, merged; migration 0018)

- Website: `/offerings`, `/offerings/[id]` (reserve with document acceptance; KYC-verified investors only), `/subscriptions` (timeline, payment instructions with countdown, refund status, cancel). Migration `0018_web_offering.sql` grants `pt_web` six `offering.web_*` functions only. Not built: withdrawal (OF-22) button, investor category choice (retail only), document download (no document store), notifications.
- Not verified in a browser (no seeded live offering in a shared database; see the branch report). Tests: see docs/TASKS.md T-044.

## Earlier update (2026-10-13, S-07, S-02, 6b and notifications merged)

- **Merged into `main`:** S-07 public `/verify` (live on the demo server), S-02 offering backend (`0015_offering.sql`), Step 6b approvals portal (`0016_admin_approvals.sql`) and T-028 notifications backend (`0017_notify.sql`, ADR 0013 Proposed). Migrations 0001–0017 apply cleanly.
- One cross-branch break fixed after the merges: the signer preview test fixture lacked S-02's `requireOfferingBatch` (d6789e9).
- **Tests on `main` (lead run, d6789e9):** backend 504/504 (60 files), admin 207 unit/DB, web 94 (unit + integration); typecheck and lint clean in all three.

## Earlier update (2026-10-13, Step 6b built on a branch)

- **Step 6b (T-004) built on a branch, not merged** (ADR 0011 section 10, migration `0016_admin_approvals.sql`). The approvals portal: inbox; signing requests shown as the exact call (decoded from the calldata, call hash) and decided by the **signing service** through a new admin-scoped HTTP client and one-time database tickets; payout batches (lines, held lines, gate, items digest); unfreeze request (maker) and decision (checker); S-01 maker-checker requests; a reason and a fresh security-key step-up on every decision; maker != checker enforced by the backend; officer names bound to officer sessions; S-01 duties linked to officer roles (S-01 refinement 10). **Merge S-02 (0015) first**: until then the backend runner refuses the gap (tests use a renumbered copy).
- Tests on the branch (0016 renumbered to 0015 locally for the run, not committed): backend 422 passed + 3 skipped (Anvil anchor stand-in not running) of 425 incl. 15 new; admin 207 unit/db (129 + 78 new) and 272 HTTP matrix (183 + 89 new); admin e2e 5/5 in Edge (3 + 2 new) with virtual FIDO2 keys and a real signing service.
- Demo server: unchanged exposure (SSH tunnel only); `update.sh` now also runs `npm run signer:admin-client` (idempotent, secret never printed).

## Earlier update (2026-10-13, after the 5h and 6a merges)

- **Step 5h merged** (c962432, ADR 0010): the website signs nothing and holds no key; reads come from the indexer read model; invest, DvP trades and sign-up go through outbox + signer (maker-checker above 10,000 tokens); web uses its own least-privilege DB role `pt_web_app`; `webdemo` DDL moved into migration 0012. Demo server: services pt-indexer, pt-signer, pt-kyc, pt-outbox, pt-offboarding active; **reconciliation PASSED on the demo server (0 blocking, 0 warnings, with indexer verify)**; signer audit intact.
- **Step 6a merged** (55d2c39, ADR 0011): `admin/` internal portal foundation (FIDO2-only officers, roles + SoD in the DB, audit viewer with evidence export, maker-checker officer management), migration 0013, 127.0.0.1:3300 only (SSH tunnel).
- **Tests on main after both merges:** backend 362/362 (with 0013: 361/362, the one failure was the load-sensitive signer p99 gate, now fixed under T-001); web 69/69; admin 129 unit/db + 183 authorization-matrix; contracts 137/137 (unchanged).
- **T-001 (partly):** the signer speed test now gates only the median in the unit suite; the full p50/p99 budget is `npm run perf:signer` (PT_PERF_GATES=1). Other timing checks listed in TASKS remain.
- **S-01 backend merged** (043ab74, T-021): `@pt/property` + migration 0014 (sponsor KYB, property state machine, duplicates, due diligence, maker-checker, audit). Backend 410/410 on main. Not yet in the portal (needs 6b screens) and DocumentRegistry anchoring needs a `document.add` signer kind.
- **Next:** S-07 public verification page (read-only), then S-02 offering, then 6b approvals portal.
- **T-027 / S-07 (branch `t-027-public-verification`, awaiting lead review):** public `/verify` page (EN + Urdu): supply/cap/pause/holder count as of the cursor block, DocumentRegistry list with a browser-only file hash check, anchor commitment recomputed in the browser, entitlement check in the browser and on chain. Labelled as not available (no fake data): trustee register attestation (Q-2), anchor records and reconciliation status (website role has no read grant: needs a migration), public anchor chain (L2 pending), `anchor:verify` result (not stored). Web tests 94/94 (69 before + 22 unit + 3 integration); e2e `verify.spec.ts` 6/6; full e2e 15/17 with both `market.spec.ts` tests failing identically on main's code on this machine at the same time (pool/connection timeouts under load; see the branch report).
- **S-02 backend built on branch `t-020-offering`** (T-020, not merged): migration `0015_offering.sql` (schema `offering` + additive bank amendment), `@pt/offering` (service, CLI `offering:*`), reconciliation amended (`issuance.paid_not_minted` SLA starts at the mint window; `offering.*` checks), signer `requireOfferingBatch`. ADR 0005/0007/0009 amendments; deviations in S-02 §16. Not built: completion payment batch (OF-45), returned refunds (OF-52), escrow per trust, investor and portal screens.
- **Next:** S-07 public verification page (read-only), then merge S-02 (0015), then 6b approvals portal.

- **Last audited commit:** `main` @ `41241b3` "test(signer): gate the speed test on the median on CI" (2026-10-13), 60 commits.
- **Audit date:** 2026-10-13.

## 1. Verified progress

| Area | State | Evidence |
|---|---|---|
| Contracts (Step 3) | Done internally; external audits pending | 137 forge tests pass (lead run 2026-10-13, incl. paused/frozen agent actions); Slither in CI |
| Local chain (Step 4) | Done | `chain/net.py`, `chain/flow.py` 50 checks |
| Backend 5a-5g | Done (mock providers, local anchor stand-in) | 13 packages, migrations 0001-0011 |
| Backend 5h | Parts 1-4 on `main` (held payouts, freeze and payout-record signer kinds, automatic offboarding, payout record through the outbox); rest **in progress on a branch** | commits 88d43cf, 246f2e9, 07d03b2 |
| Website prototype W1-W5 + v2 design | Done (demo); still on the demo signer | `web/`; `demo-signer.ts` used by 10 files |
| Internal portals (Step 6) | 6a **in progress on a branch**; 6b-6d not started | no `admin/` on `main` |
| Mobile app | Not started | no `mobile/` |
| Demo server | Live at `http://51.79.144.40` (Besu, PostgreSQL, web, console); deploys from `main` after CI | `deploy/demo-server/README.md` |

Feature-level detail: [FEATURE_INVENTORY.md](FEATURE_INVENTORY.md).

## 2. Test evidence (lead run, 2026-10-13, on `41241b3`)

| Suite | Result |
|---|---|
| contracts `forge test` | 137 / 137 pass |
| web `npm run typecheck` | OK |
| web `npm test` (vitest) | 67 / 67 pass (chain integration tests skip without a local chain) |
| backend `npm test` (vitest, 36 files) | 311 pass, **1 fail**: signer speed test p99 63 ms > 50 ms on a busy machine (p50 7 ms). Same gate failed CI #34 and #48 before the median-only CI change |
| web `npm run test:e2e` (Playwright, 11 tests) | Not run in this audit; not in CI |

Not re-run by the documentation audit itself (no `node_modules` in the audit worktree).

## 3. Branches in progress (do not duplicate)

| Work | Scope |
|---|---|
| Step 5h (remaining) | website onto outbox + signer + indexer read model; retire `web/src/lib/server/demo-signer.ts`; rent and mint journals so recon passes; demo-server services |
| Step 6a | new `admin/` app: internal portal foundation with WebAuthn, roles and separation of duties, audit viewer |
| T-020 (S-02 backend) | branch `t-020-offering`: migration `0015_offering.sql` (schema `offering`; bank amendment: cancelled payment codes, refunds of matched credits, trigger on `bank.credits`) and `@pt/offering`; recon and signer amendments. Needs 0014 (merged) |
| T-021 (S-01 backend) | merged (043ab74). Was branch `t-021-property-onboarding`: migration `0014_property.sql` (schema `property`) and `@pt/property` (sponsor KYB, property submission, duplicate detection, due diligence, IC, trustee acceptance; operator CLI `property:*`). Numbered 0014 after the 5h (0012) and 6a (0013) migrations: merge those first, or the runner refuses the numbering gap |

| T-004 (Step 6b) | branch with `admin/` approvals pages and API routes, migration `0016_admin_approvals.sql`, signer preview + officer decisions (`/v1/requests/preview`, `/v1/decide`, `npm run signer:admin-client`). Merge after S-02 (0015) |

| T-028 notifications (backend) | branch: migration `0017_notify.sql` (schema `notify`) and `@pt/notify` (sealed contacts, consent, EN/UR templates, delivery worker with record-before-send and provider lookup, mock providers, CLI `notify:*`), ADR 0013 Proposed. Numbered 0017 after S-02 (0015) and 6b (0016): merge those first. Producers not wired yet (list in TASKS T-028) |
| T-021 (S-01 backend) | branch `t-021-property-onboarding`: migration `0014_property.sql` (schema `property`) and `@pt/property` (sponsor KYB, property submission, duplicate detection, due diligence, IC, trustee acceptance; operator CLI `property:*`). Numbered 0014 after the 5h (0012) and 6a (0013) migrations: merge those first, or the runner refuses the numbering gap |

## 4. Blockers and owner decisions

- Owner decisions: which public L2 for anchoring; HSM/MPC vendor; real provider contracts (NADRA Verisys, liveness, sanctions/PEP, trustee bank Raast/payout API); GPL-3.0 legal review; retail investment limits; KYC 10-year retention confirmation; accepted-exceptions list for recon.
- Owner actions: GitHub branch protection, signed commits, Dependabot, secret scanning.

## 5. Known issues

| ID | Issue | Task |
|---|---|---|
| A4 | Timing assertions in unit tests fail under load (signer p99) | T-001 |
| A5 | Playwright e2e not in CI | T-011 |
| — | Reconciliation fails on the local chain by design until rent and mint journals are booked (`issuance.orphan_mint`, `rent.missing_ledger`) | T-002, T-022 |
| A1 | ADR 0001 names NestJS/Fastify and Redis; code uses plain `node:http` and PostgreSQL queues | T-010 |
| A2 | `webdemo` schema created by runtime DDL, outside migrations | T-008 |
| A3 | Web has its own mock KYC and ledger client next to `@pt/kyc` / `@pt/ledger` | T-009 |
| A6 | Status buried in long lines of MEMORY.md and README; README lists `admin/`, `mobile/` that do not exist | T-013 |
| — | Web connects to PostgreSQL as the admin user | T-012 |
| — | Website reads the chain directly in page loads (ADR 0001 read-path rule) | T-002 |
| — | Indexer, recon, anchor, signer, bank are not running on the demo server; no scheduler for recon/anchor:verify | T-034 |
| — | ADR 0007 and 0009 still "Proposed, awaiting lead review" after merge | T-015 |

## 6. Next recommended task

**T-001**: move tail-latency gates out of unit tests into bench scripts, so `npm test` is reliable before the 5h and 6a branches merge. Then reconcile the 5h and 6a branches (T-002, T-003).

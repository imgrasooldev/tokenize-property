# Current Status

Short handoff for the next session. Read this and [TASKS.md](TASKS.md) first; open other docs only when the task needs them.

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

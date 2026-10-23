# Decisions

Index of architecture decision records and other recorded decisions, as of `main` @ `41241b3` (2026-10-13). The ADR files in [decisions/](decisions/) are the source; this page only indexes them and flags drift. A reason that is not written anywhere is marked "undocumented".

## 1. ADR index

| ADR | Title | Status in file | Date | Implemented on `main`? |
|---|---|---|---|---|
| [0001](decisions/0001-stack.md) | Technology stack | Accepted (DB and queues amended by 0003) | 2026-10-08 | **Partly.** See §2 |
| [0002](decisions/0002-local-network.md) | Local Besu network and dev-only 60 s timelock on chain 586586 | Accepted | 2026-10-08 | Yes (`chain/`, `DeployLib`, `test_shortTimelockOnlyOnLocalDevChain`) |
| [0003](decisions/0003-backend-data.md) | PostgreSQL 18; queues in PostgreSQL, no Redis | Accepted (owner 2026-10-10) | 2026-10-10 | Yes |
| [0004](decisions/0004-outbox.md) | Outbox semantics, exactly-once on chain | Accepted (owner 2026-10-12) | 2026-10-12 | Yes (`0003_outbox.sql`, `@pt/outbox`) |
| [0005](decisions/0005-signing-service.md) | Signing service, policy engine, maker-checker | Accepted (owner 2026-10-12) | 2026-10-12 | Yes, local keystore only; HSM/MPC KeyProvider missing |
| [0006](decisions/0006-indexer.md) | Indexer and chain read model | Accepted (owner 2026-10-12) | 2026-10-12 | Yes; website does not read from it yet (5h) |
| [0007](decisions/0007-reconciliation.md) | Reconciliation and payout freeze | Accepted (2026-10-12; passing on the demo server 2026-10-13) | 2026-10-12 | Yes, merged 2026-10-12; status line not updated |
| [0008](decisions/0008-public-anchor.md) | Public-chain anchoring | Proposed (public L2 pending owner) | 2026-10-12 | Yes on a local Anvil stand-in |
| [0009](decisions/0009-kyc-and-bank.md) | KYC and bank | Accepted (real providers pending, T-031) | 2026-10-13 | Yes with mock providers; status line not updated |
| [0010](decisions/0010-website-integration.md) | Website on the read model, outbox and signing service; demo signer retired | Accepted | 2026-10-13 | Yes |
| [0011](decisions/0011-admin-portal.md) | Internal portals: FIDO2 officers, step-up, roles and SoD in the DB, audit | Accepted | 2026-10-13 | Yes |
| [0012](decisions/0012-server-stack-as-built.md) | Server stack as built (supersedes parts of 0001) | Accepted | 2026-10-13 | Yes |
| [0014](decisions/0014-sealed-cnic-for-tax.md) | Sealed CNIC for tax: tax-only key, ATL checks by the tax service, two-officer one-time FBR filing export | Proposed (S-03) | 2026-10-14 | On branch `s-03-operations-tax`; legal basis and FBR format to confirm |
| [0013](decisions/0013-notifications.md) | Notifications: sealed contacts, consent, record-before-send delivery with provider lookup | Proposed (T-028) | 2026-10-13 | On a branch, mock providers only; producers not wired |
| [0016](decisions/0016-service-database-roles.md) | One database role per backend service (pt_svc_* groups, pt_<service>_app logins, fail closed) | Proposed (T-012) | 2026-10-23 | On branch `t-012-service-roles` (migration 0029) |

## 2. ADR 0001 drift (resolved 2026-10-13 by [ADR 0012](decisions/0012-server-stack-as-built.md); kept for history)

| ADR 0001 says | `main` has | Status |
|---|---|---|
| API on NestJS with the Fastify adapter | Plain Node `node:http` servers (`signer/src/http.ts`, `bank/src/webhook.ts`, `demo-console/src/server.ts`) and Next.js server actions; no NestJS or Fastify dependency | Not implemented; no ADR records the change (A1, task T-010) |
| Cache/queues: Redis (BullMQ); reads with hot data in Redis | Queues in PostgreSQL; no Redis | Superseded by ADR 0003 (queues). The "hot data in Redis" read rule is not formally superseded |
| PostgreSQL 16 | PostgreSQL 18 | Superseded by ADR 0003 |
| Besu "runs on Java 21 without Docker" | Besu 26.9 needs Java 25 (portable JDK 25) | Superseded in practice by ADR 0002; ADR 0001 text stale |
| Writes return `202 Accepted` with a request id; live status over WebSocket or push | Web server actions run synchronously and redirect; live data via SSE (`/api/market/[symbol]/stream`) and polling (`/api/chain/pulse`) | Not implemented (undocumented) |
| The chain is never in the read path | Website pages read the chain directly through viem (`web/src/lib/server/*.ts`); backend services follow the rule | Not yet on `main`; Step 5h moves the website to the read model |
| Admin panel Next.js; investor app Flutter | Neither exists on `main` (6a admin is on a branch) | Not started |

## 3. Other recorded decisions (from MEMORY.md and docs)

| Date | Decision | Source |
|---|---|---|
| 2026-10-08 | Token standard ERC-3643 tag 4.1.3; T-REX 4.1.6 `CountryAllowModule` + `MaxBalanceModule` unchanged, in audit scope | contract-spec §1, §4.3 |
| 2026-10-08 | Guards are the only token agents; every owner is a 72 h TimelockController; Admin Safe 3-of-5; Trustee Safe can cancel | contract-spec §3 |
| 2026-10-08 | PKR only via banks/Raast; no stablecoins or on-chain payments | contract-spec §10 |
| 2026-10-08 | Max holding 10% of the register per identity; Pakistan (586) only until legal approves more | contract-spec §4.3 |
| 2026-10-08 | All-TypeScript server ("mix and match" rejected); Laravel rejected | ADR 0001 |
| 2026-10-08 | Security standards baseline (EthTrust [Q], ASVS L3, MASVS L2+R, CCSS III, SSDF, SLSA L3) | security-standards.md |
| 2026-10-10 | Website prototype before backend 5c-5h; EN + Urdu; demo market clearly labelled | MEMORY §10 |
| 2026-10-10 | Live Demo Console for team presentations | MEMORY §10 |
| 2026-10-10 | Demo market price band +-10% of NAV and demo liquidity | MEMORY §5 (W4) |
| 2026-10-10 | Unsigned PostgreSQL zip rejected; signed installer in extract-only mode | ADR 0003, backend/README |
| 2026-10-12 | Public anchor on an Ethereum L2; which L2 is open; build on Anvil stand-in meanwhile | ADR 0008, spec §11 |
| 2026-10-12 | Private demo server on a separate VPS, plain HTTP by IP, demo data only | MEMORY §8a, deploy/demo-server/README |
| 2026-10-12 | v2 design adopted for the website; `docs/design/` is read-only | MEMORY §3, §5 |
| 2026-10-12 | `eslint-config-next` dropped over a dependency advisory | web/README |
| 2026-10-13 | Payout accounts registered by the investor only (title match, 72 h cooling-off); assisted changes via two officers in Step 6 | ADR 0009 §"Decisions on the open questions" |
| 2026-10-13 | Held payouts: pay the rest, hold the share, follow-up batch later | ADR 0009, `0010_held_payouts.sql` |
| 2026-10-13 | KYC records kept 10 years after the relationship ends (legal to confirm); documents in a separate encrypted vault (vault not built) | ADR 0009 |
| 2026-10-13 | Timing tests gate on the median on CI; no hard p99 gates on CI | MEMORY §5, commit 41241b3 |
| undated | TypeScript pinned to 6.0.3 for typescript-eslint | MEMORY §5 |

## 4. Open decisions (owner)

From MEMORY.md §7 and §8: ERC-3643 GPL-3.0 legal review; which L2 for anchoring (then HSM/MPC KeyProvider); auditor rulings on single-key exceptions; retail investment limits; an "accepted exceptions" list for historical reconciliation differences; legal confirmation of 10-year KYC retention; bank file hash definition with the real bank; real provider contracts (NADRA Verisys, liveness, sanctions/PEP, trustee bank Raast and payout API); scheduling of `recon` and `anchor:verify` with alerting.

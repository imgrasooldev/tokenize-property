# Project Overview

- Audited commit: `main` @ `41241b3` (2026-10-13)
- Status labels used in this doc set: **Verified** (checked against code or a command), **Assumption** (reasonable but not proven by code), **Incomplete** (partly built), **Unknown** (cannot be determined from the repository).

## 1. Purpose

A permissioned platform for **fractional ownership of real estate in Pakistan**. Each property is held by an independent trustee (for example CDC) through a REIT or SPV under the SECP regulatory sandbox. Investors hold **ERC-3643 security tokens** that mirror the trustee's register. Money (subscriptions, rent) moves **only in PKR through banks and Raast**; smart contracts record ownership and entitlements and never hold money. (Verified: README.md, docs/contract-spec.md §1 and §10, no payment logic in `contracts/src`.)

Priorities set by the owner: safety on every layer first, response time second (MEMORY.md §1, §9).

## 2. Regulated context (Pakistan)

| Topic | What the repo says | Status |
|---|---|---|
| Regulator | SECP (REIT Regulations, regulatory sandbox); secondary trading needs SECP approval and a licensed intermediary | Assumption (legal position recorded in MEMORY.md §10 and web/README.md; no legal opinion in repo) |
| Money | PKR only via banks/Raast; no stablecoins, no on-chain payments | Verified (spec §10; `@pt/bank` books PKR paisa only) |
| Identity | NADRA Verisys, liveness, sanctions/PEP screening | Incomplete: interfaces with mocks only (`backend/packages/kyc/src/providers.ts`) |
| Allowed countries | Pakistan (ISO 586) only | Verified (`web/src/lib/server/onboarding.ts` `PAKISTAN = 586`; spec §4.3) |
| Max holding | 10% of the trustee register per identity | Verified (spec §4.3; `web/src/lib/invest-rules.ts`) |
| Tax | FBR withholding on rent | Missing (no code) |
| ERC-3643 licence | GPL-3.0, lawyer to confirm before mainnet | Open decision (ADR 0001, MEMORY §7) |

## 3. Scope

In the repository today (Verified):

- Solidity contracts: ERC-3643 suite (vendored T-REX 4.1.3) plus our guards and registries (`contracts/`).
- Local 4-validator Besu QBFT network and Python tooling (`chain/`).
- TypeScript backend workspace with 13 packages (`backend/packages/`).
- Investor website prototype, Next.js 16 (`web/`).
- Private IP demo server scripts and a GitHub Actions deploy (`deploy/demo-server/`, `.github/workflows/`).

Not in the repository on `main` (Verified absent): `admin/` (internal portals; Step 6a is on a branch), `mobile/` (Flutter app), any production infrastructure code.

## 4. Roles

| Role | Where it exists today |
|---|---|
| Investor | Web prototype (demo personas Alice/Bob, sign-up); `kyc.subjects` in backend |
| Trustee (Trustee Safe 2-of-3) | Contracts only (RecoveryGuard, DistributionRegistry reject, timelock canceller) |
| Admin Safe (3-of-5) via 72 h TimelockController | Contracts and `DeployLib.sol` |
| Issuance Safe, Ops Safe | Contracts; dev keys on the local chain |
| Pauser, Registrar, Claim issuer, Anchor key (hot keys) | Contracts; dev keys / encrypted dev keystores |
| Operators / officers (maker-checker) | Database roles and CLIs only (`signer:decide`, `recon:unfreeze`, KYC clearances, payout batch decisions); no UI yet (Step 6) |
| Property owner / sponsor | Missing |

Full actor table: [contract-spec.md §3](contract-spec.md). Database roles: [DATABASE_DESIGN.md](DATABASE_DESIGN.md#roles).

## 5. Core functions (one line each)

1. Investor onboarding with KYC and on-chain identity registration.
2. Subscription: payment, ledger entry, mint with a single-use `refId`.
3. Portfolio with reconciliation checks and rent entitlement self-verification (Merkle proof).
4. Rent distribution published on chain; payouts as maker-checker bank batches.
5. Three-way reconciliation (chain, ledger, bank) that freezes payouts on any blocking finding.
6. Hourly anchoring of the private chain and ledger head on a public chain (local stand-in today).
7. Compliance actions: freeze, automatic offboarding, recovery/forced transfer (contracts).
8. Demo-only secondary market with delivery versus payment.

Status of each feature: [FEATURE_INVENTORY.md](FEATURE_INVENTORY.md). Components: [ARCHITECTURE.md](ARCHITECTURE.md).

## 6. Documentation index

| Read when | Document |
|---|---|
| Starting any session | [CURRENT_STATUS.md](CURRENT_STATUS.md), [TASKS.md](TASKS.md) |
| Need feature status or evidence | [FEATURE_INVENTORY.md](FEATURE_INVENTORY.md) |
| Touching components, keys or deployment | [ARCHITECTURE.md](ARCHITECTURE.md) |
| Changing a business flow | [FLOW_DIAGRAMS.md](FLOW_DIAGRAMS.md) |
| Writing a migration or SQL | [DATABASE_DESIGN.md](DATABASE_DESIGN.md) |
| Changing an endpoint, action or webhook | [API_CONTRACTS.md](API_CONTRACTS.md) |
| Writing code or tests | [CODING_STANDARDS.md](CODING_STANDARDS.md) |
| Questioning a design choice | [DECISIONS.md](DECISIONS.md), [decisions/](decisions/) |
| History | [CHANGELOG.md](CHANGELOG.md) |
| Behaviour and security (sources of truth) | [contract-spec.md](contract-spec.md), [threat-model.md](threat-model.md), [security-standards.md](security-standards.md) |
| Target product list | [product-map.md](product-map.md) (build-order section is stale: says Step 3 "in progress") |
| Decisions, gotchas, owner log | [../MEMORY.md](../MEMORY.md) |

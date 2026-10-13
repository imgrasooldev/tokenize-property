# Property Token

A permissioned platform for fractional ownership of real estate in Pakistan. Each property is held by an independent trustee; investors hold ERC-3643 security tokens that mirror the trustee's register. Rent is paid in PKR through banks. Smart contracts record ownership and entitlements only and never hold money.

## Start here

- **Live demo for the team:** start Postgres and the chain, then `cd backend && npm run demo` and open http://127.0.0.1:4800 (see [backend/README.md](backend/README.md#live-demo-console)).
- [MEMORY.md](MEMORY.md): decisions, current status, findings, gotchas and next actions. Read this first.
- **Project docs:** [docs/CURRENT_STATUS.md](docs/CURRENT_STATUS.md) (short status), [docs/TASKS.md](docs/TASKS.md) (roadmap), [docs/PROJECT_OVERVIEW.md](docs/PROJECT_OVERVIEW.md) (index of architecture, flows, database, API, standards, decisions, changelog).
- **Setup and run:** chain [chain/README.md](chain/README.md#one-time-setup), backend [backend/README.md](backend/README.md#commands) (`npm ci --ignore-scripts`, `npm run migrate`, `npm run check`), website [web/README.md](web/README.md#run), contracts [MEMORY.md §6](MEMORY.md#6-how-to-work-on-the-code).
- [docs/Development-Lifecycle.pdf](docs/Development-Lifecycle.pdf): the complete lifecycle (phases, gates, standards, status). Regenerate with `python docs/tools/build_lifecycle_pdf.py`.

## Repository layout

| Folder | Contents |
|---|---|
| `docs/` | Specs, threat model, architecture decisions (`docs/decisions/`) |
| `contracts/` | Solidity contracts and Foundry tests |
| `chain/` | Local 4-validator Besu QBFT network: `net.py` (setup/start/stop/status), `flow.py` (end-to-end checks) |
| `backend/` | TypeScript workspace: config, logger, DB + migrations, typed ABIs; ledger, outbox, signing service, indexer (read model) |
| `admin/` | Internal portals "PT Control" (Next.js, 127.0.0.1:3300): officers sign in with FIDO2 hardware keys only; operations overview, audit trails with evidence export, officer management (maker-checker); see [admin/README.md](admin/README.md) and ADR 0011 |
| `mobile/` | Investor app (Flutter) |

## Development flow

Each step ends with a review. The next step starts only after approval.

| Step | Scope | Status |
|---|---|---|
| 1 | Repo setup, CI, stack decision | Done |
| 2 | Contract spec and threat model | Done (spec v0.3) |
| 3 | Smart contracts + unit, fuzz and invariant tests + Slither | Done (internal): 121 tests, 100% coverage, Slither clean, EthTrust [Q] self-assessment, deploy script verified on Anvil. External audits pending |
| 4 | Local chain: Anvil, then 4-node Besu QBFT | Done: 4-validator Besu 26.9 network (`chain/`), 50-check end-to-end flow on real blocks, validator outage tested |
| 5 | Backend: ledger, outbox, signing service, indexer, reconciliation | In progress: 5a foundation, 5b ledger, 5c outbox, 5d signing service, 5e indexer and 5f reconciliation done (see `backend/README.md`) |
| 6 | Internal portals (maker-checker) | In progress: 6a foundation (WebAuthn sign-in and step-up, roles with segregation of duties in the database, hash-chained admin audit, read-only operations overview and audit viewer, officer management) built; 6b approvals, 6c compliance, 6d trustee next |
| 7 | Flutter investor app | Not started |

## Security standards

The project follows recognised international standards, including EEA EthTrust [Q], OWASP ASVS L3, OWASP MASVS L2+R, CCSS Level III, NIST SSDF, SLSA L3, CIS Benchmarks and ISO 27001 / SOC 2. The full mapping, target levels and per-step gates are in [docs/security-standards.md](docs/security-standards.md).

## Ground rules

1. Spec first, then tests, then code.
2. No contract change after audit without a re-audit.
3. Every environment has its own keys. Production keys live only on hardware.
4. No secrets in the repo. Use `.env.example` for documented defaults.
5. All changes go through a pull request with two reviewers and green CI.

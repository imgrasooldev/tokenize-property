# Property Token

A permissioned platform for fractional ownership of real estate in Pakistan. Each property is held by an independent trustee; investors hold ERC-3643 security tokens that mirror the trustee's register. Rent is paid in PKR through banks. Smart contracts record ownership and entitlements only and never hold money.

## Repository layout

| Folder | Contents |
|---|---|
| `docs/` | Specs, threat model, architecture decisions (`docs/decisions/`) |
| `contracts/` | Solidity contracts and Foundry tests |
| `chain/` | Local Besu QBFT network config |
| `backend/` | API, ledger, indexer, signing service |
| `admin/` | Admin panel (Next.js) |
| `mobile/` | Investor app (Flutter) |

## Development flow

Each step ends with a review. The next step starts only after approval.

| Step | Scope | Status |
|---|---|---|
| 1 | Repo setup, CI, stack decision | Done |
| 2 | Contract spec and threat model | Done (v0.2) |
| 3 | Smart contracts + unit, fuzz and invariant tests + Slither | In progress: core built (105 tests, 100% coverage, Slither clean). Next: compliance modules, deploy script, EthTrust checklist |
| 4 | Local chain: Anvil, then 4-node Besu QBFT | Not started |
| 5 | Backend: ledger, outbox, signing service, indexer, reconciliation | Not started |
| 6 | Admin panel (maker-checker) | Not started |
| 7 | Flutter investor app | Not started |

## Security standards

The project follows recognised international standards, including EEA EthTrust [Q], OWASP ASVS L3, OWASP MASVS L2+R, CCSS Level III, NIST SSDF, SLSA L3, CIS Benchmarks and ISO 27001 / SOC 2. The full mapping, target levels and per-step gates are in [docs/security-standards.md](docs/security-standards.md).

## Ground rules

1. Spec first, then tests, then code.
2. No contract change after audit without a re-audit.
3. Every environment has its own keys. Production keys live only on hardware.
4. No secrets in the repo. Use `.env.example` for documented defaults.
5. All changes go through a pull request with two reviewers and green CI.

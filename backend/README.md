# Backend (Step 5)

TypeScript services that keep the books and talk to the chain: ledger, outbox, signing service, indexer, reconciliation. See [docs/decisions/0001-stack.md](../docs/decisions/0001-stack.md) and [0003](../docs/decisions/0003-backend-data.md).

## Status

| Sub-step | Scope | Status |
|---|---|---|
| 5a | Foundation: workspace, config, logger, DB pool + migration runner, typed ABIs, CI | Done |
| 5b | Ledger: double-entry, append-only, hash-chained | Next |
| 5c | Outbox + jobs in PostgreSQL, idempotency | Planned |
| 5d | Signing service + policy engine | Planned |
| 5e | Indexer → read model | Planned |
| 5f | Reconciliation (chain vs ledger vs bank) | Planned |
| 5g | KYC and bank/Raast mocks | Planned |
| 5h | Integration tests against PostgreSQL + Besu | Planned |

## Packages

| Package | Purpose |
|---|---|
| `@pt/config` | Validated configuration (zod). Fails fast, never echoes secret values; refuses the local dev chain ID and non-TLS DB in production |
| `@pt/logger` | pino with redaction of passwords, keys, tokens, CNIC, IBAN |
| `@pt/db` | Connection pool with statement/idle timeouts; migration runner with checksum (tamper) detection, advisory lock and per-migration transactions |
| `@pt/contracts` | Typed ABIs generated from `contracts/out` (CI fails on drift) |

## Local PostgreSQL 18

Portable binaries extracted from the **Authenticode-signed** EnterpriseDB installer (`postgresql-18.6-1-windows-x64.exe`, signer *EnterpriseDB Corporation*, DigiCert, SHA-256 `cae561e98d09f3f4a1a95759249240f86f66d71dcf33d14b6f7be894078401d1`) in extract-only mode: no Windows service, no system install. The unsigned EDB binaries zip was rejected because it cannot be verified.

```bash
python backend/scripts/pg.py setup    # once: cluster on 127.0.0.1:5433, scram-sha-256, data checksums
python backend/scripts/pg.py start | stop | status | psql
```

Admin password: `backend/.env.local` (git-ignored, generated). Cluster: `backend/data/pg` (git-ignored).

## Commands

```bash
cd backend
npm ci --ignore-scripts
npm run migrate            # property_token   (add -- --test for property_token_test)
npm run gen:abis           # after `forge build` in contracts/
npm run check              # typecheck + lint (0 warnings) + tests
```

## Supply-chain rules (`.npmrc`)

- Exact versions only (`save-exact`); the lockfile is committed and CI uses `npm ci`.
- Dependency install scripts are disabled (`ignore-scripts`).
- `npm audit --audit-level=high` runs in CI.
- TypeScript is pinned to 6.0.3: typescript-eslint does not support 7.x yet.

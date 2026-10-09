# Backend (Step 5)

TypeScript services that keep the books and talk to the chain: ledger, outbox, signing service, indexer, reconciliation. See [docs/decisions/0001-stack.md](../docs/decisions/0001-stack.md) and [0003](../docs/decisions/0003-backend-data.md).

## Status

| Sub-step | Scope | Status |
|---|---|---|
| 5a | Foundation: workspace, config, logger, DB pool + migration runner, typed ABIs, CI | Done |
| 5b | Ledger: double-entry, append-only, hash-chained | Done |
| 5c | Outbox + jobs in PostgreSQL, idempotency | Next |
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
| `@pt/ledger` | Typed access to the ledger (bigint amounts, typed errors). The rules themselves live in the database |
| `@pt/demo-console` | **Live Demo Console** for team presentations (local only) |

## Live Demo Console

```bash
python backend/scripts/pg.py start
python chain/net.py start
cd backend && npm run demo          # open http://127.0.0.1:4800
```

Shows, updating every 2 seconds: the 4 validators (with stop/start buttons to demonstrate fault tolerance), latest blocks, the token (supply vs trustee cap, paused state, investors with KYC and freeze status), on-chain events in plain language, and the ledger (hash-chain status, balances).

Buttons: **Run full scenario** (deploy + 50 on-chain checks, streamed live), **Rent cycle in ledger** (rent split by on-chain holdings, exact to the paisa, then an overpayment the database refuses), **Tamper test** (rogue-DBA change in a throw-away database, caught by the hash chain).

Local-only hardening: binds 127.0.0.1; rejects foreign Host headers (DNS rebinding) with 403; actions need same-origin plus a per-run token (CSRF) or get 403; strict CSP with nonces, `X-Frame-Options: DENY`, `nosniff`, `no-referrer`; all on-chain text rendered with `textContent` (no HTML injection); private keys never leave the server. It is a presentation tool, never deployed.

## Ledger guarantees (migration `0002_ledger.sql`)

Enforced by PostgreSQL, so a bug in a service cannot break them:

| ID | Guarantee | Test |
|---|---|---|
| L-1 | Every journal balances to zero per asset (PKR paisa, token units) | `L-1 double entry` |
| L-2 | No UPDATE, DELETE or TRUNCATE, even for the admin (triggers) | `blocks UPDATE, DELETE and TRUNCATE` |
| L-3 | Service roles cannot touch tables; writes only via validated `SECURITY DEFINER` functions | `writer role ... only the validated functions` |
| L-4 | SHA-256 hash chain over every journal and its postings; `verify_chain()` finds tampering | `detects a change made by ... a rogue DBA` |
| L-5 | Idempotency: identical retry returns the same journal; a different payload is refused | `L-5 idempotency` |
| L-6 | Protected accounts cannot be overdrawn (no overpaying an investor) | `L-6 no overdraft` |

Writes are serialised by an advisory lock to keep the chain linear (tested with 30 concurrent writers). A superuser can still disable triggers; that is why the chain head will be anchored on-chain (Step 5f) and production DBA access is separated and audited.

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

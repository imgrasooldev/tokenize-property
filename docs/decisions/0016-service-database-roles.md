# ADR 0016: One database role per backend service

- Status: Proposed (lead review)
- Date: 2026-10-23
- Task: T-012 (with T-011 on the same branch `t-012-service-roles`)
- Code: `backend/packages/db/migrations/0029_service_roles.sql`, `backend/packages/config/src/index.ts` (`SERVICE_DB_ROLES`, `serviceDbLogin`), `backend/packages/db/src/service-roles*.ts` (`npm run db:service-roles`), `deploy/demo-server/db-login.sh`

## Context

Every migration since 0002 created per-domain NOLOGIN roles (`pt_chain_writer`, `pt_signer`, `pt_outbox_worker`, `pt_kyc_service`, ...) with API-only grants, and revoked everything from PUBLIC. But only the website (`pt_web_app`, 0012) and the admin portal (`pt_admin_portal`, 0013) actually connected with a restricted login. Every backend service connected as `pt_admin`, the schema owner, which can disable triggers, rewrite history and read every sealed field. A bug or a compromised dependency in any service therefore had the full database. Several CLIs read optional `<SERVICE>_PG_USER` variables but fell back to the admin silently, and nothing created those logins.

## Decision

1. **One NOLOGIN group per service process**, `pt_svc_<service>`, created by migration 0029: indexer, signer, outbox, kyc, offboarding, bank, anchor, recon, recovery, tax, notify, exit, transfer, audit (read-only audit-chain checks) and console (demo console ledger panel). A group is composed by membership (`WITH INHERIT TRUE, SET FALSE`) from the existing domain roles, plus direct grants only where the code needed something they lacked (outbox worker: `SELECT outbox.commands`; reconciliation: column-level reads of `webdemo.subscriptions`, `webdemo.investors` and `bank.payout_batches`; offboarding: `kyc.enqueue_offboarding` only; exit tick: `exit.tick` only instead of the whole `pt_exit_operator`). Existing roles are not widened.
2. **One LOGIN per service**, `pt_<service>_app`, created outside migrations by `npm run db:service-roles` (pattern of `db:web-role`): password generated once and appended to the git-ignored `backend/.env.local` as `<PREFIX>_PG_USER` / `<PREFIX>_PG_PASSWORD`, never printed; `NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 30`, member of its group only (other memberships revoked on every run); the command checks that every login connects.
3. **Fail closed in code** (`serviceDbLogin` in `@pt/config`): a service uses its own login; without one it refuses to start, except on a loopback database outside production when `PT_DB_ADMIN_FALLBACK=1` says so explicitly (local development). It never connects to a non-local database as the admin, and refuses a service login named like the admin.
4. **Operator and setup commands keep the admin login** (migrate, `*:setup`, `signer:decide`, `signer:import-web-wallets`, `recon:import-bank|register-account|unfreeze`, `ops:run`, `tax:atl|enrol-cnic|...`, `exit:run`, `recovery:audit`, `transfer:audit`, `notify:status`, `indexer:reset-local`, seeds and demo bookings): they are deploy-time or break-glass tools whose duties belong in PT Control; each will move to an operator role when its screen exists.
5. **Reviewed privilege inventory**: `backend/packages/db/test/service-roles/<service>.txt` lists everything each group may do (schemas, tables with privileges, executable functions, including via PUBLIC). Any migration that widens a service role changes that file and the test fails until it is reviewed and updated (`vitest -u`).

## Consequences

- A compromised service can only do what its code does: e.g. the indexer cannot read the ledger or KYC, the signer cannot decide its own requests or write the outbox, the outbox worker cannot enqueue or decide, the anchor job cannot change anchors except through its API.
- Found by running the services' own test suites under these roles: the outbox worker could not re-read its command after an executor error (42501 would have left the command waiting for its lease); a reconciliation run as `pt_recon_writer` alone ended in `error` (it reads `webdemo` and `bank.payout_batches`); the bank processes' startup probes read tables the bank role may not read (changed to `bank.payee_status`). The comments in the CLIs ("in production a login role in pt_recon_writer") had never been tried.
- Developers run `npm run db:service-roles` once after `npm run migrate` (or set `PT_DB_ADMIN_FALLBACK=1` for a quick local run). `web/test/stack.ts` runs it, so web integration tests and e2e run the services under their roles.
- Rollback on the demo server is per unit (`deploy/demo-server/db-login.sh admin <unit>`: a systemd drop-in that blanks the login and sets the fallback flag), never a code rollback (the migration runner refuses a missing applied migration).
- Production adds TLS (`PG_SSL=require`) and secret storage outside files (owner decision with the KMS/HSM work); the role model stays.

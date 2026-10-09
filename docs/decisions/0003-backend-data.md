# ADR 0003: PostgreSQL 18, and queues in PostgreSQL instead of Redis

- Status: Accepted (owner approved 2026-10-10)
- Date: 2026-10-10
- Amends: ADR 0001 (PostgreSQL 16; Redis/BullMQ for queues)

## Context

ADR 0001 named PostgreSQL 16 and Redis (BullMQ). When Step 5 started:

- PostgreSQL 18 is the current major (18.6), supported until November 2030; 16 ends November 2028.
- The only Redis on the development machine is Laragon's Redis 5.0.14, an old, unmaintained Windows port without current security fixes.
- The outbox pattern already requires the command record to be written in the same database transaction as the business change.

## Decision

1. **PostgreSQL 18** for all environments.
2. **Queues and jobs live in PostgreSQL** (outbox tables consumed with `FOR UPDATE SKIP LOCKED`). The business write, the ledger entry and the outbox command commit or roll back together; there is no window where one exists without the other.
3. Redis is not used in Step 5. Read caching, if profiling shows it is needed, will use a maintained **Valkey 8 / Redis 7+** on Linux in production, behind the read model, never as a source of truth.
4. Local PostgreSQL binaries must be verifiable: extracted from the Authenticode-signed EnterpriseDB installer (extract-only, no service). Unsigned binary archives are not used.

## Consequences

- One fewer moving part to secure, monitor and back up.
- Queue throughput is bounded by PostgreSQL; ample for issuance, payouts and indexing volumes. Revisit if a measured bottleneck appears.
- Production PostgreSQL connections must use TLS (`PG_SSL=require`, enforced by `@pt/config`).

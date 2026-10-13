# ADR 0012: Server stack as built

- Status: Accepted (lead, 2026-10-13, task T-010; records what is on `main` and why)
- Date: 2026-10-13
- Supersedes: the API, cache/queue, runtime and write-path rows of [ADR 0001](0001-stack.md). The architecture rule of ADR 0001 (the chain is never in the read path) stands.

## Context

ADR 0001 (2026-10-08) planned NestJS on Fastify for the API, Redis/BullMQ for hot reads and queues, PostgreSQL 16, Besu on Java 21, and writes that return `202 Accepted` with live status over WebSocket. Steps 5a–5h and 6a were built differently, for reasons recorded in later ADRs or found during the work. The 2026-10-13 code audit (finding A1, [DECISIONS.md](../DECISIONS.md) §2) showed that nothing records the change. This ADR does.

## Decision

| Concern | As built | Why | Where decided |
|---|---|---|---|
| Internal services | Small TypeScript services on plain `node:http`: signing service, KYC API, bank webhook, demo console | Each service has 2–6 routes. A framework adds dependencies and attack surface without adding a control we need. Authentication is our own HMAC scheme with per-client scopes and replay protection (`@pt/http-auth`) | ADR 0005, ADR 0010 |
| Public website and internal portals | Next.js (App Router) with server actions and route handlers; CSP with a nonce per request; reads from the PostgreSQL read model | Same language and types as the backend; server actions keep keys and business rules on the server | ADR 0010, ADR 0011 |
| Queues and jobs | PostgreSQL: the outbox (`FOR UPDATE SKIP LOCKED` leases, LISTEN/NOTIFY), exactly-once per command | One store to back up and reconcile; the command commits in the same transaction as the ledger entry | ADR 0003, ADR 0004 |
| Cache | No Redis. Reads come from the indexer's read model (p95 1–6 ms measured), plus small in-process caches (for example the chain pulse, one shared value per second) | The read model meets the ADR 0001 target (p95 < 100 ms) without a second store. Revisit only if profiling shows a need; then a maintained Valkey/Redis 7+ behind the read model, never as a source of truth | ADR 0003, ADR 0006 |
| Database | PostgreSQL 18; rules enforced in SQL (append-only triggers, hash chains, state machines, maker-checker, least-privilege roles per service) | Rules hold even if application code is wrong | ADR 0003 and later |
| Private chain runtime | Hyperledger Besu 26.9 on Java 25 | Besu 26.9 requires Java 25 | ADR 0002 |
| Write path | Server action → ledger entry + outbox command in one transaction → outbox worker → signing service (policy, maker-checker) → chain → indexer → website shows the result. The UI shows "pending" until the read model has the event. Live data: Server-Sent Events (market) and short polling (pulse), not WebSocket | Same safety as ADR 0001's 202 pattern (nothing waits on the chain inside a request); SSE and polling pass through the CSP and nginx without extra infrastructure | ADR 0004, ADR 0010 |
| Chain in the read path | Website reads come from the read model since Step 5h. Direct chain reads remain only where a fresh on-chain check is the point (rent self-verification, refund proofs, onboarding identity lookup, the network status rail) | Keeps ADR 0001's rule; the exceptions are verifications, not page data | ADR 0010 |

## Consequences

- There is no API gateway yet. Internal services bind to 127.0.0.1 and authenticate every call. A gateway (rate limits, mTLS between services) is part of the production hardening in [OPERATIONS.md](../OPERATIONS.md).
- Each `node:http` service carries its own small router and must keep its tests for authentication, scopes, body limits and error formats (see `docs/API_CONTRACTS.md`).
- The Flutter investor app (ADR 0001) is still planned (task T-040).
- If a service grows past a handful of routes, prefer extracting shared middleware into a package over adopting a framework. Any framework needs a new ADR.

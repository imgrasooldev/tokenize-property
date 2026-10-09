# ADR 0001: Technology stack

- Status: Accepted (database and queue choices amended by ADR 0003)
- Date: 2026-10-08

## Context

Two requirements drive this decision:

1. **Safety first.** Ownership records and investor money must survive any single failure.
2. **Response time is a top product requirement.** The investor app and admin panel must feel instant.

The trap with blockchain apps is putting the chain in the request path. A chain call is slow (RPC round trip, block time, confirmation). So fast responses come from the *architecture*, not only from the language.

## Decision

### Architecture rule: the chain is never in the read path

- **Reads** are served from a PostgreSQL read model, with hot data in Redis. An **indexer** follows chain events and keeps the read model up to date. Target: p95 under 100 ms for all read endpoints.
- **Writes** (invest, transfer, payout) return `202 Accepted` with a request ID straight away. The work goes through an outbox to the signing service and then to the chain. The client gets live status over WebSocket or push notification.
- The chain is Besu with QBFT consensus: about 2 s blocks with **immediate finality** (no re-orgs), so "confirmed" really means confirmed.

### Components

| Component | Choice | Why |
|---|---|---|
| Smart contracts | Solidity 0.8.x + Foundry; ERC-3643 (T-REX) reference implementation | Audited standard for permissioned security tokens; Foundry gives fast fuzz and invariant testing |
| Chain (private) | Hyperledger Besu, QBFT, 4 validators run by separate organisations | Permissioned, instant finality; runs on Java 21 without Docker |
| Public anchor | Hourly state-hash anchor on a public EVM chain | Tamper evidence for the private chain |
| API | NestJS on the **Fastify** adapter (TypeScript) | Fastify has much higher throughput than Express; NestJS gives structure, DI and guards for a security-heavy codebase |
| Chain access | viem | Typed, fast, well maintained |
| Signing service | Separate TypeScript service, own process and network zone; HSM/MPC in production | Keys never live in the API process |
| Indexer | Separate TypeScript worker | Keeps chain reading out of the request path |
| Database | PostgreSQL 16 | Strict constraints, row-level security, triggers to enforce append-only ledger |
| Cache / queues | Redis (BullMQ) | Hot reads and job queues |
| Admin panel | Next.js | Same language and shared types with the API |
| Investor app | Flutter (Android + iOS) | Team already uses Flutter |

### Why one language (TypeScript) on the server instead of "mix and match"

Every extra language adds a separate toolchain, dependency tree and set of security pitfalls to audit. TypeScript across API, signer, indexer and admin means:

- one set of shared, typed contract bindings, so encoding mistakes are caught at compile time;
- one dependency-audit pipeline;
- any engineer can review any service.

Performance comes from the read-model architecture above, not from switching languages. If profiling ever shows a real hotspot, that single service can be rewritten (for example in Go) without changing the rest.

### Why not Laravel

The team knows Laravel well, and it remains a good choice for the POS products. Here, the blockchain tooling (viem, typed ABIs, T-REX scripts) is TypeScript-native, and PHP's per-request model fits worse with long-lived WebSocket and chain-subscription workers.

## Consequences

- The team needs TypeScript/NestJS skills. Budget for ramp-up.
- The read model can lag the chain by about one block. The UI shows "pending" until the indexer confirms.
- PostgreSQL must be installed locally (currently only MySQL is available via Laragon).

## Open questions

- T-REX is licensed **GPL-3.0**. A lawyer must confirm this is acceptable for our deployment and distribution model before mainnet.

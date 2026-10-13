# ADR 0004: Outbox semantics and exactly-once execution on chain

- Status: Accepted (owner approved the Step 5c plan 2026-10-12)
- Date: 2026-10-12
- Builds on: ADR 0001 (writes go through an outbox), ADR 0003 (queues in PostgreSQL)

## Context

Every chain write (mint, burn, transfer, freeze, rent publication) is caused by a business change that is also recorded in the ledger. Two things must never happen:

1. The ledger changes without the chain command, or the other way round.
2. A command executes on chain twice, or is retried while an earlier attempt might still be mined.

Networks, nodes and processes fail at any moment, including between "signed", "broadcast" and "mined". The investor website prototype (W3–W5) showed which failure points matter and how to handle them. An independent review confirmed the approach: record the transaction before broadcasting, then decide from the chain. This ADR makes that the backend's single, tested mechanism.

## Decision

**Data and atomicity.** Commands live in `outbox.commands`. The service enqueues with `outbox.enqueue`, inside the same database transaction as the ledger journal and business rows (O-1). Enqueue is idempotent per key; a different command under the same key is refused (O-2). What a command does (kind, payload, key, reference) can never change, and rows are never deleted (O-3). Every change is written to `outbox.command_events`, which is append-only (O-7).

**States.** `pending → claimed → submitted → confirmed`, with `failed` and `review` as exits. Allowed edges are enforced by a trigger. `confirmed` and `failed` are final (O-4).

**Leases.** Workers take commands with `FOR UPDATE SKIP LOCKED` and hold a time-limited lease. A `claimed` command whose lease expires goes back to `pending`. This is safe because a claimed command has recorded nothing, so it has sent nothing. A `submitted` command whose lease expires is re-leased for resolution only, never re-executed.

**Record before broadcast (O-5).** The executor signs the transaction and calls `outbox.record_submission(hash, nonce, sender)`. It broadcasts only if that call succeeds. The database accepts the record only from the current lease owner, before the lease expires, while the command is `claimed`. Therefore:

- At most one transaction per attempt can be broadcast.
- A worker that lost its lease can no longer record, and must not broadcast.
- "Nothing recorded" proves "nothing sent".

**Deciding after any failure.** The worker never trusts the error type. It reads the database state:

- **Still `claimed`:** nothing was sent. It is retried with exponential backoff (2^attempts seconds, at most 5 minutes). It goes to `failed` if the refusal is permanent, or to `review` when out of attempts.
- **`submitted`:** the chain decides from the recorded transaction:

| Chain says | Meaning | Outbox does |
|---|---|---|
| receipt, success | executed | `confirmed` |
| receipt, reverted | will never execute | `failed` (the hash is kept as evidence) |
| no receipt, and the sender's mined nonce is past the recorded nonce | dropped: another transaction used the nonce, so this one can never be mined | transaction cleared (O-6), back to `pending`, signed again with a new nonce |
| still in the pool, or unknown | not decided yet | wait; after `reviewAfterMs` → `review` |

**Nonces.** Nonce selection, signing and broadcast happen under a per-signer advisory lock in the `postgres` database. Every process shares that lock: website, workers, demo script and tests.

**Operations.** `review` is resolved only by `outbox.operator_decide`, which needs a reason of at least 10 characters and is recorded with the operator's name:

- **retry:** allowed only when no transaction is recorded, because a recorded one might still be mined.
- **confirm:** needs a recorded transaction, as evidence.
- **fail:** no extra condition.

**Roles.** These are separate database roles, with no direct table writes for any of them:

| Role | Can |
|---|---|
| `pt_outbox_writer` | enqueue |
| `pt_outbox_worker` | claim, record, complete, release, resolve |
| `pt_outbox_operator` | decide on commands in review |
| `pt_outbox_reader` | read |

**Latency.** `pg_notify` fires at commit, so an aborted business change never wakes a worker. Workers `LISTEN` and also poll as a fallback. Measured: a new command is picked up immediately, not on the next poll.

## Why this gives exactly-once on chain

A command's effect reaches the chain only through a mined transaction. Each mined transaction has to be recorded first (O-5).

- **While a recorded transaction might still be mined,** the command cannot move back to `pending`. That edge exists only for proven drops (O-6). Operators also cannot retry it.
- **A proven drop is permanent.** The sender's mined nonce has passed the recorded transaction's nonce, so it can never be mined.

Together, these mean at most one transaction per command is ever successful. The worker tests check this as a property over random fault sequences: refusals, transient errors, crashes before recording, after recording and after broadcasting, reverts, and one to three concurrent workers. A deliberately broken worker (retry without checking the database) is caught immediately, with the minimal counterexample "crash after broadcast".

Contract-level guards add a second line of defence where they exist. For example, `IssuanceGuard` accepts each `refId` once (I-11), so a duplicate mint command is refused by simulation before anything is sent.

## Consequences

- Services never call the chain directly; they enqueue. Step 5d's signing service is an `Executor`, and the policy engine and maker-checker sit in front of signing.
- The website prototype used its own inline version of the same rules until Step 5h; it is now on the outbox (below).
- The local executor (`@pt/outbox/local-executor`) signs with dev keys on chain 586586 only and refuses production.
- **Step 5h:** the website enqueues its mints, DvP deliveries and onboarding steps here, in the same transaction as its ledger entries, and settles only from final command states (`confirmed` with a matching event in the read model; `failed` with a chain proof before any refund; never while in `review`). One worker process (`npm run outbox`) executes every kind through the signing service ([ADR 0010](0010-website-integration.md)).

# ADR 0006: Indexer and the chain read model

- Status: Proposed (Step 5e plan approved by the owner 2026-10-12; implementation awaiting review)
- Date: 2026-10-12
- Builds on: ADR 0001 (the chain is never in the read path), ADR 0003 (PostgreSQL 18), ADR 0004 (exactly-once)
- Addresses: threat D-3 "read model drifts from chain"

## Context

Services and portals must answer "who holds what" in well under 100 ms (p95), so they read PostgreSQL, never the chain (ADR 0001). The read model must therefore be exactly what the chain says:

- nothing missing, nothing counted twice, whatever crashes, retries or restarts happen;
- never silently built on a chain that is not the one indexed before.

Besu QBFT has **immediate finality**: a block, once produced, never changes. A different hash at a known height is never a normal re-org. It means the node serves a different chain: a reset network, a wrong or corrupted node, or an attack. So the indexer never "re-orgs around" a mismatch. It stops.

## Decision

**Package `@pt/indexer`**, a separate TypeScript worker (viem), and **migration `0005_indexer.sql`** (schema `chain`).

**Reading.**
- Logs of the deployment's contracts are read in windows of at most **4,000 blocks**: Besu refuses `eth_getLogs` over 5,000 (MEMORY gotcha).
- A window with more than 5,000 logs is halved until it fits, to keep transactions short.
- Every header in the window is read (JSON-RPC batches of 100). Each one must name the previous one as parent. The first must name the cursor block.
- Every log must carry the hash of its block's header and must not be `removed`.
- Logs are decoded with the ABIs in `@pt/contracts`, routed by contract role (the token's `Paused` and PauseGuard's `Paused` differ). A log that matches no ABI is kept raw (`name` NULL), never dropped.

**Writing: one transaction per batch (C-1).**
- `chain.apply_batch` stores the raw events, the derived tables and the cursor in one call.
- The cursor moves by compare-and-set: a batch that does not start exactly at cursor + 1 is refused (`PTC01`).
- So a retry after a crash before or after COMMIT, or two indexers racing, can never apply a batch twice.
- Writes go only through `SECURITY DEFINER` functions. Roles:
  - `pt_chain_writer`: `register_deployment`, `apply_batch`, `halt`.
  - `pt_chain_reader`: SELECT only.

**Rules enforced by the database.**

| Rule | What it guarantees |
|---|---|
| C-1 | Raw events, derived tables and cursor commit together; the cursor moves by compare-and-set |
| C-2 | The first block of a batch links to the cursor block. A block number is never stored with two hashes. Every event sits on a stored block with the same hash |
| C-3 | Blocks, events, transfers, issuances, freeze actions and the halt history are append-only. Derived rows are never deleted. Nothing is truncated |
| C-4 | No direct table writes for service roles |
| C-5 | Contract invariants are re-checked while deriving. Balances, supply and frozen amounts never go negative. A refId is used once (I-11). A distribution moves only published → rejected, or published → finalized → paid (I-14). A recovery request closes once (I-13). A document is added once and superseded once (I-15) |
| C-6 | A halted deployment refuses every batch. Only an administrator clears a halt (`chain.clear_halt`, granted to nobody, reason of at least 10 characters, recorded) |
| C-7 | `NOTIFY chain_events` fires at commit only, for consumers that come later |

**Fail closed.** The indexer halts on any of these:
- a parent-hash, block-hash or chain-ID mismatch (`ChainMismatchError`, `PTC02`);
- an invariant violation, or any other deterministic data error (`InvariantViolationError`, `PTC03`, SQLSTATE 22/23).

Halting means:
1. The reason is recorded in `chain.cursors` and `chain.halts`.
2. `NOTIFY chain_alert` fires.
3. `onHalt` is called; the CLI logs a fatal error and exits with code 3.

While idle at the head, the indexer re-reads the cursor block, so a replaced chain is noticed without waiting for new blocks. Transient errors (RPC, connection) roll back and retry with backoff (up to 30 s).

One follower per deployment: a session advisory lock refuses a second one. The compare-and-set makes a second one harmless anyway.

**Read tables.**

| Table | Contents |
|---|---|
| `tokens` | Supply, trustee cap, paused, pause reason |
| `holdings` | Balance per holder |
| `transfers` | Every transfer: mint, burn or transfer |
| `issuances` | One row per refId |
| `freezes` | Address freeze and partial freezes per holder |
| `freeze_actions` | Every freeze action, with its case ID |
| `distributions` | Root, total, statement hash, status, reject reason, payout hash |
| `documents` | Documents, including which document superseded which |
| `recoveries` | Recovery requests |
| `investors` | Identity registry: wallet, identity, country, registered |

Not derived: timelock, ID factory and ownership events. They stay in `events`.

`StateAnchor` lives on the public chain and is out of scope here.

Two derivation details:
- **Registration order.** RegistrarGuard emits `InvestorRegistered` *before* it calls the identity registry. That event only records the country; `IdentityRegistered` marks the wallet registered. This was found on the real chain.
- **IdentityUpdated.** The event does not name the wallet. If the old identity belongs to more than one wallet, those rows are marked `identity_stale` instead of guessing.

Stored blocks: the first and last block of each batch, plus every block with an event. Every header is still checked in between. The cursor links consecutive batches. This keeps `chain.blocks` small: about 1.5 GB per year if every 2-second block were stored.

**Verification (`npm run indexer:verify`, read-only).**
1. Takes a REPEATABLE READ snapshot of the read model and pins its cursor block P.
2. Re-reads every header and log from the deployment block to P and re-checks the links.
3. Folds the events through an **independent in-memory implementation** of the derivation rules (`ReadModel`). It compares every table, plus SHA-256 digests of all events, transfers and freeze actions.
4. Reads the contracts' own view functions **at block P** and compares them with the read model:
   - token: `balanceOf`, `isFrozen` and `getFrozenTokens` of every holder, `totalSupply`, `paused`, `trusteeCap`;
   - I-1: the sum of all balances equals the total supply;
   - distribution, document and recovery counts and records;
   - registered identities and countries.

Any difference is reported and the CLI exits with code 1. Verify does not halt the indexer; alerting decides.

Why a second implementation and not a rebuild into a temporary schema? A rebuild with the same SQL would reproduce a bug in that SQL. Two implementations that must agree catch a bug in either one. The property test uses the same `ReadModel` as its oracle.

**Deployments.**
- A deployment is read from the DeployLib broadcast (`contracts/broadcast/Deploy.s.sol/586586/run-latest.json`), or from `INDEXER_DEPLOYMENT_FILE`.
- It is registered once. Re-registering with different addresses, start block or chain is refused.
- One database follows one network.
- After `python chain/net.py reset`, run `npm run indexer:reset-local -- --yes`. This works for chain 586586 outside production only.

## Measured (this laptop, local Besu, 2026-10-12)

| What | Result |
|---|---|
| Catch-up on the real chain (41,011 blocks, 537 events, 11 batches) | 8.9 s = **4,595 blocks/s**; another run 14.6 s = 2,743 blocks/s. Header checks dominate (about 1 s per 4,000 headers) |
| `verify` on the real chain (rebuild + 164 contract reads) | 10.5 s |
| Reads on the real chain, p50 / p95 / p99 | holders 1.4 / 3.8 / 7.9 ms; portfolio 1.2 / 2.2 / 5.1 ms; transfers 2.1 / 4.1 / 4.9 ms; distributions 0.7 / 1.2 / 1.7 ms |
| Synthetic apply (`npm run indexer:bench`) | 22,050 events: about 1,030 events/s; 110,050 events: 620–680 events/s |
| Synthetic reads, 110,050 events and 10,000 holders, p95 | top-50 holders 17–20 ms (one earlier run 106 ms, not reproduced); portfolio 2.2–2.5 ms; transfers 6–10 ms; distributions 4–7 ms |

Reads on the real chain are far below the p95 < 100 ms target. Top-holders over 10,000 holders is the slowest query and once measured above it on this laptop, so watch it as holder counts grow. Apply throughput is per event in PL/pgSQL. It is ample for a 2-second chain, but a full rebuild of millions of events would take tens of minutes. If that ever matters, the token derivation can become set-based (running sums with window functions), keeping the same checks.

Found while measuring: PostgreSQL's regex engine takes about 50 µs per match for counted repetition such as `^0x[0-9a-f]{64}$`. The hex checks therefore use `length(x) = 66 AND x ~ '^0x[0-9a-f]+$'`, which made writes about 4.5x faster.

## Consequences

- Reads move to `chain.*` via `@pt/indexer` queries (Step 5h moves the website). The UI shows "pending" for anything newer than the cursor.
- Production runs the indexer as a login role in `pt_chain_writer`; verify and portals use `pt_chain_reader`.
- Production also needs: a daily `indexer:verify` with alerting, `chain_alert` wired to on-call, and an operator runbook for halts. The usual answer to a halt is a rebuild into a fresh database after the cause is found, not clearing the halt.
- Besu with Bonsai storage keeps recent state only. `verify` reads state at the pinned cursor block, so run it while the indexer is near the head.

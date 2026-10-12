# Backend (Step 5)

TypeScript services that keep the books and talk to the chain: ledger, outbox, signing service, indexer, reconciliation. See [docs/decisions/0001-stack.md](../docs/decisions/0001-stack.md), [0003](../docs/decisions/0003-backend-data.md), [0004](../docs/decisions/0004-outbox.md), [0005](../docs/decisions/0005-signing-service.md) and [0006](../docs/decisions/0006-indexer.md).

## Status

| Sub-step | Scope | Status |
|---|---|---|
| 5a | Foundation: workspace, config, logger, DB pool + migration runner, typed ABIs, CI | Done |
| 5b | Ledger: double-entry, append-only, hash-chained | Done |
| 5c | Outbox + jobs in PostgreSQL, idempotency | Done |
| 5d | Signing service + policy engine | Done |
| 5e | Indexer → read model | Done |
| 5f | Reconciliation (chain vs ledger vs bank) | Next |
| 5f-2 | Public-chain anchoring of the Besu chain and the ledger head (ADR 0008) | Done on a local Anvil stand-in; public L2 pending the owner |
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
| `@pt/outbox` | Outbox: `enqueue` inside the business transaction, `OutboxWorker` (leases, LISTEN/NOTIFY, record-before-broadcast, resolution from the chain), `Executor` interface; `@pt/outbox/local-executor` for the local chain only |
| `@pt/signer` | Signing service: key custody behind `KeyProvider` (encrypted keystore locally, HSM/MPC in production), deny-by-default policy engine, maker-checker, nonce reservations, hash-chained audit, HMAC-authenticated internal API, outbox `signerExecutor` |
| `@pt/anchor` | Hourly public-chain anchor of the finalized Besu block and the ledger head (record before send, crash-safe, fail-closed alarms); `verify` checks every anchor against Besu and an independent recomputation of the ledger |
| `@pt/indexer` | Follows the chain into the read model (schema `chain`): 4,000-block windows, parent-hash checks, one transaction per batch, halts on any mismatch; `verify` rebuilds and compares with the contracts; typed read queries |
| `@pt/demo-console` | **Live Demo Console** for team presentations (local only) |

## Outbox (Step 5c)

Commands for the chain are enqueued in the **same transaction** as the ledger entry and executed by workers; see [ADR 0004](../docs/decisions/0004-outbox.md) for the full rules and the exactly-once argument. Enforced in the database (migration `0003_outbox.sql`):

| Rule | What it guarantees |
|---|---|
| O-1 | Command and business change commit or roll back together |
| O-2 | Idempotent enqueue; same key with a different command is refused |
| O-3 | Kind, payload, key, reference immutable; no deletes |
| O-4 | Only allowed status edges; `confirmed` / `failed` final |
| O-5 | A transaction is recorded before broadcast, only by the current lease owner of a claimed command |
| O-6 | A recorded transaction is cleared only when proven dropped |
| O-7 | Every change in an append-only event history |

```ts
await client.query("BEGIN");
await postJournal(client, { /* money in */ });
await enqueue(client, { idempotencyKey: `mint:${refId}`, kind: "issuance.mint", payload, ref, createdBy: "issuance-service" });
await client.query("COMMIT");

const worker = new OutboxWorker(pool, { workerId: "w1@host", executors: { "issuance.mint": executor } });
await worker.start(); // LISTEN outbox + polling fallback
```

Roles: `pt_outbox_writer` (enqueue), `pt_outbox_worker` (claim/record/complete/release/resolve), `pt_outbox_operator` (decide on review, with a reason), `pt_outbox_reader`.

Tests (26): database rules (idempotency, rollback, immutability, edges, concurrent claimers, lease loss, drop/revert, backoff, operator rules, roles, NOTIFY only on commit); worker outcomes with a fault-injecting fake chain; a **property test** (random faults, 1–3 workers: never two successful transactions per command, confirmed means exactly one, failed means none), verified to catch a deliberately broken worker; and end to end on Besu (ledger + command in one transaction, real mint, duplicate refId refused before sending).

## Signing service (Step 5d)

```bash
npm run signer:setup     # LOCAL DEV ONLY: encrypted keystore from the dev Issuance key, first mint policy (maker + checker)
npm run signer           # 127.0.0.1:4900, HMAC-authenticated
npm run signer:decide -- <requestId> <operator> approve "<reason>"   # maker-checker approval
npm run signer:audit     # verify the audit hash chain
```

Rules enforced in the database (`0004_signer.sql`): S-1 no key material in the database, S-2 versioned policies activated by a second operator, S-3 approvals by distinct operators who are not the requester, S-4 nonce reservations without duplicates or gaps, S-5 hash-chained append-only audit. The service signs but never broadcasts; the outbox records first, then broadcasts (ADR 0004/0005).

Measured locally: the signer's own work p50 6.2 ms / p99 8.9 ms; a full signature over HTTP including Besu reads p50 29 ms / p99 37 ms (before fixing gas limits per policy: p50 738 ms).

Tests (35): keystore (round trip, wrong passphrase, tampering, no key in output), policy (every deny path), service flows on a scratch database (idempotency, payload conflict, two-operator approval, rejection, unverified/paused/simulation denials without nonce use, daily limit, 30 concurrent requests get gap-free unique nonces, release and reuse, dropped re-sign, audit tamper detection, immutability), HTTP auth (forged, stale, replayed, tampered, wrong path, oversized, non-JSON), and end to end on Besu through the outbox (small mint, deferred large mint approved by two operators, unverified recipient refused with nothing signed).

## Indexer and read model (Step 5e)

```bash
npm run indexer                          # follow the local chain into schema chain (Ctrl+C to stop; crash-safe)
npm run indexer:status                   # cursor, lag, halt state
npm run indexer:verify                   # rebuild from the chain + compare with balanceOf etc. at a pinned block (exit 1 on any difference)
npm run indexer:reset-local -- --yes     # LOCAL DEV ONLY, after `python chain/net.py reset`
npm run indexer:bench                    # synthetic speed test in a throw-away database
```

Settings: `CHAIN_RPC_URL`, `CHAIN_ID`, `INDEXER_DEPLOYMENT_FILE` (default: the local DeployLib broadcast), `PG_DATABASE`. Exit code 3 means **halted**: the chain no longer matches what was indexed. Investigate first; usually rebuild into a fresh database. Rules enforced in the database (`0005_indexer.sql`), see [ADR 0006](../docs/decisions/0006-indexer.md):

| Rule | What it guarantees |
|---|---|
| C-1 | Events, derived tables and cursor commit in one transaction; the cursor moves by compare-and-set (exactly-once) |
| C-2 | Each batch links to the previous one by parent hash; a block number never has two hashes |
| C-3 | History is append-only; derived rows are never deleted; nothing is truncated |
| C-4 | `pt_chain_writer` only calls the API functions; `pt_chain_reader` only reads |
| C-5 | Contract invariants re-checked (no negative balance or supply, refId once, distribution and recovery state machines, documents) |
| C-6 | A halted deployment refuses all batches until an administrator clears it, with a recorded reason |
| C-7 | `NOTIFY chain_events` at commit only; `chain_alert` on a halt |

Reads (`holders`, `portfolio`, `transfersOf`, `distributionsOf`, `indexStatus`) are in `@pt/indexer`.

Measured locally:
- Catch-up on the real chain: 41,011 blocks in 8.9 s, about 4,600 blocks/s (another run 2,700 blocks/s). The header checks dominate.
- `verify`: 10.5 s.
- Reads on the real chain: p95 1.2–4.1 ms.
- Synthetic (`indexer:bench`): apply 620–1,030 events/s. Reads with 110,050 events and 10,000 holders, p95: top-50 holders 17–20 ms (one earlier run: 106 ms), portfolio 2.5 ms, transfers 6–10 ms, distributions 4–7 ms.

Tests (27):
- decoding and deployment parsing;
- database rules: roles, append-only, compare-and-set, halts, NOTIFY on commit;
- 4,000-block windows, event-count splitting, invariant halts, racing indexers, follow mode;
- every chain-mismatch halt: rewritten history, replaced tip, broken header link, wrong log block hash, wrong chain ID;
- a **property test**: random valid event sequences in random batch splits, with crashes before and after COMMIT and racing indexers, must give exactly the reference model's state, with no duplicates. Disabling the compare-and-set makes it fail with the minimal counterexample "race";
- end to end on Besu (read-only): catch-up, `verify` against a rebuild and the contracts' views, read latency.

## Public-chain anchoring (Step 5f-2)

Every hour the job anchors one **commitment** on the public chain: `keccak256(abi.encode(domain, besuChainId, besuBlock, besuBlockHash, ledgerJournalId, ledgerHeadHash))` (spec section 7.1, [ADR 0008](../docs/decisions/0008-public-anchor.md)). Until the owner picks the L2, the public chain is a local Anvil stand-in (`python chain/anchor.py`, `127.0.0.1:8650`, chain ID 586650; see [chain/README.md](../chain/README.md)).

```bash
npm run anchor:setup     # LOCAL DEV ONLY: anchor key in its own encrypted keystore (backend/data/keystore-anchor/)
npm run anchor:once      # finish the open anchor, or anchor the finalized Besu block + ledger head now
npm run anchor           # every ANCHOR_INTERVAL_SECONDS (default 3600) until Ctrl+C; exit code 3 = alarm
npm run anchor:verify    # every public anchor vs Besu and the ledger recomputed from its rows (exit 1 on a mismatch)
npm run anchor:status    # the anchor records in this database
```

Settings: `ANCHOR_RPC_URL` (default `http://127.0.0.1:8650`), `ANCHOR_CHAIN_ID` (586650), `ANCHOR_CONTRACT` (default: the local DeployAnchor broadcast), `ANCHOR_ALLOW_CHAIN_ID` (required for any other chain), `ANCHOR_CONFIRMATIONS` (required for any other chain), `ANCHOR_BESU_CONFIRMATIONS` (0: QBFT is final), `ANCHOR_INTERVAL_SECONDS`, `ANCHOR_RETRY_SECONDS`, `ANCHOR_GAS_LIMIT`, `ANCHOR_MAX_GAS_PRICE_WEI`, `ANCHOR_LOG_WINDOW` (2,000), `ANCHOR_KEYSTORE_DIR`, `ANCHOR_KEYSTORE_PASSPHRASE`, plus `CHAIN_RPC_URL`/`CHAIN_ID` for Besu and `PG_*`. The network policy refuses chain 586586, the private chain's own ID, the stand-in in production, and any public chain unless it is explicitly allowed **and** the key is in a production key provider (the local keystore can only sign on the stand-in).

Rules enforced in the database (`0007_anchor.sql`; roles `pt_anchor_writer`, `pt_anchor_reader`):

| Rule | What it guarantees |
|---|---|
| A-1 | Anchor inputs (chains, contract, block, hashes, ledger head, commitment) never change |
| A-2 | Never a lower block; the ledger head never moves backwards; one private chain per contract; at most one open anchor per contract |
| A-3 | Record before send: the signed raw transaction is stored before broadcast; after a crash the SAME bytes are re-broadcast; only allowed status edges; failures carry a reason |
| A-4 | No DELETE/TRUNCATE; every change in the append-only `anchor.history` |
| A-5 | The writer only calls the API functions; the reader only reads |

Measured locally: one anchor on Anvil 0.3–0.5 s end to end (preflight reads, ledger head, simulate, sign, record, broadcast, receipt; 51,060 gas); `verify` 21–32 ms for two anchors in-process (0.6 s for the CLI including connections); deploying through `forge script` 24–39 s (mostly forge start-up).

Tests (35): commitment test vector shared with Solidity, network policy, broadcast parsing; ledger recomputation equal to the database digest for awkward text (quotes, control characters, Urdu, emoji, U+2028) across page boundaries; database rules A-1..A-5 including concurrent writers and admin UPDATEs; the job on a fault-injecting fake chain (crash at every point, lost broadcast, lost response, proven-dropped re-sign, pool and confirmation waits, gas cap, racing processes, rotated key, missing contract, wrong chains, production, a stolen-key anchor, a revert); a **property test** (random crashes, RPC faults, lost broadcasts, manual mining and racing processes: never two anchors for one record, never lower, never a silent skip, `verify` clean), verified to catch a deliberately broken job (broadcast before recording: minimal counterexample "crash at signed"); **tamper tests** (rewritten Besu block, edited anchor record, edited posting, full re-hash by a rogue DBA that fools `ledger.verify_chain()`, deleted journal, anchor missing on chain); and integration on a real Anvil chain (DeployLib deploy, crash recovery with the same signed transaction, verify, re-hash detected) and against the real local Besu network (read-only).

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

Writes are serialised by an advisory lock to keep the chain linear (tested with 30 concurrent writers). A superuser can still disable triggers; that is why the chain head is anchored on a public chain every hour (Step 5f-2, `npm run anchor:verify` finds even a full re-hash) and production DBA access is separated and audited.

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

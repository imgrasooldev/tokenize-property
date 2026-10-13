# Backend (Step 5)

TypeScript services that keep the books and talk to the chain: ledger, outbox, signing service, indexer, reconciliation. See [docs/decisions/0001-stack.md](../docs/decisions/0001-stack.md), [0003](../docs/decisions/0003-backend-data.md), [0004](../docs/decisions/0004-outbox.md), [0005](../docs/decisions/0005-signing-service.md), [0006](../docs/decisions/0006-indexer.md), [0007](../docs/decisions/0007-reconciliation.md), [0009](../docs/decisions/0009-kyc-and-bank.md) and [0010](../docs/decisions/0010-website-integration.md).

## Status

| Sub-step | Scope | Status |
|---|---|---|
| 5a | Foundation: workspace, config, logger, DB pool + migration runner, typed ABIs, CI | Done |
| 5b | Ledger: double-entry, append-only, hash-chained | Done |
| 5c | Outbox + jobs in PostgreSQL, idempotency | Done |
| 5d | Signing service + policy engine | Done |
| 5e | Indexer → read model | Done |
| 5f | Reconciliation (chain vs ledger vs bank), payout freeze (ADR 0007) | Done |
| 5f-2 | Public-chain anchoring of the Besu chain and the ledger head (ADR 0008) | Done on a local Anvil stand-in; public L2 pending the owner |
| 5g | KYC and bank: identity checks, signed Raast webhooks, payout accounts and batches, mock providers and mock bank (ADR 0009) | Done (mock providers; real NADRA, liveness, sanctions and bank pending partner contracts) |
| 5h | Integration: website on the read model, the outbox and the signing service (custody, new kinds), KYC API, offboarding, held payouts, payout records, reconciliation bookings, demo-server services (ADR 0010) | Done |

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
| `@pt/recon` | Reconciliation: one snapshot pinned to the read model's block, pure deterministic checks (issuance, supply, holdings, cash, rent, integrity), findings recorded atomically; blocking findings freeze payouts until two operators unfreeze; mock bank statement import |
| `@pt/kyc` | KYC onboarding: NADRA, liveness and sanctions behind interfaces (realistic mocks), peppered CNIC/name hashes and sealed name (no readable personal data in the database), status derived in the database, maker-checker sanctions reviews |
| `@pt/bank` | Bank side: signed webhook endpoint, Raast credits matched to payment codes (or suspense), payout accounts with title match and 72-hour cooling-off, maker-checker payout batches gated by reconciliation, deterministic bank file; `MockBank` plays the outside bank (own records, statements in `pt-mock-bank-v1`) |
| `@pt/http-auth` | HMAC request signing for the internal APIs (method, path, time, one-time nonce, body hash; 30 s skew, replay refused) with per-client path scopes; used by the signing service and the KYC API |
| `@pt/demo-console` | **Live Demo Console** for team presentations (local only), and the local/demo bookings for reconciliation (`seed:local`, `rent:book`, `recon:demo-bank`) |
| `@pt/property` | Sponsor KYB, property submission and due diligence (spec S-01): keyed hashes and sealed sponsor data, the K/P state machines, duplicate detection, maker-checker and the hash-chained audit in the database; operator CLI until the portal screens exist |

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

## Reconciliation (Step 5f)

```bash
npm run recon:register-account -- TRUSTEE-ESCROW-01 web:bank:subscriptions ops-ali   # once per bank account
npm run recon:import-bank -- statement.jsonl --by ops-ali    # mock format pt-mock-bank-v1 (src/bank.ts)
npm run recon                       # one run; exit 0 = clean, 1 = findings (blocking ones freeze payouts), 2 = error
npm run recon -- --json             # the same as JSON; --no-verify skips the indexer rebuild; --sla-minutes 30
npm run recon:status                # payout gate, latest runs, open unfreeze requests, audit chain
npm run recon:unfreeze -- --request ops-ali "<reason>"            # maker
npm run recon:unfreeze -- --approve <id> ops-sara "<reason>"      # checker: a different operator, after a passed run
npm run recon:bench -- 10000        # synthetic speed test in a throw-away database
```

Settings as for the indexer (`CHAIN_RPC_URL`, `CHAIN_ID`, `INDEXER_DEPLOYMENT_FILE`, `PG_DATABASE`). A run takes one REPEATABLE READ snapshot, pins the read model's cursor block P, reads `totalSupply` and every holder's `balanceOf` at P, optionally runs the indexer's `verify`, applies the checks and stores the findings with the result in one transaction. Checks, conventions, mock bank format and data gaps: [ADR 0007](../docs/decisions/0007-reconciliation.md). Rules enforced in the database (`0006_recon.sql`):

| Rule | What it guarantees |
|---|---|
| R-1 | Runs, findings, statements, gate events, audit: append-only; a run finishes once, with all its findings |
| R-2 | Any blocking finding freezes payouts in the same transaction; nothing unfreezes automatically |
| R-3 | Unfreeze = request + approval by two different operators with reasons, bound to the current freeze, 24 h expiry, only after a later passed run |
| R-4 | `recon.payouts_allowed()`: not frozen AND latest run passed AND less than 26 hours old (deny by default) |
| R-5 | Statements imported once; opening + lines = closing; reference unique per account and direction |
| R-6 | Hash-chained audit; `recon.verify_audit()` recomputes runs, findings and statements and finds direct inserts |
| R-7 | Roles `pt_recon_writer`, `pt_recon_operator`, `pt_recon_reader`; `pt_signer` and `pt_outbox_worker` may only ask the gate |

The signing service denies every `payout.*`, `rent.*` and `distribution.*` kind unless the gate allows payouts (checked on request and again at signing).

Measured: real local chain (44,463 blocks, 116 mints) full run 10.9 s, of which the indexer `verify` is 10.7 s (checks 29 ms); synthetic 10,000 subscriptions / 20,000 journals / 10,000 mints / 10,000 bank lines: 2.4–3.7 s without the rebuild, 6.6 s with it.

Tests: checks per area (SLA edges, warnings, determinism, truncation), a **property test** (random consistent worlds give zero findings; each of 24 injected discrepancy kinds is detected under the right check name; mutation-checked), database rules (gate, freeze, maker-checker, expiry, stale requests, roles, append-only, audit tamper detection independent of TimeZone), mock statement parser, an end-to-end run on a fake chain indexed by the real indexer (clean → freeze → unfreeze → error → tamper), the signer's payout gate, and a read-only run on the local Besu chain.

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

## KYC and bank (Step 5g)

[ADR 0009](../docs/decisions/0009-kyc-and-bank.md). Every identity and money rule is in `0009_kyc_bank.sql`; the services talk to providers, keep personal data out of the database and write the bank file.

```bash
npm run kyc:setup        # LOCAL DEV ONLY: KYC_PEPPER_V1, KYC_PEPPER_CURRENT, KYC_DATA_KEY in backend/.env.local
npm run bank:setup       # LOCAL DEV ONLY: BANK_DATA_KEY, BANK_WEBHOOK_SECRET_K1 in backend/.env.local
npm run bank             # webhook endpoint http://127.0.0.1:4910/v1/bank/events (BANK_PORT, BANK_ESCROW_ACCOUNT)
npm run kyc:status -- <subjectId>
npm run kyc:audit        # KYC audit chain (exit 3 on a problem)
npm run bank:audit       # bank audit chain (exit 3 on a problem)
npm run bank:bench       # throw-away database: onboarding, webhooks, a payout batch, the cash check
```

| Rule | What it guarantees |
|---|---|
| Y-1 | No readable CNIC, name or provider response in the database: keyed hashes (peppers in the KMS), last four digits, the name sealed with AES-256-GCM, evidence hashes |
| Y-2 | One subject per CNIC, also across pepper versions |
| Y-3 | Status derived in the database: NADRA match + liveness ≥ 80 + clear sanctions, recent for a new verification, valid 365 days; errors never verify nor un-verify; a sanctions hit is final |
| Y-4 | A possible sanctions match is settled only by two different officers |
| Y-5 / B-7 | Append-only records, hash-chained audits (`kyc.verify_audit()`, `bank.verify_audit()`) that also find edited decisions, credits and batch items |
| Y-6 | Roles `pt_kyc_service`, `pt_kyc_officer`, `pt_kyc_reader`; the signer and bank see status only |
| B-1 | Signed webhooks (HMAC over timestamp and raw body, 5-minute window, key rotation, 16 KB, strict schema); an event id is booked once; same id with another body → 409 and alert |
| B-2 | Every credit is booked in the same transaction on `bank:trustee-escrow` with the Raast reference; only an exact match (code, amount, expiry, verified investor, the investor's own account) reaches an investor, everything else goes to suspense |
| B-3 | A payment code is paid once; a Raast reference is booked once |
| B-4 | Payout account title must match the verified name; one current investor per account; usable 72 hours after registration; every change alerts; IBAN as keyed hash + sealed copy bound to the investor |
| B-5 | Payout batches: maker-checker, reconciliation gate at approval and at submission, verified investors with active unchanged accounts, total = finalized on-chain distribution, ledger refuses overpaying |
| B-6 | One live batch per distribution; deterministic bank file, SHA-256 recorded before sending; a retry re-sends the same bytes |
| H-1..H-4 | Held payouts (`0010_held_payouts.sql`, Step 5h): a line that cannot be paid now (no active account, KYC not verified) is held, not sent and stays owed; a batch must pay something; follow-up batches pay held shares once each (same maker-checker and gate); the item digest covers the held flag; reconciliation warns `rent.payout_held` until paid |

Measured on this laptop (`npm run bank:bench -- 1000`): KYC onboarding with the mock providers p50 10.7 ms, p99 49 ms; a Raast credit through the signed HTTP endpoint into the ledger p50 5.9 ms, p99 32 ms; a payout batch of 1,000 investors created in 0.66 s, approved in 0.07 s, submitted (bank file + ledger) in 0.51 s; the cash check on 1,001 statement lines 19 ms with zero findings.

Tests: 22 KYC and 37 bank (see ADR 0009), including a scan of every KYC row for personal data, ten concurrent deliveries of one event, a sealed IBAN swapped between investors, and a property test where lost webhooks always show up in reconciliation and, after the bank's retry, the ledger equals the bank line by line. Three deliberate rule breaks (third-party payer accepted, suspense booked without its reference, no cooling-off) each make tests fail.

## Website integration (Step 5h, ADR 0010)

The website signs nothing and reads no chain data per request: it reads the read model (`chain.*`), enqueues `issuance.mint`, `token.transfer` and the onboarding commands in the same transaction as its ledger entries, and the outbox worker executes them through the signing service. Migration `0012_website.sql`:

| Rule | What it guarantees |
|---|---|
| W-1 | Custodial investor wallets: generated inside the signing service (or imported on the local dev chain only), recorded append-only with their key in one audited call; a platform key can never become a wallet |
| W-2 | `token.transfer` only from a custodial wallet (the signer reads that fact itself) |
| W-3 | Delivery versus payment: a transfer is signed only while the trade's escrow in the ledger holds its cost (`ledger.escrow_held`, market escrows only) |
| W-4 | The website's own records (`webdemo`) are created by the migration; the website runs no DDL |
| W-5 | The website connects as `pt_web_app` (member of `pt_web` only): its own tables without DELETE/TRUNCATE, the ledger and outbox only through their functions, read-only read model; tested to be refused everything else |

New signing kinds (deny by default, chain and contract pinned, daily limits, simulated, facts read fresh): `token.transfer` (custodial sender, verified recipient, not paused or frozen, enough unfrozen tokens, escrow, maker-checker above 10,000 tokens locally), `identity.create`, `identity.add_claim` (claim signed by the claim key, the transaction by the investor's custodial wallet) and `identity.register`, each only for a custodial wallet whose owner `kyc.is_verified`. The signer API has client scopes: `outbox-worker` may sign, broadcast and release; `web` may only create a custodial wallet. The KYC service has its own HMAC API for the website's sign-up (`npm run kyc:serve`).

Measured on this laptop (local Besu, 2-second blocks; the machine was shared with another busy test run, CPU often near 100%): an investment accepted to settled (payment, outbox, signer, block, index, follower) in 4–5 s; a trade matched to settled in 13–16 s (about 9 s of it the signer and outbox under load, then one block and the index); a sign-up end-to-end test (NADRA failure, KYC, four on-chain steps, duplicate refusal) in about 30 s; a settlement follower pass over the test database 150–650 ms. Signer own work unchanged: p50 10.7 ms, p99 25.4 ms (idle machine).

## Property onboarding and due diligence (spec S-01, task T-021)

[S-01](../docs/specs/S-01-owner-onboarding-and-due-diligence.md). Every state, guard, duty and maker-checker rule is in `0014_property.sql` (schema `property`); `@pt/property` validates input (zod), hashes registration numbers and seals names and addresses, and maps refusals to `PropertyError` (`INVALID_INPUT`, `FORBIDDEN`, `GUARD`, `DUPLICATE`, `NOT_FOUND`). Backend only: the screens come with the Step 6 portals; until then operators use the CLI. For the pilot, operations enter the sponsor's file on the sponsor's behalf, naming the representative who acted (S-01 Q-1, OB-8).

```bash
npm run property:setup                          # LOCAL DEV ONLY: PROPERTY_PEPPER_V1, PROPERTY_PEPPER_CURRENT, PROPERTY_DATA_KEY in backend/.env.local
npm run property:run -- actions                 # every workflow operation
npm run property:run -- submitProperty '{"propertyId":"…","actor":"onb-1","actingFor":12}'
npm run property:run -- decideRequest @decision.json
npm run property:show -- property <id>          # state, review status, valuations, duplicate candidates (no personal data)
npm run property:queue                          # open maker-checker requests, possible duplicates, blocked submissions
npm run property:audit                          # property audit chain (exit 3 on a problem)
npm run property:expire                         # K7 for every lapsed KYB (schedule daily)
```

| Rule | What it guarantees |
|---|---|
| PR-1 | No readable CNIC, NTN, CUIN, person's name or address: people are KYC subject ids; registration numbers are keyed hashes (own pepper, rotation-aware) + last four; legal name and address sealed (AES-256-GCM, bound to the sponsor and field); documents are SHA-256 + size + media type + an opaque store reference (no files in the database) |
| PR-2 | Only the S-01 transitions K1..K11 and P1..P14 exist (`property.transitions`); a trigger refuses any other event, or one not starting from the current state, whoever writes it; the state column follows the event log only |
| PR-3 | KYB status derived in the database: approved reads as expired after 365 days or as soon as a director, representative or beneficial owner is no longer KYC-verified |
| PR-4 | Maker-checker for K4, K5, K10, K11, a company screening clearance, P6, P13, P14 (requester never approves, one rejection is final, 72 h expiry, stale when the state moved); duplicates need an onboarding and a compliance officer; P7 needs an IC quorum; P8 needs the legal head's structure and a trustee officer |
| PR-5 | Duties granted maker-checker; a trustee holds no other duty; whoever entered or submitted a file never decides it; three different reviewers who did not assign themselves; parties to a file cannot sit on its committee |
| PR-6 | Duplicate detection inside the submission, under one lock, against every property ever submitted (any state, every sponsor): exact (property key, registered deed, identical title document) blocks and records a case; possible (GPS within 30 m, same parcel other unit, same parcel number, same land-record/authority/tax reference or address, same document) needs two decisions; an exact match on a Tokenization Ready property is a fraud indicator |
| PR-7 | A review relies on the hashes of current documents; superseding a document, a new encumbrance or a material change reopens the affected reviews and moves an approved file back to Under Review |
| PR-8 | Append-only records, hash-chained audit with UTC timestamps; `property.verify_audit()` also re-checks transitions, document hashes, review hashes, valuations, votes, replays every state and finds rows written around the API |
| PR-9 | Roles `pt_property_writer`, `pt_property_reviewer`, `pt_property_admin`, `pt_property_reader` |

LEGAL TO CONFIRM values are configurable in `property.settings` (beneficial-owner threshold 25 %, title period 30 years, valuation tolerance 10 %, gap 60 days, validity 6 months), `property.mandatory_documents` (KYB and per-property lists) and `property.doc_types` (DocType mapping, S-01 Q-5); a change is a new migration.

Not yet built (later steps): anchoring document hashes on DocumentRegistry after deployment (OB-41, needs a signer kind `document.add`), the `documents.*` and `property.token_without_approval` checks inside `@pt/recon` runs (pure functions exist in `@pt/property/recon.ts`), notifications (§9), SLA clocks, the sponsor portal, and the encrypted document vault.

Tests: `rules.test.ts` (11, no database), `property-db.test.ts` (35), `property-model.test.ts` (1 property test: 30 random operation sequences by right and wrong officers against a reference model), `cli.test.ts` (1). While migrations 0012 (Step 5h) and 0013 (Step 6a) are on other branches, the property tests build their scratch databases from a renumbered copy of the migrations (`test/helpers.ts`, 0014 becomes 0012); the copy equals the real directory once those branches are merged.

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
| L-6 | Protected accounts cannot be overdrawn (no overpaying an investor). Since migration 0008 the check reads a forward-only running balance per account, so write cost does not grow with history; `ledger.verify_balances()` proves the running balances equal the postings and reconciliation blocks payouts if not | `L-6 no overdraft`, `balances.test.ts` |

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

# services (Step 5h; each once set up with the idempotent setup commands)
npm run kyc:setup && npm run signer:setup && npm run db:web-role   # secrets in .env.local, dev keys, policies, website role
npm run indexer            # read model
npm run signer             # signing service, 127.0.0.1:4900
npm run outbox             # outbox worker (every kind through the signer)
npm run kyc:serve          # KYC API for the website, 127.0.0.1:4910
npm run kyc:offboard       # freezes for investors who lost their verification
npm run signer:decide -- <requestId> <operator> approve|reject "<reason>"   # maker-checker

# local/demo bookings so reconciliation passes on the local chain (dev chain only)
npm run seed:local         # chain/flow.py's scenario mint as Alice's seed subscription
npm run rent:book          # rent collected (published) and distributed (finalized)
npm run recon:demo-bank    # the demo bank's statements from the website's payment records
npm run recon              # 0 findings on a freshly set-up stack (see recon/test/local-stack.test.ts)
```

## Supply-chain rules (`.npmrc`)

- Exact versions only (`save-exact`); the lockfile is committed and CI uses `npm ci`.
- Dependency install scripts are disabled (`ignore-scripts`).
- `npm audit --audit-level=high` runs in CI.
- TypeScript is pinned to 6.0.3: typescript-eslint does not support 7.x yet.

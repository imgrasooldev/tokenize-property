# Project Memory

The single place to pick this project up from. Read this first, then the linked docs. Update it at the end of every working session and at every step gate.

- Last updated: 2026-10-11
- Repository: https://github.com/imgrasooldev/tokenize-property (private)
- Local path: `D:\property-token`
- Current position: **Investor website prototype W1–W5 complete (web/): invest, portfolio, rent self-verification, demo market with real-time chart, hardening, 67 + 11 e2e tests, presenter tooling. Owner approved the website gate (2026-10-12). Backend 5c outbox done; next 5d signing service + policy engine.**

---

## 1. What we are building

A permissioned platform for fractional ownership of real estate in **Pakistan**.

- An independent **trustee** (e.g. CDC) holds each property through a REIT or an SPV under the SECP sandbox.
- Investors hold **ERC-3643 security tokens** that mirror the trustee's register.
- **Rent and investments move in PKR through banks and Raast.** Smart contracts record ownership and entitlements only and never hold money.
- **Top priority: safety on every layer, especially the technical one. Second priority: fast response times.**

Full product list (websites, portals, apps, services): [docs/product-map.md](docs/product-map.md).

## 2. Decisions already made (do not re-open without a new ADR)

| Topic | Decision | Where |
|---|---|---|
| Token standard | ERC-3643, official repo `ERC-3643/ERC-3643` tag **4.1.3** (old `TokenySolutions/T-REX` is deprecated) | spec §1 |
| Compliance modules | T-REX **4.1.6** `CountryAllowModule` + `MaxBalanceModule`, unchanged; in our audit scope | spec §4.3 |
| Our contracts | Small non-upgradeable **guards** are the only token agents; solc **0.8.30**; OpenZeppelin **5.6.1** | spec §5 |
| Governance | Every owner is a **72h TimelockController**; Admin Safe 3-of-5 proposes/executes; Trustee Safe can cancel | spec §3 |
| Chain | Private **Hyperledger Besu QBFT**, 4 validators run by separate organisations, hourly hash anchor on a public chain | ADR 0001 |
| Server stack | All TypeScript: **NestJS on Fastify**, viem, **PostgreSQL 18**; queues/outbox in PostgreSQL (no Redis for now). Speed comes from never putting the chain in the read path | ADR 0001, ADR 0003 |
| Frontends | **Next.js** for website, investor portal and internal portals; **Flutter** for the mobile app | ADR 0001 |
| Money | PKR only, via banks/Raast. No stablecoins, no on-chain payments | spec §10 |
| Max holding | 10% of the trustee register per investor identity (default 100,000 of 1,000,000) | spec §4.3 |
| Allowed countries | Pakistan (586) only, until legal approves more | spec §4.3 |
| Security standards | EthTrust [Q], OWASP ASVS L3, MASVS L2+R, CCSS III, NIST SSDF, SLSA L3, CIS, ISO 27001/SOC 2 | [security-standards.md](docs/security-standards.md) |

## 3. Development lifecycle and status

Full lifecycle document: [docs/Development-Lifecycle.pdf](docs/Development-Lifecycle.pdf).

| Step | Scope | Status |
|---|---|---|
| 1 | Repo, CI, stack decision | Done |
| 2 | Contract spec + threat model | Done (spec v0.3) |
| 3 | Smart contracts + tests | **Done (internal)**: 121 tests, 100% coverage, Slither 0, EthTrust [Q] self-assessment, deploy verified on Anvil |
| 4 | Local chain: Anvil, then 4-node Besu QBFT | **Done**: Besu 26.9 + portable JDK 25, 4 validators, `chain/flow.py` 50/50 checks on real blocks, validator outage and recovery |
| 5 | Backend: ledger, outbox, signing service, indexer, reconciliation | **In progress**: 5a foundation, 5b ledger, 5c outbox done (O-1..O-7 in PostgreSQL, ADR 0004, `@pt/outbox` worker, property-tested exactly-once; 49 backend tests). Next 5d signing service |
| Demo | Live Demo Console (`backend/packages/demo-console`) | **Done**: validators, token, events, ledger; scenario/rent/tamper buttons |
| 7 (early) | Investor website prototype (`web/`) | **Done (prototype)**: W1 (properties, live chain data, charts, EN/Urdu RTL), W2 (personas, sign-up, mock KYC, real on-chain onboarding) W3 (invest: mock Raast → ledger → real mint → settle/refund; portfolio with reconciliation; rent Merkle self-verify) W4 (demo market: cash top-up, limit orders with escrow, single matcher, DvP settlement on chain, SSE real-time candles) and W5 (record-before-broadcast sends with per-signer lock, rate limits, caching, error pages, Playwright e2e in Edge, `scripts/demo.py`, docs/demo-guide.md) done; 67 tests + 11 e2e. **Complete; awaiting owner review** |
| 6 | Internal portals: operations, compliance, trustee (maker-checker) | Not started |
| 7 | Investor web portal, website, verification page, Flutter app | Not started |
| Pre-launch | 2 external audits, formal verification, pen test, SECP pilot | Not started |

Rule: a step starts only after the previous gate passes and the owner approves.

## 4. Security findings (all in vendored code; ours is clean so far)

| ID | Issue | Mitigation |
|---|---|---|
| [F-01](docs/findings/F-01-onchainid-claim-revocation-bypass.md) | ONCHAINID claim revocation bypass via re-encoded signature | Never rely on revocation. Offboard = freeze, then move/redeem tokens, then delete identity via timelock |
| [F-02](docs/findings/F-02-maxbalance-identity-coupling.md) | MaxBalanceModule strands tokens if a holder's identity is deleted or updated | Same offboarding order; never `updateIdentity` on a holding wallet; admin portal must enforce |
| F-03 | ONCHAINID claim signatures lack `chainid` | One claim-signer key per chain |

## 5. Gotchas learned the hard way

- **ERC-3643 tokens deploy paused.** Go-live = timelock sets trustee cap (72h), then Admin Safe unpauses via `PauseGuard`.
- ERC-3643 lets the same agent pause and unpause, and allows minting while paused. Our guards fix both.
- `deleteIdentity` / `updateIdentity` are agent-only, so the **timelock is an identity-registry agent** (never a token agent).
- The **implementation authorities** (ERC-3643 and ONCHAINID) and the **UUPS modules** can upgrade code. They must be owned by the timelock. `DeployLib.checkHandover` asserts it.
- T-REX ships identical copies of the ERC-3643 interfaces: keep vendor imports in separate files (`ERC3643Suite.sol`, `TrexModules.sol`).
- Vendor code (0.8.17, OpenZeppelin 4.9.6) and ours (0.8.30, OpenZeppelin 5) build together through context remappings in `foundry.toml`. Vendor code does not compile with via-IR.
- In tests, `vm.prank` is consumed by precompile calls such as `sha256`. Compute arguments before pranking.
- In tests, use `vm.getBlockTimestamp()` after `vm.warp`, not `block.timestamp`.
- Coverage misattributes several reverting `new` calls in one test; use one test per constructor check.
- **Besu 26.9 needs Java 25.** A portable Temurin JDK 25 lives in `chain/tools/`; the system Java 21 is untouched.
- On Windows, Besu fails to parse `bootnodes` (`Illegal char <:>`): use `static-nodes-file` with discovery off.
- `forge`/`cast` here do not read `ETH_PRIVATE_KEY`; pass local dev keys as arguments to child processes, never print them.
- In end-to-end scripts, count a "refused" check only on a real revert. A missing wallet once made a refusal check pass falsely.
- Chain ID **586586** is reserved for the local dev network (60 s timelock, plus `LOCAL_DEV_NETWORK=true`). Never use it elsewhere.
- **PostgreSQL:** the EDB binaries zip is unsigned, so it was rejected. Binaries come from the Authenticode-signed EDB installer in extract-only mode, which needs a UAC prompt; the owner approved it. Local cluster runs on `127.0.0.1:5433`. `pg_ctl start` must not have its output piped or the call hangs.
- **Laragon's Redis is 5.0.14** (old Windows port): do not use it.
- **Never edit a committed migration**; the runner refuses changed checksums. Uncommitted migrations may be edited only after resetting the local test DB.
- SQL functions marked `STRICT` return NULL if any argument is NULL; this once nulled the ledger hash (caught by NOT NULL + tests).
- **Demo Console:** `cd backend && npm run demo`, then open `http://127.0.0.1:4800`. Start Postgres and the chain first. Child Python processes must run with `-u` or their output only appears at the end. The preview tool picked another project's launch config, so start the server via a background shell and open it by URL.
- **Web (Next.js 16):** use `src/proxy.ts`, not `middleware`; route `params` are a Promise. `next dev` auto-writes `web/AGENTS.md`, so commit it. `eslint-config-next` was dropped over a high-severity `braces` advisory. ABIs are copied from the backend by `npm run sync:abis`, and CI checks they are identical. Dev server runs on `127.0.0.1:3100`. Browser-pane screenshots can go stale when the window is hidden; reload before taking one.
- **Web W2:** run `npm run setup:demo` once to create `web/.env.local` (session, wallet-encryption and CNIC-pepper secrets). Investor demo data lives in schema `webdemo` in the local `property_token` DB. React resets the form after a server action, so refill fields when testing. Mock NADRA rejects CNICs ending in 0.
- **W3 invest:** refunds only when the mint provably never happened (simulation refused, or mined and reverted); unknown outcomes go to `review` and settle only against a `Minted` event matching wallet **and** amount. The status UPDATE gates every settle/refund journal. Web tests use `WEB_DB_NAME=property_token_test` (only that value is honoured) and onboard a fresh investor each run.
- **Rent statements:** `python chain/rent.py [rupees]` writes `chain/data/rent/<token>-<id>.json` (git-ignored, wiped by `net.py reset`). Distribution 1 from `flow.py` has no statement file, so the portfolio shows "statement not available" for it. `flow.py`'s outage check moves 1 token Alice → Bob, so balances are 49,999 / 10,001 after a fresh run.
- **Windows shell:** in a backgrounded `cd X && cmd & other &` chain, only the first command runs in `X`; a download once landed in the repo root. Use absolute paths. Python on Windows writes CRLF in text mode; `.gitattributes` normalises to LF.
- **New machine setup (2026-10-10):** Foundry 1.8.5 (release zip, SHA-256 checked) in `~/.foundry/bin`; Besu, JDK 25 and PostgreSQL 18.6 verified against the hashes in chain/README.md and backend/README.md (Postgres also Authenticode). `net.py setup` creates new dev keys, so earlier demo investors do not carry over.
- **W4 market:** a buy order's cost sits in its own escrow account `web:order:<id>:escrow`; price improvement on partial fills stays there until the order ends. Matcher = `pg_try_advisory_lock(586586030)`; cancels wait on the same lock. Any failure before broadcast (including a missing custodial key) must fail the trade, never send it to review. Band ±10% of NAV and demo liquidity were the owner's choices (2026-10-10).
- **Dev server speed:** the first request after editing a file includes Turbopack compile time (10–15 s); measured order + on-chain settlement is about 2–3 s, mostly the 2 s block time. viem `pollingInterval` is 250 ms (default 4 s).
- **Stopping the dev server:** `TaskStop` on `npm run dev` leaves the `next` child on port 3100; stop the process listening on 3100. Never run `next build` while `next dev` runs (shared `.next`). `next build` rewrites `web/next-env.d.ts`; restore it before committing.
- **Sending transactions (W5):** `send()` = simulate → per-signer advisory lock (database `postgres`, so all processes share it) → nonce → sign locally → `onSigned` records hash + nonce → broadcast. Recovery decides from the chain via `txOutcome` (success / reverted / dropped / pending / unknown). "No recorded hash" means nothing was sent, because the record step is guarded by the sending status.
- **Besu `eth_getLogs` max range is 5,000 blocks.** Always read logs in windows (`inBlockWindows`, `rent.py`, demo console). This silently broke reconcile once the chain passed 5,000 blocks.
- **E2E:** `npm run test:e2e` starts its own `next dev` on 3101 with `WEB_DB_NAME=property_token_test` and `NEXT_DIST_DIR=.next-e2e` (only those values are honoured). Uses the installed Edge (`channel: msedge`); no browser download. Next's route announcer has `role="alert"` and its dev-tools button matches "EN": use `.alert` and `exact: true`. Sign-up names must be letters only.
- **X-Forwarded-For** is client-controlled; rate limits trust it only with `TRUST_PROXY=1`.
- **Python on Windows** cannot open paths over 260 characters (the session scratchpad); copy scripts to a short path first. Bash heredocs with backticks inside Python strings break; write the script to a file instead.
- **Presenting:** `python scripts/demo.py up --trade` (chain, DB, website, pre-compile, demo trading); `down [--all]`. Production build: pages 9–32 ms on this laptop.
- **Outbox (5c):** the worker decides after any error from the DATABASE state (still `claimed` = nothing sent) and then the CHAIN, never from the error type. Lease minimum 5 s. Tests fast-forward leases and backoffs with admin UPDATEs (allowed: lease fields are not protected). A deliberate mutation (retry without checking the DB) must make the property test fail; keep it that way.
- **`0003_outbox.sql` is applied to both local DBs:** never edit it again; add 0004+.
- **Website redesign mockups (2026-10-12):** `docs/design/mockup-home-v1..v12.html` (serve with `python -m http.server 3200` in docs/design). Owner liked v4's terminal look but wants a **customer website** (not a dashboard) with a **blockchain + AI feel**: latest candidates **v11 (neon chain: globe, AI orb, holographic token cards)** and **v12 (amber chain: live blocks, AI ask bar, neural background)**. Owner has not picked yet. AI advisor in the mockups is a concept only (would be sourced, never investment advice); mockup figures are samples, real site shows real data only.
- **Grid layouts:** panels inside `.detail` need `min-inline-size: 0` or wide tables push the page past 375 px on phones.
- **TypeScript pinned to 6.0.3** because typescript-eslint supports `<6.1`. `.npmrc` sets `ignore-scripts=true` and `save-exact=true`.
- CI had job-level `if: hashFiles(...)`, which GitHub does not allow there; it was removed on 2026-10-10. Pushes before then may not have run CI. Check the Actions tab.

## 6. How to work on the code

```bash
git clone --recursive https://github.com/imgrasooldev/tokenize-property.git
cd tokenize-property/contracts
forge build
forge test                      # 121 tests, about 2 minutes
forge coverage --report summary --no-match-coverage "(test|lib|vendor|script)"
python -m slither . --filter-paths "lib/|test/|src/vendor/|script/" --exclude-dependencies
```

- Foundry lives in `~/.foundry/bin` (add it to PATH). Slither: `python -m slither`.
- Local network: `python chain/net.py setup` once, then `python chain/net.py start` and `python chain/flow.py` (deploy + 50 end-to-end checks). See [chain/README.md](chain/README.md).
- Quick deploy on Anvil: start `anvil`, fill `script/deploy.env.example` into `.env.local` (never commit), then `forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast --unlocked --sender $DEPLOYER`.
- **All deployments go through `script/DeployLib.sol`.** Tests use the same library, so never deploy contracts any other way.
- Every PR follows the security definition of done in [docs/security-standards.md](docs/security-standards.md) (template in `.github/pull_request_template.md`).
- No `.bak` files; rely on git. No secrets in the repo.

## 7. Open decisions (owner to decide)

1. ERC-3643 is **GPL-3.0**: lawyer must confirm before mainnet.
2. Public anchor chain: Ethereum mainnet (most trusted, costly) or an L2 such as Base or Polygon (cheap).
3. Auditor rulings: single-key exception (pauser, registrar, anchor key) and token-address validation in registries (EthTrust checklist §4).
4. Retail investment limits (business and legal).

## 8. Next actions

1. **Investor website prototype**, W1–W5 complete; owner to review (`python scripts/demo.py up --trade`, docs/demo-guide.md). Scope was (owner's choice 2026-10-10): Next.js; pages: properties, property detail (valuation/rent charts), sign-up + mock KYC, invest (real mint on local chain + ledger), portfolio (holdings, rent, Merkle self-verify), and a **demo secondary market** (order book, real-time price chart, trades settled on the local chain) clearly labelled "DEMO: secondary trading needs SECP approval". English + Urdu (RTL) toggle. Uses a demo signer until 5d.
2. Backend 5d signing service + policy engine (replaces the demo signer and the local executor), then 5e indexer, 5f reconciliation, 5g KYC/bank mocks, 5h integration. Then move the website onto the outbox.
3. **Demo deployment (paused by owner 2026-10-12, "baad main dekh len ge"):** owner wants a private demo on a **brand-new, separate server** in their Ploi account (never touch the server running their other product, and no reference to it anywhere), reached by **static IP over plain HTTP, no domain** (owner: "just demo, no need to worry about IP/domain security"). Plan when resumed: owner creates Ubuntu 24.04, 4 vCPU / 8 GB / 80 GB server named neutrally (e.g. `pt-demo`) and adds the deploy key; we deploy with Docker (4 Besu validators, PostgreSQL, website on :80, demo console), chain RPC and DB never exposed, cookie `secure` flag configurable for HTTP, noindex, demo banner; then run e2e against the IP. Deploy key created locally: `~/.ssh/pt_demo_ed25519` (public key comment `pt-demo-deploy`). This replaces the earlier "staging only after Step 6" agreement.
4. Set GitHub branch protection on `main` (2 reviews, CI required, signed commits), Dependabot and secret scanning. **Owner action.**
5. Report F-01 upstream to the ONCHAINID maintainers (responsible disclosure).
6. Shortlist two audit firms and a formal-verification provider.

## 9. Owner preferences and working agreement

- **Language:** chat in Roman Urdu (simple, mixed with English terms); all repository docs in English.
- **Safety bar:** "world best standards" on every layer, technical side most of all. When in doubt, choose the safer option and explain the trade-off.
- **Performance bar:** "response is everything". The owner asked for the fastest stack ("mix and match"); we chose all-TypeScript and keep the chain out of the read path (ADR 0001).
- **Process:** step by step with a review gate after each step. Share the plan before starting a new step.
- **Git:** the owner creates GitHub repos themselves. After finishing work, commit and **push** to `origin/main` (the owner asks for this every time).
- **Memory:** keep this file current after every piece of work (status, next actions, gotchas, communication log) and push it with the work. The owner asks for this regularly.
- **Location and market:** code in `D:\property-token`; target market Pakistan.
- **Honesty:** say clearly what is internal versus externally verified; never present self-assessments as audits.

## 10. Communication log

Short, dated record of what the owner asked and what came out of it. Add a line per working session.

| Date | Owner asked | Outcome |
|---|---|---|
| 2026-10-12 | Demo of all portals; site "too simple"; then 12 mockups (premium, AI+blockchain, 3D city, terminal, luxury, Urdu-first, dashboards, customer sites v9-v12); asked about deploying on their Ploi | Ran website + console demo (40 trades settled). Mockups in docs/design (latest picks v11/v12, not chosen yet). Deployment planned on a new separate server via IP, then paused by owner: continue development first |
| 2026-10-12 | "next continue" (website gate approved), then approved the 5c plan | Step 5c done: migration 0003_outbox.sql (O-1..O-7, roles), `@pt/outbox` (enqueue, OutboxWorker, Executor, local executor), ADR 0004; 26 new tests incl. property test (mutation-checked) and real mint on Besu; threat model M-10; pushed |
| 2026-10-11 | Run the app; then approved the W5 plan (Playwright with installed Edge) | Ran the demo (40 trades settled). W5: independent security review (0 critical, 1 high: unpaid delivered trade after a crash) and all findings fixed: record-before-broadcast sends with per-signer lock, dropped-tx refunds, rate limits, snapshot cache, throttled page side effects, retryable sign-up, error pages, log windows (found Besu 5,000-block limit bug). 67 tests + 11 Edge e2e; prod pages 9–32 ms; `scripts/demo.py`, docs/demo-guide.md; threat model M-9; pushed |
| 2026-10-11 | Continue: approved the W4 plan (±10% band, demo liquidity script) | W4 built: demo cash, limit orders with per-order escrow, single matcher, DvP settlement on chain, SSE real-time candles/order book, EN/Urdu, mobile; `npm run demo:market`; 61 web tests (5 market integration incl. racing buyers and frozen seller); threat model M-8; pushed |
| 2026-10-10 | Fetch/pull the repo and read memory (new machine); then approved 5 verified downloads + setup and the W3 plan | Cloned to `D:\property-token`, all checksums/signature verified, baseline green (121 contract tests, flow 50/50, 23 backend tests). W3 built: invest flow with ledger-first payment, single-use refId mint, safe refund/review rules, portfolio reconciliation, `chain/rent.py` + Merkle self-verify, EN/Urdu, mobile; 28 web tests incl. 5 concurrent identical submits; threat model M-6, M-7; pushed |
| 2026-10-01 | "Property Tokenization Blockchain": explain the concept, for Pakistan | Explained SPV/REIT wrapper, tokens as claims on the legal entity, KYC whitelist, rent flow. Pakistan context: Companies Act 50-member cap for private companies, SECP REIT Regulations and sandbox, SBP 2018 circular, PVARA (2025), PKR via banks/Raast, title risk, FBR tax, Shariah structures |
| 2026-10-01 | Make it much safer, all aspects | 10-layer safety framework (legal, title, contracts, keys, money, app, compliance, insider, continuity, investor honesty); became `docs/threat-model.md` |
| 2026-10-02 | Technical side must be very safe | Architecture with isolated signing service, HSM/MPC, permissioned chain + public anchor, ledger, monitoring; became ADR 0001 and spec |
| 2026-10-07 | Guide the development lifecycle | Phases 0–8 with gates; later published as `docs/Development-Lifecycle.pdf` |
| 2026-10-08 | Start development; show the flow first; use Chrome if needed | 7-step flow agreed; folder `D:\property-token`; backend "mix and match" → all-TypeScript decision; Steps 1–2 done |
| 2026-10-08 | Follow world-best security standards | `docs/security-standards.md` baseline and PR definition of done |
| 2026-10-08 | Start development; list websites, portals and apps | `docs/product-map.md`; Step 3 contracts built (F-01 found) |
| 2026-10-08 | Push to `imgrasooldev/tokenize-property` | Pushed; continued Step 3: modules, DeployLib, F-02, EthTrust checklist; pushed |
| 2026-10-08 | Store memory in MEMORY.md; lifecycle as PDF in docs | `MEMORY.md`, `CLAUDE.md`, `docs/Development-Lifecycle.pdf`; pushed |
| 2026-10-08 | Is all our communication in MEMORY.md? | No; added sections 9 and 10 (this log) |
| 2026-10-08 | Continue; approved downloads of Besu 26.9.0 (192 MB) and portable JDK 25 (141 MB) | Step 4 done: 4-validator network, 50/50 end-to-end checks, outage test; dev-only 60 s timelock (ADR 0002); pushed |
| 2026-10-10 | Update MEMORY.md | Already current after W2; fixed duplicate numbering in next actions, added web/README.md to the index and the "keep memory current" agreement; pushed |
| 2026-10-10 | Continue W2, then push | W2 done and verified in the browser: Alice login; NADRA-failure path; new investor "Ayesha Test" onboarded on chain (isVerified=true via cast); duplicate CNIC refused; forged session refused; DB holds no full CNIC or phone; pushed |
| 2026-10-10 | Push to GitHub and update MEMORY.md | Already pushed (73aeb43); added demo and website rows to the step table and this log line; pushed |
| 2026-10-10 | Continue (website) | Showed flow and market-page layout; built W1: properties list and detail with live chain data, NAV and rent charts, English/Urdu RTL; verified in the browser; web CI job; pushed |
| 2026-10-10 | Asked for an end-user website with a real-time trading chart (complete flow) | Explained the market needs SECP approval; offered real NAV/rent charts plus a clearly labelled demo market. Owner chose: portal + demo market, website before backend 5c–5h, English + Urdu toggle. Demo Console finished and verified in the browser (scenario 50/50, rent cycle, tamper test; security 403s); pushed |
| 2026-10-10 | Next (5b); asked whether we can go live and demo alongside, to present to the team | Advised: not production-live (audits, legal, Steps 5–7 pending); demo in stages. Owner chose a **Live Demo Console** after finishing 5b. 5b ledger done (13 ledger tests incl. tamper, concurrency, property tests); pushed |
| 2026-10-10 | Next; chose PostgreSQL 18, queues in PostgreSQL, approved download | Unsigned EDB zip rejected; signed installer verified and extracted via UAC (no service). 5a foundation done (10 tests, lint 0 warnings, 0 vulnerabilities); ADR 0003; CI fixed + backend job; pushed |

## 11. Document index

| Document | Purpose |
|---|---|
| [README.md](README.md) | Overview and step table |
| [docs/Development-Lifecycle.pdf](docs/Development-Lifecycle.pdf) | Complete lifecycle: phases, gates, standards, status |
| [docs/contract-spec.md](docs/contract-spec.md) | Contract behaviour, roles, invariants I-1 to I-17, deployment |
| [docs/threat-model.md](docs/threat-model.md) | STRIDE threats and controls |
| [docs/security-standards.md](docs/security-standards.md) | Standards baseline and per-PR definition of done |
| [docs/product-map.md](docs/product-map.md) | Websites, portals, apps and services |
| [docs/decisions/](docs/decisions/) | Architecture decision records (0001 stack, 0002 local network, 0003 PostgreSQL 18 + queues in PostgreSQL, 0004 outbox and exactly-once) |
| [chain/README.md](chain/README.md) | Local Besu network: setup, verified downloads, secrets, production differences |
| [web/README.md](web/README.md) | Investor website prototype: status W1–W5, run commands, flows, hardening, tests, speed |
| [docs/demo-guide.md](docs/demo-guide.md) | 15-minute presenter script, setup and Q&A for team demos |
| [backend/README.md](backend/README.md) | Backend packages, local PostgreSQL 18, commands, supply-chain rules |
| [docs/findings/](docs/findings/) | Security findings with proofs and mitigations |
| [docs/audit/ethtrust-checklist.md](docs/audit/ethtrust-checklist.md) | EthTrust [Q] self-assessment |

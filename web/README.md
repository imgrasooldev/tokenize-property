# Investor website (prototype)

Next.js 16 investor website: a preview of Step 7, built early for team presentations. It runs against the **local** Besu network and ledger with sample properties and test money.

| Part | Scope | Status |
|---|---|---|
| W1 | Properties list and detail, live chain data, NAV and rent charts, English/Urdu (RTL) | Done |
| W2 | Demo investor login, sign-up, mock KYC, on-chain identity registration | Done |
| W3 | Invest (mock bank → ledger → real mint), portfolio, rent self-verification | Done |
| W4 | Demo secondary market: order book, matching, settlement on chain, real-time chart | Done |
| W5 | Hardening, end-to-end tests, speed, presenter tooling, docs | Done |
| 5h | On the backend: reads from the chain index, writes through the outbox and the signing service, sign-up through the KYC service, own database role, no keys | Done (ADR 0010) |

## Run

```bash
python chain/net.py start          # local chain (see chain/README.md)
python backend/scripts/pg.py start  # local PostgreSQL (see backend/README.md)
cd backend && npm ci --ignore-scripts
npm run migrate                    # 0001..0012 (0012 creates schema webdemo and the website's role)
npm run kyc:setup && npm run signer:setup && npm run db:web-role   # once, idempotent; secrets in backend/.env.local
npm run indexer & npm run signer & npm run outbox & npm run kyc:serve &   # the services the website needs
cd ../web && npm ci --ignore-scripts
npm run setup:demo                 # once: creates web/.env.local with random secrets (git-ignored)
npm run dev                        # http://127.0.0.1:3100
```

The website needs the indexer (reads), the signing service and the outbox worker (anything that moves tokens), and the KYC service (sign-up). Without one of them the matching feature says so and nothing moves; it never falls back to signing or reading the chain itself.

## Sign-up and KYC (W2)

- **Personas:** Alice and Bob, pre-verified on chain, for one-click demos. No passwords anywhere; real accounts will use passkeys (NIST AAL2) in Step 7.
- **KYC by the KYC service** (Step 5h): name, CNIC, phone and a simulated liveness session go to the KYC service (`npm run kyc:serve`, ADR 0009) over its HMAC-authenticated API; it runs the mock NADRA, liveness and sanctions checks and derives the status in its own database. Mock NADRA: CNIC ending in `0` = not found, `8` = name mismatch, `9` = service down. One account per CNIC (the website's own check and the KYC service's).
- **Data minimisation:** the website never stores the full CNIC or phone, only the last digits plus an HMAC (secret pepper) for its uniqueness check; the KYC service keeps peppered hashes only. Verified in the database (end-to-end test): no full CNIC in `webdemo` or `kyc`.
- **Real on-chain onboarding through the outbox and the signing service:** the signing service creates the custodial wallet (the website gets the address only), then `identity.create` (identity operator), `identity.add_claim` for KYC and AML (the investor's wallet adds claims signed by the claim key) and `identity.register` (RegistrarGuard). The signer allows each step only for a custodial wallet whose owner the KYC service verified. The account page shows the progress and refreshes itself; a failed step is retried with a new command (at most three times), then marked for operations.
- **No keys in the website** (ADR 0010): the demo signer, the website-held wallet keys and the `WEB_DEMO_SIGNER` opt-in are gone. Alice's and Bob's dev keys are custodial wallets of the signing service (`npm run signer:setup`, local dev chain only); wallets of earlier sign-ups move once with `npm run signer:import-web-wallets`.
- **Own database role:** the website connects as `pt_web_app` (member of `pt_web` only, migration 0012) with the password `npm run db:web-role` puts in `backend/.env.local`; never as the admin, and it runs no DDL.
- **Sessions:** HMAC-signed, HttpOnly, SameSite=Strict, 8 h. Forged or expired cookies redirect to sign-in. Server actions get Next.js's built-in origin check; every input is validated with zod.

## Invest and portfolio (W3)

Flow (`src/lib/server/invest.ts`):

1. **Pre-checks** (server, `src/lib/invest-rules.ts`): KYC-verified in the database **and** registered in the chain index; token not paused; at least 10 tokens; holding (chain index **plus everything still in flight**: open subscriptions and purchases) stays within 100,000 (10% of the register, contract-spec §4.3); supply plus mints in flight stays within the trustee cap. The signing service and the contracts repeat every check against the chain.
2. **Payment (mock Raast), ledger and mint command, in ONE database transaction:** subscription row (`webdemo.subscriptions`, status `minting`), journal `subscription_paid` (debit `web:bank:subscriptions`, credit `web:investor:<id>:subscription`) and the outbox command `issuance.mint` (`web:sub:<id>:mint`). The form carries a `requestId`; a repeated or concurrent submit returns the first subscription and is never charged twice (per-investor lock, unique `request_id`, journal and outbox idempotency keys).
3. **Mint:** the outbox worker has the signing service check the `issuance.mint` policy (target, chain, limits, recipient verified, cap, pause, simulation), wait for **two operators above 10,000 tokens** (`npm run signer:decide`), reserve a nonce and sign with the Issuance Safe key; the worker records the transaction before broadcasting it (ADR 0004/0005). `refId = keccak256("property-token:subscription:<id>")`, single-use on chain (I-11). The website signs nothing.
4. **Settle or refund** (settlement follower, `src/lib/server/follower.ts`, in the website process; one runner at a time; woken by the indexer's `chain_events` and every 2 s): settled (`subscription_settled`) only when the command is confirmed **and** the chain index shows the `Minted` event for that refId **to this wallet for exactly this amount**. Refunded (`subscription_refunded`) only when the command **failed** (final), the refId is unused on chain, and no transaction was recorded or the chain proves the recorded one reverted or was dropped. A command in the outbox's review, or anything that does not match, puts the subscription in `review`; nothing is refunded while an operator could still retry the command. The status change gates the journal, so a row is settled or refunded at most once.
5. **Pending is shown, not hidden:** the receipt and the history say "queued", "awaiting approval" or "confirming on chain" and the page refreshes itself until the chain index shows the mint. Subscriptions from before Step 5h are resolved from the chain index and the chain as before and never sent again (a `paid` one gets its outbox command).

Portfolio (`/portfolio`): balances from the chain index ("as of block N"), investment history with tx hashes and a `refId used` tick from the chain index, four checks (ledger owed = open subscriptions; every issuance confirmed on chain; ledger hash chain intact; escrow matches the order book), and rent.

**Rent:** `python chain/rent.py [rupees]` publishes a distribution: balances at a past block, exact paisa split, Merkle root + total + statement hash on chain, statement with proofs in `chain/data/rent/` (git-ignored). The list comes from the chain index; "Verify my share" is deliberately a fresh chain check: the statement hashes to the on-chain `statementHash`, `DistributionRegistry.verify` accepts the investor's proof, and 1 paisa more is rejected. `npm run rent:book` (backend) books the rent in the ledger for reconciliation (ADR 0010).

**Tests** (`npm run test`): 21 unit tests (pricing, limits at exact boundaries, refId, input validation) and 8 integration tests on the real local chain and the **test** database (`property_token_test`). They start the backend services for the test database themselves (`test/stack.ts`: indexer, signing service on 4901, outbox worker, KYC service on 4911) and onboard a fresh investor per run through the KYC service and the outbox: five concurrent identical submits → one charge, one command, one mint, shown only once indexed; limits refused without taking money; investor not registered refused; a signer refusal → full refund, nothing minted; 10,001 tokens wait for two operators (the requester cannot approve) and mint once approved; a worker that crashes after claiming, plus a pre-5h `paid` row, settle with exactly one mint each; the signer's audit chain stays intact. Integration tests skip when the network is not running (CI).

## Demo secondary market (W4)

**DEMO only:** secondary trading needs SECP approval and a licensed intermediary. The page says so permanently.

- **Cash (demo):** each investor has a PKR cash account in the ledger, funded by demo Raast top-ups (idempotent per request, max Rs 10,000,000 each).
- **Orders** (`/market`, `src/lib/server/market.ts`): limit orders, min 10 tokens, price within **±10% of NAV** (circuit breaker), buyer's committed holding within the 10% limit, no crossing one's own orders. A buy order moves its full cost from cash into its **own escrow account** (`web:order:<id>:escrow`) before it can match; the ledger refuses any overdraft. A sell order can offer only on-chain tokens not already offered or in flight. Placement is serialised per investor (advisory lock).
- **Matching:** price-time priority, trade at the earlier (maker) order's price. One matcher at a time across processes (`pg_try_advisory_lock`); the holder re-checks the book after releasing, so nothing crossing is left behind.
- **Settlement (delivery versus payment), Step 5h:** the matcher records the fills, the trade and an outbox `token.transfer` command in ONE transaction. The signing service signs the transfer with the seller's custodial wallet only while the buyer's escrow holds the trade's cost (policy W-3), to a verified buyer, within limits (two operators above 10,000 tokens); the token re-checks identity, limits, freeze, pause. Only when the chain index shows that transfer does the settlement follower move the cash from the buyer's escrow to the seller. A trade's cost stays in escrow while it is in flight, even if the buy order is cancelled. Refused by the signer or reverted → trade `failed`, both orders cancelled, escrow returned, nothing moved. Anything unknown → `review`. A seller whose wallet is not in custody has the offer cancelled before matching.
- **Real time:** `/api/market/<symbol>/stream` (Server-Sent Events, same origin) pushes the public view (order book, recent trades, 1-minute candles, last price) whenever it changes. No investor identities in the feed. Chart: candles + volume + dashed NAV line, times in Pakistan time.
- **Demo liquidity:** `npm run demo:market -- [rounds] [seconds]` makes Alice and Bob trade through the same code; since Step 5h every delivery goes through the outbox and the signing service (needs the indexer, signer and outbox worker running; the tool runs its own settlement follower), then leaves a few resting orders. On the demo server an optional timer runs a few rounds every four hours (`pt-demo-market.timer`, off by default; deploy/demo-server/README.md).

**Tests:** 28 unit tests for the market rules (price parsing without floats, band edges, cash, holding limit, self-trade, maker price, candles) and 8 integration tests through the outbox and the signing service: idempotent top-up under concurrency; every refusal takes no money; maker-price settlement that stays pending until the transfer is indexed, with exact escrow arithmetic; cancelling a buy order while its trade is in flight keeps that trade's cost in escrow; three racing buyers plus extra matcher runs fill exactly the 20 tokens offered; a pre-5h interrupted trade is undone; a 10,001-token delivery waits for two operators; an investor who loses KYC is frozen through the offboarding worker's outbox command and their trade is refused by the signer and undone completely.

## Hardening, tests and speed (W5)

**Sending transactions safely** is the backend's job since Step 5h (ADR 0010): the outbox records every transaction before it is broadcast and decides after any failure from the database and the chain (ADR 0004); the signing service reserves nonces, applies the policies and keeps the audit (ADR 0005). The W5 rules carry over unchanged: nothing is refunded or undone unless the chain proves the transaction can never execute (no recorded transaction, reverted, or dropped), unknown outcomes go to review, and a status change gates every journal.

**Other hardening** (from an independent review of W3–W4):
- Rate limits (`src/lib/server/rate-limit.ts`): sign-in, sign-up, invest, orders, top-ups, cancels, rent checks; live-feed connections capped per client and in total. Signed-in limits are keyed by investor; `X-Forwarded-For` is trusted only with `TRUST_PROXY=1`. Production limits belong at the edge.
- One shared market snapshot per symbol (0.7 s) for all live-feed viewers; page-load matching throttled; settlement in one background follower per process (one runner across processes); ledger hash-chain check cached for 10 s; database pool with a connection timeout; cancel waits for the matcher without holding a connection.
- Placement counts the chain index plus everything in flight (open orders, settling trades, open subscriptions): a trade or mint stays "in flight" until the index shows it, so it is never missed.
- Sign-up: concurrent duplicates are refused cleanly; a failed on-chain step is retried with a new outbox command (three attempts), then marked for operations.
- Error pages that show only an opaque reference; server-side error log without personal data; HSTS in production builds.
- Event logs are no longer read by the website (the indexer reads them in windows of 4,000 blocks; Besu refuses ranges over 5,000, which had once silently broken the prototype's reconciliation).

**Tests:** `npm run test` (unit + integration on the local chain and test database) and `npm run test:e2e` (11 Playwright tests in the installed Microsoft Edge, against their own server on port 3101, the **test** database and their own backend services started by `test/stack-cli.ts`): security headers, forged sessions, 404s, public-only live feed, sign-up with NADRA failure, KYC and on-chain onboarding through the outbox, no full CNIC in `webdemo` or `kyc`, duplicate CNIC, invest → portfolio checks → rent verification, a trade between two investors seen live by a third window, cancel with escrow return, Urdu and 375 px layouts.

**Speed** (this laptop, production build, median of 7): `/login` 9 ms, `/properties/GPF3` 12 ms, `/market` 30 ms, `/` 32 ms; first live-feed frame 70 ms. A trade or mint settles in about 2–3 s, mostly the 2-second block time. In `next dev` pages take 150–600 ms because of development overhead.

**Presenting:** `python scripts/demo.py up --trade` starts everything and pre-compiles the pages; script and Q&A in [docs/demo-guide.md](../docs/demo-guide.md).

## Public verification page (S-07, T-027)

`/verify`, public, no sign-in, English and Urdu. Source of truth: [docs/specs/S-07-public-verification-page.md](../docs/specs/S-07-public-verification-page.md). Read-only: no write path, no key, no new database object.

| Section | What the page shows | Where the check runs |
|---|---|---|
| Header | "As of block #N" with the cursor block's time (`chain.cursors` + `chain.blocks`). A halted indexer shows "verification paused" with the last good block and **no** figures; a stale one (no progress for 60 s) shows a warning (S-07 §6) | server |
| 3.1 Supply | total supply, trustee cap, paused flag with PauseGuard's reason, holder **count** only (PV-3), token address. Trustee register attestation: **not published yet** (format and frequency open, Q-2), shown grey, never green; the rule (`registerCheck`, green only if equal, any difference a blocking `supply.register_mismatch`) is built and tested | server |
| 3.2 Documents | DocumentRegistry records of the token from the read model (`chain.documents`): type, added block and time, SHA-256, `pt-doc://` reference, superseded by. **Check a file:** SHA-256 with Web Crypto in the browser, matched as current, superseded or none; the file is never sent (e2e checks every request). No public document downloads yet (PV-12) | browser |
| 3.3 Anchors | StateAnchor deployment (`python chain/anchor.py deploy`, chain 586650 locally), the anchor components from schema `anchor`, the committed value read from the anchor chain. The browser recomputes `keccak256(abi.encode(...))` with `src/lib/anchor-commitment.ts`, a byte-identical copy of `@pt/anchor`'s `commitment.ts` (`npm run sync:abis`; CI `cmp`). Honesty statement (PV-22), freshness warning above 2 h (PV-23). "Check an anchor yourself" recomputes any components a visitor enters. **Today:** no anchor chain on the demo server or this laptop ("not available on this server"); where one is deployed, the website's role cannot yet read schema `anchor` ("not readable by the website yet") until a migration grants it; the `anchor:verify` result is not stored ("not recorded") | browser (public value read by the server: the CSP keeps `connect-src 'self'`) |
| 3.4 Distributions | id, status (with reject reason), record block, total, Merkle root, statement hash, published and finalized/paid times, payout batch hash. **Verify an entitlement:** the investor pastes the JSON the portfolio now offers under each rent item ("My entitlement for the public check"); the browser computes leaf and root (`src/lib/merkle.ts`) and the 1-paisa control; the server action `checkProofOnChain` calls `DistributionRegistry.verify` at the cursor block (and +1 paisa). **Check a statement file:** keccak256 in the browser against the statement hash | browser + chain |
| 5 Reconciliation | latest run passed/failed with time, no findings. **Today:** "not available to the website yet" (no read grant on schema `recon`) | server |

- **Privacy:** no holder list, no wallet lookup, no names; the entitlement a visitor pastes is not stored or logged (only the rate-limit counter `publicVerify`, 20 per minute per client address; a chain error logs the error class only). Tests scan the view and the HTML for holder wallets, investor names, CNIC- and phone-shaped numbers.
- **Caching:** one shared view per 2 s for all visitors (anchor and reconciliation reads 30 s), so traffic never multiplies database or RPC load. CSP unchanged; fonts unchanged.
- **Demo documents:** `python chain/document.py add FILE [--type N] [--uri pt-doc://ID]`, `supersede OLD NEW`, `list` record hashes with the local Ops Safe dev key (local chain only, idempotent). The e2e test records two sample public notices (`e2e/fixtures/`), version 2 superseding version 1.
- **Pending (needs the lead):** a migration granting the website role read access to the anchor components (without `raw_tx`) and to the latest reconciliation status only; the trustee attestation source (Q-2); the public L2 and explorer links (Q-1).

**Tests:** unit `merkle.test.ts` (leaf/root against `chain/rent.py` output, +1/-1 paisa, input parsing), `anchor-commitment.test.ts` (shared vector, tampered components, byte-identity with `@pt/anchor`), `verify-rules.test.ts` (Web Crypto SHA-256 vs Node, document match, register rule, freshness, read-model gate, EN/UR text parity); integration `verify.integration.test.ts` (every figure equals the contract views at the cursor block; no grant on `anchor`/`recon` shown as such; on-chain proof valid and +1 paisa refused; no holder wallet or name in the view); e2e `verify.spec.ts` (file current/superseded/tampered with no upload, anchor recompute match/tampered, entitlement valid and +1 paisa in the browser and on chain, EN and Urdu at 375 px and 1440 px, no personal data in the HTML).

## Design (v2, 2026-10-12)

The site follows the approved v2 design: `docs/design/mockup-home-v2.html` (main source) and `docs/design/v2-suite/` for the other screens, with the ticker strip, "bank to blockchain" flow, rent proof, returns calculator and final call to action from `mockup-home-v11.html`, and dashboard density from `mockup-home-v7.html`. The mockups are read-only references; nothing in `docs/design/` is used at runtime.

| Page | Mockup | Shell |
|---|---|---|
| `/` | mockup-home-v2 (+ v11 parts) | public: live status rail + navigation |
| `/properties` (new list page) | site-properties | public |
| `/properties/[symbol]` (detail + invest form) | site-property, portal-invest | public |
| `/login`, `/signup` | site-login, site-signup | public (minimal header) |
| `/portfolio` (with rent and proofs at `#rent`) | portal-dashboard, portal-rent | investor app (sidebar) |
| `/market` | portal-market | investor app when signed in, public otherwise |
| `/account` | investor portal page | investor app |
| `/verify` (public verification, S-07) | v2 panels, tables and chips (no dedicated mockup) | public |

- **Real data only.** The status rail, block row, ticker, home stats, hero cards and events come from the chain index and the database: `src/lib/server/pulse.ts` (latest blocks and QBFT validator count from the node, one shared value per second; token supply and cap from the chain index; ledger hash-chain check) served publicly at `GET /api/chain/pulse` (no personal data, one shared value per second, stale-while-revalidate so pages never wait), and `src/lib/server/site-stats.ts` (verified investors, settled trades, latest issuance and trade without identities, rent distributions on chain).
- **Everything that is not real is labelled.** AI analyst answers, AI risk scores (`src/lib/sample-ai.ts`), the map, document hashes and the trust-structure card carry a visible "Sample" chip; features not built yet (AI search box, passkeys, bank linking, tax certificate, filters, public anchor) carry "Coming soon" and are disabled. AI text always says it is informational and never investment advice. Catalogue figures stay marked "Sample property".
- **Fonts** are self-hosted with `next/font/local` (`src/app/fonts.ts`): Latin subsets of Inter, Space Grotesk and JetBrains Mono, and the Arabic subset of Noto Nastaliq Urdu, all from the `@fontsource-variable/*` 5.3.0 packages under the SIL Open Font License 1.1 (files and licences in `src/fonts/`; no new npm dependency). Nastaliq is not preloaded and is used only in Urdu mode, so English pages never download it. The CSP is unchanged (`font-src 'self'`, no external URLs, no inline scripts).
- **Motion** lives in client components (`src/components/live/`): one network canvas (max 36 nodes, DPR capped at 1.5, about 30 fps, stops when hidden or off screen), CSS-only ticker (pauses on hover/focus), count-up figures, and 2-second polling of the pulse while the tab is visible. `prefers-reduced-motion` turns all animation off (the canvas draws one still frame; the ticker becomes a static, scrollable row). The aurora background uses soft gradients with a transform animation only (no blur filter); cards avoid `backdrop-filter`.
- **Urdu:** RTL layout uses logical CSS properties throughout; Nastaliq with taller line heights and no letter-spacing (it breaks Arabic joins).
- **Weight** (production build, first visit, English home, 1440 px): 307 KB transferred before → 297 KB after; JavaScript 461 KB → 478 KB decoded. The first Urdu visit adds the 239 KB Nastaliq font (Naskh before: about 30–45 KB). Server time (median of 9, this laptop): `/login` 15 ms, `/properties` 20 ms, `/properties/GPF3` 26 ms, `/market` 39 ms, `/` 46 ms (was 32 ms; the page now carries the full v2 home), `/api/chain/pulse` 11 ms.

## Security

- Per-request nonce-based Content-Security-Policy (`src/proxy.ts`); `X-Frame-Options: DENY`, `nosniff`, `no-referrer`, restrictive `Permissions-Policy`, no `X-Powered-By`.
- Binds to 127.0.0.1 in dev and start scripts; `robots: noindex`.
- Route parameters are matched against the property catalogue before anything else (unknown symbol → 404).
- Same supply-chain rules as the backend (`.npmrc`: exact versions, no install scripts; `npm audit` gate). `eslint-config-next` was dropped because its dependency tree carried a high-severity `braces` advisory; linting uses strict type-checked TypeScript rules plus `eslint-plugin-security`.
- Charts use TradingView `lightweight-charts` (Apache-2.0); its attribution logo stays enabled as the licence asks.

All properties are labelled **Sample property** and the site shows a permanent prototype banner.

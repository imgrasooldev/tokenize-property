# Investor website (prototype)

Next.js 16 investor website: a preview of Step 7, built early for team presentations. It runs against the **local** Besu network and ledger with sample properties and test money.

| Part | Scope | Status |
|---|---|---|
| W1 | Properties list and detail, live chain data, NAV and rent charts, English/Urdu (RTL) | Done |
| W2 | Demo investor login, sign-up, mock KYC, on-chain identity registration | Done |
| W3 | Invest (mock bank → ledger → real mint), portfolio, rent self-verification | Done |
| W4 | Demo secondary market: order book, matching, settlement on chain, real-time chart | Done |
| W5 | Hardening, end-to-end tests, speed, presenter tooling, docs | Done |

## Run

```bash
python chain/net.py start          # local chain (see chain/README.md)
python backend/scripts/pg.py start  # local PostgreSQL (see backend/README.md)
cd web && npm ci --ignore-scripts
npm run setup:demo                 # once: creates web/.env.local with random secrets (git-ignored)
npm run dev                        # http://127.0.0.1:3100
```

## Sign-up and KYC (W2)

- **Personas:** Alice and Bob, pre-verified on chain, for one-click demos. No passwords anywhere; real accounts will use passkeys (NIST AAL2) in Step 7.
- **Mock KYC:** name, CNIC, phone, simulated liveness. Mock NADRA rejects CNICs ending in `0` to show the failure path. One account per CNIC.
- **Data minimisation:** the full CNIC and phone are never stored, only the last digits plus an HMAC (secret pepper) for the uniqueness check. Verified in the database: no full CNIC or phone anywhere.
- **Real on-chain onboarding:** a new custodial wallet, then an ONCHAINID (identity operator), then KYC and AML claims signed by the claim signer, then RegistrarGuard registration. This is the same path the contract tests prove. Wallet keys are encrypted with AES-256-GCM (HSM/MPC in production).
- **Demo signer** (`src/lib/server/demo-signer.ts`): uses local dev keys only, refuses production builds and any chain other than 586586, and checks the chain ID before every signature. The one exception is the private IP demo server (`deploy/demo-server`), which runs a production build with the explicit opt-in `WEB_DEMO_SIGNER=1`; the chain-ID check still applies there. Step 5d's signing service replaces it.
- **Sessions:** HMAC-signed, HttpOnly, SameSite=Strict, 8 h. Forged or expired cookies redirect to sign-in. Server actions get Next.js's built-in origin check; every input is validated with zod.

## Invest and portfolio (W3)

Flow (`src/lib/server/invest.ts`):

1. **Pre-checks** (server, `src/lib/invest-rules.ts`): KYC-verified in the database **and** `isVerified` on chain; token not paused; at least 10 tokens; holding stays within 100,000 (10% of the register, contract-spec §4.3); supply stays within the trustee cap. The contracts repeat every check.
2. **Payment (mock Raast) and ledger, in one database transaction:** subscription row (`webdemo.subscriptions`) plus journal `subscription_paid` (debit `web:bank:subscriptions`, credit `web:investor:<id>:subscription`). The form carries a `requestId`; a repeated or concurrent submit returns the first subscription and is never charged twice (unique `request_id`, journal idempotency keys).
3. **Mint:** the row is claimed atomically (`paid → minting`), then `IssuanceGuard.mint(wallet, tokens, refId)` with `refId = keccak256("property-token:subscription:<id>")`, single-use on chain (I-11). Demo signer: local `ISSUANCE_SAFE` key; in production the trustee co-signs.
4. **Settle or refund:** confirmed → `subscription_settled` (investor liability → `web:property:<symbol>:capital`). A refund (`subscription_refunded`) is posted **only** when the mint provably never happened: refused before broadcast (simulation) or mined and reverted. Any unknown outcome (timeout, RPC error) goes to `review`; the status change gates the journal, so a row is settled or refunded at most once.
5. **Reconciliation** (on every portfolio visit): `review` rows settle only when the chain shows a `Minted` event for that refId **to this wallet for exactly this amount**; mismatches stay in review for operations. Stale `paid` rows (never broadcast) are minted; stale `minting` rows go to review.

Portfolio (`/portfolio`): live balances, investment history with tx hashes and an on-chain `refUsed` tick, three reconciliation checks (ledger owed = open subscriptions; every issuance confirmed on chain; ledger hash chain intact), and rent.

**Rent:** `python chain/rent.py [rupees]` publishes a distribution: balances at a past block, exact paisa split, Merkle root + total + statement hash on chain, statement with proofs in `chain/data/rent/` (git-ignored). "Verify my share" checks that the statement hashes to the on-chain `statementHash`, that `DistributionRegistry.verify` accepts the investor's proof, and that 1 paisa more is rejected.

**Tests** (`npm run test`): 21 unit tests (pricing, limits at exact boundaries, refId, input validation) and 7 integration tests on the real local chain and the **test** database (`property_token_test`), with a freshly onboarded investor per run: five concurrent identical submits → one charge and one mint; limits refused without taking money; investor not registered on chain refused; chain refusal (reused refId) → full refund, nothing minted; reconcile settles only a matching mint, and leaves wrong-amount and unknown cases in review. Integration tests skip when the network is not running (CI).

## Demo secondary market (W4)

**DEMO only:** secondary trading needs SECP approval and a licensed intermediary. The page says so permanently.

- **Cash (demo):** each investor has a PKR cash account in the ledger, funded by demo Raast top-ups (idempotent per request, max Rs 10,000,000 each).
- **Orders** (`/market`, `src/lib/server/market.ts`): limit orders, min 10 tokens, price within **±10% of NAV** (circuit breaker), buyer's committed holding within the 10% limit, no crossing one's own orders. A buy order moves its full cost from cash into its **own escrow account** (`web:order:<id>:escrow`) before it can match; the ledger refuses any overdraft. A sell order can offer only on-chain tokens not already offered or in flight. Placement is serialised per investor (advisory lock).
- **Matching:** price-time priority, trade at the earlier (maker) order's price. One matcher at a time across processes (`pg_try_advisory_lock`); the holder re-checks the book after releasing, so nothing crossing is left behind.
- **Settlement (delivery versus payment):** trade and fills recorded → seller's custodial wallet `transfer`s the tokens on chain (the token re-checks identity, limits, freeze, pause) → only after confirmation, cash moves from the buyer's escrow to the seller. Unused escrow (bought below the limit) returns to cash when the order ends. Refused before broadcast or reverted → trade `failed`, both orders cancelled, escrow returned, nothing moved. Unknown outcome → `review`, resolved later from the transaction receipt.
- **Real time:** `/api/market/<symbol>/stream` (Server-Sent Events, same origin) pushes the public view (order book, recent trades, 1-minute candles, last price) whenever it changes. No investor identities in the feed. Chart: candles + volume + dashed NAV line, times in Pakistan time.
- **Demo liquidity:** `npm run demo:market -- [rounds] [seconds]` makes Alice and Bob trade through the same code (every trade settles on chain), then leaves a few resting orders.

**Tests:** 28 unit tests for the market rules (price parsing without floats, band edges, cash, holding limit, self-trade, maker price, candles) and 5 integration tests: idempotent top-up under concurrency; every refusal takes no money; maker-price settlement with tokens first and exact escrow arithmetic; three racing buyers plus extra matcher runs fill exactly the 20 tokens offered; a frozen seller's trade is undone completely.

## Hardening, tests and speed (W5)

**Sending transactions safely** (`src/lib/server/demo-signer.ts`): every send is simulate → take a per-signer lock (PostgreSQL advisory lock in the `postgres` database, shared by the website, the demo script and the tests) → pick the nonce → sign locally → **record the hash and nonce in the database** → broadcast. Consequences:
- Two concurrent senders never reuse a nonce.
- After any crash or timeout the outcome is decided from the chain: mined → settle; reverted, or **dropped** (the signer's nonce moved past it) → refund / undo; no recorded hash → nothing was ever sent → refund / undo. A late sender cannot record (the row is no longer in its sending state), so it never broadcasts after a refund.
- Market: a review trade is resolved the same way; if the chain or an investor record is unavailable before sending, the match is undone and both orders stay open; a missing seller key cancels only the sell order.

**Other hardening** (from an independent review of W3–W4):
- Rate limits (`src/lib/server/rate-limit.ts`): sign-in, sign-up, invest, orders, top-ups, cancels, rent checks; live-feed connections capped per client and in total. Signed-in limits are keyed by investor; `X-Forwarded-For` is trusted only with `TRUST_PROXY=1`. Production limits belong at the edge.
- One shared market snapshot per symbol (0.7 s) for all live-feed viewers; page-load matching and reconciliation throttled; ledger hash-chain check cached for 10 s; database pool with a connection timeout; cancel waits for the matcher without holding a connection.
- Placement reads the order book before the chain balance (a settling trade can only be double-counted, never missed).
- Sign-up: a failed on-chain registration removes the pending record, so the same person can retry; concurrent duplicates are refused cleanly.
- Error pages that show only an opaque reference; server-side error log without personal data; HSTS in production builds.
- Event-log reads go in windows of 4,000 blocks (Besu refuses ranges over 5,000); this had silently broken reconciliation once the chain passed 5,000 blocks.

**Tests:** `npm run test` (67: unit + integration on the local chain and test database) and `npm run test:e2e` (11 Playwright tests in the installed Microsoft Edge, against their own server on port 3101 and the **test** database): security headers, forged sessions, 404s, public-only live feed, sign-up with NADRA failure and duplicate CNIC, invest → portfolio checks → rent verification, a trade between two investors seen live by a third window, cancel with escrow return, Urdu and 375 px layouts.

**Speed** (this laptop, production build, median of 7): `/login` 9 ms, `/properties/GPF3` 12 ms, `/market` 30 ms, `/` 32 ms; first live-feed frame 70 ms. A trade or mint settles in about 2–3 s, mostly the 2-second block time. In `next dev` pages take 150–600 ms because of development overhead.

**Presenting:** `python scripts/demo.py up --trade` starts everything and pre-compiles the pages; script and Q&A in [docs/demo-guide.md](../docs/demo-guide.md).

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

- **Real data only.** The status rail, block row, ticker, home stats, hero cards and events come from the chain and the test database: `src/lib/server/pulse.ts` (latest blocks, QBFT validator count, live token price and supply, ledger hash-chain check) served publicly at `GET /api/chain/pulse` (no personal data, one shared value per second, stale-while-revalidate so pages never wait), and `src/lib/server/site-stats.ts` (verified investors, settled trades, latest issuance and trade without identities, rent distributions on chain).
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

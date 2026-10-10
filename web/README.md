# Investor website (prototype)

Next.js 16 investor website: a preview of Step 7, built early for team presentations. It runs against the **local** Besu network and ledger with sample properties and test money.

| Part | Scope | Status |
|---|---|---|
| W1 | Properties list and detail, live chain data, NAV and rent charts, English/Urdu (RTL) | Done |
| W2 | Demo investor login, sign-up, mock KYC, on-chain identity registration | Done |
| W3 | Invest (mock bank → ledger → real mint), portfolio, rent self-verification | Done |
| W4 | Demo secondary market: order book, matching, settlement on chain, real-time chart | Done |
| W5 | Polish, end-to-end tests, docs | Next |

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
- **Demo signer** (`src/lib/server/demo-signer.ts`): uses local dev keys only, refuses production builds and any chain other than 586586, and checks the chain ID before every signature. Step 5d's signing service replaces it.
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

## Security

- Per-request nonce-based Content-Security-Policy (`src/proxy.ts`); `X-Frame-Options: DENY`, `nosniff`, `no-referrer`, restrictive `Permissions-Policy`, no `X-Powered-By`.
- Binds to 127.0.0.1 in dev and start scripts; `robots: noindex`.
- Route parameters are matched against the property catalogue before anything else (unknown symbol → 404).
- Same supply-chain rules as the backend (`.npmrc`: exact versions, no install scripts; `npm audit` gate). `eslint-config-next` was dropped because its dependency tree carried a high-severity `braces` advisory; linting uses strict type-checked TypeScript rules plus `eslint-plugin-security`.
- Charts use TradingView `lightweight-charts` (Apache-2.0); its attribution logo stays enabled as the licence asks.

All properties are labelled **Sample property** and the site shows a permanent prototype banner.

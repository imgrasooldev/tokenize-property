# Investor website (prototype)

Next.js 16 investor website: a preview of Step 7, built early for team presentations. It runs against the **local** Besu network and ledger with sample properties and test money.

| Part | Scope | Status |
|---|---|---|
| W1 | Properties list and detail, live chain data, NAV and rent charts, English/Urdu (RTL) | Done |
| W2 | Demo investor login, sign-up, mock KYC, on-chain identity registration | Next |
| W3 | Invest (mock bank → ledger → real mint), portfolio | Planned |
| W4 | Demo secondary market: order book, matching, settlement on chain, real-time chart | Planned |
| W5 | Polish, end-to-end tests, docs | Planned |

## Run

```bash
python chain/net.py start          # local chain (see chain/README.md)
cd web && npm ci --ignore-scripts
npm run dev                        # http://127.0.0.1:3100
```

## Security

- Per-request nonce-based Content-Security-Policy (`src/proxy.ts`); `X-Frame-Options: DENY`, `nosniff`, `no-referrer`, restrictive `Permissions-Policy`, no `X-Powered-By`.
- Binds to 127.0.0.1 in dev and start scripts; `robots: noindex`.
- Route parameters are matched against the property catalogue before anything else (unknown symbol → 404).
- Same supply-chain rules as the backend (`.npmrc`: exact versions, no install scripts; `npm audit` gate). `eslint-config-next` was dropped because its dependency tree carried a high-severity `braces` advisory; linting uses strict type-checked TypeScript rules plus `eslint-plugin-security`.
- Charts use TradingView `lightweight-charts` (Apache-2.0); its attribution logo stays enabled as the licence asks.

All properties are labelled **Sample property** and the site shows a permanent prototype banner.

# Investor website (prototype)

Next.js 16 investor website: a preview of Step 7, built early for team presentations. It runs against the **local** Besu network and ledger with sample properties and test money.

| Part | Scope | Status |
|---|---|---|
| W1 | Properties list and detail, live chain data, NAV and rent charts, English/Urdu (RTL) | Done |
| W2 | Demo investor login, sign-up, mock KYC, on-chain identity registration | Done |
| W3 | Invest (mock bank → ledger → real mint), portfolio | Next |
| W4 | Demo secondary market: order book, matching, settlement on chain, real-time chart | Planned |
| W5 | Polish, end-to-end tests, docs | Planned |

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

## Security

- Per-request nonce-based Content-Security-Policy (`src/proxy.ts`); `X-Frame-Options: DENY`, `nosniff`, `no-referrer`, restrictive `Permissions-Policy`, no `X-Powered-By`.
- Binds to 127.0.0.1 in dev and start scripts; `robots: noindex`.
- Route parameters are matched against the property catalogue before anything else (unknown symbol → 404).
- Same supply-chain rules as the backend (`.npmrc`: exact versions, no install scripts; `npm audit` gate). `eslint-config-next` was dropped because its dependency tree carried a high-severity `braces` advisory; linting uses strict type-checked TypeScript rules plus `eslint-plugin-security`.
- Charts use TradingView `lightweight-charts` (Apache-2.0); its attribution logo stays enabled as the licence asks.

All properties are labelled **Sample property** and the site shows a permanent prototype banner.

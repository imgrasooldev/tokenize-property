# API Contracts

- Audited commit: `main` @ `41241b3` (2026-10-13). Every contract below is **Verified** from the named source file. There is no public REST API for investors; the website uses Next.js pages and server actions.
- Flows that use these interfaces: [FLOW_DIAGRAMS.md](FLOW_DIAGRAMS.md).

## 1. Website pages (`web/src/app`)

| Route | Auth | Notes |
|---|---|---|
| `/` | public | home; live data from the pulse |
| `/properties` | public | catalogue from `web/src/lib/properties.ts` (GPF3 live; DHA6, BAO2 coming soon) |
| `/properties/[symbol]` | public; invest form needs a session | unknown symbol -> 404 |
| `/login` | public | `?e=rate` shows the rate-limit message |
| `/signup` | public | sign-up form (`signUp` action) |
| `/portfolio` | session, else redirect `/login` | `?sub=<subscriptionId>` highlights a subscription; rent at `#rent` |
| `/market` | public view; trading needs a session | demo market |
| `/account` | session, else redirect `/login` | |

Global: per-request CSP nonce and security headers from `web/src/proxy.ts` (matcher excludes `_next/static`, `_next/image`, `favicon.ico`); `error.tsx` shows an opaque reference; `not-found.tsx`.

## 2. Website API routes

### `GET /api/chain/pulse`

- Source: `web/src/app/api/chain/pulse/route.ts`, type `Pulse` in `web/src/lib/pulse-view.ts`.
- Auth: none (public, same origin by CSP). Response `200 application/json`, `Cache-Control: no-store`.
- Body: `{ ok, at, blocks: [{number, hash, time, txs}], blockSeconds, validators, market: {symbol, nav, last, supply, cap, address} | null, ledgerOk }`. No personal data. `ok: false` when the chain cannot be read; `ledgerOk: null` when the database is unreachable.

### `GET /api/market/[symbol]/stream`

- Source: `web/src/app/api/market/[symbol]/stream/route.ts`, type `MarketView` in `web/src/lib/market-view.ts`.
- Auth: none. Server-Sent Events, `text/event-stream`.
- Errors: `404 Not found` unless the symbol is a live property; `429 Too many live connections` with `Retry-After: 30` (per client and global caps; `X-Forwarded-For` trusted only with `TRUST_PROXY=1`).
- Events: `event: market` with `MarketView` JSON `{version, bids, asks, trades, candles, last, volume24h}` when the snapshot version changes (polled every 1 s); `: keep-alive` comment every 15 s; the server closes after 5 minutes (EventSource reconnects).

## 3. Server actions (`web/src/app/actions`)

All are POSTs through Next.js server actions (built-in origin check). Errors are returned as state objects, never thrown to the client; unexpected errors are logged server-side (`logError`) and returned as `generic`.

| Action | File | Auth | Input (FormData) | Output |
|---|---|---|---|---|
| `loginAsPersona` | `auth.ts` | none; rate `login` per client | `persona` = `ALICE` or `BOB` | redirect `/account`; `/login?e=rate`; unknown persona throws |
| `logout` | `auth.ts` | none | none | clears cookie, redirect `/` |
| `signUp` | `auth.ts` | none; rate `signup` | `fullName` (letters, 2-80), `cnic` `12345-1234567-1`, `phone` `03xx-xxxxxxx`, `liveness`=`on`, `consent`=`on` | redirect `/account`, or `{fields}` (validation) or `{error: rate, nadra, duplicate, generic, chain}` |
| `invest` | `invest.ts` | session, else redirect `/login`; rate `invest` per investor | `symbol`, `tokens` (1-7 digits), `requestId` (uuid v4), `bankConfirm`=`on` | redirect `/portfolio?sub=<id>`, or `{error}`: `input`, `rate`, `unverified`, `notLive`, `chain`, `generic`, or an order problem `min`, `maxHolding`, `cap`, `paused` (`web/src/lib/invest-rules.ts`) |
| `placeOrderAction` | `market.ts` | session; rate `order` | `symbol`, `side` buy/sell, `price` (rupees), `tokens` (1-6 digits), `requestId` | `{ok: true}` or `{error}`: `input`, `rate`, `generic`, `unverified`, `notLive`, `paused`, `chain`, or a market order problem `min`, `maxOrder`, `band`, `maxHolding`, `noTokens`, `noCash`, `selfTrade` (`web/src/lib/market-rules.ts`) |
| `topUpAction` | `market.ts` | session; rate `topup` | `amount` whole rupees (<= `MAX_TOPUP_PAISA`), `requestId`, `bankConfirm`=`on` | `{ok: true}` or `{error: input, rate, generic}` |
| `cancelOrderAction` | `market.ts` | session; rate `cancel` | `orderId` uuid | void (revalidates `/market`) |
| `verifyRent` | `rent.ts` | session; rate `verify` | `distributionId` 1-9 digits | `{done, statementMatches, proofValid, tamperedRejected}` or `{done, error: none, chain, rate}` |

Idempotency: `requestId` is unique per subscription, top-up and order (`webdemo` unique constraints), so a repeated submit returns the first result.

Session cookie: `pt_session` = `<investorId>.<expiry>.<hmac>`, HttpOnly, SameSite=Strict, 8 h, `Secure` in production unless `WEB_PLAIN_HTTP=1` (`web/src/lib/server/session.ts`).

## 4. Signing service HTTP API

- Source: `backend/packages/signer/src/http.ts`; started by `npm run signer` on `127.0.0.1:${SIGNER_PORT:-4900}`.
- Auth (every POST): headers `x-pt-client` (client id), `x-pt-ts` (13-digit ms), `x-pt-nonce` (32 hex), `x-pt-sig` = hex HMAC-SHA256(secret, `METHOD\nPATH\nTS\nNONCE\nsha256(body)`). Clock skew max 30 s; nonce single-use per client (replay refused). Body max 32 KB, `content-type: application/json`.

| Method and path | Body | 200 response |
|---|---|---|
| `GET /v1/health` | none (no auth) | `{ok: true}` |
| `POST /v1/sign` | `{commandRef (8-200), kind: issuance.mint, compliance.freeze or rent.record_payout, payload: object}` | one of `{status: denied, requestId?, reason}`, `{status: pending_approval, requestId, approvalsNeeded}`, `{status: signed, requestId, raw, hash, nonce, from}`, `{status: broadcast, requestId, hash, nonce, from}` (bigints as strings) |
| `POST /v1/broadcast` | `{requestId: uuid}` | `{ok: boolean}` |
| `POST /v1/release` | `{requestId: uuid}` | `{ok: boolean}` |

Payload schemas (`backend/packages/signer/src/policy.ts`): mint `{issuance, to, amount (decimal string), refId (bytes32)}`; freeze `{freezeGuard, account, caseId}`; record payout `{registry, distributionId, payoutBatchHash}`.

Errors (body `{error}`): `404 not_found`, `415 json_only`, `413 too_large`, `401 unauthorized`, `400 bad_json`, `400 bad_request` (schema), `500 internal` (never echoes details). Client: `SignerClient` in the same file (20 s timeout).

## 5. Bank webhook

- Source: `backend/packages/bank/src/webhook.ts`, handler `BankService.handle` in `backend/packages/bank/src/service.ts`; `npm run bank` on `127.0.0.1:${BANK_PORT:-4910}`.
- Auth: header `x-pt-bank-signature: t=<13-digit ms>,kid=<key id>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`; 5-minute window; several keys for rotation. Body max 16 KB, JSON only. The real bank's scheme is Unknown; this is the mock contract.

| Method and path | Body | Responses |
|---|---|---|
| `GET /v1/health` | none | `200 {ok: true}` |
| `POST /v1/bank/events` | `credit.received`: `{id, type, createdAt, data: {raastRef, amountPaisa (string), valueDate, payer: {iban, title}, narration}}` or `payout.returned`: `{id, type, createdAt, data: {batchReference PTPAY-..., lineNo, returnRef, amountPaisa, reason}}` (strict objects) | `200 {status: processed or duplicate, outcome?}`; `409 {status: conflict}` (same id, other body); `400 {error: bad_event}`; `422 {error: rejected}` (database refused: SQLSTATE 23514 or P0002); `401 unauthorized`; `404`, `413`, `415`; `500 {error: internal}` (bank retries; event id keeps it harmless) |

Payment codes `PT-XXXX-XXXX` (Crockford base32) in the narration match a credit to an open payment intent; anything else goes to suspense.

## 6. Live Demo Console

- Source: `backend/packages/demo-console/src/server.ts`; `npm run demo`, bound to `127.0.0.1:4800`, local presentation tool only.
- Every request: `Host` must be an allowed local host name, else `403 forbidden host` (DNS rebinding).

| Method and path | Contract |
|---|---|
| `GET /` | HTML with per-response CSP nonce and an embedded per-run token |
| `GET /stream` | SSE of console state and `busy` events |
| `POST /api/action` | needs same `Origin` and header `x-demo-token`, else `403`; body <= 1 KB `{action, node?}`; actions: `scenario`, `network-start`, `network-stop`, `node-stop`, `node-start` (node 1-4), `rent-cycle`, `tamper-demo`; `409 {error: busy: ...}` while one runs; `400 bad request`; `202 {accepted: action}` |

## 7. CLIs (operator interface today)

There is no operator UI on `main`. Maker-checker decisions are CLI commands in `backend/package.json`: `signer:decide`, `recon:unfreeze --request|--approve`, `recon:register-account`, `recon:import-bank`, `kyc:status`, `kyc:offboard`, audits (`signer:audit`, `kyc:audit`, `bank:audit`, `anchor:verify`, `indexer:verify`). KYC clearances and payout batch decisions exist as library functions (`decideClearance`, `decidePayoutBatch`) with no CLI command (Verified: not in `backend/package.json` scripts).

Property onboarding (spec S-01, branch `t-021-property-onboarding`): `property:run -- <action> '<json>'` (or `@file.json`) runs one workflow operation; the input is validated by the same zod schema the service uses (`ACTIONS` in `backend/packages/property/src/service.ts`; `property:run -- actions` lists them). Output is one JSON line: `{"ok":true,"result":…}` (exit 0) or, on stderr, `{"ok":false,"code":"INVALID_INPUT|FORBIDDEN|GUARD|DUPLICATE|NOT_FOUND","error":…}` (exit 4). Every input names the acting officer (`actor`, `officer`, `reviewer`, `chair`, `member` or `trustee`); the database checks that officer's duty. Also `property:show -- sponsor|property <id>`, `property:queue`, `property:audit` (exit 3 on a problem), `property:expire [actor]`, `property:setup` (local dev secrets).

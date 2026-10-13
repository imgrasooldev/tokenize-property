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
| `/verify` | public (no sign-in) | S-07 public verification page (T-027): supply, trustee cap, pause reason and holder count as of the indexer cursor; DocumentRegistry records with a browser-only SHA-256 file check; anchors (or why they are not available); rent distributions with a browser + on-chain entitlement check; latest reconciliation result (or why not available). Server data from `web/src/lib/server/verify.ts` (`verificationView`, one shared value per 2 s; anchors and reconciliation 30 s). Read-only. |

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
| `checkProofOnChain` | `verify.ts` | none (public page `/verify`); rate `publicVerify` (20, 20/min) per client address | one string: entitlement JSON `{distributionId, wallet, amountPaisa, proof}` (strict, `web/src/lib/merkle.ts` `entitlementInput`; amount integer paisa; at most 64 proof hashes; at most 20,000 characters) | `{ok: true, valid, controlRejected, block}` (`DistributionRegistry.verify` at the read model's cursor block, and the same proof with 1 paisa more) or `{ok: false, error: rate, input, paused, chain}`. Nothing entered is stored or logged (S-07 PV-33); a chain error logs the error class only |

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
| `POST /v1/custody/wallets` | `{}` | `{address}` (custodial wallet created inside the key provider, ADR 0010) |
| `POST /v1/requests/preview` (Step 6b) | `{requestId: uuid}` | `{requestId, status, call, problem, live}`: `call` = CallPreview v1 `{kind, chainId, policyId, policyVersion, from, to, contract, functionName, args: [{name, type, value}] decoded from the calldata, data (null only for identity.add_claim), selector, gasLimit, payloadHash, callHash, rules[], note}`; `live` = `{state: pass, fail, unavailable or skipped, reason, approvalsNeeded}`; `404 {error: not_found}` for an unknown request. Read-only: nothing is signed, reserved or audited |
| `POST /v1/decide` (Step 6b) | `{requestId: uuid, decision: approve or reject, reason (10-500), ticket (43 base64url), callHash (64 hex)}` | `{status: pending_approval, approved, rejected or expired}` or `{status: refused, reason}` (call changed since review, ticket invalid/used/expired, stale step-up, maker-checker, unknown request) |

Client scopes (`@pt/http-auth`): `outbox-worker` = sign, broadcast, release; `web` = custody wallets; `admin-portal` = requests/preview and decide only (secret `SIGNER_CLIENT_SECRET_ADMIN`, `npm run signer:admin-client`). An authenticated client outside its scope gets `403 {error: forbidden}`. The call hash is SHA-256 over `["pt-signer-call-v1", requestId, kind, chainId, policyId, policyVersion, from, to, data, gasLimit, payloadHash]` (JSON); `/v1/decide` recomputes it and refuses a decision taken on another call. The ticket is issued by `admin.issue_signer_ticket` (admin database) and redeemed by `signer.decide_officer` (migration 0016).

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

Before Step 6b there was no operator UI (see section 8 for the portal). Maker-checker decisions are also CLI commands in `backend/package.json`: `signer:decide`, `recon:unfreeze --request|--approve`, `recon:register-account`, `recon:import-bank`, `kyc:status`, `kyc:offboard`, audits (`signer:audit`, `kyc:audit`, `bank:audit`, `anchor:verify`, `indexer:verify`). KYC clearances and payout batch decisions exist as library functions (`decideClearance`, `decidePayoutBatch`) with no CLI command (Verified: not in `backend/package.json` scripts).

Property onboarding (spec S-01, branch `t-021-property-onboarding`): `property:run -- <action> '<json>'` (or `@file.json`) runs one workflow operation; the input is validated by the same zod schema the service uses (`ACTIONS` in `backend/packages/property/src/service.ts`; `property:run -- actions` lists them). Output is one JSON line: `{"ok":true,"result":…}` (exit 0) or, on stderr, `{"ok":false,"code":"INVALID_INPUT|FORBIDDEN|GUARD|DUPLICATE|NOT_FOUND","error":…}` (exit 4). Every input names the acting officer (`actor`, `officer`, `reviewer`, `chair`, `member` or `trustee`); the database checks that officer's duty. Also `property:show -- sponsor|property <id>`, `property:queue`, `property:audit` (exit 3 on a problem), `property:expire [actor]`, `property:setup` (local dev secrets).

Offering lifecycle (spec S-02, task T-020): `offering:run -- <action> '<json>'` (or `@file.json`; `offering:run -- actions` lists them; `ACTIONS` in `backend/packages/offering/src/service.ts`) with the same output and exit codes as `property:run` (`OfferingError` codes `INVALID_INPUT|FORBIDDEN|GUARD|DUPLICATE|NOT_FOUND`, exit 4). Officer actions name the officer (`actor` or `officer`); investor actions (`acceptDocument`, `reserve`, `cancel`, `withdraw`) name the KYC subject and the portal's actor; `reserve` returns `{subscriptionId, refId, state, units, amountPaisa, paymentCode, expiresAt, reason}` (payment code `PT-XXXX-XXXX` for the Raast narration; `reason` is investor-safe). Also `offering:show -- <offeringId>`, `offering:queue`, `offering:tick [-- <offeringId>]` (the scheduled clock: opens, expires, promotes, closes, proposes outcomes, settles), `offering:audit` (exit 3 on a problem). Refunds are sent by library function `executeApprovedRefunds(pool, bankGateway, offeringId, actor)` (records first, then instructs the bank); no CLI command, because the CLI has no bank connection.

Step 6b (migration 0016): command-line operator names that are the handle of an admin-portal officer are refused for signer approvals, unfreeze requests and decisions, and payout batches created, decided or submitted (officers decide in the portal); an S-01 duty (`requestDuty`) needs an officer of the portal with a matching role (see ADR 0011 section 10).

## 8. Internal portal (`admin/`, Step 6a and 6b)

- Source: `admin/src/app`; every route and its access rule is listed in `admin/src/lib/routes.ts` (a unit test checks it equals the files, the HTTP matrix exercises each route for every role, anonymous visitors and an investor cookie). Bound to `127.0.0.1:3300`; officers use `http://localhost:3300` (SSH tunnel).
- Every POST: same origin (or `Origin: null` with `Sec-Fetch-Site: same-origin`), session cookie `__Host-pt_admin`, CSRF token (form field `csrf` or header `x-csrf-token`); then the permission, checked again by the database. Form posts answer `303` back to the page with `?ok=` or `?error=`.

| Route | Access | Contract |
|---|---|---|
| `GET /approvals` | `approvals.read` | inbox: signing requests waiting, payout batches to decide or submit, open unfreeze requests, payout gate, and (with `property.read`) open S-01 requests (`admin.approvals_inbox`) |
| `GET /approvals/signer/[id]` | `approvals.read` | request, payload and payload hash, policy, approvals, outbox command; the exact call from `POST /v1/requests/preview`; why a decision is unavailable |
| `GET /approvals/payouts/[id]` | `approvals.read` | lines (subject id prefix, bank, IBAN last four), totals, held lines, gate, items digest, bank file SHA-256 when submitted |
| `GET /approvals/unfreeze/[id]` | `approvals.read` | request, freeze event, freezing and latest run, gate |
| `GET /approvals/property`, `GET /approvals/property/[id]` | `property.read` | open S-01 requests; one request with transition, file state and identifiers (no sealed data), evidence hashes, checker duties, request digest |
| `POST /api/approvals/signer/[id]/decide` | `approvals.decide` | form `decision`, `reason` (10-500), `payloadHash`, `callHash` → `admin.issue_signer_ticket` then `POST /v1/decide` |
| `POST /api/approvals/payouts/[id]/decide` | `approvals.decide` | form `decision`, `reason`, `itemsDigest` → `admin.decide_payout_batch` → `bank.decide_payout_batch` |
| `POST /api/approvals/unfreeze` | `approvals.request` | form `reason` → `admin.request_unfreeze` → `recon.request_unfreeze`; 303 to the new request |
| `POST /api/approvals/unfreeze/[id]/decide` | `approvals.decide` | form `decision`, `reason`, `freezeEvent` → `admin.decide_unfreeze` → `recon.decide_unfreeze` |
| `POST /api/approvals/property/[id]/decide` | `property.decide` | form `decision`, `reason`, `digest` → `admin.decide_property_request` → `property.decide_request` |

Every decision needs a step-up younger than five minutes (`PTS01` → "Confirm with your security key first"); the forms run it with the officer's key before submitting. Database refusals come back as `{ok: false, error}` from the `admin.*` function and are shown on the page.

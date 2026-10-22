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
| `/offerings` | public | S-02 offerings from `offering.web_offerings()` (migration 0018): state, price per token, raise target and raised so far (paid units x price), min/max per investor, open/close in PKT, all-or-nothing chip |
| `/offerings/[id]` | public; reserving needs a session, a verified KYC status and a KYC subject | non-uuid or not visible -> 404. Terms, rules (all-or-nothing, FCFS reservation and waitlist, mint at completion, refunds to source), document SHA-256 (EN, UR, risk) with a link to `/verify`, use of proceeds, reserve form |
| `/subscriptions` | session, else redirect `/login` | "My subscriptions": timeline reserved -> paid -> allocated -> minted at completion (or refunded / cancelled / expired / under review), payment instructions while a reservation awaits payment (payment code, exact amount, trustee escrow account, expiry in PKT with a countdown), refund status, cancel before payment. `?sub=<id>` highlights one |
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

| `reserveAction` | `offering.ts` | session, else redirect `/login`; rate `reserve` (10, 10/min) per investor; `kyc_status = verified` and a KYC subject, and the database gate (0018 WO-2) | `offeringId` uuid, `units` (1-13 digits), `requestId` uuid v4, `language` en/ur, `docSha`, `riskSha` (64 hex, the versions shown), `acceptDoc`=`on`, `acceptRisk`=`on` | redirect `/subscriptions?sub=<id>`, or `{error}`: `input`, `rate`, `kyc`, `notOpen`, `units`, `docs`, `already`, `paused`, `unknown`, `generic`. Acceptances and reservation in one transaction; actor `web:<investorId>`; idempotency key `web-<requestId>`; session and device stored only as keyed SHA-256 |
| `cancelReservationAction` | `offering.ts` | session; rate `reserve` | `subscriptionId` uuid | `{ok: true}` or `{error}`: `input`, `rate`, `state` (already paid or ended), `unknown` (not the investor's), `generic` |

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

Payload schemas (`backend/packages/signer/src/policy.ts`): mint `{issuance, to, amount (decimal string), refId (bytes32)}`; freeze and unfreeze `{freezeGuard, account, caseId}`; record payout `{registry, distributionId, payoutBatchHash}`.

Kind `compliance.unfreeze` (Step 6c, migration 0019): `FreezeGuard.unfreezeAddress(account, caseId)`, signed only if `compliance.unfreeze_allowed(account, caseId)` (an approved two-officer unfreeze whose hold is lifted), the owner is KYC-verified and the wallet is frozen; same rule shape as `compliance.freeze` (`chainId, keyRef, freezeGuard, token, maxPerDay, approvals, gasLimit`). Commands are enqueued only by `compliance.decide_freeze` (keys `compliance.freeze:request:<id>` / `compliance.unfreeze:request:<id>`).

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

Notifications (task T-028, ADR 0013, branch): `notify:setup` (local dev keys `NOTIFY_DATA_KEY`, `NOTIFY_LOOKUP_KEY`, created once and never printed; refused in production), `notify:run [-- --once]` (delivery worker with mock providers; prints one redacted line per accepted message: delivery uid and provider message id, never the contact or text; refused in production), `notify:status` (queue counts, dead letters, undeliverable security notices, audit check; exit 3 if any of them is non-empty, 0 otherwise).

**SQL producer API (narrow grant `pt_notify_producer`).** `notify.enqueue(p_key text, p_kind text, p_subject_type 'investor'|'officer', p_subject_id text, p_params jsonb, p_actor text) → bigint`, called inside the producer's transaction. Same key and same content returns the original id; same key with different content raises `unique_violation` ("idempotency key … was already used"). `p_params` must hold exactly the kind's placeholders as strings (types in `notify.event_kinds`); anything else raises `check_violation`. TypeScript: `enqueue(client, { key, event: { kind, params }, recipient: { type, id }, actor })` from `@pt/notify` (typed parameters per kind: `Date` for times, `bigint` for paisa). Kinds: `security.new_device_sign_in`, `security.contact_changed`, `security.payout_account_added`, `security.payout_account_changed`, `security.payout_account_active`, `security.kyc_status_changed`, `security.account_frozen`, `security.account_unfrozen`, `security.large_transaction_pending`, `offering.reservation_expiring`, `rent.paid`.

**Provider interface** (`backend/packages/notify/src/providers.ts`): `send(message, signal) → { messageId }` and `lookup(idempotencyKey) → accepted(messageId) | not_found | unknown`; `ProviderRejected` = permanent, `ProviderUnavailable` = provably not sent, anything else = outcome unknown (ADR 0013 adapter contract).

Property onboarding (spec S-01, branch `t-021-property-onboarding`): `property:run -- <action> '<json>'` (or `@file.json`) runs one workflow operation; the input is validated by the same zod schema the service uses (`ACTIONS` in `backend/packages/property/src/service.ts`; `property:run -- actions` lists them). Output is one JSON line: `{"ok":true,"result":…}` (exit 0) or, on stderr, `{"ok":false,"code":"INVALID_INPUT|FORBIDDEN|GUARD|DUPLICATE|NOT_FOUND","error":…}` (exit 4). Every input names the acting officer (`actor`, `officer`, `reviewer`, `chair`, `member` or `trustee`); the database checks that officer's duty. Also `property:show -- sponsor|property <id>`, `property:queue`, `property:audit` (exit 3 on a problem), `property:expire [actor]`, `property:setup` (local dev secrets).

Offering lifecycle (spec S-02, task T-020): `offering:run -- <action> '<json>'` (or `@file.json`; `offering:run -- actions` lists them; `ACTIONS` in `backend/packages/offering/src/service.ts`) with the same output and exit codes as `property:run` (`OfferingError` codes `INVALID_INPUT|FORBIDDEN|GUARD|DUPLICATE|NOT_FOUND`, exit 4). Officer actions name the officer (`actor` or `officer`); investor actions (`acceptDocument`, `reserve`, `cancel`, `withdraw`) name the KYC subject and the portal's actor; `reserve` returns `{subscriptionId, refId, state, units, amountPaisa, paymentCode, expiresAt, reason}` (payment code `PT-XXXX-XXXX` for the Raast narration; `reason` is investor-safe). Also `offering:show -- <offeringId>`, `offering:queue`, `offering:tick [-- <offeringId>]` (the scheduled clock: opens, expires, promotes, closes, proposes outcomes, settles), `offering:audit` (exit 3 on a problem). Refunds are sent by library function `executeApprovedRefunds(pool, bankGateway, offeringId, actor)` (records first, then instructs the bank); no CLI command, because the CLI has no bank connection.

Operations and tax (spec S-03, migration 0021, ADR 0014): `ops:statement -- <token> <YYYY-MM>` (operating statement JSON), `ops:run -- <action> '<json>'` (`ops:run -- actions` lists them: `collect`, `decide-collection`, `charge`, `decide-charge`, `calculate`, `attach` (builds statement v2 + tax schedule + Merkle root and attaches them), `verify` (independent recomputation, exit 3 on a problem), `decide-distribution`, `book`, `statement-file` (writes the website's statement file with NET amounts and proofs to `chain/data/rent/`), `remit`, `decide-remit`, `certificate`). Actors are operator names; officer handles are refused. `tax:setup` (local dev: `TAX_CNIC_KEY_V1`, `TAX_CNIC_KEY_CURRENT`, `TAX_CLIENT_SECRET_ADMIN`, also into `admin/.env.local`; never printed), `tax:serve` (127.0.0.1:4940), `tax:atl -- <YYYY-MM-DD>` (mock ATL provider; refused in production), `tax:enrol-cnic -- <subject>` (CNIC from stdin only, never argv), `tax:audit`, `tax:reconcile -- <token>` (exit 3 on findings).

**Tax service HTTP API** (`@pt/tax`, HMAC as the signing service; client `admin-portal`, scope one path): `POST /v1/filing-exports/generate` body `{exportId: "<id>", ticket: "<43 base64url chars>"}` → `200 {fileName, csv (base64), sha256, rows, record: {audit, auditHash, at, officer}}`; `409 {error}` for a refusal written for officers (invalid/used/expired ticket, export not approved, a line without a sealed CNIC); `401/403` authentication or scope; `500 {error: "internal"}` (nothing echoed). `GET /v1/health`.

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

Step 6c compliance routes (migration 0019; pages for compliance officers and auditors, POSTs for compliance officers only; "step-up" = checked by the database):

| Route | Access | Contract |
|---|---|---|
| `GET /compliance` | `compliance.read` | dashboard: counts by state, SLA breaches, oldest open items, recent decisions (`admin.compliance_dashboard`) |
| `GET /compliance/kyc[?status=]`, `GET /compliance/kyc/[id]` | `compliance.read` | queue (live or one state); case with masked investor, provider checks (codes, scores, list versions), proposal, Y-4 clearance, history, per-action blockers, digest |
| `GET /compliance/screening[?outcome=]` | `compliance.read` | latest sanctions/PEP screening per investor, its case, re-screening queue |
| `GET /compliance/freezes`, `GET /compliance/freezes/[id]` | `compliance.read` | requests, active holds, policy presence; one request with outbox command status, blockers, digest |
| `GET /compliance/str`, `GET /compliance/str/[id]` | `compliance.read` | STR cases; one case with notes, history, exports, blockers, digest |
| `GET /audit/compliance`, `POST /api/audit/compliance/export` | `compliance.read` (+ `audit.export`) | the compliance audit chain like the other sources |
| `POST /api/compliance/kyc` | `compliance.decide` | form `subject` (uuid), `risk`, `summary` → `admin.open_kyc_case`; 303 to the case |
| `POST /api/compliance/kyc/[id]/act` | `compliance.decide` + step-up | form `decision` (request_info, info_received, escalate, approve, reject, confirm, decline), `reason`, `digest` → `admin.kyc_case_act` |
| `POST /api/compliance/rescreen` | `compliance.decide` | form `subject`, `reason` → `admin.request_rescreen` (the KYC service runs it) |
| `POST /api/compliance/freezes` | `compliance.decide` + step-up | form `kind`, `wallet`, `reasonCode`, `reason`, optional `kycCase`, `strCase` → `admin.request_freeze`; 303 to the request |
| `POST /api/compliance/freezes/[id]/decide` | `compliance.decide` + step-up | form `decision`, `reason`, `digest` → `admin.decide_freeze` (hold + outbox command on approval) |
| `POST /api/compliance/str` | `compliance.decide` | form `category`, optional `subject`, `summary` → `admin.open_str`; 303 to the case |
| `POST /api/compliance/str/[id]/notes` | `compliance.decide` | form `body` → `admin.add_str_note` (append-only) |
| `POST /api/compliance/str/[id]/act` | `compliance.decide` + step-up | form `decision` (start_review, propose_close, confirm_close, decline_close, mark_filed), `reason`, `fmuReference`, `digest` → `admin.str_act` |
| `POST /api/compliance/str/[id]/export` | `compliance.export` + step-up | form `decision=export` → ZIP (case JSON, manifest.json, SHA256SUMS), recorded by `admin.record_str_export` before release; otherwise 303 back with the reason |

CLI (KYC service): `npm run kyc:rescreen` executes queued re-screenings (mock providers; refused in production).

S-06 recovery, succession and reversals (migration 0020; every route also checked by the database, decisions bound to the case digest):

| Route | Access | Body / result |
|---|---|---|
| `GET /recovery`, `GET /recovery/[id]` | `recovery.read` | case list with filters; case detail with documents, heirs, allocation preview, decisions, on-chain requests and the reasons each action is unavailable |
| `POST /api/recovery/cases` | `recovery.request` + step-up | `kind=wallet_recovery|succession`, `subject` (KYC subject id), `summary`; or `kind=reversal`, `journal`, `reasonCode`, `evidence` (SHA-256 hex), `summary` → 303 to the case |
| `POST /api/recovery/cases/[id]/evidence` | `recovery.request` | `what=document`, `docType`, `reference`, `issuer?`, `sha256`; or `what=heir`, `subject`, `num`, `den` → 303 back |
| `POST /api/recovery/cases/[id]/wallet` | `recovery.request` + step-up | `decision=create`: the signing service creates a custodial wallet (`/v1/custody/wallets`, admin client), the database sets it → 303 back |
| `POST /api/recovery/cases/[id]/act` | `recovery.decide` + step-up | `decision=approve|reject` + `capacity=operations|compliance|legal`, or `decision=cancel|release`; `reason`, `digest` → 303 back |
| `POST /api/recovery/sync` | `recovery.request` | `decision=sync` runs `recovery.tick` → 303 back |

Signing service: kinds `recovery.freeze|unfreeze|add_key|propose|execute|cancel` (ADR 0005 amendment); the admin client scope now includes `/v1/custody/wallets`. KYC service: `POST /v1/reverify` (`cnic`, `fullName`, `livenessSessionId`; client `recovery`, secret `KYC_CLIENT_SECRET_RECOVERY`, scope `/v1/reverify` only) → subject, status and check outcomes, 404 when no registered investor matches. CLI: `npm run recovery:tick [-- --loop]`, `npm run recovery:audit`.

S-03 operations and tax routes (migration 0021; operations pages for ops makers/checkers, trustee officers, tax officers and auditors; tax pages for tax officers and auditors):

| Route | Access | Contract |
|---|---|---|
| `GET /operations[?token=&period=]` | `operations.read` | periods with collected and distributable amounts and calculation state; one period's operating statement, charges, collections and calculations; propose form for makers |
| `GET /operations/charges/[id]` | `operations.read` | charge with evidence SHA-256, maker, decision, journal, blockers, digest |
| `GET /operations/distributions/[id]` | `operations.read` | calculation: statement snapshot, record date/block, sums, root and hashes, every line (subject reference, units, gross, filer status as of a date, flag, rate, WHT, net), blockers, digest |
| `GET /tax`, `GET /tax/exports`, `GET /tax/exports/[id]` | `tax.read` | rates (versions, placeholders, in force), proposals with decision forms, ATL summary, withheld vs remitted; exports; one export with lines in scope and missing sealed CNICs, blockers |
| `POST /api/operations/charges` | `operations.request` | multipart form `token`, `period`, `kind`, `feeType`, `payee`, `description`, `amount` (rupees, <= 2 decimals), `evidenceFile` (hashed, not kept) or `evidence` (hex) → `admin.propose_charge`; 303 to the charge |
| `POST /api/operations/charges/[id]/decide`, `POST /api/operations/distributions/[id]/decide` | `operations.decide` + step-up | form `decision`, `reason`, `digest` → `admin.decide_charge` / `admin.decide_distribution` |
| `POST /api/tax/rates` | `tax.decide` + step-up | form `incomeType`, `status`, `rate` (percent, <= 4 decimals), `effectiveFrom`, `basis` → `admin.propose_tax_rate` |
| `POST /api/tax/rates/[id]/decide` | `tax.decide` + step-up | form `decision`, `reason`, `digest` → `admin.decide_tax_rate` |
| `POST /api/tax/exports` | `tax.export` + step-up | form `token` (optional), `from`, `to`, `reason` → `admin.request_tax_export`; 303 to the export |
| `POST /api/tax/exports/[id]/decide` | `tax.export` + step-up | form `decision`, `reason`, `digest` → `admin.decide_tax_export` |
| `POST /api/tax/exports/[id]/generate` | `tax.export` + step-up | form `decision=generate` → `admin.issue_tax_export_ticket`, then the tax service; `200 application/zip` (CSV + manifest.json + SHA256SUMS, `no-store`) or 303 back with the reason |

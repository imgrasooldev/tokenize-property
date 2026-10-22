# ADR 0010: Website on the outbox, the signing service and the read model

- Status: Accepted (Step 5h; owner approved the plan 2026-10-13; reviewed, merged and deployed by the lead 2026-10-13; reconciliation passes on the demo server)
- Date: 2026-10-13
- Builds on: ADR 0001 (chain out of the read path), ADR 0004 (outbox), ADR 0005 (signing service), ADR 0006 (indexer and read model), ADR 0007 (reconciliation), ADR 0009 (KYC and bank)
- Replaces: the web prototype's demo signer (W3–W5, `web/src/lib/server/demo-signer.ts`) and the `WEB_DEMO_SIGNER` opt-in

## Context

Until Step 5h the investor website (prototype) did three things the backend steps had built proper services for:

- It read balances, supply, issuances and distributions from the chain on every page view.
- It signed and broadcast platform transactions itself with local dev keys (mint, onboarding) and with the investors' custodial keys, which it held encrypted in its own database (DvP transfers).
- It ran its own copy of the "record before broadcast" rules (W5).

The backend now has an outbox with exactly-once execution (ADR 0004), a signing service with deny-by-default policies, maker-checker and an audit log (ADR 0005), an indexer read model (ADR 0006), reconciliation (ADR 0007) and a KYC service (ADR 0009). This ADR moves the website onto them and removes every signing key from the website.

## Decision

### 1. Reads come from the read model

The website reads `chain.*` (same database, read-only; production role `pt_chain_reader`) for holdings, transfers, issuances, distributions, token supply, trustee cap, pause state and the investor register. Nothing on a page waits for the node.

- **Freshness is shown, not hidden.** Every figure is "as of block N" (the indexer cursor). Anything the website started that the read model does not show yet is listed as **pending** (queued, awaiting approval, confirming on chain) and is never counted as settled. A halted indexer, or one that has not moved for 60 seconds, is shown as such.
- **Conservative pre-checks.** Before money moves, the website uses the read model plus everything in flight: a subscription or a purchase counts against the holding limit from the moment it is accepted, and a sale or an offer reduces the free tokens until the read model shows the transfer. Subscriptions and trades are marked done only after the read model shows their event, so "read model + in flight" never misses a movement. The contracts and the signing service re-check every rule against the chain anyway.
- **The chain is read directly only where a fresh on-chain check is the point:**
  - rent self-verification (`DistributionRegistry.verify` and the statement hash);
  - proof that a recorded transaction can never execute before money is returned (receipt reverted, or the sender's mined nonce has passed it);
  - looking up a new investor's ONCHAINID address during onboarding (background, never in a page);
  - the network status rail (latest blocks and QBFT validators): one shared value per second for all viewers, never per request.

### 2. Writes go through the outbox and the signing service

| Action | Same database transaction | Outbox kind | Key (signing service) |
|---|---|---|---|
| Invest | subscription row + `subscription_paid` journal | `issuance.mint` | Issuance Safe |
| Trade (DvP) | fills + trade row (matcher) | `token.transfer` | the seller's custodial wallet |
| Sign-up | investor row (after KYC) | `identity.create`, then `identity.add_claim` (KYC, AML), then `identity.register` | identity operator; the investor's custodial wallet (claim signed by the claim key); registrar |

The outbox worker (`npm run outbox`) executes every kind through the signing service (`signerExecutor`): policy, maker-checker, nonce reservation, audit, record before broadcast. The website never signs and never broadcasts.

**Settlement follower.** A small loop in the website process (one runner at a time across processes, PostgreSQL advisory lock; woken by `chain_events` and every 2 seconds) moves each subscription, trade and sign-up forward. It decides only from the **final** outbox state, the read model and, for refunds, a fresh chain proof:

| Outbox command | Read model | Website does |
|---|---|---|
| pending / claimed / submitted | – | pending (shows "awaiting approval" while maker-checker waits) |
| confirmed | matching event (Minted with this refId **to this wallet for this amount**; Transfer seller → buyer of this amount in this transaction) | settle: `subscription_settled`, or cash from the buyer's escrow to the seller |
| confirmed | event not indexed yet | pending ("confirming on chain") |
| confirmed | event does not match | review (operations) |
| failed (final) | no event for the refId | refund / undo, **only if** no transaction was recorded or the chain proves the recorded one reverted or was dropped; otherwise review |
| failed | the refId was used anyway | review |
| review | – | review (operations decide in the outbox; a retry would revive it, so nothing is refunded while a command is in review) |

These are the W3–W5 rules (record before broadcast, refund only when the mint provably never happened, review on unknown outcomes, escrow, single matcher), now enforced by the outbox for sending and by the follower for settling. A status change still gates every journal, so each subscription is settled or refunded at most once and each trade settled or undone at most once.

### 3. Custody moves into the signing service

- Investor wallets are **custodial wallets of the signing service**. The service generates the key (production: inside the HSM/MPC), stores it encrypted like every other key (S-1) and records the address in `signer.custodial_wallets` (append-only). The website asks for a new wallet over the signer API (client `web`, which may only create wallets) and stores the address only.
- The demo personas' keys (Alice, Bob) are imported as custodial wallets by `npm run signer:setup` (local dev chain only). Wallets of earlier web sign-ups can be moved once with `npm run signer:import-web-wallets` (local/demo only), which clears the website's copy.
- The website holds **no private key**. `demo-signer.ts`, `wallets.ts` and `WEB_DEMO_SIGNER` are removed.

### 4. New signing kinds (deny by default)

Every kind pins the chain ID and the exact contract, has a daily limit, is simulated before signing, and reads its facts fresh (chain and database) at request and at signing time.

- **`token.transfer`** (DvP delivery): only from a custodial wallet; only to a wallet verified in the identity registry; not paused, sender not frozen, enough unfrozen balance; per-command and daily token limits; maker-checker above a threshold; and the **payment must be locked**: the trade's escrow account in the ledger must hold at least the trade's cost (delivery versus payment).
- **`identity.create`**, **`identity.add_claim`**, **`identity.register`** (onboarding): only for a custodial wallet whose owner is **KYC-verified** (`kyc.is_verified`, ADR 0009); the identity must be the one the IdFactory records for the wallet; claims only for the allowed topics (KYC, AML) and only from the trusted claim issuer, signed by the signing service's claim key; registration only for an allowed country and a wallet not yet registered, and only once both claims are on the identity.

### 5. Sign-up uses the KYC service

The website calls the KYC service (`npm run kyc:serve`, HMAC-authenticated like the signer, client `web`) with the CNIC, name and liveness session. The service applies ADR 0009 (peppered hashes, mock providers locally, status derived in the database, wallet bound to the subject). The website keeps only what it displays (name, last digits) and its own uniqueness HMAC. Registration on chain then follows the outbox steps above; the account page shows the progress.

### 6. The website's database role

The website no longer connects as the database admin (security audit, 2026-10-13). Migration `0012_website.sql` creates `pt_web` (NOLOGIN) with exactly what the website needs: its own records in `webdemo` (SELECT, INSERT, UPDATE; never DELETE, TRUNCATE or DDL), the ledger only through `post_journal`/`open_account` plus reads (`pt_ledger_writer`, `pt_ledger_reader`), `outbox.enqueue` plus reads of command state (`pt_outbox_writer`, `pt_outbox_reader`), the read model (`pt_chain_reader`) and the list of custodial wallets. It cannot sign, approve, change policies, resolve outbox reviews, unfreeze payouts, read KYC or bank data, or change the read model. `npm run db:web-role` creates the login role `pt_web_app` (member of `pt_web` only; no superuser, role or database rights) with a generated password in the git-ignored `backend/.env.local`; the website refuses to start its pool without it and never falls back to the admin. The `webdemo` DDL moved from the website (where it ran as the admin on the first request, audit item A2) into the same migration: the website runs no DDL.

### 7. Processes

`pt-indexer` (follow), `pt-signer`, `pt-outbox` (worker), `pt-kyc` (KYC API), `pt-offboarding` (KYC offboarding worker) and `pt-web`. All bind to 127.0.0.1; only nginx is public. The website fails closed: if the signer or KYC service is down, sign-up says so; if the outbox worker is down, orders stay pending; if the indexer is down, figures say "as of block N" and nothing settles.

### 8. Investor passkeys and database sessions (amendment, task T-030, 2026-10-13)

Investors sign in with **passkeys** (WebAuthn, NIST SP 800-63B AAL2; `@simplewebauthn` 14, the library and approach of the officers' portal, ADR 0011) and every website session is **enforced by the database** (migration `0024_investor_passkeys.sql`, schema `webauth`, rules IP-1..IP-9):

- **Sessions.** The cookie `pt_session` holds a random 256-bit token; `webauth.sessions` keeps its SHA-256 and checks it on every request: 30 minutes idle, 12 hours absolute (AAL2 limits), at most 10 live sessions per investor, ended by logout or by revoking the passkey that opened it. This replaces the stateless HMAC cookie (no server-side logout, no idle limit). The demo paths stay (persona sign-in; the session right after sign-up), but the database starts them only for persona investors and within 30 minutes of sign-up.
- **Passkeys.** Discoverable credentials, user verification required, attestation `none` (investors' privacy; no authenticator allow-list), synced passkeys accepted (allowed at AAL2; officers keep device-bound keys at AAL3). Registration from `/account` needs re-authentication: a passkey within 5 minutes, or for the first passkey a session at most 10 minutes old. Listing shows a label and times only. Revocation needs a passkey within 5 minutes and ends the sessions that used it.
- **Ceremonies.** Server actions (the website's existing pattern; Next.js checks the origin; cookies SameSite=Strict); challenges single use, 5 minutes, bound to a ceremony cookie and (registration, step-up) to the session, consumed before verification; the database records a result only against a consumed challenge, once. **Clone detection is the database's**: the library is given counter 0, so a counter that does not move always reaches `webauth.use_passkey`, which revokes the passkey, ends its sessions and raises `webauth_alert`. Lockout after 10 failed ceremonies of an investor in 15 minutes; in-process rate limits per address (sign-in) and per investor (management) in front.
- **Step-up (`requireRecentPasskey`).** `webauth.step_up_actions` lists sensitive actions with amount thresholds (reserve from PKR 100,000, cancel always, payout bank account always; anything unlisted always). An investor with a passkey needs an assertion on this session within 5 minutes. The decision is taken inside session-bound SQL wrappers (`webauth.web_reserve`, `webauth.web_cancel`), which also take the investor and KYC subject from the session; `pt_web` lost `EXECUTE` on `offering.web_reserve`/`web_cancel` (0018), so the website can no longer act for a subject of its choosing (the T-044 follow-up). An investor without a passkey is waived (audited) while `webauth.settings.require_passkey` is off and refused once it is on.
- **Where passkeys work.** `WEB_ORIGIN` names the one origin (https://… in production; development defaults to `http://localhost:3100`). WebAuthn needs a secure context and a domain as RP ID, so on the plain-HTTP IP demo server passkeys are off and the sign-in page says "Passkeys need the secure domain; available after the domain + TLS go live" (detected from the configuration, not hard-coded); a page opened at another host than `WEB_ORIGIN` points to the right address. **Owner action:** a domain and TLS for the website, then `WEB_ORIGIN=https://<domain>`, drop `WEB_PLAIN_HTTP`, and switch `require_passkey` on.

Not in this amendment: new-device sign-in notifications (T-028 producer 7), account recovery without any passkey (S-06), an investor screen listing sessions. The payout bank account (T-045, `/account`) is gated by the website through `webauth.web_require_recent_passkey(session, 'bank.payout_account')` before it calls the bank service; the bank service does not check the step-up itself yet (follow-up).

### 9. Public-anchoring status (amendment, task T-047, 2026-10-22)

The website reads anchoring the same way as the reconciliation status (0022): `pt_web` may execute `anchor.web_status()` and `anchor.web_recent(integer)` (migration 0025, WN-1..WN-4) and nothing else in schema `anchor`. The status rail (pulse field `anchor`, cached 15 s) and `/verify#anchor` (30 s) show the real state; the warning threshold is 2 x `ANCHOR_INTERVAL_SECONDS` of the website process, which must match the anchoring job's interval. The value on the anchor chain is still read by the server (CSP `connect-src 'self'` unchanged); the commitment is recomputed in the browser with the byte-identical copy of `@pt/anchor`'s `commitment.ts`.

## Consequences

- **UX:** investing, trading and signing up are asynchronous. The pages show the honest state and refresh themselves while something is pending (typically 2–5 seconds; an approval waits for two operators: `npm run signer:decide`).
- **Threat model:** M-6, M-8, M-9 and M-10 now rest on the outbox and the signer for the website too; K-2/K-3 cover investor custody; D-3's "UI shows pending" is built.
- **Reconciliation:** the website's journals keep the ADR 0007 keys (`web:sub:<uuid>:…`). For a fresh local stack to reconcile with zero findings, the demo's own records are booked (backend, local dev chain only; no exceptions list, every booking needs evidence):
  - `npm run seed:local` books the `flow.py` scenario mint (60,000 to Alice, refId `0xa1…a1`) as Alice's seed subscription: a `webdemo` subscription row (the expected amount and wallet) and `sub:<refId>:paid|settled`. Refused unless the read model shows exactly that mint.
  - `npm run rent:book` books, per distribution, the rent collected when published (`rent:collected:<token>:d<id>`, trustee escrow → `rent:pool:<token>`) and the split when finalized (`rent:distribution:<token>:<id>`, pool → `rent:payable:<subject>`, or `rent:payable:wallet:<address>` for a wallet without a KYC subject; external_ref = statement hash). The split is taken only from a statement whose hash the chain holds and whose lines add up to the on-chain total.
  - `npm run recon:demo-bank` registers the website's demo bank accounts and imports one statement per PKT day built from the website's payment records (`webdemo` subscriptions, refunds, top-ups), not from the ledger, so cash reconciles between two independent records.
  - `backend/packages/recon/test/local-stack.test.ts` replays a fresh stack (flow.py, website subscriptions and a trade, rent, bank) on a fake chain with the real indexer and proves zero findings; each booking is also shown to be necessary.
- **Shared keys across databases (local only):** two signing services on one chain with the same platform key (for example the dev site and the test suite) can race for a nonce; the outbox resolves the loser as dropped and signs it again. Production has one signing service per chain.
- **Not in this step:** the operations portal for approvals and reviews (Step 6), real providers and HSM/MPC custody, login roles for the other services (they still connect as the local admin; the website is the first to use its own role), and moving the website's demo records (`webdemo`) into backend services.

## Amendment 2026-10-22: transfers on the website (S-04 section 16.9, migration 0028)

- The website reaches transfers only through session-bound wrappers: `webauth.web_transfers` (read), `webauth.web_transfer_code` (a receive code), `webauth.web_transfer_request`, `webauth.web_transfer_accept` and `webauth.web_transfer_withdraw`. The KYC subject comes from the session; the three writes need the new step-up actions `transfer.request`, `transfer.accept`, `transfer.withdraw` (from PKR 0). `pt_web` has no grant on schema `transfer`.
- The seller names the buyer by the buyer's receive code; the buyer accepts by re-entering the SHA-256 of the signed agreement (hashed in the browser, never uploaded). Investors see investor-facing states only, never the other party's identity or a reason for a refusal (tipping-off).

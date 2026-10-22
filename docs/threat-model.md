# Threat Model

- Version: 0.1 (draft for review)
- Date: 2026-10-08
- Method: STRIDE per component, plus insider and supply-chain threats
- Companion: [contract-spec.md](contract-spec.md), [security-standards.md](security-standards.md), [ADR 0001](decisions/0001-stack.md)

## 1. What we protect

| Asset | Why it matters |
|---|---|
| A1. Ownership records (token balances, trustee register) | They are the investors' property |
| A2. Investor money in transit (subscriptions, rent payouts, exits) | Direct financial loss |
| A3. Signing keys (multisig, registrar, claim issuer, anchor) | Whoever holds them controls A1 |
| A4. Investor personal data (CNIC, selfie, bank details) | Privacy, identity theft, legal liability |
| A5. Ledger and its history | Proof of what happened; basis for audits and disputes |
| A6. Service availability | Investors must be able to see holdings and receive rent |
| A7. Property title and documents | The token is worthless if the title is lost or forged |

## 2. Actors

| Actor | Motivation |
|---|---|
| External attacker | Steal money or tokens, ransom data |
| Fraudulent investor | Fake KYC, money laundering, payout redirection |
| SIM-swap / account-takeover gang | Take over an investor account and withdraw |
| Malicious or coerced insider | Divert payouts, mint to themselves, sell data |
| Compromised vendor or dependency | Backdoor through npm/Solidity libraries or CI |
| Seller of property | Forged title, hidden liens, double sale |
| Validator operator | Censor or rewrite chain history |

## 3. Trust boundaries

1. Internet ↔ edge (WAF, API gateway)
2. API ↔ internal services (mTLS)
3. Internal services ↔ signing service (only path to keys)
4. Platform ↔ chain validators (separate organisations)
5. Platform ↔ bank / Raast / NADRA (external partners)
6. Staff ↔ admin panel (VPN + SSO + hardware key)
7. Developers ↔ CI/CD ↔ production

## 4. Threats and controls

Status: **Planned** (designed, not built), **Spec** (in contract spec), **Built, tested** (implemented with passing tests), **Verified** (externally audited). Nothing is externally verified yet.

### 4.1 Smart contracts

| ID | STRIDE | Threat | Control | Status |
|---|---|---|---|---|
| SC-1 | Elevation | Bug in custom code lets an attacker mint or move tokens | Minimal custom code; audited ERC-3643 core; invariant tests I-1 to I-16; Slither; formal verification of guards; two external audits | Built: 100% coverage, invariants and Slither clean. Formal verification and audits pending |
| SC-2 | Elevation | A single stolen key mints tokens | Mint only via `IssuanceGuard`, called by a 2-of-3 Safe that includes a trustee signer; supply capped by trustee register | Built, tested |
| SC-3 | Tampering | Malicious upgrade replaces logic | Guards non-upgradeable; core upgrades only via 72h timelock; public notice; trustee can cancel | Spec |
| SC-4 | Elevation | Stolen pauser key | Pauser can only pause, never unpause (I-10) | Built, tested |
| SC-5 | Elevation | Abuse of forced transfer or recovery | 48h delay, evidence hash required, cancellable by Admin or Trustee Safe, one execution only (I-13) | Built, tested |
| SC-6 | Spoofing | Unverified wallet receives tokens | Identity registry check on every transfer (I-3, I-4); claims only from our HSM-held issuer | Built, tested |
| SC-7 | Elevation | Stolen registrar key floods fake identities | On-chain rate limit (I-12); identity needs valid claim from separate issuer key; monitor compares registrations with KYC DB | Built, tested |
| SC-8 | Tampering | Wrong rent distribution root | 48h challenge window; trustee recomputes and can reject; any investor can verify own leaf | Built, tested |
| SC-9 | Info. disclosure | Personal data on-chain | Only wallet addresses, hashes and amounts on-chain; no names, CNICs or bank details | Spec |
| SC-10 | Tampering | Deployer keeps hidden powers | Post-deploy script asserts I-8 and I-9; deployer roles renounced; deployer key destroyed | Built, tested |
| SC-11 | Tampering | Deployed code differs from audited code | Bytecode verification against audited commit before go-live | Spec |
| SC-13 | Elevation | Owner of an implementation authority or UUPS module upgrades token, identity or module code | Both authorities and both modules owned by the 72h timelock; asserted by `DeployLib.checkHandover` and verified on a live Anvil deployment | Built, tested |
| SC-14 | Elevation | A real network is configured with the local dev chain ID (586586) and gets a 60 s timelock | Chain ID reserved and documented (ADR 0002); `Deploy.s.sol` also requires `LOCAL_DEV_NETWORK=true`; production genesis review checks the chain ID | Built, tested |
| SC-12 | DoS | Contract becomes unusable (gas, loops) | No unbounded loops over holders; batch sizes capped; Merkle proofs instead of on-chain iteration | Spec |

### 4.2 Keys and signing

| ID | STRIDE | Threat | Control | Status |
|---|---|---|---|---|
| K-1 | Elevation | Theft of a multisig signer key | Hardware wallets; 3-of-5 / 2-of-3 thresholds; signers in different cities and organisations; quarterly rotation drill | Planned |
| K-2 | Elevation | API compromise used to sign transactions | API holds no keys; signing service is a separate process in a separate network zone, reachable only via mTLS | Built (Step 5d): separate `@pt/signer` process, HMAC-authenticated internal API on 127.0.0.1, replay and skew protection; mTLS and network zoning in production. Step 5h: the website holds no key at all (demo signer and website-held wallet keys removed; investor wallets are custodial wallets of the signing service, W-1); signer API clients are scoped (the website's client may only create wallets, never ask for a signature) |
| K-3 | Tampering | Signing service signs a malicious transaction | Policy engine: allowed contracts and functions only, amount and rate limits, maker-checker for anything non-routine | Built and tested (Step 5d): deny-by-default policies (target, function, chain, per-command and daily limits, verified recipient, cap, simulation), maker-checker approvals by distinct operators, policy changes also maker-checker (ADR 0005). Step 5h: deny-by-default kinds for DvP delivery (custodial sender, verified recipient, escrow holds the cost, limits, maker-checker) and onboarding (only for custodial wallets whose owner the KYC service verified; claims only from the trusted issuer for allowed topics; registration only with both claims, allowed country, once), tested on a scratch database and on Besu ([ADR 0010](decisions/0010-website-integration.md)) |
| K-4 | Repudiation | Nobody knows who approved a signature | Every signing request logged with requester, approvers and payload hash in the append-only audit log | Built and tested (Step 5d): hash-chained `signer.audit`, tamper detection. Verification made independent of the session TimeZone (finding [F-04](findings/F-04-06-step-5f-review.md), migration 0008) |
| K-5 | Elevation | Departing employee keeps access | Same-day key revocation and Safe owner rotation; monthly access review | Portal part built (Step 6a): disabling an officer (maker-checker) ends the session and blocks sign-in at once; auditors see the officer list for access reviews. Safe owner rotation planned |
| K-7 | Tampering | Nonce reuse or gaps stall or double-send transactions | Database nonce reservations under a lock; released and stale nonces reused lowest first; dropped transactions proven before re-signing | Built and tested (Step 5d) |
| K-6 | Info. disclosure | Keys leak via code, logs or backups | Keys only in HSM/MPC in production; gitleaks in CI; secrets in Vault; log redaction | Partly built: local keys AES-256-GCM encrypted at rest (scrypt), never in JSON or logs, DB holds addresses only; HSM/MPC planned |

### 4.3 Money flows (bank, Raast)

| ID | STRIDE | Threat | Control | Status |
|---|---|---|---|---|
| M-1 | Spoofing | Payout redirected to an attacker's account | Payouts only to an IBAN whose title matches the investor's verified name; one current investor per account; 72h cooling-off after any bank-detail change, with an alert on every change; batches re-check the account at approval and submission; IBAN stored as keyed hash + sealed copy bound to the investor ([ADR 0009](decisions/0009-kyc-and-bank.md), B-4) | Built, tested (Step 5g, mock bank). Notification service built on a branch (T-028, ADR 0013: security notices cannot be switched off, sent to the contact current at the change and to a replaced contact, mock providers); wiring `bank.register_payee` to it, real SMS/e-mail providers (T-031) and a bank-side CNIC-to-account check pending |
| M-2 | Tampering | Insider changes payout amounts | Amounts come from the finalized on-chain distribution; maker-checker; daily 3-way reconciliation (chain, ledger, bank) freezes payouts on mismatch: each distribution's total, statement hash, status and payout batch hash must match the ledger's rent journals, and the payout batch must match the bank statement; payouts need a passed run under 26 hours old, a freeze lifts only by two operators ([ADR 0007](decisions/0007-reconciliation.md)) | Reconciliation and payout freeze built and tested (Step 5f, mock bank); rent journals are not written by any producer yet, bank payouts in Step 5g |
| M-3 | Tampering | Duplicate payout | Idempotency key on every payment instruction; payout recorded once on-chain (I-14); one live payout batch per distribution, recorded before sending, re-sent byte for byte after a crash; the bank de-duplicates by batch reference (ADR 0009, B-6) | Built, tested (ledger; bank side Step 5g with the mock bank) |
| M-4 | Elevation | Investor money mixed with company funds | Separate trustee escrow account; platform has no withdrawal authority over it | Planned |
| M-5 | Repudiation | Dispute over whether a payment happened | Bank batch hash recorded on-chain (SHA-256 of the submitted bank file, checked by reconciliation); ledger keeps bank references; signed bank events stored with their body hash | Built, tested off chain (Step 5g); `recordPayout` with the file hash in Step 5h |
| M-6 | Tampering | Tokens issued without payment, payment kept without tokens, or one payment charged or minted twice | Payment recorded in the ledger before minting; single-use `refId` per subscription (I-11); request idempotency key; refund only when the mint provably never happened (not broadcast, or reverted); unknown outcomes held for review and settled only against a matching on-chain `Minted` event (wallet and amount); per-visit reconciliation of ledger, chain and subscriptions | Prototype built and tested (web W3). Backend reconciliation built and tested (Step 5f, [ADR 0007](decisions/0007-reconciliation.md)): every on-chain mint refId has exactly one paid subscription and vice versa, amounts and wallets match the request, nothing stays paid-but-unminted or minted-but-unsettled beyond the SLA, refunds never coexist with a mint; blocking findings freeze payouts. Step 5h ([ADR 0010](decisions/0010-website-integration.md)): the website's payment, ledger entry and `issuance.mint` command are one transaction; minting only through the outbox and the signing service (policy, maker-checker above the threshold); settled only when the read model shows the matching Minted event; refunded only when the command failed AND the refId is unused AND the recorded transaction (if any) provably reverted or was dropped; a fresh local stack reconciles with zero findings (seed, rent and demo-bank bookings, tested). S-02 offerings (T-020, branch, migration 0015): payment codes exist only for reserved units, expire with the reservation and are cancelled with it, so the platform never collects more than the hard cap; the matched credit confirms the subscription in the bank's transaction; mint commands only at completion for booked, unrefunded payments in an approved issuance batch (`offering.mint_allowed` for the signer); refunds only to the sender, by two bank operators through the gate, never while a mint exists or could be mined; reconciliation `offering.*` checks (S-02 §16) |
| M-10 | Tampering | Chain command executed twice, or ledger and chain command out of step (backend) | Outbox (ADR 0004): command enqueued in the same transaction as the ledger entry; leases with SKIP LOCKED; transaction recorded before broadcast by the lease owner only; outcome from the chain; drops proven by nonce; operator decisions need a reason and are logged; separate DB roles | Built and tested (Step 5c), property-tested. Step 5h: the website's mints, deliveries and onboarding steps all go through it (enqueued in the same transaction as the ledger entry), executed by `npm run outbox` with the signing service; the website reads command states only and settles from final states ([ADR 0010](decisions/0010-website-integration.md)) |
| M-9 | Tampering / DoS | Interrupted send (crash, timeout, nonce clash) leaves money held or a leg unsettled forever | Per-signer cross-process lock for nonce selection; transaction hash and nonce recorded before broadcast; outcome decided from the chain (mined, reverted, dropped nonce, never sent) on reconciliation; late senders cannot broadcast after a refund | Prototype built and tested (web W5). Step 5h: the website no longer sends anything; the outbox (record before broadcast, decide from the database and the chain) and the signing service (database nonce reservations) carry these rules for every website transaction; tested with a worker crash after claiming (one mint, no double) and pre-5h rows resolved without re-sending ([ADR 0010](decisions/0010-website-integration.md)) |
| M-8 | Tampering | Secondary trade settles one leg only (tokens without cash or cash without tokens), double fills under concurrency, or a buyer spends cash twice | Buy cost moved into a per-order escrow before matching (ledger refuses overdraft); sell size limited to free on-chain tokens; single matcher via advisory lock; delivery versus payment (cash moves only after the on-chain transfer is confirmed); refused/reverted transfers undo fills and return escrow; unknown outcomes held for review and resolved from the receipt. Secondary trading itself needs SECP approval: demo only | Prototype built and tested (web W4). Step 5h: the delivery is an outbox `token.transfer` signed by the signing service only from a custodial wallet and only while the buyer's escrow holds the trade's cost (W-3); a trade's cost stays in escrow while it is in flight, even after its buy order is cancelled; cash moves only when the read model shows the transfer ([ADR 0010](decisions/0010-website-integration.md)) |
| M-11 | Spoofing / Tampering | Forged or replayed bank notification books money that never arrived (or books it twice) | HMAC-signed webhooks over timestamp and raw body, 5-minute window, key rotation; event id and Raast reference booked once; same id with another body refused and alerted; every credit reconciled line by line against the bank's own statement (ADR 0009, B-1..B-3) | Built, tested (Step 5g, mock bank) |
| M-12 | Elevation | Money laundering or mistakes through third-party payments (someone else pays for an investor) | A credit reaches an investor only from an account registered to that investor and matching the payment code and amount; otherwise suspense, returned to the sender only through the reconciliation gate (ADR 0009, B-2) | Built, tested (Step 5g) |
| M-7 | Tampering | Rent statement altered after publication (amounts changed off chain) | Statement hash and Merkle root on chain; investors verify their own leaf and the statement hash themselves | Prototype built (web W3, `chain/rent.py`) |

### 4.4 API and backend

| ID | STRIDE | Threat | Control | Status |
|---|---|---|---|---|
| API-1 | Spoofing | Account takeover (password reuse, phishing) | Passkeys or authenticator app; device binding; step-up auth for sensitive actions | **Built, tested (T-030, migration 0024, ADR 0010 section 8)** on localhost and any HTTPS origin: passkeys (origin-bound, user verification required), database sessions (30 min idle, 12 h, logout ends them), passkey step-up within 5 min for reserve from PKR 100,000 and cancel, enforced in SQL. Open: passkeys cannot work on the plain-HTTP IP demo (owner action: domain + TLS), and demo personas still sign in without any authentication until `require_passkey` is on and personas are retired |
| API-8 | Spoofing / Elevation | Investor session or passkey abused: stolen cookie, forged or replayed assertion, cloned authenticator, rogue passkey added to a victim's account, brute force, website acting for another investor | Random 256-bit token, only SHA-256 stored, checked in the database every request (idle/absolute, 10 live max); challenges single use, 5 min, bound to the browser and session, consumed before verification, one recorded result per ceremony; signature, origin, RP ID and user verification checked by `@simplewebauthn/server`; counter regression revokes the passkey, ends its sessions and alerts; adding a passkey needs a passkey within 5 min (first passkey: sign-in within 10 min); revoking needs a passkey within 5 min; lockout after 10 failures in 15 min plus per-address and per-investor rate limits; investor and KYC subject of reserve/cancel taken from the session inside SQL; hash-chained `webauth.audit` with `verify_audit()` (T-030, IP-1..IP-9) | Built, tested (22 DB, 10 integration with a software authenticator, 2 e2e in Edge with a virtual authenticator). Residual: a stolen cookie within 10 minutes of a passkey-less sign-in can add a passkey; no new-device notification yet (T-028 producer 7) |
| API-2 | Spoofing | SIM swap defeats SMS OTP | SMS never the only factor; SIM-change signals from telco where available; cooling-off on new device; new-device and contact-change alerts to every contact on file, including the replaced one (ADR 0013) | Planned (alerts built on a branch, T-028; sign-in wiring with T-030) |
| API-3 | Elevation | Broken access control (IDOR) | Ownership checks in guards on every route; row-level security in PostgreSQL; automated authz tests | Planned (web prototype: every query scoped to the signed-in investor; independent review found no IDOR). Step 5h: the website connects as its own least-privilege database role `pt_web` (no admin, no DDL, no DELETE, ledger and outbox only through their functions, no KYC/bank/signer data), tested to be refused everything else (migration 0012 W-5) |
| API-4 | Tampering | Injection (SQL, header, deserialisation) | ORM with parameterised queries; DTO validation with whitelisting; OWASP ASVS L2 checklist | Planned (web prototype: parameterised SQL only, zod on every input) |
| API-5 | DoS | Traffic flood | Cloudflare WAF and DDoS protection; per-user and per-IP rate limits; reads served from cache | Planned (web prototype: in-process rate limits, live-feed caps, shared snapshot cache) |
| API-6 | Tampering | Replay of a write request | Idempotency keys; request signing from the mobile app; short-lived tokens | Planned (web prototype: request ids on invest, orders and top-ups; ledger idempotency keys) |
| API-7 | Info. disclosure | Verbose errors leak internals | Generic error responses; details only in internal logs | Planned (web prototype: error page shows only a digest; server log without personal data) |

### 4.5 Ledger and data

| ID | STRIDE | Threat | Control | Status |
|---|---|---|---|---|
| D-1 | Tampering | Ledger rows edited or deleted | Append-only enforced by DB permissions and triggers; each entry hash-chained to the previous one; every reconciliation run re-verifies the ledger, signer and recon audit chains and freezes payouts on a break; the ledger head is bound into the hourly public anchor commitment, and `anchor:verify` recomputes the hash chain from the rows independently of the database functions, so an edit even with a full re-hash by a superuser is detected ([ADR 0008](decisions/0008-public-anchor.md)) | Built, tested (reconciliation Step 5f; anchoring on a local Anvil stand-in, public L2 not chosen yet; daily verify scheduling and alerting pending) |
| D-2 | Info. disclosure | Database dump leaks CNICs and bank details | No readable CNIC, name or IBAN in the database: HMAC-SHA256 with secret peppers (KMS), last digits only, AES-256-GCM sealed copies bound to their record, provider evidence as hashes; separate `kyc` schema with status-only views for other roles (ADR 0009, Y-1, Y-6); encrypted backups; KYC document vault separate | Built, tested for the operational database (Step 5g); KMS, document vault and backups pending |
| D-3 | Tampering | Read model drifts from chain | Indexer checks every header's parent hash and every log's block hash, and halts (fail closed) on any mismatch; one transaction per batch with a compare-and-set cursor (exactly-once); contract invariants re-checked while deriving; `indexer:verify` rebuilds from the chain with an independent implementation and compares with `balanceOf` and other views at a pinned block; UI shows "pending" until confirmed ([ADR 0006](decisions/0006-indexer.md)) | Built, tested. Reconciliation (Step 5f, [ADR 0007](decisions/0007-reconciliation.md)) runs `verify` and turns any mismatch or a halted indexer into a blocking finding that freezes payouts; it also compares totalSupply and every holder's `balanceOf` at the pinned block. Daily scheduling and alert wiring in production pending. Step 5h: the website reads the read model ("as of block N"), shows anything newer as pending, marks subscriptions and trades done only once the read model shows them, and shows a halted or stale index ([ADR 0010](decisions/0010-website-integration.md)) |
| D-4 | DoS | Data loss | Point-in-time recovery; backups in two locations; quarterly restore drill | Planned |
| D-6 | Tampering | Batch with a missing field accepted, so the read model silently skips events or the ledger accepts a malformed posting (SQL `<>` with NULL) | `IS DISTINCT FROM` and explicit NULL checks in `chain.apply_batch` and `ledger.post_journal`; the cursor never moves on a refused batch (finding [F-06](findings/F-04-06-step-5f-review.md)) | Built, tested (migration 0008) |
| D-7 | DoS | Ledger writes slow down as account history grows, blocking issuance and payouts at volume | Running balance per account maintained in the same transaction; forward-only table; `ledger.verify_balances()` checked by every reconciliation run as a blocking finding (finding [F-05](findings/F-04-06-step-5f-review.md)) | Built, tested (migration 0008) |
| D-5 | Info. disclosure | Breach of personal data | Data minimisation; retention limits; breach-response runbook; confirm Pakistan data-localisation rules | Planned |

### 4.6 KYC and AML

| ID | STRIDE | Threat | Control | Status |
|---|---|---|---|---|
| KYC-1 | Spoofing | Fake or stolen CNIC | NADRA Verisys; selfie match with liveness check (score >= 80, enforced by a table constraint); one subject per CNIC across pepper versions; status derived in the database (ADR 0009, Y-2, Y-3) | Built, tested with mock providers (Step 5g); real NADRA and liveness vendor pending contracts |
| KYC-2 | Elevation | Money laundering through tokens | Sanctions and PEP screening (a possible match needs two officers, a hit is final, re-screening removes a verification and alerts); no third-party funding (M-12); source-of-funds checks; transaction monitoring; reporting to FMU | Sanctions screening built, tested with a mock list (Step 5g); PEP review (two officers, enhanced due diligence), compliance freezes and the STR case log with recorded FMU export built in Step 6c (migration 0019, mock PEP list); source of funds, transaction monitoring and goAML filing pending |
| KYC-3 | Spoofing | Claim issuer key misuse | Claim issuer key in HSM, separate from registrar key; claims have expiry; revocation on-chain | Partly built (Step 5h): the claim key is held only by the signing service, separate from the registrar key, and signs a claim only for a custodial wallet whose owner the KYC service verified (`identity.add_claim`); HSM, expiry pending |
| KYC-4 | Elevation | Revoked investor restores own verification (finding [F-01](findings/F-01-onchainid-claim-revocation-bypass.md)) | Never rely on claim revocation: freeze immediately, move or redeem tokens, then delete identity through the timelock | Built, tested |
| KYC-5 | DoS | Tokens stranded by deleting or updating a holder's identity (finding [F-02](findings/F-02-maxbalance-identity-coupling.md)) | Offboarding order enforced by procedure and admin portal; never `updateIdentity` on a holding wallet; invariant I-17 | Built, tested (portal enforcement in Step 6) |
| KYC-6 | Spoofing | Claim replay on another chain (claims lack `chainid`, finding F-03) | One claim-signer key per chain | Spec |

### 4.7 Chain and infrastructure

| ID | STRIDE | Threat | Control | Status |
|---|---|---|---|---|
| CH-1 | Tampering | Validators collude to rewrite history | 4 validators run by separate organisations (platform, trustee, auditor, backup); hourly anchor of a finalized block hash on a public chain (`StateAnchor`, commitment in spec 7.1); `anchor:verify` compares every anchor with the private chain and reports any rewritten block ([ADR 0008](decisions/0008-public-anchor.md)) | Built, tested on a local Anvil stand-in against the local Besu network (public L2 and the HSM anchor key pending) |
| CH-2 | DoS | Validators go offline | QBFT tolerates 1 of 4 failing; monitoring and runbook for validator recovery | Built, tested locally (`chain/flow.py` stops and restarts a validator) |
| CH-3 | Elevation | Unauthorised node joins network | Permissioned node allowlist; static peering, discovery off; TLS between nodes | Allow-list and static peering built locally; TLS planned |
| INF-1 | Elevation | Lateral movement after one service is breached | Private subnets; mTLS between services; signing service and DB not internet-reachable | Planned |
| INF-2 | Elevation | Admin panel exposed | VPN + SSO + FIDO2 hardware keys; IP allowlist; separate domain | Partly built (Step 6a, [ADR 0011](decisions/0011-admin-portal.md)): FIDO2 hardware keys only, Host allow-list, binds 127.0.0.1:3300, never behind the public nginx (demo: SSH tunnel). VPN, SSO and TLS domain in production pending |

### 4.8 Supply chain and CI/CD

| ID | STRIDE | Threat | Control | Status |
|---|---|---|---|---|
| SUP-1 | Tampering | Malicious npm or Solidity dependency | Exact version pinning; lockfile review; dependency scanning; minimal dependencies; ERC-3643 pinned to a release tag | Planned |
| SUP-2 | Tampering | Malicious code merged | Protected `main`; 2 reviewers; signed commits; CI gates | Planned |
| SUP-3 | Elevation | CI secrets stolen | Least-privilege CI tokens; no production keys in CI; OIDC for deployments | Planned |
| SUP-4 | Tampering | Tampered build artifact | Reproducible builds; signed container images; SBOM | Planned |

### 4.9 People and process

| ID | STRIDE | Threat | Control | Status |
|---|---|---|---|---|
| P-1 | Elevation | Single insider acts alone | Separation of duties; maker-checker everywhere; no one holds more than one Safe key of the same Safe | Officer roles and segregation of duties enforced by the database, officer changes maker-checker with step-up (Step 6a, ADR 0011, AD-3/AD-4); Safe keys planned |
| P-2 | Spoofing | Social engineering of staff ("urgent CEO request") | Out-of-band verification for any key or payout action; training; written procedures | Planned |
| P-3 | Repudiation | Admin action without trace | Immutable audit log of every admin action | Built, tested (Step 6a): hash-chained `admin.audit` of every sign-in, step-up, page view, denial, officer change and export; `admin.verify_audit()` (AD-6) |

### 4.11 Internal portals (Step 6, [ADR 0011](decisions/0011-admin-portal.md))

| ID | STRIDE | Threat | Control | Status |
|---|---|---|---|---|
| AD-1 | Spoofing | Officer account taken over (phishing, password reuse, stolen session) | FIDO2 hardware keys only (no passwords), user verification required, origin-bound (phishing-resistant), synced passkeys refused; random 256-bit session token, only its hash stored; 15 min idle, 8 h absolute, one live session, enforced in the database; counter regression refused and alerted | Built, tested |
| AD-2 | Spoofing | Rogue enrolment (someone else registers a key for an officer) | One-time link only for an officer approved by two administrators (or a bootstrap administrator): hashed, single use, 30 min, newest link revokes older ones, token only in the URL fragment; issued on the server by a role that can do nothing else | Built, tested |
| AD-3 | Elevation | One person combines incompatible roles (maker and checker, trustee and platform, auditor and anything) | `admin.role_conflicts` checked by a trigger on every grant, also for a superuser's direct INSERT, serialised per officer | Built, tested (incl. concurrent approvals) |
| AD-4 | Elevation | A single administrator grants themself or a friend power | Every officer change maker-checker by two administrators with reasons; nobody changes their own account; step-up within 5 minutes checked in the database; at least two active administrators; administrators can never approve money or token actions | Built, tested |
| AD-5 | Elevation | Broken access control in a page or API route (IDOR, forgotten check) | Route registry tested against the files; authorisation matrix over HTTP for every route × role, anonymous and investor cookie; every database function checks the session and permission again; the portal's database login has no table grants | Built, tested |
| AD-6 | Repudiation / Tampering | Officer actions denied later, or the record edited by a DBA | Hash-chained append-only `admin.audit` (UTC digests); `verify_audit()` finds edits, deletions, forged credentials, swapped public keys, forged sessions, unaudited grants and changes, an edited role matrix | Built, tested; anchoring the admin head with the ledger head (ADR 0008) planned |
| AD-7 | Tampering | Cross-site request forgery or DNS rebinding against a signed-in officer | No server actions; same origin (or `Origin: null` with `Sec-Fetch-Site: same-origin`) plus a session-bound CSRF token plus SameSite=Strict; Host allow-list (421) | Built, tested on every mutating route |
| AD-8 | Information disclosure | Evidence export or overview leaks data, or an export is altered afterwards | Overview returns counts and health only (no payloads, no personal data); exports only for compliance and auditors, recorded with the file's SHA-256 before release, manifest names the audit entry; CSV formula neutralisation | Built, tested |
| AD-9 | Elevation / Tampering | A compromised portal (or its database login) approves money or token actions on its own, or an officer approves something other than what was shown | The portal's role cannot call any backend decision function; decisions go through `admin.*` functions that check session, permission and step-up, then the backend decides under the officer's handle (maker-checker, gate, duties); signer approvals need a one-time ticket from the database AND the signing service's own check (neither can decide alone); every decision bound to the digest of what was shown (payload + call hash decoded from the calldata, items digest, freeze event, request digest); officer handles refused as operator names outside the portal (Step 6b, ADR 0011 section 10) | Built, tested (backend, database, HTTP, e2e) |
| AD-10 | Elevation / Info. disclosure | One compliance officer clears a PEP or sanctions match, buries a suspicion report, or freezes/unfreezes alone; compliance data leaks to operations or the investor (tipping-off) | High-risk KYC outcomes, freezes/unfreezes and closing an STR without a report need a second, different compliance officer (CHECK constraints + Y-4 clearances); step-up and digest on every decision; unfreeze signed only after `compliance.unfreeze_allowed`; compliance readable by compliance officers and auditors only; masked CNIC, no names; free text refusing CNIC/IBAN/phone; exports recorded before release; nothing sent to the FMU automatically (Step 6c, ADR 0011 section 11) | Built, tested (backend, database, HTTP) |
| AD-11 | Elevation / Tampering | Issuance or a distribution goes through without the independent trustee; a platform officer stands in for the trustee; a rejected distribution is still booked and paid; the trustee register silently drifts from the token | Trustee co-signature required by the database for mints needing maker-checker (requirement set on insert, capacity derived from the approver's role, approval transition re-checked by a trigger); trustee votes on S-02 requests only through the portal (session, step-up, digest; OF-SOD-4 in a trigger; command-line votes under an officer's handle refused by a trigger; the demo catalogue seed stops at every vote), S-03 charges above the limit and calculation pre-checks need the trustee in SQL; distribution review inside the 48 h window with the recomputed root, a rejection blocks payout batches and the booking in triggers; trustee register with two-officer adjustments compared with the read model at a pinned block; exports recorded before release; hash-chained `trustee.audit` (Step 6d, ADR 0011 section 12) | Built, tested (backend, database, HTTP, e2e) |

### 4.10 Property and title (non-technical, tracked here for completeness)

| ID | Threat | Control | Status |
|---|---|---|---|
| T-1 | Forged or disputed title | Sub-Registrar, fard/PLRA and society verification; lawyer opinion | Planned |
| T-2 | Property sold or mortgaged behind investors' backs | Charge registered in trustee's favour; sale only after investor vote | Partly built (S-05, migration 0027, branch `s-05-exit`): a sale proceeds only through recorded decisions (committee, counted vote with quorum/majority checked, trustee + legal, buyer checks) by different officers with evidence hashes; proceeds only from the trustee escrow; burns only for an approved redemption batch (`issuance.burn` deny by default, refId re-derived, after payment by default) and blocking reconciliation checks (`issuance.orphan_burn`, `exit.*`). Title registration and the charge remain legal steps outside the platform |
| T-3 | Overvaluation at issuance | Two independent PBA-panel valuers | Planned |

## 5. Top risks to address first

1. **K-1 / K-2 / K-3** (keys): designed into the signing service from day one in Step 5.
2. **SC-1 / SC-2** (contract bugs, minting): Step 3 tests and the two external audits.
3. **M-1** (payout redirection): the most common real-world fraud pattern; build cooling-off and IBAN title match before any pilot.
4. **API-2** (SIM swap): common in Pakistan; passkeys or authenticator app from the first release.

## 6. Review cadence

This document is updated at every step gate, after every incident, and before each audit.

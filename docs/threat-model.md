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
| K-2 | Elevation | API compromise used to sign transactions | API holds no keys; signing service is a separate process in a separate network zone, reachable only via mTLS | Planned |
| K-3 | Tampering | Signing service signs a malicious transaction | Policy engine: allowed contracts and functions only, amount and rate limits, maker-checker for anything non-routine | Planned |
| K-4 | Repudiation | Nobody knows who approved a signature | Every signing request logged with requester, approvers and payload hash in the append-only audit log | Planned |
| K-5 | Elevation | Departing employee keeps access | Same-day key revocation and Safe owner rotation; monthly access review | Planned |
| K-6 | Info. disclosure | Keys leak via code, logs or backups | Keys only in HSM/MPC in production; gitleaks in CI; secrets in Vault; log redaction | Planned |

### 4.3 Money flows (bank, Raast)

| ID | STRIDE | Threat | Control | Status |
|---|---|---|---|---|
| M-1 | Spoofing | Payout redirected to an attacker's account | Payouts only to an IBAN whose title matches the investor's CNIC name; 72h cooling-off after any bank-detail change, with notifications on all channels | Planned |
| M-2 | Tampering | Insider changes payout amounts | Amounts come from the finalized on-chain distribution; maker-checker; daily 3-way reconciliation (chain, ledger, bank) freezes payouts on mismatch | Planned |
| M-3 | Tampering | Duplicate payout | Idempotency key on every payment instruction; payout recorded once on-chain (I-14) | Ledger idempotency built, tested; bank side Step 5g |
| M-4 | Elevation | Investor money mixed with company funds | Separate trustee escrow account; platform has no withdrawal authority over it | Planned |
| M-5 | Repudiation | Dispute over whether a payment happened | Bank batch hash recorded on-chain; ledger keeps bank references | Spec |
| M-6 | Tampering | Tokens issued without payment, payment kept without tokens, or one payment charged or minted twice | Payment recorded in the ledger before minting; single-use `refId` per subscription (I-11); request idempotency key; refund only when the mint provably never happened (not broadcast, or reverted); unknown outcomes held for review and settled only against a matching on-chain `Minted` event (wallet and amount); per-visit reconciliation of ledger, chain and subscriptions | Prototype built and tested (web W3); production in Steps 5c–5g |
| M-10 | Tampering | Chain command executed twice, or ledger and chain command out of step (backend) | Outbox (ADR 0004): command enqueued in the same transaction as the ledger entry; leases with SKIP LOCKED; transaction recorded before broadcast by the lease owner only; outcome from the chain; drops proven by nonce; operator decisions need a reason and are logged; separate DB roles | Built and tested (Step 5c), property-tested |
| M-9 | Tampering / DoS | Interrupted send (crash, timeout, nonce clash) leaves money held or a leg unsettled forever | Per-signer cross-process lock for nonce selection; transaction hash and nonce recorded before broadcast; outcome decided from the chain (mined, reverted, dropped nonce, never sent) on reconciliation; late senders cannot broadcast after a refund | Prototype built and tested (web W5) |
| M-8 | Tampering | Secondary trade settles one leg only (tokens without cash or cash without tokens), double fills under concurrency, or a buyer spends cash twice | Buy cost moved into a per-order escrow before matching (ledger refuses overdraft); sell size limited to free on-chain tokens; single matcher via advisory lock; delivery versus payment (cash moves only after the on-chain transfer is confirmed); refused/reverted transfers undo fills and return escrow; unknown outcomes held for review and resolved from the receipt. Secondary trading itself needs SECP approval: demo only | Prototype built and tested (web W4) |
| M-7 | Tampering | Rent statement altered after publication (amounts changed off chain) | Statement hash and Merkle root on chain; investors verify their own leaf and the statement hash themselves | Prototype built (web W3, `chain/rent.py`) |

### 4.4 API and backend

| ID | STRIDE | Threat | Control | Status |
|---|---|---|---|---|
| API-1 | Spoofing | Account takeover (password reuse, phishing) | Passkeys or authenticator app; device binding; step-up auth for sensitive actions | Planned |
| API-2 | Spoofing | SIM swap defeats SMS OTP | SMS never the only factor; SIM-change signals from telco where available; cooling-off on new device | Planned |
| API-3 | Elevation | Broken access control (IDOR) | Ownership checks in guards on every route; row-level security in PostgreSQL; automated authz tests | Planned (web prototype: every query scoped to the signed-in investor; independent review found no IDOR) |
| API-4 | Tampering | Injection (SQL, header, deserialisation) | ORM with parameterised queries; DTO validation with whitelisting; OWASP ASVS L2 checklist | Planned (web prototype: parameterised SQL only, zod on every input) |
| API-5 | DoS | Traffic flood | Cloudflare WAF and DDoS protection; per-user and per-IP rate limits; reads served from cache | Planned (web prototype: in-process rate limits, live-feed caps, shared snapshot cache) |
| API-6 | Tampering | Replay of a write request | Idempotency keys; request signing from the mobile app; short-lived tokens | Planned (web prototype: request ids on invest, orders and top-ups; ledger idempotency keys) |
| API-7 | Info. disclosure | Verbose errors leak internals | Generic error responses; details only in internal logs | Planned (web prototype: error page shows only a digest; server log without personal data) |

### 4.5 Ledger and data

| ID | STRIDE | Threat | Control | Status |
|---|---|---|---|---|
| D-1 | Tampering | Ledger rows edited or deleted | Append-only enforced by DB permissions and triggers; each entry hash-chained to the previous one; hourly hash anchored | Built, tested (anchoring pending, Step 5f) |
| D-2 | Info. disclosure | Database dump leaks CNICs and bank details | Field-level encryption with KMS; KYC data in a separate database; encrypted backups | Planned |
| D-3 | Tampering | Read model drifts from chain | Indexer re-checks by block hash; daily full rebuild comparison; UI shows "pending" until confirmed | Planned |
| D-4 | DoS | Data loss | Point-in-time recovery; backups in two locations; quarterly restore drill | Planned |
| D-5 | Info. disclosure | Breach of personal data | Data minimisation; retention limits; breach-response runbook; confirm Pakistan data-localisation rules | Planned |

### 4.6 KYC and AML

| ID | STRIDE | Threat | Control | Status |
|---|---|---|---|---|
| KYC-1 | Spoofing | Fake or stolen CNIC | NADRA Verisys; selfie match with liveness check | Planned |
| KYC-2 | Elevation | Money laundering through tokens | Sanctions and PEP screening; source-of-funds checks; transaction monitoring; reporting to FMU | Planned |
| KYC-3 | Spoofing | Claim issuer key misuse | Claim issuer key in HSM, separate from registrar key; claims have expiry; revocation on-chain | Planned |
| KYC-4 | Elevation | Revoked investor restores own verification (finding [F-01](findings/F-01-onchainid-claim-revocation-bypass.md)) | Never rely on claim revocation: freeze immediately, move or redeem tokens, then delete identity through the timelock | Built, tested |
| KYC-5 | DoS | Tokens stranded by deleting or updating a holder's identity (finding [F-02](findings/F-02-maxbalance-identity-coupling.md)) | Offboarding order enforced by procedure and admin portal; never `updateIdentity` on a holding wallet; invariant I-17 | Built, tested (portal enforcement in Step 6) |
| KYC-6 | Spoofing | Claim replay on another chain (claims lack `chainid`, finding F-03) | One claim-signer key per chain | Spec |

### 4.7 Chain and infrastructure

| ID | STRIDE | Threat | Control | Status |
|---|---|---|---|---|
| CH-1 | Tampering | Validators collude to rewrite history | 4 validators run by separate organisations (platform, trustee, auditor, backup); hourly public-chain anchor makes rewrites detectable | Spec |
| CH-2 | DoS | Validators go offline | QBFT tolerates 1 of 4 failing; monitoring and runbook for validator recovery | Built, tested locally (`chain/flow.py` stops and restarts a validator) |
| CH-3 | Elevation | Unauthorised node joins network | Permissioned node allowlist; static peering, discovery off; TLS between nodes | Allow-list and static peering built locally; TLS planned |
| INF-1 | Elevation | Lateral movement after one service is breached | Private subnets; mTLS between services; signing service and DB not internet-reachable | Planned |
| INF-2 | Elevation | Admin panel exposed | VPN + SSO + FIDO2 hardware keys; IP allowlist; separate domain | Planned |

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
| P-1 | Elevation | Single insider acts alone | Separation of duties; maker-checker everywhere; no one holds more than one Safe key of the same Safe | Planned |
| P-2 | Spoofing | Social engineering of staff ("urgent CEO request") | Out-of-band verification for any key or payout action; training; written procedures | Planned |
| P-3 | Repudiation | Admin action without trace | Immutable audit log of every admin action | Planned |

### 4.10 Property and title (non-technical, tracked here for completeness)

| ID | Threat | Control | Status |
|---|---|---|---|
| T-1 | Forged or disputed title | Sub-Registrar, fard/PLRA and society verification; lawyer opinion | Planned |
| T-2 | Property sold or mortgaged behind investors' backs | Charge registered in trustee's favour; sale only after investor vote | Planned |
| T-3 | Overvaluation at issuance | Two independent PBA-panel valuers | Planned |

## 5. Top risks to address first

1. **K-1 / K-2 / K-3** (keys): designed into the signing service from day one in Step 5.
2. **SC-1 / SC-2** (contract bugs, minting): Step 3 tests and the two external audits.
3. **M-1** (payout redirection): the most common real-world fraud pattern; build cooling-off and IBAN title match before any pilot.
4. **API-2** (SIM swap): common in Pakistan; passkeys or authenticator app from the first release.

## 6. Review cadence

This document is updated at every step gate, after every incident, and before each audit.

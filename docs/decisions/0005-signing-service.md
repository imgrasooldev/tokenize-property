# ADR 0005: Signing service, policy engine and maker-checker

- Status: Accepted (owner approved the Step 5d plan 2026-10-12)
- Date: 2026-10-12
- Builds on: ADR 0001 (isolated signing service), ADR 0004 (outbox, record before broadcast)

## Context

Whoever can sign as the Issuance Safe can mint tokens. Until now the dev keys were read by whatever process needed them. The threat model (§4.2) requires these controls:

- Keys are isolated in one place.
- Every signature is checked against an explicit policy.
- Large or sensitive actions need two people.
- Every decision leaves a tamper-evident record.

The owner's bar for this step: reliable, fast, secure and up to standard.

## Decision

**One signing service (`@pt/signer`).** It is a separate process and the only holder of signing keys. Other services ask it for signatures over an internal API and never see a key.

- **Key custody behind an interface (S-1).** `KeyProvider` exposes only `address(ref)` and `signTransaction(ref, tx)`.
  - **Local development:** encrypted key files. AES-256-GCM, with the key reference and address as associated data. The key is derived with scrypt (N = 2^15) from a passphrase of at least 32 characters. Files are written once (`wx`) with mode 0600, and key material never appears in JSON or `inspect` output.
  - **Production:** an HSM (FIPS 140-3 Level 3) or MPC provider behind the same interface, with keys generated inside the device (NIST SP 800-57, CCSS key generation and storage).
  - The database stores key references and addresses only.
- **Policy engine, deny by default (S-2).**
  - Each command kind has one active, versioned policy. A new version becomes active only when an operator other than its proposer approves it.
  - The mint policy pins: the chain ID, the exact IssuanceGuard address, the signing key, a per-command maximum, a daily maximum (Pakistan time) and the approval threshold. It also requires that the recipient is verified in the identity registry, the token is not paused and the trustee cap holds.
  - Every allowed call is simulated (`eth_call`) before signing.
  - Facts are read fresh for each decision, and again at signing time for requests that waited for approval.
- **Maker-checker (S-3).** A request above the threshold waits for the policy's number of approvals from distinct operators. The requester cannot approve. One rejection is final. Approvals expire with the request (24 h).
  - The outbox treats waiting as `DeferredError`: the command goes back to pending without using up an attempt.
- **Nonces (S-4).** Nonces are reserved per address in the database under a lock, starting from the node's pending nonce.
  - A reservation that is never broadcast is released and reused, lowest first, so no gaps are left.
  - A stale reservation (2 minutes) at or above the node's pending nonce is released automatically: the node shows the transaction as neither mined nor pending.
  - A request whose broadcast transaction is proven dropped (no receipt, mined nonce past it) may be signed again.
- **Sign, never broadcast.** The service returns the signed transaction. The outbox worker records it (outbox O-5), broadcasts it, then reports `broadcast`. If recording fails it reports `release`. The signer never broadcasts, so the outbox's exactly-once argument (ADR 0004) is unchanged.
- **Audit (S-5).** Every request, decision, approval, signature, broadcast, release and policy change is appended to `signer.audit`. Each entry is hash-chained to the previous one, and `signer.verify_audit()` detects any change.
- **API.** The API is plain `node:http` (no new dependency).
  - It is bound to 127.0.0.1 here; in production it sits on a private network with mTLS.
  - Every request carries an HMAC-SHA256 over method, path, timestamp, one-time nonce and body hash. Requests outside a 30 s skew or replayed are refused, bodies are capped at 32 KB, only JSON is accepted, and errors never echo internals.
- **Speed.**
  - Gas limits are fixed per kind in the policy (a mint uses about 390k, the limit is 800k), because estimating gas costs 0.7–1 s per call on Besu. Simulation guarantees the call succeeds, and gas is free on the private chain.
  - The chain ID is cached, and independent chain reads run in parallel.

## Measured (this laptop, local Besu)

| What | p50 | p99 |
|---|---|---|
| Signer's own work (policy, database, nonce, signature, audit) | 6.2 ms | 8.9 ms |
| Full signature over HTTP including Besu reads (identity check, supply, cap, simulation, nonce) | 29 ms | 37 ms |

Before the fixed gas limit: p50 738 ms. Besu reads vary from run to run; the identity-registry check alone takes 20–95 ms.

## Consequences

- The web prototype still uses its demo signer. It moves onto outbox + signer next.
- Production needs, in this order:
  - an HSM/MPC `KeyProvider`
  - mTLS between services
  - operator authentication (passkeys + SSO) in the Step 6 portals, replacing the CLI
  - the service running as `pt_signer` with only the grants in `0004_signer.sql`
- Operators approve with `npm run signer:decide` until the operations portal exists.

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

- The web prototype moved onto outbox + signer in Step 5h ([ADR 0010](0010-website-integration.md)): the demo signer is gone, investor wallets are custodial wallets of this service (`KeyProvider.signMessage` and a custody provider were added for that), and the new kinds `token.transfer`, `identity.create`, `identity.add_claim` and `identity.register` follow the same deny-by-default rules. API clients are scoped per path (`@pt/http-auth`).
- Production needs, in this order:
  - an HSM/MPC `KeyProvider`
  - mTLS between services
  - operator authentication (passkeys + SSO) in the Step 6 portals, replacing the CLI
  - the service running as `pt_signer` with only the grants in `0004_signer.sql`
- Operators approve with `npm run signer:decide` until the operations portal exists.

## Amendment 2026-10-13: offering mints (spec S-02 OF-46, T-020)

- The `issuance.mint` policy has a new field `requireOfferingBatch` (default `false`). When `true`, the signer asks the database `offering.mint_allowed(refId, to, amount)` (granted to `pt_signer`, nothing else in schema `offering`) and denies unless the refId is an allocation in the **approved issuance batch** of an offering **in its mint window** (Completing, `start_minting` done), with the same wallet and units, a booked `sub:<refId>:paid` and no refund; a subscription in Issuance Review is allowed only with an approved V17 retry. Denials read `offering: <reason>`; an unavailable fact denies.
- Default `false` keeps the web prototype's mints (no offering) working; **production policies must set it to `true`** (a policy change is approved by a second operator, S-2) once investors subscribe through offerings. Tested in `signer/test/keystore-policy.test.ts` and `offering/test/lifecycle.test.ts`.
- Not changed: how the signer key relates to a 2-of-3 Issuance Safe in production (S-02 Q-8), the `token.pause` and `document.add` kinds.

## Amendment 2026-10-13: compliance unfreeze (Step 6c, T-005, migration 0019)

- New kind `compliance.unfreeze` (`FreezeGuard.unfreezeAddress(account, caseId)`), same rule shape as `compliance.freeze`. The signer asks the database `compliance.unfreeze_allowed(account, caseId)` (granted to `pt_signer`) and denies unless an unfreeze was approved by two different compliance officers in the portal for exactly that wallet and caseId and its hold is lifted; it also denies when the owner is not KYC-verified, the wallet is not frozen, or the daily limit is reached. Policy `approvals: 0` is the default because the maker-checker happened in the database; a policy may still require approvals. `npm run signer:setup` activates it locally.
- `compliance.freeze` is unchanged: a compliance freeze of a verified investor is signed because the approved freeze places a hold that makes the investor read `suspended` (not verified) in `kyc.subject_status()` (ADR 0011 section 11).
- Tested in `signer/test/compliance-freeze.test.ts` and `signer/test/preview.test.ts`.

## Amendment 2026-10-13: trustee co-signature (Step 6d, T-006, migration 0023)

- The maker-checker of the signing service gains a second capacity. Kinds the specs assign to the trustee are listed in `signer.trustee_cosign_kinds` (today `issuance.mint`: the Issuance Safe always includes a trustee signer, contract-spec section 3, S-02 sections 3 and 8). A request of such a kind that needs approvals under its policy (amount above `approvalAbove`) needs **one trustee approval in addition to** the policy's `approvals` platform approvals. The requirement is set by a trigger on insert (`trustee_approvals_needed`; the service cannot lower it) and never changes; requests already waiting when 0023 ran need it as well.
- An approval's `capacity` (`platform` | `trustee`) is set by a trigger from the approver: `trustee` exactly when the name is an active portal officer holding the `trustee_officer` role (bound to that officer's session, 0016 A-3), so a trustee officer can approve only through the portal. `signer.decide` counts the capacities separately, refuses a platform approval once the platform part is complete ("only the trustee co-signs now") and a trustee approval on a request that needs none; a trigger re-checks `pending_approval -> approved`, so a direct UPDATE cannot skip the trustee (deny by default).
- The portal obtains a ticket of capacity `trustee` (`admin.issue_trustee_ticket`, permission `trustee.decide`, step-up, payload hash); the service redeems it through the unchanged `/v1/decide` after recomputing the call (call hash over the exact calldata). The policy schema is unchanged; the preview's rule text for mints mentions the co-signature.
- Not changed: requests at or below the threshold (no approvals), other kinds, how the signing key relates to the 2-of-3 Issuance Safe in production (S-02 Q-8). The off-chain rule is stricter than a Safe 2-of-3 (platform approvals plus the trustee); owner and trustee to confirm (ADR 0011 open item 11).
- Tested in `signer/test/trustee-cosign.test.ts`, `signer/test/officer-approval.test.ts`, `signer/test/service.test.ts`, the admin HTTP matrix and the admin e2e.

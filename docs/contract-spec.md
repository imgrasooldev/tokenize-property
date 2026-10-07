# Smart Contract Specification

- Version: 0.1 (draft for review)
- Date: 2026-10-08
- Scope: contracts deployed per property on the private Besu chain, plus the public-chain anchor.

This document is the source of truth for Step 3. Code and tests must match it. Any change to behaviour starts here.

---

## 1. Design principles

1. **Contracts never hold money.** No `payable` functions, no ERC-20 balances. Rent and investments move in PKR through banks. Contracts record ownership and entitlements only.
2. **Reuse audited code.** The token, identity registry and compliance framework come from the official ERC-3643 implementation (`github.com/ERC-3643/ERC-3643`, pinned to a release tag). The older `TokenySolutions/T-REX` repo is deprecated and is not used.
3. **Small custom code, narrow permissions.** Our own contracts are small "guard" contracts. Each one exposes exactly one kind of power and adds limits (delays, caps, rate limits). No person or server key is ever a direct agent or owner of the token.
4. **No single key can do damage.** Every powerful action needs a multisig, a timelock, or both.
5. **Non-upgradeable guards.** Our guard and registry contracts are not proxies. To change one, deploy a new version and swap it in through the timelock. The ERC-3643 core uses its own proxy pattern; its upgrades also go through the timelock.
6. **Everything emits an event.** The indexer and auditors rebuild full history from events alone.

## 2. Contract overview

```
                     ┌───────────────────────────────┐
                     │ TimelockController (72h)      │  owner of every ERC-3643 contract
                     │ proposer/executor: Admin Safe │  and of every guard
                     │ canceller: Admin + Trustee    │
                     └──────────────┬────────────────┘
                                    │ owns
   ┌────────────────────────────────┼─────────────────────────────────────┐
   ▼                                ▼                                     ▼
ERC-3643 core (audited)        Guards (ours, the only token agents)   Registries (ours)
- Token (per property)         - IssuanceGuard   mint / burn          - DistributionRegistry
- IdentityRegistry             - PauseGuard      pause / unpause      - DocumentRegistry
- IdentityRegistryStorage      - FreezeGuard     freeze / unfreeze
- ModularCompliance + modules  - RecoveryGuard   recovery, forced transfer
- ClaimTopicsRegistry          - RegistrarGuard  register investors (rate-limited)
- TrustedIssuersRegistry
- ONCHAINID (per investor)

Public chain:  StateAnchor  (hourly hash of the private chain)
```

## 3. Actors and keys

| Actor | Type | Holders | Used for |
|---|---|---|---|
| Admin Safe | Safe multisig, 3-of-5 | Directors and CTO, hardware wallets, at least 2 cities | Proposes and executes timelock operations; unpause |
| Trustee Safe | Safe multisig, 2-of-3 | Trustee officers (e.g. CDC) | Co-signs issuance, recovery, distribution rejection; can cancel timelock operations |
| Issuance Safe | Safe multisig, 2-of-3, at least 1 trustee signer | Ops lead + trustee | Calls `IssuanceGuard` |
| Ops Safe | Safe multisig, 2-of-3 | Operations staff | Freeze, documents, distributions, payouts |
| Pauser | Hot key (on-call) | On-call engineer | **Pause only** |
| Registrar | Hot key in the signing service (HSM) | Automated | Registers KYC-approved investors, under an on-chain rate limit |
| Claim issuer | Key in HSM | Automated KYC service | Signs KYC/AML claims on investor ONCHAINIDs |
| Anchor key | Hot key (HSM) | Automated | Writes hourly anchors on the public chain |

**Rule:** a hot key can only do things that are safe to do too often (pause, register an already KYC-approved investor, anchor a hash). Anything that can move or create value needs a multisig.

## 4. ERC-3643 core configuration

### 4.1 Token (one per property)

| Parameter | Value |
|---|---|
| Name / symbol | e.g. "Gulberg Plaza Floor 3" / `GPF3` |
| Decimals | 0 (one token = one unit on the trustee register; no fractions of units) |
| Owner | TimelockController |
| Agents | `IssuanceGuard`, `PauseGuard`, `FreezeGuard`, `RecoveryGuard` only |
| Identity registry | Shared `IdentityRegistry` |
| Compliance | One `ModularCompliance` per token |

### 4.2 Identity

- Every investor wallet is linked to an **ONCHAINID** identity contract.
- Required claim topics (in `ClaimTopicsRegistry`): `1 = KYC`, `2 = AML_SCREENED`.
- Trusted issuer: our KYC claim-issuer contract only.
- Country code stored in the registry (ISO 3166 numeric, Pakistan = 586).
- The only identity-registry agent is `RegistrarGuard`, and it can only register. Deleting or updating an identity goes through the timelock.

### 4.3 Compliance modules

| Module | Rule | Default |
|---|---|---|
| Country allow | Only listed investor countries can hold | `[586]` plus countries approved by legal |
| Max balance | No single investor holds more than X% of supply | 10% |

**Open item (Step 3):** the current ERC-3643 repo ships only the module framework. The concrete modules above existed in the deprecated T-REX repo (Hacken audit, April 2023). Step 3 decides between porting those audited modules unchanged or writing minimal ones. Either way they get full tests and go into our audit scope.

Supply cap is **not** a compliance module. It is enforced in `IssuanceGuard` (section 5.1), so it cannot be bypassed by a misconfigured module list.

## 5. Guard contracts (custom)

All guards:
- are owned by the TimelockController;
- use custom errors and emit an event for every state change;
- have no `payable`, no `delegatecall`, no `selfdestruct`;
- are not upgradeable.

### 5.1 IssuanceGuard

Only path to `mint` and `burn`.

| Function | Caller | Behaviour |
|---|---|---|
| `setTrusteeCap(uint256 cap)` | Timelock | Sets the number of units on the trustee register. Cannot go below current `totalSupply`. |
| `mint(address to, uint256 amount, bytes32 refId)` | Issuance Safe | Reverts if `totalSupply + amount > trusteeCap`. `refId` links to the off-chain subscription record; each `refId` can be used once. |
| `burn(address from, uint256 amount, bytes32 refId)` | Issuance Safe | For redemptions and exits; `refId` used once. |

Events: `TrusteeCapSet(old, new)`, `Minted(to, amount, refId)`, `Burned(from, amount, refId)`.

### 5.2 PauseGuard

Fixes the gap where ERC-3643's agent role can both pause and unpause.

| Function | Caller | Behaviour |
|---|---|---|
| `pause(string reason)` | Pauser **or** Ops Safe **or** Admin Safe | Pauses the token immediately |
| `unpause()` | Admin Safe only | Unpauses |
| `setPauser(address)` | Timelock | Rotates the pauser key |

A stolen pauser key can only stop trading, which is safe. It cannot restart it.

### 5.3 FreezeGuard

| Function | Caller | Behaviour |
|---|---|---|
| `freezeAddress(address, bytes32 caseId)` | Ops Safe | Freezes all tokens of an address (court order, fraud case) |
| `unfreezeAddress(address, bytes32 caseId)` | Ops Safe | |
| `freezePartial(address, uint256, bytes32 caseId)` / `unfreezePartial(...)` | Ops Safe | Freezes part of a balance |

`caseId` links to the compliance case file; it is stored only in events.

### 5.4 RecoveryGuard

For lost wallets, deceased investors (succession) and court orders. Two steps with a delay.

| Function | Caller | Behaviour |
|---|---|---|
| `propose(Kind kind, address from, address to, uint256 amount, bytes32 evidenceHash)` | Trustee Safe | Creates a request. `kind` is `WalletRecovery` or `ForcedTransfer`. `evidenceHash` is the hash of the court order or identity re-verification file in `DocumentRegistry`. |
| `execute(uint256 id)` | Trustee Safe | Only after `RECOVERY_DELAY` (48h) and if not cancelled. Executes once. |
| `cancel(uint256 id)` | Admin Safe or Trustee Safe | Cancels a pending request |

`to` must already be a verified identity. Events: `RecoveryProposed`, `RecoveryExecuted`, `RecoveryCancelled`.

### 5.5 RegistrarGuard

Registers KYC-approved investors in the identity registry. Called many times a day by the signing service, so it is rate-limited on-chain.

| Function | Caller | Behaviour |
|---|---|---|
| `register(address wallet, IIdentity identity, uint16 country)` | Registrar key | Registers an identity. Reverts if the rolling 1-hour count exceeds `maxPerHour` (default 50). The identity must already hold valid KYC and AML claims from the trusted issuer. |
| `setRegistrar(address)` / `setMaxPerHour(uint32)` | Timelock | |

A stolen registrar key can register at most 50 wallets per hour, and only identities that already carry a valid claim from our HSM-held claim issuer. The monitor alerts on any registration not matching a KYC record in the database.

## 6. Registry contracts (custom)

### 6.1 DistributionRegistry

Records rent distributions so every investor can verify their own entitlement. No money moves on-chain.

Flow:

1. The backend computes each holder's balance at `recordBlock` from chain events, works out the PKR entitlement, and builds a Merkle tree of `(wallet, amountPaisa)` leaves.
2. Ops Safe calls `publish(token, recordBlock, merkleRoot, totalPaisa, statementHash)`.
3. A `CHALLENGE_WINDOW` of 48h starts. The trustee (or anyone off-chain) can recompute the root. The Trustee Safe can call `reject(id, reason)` in this window.
4. After the window, anyone can call `finalize(id)`.
5. The bank pays investors. Ops Safe calls `recordPayout(id, bankBatchHash)`.

| Rule | |
|---|---|
| `recordBlock` | Must be in the past |
| IDs | Strictly increasing per token |
| Root, total | Immutable once published |
| Finalize | Only after the window and only if not rejected |
| Payout | Only once, only for a finalized distribution |
| `verify(id, wallet, amount, proof)` | Public view: lets any investor check their leaf |

Amounts are in **paisa** (integer), never floating point.

### 6.2 DocumentRegistry

Append-only record of document hashes per token: title deed, fard, valuations, insurance, trust deed, audit reports, Shariah certificate, court orders.

- `add(token, DocType docType, bytes32 sha256, string uri)`: Ops Safe.
- `supersede(oldId, newId)`: marks an old document as replaced. Nothing is ever deleted or overwritten.
- `uri` points to the private document store and contains no personal data.

## 7. Public-chain anchor

`StateAnchor` on a public EVM chain:

- `anchor(uint64 besuBlock, bytes32 besuBlockHash)`: anchor key, hourly.
- `besuBlock` must be strictly greater than the last anchored block. Anchors are never overwritten.
- Anchor key rotation: owner is a Safe on the public chain.

Anyone with read access to the private chain can check that its history matches the public anchors.

## 8. Invariants

Each invariant becomes a Foundry invariant or fuzz test in Step 3. A failing invariant blocks merge.

| ID | Invariant |
|---|---|
| I-1 | `sum(balanceOf(all holders)) == totalSupply` |
| I-2 | `totalSupply <= trusteeCap` |
| I-3 | Every address with a balance above 0 was a verified identity when it received tokens |
| I-4 | A transfer to an unverified address always reverts |
| I-5 | A frozen address cannot send; frozen partial amounts cannot move |
| I-6 | While paused, no ordinary transfer succeeds |
| I-7 | No protocol contract holds native coin or any ERC-20 balance |
| I-8 | Token agents are exactly the four guards; no EOA is an agent or owner of any protocol contract |
| I-9 | The owner of every protocol contract is the TimelockController, and its minimum delay is at least 72h |
| I-10 | Only the Admin Safe can unpause |
| I-11 | Each `refId` in `IssuanceGuard` is used at most once |
| I-12 | Registrations in any 1-hour window never exceed `maxPerHour` |
| I-13 | A recovery request executes at most once, only after its delay, and never after cancellation |
| I-14 | Distribution IDs strictly increase; a published root never changes; finalize happens only after the window and only if not rejected; payout is recorded at most once |
| I-15 | Document records are never deleted or modified |
| I-16 | Anchored block numbers strictly increase |

**To verify in Step 3 against ERC-3643 source:** whether forced transfer and recovery work while the token is paused. Desired behaviour: yes, so the trustee can act during an incident.

## 9. Deployment procedure (summary)

1. Deploy Safes (Admin, Trustee, Issuance, Ops) and the TimelockController.
2. Deploy the ERC-3643 suite through its factory, with the deployer as temporary owner.
3. Deploy guards and registries; add the four guards as token agents and `RegistrarGuard` as identity-registry agent.
4. Transfer ownership of every contract to the TimelockController.
5. **Renounce** all deployer roles. Run the post-deploy check script, which asserts I-8 and I-9 on-chain.
6. Verify that deployed bytecode matches the audited commit.
7. Destroy the deployer key.

## 10. Out of scope for v0.1

- Secondary market or order book (needs regulatory approval first).
- On-chain voting for property sale (the trustee handles sale votes off-chain for now; the vote result hash goes into `DocumentRegistry`).
- Stablecoin or any on-chain payment.

## 11. Open questions

1. GPL-3.0 licence of ERC-3643: legal review required.
2. Compliance modules: port from audited T-REX or write minimal (section 4.3).
3. Max balance default (10%) and retail investment limits: business and legal decision.
4. Public chain for anchoring: Ethereum mainnet (most trusted, higher fees) or an L2 such as Base or Polygon (cheap).

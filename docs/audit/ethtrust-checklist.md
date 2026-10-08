# EthTrust Security Levels: Self-Assessment

- Target: **Security Level [Q]** (highest)
- Specification: EEA EthTrust Security Levels, v3 Editor's Draft ("v-after-2"), fetched 2026-10-08 from `entethalliance.github.io/wg-ethtrust-site/spec/v3/`. Requirement IDs below are the anchor IDs in that document. Re-check against the published version before the audit.
- Scope: our contracts in `contracts/src/` (guards, registries, anchor) at the commit containing this file. Vendored ERC-3643 / ONCHAINID / T-REX code is assessed separately in section 5.
- Status: **self-assessment only.** EthTrust certification requires an independent auditor.

Legend: **Met**, **N/A** (the construct is not used), **Exception** (deviation with documented reason, for the auditor to rule on), **Not met**.

## 1. Evidence used

| Evidence | Where |
|---|---|
| Spec and invariants | `docs/contract-spec.md` (v0.3) |
| Threat model | `docs/threat-model.md` |
| Tests | `contracts/test/` (120 tests: unit, fuzz, invariant over 25,600 random calls) |
| Coverage | 100% lines, statements, branches, functions on `src/` (excluding vendor) |
| Static analysis | Slither 0.11.6: 0 results; `forge lint`: 0 warnings |
| Source scan | No non-ASCII characters; no `assembly`, `delegatecall`, `selfdestruct`, `CREATE2`, `tx.origin`, `unchecked`, `assert`, `payable`, `abi.encodePacked` or `ecrecover` in `src/` (outside `src/vendor/`) |
| Compiler | `pragma solidity 0.8.30` (exact) for all our files; optimizer 200 runs, no via-IR, settings pinned in `foundry.toml` |

## 2. Security Level [S]

| Requirement | Status | Notes |
|---|---|---|
| `req-1-eip155-chainid` Encode Hashes with chainid | N/A | Our contracts verify no signatures. Vendor: see 5.3. |
| `req-1-no-create2` No CREATE2 | Met | Not used in our code. (Vendor factory uses it; see 5.) |
| `req-1-exact-balance-check` No Exact Balance Check | Met | No balance equality checks. |
| `req-1-no-hashing-consecutive-variable-length-args` | Met | Merkle leaves use `abi.encode`, never `encodePacked`. |
| `req-1-self-destruct` No selfdestruct() | Met | |
| `req-1-no-assembly` No assembly {} | Met | (Assembly exists only in `script/DeployLib.sol`, which is never deployed.) |
| `req-1-unicode-bdo` No Unicode Direction Control Characters | Met | Source is pure ASCII. |
| `req-1-check-return` Check External Calls Return | Met | `RecoveryGuard.execute` checks the `bool` from `forcedTransfer`/`recoveryAddress` and reverts with `ExecutionFailed`; tested with a false-returning mock. Other token calls return nothing and revert on failure. |
| `req-1-use-c-e-i` Use Check-Effects-Interaction | Met | State changes (`refUsed`, request status, rate-limit ring) and events happen before external calls. |
| `req-1-delegatecall` No delegatecall() | Met | |
| `req-1-compiler-sol-2021-4` | Met | solc 0.8.30 is not affected. |
| `req-1-compiler-060` / `req-1-no-ancient-compilers` | Met | solc 0.8.30. |
| `req-1-inheritance-conflict` No Conflicting Names | Met | Single inheritance chain (`Governed` → `Ownable2Step`). |
| `req-1-overflow-underflow` No Overflow/Underflow | Met | Checked arithmetic, no `unchecked`. `uint64` timestamp casts are annotated and safe. |
| `req-1-explicit-storage` Explicit Storage | Met | |

## 3. Security Level [M]

| Requirement | Status | Notes |
|---|---|---|
| `req-2-pass-l1` | Met | Section 2. |
| `req-2-enforce-eval-order` | Met | No expressions whose result depends on evaluation order. |
| `req-2-verify-exact-balance-check` | N/A | |
| `req-2-unicode-bdo`, `req-2-no-homoglyph-attack` | Met | ASCII only. |
| `req-2-external-calls` Protect External Calls | Met | Guards call only the token / identity registry fixed as `immutable` at construction; both are timelock-owned protocol contracts. |
| `req-2-avoid-readonly-reentrancy` | Met | No view function is relied on by others mid-update. |
| `req-2-handle-return` | Met | See `req-1-check-return`. |
| `req-2-documented` Document Special Code Use | Met | No special code. Lint suppressions carry written reasons. |
| `req-2-check-rounding` | Met (on-chain) | No division on-chain. Entitlements are integer paisa computed off-chain; rounding rules must be documented in the backend spec (Step 5). |
| `req-2-self-destruct`, `req-2-safe-assembly`, `req-2-protect-create2` | N/A | |
| `req-2-overflow-underflow` | Met | |
| `req-2-random-enough` | N/A | No randomness. |
| `req-2-block-data-misuse` Don't Misuse Block Data | Met | `block.timestamp` only for delays of 1h to 72h; QBFT validators can skew by seconds. Documented at each use. `block.number` only to require `recordBlock` is in the past. |
| `req-2-signature-verification`, `req-2-malleable-signatures-for-replay`, `req-2-validate-ecrecover-input` | N/A (ours) / **Not met (vendor)** | Our code verifies no signatures. ONCHAINID fails these; see 5.1 (finding F-01). |
| `req-2-compiler-060` | Met | |
| `req-2-no-failing-asserts` | Met | No `assert`. |
| `req-2-safe-inheritance-order` | Met | |
| `req-2-explicit-storage` | Met | |
| `req-2-compiler-check-payable-constructor`, `req-2-compiler-check-identity-calls`, `req-2-compiler-no-zero-ether-send` | Met | solc 0.8.30 not affected. |

## 4. Security Level [Q]

| Requirement | Status | Notes |
|---|---|---|
| `req-3-pass-l2` | Met for our code | Section 3. Vendor gaps mitigated, see 5. |
| `req-3-timelock-for-privileged-actions` | Met | Every owner is a 72h `TimelockController` (enforced by `DeployLib`); Trustee Safe can cancel. Recovery has its own 48h delay; distributions a 48h challenge window. |
| `req-3-linted` Code Linting | Met | `forge fmt --check`, `forge lint`, Slither in CI. |
| `req-3-enough-gas`, `req-3-protect-gas` | Met | No unbounded loops in state-changing code. `recentRegistrations()` (view) loops at most 500. |
| `req-3-check-oracles` | N/A | No oracles. |
| `req-3-block-front-running`, `req-3-block-mev` | Met | Permissioned chain, no public mempool; every state change is gated to a specific Safe or key, so ordering cannot be exploited by third parties. |
| `req-3-protect-governance` | Met | Admin Safe 3-of-5 + 72h timelock + Trustee cancel; module and implementation-authority ownership also timelocked (I-9). |
| `req-3-all-valid-inputs` Process All Inputs | **Partial** | All addresses, amounts, hashes and IDs are validated. `DistributionRegistry.publish` and `DocumentRegistry.add` accept any non-zero `token` address; a wrong address is caught by trustee review, not on-chain. Auditor to rule; option: restrict to a timelock-managed token list. |
| `req-3-event-on-state-change` | Met | Every state change emits an event, including role rotations. |
| `req-3-no-private-data` | Met | Only addresses, hashes and amounts on-chain. |
| `req-3-intended-replay` | N/A | |
| `req-3-documented`, `req-3-document-system`, `req-3-document-threats` | Met | `contract-spec.md`, `product-map.md`, `threat-model.md`. |
| `req-3-annotate` Annotate Code with NatSpec | Met | All external and public functions carry NatSpec. |
| `req-3-implement-as-documented` | Met | Invariants I-1 to I-17 map one-to-one to named tests. |
| `req-3-access-control` Enforce Least Privilege | Met | Each guard exposes exactly one power; no person or server key is a token agent or owner (I-8). |
| `req-3-revocable-permisions` | Met | Every role is rotatable through the timelock; `Ownable2Step`; renounce disabled to avoid bricking. |
| `req-3-no-single-admin-eoa` | **Exception** | Three single keys exist by design, each limited to a "safe direction": the **pauser** can only pause (unpause needs the Admin Safe); the **registrar** can only register already-verified identities, at most 50 per hour; the **anchor key** can only append hashes. All are rotatable via the timelock. |
| `req-3-external-calls` Verify External Calls | Met | Targets are immutable protocol contracts. |
| `req-3-consistent-solidity-output` | Met | Exact pragma, pinned compiler settings, `bytecode_hash = "none"` for reproducible bytecode. |

## 5. Vendored code (ERC-3643 4.1.3, ONCHAINID 2.2.1, T-REX 4.1.6 modules)

Vendored code is used unchanged and pinned to tags. Its own gaps against EthTrust, and how we contain them:

### 5.1 F-01: ONCHAINID claim revocation bypass (signature malleability)
`ClaimIssuer` accepts several encodings of one signature and keys revocation by raw bytes (`req-2-malleable-signatures-for-replay`, `req-2-validate-ecrecover-input`, `req-2-signature-verification`). **Mitigation:** never rely on revocation; freeze, then move or redeem tokens, then delete the identity through the timelock. See `docs/findings/F-01-*.md`.

### 5.2 F-02: MaxBalanceModule identity coupling
Deleting or updating the identity of a wallet that still holds tokens strands those tokens. **Mitigation:** offboarding order is freeze → forced transfer or burn → delete identity; never `updateIdentity` on a holding wallet (use wallet recovery). See `docs/findings/F-02-*.md`.

### 5.3 F-03 (informational): claim signatures do not include chainid
ONCHAINID signs `keccak256(abi.encode(identity, topic, data))` without `chainid` (`req-1-eip155-chainid`). Identity addresses come from `CREATE2` in the ID factory, so the same identity address can exist on another chain, where a claim could be replayed. **Mitigation:** the claim-signer key is used for exactly one chain; a separate key per network.

### 5.4 Compiler 0.8.17
Vendored code pins solc 0.8.17. Its listed known bugs (`VerbatimInvalidDeduplication`, `FullInlinerNonExpressionSplitArgumentEvaluationOrder`, `MissingSideEffectsOnSelectorAccess`) need via-IR, a custom optimizer sequence, or `.selector` on side-effecting expressions respectively. We compile without via-IR and with the default optimizer; the auditors should confirm the third does not occur in vendored code.

### 5.5 Audit coverage
ERC-3643 core: Hacken audit, April 2023. **T-REX modules 4.1.6 post-date that audit** and are in our external audit scope.

## 6. Open items before certification

1. Auditor ruling on the `req-3-no-single-admin-eoa` exception and the `req-3-all-valid-inputs` partial.
2. Formal verification of the guards (planned: Certora or Halmos).
3. Two independent external audits, including vendored modules and findings F-01 to F-03.
4. Re-map this checklist to the published EthTrust version current at audit time.

# F-02: MaxBalanceModule strands tokens if a holder's identity changes

| | |
|---|---|
| Component | T-REX 4.1.6 `MaxBalanceModule` (vendored, not our code) |
| Severity for us | **Medium** (tokens frozen in place, not stolen); **mitigated** by procedure |
| Found | 2026-10-08, Step 3 module review |
| Status | Mitigated by operating procedure; auditors to confirm |
| Proof | `contracts/test/Compliance.t.sol` → `OffboardingProcedureTest` |

## Issue

`MaxBalanceModule` tracks balances per ONCHAINID and looks up the sender's identity in the identity registry on every transfer and burn.

1. **Identity deleted while holding tokens:** the lookup reverts with `"identity not found"`. The tokens can no longer be burned or force-transferred.
2. **Identity updated while holding tokens:** the module's record stays under the old identity, the wallet now maps to a new identity with a zero record, and the next transfer underflows and reverts.

## Impact

An investor's tokens can become permanently stuck, including for the trustee acting on a court order. This would also break the obvious F-01 response ("delete the identity").

## Mitigation (in place)

Operating procedure, written into `contract-spec.md` section 4.2:

1. **Offboarding order:** freeze via `FreezeGuard` → move the tokens (forced transfer via `RecoveryGuard`) or redeem them (burn via `IssuanceGuard`) → only then delete the identity through the timelock.
2. **Never call `updateIdentity` on a wallet that holds tokens.** To change a holder's wallet, use wallet recovery, which keeps the same ONCHAINID.
3. Invariant I-17 checks that the module's per-identity record always equals the real balance.

The admin portal (Step 6) must enforce this order and refuse identity deletion while the wallet's balance is non-zero.

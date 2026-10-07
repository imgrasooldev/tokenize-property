# F-01: ONCHAINID claim revocation can be bypassed

| | |
|---|---|
| Component | ONCHAINID `ClaimIssuer` 2.2.1 (vendored dependency, not our code) |
| Severity for us | **High** if relied on; **mitigated** by design |
| Found | 2026-10-08, Step 3 dependency review |
| Status | Mitigated in our design; to report upstream; auditors to confirm |
| Proof | `contracts/test/findings/OnchainIdRevocationBypass.t.sol` |

## Issue

`ClaimIssuer` records revocations keyed by the **raw signature bytes** (`mapping(bytes => bool) revokedClaims`). Signature recovery (`getRecoveredAddress`) accepts more than one byte encoding of the same signature:

- `v` may be `0/1` or `27/28` (the code adds 27 when `v < 27`);
- there is no check that `s` is in the lower half of the curve order, so the "high-s" twin is also accepted.

A revoked investor can take their old claim signature, re-encode it, and add it to their identity again. `isClaimValid` then returns true, because the re-encoded bytes are not in `revokedClaims`, and the investor becomes verified again.

The test `test_F01_revokedClaimRevivedWithReencodedSignature` demonstrates this end to end against the real ERC-3643 identity registry.

## Impact

If we relied on claim revocation to offboard an investor (for example, after an AML hit), that investor could restore their own verification and keep receiving or sending tokens.

## Mitigation (in place)

We never rely on claim revocation alone. Offboarding an investor is:

1. **Immediately** freeze the wallet via `FreezeGuard` (Ops Safe). A frozen wallet cannot send, whatever its claims say.
2. Delete the identity from the identity registry through the 72h timelock. The timelock is an identity-registry agent for this purpose.
3. Also revoke the claim at the issuer, for completeness and audit trail.

Tests `test_F01_mitigation_freezeStopsRevokedInvestor` and `test_F01_mitigation_registryDeletionThroughTimelock` prove steps 1 and 2.

## Follow-up

- Report upstream to the ONCHAINID maintainers (responsible disclosure).
- Ask both external auditors to confirm the finding and the mitigation.
- Consider claim data that includes an expiry date, so stale claims age out even without revocation.

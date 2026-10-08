# ADR 0002: Local Besu network and the dev-only timelock exception

- Status: Accepted
- Date: 2026-10-08

## Context

Step 4 runs the real contracts on a real QBFT network. Two constraints shaped it:

1. The machine has no Docker. Besu 26.9 (current release) requires Java 25; the system has Java 21, which other projects use.
2. `DeployLib` enforces a 72-hour timelock. On a real chain time cannot be fast-forwarded, so go-live (trustee cap through the timelock) could not be exercised locally.

## Decision

- Run Besu **26.9.0** natively with a **portable Temurin JDK 25** in `chain/tools/` (git-ignored, checksums recorded in `chain/README.md`). The system Java is untouched.
- Four validators, static peering with discovery off, node allow-list, RPC on localhost only.
- Reserve **chain ID 586586** for the local dev network. On that chain only, `DeployLib` accepts a timelock of at least **60 seconds**; everywhere else 72 hours remains mandatory.
- Defence in depth: `Deploy.s.sol` also refuses chain ID 586586 unless `LOCAL_DEV_NETWORK=true` is set explicitly, so a network misconfigured with that ID cannot get a short timelock by accident.

## Consequences

- Tests prove the 72h rule still holds on chain IDs 1, 31337 and 586587, and that the exception needs at least 60 s on 586586 (`test_shortTimelockOnlyOnLocalDevChain`).
- Production and staging genesis files must use a different chain ID; this is part of the production genesis review (threat SC-14).
- Recovery (48h) and distribution finalisation (48h) cannot complete locally; they stay covered by the Foundry tests with time warps.

# Changelog

Built only from `git log` of `main` up to `41241b3` (60 commits). Dates are commit dates. Grouped by date and step; commit hashes in brackets.

## 2026-10-13

- Contracts: 5 tests proving agent actions while paused or frozen (mint refused; redemption burn, trustee forced transfer and burn of frozen tokens work; investor transfers blocked), as assumed by specs S-04/S-05/S-06; 137 forge tests.
- Functional specs S-01..S-07 merged (docs/specs).
- Documentation set from the code audit merged (docs/*.md).
**Step 5f review fixes and Step 5g**
- Fix Step 5f review findings F-04..F-06: migration 0008 (signer audit digest v2 in UTC, forward-only ledger running balances, `IS DISTINCT FROM` validation) [c986aa0]
- Step 5g: KYC and bank with mock providers and a mock bank (ADR 0009, migration 0009) [19e5cc6]
- Record the three Step 5g decisions in ADR 0009 and MEMORY.md [2fb13a3]

**Step 5h (parts 1-4)**
- Held payouts (migration 0010, ADR 0009 decision 2) [88d43cf]
- Signer kinds `compliance.freeze` and `rent.record_payout`; automatic offboarding (migration 0011) [246f2e9]
- Record paid distributions on chain through the outbox [07d03b2]

**Tests**
- Gate the signer speed test on the median on CI [41241b3]

## 2026-10-12

**Step 5c-5f-2 (backend)**
- Step 5c outbox with exactly-once execution on chain [4ed0721]
- Step 5d signing service, policy engine and maker-checker [ee3347e]
- Step 5e indexer and chain read model [2fdff6d], merged [0254836]; ADR 0006 accepted [23277dd]
- Step 5f reconciliation (chain, ledger, bank) and payout freeze [30ead63], merged [926f71d]
- Step 5f-2 public-chain anchoring on a local stand-in [22ff1dc], merged [f1254cd]
- Fix flaky backend CI and bind Besu P2P to localhost [0647031]; measure signer p99 over 200 samples [aa6133f]; `net.py stop` waits for shutdown [89e8e08]

**Website**
- v2 design across the investor website [06e5847], merged [ba5a21c]
- Explicit demo-signer opt-in for the IP demo server [3d8a0b9]

**Deploy and demo**
- `demo.py` also starts the Live Demo Console [c2674d4]
- Private IP demo server and GitHub deploy pipeline [33df872]; fixes [5b945e5, 29af57d, 22cc395, 06786dd, 761c0a9]; mockups published at `/mockups/` [7451ecc]; Ploi plain-server notes [e6cd7e0]

**Design and docs**
- Website redesign mockups v1-v12 [92e90a7]; full v2 mockup suite [c8d8481], PDF [693107f], mobile mockups [6a01bdd, c7ece59]
- MEMORY updates [62db941, f4c6550, f7ec167, b2471e5, af66c09]

## 2026-10-11

- W4 demo secondary market with real-time chart [ff0d36b]
- W5 hardening, end-to-end tests, speed and presenter tooling [c58bf69]

## 2026-10-10

- Step 5a backend foundation on PostgreSQL 18 [4b5060c]
- Step 5b ledger enforced inside PostgreSQL [fbf3c33]
- Live Demo Console [b0d01e9]
- Website W1 properties and live chain data, EN/Urdu [00c6b2f]; W2 demo login, sign-up, mock KYC, on-chain onboarding [52bf75c]; W3 invest, portfolio, rent self-verification [957cadf]
- MEMORY updates [73aeb43, 59e8145, be5a7b1, a27e5e5]

## 2026-10-08

- Project setup, stack decision, contract spec and threat model [a69fdee]
- Security standards baseline [40f6402]
- Step 3 contracts: guards, registries and tests on ERC-3643 4.1.3 [7db5f90]; compliance modules, DeployLib, EthTrust self-assessment [21d240a]
- Project memory and lifecycle PDF [afc252a]; owner preferences and log [6fbe9ed]
- Step 4 local 4-validator Besu QBFT network and end-to-end flow [442af53]

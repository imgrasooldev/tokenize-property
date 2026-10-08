# Project Memory

The single place to pick this project up from. Read this first, then the linked docs. Update it at the end of every working session and at every step gate.

- Last updated: 2026-10-08
- Repository: https://github.com/imgrasooldev/tokenize-property (private)
- Local path: `D:\property-token`
- Current position: **Step 3 (smart contracts) done internally. Next: Step 4 (local Besu chain).**

---

## 1. What we are building

A permissioned platform for fractional ownership of real estate in **Pakistan**.

- An independent **trustee** (e.g. CDC) holds each property through a REIT or an SPV under the SECP sandbox.
- Investors hold **ERC-3643 security tokens** that mirror the trustee's register.
- **Rent and investments move in PKR through banks and Raast.** Smart contracts record ownership and entitlements only and never hold money.
- **Top priority: safety on every layer, especially the technical one. Second priority: fast response times.**

Full product list (websites, portals, apps, services): [docs/product-map.md](docs/product-map.md).

## 2. Decisions already made (do not re-open without a new ADR)

| Topic | Decision | Where |
|---|---|---|
| Token standard | ERC-3643, official repo `ERC-3643/ERC-3643` tag **4.1.3** (old `TokenySolutions/T-REX` is deprecated) | spec §1 |
| Compliance modules | T-REX **4.1.6** `CountryAllowModule` + `MaxBalanceModule`, unchanged; in our audit scope | spec §4.3 |
| Our contracts | Small non-upgradeable **guards** are the only token agents; solc **0.8.30**; OpenZeppelin **5.6.1** | spec §5 |
| Governance | Every owner is a **72h TimelockController**; Admin Safe 3-of-5 proposes/executes; Trustee Safe can cancel | spec §3 |
| Chain | Private **Hyperledger Besu QBFT**, 4 validators run by separate organisations, hourly hash anchor on a public chain | ADR 0001 |
| Server stack | All TypeScript: **NestJS on Fastify**, viem, PostgreSQL 16, Redis. Speed comes from never putting the chain in the read path | ADR 0001 |
| Frontends | **Next.js** for website, investor portal and internal portals; **Flutter** for the mobile app | ADR 0001 |
| Money | PKR only, via banks/Raast. No stablecoins, no on-chain payments | spec §10 |
| Max holding | 10% of the trustee register per investor identity (default 100,000 of 1,000,000) | spec §4.3 |
| Allowed countries | Pakistan (586) only, until legal approves more | spec §4.3 |
| Security standards | EthTrust [Q], OWASP ASVS L3, MASVS L2+R, CCSS III, NIST SSDF, SLSA L3, CIS, ISO 27001/SOC 2 | [security-standards.md](docs/security-standards.md) |

## 3. Development lifecycle and status

Full lifecycle document: [docs/Development-Lifecycle.pdf](docs/Development-Lifecycle.pdf).

| Step | Scope | Status |
|---|---|---|
| 1 | Repo, CI, stack decision | Done |
| 2 | Contract spec + threat model | Done (spec v0.3) |
| 3 | Smart contracts + tests | **Done (internal)**: 120 tests, 100% coverage, Slither 0, EthTrust [Q] self-assessment, deploy verified on Anvil |
| 4 | Local chain: Anvil, then 4-node Besu QBFT | **Next** |
| 5 | Backend: ledger, outbox, signing service, indexer, reconciliation | Not started |
| 6 | Internal portals: operations, compliance, trustee (maker-checker) | Not started |
| 7 | Investor web portal, website, verification page, Flutter app | Not started |
| Pre-launch | 2 external audits, formal verification, pen test, SECP pilot | Not started |

Rule: a step starts only after the previous gate passes and the owner approves.

## 4. Security findings (all in vendored code; ours is clean so far)

| ID | Issue | Mitigation |
|---|---|---|
| [F-01](docs/findings/F-01-onchainid-claim-revocation-bypass.md) | ONCHAINID claim revocation bypass via re-encoded signature | Never rely on revocation. Offboard = freeze, then move/redeem tokens, then delete identity via timelock |
| [F-02](docs/findings/F-02-maxbalance-identity-coupling.md) | MaxBalanceModule strands tokens if a holder's identity is deleted or updated | Same offboarding order; never `updateIdentity` on a holding wallet; admin portal must enforce |
| F-03 | ONCHAINID claim signatures lack `chainid` | One claim-signer key per chain |

## 5. Gotchas learned the hard way

- **ERC-3643 tokens deploy paused.** Go-live = timelock sets trustee cap (72h), then Admin Safe unpauses via `PauseGuard`.
- ERC-3643 lets the same agent pause and unpause, and allows minting while paused. Our guards fix both.
- `deleteIdentity` / `updateIdentity` are agent-only, so the **timelock is an identity-registry agent** (never a token agent).
- The **implementation authorities** (ERC-3643 and ONCHAINID) and the **UUPS modules** can upgrade code. They must be owned by the timelock. `DeployLib.checkHandover` asserts it.
- T-REX ships identical copies of the ERC-3643 interfaces: keep vendor imports in separate files (`ERC3643Suite.sol`, `TrexModules.sol`).
- Vendor code (0.8.17, OpenZeppelin 4.9.6) and ours (0.8.30, OpenZeppelin 5) build together through context remappings in `foundry.toml`. Vendor code does not compile with via-IR.
- In tests, `vm.prank` is consumed by precompile calls such as `sha256`. Compute arguments before pranking.
- In tests, use `vm.getBlockTimestamp()` after `vm.warp`, not `block.timestamp`.
- Coverage misattributes several reverting `new` calls in one test; use one test per constructor check.

## 6. How to work on the code

```bash
git clone --recursive https://github.com/imgrasooldev/tokenize-property.git
cd tokenize-property/contracts
forge build
forge test                      # 120 tests, about 1-2 minutes
forge coverage --report summary --no-match-coverage "(test|lib|vendor|script)"
python -m slither . --filter-paths "lib/|test/|src/vendor/|script/" --exclude-dependencies
```

- Foundry lives in `~/.foundry/bin` (add it to PATH). Slither: `python -m slither`.
- Deploy locally: start `anvil`, fill `script/deploy.env.example` into `.env.local` (never commit), then `forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast --unlocked --sender $DEPLOYER`.
- **All deployments go through `script/DeployLib.sol`.** Tests use the same library, so never deploy contracts any other way.
- Every PR follows the security definition of done in [docs/security-standards.md](docs/security-standards.md) (template in `.github/pull_request_template.md`).
- No `.bak` files; rely on git. No secrets in the repo.

## 7. Open decisions (owner to decide)

1. ERC-3643 is **GPL-3.0**: lawyer must confirm before mainnet.
2. Public anchor chain: Ethereum mainnet (most trusted, costly) or an L2 such as Base or Polygon (cheap).
3. Auditor rulings: single-key exception (pauser, registrar, anchor key) and token-address validation in registries (EthTrust checklist §4).
4. Retail investment limits (business and legal).

## 8. Next actions

1. Step 4: 4-validator Besu QBFT network on Java 21 (no Docker), deploy via `DeployLib`, run the test flows against it.
2. Set GitHub branch protection on `main` (2 reviews, CI required, signed commits), Dependabot and secret scanning. **Owner action.**
3. Report F-01 upstream to the ONCHAINID maintainers (responsible disclosure).
4. Shortlist two audit firms and a formal-verification provider.

## 9. Document index

| Document | Purpose |
|---|---|
| [README.md](README.md) | Overview and step table |
| [docs/Development-Lifecycle.pdf](docs/Development-Lifecycle.pdf) | Complete lifecycle: phases, gates, standards, status |
| [docs/contract-spec.md](docs/contract-spec.md) | Contract behaviour, roles, invariants I-1 to I-17, deployment |
| [docs/threat-model.md](docs/threat-model.md) | STRIDE threats and controls |
| [docs/security-standards.md](docs/security-standards.md) | Standards baseline and per-PR definition of done |
| [docs/product-map.md](docs/product-map.md) | Websites, portals, apps and services |
| [docs/decisions/](docs/decisions/) | Architecture decision records |
| [docs/findings/](docs/findings/) | Security findings with proofs and mitigations |
| [docs/audit/ethtrust-checklist.md](docs/audit/ethtrust-checklist.md) | EthTrust [Q] self-assessment |

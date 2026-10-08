# Local Besu network (Step 4)

A four-validator **Hyperledger Besu QBFT** network on one machine: a small copy of the production topology used to run the real contracts on real blocks.

| Setting | Value | Why |
|---|---|---|
| Validators | 4 (QBFT) | Tolerates 1 faulty or offline validator, like production |
| Block time | 2 s, immediate finality | No re-orgs: "confirmed" means confirmed |
| Chain ID | **586586** (reserved for local dev only) | Unlocks a 60 s timelock for testing; never use it anywhere else |
| Peering | Static nodes, discovery off, node allow-list | Only the four known validators can connect |
| RPC | `127.0.0.1:8545`–`8548`, APIs `ETH,NET,WEB3,QBFT,TXPOOL` | No ADMIN, DEBUG or PERSONAL; never exposed off the machine |
| Gas price | 0 (`zeroBaseFee`, `min-gas-price=0`) | The native coin has no value on a private chain |
| EVM | Cancun from genesis | Matches `evm_version` in `contracts/foundry.toml` |

## One-time setup

Binaries are not in git. Download into `chain/tools/` and **verify the checksums** before use:

| File | Source | SHA-256 |
|---|---|---|
| `besu-26.9.0.zip` | github.com/besu-eth/besu releases (formerly hyperledger/besu) | `749f90b0b29b8138f5d58b949d19eed721826cab66bfb8d983f86e15831d22b2` |
| `OpenJDK25U-jdk_x64_windows_hotspot_25.0.4.1_1.zip` | Eclipse Temurin (adoptium/temurin25-binaries) | `00c847d804f4a78e9f04f2683faf14fed898535b177b7fc704486cb0284e9283` |

Besu 26.9 needs **Java 25**. The JDK is kept portable inside `chain/tools/`, so the system Java (21) is untouched. Extract both zips into `chain/tools/`.

```bash
python chain/net.py setup       # dev accounts, 4 validator keys, genesis, node configs
```

## Daily use

```bash
python chain/net.py start       # start all validators (about 20 s for the JVMs)
python chain/net.py status      # height, peers and validators per node
python chain/flow.py            # deploy via DeployLib and run the 50-check end-to-end flow
python chain/net.py stop        # stop everything
python chain/net.py reset       # stop and wipe chain data (keeps keys and accounts)
```

`flow.py` checks, on real blocks: deployment hand-over (I-8, I-9); go-live through the timelock; onboarding with signed KYC/AML claims; mint, transfer, trustee cap and 10% limit; attacks that must revert; pause, freeze; rent distribution with Merkle-proof verification; recovery proposal and cancel; and a validator outage with recovery. A "refused" check passes only on a real contract revert; any tooling error stops the run.

## What is secret here

| Path | Contents | In git? |
|---|---|---|
| `chain/network/dev-accounts.env` | 12 generated role keys (deployer, Safes, pauser, registrar, investors) | **No** |
| `chain/network/generated/` | Validator node keys, genesis, node configs | **No** |
| `chain/tools/`, `chain/data/` | Binaries, chain databases, logs | **No** |

These are **local development keys only**. Never fund them on a real network, never reuse them.

## Differences from production

| Local | Production |
|---|---|
| One machine runs all four validators | Four separate organisations (platform, trustee, auditor, backup), separate hosts |
| Role keys in a local file | Safe multisigs on hardware wallets; hot keys in HSM/MPC |
| 60 s timelock (chain ID 586586 + `LOCAL_DEV_NETWORK=true`) | 72 h timelock, enforced by `DeployLib` |
| Plain TCP between nodes on localhost | TLS between nodes, firewalled p2p, CIS-hardened hosts |
| No public anchor | Hourly `StateAnchor` on a public chain |

## Gotchas

- On Windows, Besu 26.9 fails to parse `bootnodes` (`Illegal char <:>`). We use `static-nodes-file` with discovery off instead, which is also the stricter setup.
- `forge` and `cast` here do not read `ETH_PRIVATE_KEY` from the environment; `flow.py` passes local dev keys as arguments to child processes and never prints them.
- A restarted node needs about 15–20 s for the JVM before its RPC answers.

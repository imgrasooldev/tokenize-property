# ADR 0008: Public-chain anchoring of the private chain and the ledger

- Status: Proposed (2026-10-12). Built and tested against a local Anvil stand-in. **The public chain is pending the owner**: an Ethereum L2 (owner's direction, 2026-10-12), which one is not chosen yet.
- Date: 2026-10-12
- Builds on: ADR 0001 (private Besu chain + hourly public anchor), ADR 0003 (PostgreSQL), ADR 0004 (record before broadcast), ADR 0005 (keys behind `KeyProvider`)
- Addresses: threats **CH-1** "validators collude to rewrite history" and **D-1** "ledger rows edited or deleted"

## Context

The private chain is run by four known organisations, and the ledger lives in our own PostgreSQL. Both protect themselves (QBFT needs 3 of 4 validators; the ledger is append-only and hash-chained), but neither can prove to an outsider that its history was never rewritten:

- three colluding validators can produce a different history for the same block numbers;
- a superuser can disable the ledger triggers, edit a journal and re-hash the whole chain so that `ledger.verify_chain()` is clean again.

`StateAnchor` (contract spec section 7) already exists: `anchor(uint64 besuBlock, bytes32 besuBlockHash)`, anchor key only, strictly increasing, never overwritten, owner a Safe on the public chain. What was missing: what exactly to anchor, how to deploy it, the job that writes the anchors safely, and the check that uses them.

## Decision

### 1. What is anchored: one commitment, no contract change

The `bytes32` argument carries a **commitment** (spec section 7.1) instead of the bare block hash:

```
commitment = keccak256(abi.encode(keccak256("property-token/state-anchor/v1"), besuChainId,
                                  besuBlock, besuBlockHash, ledgerJournalId, ledgerHeadHash))
```

- It covers CH-1 (the private block hash) and D-1 (the ledger head) in one transaction per hour.
- The components are stored in the database (schema `anchor`), so anyone can recompute the public value (also with `cast`).
- The contract is unchanged (it stores any non-zero `bytes32`; strictly increasing block numbers still hold). A new contract with a renamed parameter and a second field would need a new audit scope and a redeploy for no extra safety.
- A fixed test vector is checked on both sides: `contracts/test/AnchorDeployment.t.sol` and `backend/packages/anchor/test/unit.test.ts`.

Rejected: two anchors per hour (one for Besu, one for the ledger) under different "block numbers": it breaks the meaning of `besuBlock` and doubles the cost. Rejected: anchoring the ledger head inside a Besu transaction: a colluding validator set could rewrite it along with everything else.

### 2. Deployment through DeployLib

`DeployLib.deployAnchor` + `DeployLib.checkAnchor`, run by `script/DeployAnchor.s.sol` (spec section 7.2):

- refuses chain ID 586586 (the anchor never lives on the private chain);
- owner and anchor key are set in the constructor; the deployer never holds any power;
- `checkAnchor`: exact owner and key, no pending ownership transfer, nothing anchored yet, three distinct addresses, owner is a contract (the Safe). Only the stand-in chain ID **586650** with `LOCAL_DEV_NETWORK=true` accepts a plain owner address.

### 3. Local stand-in

`python chain/anchor.py start|deploy|status|stop|reset`: Anvil on `127.0.0.1:8650`, chain ID **586650**, state saved to `chain/data/anchor/state.json` every 5 seconds. It is a separate chain from Besu (586586, 8545–8548), as in production. Deployment uses Anvil's own unlocked accounts, so no private key is passed around; account 1 stands in for the Safe.

### 4. The anchoring job (`@pt/anchor`, migration `0007_anchor.sql`)

Every hour (`ANCHOR_INTERVAL_SECONDS`, default 3600; an open anchor is retried after `ANCHOR_RETRY_SECONDS`):

1. **Preflight** (fail closed): both RPCs serve the configured chain IDs; the network policy allows sending (below); the contract has code; the contract's anchor key is the key this process holds.
2. **An open anchor is finished first**, decided from the chain, never from an error type (as in ADR 0004):
   - receipt success with enough confirmations: confirmed (after checking the contract holds the commitment);
   - receipt reverted: failed with the reason, **alarm**;
   - nonce used by another transaction and no receipt: proven dropped, re-signed with a new nonce;
   - in the pool: wait;
   - not visible at all: the **same signed bytes** are broadcast again (stored before the first broadcast). A second signature is never made for an unresolved transaction.
3. **A new anchor**: the contract's last anchored block must equal the database's (else **alarm**: someone else used the key, or the anchor chain lost a block). The finalized Besu block (`head - ANCHOR_BESU_CONFIRMATIONS`; QBFT is final at once, default 0) and the ledger head are read, the commitment is computed and **recorded**; the contract call is simulated; the transaction is signed, **recorded with its raw bytes**, and only then broadcast.

An **alarm** (`AnchorAlarm`) stops the loop with exit code 3. Anything else is retried.

**Rules enforced by the database** (`0007_anchor.sql`):

| Rule | What it guarantees |
|---|---|
| A-1 | The inputs of an anchor (chains, contract, block, hashes, ledger head, commitment) never change |
| A-2 | Never a lower block: strictly above every earlier anchor that did not fail; the ledger head never moves backwards; one private chain per contract; at most one open anchor per contract |
| A-3 | Record before send: hash, nonce, sender and raw transaction stored before broadcast; only `recorded → sent → confirmed`, `sent → recorded` (proven dropped), `→ failed` with a reason; final states stay final |
| A-4 | No DELETE or TRUNCATE; every change appended to `anchor.history` |
| A-5 | `pt_anchor_writer` only calls the API functions (and reads the ledger head); `pt_anchor_reader` only reads (including the ledger rows, for verification) |

The triggers apply to an administrator's UPDATE too. A session advisory lock allows one job per contract.

### 5. Keys and the network policy

- The job signs through the signing service's `KeyProvider` interface (ADR 0005). Locally the anchor key lives in its **own** encrypted keystore (`backend/data/keystore-anchor/`, passphrase `ANCHOR_KEYSTORE_PASSPHRASE`), created by `npm run anchor:setup`, so the anchoring process never decrypts any other key. In production the key is generated inside the HSM/MPC provider.
- Sending is refused on chain 586586, on the private chain's own ID, on the stand-in in production, and on **any other chain** unless it is named in `ANCHOR_ALLOW_CHAIN_ID` **and** the key is held by a production key provider. The local keystore can therefore never sign on a public chain. Any chain other than the stand-in must also set `ANCHOR_CONFIRMATIONS` explicitly.
- Gas: legacy transactions with a fixed gas limit (`ANCHOR_GAS_LIMIT`, 150,000; `anchor` used 51,060 on the stand-in) and a price cap (`ANCHOR_MAX_GAS_PRICE_WEI`); above the cap nothing is sent.

### 6. Verification (`npm run anchor:verify`)

Reads every `Anchored` event in windows (`ANCHOR_LOG_WINDOW`, default 2,000 blocks; providers limit `eth_getLogs`) and reports any mismatch (exit 1):

- an event without a database record (unknown writer or deleted record);
- a record whose components no longer hash to the public commitment (edited record);
- **CH-1**: the private chain's block hash at that height differs from the anchored one;
- **D-1**: the ledger, **recomputed in TypeScript from its rows** (independent of `ledger.digest` / `verify_chain`, which a superuser could replace), no longer has the anchored hash at the anchored journal, or its hash chain is broken anywhere;
- a confirmed record missing on the public chain, in another transaction or block, or in an anchor-chain block that was replaced (re-org); the contract's last anchored block differs from the events.

## Consequences

- A rewrite of private history or of the ledger before the last anchor is publicly detectable within an hour of the next anchor, by anyone holding the database rows and read access to Besu.
- Changes after the last anchor are covered only by the database's own controls until the next anchor (at most one hour by default).
- The job depends on the public chain's availability; an outage delays anchors but never loses or reorders them.
- Cost: one small transaction per hour (8,760 per year) on the chosen L2.

## Open items (owner / later steps)

1. **Choose the L2** (and its RPC providers, confirmations, `finalized` semantics, gas cap) and deploy the Safe there. Then build the HSM/MPC `KeyProvider` and run `DeployAnchor.s.sol` with a hardware-wallet deployer.
2. Fee bumping for a transaction stuck below the market price (replacement with the same nonce) is not built: on the stand-in it cannot happen; on an L2 the job waits and alerts.
3. Schedule `anchor:verify` daily and feed a mismatch into Step 5f reconciliation (payout freeze) and alerting.
4. Publish the anchor records (components only) so outsiders can verify without database access.
5. Natspec of `StateAnchor` still calls the value "hash of that block"; rename it to "commitment" in the next contract revision (no behaviour change, so not done now).

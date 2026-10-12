import { encodeAbiParameters, keccak256, toBytes, type Hex } from "viem";

/**
 * The v1 anchor commitment (contract-spec.md section 7.1):
 *   keccak256(abi.encode(bytes32 domain, uint256 besuChainId, uint64 besuBlock, bytes32 besuBlockHash,
 *                        uint64 ledgerJournalId, bytes32 ledgerHeadHash))
 * It binds a finalized private-chain block (threat CH-1) and the ledger hash-chain head (threat D-1)
 * into the one bytes32 that StateAnchor stores. A new format needs a new domain tag.
 */
export const COMMITMENT_DOMAIN: Hex = keccak256(toBytes("property-token/state-anchor/v1"));
export const ZERO_HASH: Hex = `0x${"0".repeat(64)}`;
const MAX_UINT64 = 2n ** 64n - 1n;
const BYTES32 = /^0x[0-9a-f]{64}$/;

export interface CommitmentInput {
  besuChainId: bigint;
  besuBlock: bigint;
  besuBlockHash: Hex;
  /** Newest ledger journal when anchoring; 0 for an empty ledger. */
  ledgerJournalId: bigint;
  /** Its hash-chain value; ZERO_HASH for an empty ledger. */
  ledgerHeadHash: Hex;
}

export function computeCommitment(c: CommitmentInput): Hex {
  if (c.besuChainId <= 0n) throw new Error("invalid private chain ID");
  if (c.besuBlock <= 0n || c.besuBlock > MAX_UINT64) throw new Error("private block out of range");
  if (c.ledgerJournalId < 0n || c.ledgerJournalId > MAX_UINT64) throw new Error("ledger journal id out of range");
  const besuBlockHash = c.besuBlockHash.toLowerCase() as Hex;
  const ledgerHeadHash = c.ledgerHeadHash.toLowerCase() as Hex;
  if (!BYTES32.test(besuBlockHash) || besuBlockHash === ZERO_HASH) throw new Error("invalid private block hash");
  if (!BYTES32.test(ledgerHeadHash)) throw new Error("invalid ledger head hash");
  if ((c.ledgerJournalId === 0n) !== (ledgerHeadHash === ZERO_HASH)) throw new Error("ledger head: id 0 exactly when the hash is zero");
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint256" }, { type: "uint64" }, { type: "bytes32" }, { type: "uint64" }, { type: "bytes32" }],
      [COMMITMENT_DOMAIN, c.besuChainId, c.besuBlock, besuBlockHash, c.ledgerJournalId, ledgerHeadHash],
    ),
  );
}

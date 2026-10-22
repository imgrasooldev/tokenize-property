import { concat, encodeAbiParameters, keccak256, type Address, type Hex } from "viem";

/**
 * Rent entitlement Merkle tree, exactly as DistributionRegistry.verify (OpenZeppelin MerkleProof),
 * chain/rent.py and web/src/lib/merkle.ts (the public /verify page):
 *   leaf = keccak256(bytes.concat(keccak256(abi.encode(address wallet, uint256 amountPaisa))))
 *   node = keccak256(min(a, b) ++ max(a, b))
 * With S-03 OP-37 the amount is the NET entitlement (after FBR withholding). The leaf format itself
 * is unchanged (leaf v1), so nothing on chain or in /verify changes.
 * Tree shape as chain/rent.py: leaves in entitlement order (wallet ascending), pairs left to right,
 * an odd node moves up unchanged.
 */
export function rentLeaf(wallet: Address, amountPaisa: bigint): Hex {
  if (amountPaisa < 0n) throw new Error("amount must not be negative");
  return keccak256(keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [wallet, amountPaisa])));
}

export function hashPair(a: Hex, b: Hex): Hex {
  return BigInt(a) <= BigInt(b) ? keccak256(concat([a, b])) : keccak256(concat([b, a]));
}

export function processProof(leaf: Hex, proof: readonly Hex[]): Hex {
  let h = leaf;
  for (const p of proof) h = hashPair(h, p);
  return h;
}

/** Root and one proof per leaf (proofs[i] belongs to leaves[i]). */
export function buildTree(leaves: readonly Hex[]): { root: Hex; proofs: Hex[][] } {
  if (leaves.length === 0) throw new Error("no leaves");
  const proofs: Hex[][] = leaves.map(() => []);
  let level: { hash: Hex; under: number[] }[] = leaves.map((hash, i) => ({ hash, under: [i] }));
  while (level.length > 1) {
    const next: { hash: Hex; under: number[] }[] = [];
    for (let k = 0; k + 1 < level.length; k += 2) {
      const a = level.at(k);
      const b = level.at(k + 1);
      if (!a || !b) throw new Error("unreachable");
      for (const i of a.under) proofs.at(i)?.push(b.hash);
      for (const i of b.under) proofs.at(i)?.push(a.hash);
      next.push({ hash: hashPair(a.hash, b.hash), under: [...a.under, ...b.under] });
    }
    const odd = level.length % 2 === 1 ? level[level.length - 1] : undefined;
    if (odd) next.push(odd);
    level = next;
  }
  const root = level[0];
  if (!root) throw new Error("unreachable");
  return { root: root.hash, proofs };
}

import { concat, encodeAbiParameters, keccak256, type Address, type Hex } from "viem";
import { z } from "zod";

/**
 * Rent entitlement proofs (S-07 PV-31), computed the same way as DistributionRegistry.verify
 * (OpenZeppelin MerkleProof) and chain/rent.py:
 *   leaf = keccak256(bytes.concat(keccak256(abi.encode(address wallet, uint256 amountPaisa))))
 *   node = keccak256(min(a, b) ++ max(a, b))   (sorted pairs, so a proof needs no left/right flags)
 * Pure functions with no server code: the public verification page runs them in the browser, so a
 * visitor does not have to trust the platform's server for the local check.
 */
const HEX32 = /^0x[0-9a-f]{64}$/;

export function rentLeaf(wallet: Address, amountPaisa: bigint): Hex {
  if (amountPaisa < 0n) throw new Error("amount must not be negative");
  const inner = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [wallet, amountPaisa]));
  return keccak256(inner);
}

export function hashPair(a: Hex, b: Hex): Hex {
  return BigInt(a) <= BigInt(b) ? keccak256(concat([a, b])) : keccak256(concat([b, a]));
}

/** The root a proof leads to from a leaf. */
export function processProof(leaf: Hex, proof: readonly Hex[]): Hex {
  let h = leaf;
  for (const p of proof) h = hashPair(h, p);
  return h;
}

/** Whether (wallet, amount, proof) leads to the published root. */
export function verifyEntitlementProof(root: Hex, wallet: Address, amountPaisa: bigint, proof: readonly Hex[]): boolean {
  return processProof(rentLeaf(wallet, amountPaisa), proof).toLowerCase() === root.toLowerCase();
}

/**
 * The entitlement an investor copies from their portfolio (rent section) and pastes into the public
 * page: distribution id, wallet, net amount in paisa and the proof. Amounts are integers (paisa),
 * given as a string or a safe integer, never a decimal.
 */
export const entitlementInput = z.strictObject({
  distributionId: z.union([z.string().regex(/^[1-9][0-9]{0,8}$/), z.number().int().positive().max(999_999_999)]).transform((v) => BigInt(v)),
  wallet: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .transform((v) => v.toLowerCase() as Address),
  amountPaisa: z.union([z.string().regex(/^(0|[1-9][0-9]{0,29})$/), z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)]).transform((v) => BigInt(v)),
  proof: z
    .array(z.string().transform((v) => v.toLowerCase()).pipe(z.string().regex(HEX32)))
    .max(64)
    .transform((v) => v as Hex[]),
});
export type Entitlement = z.output<typeof entitlementInput>;

/** Parses pasted entitlement JSON; null when it is not a valid entitlement. */
export function parseEntitlement(text: string): Entitlement | null {
  if (text.length > 20_000) return null;
  try {
    const r = entitlementInput.safeParse(JSON.parse(text));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

/** The text the portfolio offers for copying (amount as a string so no JSON reader rounds it). */
export function entitlementText(e: { distributionId: bigint; wallet: Address; amountPaisa: bigint; proof: readonly Hex[] }): string {
  return JSON.stringify(
    { distributionId: e.distributionId.toString(), wallet: e.wallet, amountPaisa: e.amountPaisa.toString(), proof: e.proof },
    null,
    1,
  );
}

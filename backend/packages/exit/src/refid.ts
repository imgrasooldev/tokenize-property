import { keccak256, stringToBytes, type Hex } from "viem";

/**
 * The single-use refId of a redemption burn (spec S-05 EX-14, contract-spec 5.1 I-11):
 *   keccak256(utf8("property-token:redemption:<token>:<distributionId>:<wallet>"))
 * with the token and wallet as lower-case 0x addresses and the on-chain distribution id in decimal.
 * The exit service computes it (no keccak in SQL); the signing service and reconciliation derive it
 * again and refuse anything else.
 */
export function redemptionRefId(token: string, distributionId: bigint | string, wallet: string): Hex {
  const id = BigInt(distributionId);
  if (id <= 0n) throw new Error("distribution id must be positive");
  if (!/^0x[0-9a-fA-F]{40}$/.test(token) || !/^0x[0-9a-fA-F]{40}$/.test(wallet)) throw new Error("token and wallet must be addresses");
  return keccak256(stringToBytes(`property-token:redemption:${token.toLowerCase()}:${id.toString()}:${wallet.toLowerCase()}`));
}

import { LOCAL_DEV_CHAIN_ID } from "@pt/config";

/** Chain ID of the local Anvil stand-in for the public chain (must equal DeployLib.LOCAL_ANCHOR_CHAIN_ID). */
export const LOCAL_ANCHOR_CHAIN_ID = 586_650;

/**
 * How the anchor key is held. "dev-file" is the encrypted local keystore (development only); "hsm" is
 * the production provider (HSM/MPC behind the same KeyProvider interface), not built yet.
 */
export type KeyCustody = "dev-file" | "hsm";

export interface NetworkPolicyInput {
  anchorChainId: number;
  besuChainId: number;
  production: boolean;
  /** ANCHOR_ALLOW_CHAIN_ID: the one public chain an operator explicitly allowed. */
  allowChainId?: number | undefined;
  custody: KeyCustody;
}

/**
 * Decides whether this process may SEND anchors to `anchorChainId`. Returns the reason for a refusal,
 * or null. Reading (verify) needs only `readProblem`.
 *  - never the private chain itself, never the reserved local dev chain ID;
 *  - the local stand-in (586650) only outside production;
 *  - any other chain (a real L2, a testnet, mainnet) only when named in ANCHOR_ALLOW_CHAIN_ID AND with
 *    a production key provider: the local dev keystore may only ever sign on the stand-in.
 */
export function sendProblem(p: NetworkPolicyInput): string | null {
  const r = readProblem(p);
  if (r) return r;
  if (p.anchorChainId === LOCAL_ANCHOR_CHAIN_ID) {
    return p.production ? "the local anchor stand-in (586650) is not allowed in production" : null;
  }
  if (p.allowChainId !== p.anchorChainId) {
    return `chain ${String(p.anchorChainId)} is not the local stand-in; set ANCHOR_ALLOW_CHAIN_ID=${String(p.anchorChainId)} to anchor there deliberately`;
  }
  if (p.custody === "dev-file") {
    return "a local dev keystore may only sign on the local stand-in (586650); a public chain needs the HSM/MPC key provider";
  }
  return null;
}

export function readProblem(p: Pick<NetworkPolicyInput, "anchorChainId" | "besuChainId">): string | null {
  if (p.anchorChainId === LOCAL_DEV_CHAIN_ID) return "the anchor chain must never be the private dev chain (586586)";
  if (p.anchorChainId === p.besuChainId) return "the anchor chain must differ from the private chain it anchors";
  return null;
}

"use server";

import { parseEntitlement } from "@/lib/merkle";
import { logError } from "@/lib/server/log";
import { clientKey, take } from "@/lib/server/rate-limit";
import { indexStatus } from "@/lib/server/readmodel";
import { verifyProofOnChain } from "@/lib/server/rent";
import { indexGate } from "@/lib/verify-rules";

export type ChainProofResult =
  | { ok: true; valid: boolean; controlRejected: boolean; block: string }
  | { ok: false; error: "rate" | "input" | "paused" | "chain" };

/**
 * Public page (S-07 PV-31): DistributionRegistry.verify for an entitlement a visitor pasted, at the
 * read model's block, plus the control with 1 paisa more. No sign-in. Nothing the visitor enters is
 * stored or logged (PV-33): only the rate-limit counter per client address and, on a chain error,
 * the error class.
 */
export async function checkProofOnChain(text: unknown): Promise<ChainProofResult> {
  if (!take("publicVerify", await clientKey())) return { ok: false, error: "rate" };
  const e = typeof text === "string" ? parseEntitlement(text) : null;
  if (!e) return { ok: false, error: "input" };
  const status = await indexStatus();
  const gate = indexGate(status);
  if (!status || gate === "halted" || gate === "unavailable") return { ok: false, error: "paused" };
  try {
    const r = await verifyProofOnChain(e.distributionId, e.wallet, e.amountPaisa, e.proof, status.block);
    if (!r) return { ok: false, error: "chain" };
    return { ok: true, valid: r.valid, controlRejected: r.controlRejected, block: status.block.toString() };
  } catch (err) {
    // The error class only: viem messages repeat the call's arguments (the visitor's wallet).
    logError("publicVerify", err instanceof Error ? err.name : "Error");
    return { ok: false, error: "chain" };
  }
}

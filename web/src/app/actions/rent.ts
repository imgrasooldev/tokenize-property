"use server";

import { redirect } from "next/navigation";
import { investorById } from "@/lib/server/db";
import { verifyEntitlement } from "@/lib/server/rent";
import { currentInvestorId } from "@/lib/server/session";

export interface VerifyState {
  done?: boolean;
  error?: "none" | "chain";
  statementMatches?: boolean;
  proofValid?: boolean;
  tamperedRejected?: boolean;
}

/** Self-verification of the signed-in investor's own rent entitlement against the chain. */
export async function verifyRent(_prev: VerifyState, formData: FormData): Promise<VerifyState> {
  const id = await currentInvestorId();
  const investor = id ? await investorById(id) : null;
  if (!investor) redirect("/login");
  const raw = formData.get("distributionId");
  if (typeof raw !== "string" || !/^[1-9][0-9]{0,8}$/.test(raw)) return { done: true, error: "none" };
  try {
    const r = await verifyEntitlement(investor.wallet_address, BigInt(raw));
    if (!r) return { done: true, error: "none" };
    return { done: true, statementMatches: r.statementMatches, proofValid: r.proofValid, tamperedRejected: r.tamperedRejected };
  } catch {
    return { done: true, error: "chain" };
  }
}

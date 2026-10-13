"use server";

import { redirect } from "next/navigation";
import { investSchema } from "@/lib/invest-rules";
import { investorById } from "@/lib/server/db";
import { nudgeFollower } from "@/lib/server/follower";
import { placeOrder, type InvestError } from "@/lib/server/invest";
import { logError } from "@/lib/server/log";
import { take } from "@/lib/server/rate-limit";
import { currentInvestorId } from "@/lib/server/session";

export interface InvestState {
  error?: InvestError | "input" | "rate";
}

/** Invest in a live property: mock Raast payment and ledger, then the mint through the outbox and the signing service (ADR 0010). */
export async function invest(_prev: InvestState, formData: FormData): Promise<InvestState> {
  const id = await currentInvestorId();
  const investor = id ? await investorById(id) : null;
  if (!investor) redirect("/login");
  if (!take("invest", investor.id)) return { error: "rate" };

  const parsed = investSchema.safeParse({
    symbol: formData.get("symbol"),
    tokens: formData.get("tokens"),
    requestId: formData.get("requestId"),
    bankConfirm: formData.get("bankConfirm"),
  });
  if (!parsed.success) return { error: "input" };

  let result: Awaited<ReturnType<typeof placeOrder>>;
  try {
    result = await placeOrder(investor, parsed.data);
  } catch (e) {
    logError("invest", e);
    return { error: "generic" };
  }
  if ("error" in result) return { error: result.error };
  void nudgeFollower();
  redirect(`/portfolio?sub=${result.subscriptionId}`);
}

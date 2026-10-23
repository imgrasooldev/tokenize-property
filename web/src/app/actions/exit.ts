"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { redemptionRequestSchema, redemptionWithdrawSchema, type RedemptionErrorKey, type WithdrawErrorKey } from "@/lib/exit-rules";
import { requestRedemption, withdrawRedemption } from "@/lib/server/exit";
import { logError } from "@/lib/server/log";
import { take } from "@/lib/server/rate-limit";
import { currentSession } from "@/lib/server/session";

/** The signed-in investor's session (the database takes investor and KYC subject from it). */
async function signedIn(): Promise<{ investorId: string; session: Buffer }> {
  const s = await currentSession();
  if (!s) redirect("/login");
  return { investorId: s.investorId, session: s.hash };
}

export interface RedemptionState {
  error?: RedemptionErrorKey;
}

/**
 * EX-40 (S-05 phase 0): a non-binding redemption request in an open window, at the window's frozen
 * indicative price. The database checks KYC, the free balance, one live request per window and the
 * window cap, and asks for a passkey step-up first (always; waived while passkeys are not required).
 * A repeat of the same form (same requestId, e.g. after the step-up) is the same request.
 */
export async function requestRedemptionAction(_prev: RedemptionState, formData: FormData): Promise<RedemptionState> {
  const me = await signedIn();
  if (!take("exit", me.investorId)) return { error: "rate" };
  const parsed = redemptionRequestSchema.safeParse({ windowId: formData.get("windowId"), units: formData.get("units"), requestId: formData.get("requestId") });
  if (!parsed.success) return { error: "input" };
  let result: Awaited<ReturnType<typeof requestRedemption>>;
  try {
    result = await requestRedemption(me.session, parsed.data);
  } catch (e) {
    logError("redemption-request", e);
    return { error: "generic" };
  }
  if ("error" in result) {
    if (result.error === "session") redirect("/login");
    return { error: result.error };
  }
  revalidatePath("/exit");
  redirect(`/exit?req=${result.id}`);
}

export interface WithdrawState {
  ok?: boolean;
  error?: WithdrawErrorKey;
}

/** EX-44: withdraws the investor's own submitted request while its window is open (passkey step-up, always). */
export async function withdrawRedemptionAction(_prev: WithdrawState, formData: FormData): Promise<WithdrawState> {
  const me = await signedIn();
  if (!take("exit", me.investorId)) return { error: "rate" };
  const parsed = redemptionWithdrawSchema.safeParse({ requestId: formData.get("requestId") });
  if (!parsed.success) return { error: "input" };
  try {
    const r = await withdrawRedemption(me.session, parsed.data.requestId);
    if ("error" in r) return { error: r.error };
  } catch (e) {
    logError("redemption-withdraw", e);
    return { error: "generic" };
  }
  revalidatePath("/exit");
  return { ok: true };
}

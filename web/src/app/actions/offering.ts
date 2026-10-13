"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cancelSchema, reserveSchema, type CancelErrorKey, type ReserveErrorKey } from "@/lib/offering-rules";
import { investorById, type InvestorRow } from "@/lib/server/db";
import { logError } from "@/lib/server/log";
import { cancelSubscription, reserveUnits } from "@/lib/server/offerings";
import { take } from "@/lib/server/rate-limit";
import { keyedHash } from "@/lib/server/secrets";
import { currentInvestorId, sessionFingerprint } from "@/lib/server/session";

async function signedIn(): Promise<InvestorRow> {
  const id = await currentInvestorId();
  const investor = id ? await investorById(id) : null;
  if (!investor) redirect("/login");
  return investor;
}

export interface ReserveState {
  error?: ReserveErrorKey;
}

/**
 * Reserve units of a live offering (S-02 V2/V3; FCFS for the reservation time, else a waitlist
 * place). KYC gate: only a verified investor with a KYC record gets this far, and the database
 * refuses anyone else again (migration 0018 WO-2). Nothing about money is entered here: the
 * investor pays later from their own bank with the payment code shown on My subscriptions.
 */
export async function reserveAction(_prev: ReserveState, formData: FormData): Promise<ReserveState> {
  const investor = await signedIn();
  if (!take("reserve", investor.id)) return { error: "rate" };
  if (investor.kyc_status !== "verified" || !investor.kyc_subject) return { error: "kyc" };
  const parsed = reserveSchema.safeParse({
    offeringId: formData.get("offeringId"),
    units: formData.get("units"),
    requestId: formData.get("requestId"),
    language: formData.get("language"),
    docSha: formData.get("docSha"),
    riskSha: formData.get("riskSha"),
    acceptDoc: formData.get("acceptDoc"),
    acceptRisk: formData.get("acceptRisk"),
  });
  if (!parsed.success) return { error: "input" };
  const session = await sessionFingerprint();
  if (!session) redirect("/login");
  const device = keyedHash("offering-device", (await headers()).get("user-agent") ?? "");

  let result: Awaited<ReturnType<typeof reserveUnits>>;
  try {
    result = await reserveUnits(investor, parsed.data, { sessionHash: session, deviceHash: device });
  } catch (e) {
    logError("reserve", e);
    return { error: "generic" };
  }
  if ("error" in result) return { error: result.error };
  revalidatePath("/subscriptions");
  redirect(`/subscriptions?sub=${result.subscriptionId}`);
}

export interface CancelState {
  ok?: boolean;
  error?: CancelErrorKey;
}

/** Cancel a reservation (or a queue place) before paying (S-02 V11); the payment code is cancelled with it. */
export async function cancelReservationAction(_prev: CancelState, formData: FormData): Promise<CancelState> {
  const investor = await signedIn();
  if (!take("reserve", investor.id)) return { error: "rate" };
  const parsed = cancelSchema.safeParse({ subscriptionId: formData.get("subscriptionId") });
  if (!parsed.success) return { error: "input" };
  try {
    const r = await cancelSubscription(investor, parsed.data.subscriptionId);
    if ("error" in r) return { error: r.error };
  } catch (e) {
    logError("cancel-reservation", e);
    return { error: "generic" };
  }
  revalidatePath("/subscriptions");
  return { ok: true };
}

"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { logError } from "@/lib/server/log";
import { take } from "@/lib/server/rate-limit";
import { currentSession } from "@/lib/server/session";
import { acceptTransfer, newReceiveCode, requestTransfer, withdrawTransfer } from "@/lib/server/transfers";
import { acceptSchema, requestIssue, requestSchema, withdrawSchema, type TransferErrorKey } from "@/lib/transfer-rules";

/**
 * Server actions of /transfers (S-04 phase 0, spec 16.9). The session hash is all the database
 * needs: it finds the investor and KYC subject itself and runs the passkey step-up gate inside the
 * webauth.web_transfer_* wrappers (migration 0028). A refused gate comes back as stepup or
 * enrolPasskey (the form shows the passkey prompt and re-submits); an ended session goes to sign-in.
 */
async function sessionOrLogin(): Promise<{ investorId: string; hash: Buffer }> {
  const s = await currentSession();
  if (!s) redirect("/login");
  return { investorId: s.investorId, hash: s.hash };
}

/** A failure that must never show a stack trace: logged, and a generic message for the investor. */
function failed(where: string, e: unknown): { error: TransferErrorKey } {
  logError(where, e);
  return { error: "generic" };
}

export interface CodeState {
  code?: { code: string; expiresAt: string };
  error?: TransferErrorKey;
}

/** A receive code for the signed-in investor (TR-B3; at most three live, 7 days, single use). */
export async function receiveCodeAction(): Promise<CodeState> {
  const s = await sessionOrLogin();
  if (!take("transfer", s.investorId)) return { error: "rate" };
  let r: Awaited<ReturnType<typeof newReceiveCode>>;
  try {
    r = await newReceiveCode(s.hash);
  } catch (e) {
    return failed("transfer-code", e);
  }
  if ("error" in r) {
    if (r.error === "session") redirect("/login");
    return { error: r.error };
  }
  revalidatePath("/transfers");
  return { code: r };
}

export interface RequestState {
  error?: TransferErrorKey;
}

/** The seller's request to the holder of a receive code (sale, gift or family; T1 on the website). */
export async function requestTransferAction(_prev: RequestState, formData: FormData): Promise<RequestState> {
  const s = await sessionOrLogin();
  if (!take("transfer", s.investorId)) return { error: "rate" };
  const parsed = requestSchema.safeParse({
    token: formData.get("token"),
    units: formData.get("units"),
    buyerCode: formData.get("buyerCode"),
    consideration: formData.get("consideration"),
    price: formData.get("price"),
    noPriceReason: formData.get("noPriceReason"),
    agreementSha256: formData.get("agreementSha256"),
    priceExplanation: formData.get("priceExplanation"),
    holdingReason: formData.get("holdingReason"),
  });
  if (!parsed.success) return { error: requestIssue(parsed.error.issues) };
  if (formData.get("confirm") !== "on") return { error: "input" };
  let r: Awaited<ReturnType<typeof requestTransfer>>;
  try {
    r = await requestTransfer(s.hash, parsed.data);
  } catch (e) {
    return failed("transfer-request", e);
  }
  if ("error" in r) {
    if (r.error === "session") redirect("/login");
    return { error: r.error };
  }
  revalidatePath("/transfers");
  redirect(`/transfers?case=${r.id}`);
}

export interface CaseActionState {
  ok?: boolean;
  error?: TransferErrorKey;
}

/** The buyer accepts by giving the same agreement fingerprint as the seller (computed in the browser). */
export async function acceptTransferAction(_prev: CaseActionState, formData: FormData): Promise<CaseActionState> {
  const s = await sessionOrLogin();
  if (!take("transfer", s.investorId)) return { error: "rate" };
  const parsed = acceptSchema.safeParse({ caseId: formData.get("caseId"), agreementSha256: formData.get("agreementSha256") });
  if (!parsed.success) return { error: parsed.error.issues[0]?.path[0] === "agreementSha256" ? "agreement" : "input" };
  let r: Awaited<ReturnType<typeof acceptTransfer>>;
  try {
    r = await acceptTransfer(s.hash, parsed.data.caseId, parsed.data.agreementSha256);
  } catch (e) {
    return failed("transfer-accept", e);
  }
  if ("error" in r) {
    if (r.error === "session") redirect("/login");
    return { error: r.error };
  }
  revalidatePath("/transfers");
  return { ok: true };
}

/** Either party withdraws before a payment is booked (T2); a live payment code is cancelled with it. */
export async function withdrawTransferAction(_prev: CaseActionState, formData: FormData): Promise<CaseActionState> {
  const s = await sessionOrLogin();
  if (!take("transfer", s.investorId)) return { error: "rate" };
  const parsed = withdrawSchema.safeParse({ caseId: formData.get("caseId") });
  if (!parsed.success) return { error: "input" };
  let r: Awaited<ReturnType<typeof withdrawTransfer>>;
  try {
    r = await withdrawTransfer(s.hash, parsed.data.caseId);
  } catch (e) {
    return failed("transfer-withdraw", e);
  }
  if ("error" in r) {
    if (r.error === "session") redirect("/login");
    return { error: r.error };
  }
  revalidatePath("/transfers");
  return { ok: true };
}

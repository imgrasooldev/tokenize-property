"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { investorById, type InvestorRow } from "@/lib/server/db";
import { logError } from "@/lib/server/log";
import { take } from "@/lib/server/rate-limit";
import { registerPayoutAccount } from "@/lib/server/services";
import { currentInvestorId } from "@/lib/server/session";

async function signedIn(): Promise<InvestorRow> {
  const id = await currentInvestorId();
  const investor = id ? await investorById(id) : null;
  if (!investor) redirect("/login");
  return investor;
}

export type PayeeError = "input" | "rate" | "noKyc" | "invalid_iban" | "title_not_found" | "title_mismatch" | "not_verified" | "in_use" | "unavailable";

export interface PayeeState {
  ok?: boolean;
  error?: PayeeError;
}

const payeeSchema = z.object({
  // Spaces and dashes allowed as typed; the bank service validates the IBAN itself (length, checksum).
  iban: z
    .string()
    .trim()
    .max(40)
    .transform((s) => s.replace(/[\s-]+/g, "").toUpperCase())
    .pipe(z.string().regex(/^PK[0-9]{2}[A-Z]{4}[0-9A-Z]{16}$/)),
  title: z
    .string()
    .trim()
    .min(2)
    .max(140)
    .regex(/^[\p{L}\p{M} .'-]+$/u),
});

/**
 * Registers (or changes) the investor's payout bank account through the bank service (ADR 0009 B-4):
 * the bank's title inquiry, the match with the KYC name and the 72-hour cooling-off are enforced by
 * the bank service and the database. The website keeps nothing of the IBAN (last four digits come
 * back through bank.web_payees).
 */
export async function registerPayeeAction(_prev: PayeeState, formData: FormData): Promise<PayeeState> {
  const investor = await signedIn();
  if (!take("payee", investor.id)) return { error: "rate" };
  if (!investor.kyc_subject) return { error: "noKyc" };
  const parsed = payeeSchema.safeParse({ iban: formData.get("iban"), title: formData.get("title") });
  if (!parsed.success) return { error: parsed.error.issues.some((i) => i.path[0] === "iban") ? "invalid_iban" : "input" };
  let r: Awaited<ReturnType<typeof registerPayoutAccount>>;
  try {
    r = await registerPayoutAccount({ subjectId: investor.kyc_subject, iban: parsed.data.iban, title: parsed.data.title });
  } catch (e) {
    logError("payee", e);
    return { error: "unavailable" };
  }
  if (!r.ok) return { error: r.error };
  revalidatePath("/account");
  return { ok: true };
}

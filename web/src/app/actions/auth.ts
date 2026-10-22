"use server";

import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import { z } from "zod";
import { db, tx } from "@/lib/server/db";
import { nudgeFollower } from "@/lib/server/follower";
import { startOnboarding } from "@/lib/server/onboarding";
import { upsertPersona } from "@/lib/server/personas";
import { clientKey, take } from "@/lib/server/rate-limit";
import { logError } from "@/lib/server/log";
import { hmac } from "@/lib/server/secrets";
import { createCustodialWallet, kycOnboard } from "@/lib/server/services";
import { endSession, startSession } from "@/lib/server/session";

/** Signs in as one of the two pre-verified demo investors. */
export async function loginAsPersona(formData: FormData): Promise<void> {
  const persona = formData.get("persona");
  if (persona !== "ALICE" && persona !== "BOB") throw new Error("Unknown persona");
  if (!take("login", await clientKey())) redirect("/login?e=rate");
  await startSession(await upsertPersona(persona), "persona");
  redirect("/account");
}

export async function logout(): Promise<void> {
  await endSession();
  redirect("/");
}

export interface SignUpState {
  error?: string;
  fields?: Partial<Record<"fullName" | "cnic" | "phone" | "liveness" | "consent", string>>;
}

const signUpSchema = z.object({
  fullName: z
    .string()
    .trim()
    .min(2)
    .max(80)
    .regex(/^[\p{L}][\p{L} .'-]*$/u, "letters and spaces only"),
  cnic: z.string().trim().regex(/^\d{5}-\d{7}-\d$/, "format 12345-1234567-1"),
  phone: z
    .string()
    .trim()
    .regex(/^03\d{2}-?\d{7}$/, "format 0300-1234567"),
  liveness: z.literal("on", "complete the liveness check"),
  consent: z.literal("on", "accept the terms to continue"),
});

/**
 * Sign-up (ADR 0010 §5): a custodial wallet from the signing service, KYC through the KYC service
 * (mock NADRA, liveness and sanctions providers; status derived in its database), then on-chain
 * onboarding through the outbox and the signing service. The account page shows the progress.
 * Data minimisation: the full CNIC and phone number are never stored by the website. It keeps the
 * last digits for display and an HMAC (with a secret pepper) to enforce one account per CNIC; the
 * KYC service keeps only its own peppered hashes (ADR 0009).
 */
export async function signUp(_prev: SignUpState, formData: FormData): Promise<SignUpState> {
  if (!take("signup", await clientKey())) return { error: "rate" };
  const parsed = signUpSchema.safeParse({
    fullName: formData.get("fullName"),
    cnic: formData.get("cnic"),
    phone: formData.get("phone"),
    liveness: formData.get("liveness"),
    consent: formData.get("consent"),
  });
  if (!parsed.success) {
    // First message per field; keys come from our own schema.
    const first = new Map<string, string>();
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0]);
      if (!first.has(key)) first.set(key, issue.message);
    }
    return { fields: Object.fromEntries(first) };
  }
  const { fullName, cnic, phone } = parsed.data;

  const pool = await db();
  const cnicHmac = hmac("cnic", cnic.replaceAll("-", ""));
  const dup = await pool.query("SELECT 1 FROM webdemo.investors WHERE cnic_hmac = $1", [cnicHmac]);
  if (dup.rowCount) return { error: "duplicate" };

  // 1. A wallet held by the signing service (the website never sees a key).
  let wallet: `0x${string}`;
  try {
    wallet = await createCustodialWallet();
  } catch (e) {
    logError("signUp wallet", e);
    return { error: "chain" };
  }

  // 2. KYC by the KYC service (mock NADRA: CNIC ending 0 = not found, 8 = name mismatch, 9 = down).
  const kyc = await kycOnboard({ cnic, fullName, livenessSessionId: `web-${randomUUID()}`, wallet });
  if (!kyc.ok) return { error: kyc.error === "duplicate" ? "duplicate" : kyc.error === "invalid" ? "generic" : "kycDown" };
  if (kyc.status !== "verified") {
    const nadra = kyc.checks.find((c) => c.kind === "nadra");
    if (nadra?.outcome === "fail") return { error: "nadra" };
    if (nadra?.outcome === "error") return { error: "kycDown" };
    return { error: "kyc" };
  }

  // 3. The investor row and the first onboarding command, in one transaction.
  let id: string;
  try {
    id = await tx(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO webdemo.investors (display_name, cnic_last4, cnic_hmac, phone_last3, wallet_address, kyc_status, kyc_note, kyc_subject)
         VALUES ($1, $2, $3, $4, $5, 'pending', 'KYC service verified (mock providers); registering on chain', $6) RETURNING id`,
        [fullName, cnic.replaceAll("-", "").slice(-4), cnicHmac, phone.replaceAll("-", "").slice(-3), wallet, kyc.subjectId],
      );
      const newId = rows[0]?.id;
      if (!newId) throw new Error("insert failed");
      await startOnboarding(c, newId, wallet);
      return newId;
    });
  } catch (e) {
    // Two sign-ups with the same CNIC at once: the unique index refuses the second.
    if (e instanceof Error && "code" in e && e.code === "23505") return { error: "duplicate" };
    logError("signUp insert", e);
    return { error: "generic" };
  }
  void nudgeFollower();
  await startSession(id, "signup");
  redirect("/account");
}

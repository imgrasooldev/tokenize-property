"use server";

import { redirect } from "next/navigation";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import { db } from "@/lib/server/db";
import { onboardOnChain } from "@/lib/server/onboarding";
import { upsertPersona } from "@/lib/server/personas";
import { clientKey, take } from "@/lib/server/rate-limit";
import { logError } from "@/lib/server/log";
import { encrypt, hmac } from "@/lib/server/secrets";
import { endSession, startSession } from "@/lib/server/session";

/** Signs in as one of the two pre-verified demo investors. */
export async function loginAsPersona(formData: FormData): Promise<void> {
  const persona = formData.get("persona");
  if (persona !== "ALICE" && persona !== "BOB") throw new Error("Unknown persona");
  if (!take("login", await clientKey())) redirect("/login?e=rate");
  await startSession(await upsertPersona(persona));
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
 * Sign-up with mock KYC, then real on-chain onboarding.
 * Data minimisation: the full CNIC and phone number are never stored. We keep the last digits for
 * display and an HMAC (with a secret pepper) to enforce one account per CNIC.
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

  // Mock NADRA Verisys: CNICs ending in 0 are "not found", to demonstrate the rejection path.
  if (cnic.endsWith("0")) {
    return { error: "nadra" };
  }

  const pool = await db();
  const cnicHmac = hmac("cnic", cnic.replaceAll("-", ""));
  const dup = await pool.query("SELECT 1 FROM webdemo.investors WHERE cnic_hmac = $1", [cnicHmac]);
  if (dup.rowCount) return { error: "duplicate" };

  const key = generatePrivateKey();
  const account = privateKeyToAccount(key);
  let id: string | undefined;
  try {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO webdemo.investors (display_name, cnic_last4, cnic_hmac, phone_last3, wallet_address, wallet_key_enc, kyc_status, kyc_note)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', 'NADRA (mock) passed; liveness (simulated) passed') RETURNING id`,
      [fullName, cnic.replaceAll("-", "").slice(-4), cnicHmac, phone.replaceAll("-", "").slice(-3), account.address, encrypt(key)],
    );
    id = rows[0]?.id;
  } catch (e) {
    // Two sign-ups with the same CNIC at once: the unique index refuses the second.
    if (e instanceof Error && "code" in e && e.code === "23505") return { error: "duplicate" };
    logError("signUp insert", e);
    return { error: "generic" };
  }
  if (!id) return { error: "generic" };

  try {
    const { identity } = await onboardOnChain(account, `web-${id}`);
    await pool.query("UPDATE webdemo.investors SET identity_address = $2, kyc_status = 'verified' WHERE id = $1", [id, identity]);
  } catch (e) {
    // Not registered: remove the pending record so the same person can simply try again. A partly
    // created ONCHAINID stays unregistered on chain and cannot hold tokens.
    logError("signUp onboarding", e);
    await pool.query("DELETE FROM webdemo.investors WHERE id = $1 AND kyc_status = 'pending'", [id]);
    return { error: "chain" };
  }
  await startSession(id);
  redirect("/account");
}

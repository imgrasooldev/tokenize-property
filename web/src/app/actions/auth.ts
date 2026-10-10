"use server";

import { redirect } from "next/navigation";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import { idFactoryAbi } from "@/lib/abis";
import { latestDeployment } from "@/lib/server/chain";
import { db } from "@/lib/server/db";
import { personaAccount, publicClient, type Persona } from "@/lib/server/demo-signer";
import { isVerifiedOnChain, onboardOnChain } from "@/lib/server/onboarding";
import { encrypt, hmac } from "@/lib/server/secrets";
import { endSession, startSession } from "@/lib/server/session";

const PERSONAS: Record<Persona, string> = { ALICE: "Alice (demo)", BOB: "Bob (demo)" };

/** Signs in as one of the two pre-verified demo investors. */
export async function loginAsPersona(formData: FormData): Promise<void> {
  const persona = formData.get("persona");
  if (persona !== "ALICE" && persona !== "BOB") throw new Error("Unknown persona");
  const account = personaAccount(persona);
  const idFactory = latestDeployment()?.get("idFactory");
  const identity = idFactory
    ? await publicClient
        .readContract({ address: idFactory, abi: idFactoryAbi, functionName: "getIdentity", args: [account.address] })
        .catch(() => null)
    : null;
  const verified = (await isVerifiedOnChain(account.address)) === true;
  const pool = await db();
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO webdemo.investors (persona, display_name, wallet_address, identity_address, kyc_status)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (persona) DO UPDATE SET wallet_address = EXCLUDED.wallet_address,
       identity_address = EXCLUDED.identity_address, kyc_status = EXCLUDED.kyc_status
     RETURNING id`,
    [persona, persona === "ALICE" ? PERSONAS.ALICE : PERSONAS.BOB, account.address, identity && !/^0x0+$/.test(identity) ? identity : null, verified ? "verified" : "pending"],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error("Could not sign in");
  await startSession(id);
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
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO webdemo.investors (display_name, cnic_last4, cnic_hmac, phone_last3, wallet_address, wallet_key_enc, kyc_status, kyc_note)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending', 'NADRA (mock) passed; liveness (simulated) passed') RETURNING id`,
    [fullName, cnic.replaceAll("-", "").slice(-4), cnicHmac, phone.replaceAll("-", "").slice(-3), account.address, encrypt(key)],
  );
  const id = rows[0]?.id;
  if (!id) return { error: "generic" };

  try {
    const { identity } = await onboardOnChain(account, `web-${id}`);
    await pool.query("UPDATE webdemo.investors SET identity_address = $2, kyc_status = 'verified' WHERE id = $1", [id, identity]);
  } catch {
    await pool.query("UPDATE webdemo.investors SET kyc_note = 'on-chain registration failed; retry later' WHERE id = $1", [id]);
    return { error: "chain" };
  }
  await startSession(id);
  redirect("/account");
}

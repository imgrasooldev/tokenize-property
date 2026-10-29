import type pg from "pg";
import { KycError, type KycService } from "./service.ts";

/**
 * Demo personas (Alice, Bob) predate the KYC service: their website rows say "verified" but have no
 * KYC subject, so nothing that hangs off a subject (notifications, payout accounts, tax certificates,
 * support lookups) works for them. This gives each persona a real subject through the KYC service
 * with the MOCK providers and a fictional CNIC, binds the persona's wallet, and links the subject to
 * the website row. Local and demo chains only (the caller refuses production); idempotent.
 */
const FICTIONAL: Record<string, { cnic: string; name: string }> = {
  // Last digit 1-7: the mock NADRA passes. These numbers are fictional and only ever used with mocks.
  ALICE: { cnic: "4210100000011", name: "Alice Demo" },
  BOB: { cnic: "4210100000022", name: "Bob Demo" },
};

export interface PersonaLink {
  persona: string;
  subjectId: string;
  outcome: "linked" | "already linked";
}

export async function linkDemoPersonas(db: pg.Pool, kyc: KycService): Promise<PersonaLink[]> {
  const { rows } = await db.query<{ id: string; persona: string; wallet: string; subject: string | null }>(
    "SELECT id, persona, lower(wallet_address) AS wallet, kyc_subject::text AS subject FROM webdemo.investors WHERE persona IS NOT NULL ORDER BY persona",
  );
  const out: PersonaLink[] = [];
  for (const r of rows) {
    if (r.subject) {
      out.push({ persona: r.persona, subjectId: r.subject, outcome: "already linked" });
      continue;
    }
    const who = new Map(Object.entries(FICTIONAL)).get(r.persona);
    if (!who) continue;
    // A subject may already hold the wallet (an earlier run whose website row was recreated).
    let subjectId = (await db.query<{ s: string }>("SELECT subject_id::text AS s FROM kyc.wallets WHERE wallet = $1", [r.wallet])).rows[0]?.s ?? null;
    if (!subjectId) {
      try {
        const res = await kyc.onboard({ cnic: who.cnic, fullName: who.name, livenessSessionId: `persona-${r.persona.toLowerCase()}-0001`, wallet: r.wallet });
        if (res.status !== "verified") throw new Error(`${r.persona}: the mock KYC did not verify (${res.status} ${res.reason})`);
        subjectId = res.subjectId;
      } catch (e) {
        if (e instanceof KycError && e.code === "DUPLICATE_CNIC") throw new Error(`${r.persona}: the fictional CNIC is registered to another subject; link it by hand`, { cause: e });
        throw e;
      }
    }
    await db.query("UPDATE webdemo.investors SET kyc_subject = $2 WHERE id = $1 AND kyc_subject IS NULL", [r.id, subjectId]);
    out.push({ persona: r.persona, subjectId, outcome: "linked" });
  }
  return out;
}

import { createHash } from "node:crypto";
import { db } from "./db";
import { sponsorStore } from "./services";

/**
 * The property sponsor portal (migration 0048). Every call is session-bound: the database finds the
 * sponsors the signed-in person represents and runs the S-01 functions as that representative
 * (powers, KYC and state rules apply). Nothing internal (screening, risk, duplicates, reviewers)
 * ever reaches the website.
 */
export interface SponsorDoc {
  type: string;
  sha256: string;
  at: string;
  verified: boolean;
}

export interface SponsorNote {
  code: string;
  reason: string;
  at: string;
}

export interface SponsorProperty {
  id: string;
  state: string;
  building: string | null;
  district: string | null;
  province: string | null;
  missing: string | null;
  note: SponsorNote | null;
  documents: SponsorDoc[];
}

export interface SponsorFile {
  id: string;
  kind: "company" | "individual";
  cuinLast: string | null;
  state: string;
  role: string;
  powers: string[];
  note: SponsorNote | null;
  documents: SponsorDoc[];
  properties: SponsorProperty[];
}

export async function sponsorOverview(session: Buffer): Promise<SponsorFile[]> {
  const { rows } = await (await db()).query<{ v: SponsorFile[] | null }>("SELECT sponsorweb.overview($1) AS v", [session]);
  return rows[0]?.v ?? [];
}

export type SponsorAction = "submit_kyb" | "create_property" | "update_property" | "submit_property" | "withdraw_property";
export type SponsorResult = { ok: true; property?: string } | { error: "session" | "forbidden" | "state" | "invalid" | "unknown" };

const refusal = (e: unknown): SponsorResult | null => {
  const code = (e as { code?: string }).code ?? "";
  if (code === "42501") return { error: "forbidden" };
  if (code === "23514" || code === "23505") return { error: "state" };
  if (code === "P0002") return { error: "unknown" };
  if (code.startsWith("22")) return { error: "invalid" };
  return null;
};

export async function sponsorAct(
  session: Buffer,
  a: { sponsor: string | null; property: string | null; action: SponsorAction; ids?: Record<string, string | boolean>; reason?: string },
): Promise<SponsorResult> {
  try {
    const { rows } = await (await db()).query<{ r: { ok?: boolean; error?: string; property?: string } }>("SELECT sponsorweb.act($1, $2, $3, $4, $5::jsonb, $6) AS r", [
      session,
      a.sponsor,
      a.property,
      a.action,
      a.ids ? JSON.stringify(a.ids) : null,
      a.reason ?? null,
    ]);
    const r = rows[0]?.r;
    if (!r?.ok) return { error: "session" };
    return r.property ? { ok: true, property: r.property } : { ok: true };
  } catch (e) {
    const x = refusal(e);
    if (x) return x;
    throw e;
  }
}

/** Upload: a one-time ticket for exactly this file, the vault stores it, then the document is recorded (SP-3). */
export async function sponsorUpload(session: Buffer, a: { sponsor: string; property: string | null; type: string; media: string; bytes: Buffer }): Promise<SponsorResult> {
  const sha = createHash("sha256").update(a.bytes).digest();
  try {
    const t = await (await db()).query<{ t: string }>("SELECT sponsorweb.upload_ticket($1, $2, $3, $4, $5, $6, $7) AS t", [
      session,
      a.sponsor,
      a.property,
      a.type,
      sha,
      a.bytes.length,
      a.media,
    ]);
    const ticket = t.rows[0]?.t ?? "";
    if (!(await sponsorStore(ticket, a.media, a.bytes))) return { error: "state" };
    await (await db()).query("SELECT sponsorweb.add_document($1, $2)", [session, ticket]);
    return { ok: true };
  } catch (e) {
    const x = refusal(e);
    if (x) return x;
    throw e;
  }
}

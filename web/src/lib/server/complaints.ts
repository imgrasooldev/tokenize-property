import { db } from "./db";

/**
 * Investor complaints (migration 0040). Every call goes through a session-bound complaints.web_*
 * function: the database derives the investor from the session and returns or changes only that
 * investor's complaints. A referral to compliance reads "under_review".
 */
export interface ComplaintSummary {
  id: number;
  ref: string;
  category: string;
  title: string;
  status: string;
  createdAt: string;
  resolveDue: string;
}

export interface ComplaintCase extends ComplaintSummary {
  ackDue: string;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  resolution: string | null;
  closedAt: string | null;
  reopenUntil: string | null;
  messages: { from: "investor" | "officer"; body: string; at: string }[];
  events: { action: string; at: string }[];
}

export async function myComplaints(session: Buffer): Promise<ComplaintSummary[]> {
  const { rows } = await (await db()).query<{ v: ComplaintSummary[] | null }>("SELECT complaints.web_cases($1) AS v", [session]);
  return rows[0]?.v ?? [];
}

export async function myComplaint(session: Buffer, id: string): Promise<ComplaintCase | null> {
  if (!/^[1-9]\d{0,17}$/.test(id)) return null;
  const { rows } = await (await db()).query<{ v: ComplaintCase | null }>("SELECT complaints.web_case($1, $2) AS v", [session, id]);
  return rows[0]?.v ?? null;
}

export type ComplaintResult = { ok: true; id?: number; ref?: string } | { error: "session" | "invalid" | "unknown" };

const refused = (e: unknown): ComplaintResult | null => {
  const code = (e as { code?: string }).code;
  if (code === "23514") return { error: "invalid" };
  if (code === "P0002") return { error: "unknown" };
  return null;
};

export async function fileComplaint(session: Buffer, category: string, title: string, body: string): Promise<ComplaintResult> {
  try {
    const { rows } = await (await db()).query<{ r: { id?: number; ref?: string; error?: string } }>("SELECT complaints.web_file($1, $2, $3, $4) AS r", [
      session,
      category,
      title,
      body,
    ]);
    const r = rows[0]?.r;
    if (!r || r.error) return { error: "session" };
    return { ok: true, id: r.id, ref: r.ref };
  } catch (e) {
    const x = refused(e);
    if (x) return x;
    throw e;
  }
}

export async function actOnComplaint(session: Buffer, id: string, action: "reply" | "close" | "reopen", body: string | null): Promise<ComplaintResult> {
  try {
    const { rows } = await (await db()).query<{ r: { error?: string } }>("SELECT complaints.web_act($1, $2, $3, $4) AS r", [session, id, action, body]);
    if (rows[0]?.r.error) return { error: "session" };
    return { ok: true };
  } catch (e) {
    const x = refused(e);
    if (x) return x;
    throw e;
  }
}

import { db } from "./db";

/** Investor complaints in PT Control (migration 0040): reads through admin.complaints / admin.complaint only. */
export interface ComplaintRow {
  id: number;
  ref: string;
  category: string;
  title: string;
  status: "open" | "acknowledged" | "resolved" | "closed" | "referred";
  createdAt: string;
  ackDue: string;
  resolveDue: string;
  ackLate: boolean;
  resolveLate: boolean;
}

export interface Complaint {
  id: number;
  ref: string;
  category: string;
  title: string;
  status: ComplaintRow["status"];
  investorRef: string | null;
  createdAt: string;
  ackDue: string;
  resolveDue: string;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  resolution: string | null;
  closedAt: string | null;
  messages: { from: "investor" | "officer"; author: string; body: string; at: string }[];
  events: { action: string; actor: string; at: string }[];
}

export async function complaints(sessionHash: Buffer): Promise<ComplaintRow[]> {
  const { rows } = await db().query<{ v: { cases: ComplaintRow[] } }>("SELECT admin.complaints($1) AS v", [sessionHash]);
  return rows[0]?.v.cases ?? [];
}

export async function complaint(sessionHash: Buffer, id: string): Promise<Complaint | null> {
  const { rows } = await db().query<{ v: Complaint | null }>("SELECT admin.complaint($1, $2) AS v", [sessionHash, id]);
  return rows[0]?.v ?? null;
}

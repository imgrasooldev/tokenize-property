import { db } from "./db";

/** Token-holder polls (admin.polls, migration 0046). */
export interface Poll {
  id: number;
  token: string;
  title: string;
  question: string;
  options: string[];
  recordBlock: number;
  opensAt: string;
  closesAt: string;
  quorumPpm: number;
  status: "proposed" | "approved" | "rejected" | "closed";
  proposedBy: string;
  decidedBy: string | null;
  canClose: boolean;
  ballots: number;
  result: { options: { option: string; weight: string; ballots: number }[]; unitsAtRecord: string; turnoutPpm: number; quorumMet: boolean } | null;
}

export async function polls(sessionHash: Buffer): Promise<{ polls: Poll[]; tokens: { token: string; cursor: number }[] }> {
  const { rows } = await db().query<{ v: { polls: Poll[]; tokens: { token: string; cursor: number }[] } }>("SELECT admin.polls($1) AS v", [sessionHash]);
  return rows[0]?.v ?? { polls: [], tokens: [] };
}

import { db } from "./db";

/**
 * Token-holder votes (migration 0046). Every call is session-bound: the database derives the
 * investor, their KYC subject and wallet, and shows only polls of tokens they held at the record
 * block; running totals are never returned, only the result after closing.
 */
export interface MyPoll {
  id: number;
  token: string;
  title: string;
  question: string;
  options: string[];
  recordBlock: number;
  opensAt: string;
  closesAt: string;
  quorumPpm: number;
  state: "upcoming" | "open" | "counting" | "closed";
  weight: string;
  myChoice: number | null;
  result: { options: { option: string; weight: string }[]; turnoutPpm: number; quorumMet: boolean } | null;
}

export async function myPolls(session: Buffer): Promise<MyPoll[]> {
  const { rows } = await (await db()).query<{ v: MyPoll[] | null }>("SELECT voting.web_polls($1) AS v", [session]);
  return rows[0]?.v ?? [];
}

export type VoteResult = { ok: true } | { error: "stepup" | "enrolPasskey" | "session" | "closed" };

export async function castVote(session: Buffer, poll: string, choice: number): Promise<VoteResult> {
  try {
    const { rows } = await (await db()).query<{ r: { ok?: boolean; error?: string } }>("SELECT webauth.web_vote($1, $2, $3) AS r", [session, poll, choice]);
    const r = rows[0]?.r;
    if (r?.error === "step_up") return { error: "stepup" };
    if (r?.error === "enrol") return { error: "enrolPasskey" };
    if (!r?.ok) return { error: "session" };
    return { ok: true };
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "23514" || code === "42501") return { error: "closed" };
    throw e;
  }
}

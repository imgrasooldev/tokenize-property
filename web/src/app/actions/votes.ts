"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { logError } from "@/lib/server/log";
import { take } from "@/lib/server/rate-limit";
import { currentSession } from "@/lib/server/session";
import { castVote } from "@/lib/server/votes";

/** Casts one token-holder vote (migration 0046); the database decides the weight and refuses a second vote. */
const schema = z.object({ poll: z.string().regex(/^[1-9][0-9]{0,17}$/), choice: z.coerce.number().int().min(0).max(5) });

export interface VoteState {
  ok?: boolean;
  error?: "rate" | "closed" | "generic" | "stepup" | "enrolPasskey";
}

export async function voteAction(_prev: VoteState, formData: FormData): Promise<VoteState> {
  const s = await currentSession();
  if (!s) redirect("/login");
  const parsed = schema.safeParse({ poll: formData.get("poll"), choice: formData.get("choice") });
  if (!parsed.success) return { error: "closed" };
  if (!take("transfer", s.investorId)) return { error: "rate" };
  try {
    const r = await castVote(s.hash, parsed.data.poll, parsed.data.choice);
    if ("error" in r) return { error: r.error === "session" ? "generic" : r.error };
  } catch (e) {
    logError("vote", e);
    return { error: "generic" };
  }
  revalidatePath("/votes");
  return { ok: true };
}

import type { NextRequest } from "next/server";
import { complianceRoute, HEX32, ID, text } from "@/lib/server/compliance-route";

const VOTES = new Set(["approve", "reject", "abstain", "conflict"]);

/**
 * A committee member's vote (approve / reject / abstain with a reason) or declared conflict
 * (admin.committee_vote -> property.cast_vote under the officer's handle), bound to the digest of
 * the file as shown.
 */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const valid = ID.test(id);
  return complianceRoute(request, {
    permission: "committee.vote",
    back: valid ? `/committees/${id}` : "/committees",
    build: (o, form) => {
      if (!valid) return "Unknown meeting.";
      const vote = form?.get("decision");
      const reason = text(form, "reason", 500);
      const digest = form?.get("digest");
      if (typeof vote !== "string" || !VOTES.has(vote)) return "Choose approve, reject, abstain or a conflict.";
      if (!reason || reason.length < 10) return "Give a reason of at least 10 characters.";
      if (typeof digest !== "string" || !HEX32.test(digest)) return "What you reviewed is missing: reload the page.";
      return { sql: "SELECT admin.committee_vote($1, $2, $3, $4, $5) AS r", params: [o.sessionHash, id, vote, reason, Buffer.from(digest, "hex")] };
    },
    okMessage: (r) => (r.status === "conflict" ? "Conflict recorded: you take no part in this vote." : `Vote recorded: ${r.status ?? "done"}.`),
  });
}

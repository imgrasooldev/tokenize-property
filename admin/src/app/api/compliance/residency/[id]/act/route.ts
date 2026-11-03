import type { NextRequest } from "next/server";
import { complianceRoute, HEX32, ID, text } from "@/lib/server/compliance-route";

const ACTIONS = new Set(["propose", "confirm", "decline", "reject"]);

/** One action on a residency review (admin.residency_act -> compliance.residency_act, spec S-08 RD-2). */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const valid = ID.test(id);
  return complianceRoute(request, {
    permission: "compliance.decide",
    back: valid ? `/compliance/residency/${id}` : "/compliance/residency",
    build: (o, form) => {
      if (!valid) return "Unknown review.";
      const action = form?.get("decision");
      const reason = text(form, "reason", 500);
      const digest = form?.get("digest");
      if (typeof action !== "string" || !ACTIONS.has(action)) return "Choose an action.";
      if (!reason || reason.length < 10) return "Give a reason of at least 10 characters.";
      if (typeof digest !== "string" || !HEX32.test(digest)) return "What you reviewed is missing: reload the page.";
      return { sql: "SELECT admin.residency_act($1, $2, $3, $4, $5) AS r", params: [o.sessionHash, id, action, reason, Buffer.from(digest, "hex")] };
    },
    okMessage: (r) => `Recorded: the review is now ${r.status ?? "updated"}.`,
  });
}

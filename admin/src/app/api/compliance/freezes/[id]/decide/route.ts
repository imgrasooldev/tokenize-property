import type { NextRequest } from "next/server";
import { complianceRoute, HEX32, ID, text } from "@/lib/server/compliance-route";

/**
 * Checker: approves or rejects a freeze or unfreeze (admin.decide_freeze -> compliance.decide_freeze:
 * maker-checker, 24 hours, hold, outbox command for the signing service in the same transaction).
 */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const valid = ID.test(id);
  return complianceRoute(request, {
    permission: "compliance.decide",
    back: valid ? `/compliance/freezes/${id}` : "/compliance/freezes",
    build: (o, form) => {
      if (!valid) return "Unknown request.";
      const choice = form?.get("decision");
      const reason = text(form, "reason", 500);
      const digest = form?.get("digest");
      if (choice !== "approve" && choice !== "reject") return "Choose approve or reject.";
      if (!reason || reason.length < 10) return "Give a reason of at least 10 characters.";
      if (typeof digest !== "string" || !HEX32.test(digest)) return "What you reviewed is missing: reload the page.";
      return { sql: "SELECT admin.decide_freeze($1, $2, $3, $4, $5) AS r", params: [o.sessionHash, id, choice, reason, Buffer.from(digest, "hex")] };
    },
    okMessage: (r) =>
      r.status === "approved" ? "Approved: the command is in the outbox for the signing service." : `Decision recorded: ${r.status ?? "done"}.`,
  });
}

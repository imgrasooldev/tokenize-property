import type { NextRequest } from "next/server";
import { complianceRoute, HEX32, ID, text } from "@/lib/server/compliance-route";

/** Checker: approves or rejects an identity deletion (admin.decide_identity_deletion; zero units checked again). */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const valid = ID.test(id);
  return complianceRoute(request, {
    permission: "compliance.decide",
    back: valid ? `/compliance/offboarding/${id}` : "/compliance/offboarding",
    build: (o, form) => {
      if (!valid) return "Unknown request.";
      const choice = form?.get("decision");
      const reason = text(form, "reason", 500);
      const digest = form?.get("digest");
      if (choice !== "approve" && choice !== "reject") return "Choose approve or reject.";
      if (!reason || reason.length < 10) return "Give a reason of at least 10 characters.";
      if (typeof digest !== "string" || !HEX32.test(digest)) return "What you reviewed is missing: reload the page.";
      return { sql: "SELECT admin.decide_identity_deletion($1, $2, $3, $4, $5) AS r", params: [o.sessionHash, id, choice, reason, Buffer.from(digest, "hex")] };
    },
    okMessage: (r) => (r.status === "approved" ? "Approved: the Admin Safe schedules the timelock call shown below." : `Decision recorded: ${r.status ?? "done"}.`),
  });
}

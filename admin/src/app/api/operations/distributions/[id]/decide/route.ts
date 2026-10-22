import type { NextRequest } from "next/server";
import { complianceRoute, HEX32, ID, text } from "@/lib/server/compliance-route";

/**
 * Checker: approves a distribution calculation with its statement and tax schedule, or returns it
 * (admin.decide_distribution -> ops.decide_distribution: nobody who calculated or attached it,
 * step-up, digest; placeholder tax rates are refused). Publication on chain follows (T-022).
 */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const valid = ID.test(id);
  return complianceRoute(request, {
    permission: "operations.decide",
    back: valid ? `/operations/distributions/${id}` : "/operations",
    build: (o, form) => {
      if (!valid) return "Unknown distribution.";
      const choice = form?.get("decision");
      const reason = text(form, "reason", 500);
      const digest = form?.get("digest");
      if (choice !== "approve" && choice !== "reject") return "Choose approve or reject.";
      if (!reason || reason.length < 10) return "Give a reason of at least 10 characters.";
      if (typeof digest !== "string" || !HEX32.test(digest)) return "What you reviewed is missing: reload the page.";
      return { sql: "SELECT admin.decide_distribution($1, $2, $3, $4, $5) AS r", params: [o.sessionHash, id, choice, reason, Buffer.from(digest, "hex")] };
    },
    okMessage: (r) => (r.status === "approved" ? "Approved: ready to publish on chain." : `Decision recorded: ${r.status ?? "done"}.`),
  });
}

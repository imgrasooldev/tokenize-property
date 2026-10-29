import type { NextRequest } from "next/server";
import { complianceRoute, ID, text } from "@/lib/server/compliance-route";

/** Checker: approve (the money goes back to the payer) or reject a suspense return (admin.decide_suspense_return, migration 0038). */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return complianceRoute(request, {
    permission: "operations.decide",
    back: "/operations/bank",
    build: (o, form) => {
      if (!ID.test(id)) return "Unknown return request.";
      const choice = form?.get("decision");
      const reason = text(form, "reason", 500);
      if (choice !== "approve" && choice !== "reject") return "Choose approve or reject.";
      if (!reason || reason.length < 10) return "Give a reason of at least 10 characters.";
      return { sql: "SELECT admin.decide_suspense_return($1, $2, $3, $4) AS r", params: [o.sessionHash, id, choice, reason] };
    },
    okMessage: (r) => `Return #${id}: ${r.status ?? "decided"}.`,
  });
}

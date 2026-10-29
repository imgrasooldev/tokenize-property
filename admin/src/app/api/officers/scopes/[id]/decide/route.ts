import type { NextRequest } from "next/server";
import { complianceRoute, ID, text } from "@/lib/server/compliance-route";

/** Administrator (checker): approve or reject a property manager's property change (admin.decide_manager_scope, migration 0034). */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return complianceRoute(request, {
    permission: "officers.manage",
    back: "/officers",
    build: (o, form) => {
      if (!ID.test(id)) return "Unknown change.";
      const choice = form?.get("decision");
      const reason = text(form, "reason", 500);
      if (choice !== "approve" && choice !== "reject") return "Choose approve or reject.";
      if (!reason || reason.length < 10) return "Give a reason of at least 10 characters.";
      return { sql: "SELECT admin.decide_manager_scope($1, $2, $3, $4) AS r", params: [o.sessionHash, id, choice, reason] };
    },
    okMessage: (r) => `Property change #${id}: ${r.status ?? "decided"}.`,
  });
}

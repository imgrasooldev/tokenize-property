import type { NextRequest } from "next/server";
import { complianceRoute, ID, text } from "@/lib/server/compliance-route";

/** Checker: approve or reject a proposed rent collection (admin.decide_collection, migration 0044); a linked invoice follows. */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return complianceRoute(request, {
    permission: "operations.decide",
    back: "/operations/invoices",
    build: (o, form) => {
      if (!ID.test(id)) return "Unknown collection.";
      const choice = form?.get("decision");
      const reason = text(form, "reason", 500);
      if (choice !== "approve" && choice !== "reject") return "Choose approve or reject.";
      if (!reason || reason.length < 10) return "Give a reason of at least 10 characters.";
      return { sql: "SELECT admin.decide_collection($1, $2, $3, $4) AS r", params: [o.sessionHash, id, choice, reason] };
    },
    okMessage: (r) => `Collection #${id}: ${r.status ?? "decided"}.`,
  });
}

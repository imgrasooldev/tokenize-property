import type { NextRequest } from "next/server";
import { complianceRoute, ID } from "@/lib/server/compliance-route";

/**
 * Maker: the follow-up batch of a submitted distribution batch for every held line that can be paid
 * now (admin.create_followup_batch, migration 0038). It then waits for a checker on /approvals/payouts.
 */
export async function POST(request: NextRequest) {
  return complianceRoute(request, {
    permission: "operations.request",
    back: "/operations/bank",
    build: (o, form) => {
      const parent = form?.get("parent");
      if (typeof parent !== "string" || !ID.test(parent)) return "Choose a batch.";
      return { sql: "SELECT admin.create_followup_batch($1, $2) AS r", params: [o.sessionHash, parent] };
    },
    okMessage: (r) => `Follow-up batch #${String(r.id ?? "")} created: an operations checker decides it in Approvals.`,
  });
}

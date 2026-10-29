import type { NextRequest } from "next/server";
import { complianceRoute, ID } from "@/lib/server/compliance-route";

/**
 * Activate (checker) or withdraw (proposer or checker) a signing policy proposal
 * (admin.approve_signer_policy / admin.withdraw_signer_policy, migration 0039). The database decides
 * who may do which.
 */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return complianceRoute(request, {
    permission: "operations.read",
    back: "/operations/policies",
    build: (o, form) => {
      if (!ID.test(id)) return "Unknown proposal.";
      const choice = form?.get("decision");
      if (choice === "approve") return { sql: "SELECT admin.approve_signer_policy($1, $2) AS r", params: [o.sessionHash, id] };
      if (choice === "withdraw") return { sql: "SELECT admin.withdraw_signer_policy($1, $2) AS r", params: [o.sessionHash, id] };
      return "Choose approve or withdraw.";
    },
    okMessage: (r) =>
      r.status === "active" ? `Policy #${id} is active. Restart the signing service (pt-signer) so it loads it.` : `Policy proposal #${id}: ${r.status ?? "done"}.`,
  });
}

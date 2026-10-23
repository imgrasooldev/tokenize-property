import type { NextRequest } from "next/server";
import { complianceRoute, text, UUID } from "@/lib/server/compliance-route";

const RELATIONS = new Set(["family", "related_company", "common_control", "other"]);

/**
 * Compliance officer (TR-23): records a link between two investors; a sale between them raises a
 * surveillance alert (admin.transfer_link_parties: step-up; the role is enforced in the database).
 */
export async function POST(request: NextRequest) {
  return complianceRoute(request, {
    permission: "transfer.decide",
    back: "/transfers",
    build: (o, form) => {
      const a = text(form, "a", 36)?.toLowerCase() ?? null;
      const b = text(form, "b", 36)?.toLowerCase() ?? null;
      const relation = form?.get("relation");
      const reason = text(form, "reason", 500);
      if (!a || !UUID.test(a) || !b || !UUID.test(b)) return "Give both investors' references (KYC subject ids).";
      if (a === b) return "Two different investors are needed.";
      if (typeof relation !== "string" || !RELATIONS.has(relation)) return "Choose the relation.";
      if (!reason || reason.length < 10) return "Give a reason of at least 10 characters.";
      return { sql: "SELECT admin.transfer_link_parties($1, $2, $3, $4, $5) AS r", params: [o.sessionHash, a, b, relation, reason] };
    },
    okMessage: () => "Link recorded.",
  });
}

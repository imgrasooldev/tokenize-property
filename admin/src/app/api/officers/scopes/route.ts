import type { NextRequest } from "next/server";
import { complianceRoute, text, UUID } from "@/lib/server/compliance-route";

/**
 * Administrator (maker): ask to grant or revoke one property for a property manager
 * (admin.request_manager_scope, migration 0034); a different administrator decides.
 */
export async function POST(request: NextRequest) {
  return complianceRoute(request, {
    permission: "officers.manage",
    back: "/officers",
    build: (o, form) => {
      const officer = form?.get("officer");
      const property = form?.get("property");
      const action = form?.get("action");
      const reason = text(form, "reason", 500);
      if (typeof officer !== "string" || !UUID.test(officer) || typeof property !== "string" || !UUID.test(property)) return "Choose a manager and a property.";
      if (action !== "grant" && action !== "revoke") return "Choose grant or revoke.";
      if (!reason || reason.length < 10) return "Give a reason of at least 10 characters.";
      return { sql: "SELECT admin.request_manager_scope($1, $2, $3, $4, $5) AS r", params: [o.sessionHash, officer, property, action, reason] };
    },
    okMessage: (r) => `Property change #${String(r.id ?? "")} requested: another administrator decides it.`,
  });
}

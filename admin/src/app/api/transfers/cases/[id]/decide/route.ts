import type { NextRequest } from "next/server";
import { complianceRoute, HEX32, ID, text } from "@/lib/server/compliance-route";

const ACTIONS = new Set(["approve", "reject", "cancel", "dispute"]);
const CAPACITIES = new Set(["compliance", "trustee"]);

/**
 * Compliance and trustee officers: approve or reject in their capacity (T3/T4), cancel before
 * execution (T9) or record a dispute after it (T15) (admin.transfer_act: step-up, maker-checker,
 * declared conflicts, the checks and the case's own rules in the database, bound to the digest the
 * officer reviewed).
 */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const valid = ID.test(id);
  return complianceRoute(request, {
    permission: "transfer.decide",
    back: valid ? `/transfers/${id}` : "/transfers",
    build: (o, form) => {
      if (!valid) return "Unknown case.";
      const action = form?.get("decision");
      const capacity = form?.get("capacity");
      const reason = text(form, "reason", 500);
      const digest = form?.get("digest");
      if (typeof action !== "string" || !ACTIONS.has(action)) return "Choose an action.";
      const deciding = action === "approve" || action === "reject";
      if (deciding && (typeof capacity !== "string" || !CAPACITIES.has(capacity))) return "Choose the capacity you decide in.";
      if (!reason || reason.length < 10) return "Give a reason of at least 10 characters.";
      if (typeof digest !== "string" || !HEX32.test(digest)) return "What you reviewed is missing: reload the page.";
      return {
        sql: "SELECT admin.transfer_act($1, $2, $3, $4, $5, $6) AS r",
        params: [o.sessionHash, id, action, deciding ? capacity : null, reason, Buffer.from(digest, "hex")],
      };
    },
    okMessage: (r) => `Recorded: the case is now ${r.status ?? "updated"}.`,
  });
}

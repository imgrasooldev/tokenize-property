import type { NextRequest } from "next/server";
import { complianceRoute, HEX32, ID, text } from "@/lib/server/compliance-route";

const ACTIONS = new Set(["approve", "reject", "cancel", "release"]);
const CAPACITIES = new Set(["operations", "compliance", "legal"]);

/**
 * Decider: approve or reject in a capacity, cancel (objection, error) or release a freeze
 * (admin.recovery_act -> recovery.decide / cancel / release: step-up, maker-checker, capacities and
 * the case's own rules in the database, bound to the digest the officer reviewed).
 */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const valid = ID.test(id);
  return complianceRoute(request, {
    permission: "recovery.decide",
    back: valid ? `/recovery/${id}` : "/recovery",
    build: (o, form) => {
      if (!valid) return "Unknown case.";
      const action = form?.get("decision");
      const capacity = form?.get("capacity");
      const reason = text(form, "reason", 500);
      const digest = form?.get("digest");
      if (typeof action !== "string" || !ACTIONS.has(action)) return "Choose an action.";
      if ((action === "approve" || action === "reject") && (typeof capacity !== "string" || !CAPACITIES.has(capacity))) return "Choose the capacity you decide in.";
      if (!reason || reason.length < 10) return "Give a reason of at least 10 characters.";
      if (typeof digest !== "string" || !HEX32.test(digest)) return "What you reviewed is missing: reload the page.";
      return {
        sql: "SELECT admin.recovery_act($1, $2, $3, $4, $5, $6) AS r",
        params: [o.sessionHash, id, action, typeof capacity === "string" && CAPACITIES.has(capacity) ? capacity : null, reason, Buffer.from(digest, "hex")],
      };
    },
    okMessage: (r) => `Recorded: the case is now ${r.status ?? "updated"}.`,
  });
}

import type { NextRequest } from "next/server";
import { complianceRoute, ID, text } from "@/lib/server/compliance-route";

/**
 * A poll's next step (migration 0046): a trustee officer approves or rejects it (trustee.decide), an
 * operations maker closes it after its closing time (operations.request). The database checks who may.
 */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return complianceRoute(request, {
    permission: "operations.read",
    back: "/votes",
    build: (o, form) => {
      if (!ID.test(id)) return "Unknown poll.";
      const action = form?.get("action");
      if (action === "close") return { sql: "SELECT admin.close_poll($1, $2) AS r", params: [o.sessionHash, id] };
      const reason = text(form, "reason", 500);
      if (action !== "approve" && action !== "reject") return "Choose approve, reject or close.";
      if (!reason || reason.length < 10) return "Give a reason of at least 10 characters.";
      return { sql: "SELECT admin.decide_poll($1, $2, $3, $4) AS r", params: [o.sessionHash, id, action, reason] };
    },
    okMessage: (r) => `Poll #${id}: ${r.status ?? "updated"}.`,
  });
}

import type { NextRequest } from "next/server";
import { complianceRoute, HEX32, ID, text } from "@/lib/server/compliance-route";

const ACTIONS = new Set(["prepare_settlement", "prepare_refund", "approve", "reject"]);

/**
 * Cash leg (TR-B8, TR-B9): an operations maker prepares the seller's settlement or the buyer's
 * refund; an operations checker who neither prepared it nor opened or completed the case approves
 * or rejects it (admin.transfer_cash: step-up, TR-SOD-3, the payout gate and placeholder rates in
 * the database, bound to the digest the officer reviewed).
 */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const valid = ID.test(id);
  return complianceRoute(request, {
    permission: "transfer.cash",
    back: valid ? `/transfers/${id}` : "/transfers",
    build: (o, form) => {
      if (!valid) return "Unknown case.";
      const action = form?.get("decision");
      const reason = text(form, "reason", 500);
      const digest = form?.get("digest");
      if (typeof action !== "string" || !ACTIONS.has(action)) return "Choose an action.";
      const deciding = action === "approve" || action === "reject";
      if (deciding && (!reason || reason.length < 10)) return "Give a reason of at least 10 characters.";
      if (typeof digest !== "string" || !HEX32.test(digest)) return "What you reviewed is missing: reload the page.";
      return {
        sql: "SELECT admin.transfer_cash($1, $2, $3, $4, $5) AS r",
        params: [o.sessionHash, id, action, deciding ? reason : null, Buffer.from(digest, "hex")],
      };
    },
    okMessage: (r) => (r.status === "prepared" ? "Prepared: an operations checker confirms it." : `Recorded: the case is now ${r.status ?? "updated"}.`),
  });
}

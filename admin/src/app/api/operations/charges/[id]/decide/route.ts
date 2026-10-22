import type { NextRequest } from "next/server";
import { complianceRoute, HEX32, ID, text } from "@/lib/server/compliance-route";

/**
 * Checker: approves or rejects a charge (admin.decide_charge -> ops.decide_charge: a different
 * officer, step-up, bound to the digest of what was shown). Approval posts the ledger journal
 * (S-03 §7 key) in the same transaction; above the operations limit it needs the trustee.
 */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const valid = ID.test(id);
  return complianceRoute(request, {
    permission: "operations.decide",
    back: valid ? `/operations/charges/${id}` : "/operations",
    build: (o, form) => {
      if (!valid) return "Unknown charge.";
      const choice = form?.get("decision");
      const reason = text(form, "reason", 500);
      const digest = form?.get("digest");
      if (choice !== "approve" && choice !== "reject") return "Choose approve or reject.";
      if (!reason || reason.length < 10) return "Give a reason of at least 10 characters.";
      if (typeof digest !== "string" || !HEX32.test(digest)) return "What you reviewed is missing: reload the page.";
      return { sql: "SELECT admin.decide_charge($1, $2, $3, $4, $5) AS r", params: [o.sessionHash, id, choice, reason, Buffer.from(digest, "hex")] };
    },
    okMessage: (r) => (r.status === "approved" ? "Approved: the journal is posted." : `Decision recorded: ${r.status ?? "done"}.`),
  });
}

import type { NextRequest } from "next/server";
import { complianceRoute, HEX32, ID, text } from "@/lib/server/compliance-route";

const ROOT = /^0x[0-9a-fA-F]{64}$/;

/**
 * The trustee's pre-check of a distribution calculation (admin.precheck_distribution, S-03 D4):
 * approve with the Merkle root recomputed independently (must equal the attached root) or reject.
 */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const valid = ID.test(id);
  return complianceRoute(request, {
    permission: "trustee.decide",
    back: valid ? `/trustee/cosign/calculation/${id}` : "/trustee/cosign",
    build: (o, form) => {
      if (!valid) return "Unknown calculation.";
      const choice = form?.get("decision");
      const reason = text(form, "reason", 500);
      const digest = form?.get("digest");
      const root = text(form, "root", 66);
      if (choice !== "approve" && choice !== "reject") return "Choose approve or reject.";
      if (!reason || reason.length < 10) return "Give a reason of at least 10 characters.";
      if (typeof digest !== "string" || !HEX32.test(digest)) return "What you reviewed is missing: reload the page.";
      if (choice === "approve" && (!root || !ROOT.test(root))) return "To approve, give the Merkle root you recomputed (0x and 64 hex characters).";
      return {
        sql: "SELECT admin.precheck_distribution($1, $2, $3, $4, $5, $6) AS r",
        params: [o.sessionHash, id, choice, reason, Buffer.from(digest, "hex"), choice === "approve" ? (root?.toLowerCase() ?? null) : null],
      };
    },
    okMessage: (r) => (r.status === "approved" ? "Pre-checked: the operations checker may now approve the calculation." : "Rejected: the calculation must be returned and recalculated."),
  });
}

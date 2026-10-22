import type { NextRequest } from "next/server";
import { complianceRoute, HEX32, text } from "@/lib/server/compliance-route";
import { ADDRESS } from "@/lib/server/trustee";

const ROOT = /^0x[0-9a-fA-F]{64}$/;

/**
 * Trustee review of a published distribution inside its 48-hour window (admin.review_distribution):
 * approve with the Merkle root the trustee recomputed, or reject with a reason, which blocks its
 * booking and payout in the database. Bound to the digest of what was shown.
 */
export async function POST(request: NextRequest, ctx: { params: Promise<{ registry: string; id: string }> }) {
  const { registry, id } = await ctx.params;
  const valid = ADDRESS.test(registry) && /^[1-9]\d{0,30}$/.test(id);
  return complianceRoute(request, {
    permission: "trustee.decide",
    back: valid ? `/trustee/distributions/${registry}/${id}` : "/trustee/distributions",
    build: (o, form) => {
      if (!valid) return "Unknown distribution.";
      const choice = form?.get("decision");
      const reason = text(form, "reason", 500);
      const digest = form?.get("digest");
      const root = text(form, "root", 66);
      if (choice !== "approve" && choice !== "reject") return "Choose approve or reject.";
      if (!reason || reason.length < 10) return "Give a reason of at least 10 characters.";
      if (typeof digest !== "string" || !HEX32.test(digest)) return "What you reviewed is missing: reload the page.";
      if (choice === "approve" && (!root || !ROOT.test(root))) return "To approve, give the Merkle root you recomputed (0x and 64 hex characters).";
      return {
        sql: "SELECT admin.review_distribution($1, $2, $3, $4, $5, $6, $7) AS r",
        params: [o.sessionHash, registry, id, choice, reason, Buffer.from(digest, "hex"), choice === "approve" ? (root?.toLowerCase() ?? null) : null],
      };
    },
    okMessage: (r) =>
      r.status === "rejected"
        ? "Rejected: booking and payout are blocked. Execute reject(id, reason) from the Trustee Safe before the window closes."
        : "Approved: the trustee's recomputation matches the published root.",
  });
}

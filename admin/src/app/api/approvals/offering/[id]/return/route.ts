import type { NextRequest } from "next/server";
import { complianceRoute, HEX32, ID, text } from "@/lib/server/compliance-route";

/**
 * Return an offering pending approval to draft (L2) from its approval request, e.g. after the L3
 * request expired (admin.return_offering -> offering.return_offering under the officer's handle;
 * never the maker), bound to the request digest.
 */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const valid = ID.test(id);
  return complianceRoute(request, {
    permission: "offering.decide",
    back: valid ? `/approvals/offering/${id}` : "/approvals/offering",
    build: (o, form) => {
      if (!valid) return "Unknown request.";
      const reason = text(form, "reason", 500);
      const digest = form?.get("digest");
      if (form?.get("decision") !== "return") return "Choose to return the offering to draft.";
      if (!reason || reason.length < 10) return "Give a reason of at least 10 characters.";
      if (typeof digest !== "string" || !HEX32.test(digest)) return "What you reviewed is missing: reload the page.";
      return { sql: "SELECT admin.return_offering($1, $2, $3, $4) AS r", params: [o.sessionHash, id, reason, Buffer.from(digest, "hex")] };
    },
    okMessage: () => "Returned to draft: the offering maker updates the terms and submits again.",
  });
}

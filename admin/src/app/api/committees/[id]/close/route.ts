import type { NextRequest } from "next/server";
import { complianceRoute, HEX32, ID, text } from "@/lib/server/compliance-route";

/**
 * The chair closes an investment-committee meeting with the SHA-256 of the minutes
 * (admin.close_committee -> property.close_ic under the officer's handle: chair only, quorum and
 * outcome by OB-33), bound to the digest of the file and the votes as shown.
 */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const valid = ID.test(id);
  return complianceRoute(request, {
    permission: "committee.vote",
    back: valid ? `/committees/${id}` : "/committees",
    build: (o, form) => {
      if (!valid) return "Unknown meeting.";
      const reason = text(form, "reason", 500);
      const digest = form?.get("digest");
      const minutes = text(form, "minutes", 64)?.toLowerCase();
      if (form?.get("decision") !== "close") return "Choose to close the meeting.";
      if (!reason || reason.length < 10) return "Give a closing note of at least 10 characters.";
      if (!minutes || !HEX32.test(minutes)) return "Give the SHA-256 of the signed minutes (64 hex characters).";
      if (typeof digest !== "string" || !HEX32.test(digest)) return "What you reviewed is missing: reload the page.";
      return { sql: "SELECT admin.close_committee($1, $2, $3, $4, $5) AS r", params: [o.sessionHash, id, minutes, reason, Buffer.from(digest, "hex")] };
    },
    okMessage: (r) => (r.status === "legal_approved" ? "Closed: approved. The property is Legal Approved." : "Closed: not approved. The property stays under review."),
  });
}

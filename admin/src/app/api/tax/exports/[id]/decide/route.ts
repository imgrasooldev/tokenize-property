import type { NextRequest } from "next/server";
import { complianceRoute, HEX32, ID, text } from "@/lib/server/compliance-route";

/** Tax officer 2: approves or rejects an export request (two officers, step-up, digest; ADR 0014). */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const valid = ID.test(id);
  return complianceRoute(request, {
    permission: "tax.export",
    back: valid ? `/tax/exports/${id}` : "/tax/exports",
    build: (o, form) => {
      if (!valid) return "Unknown export.";
      const choice = form?.get("decision");
      const reason = text(form, "reason", 500);
      const digest = form?.get("digest");
      if (choice !== "approve" && choice !== "reject") return "Choose approve or reject.";
      if (!reason || reason.length < 10) return "Give a reason of at least 10 characters.";
      if (typeof digest !== "string" || !HEX32.test(digest)) return "What you reviewed is missing: reload the page.";
      return { sql: "SELECT admin.decide_tax_export($1, $2, $3, $4, $5) AS r", params: [o.sessionHash, id, choice, reason, Buffer.from(digest, "hex")] };
    },
    okMessage: (r) => (r.status === "approved" ? "Approved: either of the two officers may now generate the file (24 hours)." : `Decision recorded: ${r.status ?? "done"}.`),
  });
}

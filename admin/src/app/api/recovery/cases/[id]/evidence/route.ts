import type { NextRequest } from "next/server";
import { complianceRoute, HEX32, ID, text, UUID } from "@/lib/server/compliance-route";
import { DOC_TYPE_CODES } from "@/lib/server/recovery";

const SHARE = /^[1-9]\d{0,8}$/;

/**
 * Maker (operations): adds a document (metadata and SHA-256 only, never the file) or an heir with a
 * share to a case that nobody has decided yet (admin.recovery_add_document / admin.recovery_add_heir).
 */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const valid = ID.test(id);
  return complianceRoute(request, {
    permission: "recovery.request",
    back: valid ? `/recovery/${id}` : "/recovery",
    build: (o, form) => {
      if (!valid) return "Unknown case.";
      const what = form?.get("what");
      if (what === "document") {
        const type = text(form, "docType", 40);
        const reference = text(form, "reference", 120);
        const issuer = text(form, "issuer", 120);
        const sha = text(form, "sha256", 64)?.toLowerCase() ?? null;
        if (!type || !DOC_TYPE_CODES.includes(type)) return "Choose the document type.";
        if (!reference || reference.length < 3) return "Give the document's reference (e.g. the certificate number).";
        if (!sha || !HEX32.test(sha)) return "Give the document's SHA-256 (64 hex digits).";
        return { sql: "SELECT admin.recovery_add_document($1, $2, $3, $4, $5, $6) AS r", params: [o.sessionHash, id, type, reference, issuer, sha] };
      }
      if (what === "heir") {
        const subject = text(form, "subject", 36)?.toLowerCase() ?? null;
        const num = text(form, "num", 9);
        const den = text(form, "den", 9);
        if (!subject || !UUID.test(subject)) return "Give the heir's reference (KYC subject id).";
        if (!num || !den || !SHARE.test(num) || !SHARE.test(den)) return "Give the heir's share as a fraction (numerator / denominator).";
        return { sql: "SELECT admin.recovery_add_heir($1, $2, $3, $4, $5) AS r", params: [o.sessionHash, id, subject, num, den] };
      }
      return "Choose what to add: a document or an heir.";
    },
    okMessage: () => "Added to the case.",
  });
}

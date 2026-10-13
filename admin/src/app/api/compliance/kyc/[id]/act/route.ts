import type { NextRequest } from "next/server";
import { CASE_ACTIONS, type CaseAction } from "@/lib/server/compliance";
import { complianceRoute, HEX32, ID, text } from "@/lib/server/compliance-route";

/**
 * One action on a KYC review case (admin.kyc_case_act: session, compliance.decide, step-up, the
 * digest of what the officer saw; then compliance.kyc_case_act: state machine, maker-checker for
 * high risk, Y-4 clearances for screening matches).
 */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const valid = ID.test(id);
  return complianceRoute(request, {
    permission: "compliance.decide",
    back: valid ? `/compliance/kyc/${id}` : "/compliance/kyc",
    build: (o, form) => {
      if (!valid) return "Unknown case.";
      const action = form?.get("decision");
      const reason = text(form, "reason", 500);
      const digest = form?.get("digest");
      if (typeof action !== "string" || !CASE_ACTIONS.includes(action as CaseAction)) return "Choose an action.";
      if (!reason || reason.length < 10) return "Give a reason of at least 10 characters.";
      if (typeof digest !== "string" || !HEX32.test(digest)) return "What you reviewed is missing: reload the page.";
      return { sql: "SELECT admin.kyc_case_act($1, $2, $3, $4, $5) AS r", params: [o.sessionHash, id, action, reason, Buffer.from(digest, "hex")] };
    },
    okMessage: (r) => `Recorded: the case is now ${r.status ?? "updated"}.`,
  });
}

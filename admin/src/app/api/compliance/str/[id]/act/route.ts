import type { NextRequest } from "next/server";
import { STR_ACTIONS, type StrAction } from "@/lib/server/compliance";
import { complianceRoute, HEX32, ID, text } from "@/lib/server/compliance-route";

/** One STR case action (admin.str_act: step-up, digest; closing without a report needs a second officer). */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const valid = ID.test(id);
  return complianceRoute(request, {
    permission: "compliance.decide",
    back: valid ? `/compliance/str/${id}` : "/compliance/str",
    build: (o, form) => {
      if (!valid) return "Unknown case.";
      const action = form?.get("decision");
      const reason = text(form, "reason", 500);
      const fmu = text(form, "fmuReference", 40);
      const digest = form?.get("digest");
      if (typeof action !== "string" || !STR_ACTIONS.includes(action as StrAction)) return "Choose an action.";
      if (!reason || reason.length < 10) return "Give a reason of at least 10 characters.";
      if (typeof digest !== "string" || !HEX32.test(digest)) return "What you reviewed is missing: reload the page.";
      return { sql: "SELECT admin.str_act($1, $2, $3, $4, $5, $6) AS r", params: [o.sessionHash, id, action, reason, fmu, Buffer.from(digest, "hex")] };
    },
    okMessage: (r) => `Recorded: the case is now ${r.status ?? "updated"}.`,
  });
}

import type { NextRequest } from "next/server";
import { complianceRoute, HEX32, ID, text } from "@/lib/server/compliance-route";
import { TM_ACTIONS, type TmAction } from "@/lib/server/monitoring";

/** One decision on a monitoring alert (admin.tm_alert_act: step-up, digest; dismissing needs a second officer). */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const valid = ID.test(id);
  return complianceRoute(request, {
    permission: "compliance.decide",
    back: valid ? `/compliance/monitoring/${id}` : "/compliance/monitoring",
    build: (o, form) => {
      if (!valid) return "Unknown alert.";
      const action = form?.get("decision");
      const reason = text(form, "reason", 500);
      const digest = form?.get("digest");
      if (typeof action !== "string" || !TM_ACTIONS.includes(action as TmAction)) return "Choose an action.";
      if (!reason || reason.length < 10) return "Give a reason of at least 10 characters.";
      if (typeof digest !== "string" || !HEX32.test(digest)) return "What you reviewed is missing: reload the page.";
      return { sql: "SELECT admin.tm_alert_act($1, $2, $3, $4, $5) AS r", params: [o.sessionHash, id, action, reason, Buffer.from(digest, "hex")] };
    },
    okPath: (r) => (r.strCase ? `/compliance/str/${String(r.strCase)}` : `/compliance/monitoring/${id}`),
    okMessage: (r) => (r.strCase ? `STR case #${String(r.strCase)} opened from monitoring alert #${id}.` : `Recorded: the alert is now ${(r.status ?? "updated").replace("_", " ")}.`),
  });
}

import type { NextRequest } from "next/server";
import { complianceRoute, ID, text } from "@/lib/server/compliance-route";

/**
 * Support or operations: acknowledge, reply to, resolve or refer an investor complaint to compliance
 * (admin.complaint_act, migration 0040; complaints.handle, step-up, under the officer's handle).
 */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const valid = ID.test(id);
  return complianceRoute(request, {
    permission: "complaints.handle",
    back: valid ? `/complaints/${id}` : "/complaints",
    build: (o, form) => {
      if (!valid) return "Unknown complaint.";
      const action = form?.get("action");
      if (action !== "acknowledge" && action !== "reply" && action !== "resolve" && action !== "refer") return "Choose an action.";
      const body = text(form, "body", 2000);
      if ((action === "reply" || action === "resolve") && !body) return "Write the message first.";
      return { sql: "SELECT admin.complaint_act($1, $2, $3, $4) AS r", params: [o.sessionHash, id, action, body] };
    },
    okMessage: (r) => `Complaint ${r.status ?? "updated"}.`,
  });
}

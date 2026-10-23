import type { NextRequest } from "next/server";
import { complianceRoute, HEX32, ID, text } from "@/lib/server/compliance-route";

/**
 * Transfer desk (operations maker): completes an accepted request (T1: the checks run and are
 * recorded, surveillance is evaluated) or withdraws it for a party who asked in writing (T2)
 * (admin.transfer_act: step-up, bound to the digest the officer reviewed).
 */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const valid = ID.test(id);
  return complianceRoute(request, {
    permission: "transfer.request",
    back: valid ? `/transfers/${id}` : "/transfers",
    build: (o, form) => {
      if (!valid) return "Unknown case.";
      const action = form?.get("decision");
      const reason = text(form, "reason", 500);
      const digest = form?.get("digest");
      if (action !== "complete" && action !== "withdraw") return "Choose an action.";
      if (action === "withdraw" && (!reason || reason.length < 10)) return "Give a reason of at least 10 characters.";
      if (typeof digest !== "string" || !HEX32.test(digest)) return "What you reviewed is missing: reload the page.";
      return {
        sql: "SELECT admin.transfer_act($1, $2, $3, NULL, $4, $5) AS r",
        params: [o.sessionHash, id, action, action === "withdraw" ? reason : null, Buffer.from(digest, "hex")],
      };
    },
    okMessage: (r) => `Recorded: the case is now ${r.status ?? "updated"}.`,
  });
}

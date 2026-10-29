import type { NextRequest } from "next/server";
import { complianceRoute, text } from "@/lib/server/compliance-route";

/** Maker: ask to return one credit in suspense to its payer (admin.request_suspense_return, migration 0038); a checker decides. */
export async function POST(request: NextRequest) {
  return complianceRoute(request, {
    permission: "operations.request",
    back: "/operations/bank",
    build: (o, form) => {
      const ref = form?.get("ref");
      const reason = text(form, "reason", 300);
      if (typeof ref !== "string" || !/^[A-Z0-9][A-Z0-9-]{3,63}$/.test(ref)) return "Choose a credit.";
      if (!reason || reason.length < 10) return "Give a reason of at least 10 characters.";
      return { sql: "SELECT admin.request_suspense_return($1, $2, $3) AS r", params: [o.sessionHash, ref, reason] };
    },
    okMessage: (r) => `Return #${String(r.id ?? "")} requested: an operations checker decides it.`,
  });
}

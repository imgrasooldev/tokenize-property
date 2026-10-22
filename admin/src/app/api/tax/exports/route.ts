import type { NextRequest } from "next/server";
import { complianceRoute, text } from "@/lib/server/compliance-route";
import { PERIOD, TOKEN } from "@/lib/server/operations-route";

/**
 * Tax officer 1: requests an FBR filing export for a token (or all) and a range of periods
 * (admin.request_tax_export -> tax.request_export: step-up, reason). A different tax officer
 * approves it before anything containing a CNIC can be generated (ADR 0014).
 */
export async function POST(request: NextRequest) {
  return complianceRoute(request, {
    permission: "tax.export",
    back: "/tax/exports",
    build: (o, form) => {
      const raw = form?.get("token");
      const token = typeof raw === "string" ? raw.trim().toLowerCase() : "";
      const from = form?.get("from");
      const to = form?.get("to");
      const reason = text(form, "reason", 500);
      if (token !== "" && !TOKEN.test(token)) return "Token: a lower-case address, or empty for every token.";
      if (typeof from !== "string" || typeof to !== "string" || !PERIOD.test(from) || !PERIOD.test(to) || from > to) return "Give the periods (YYYY-MM), from before to.";
      if (!reason || reason.length < 10) return "Give the purpose of the filing (at least 10 characters).";
      return { sql: "SELECT admin.request_tax_export($1, $2, $3, $4, $5) AS r", params: [o.sessionHash, token || null, from, to, reason] };
    },
    okPath: (r) => `/tax/exports/${String(r.id ?? "")}`,
    okMessage: () => "Requested: a different tax officer approves it.",
  });
}

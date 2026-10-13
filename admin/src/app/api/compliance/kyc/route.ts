import type { NextRequest } from "next/server";
import { complianceRoute, text, UUID } from "@/lib/server/compliance-route";

/** Opens a manual KYC review case (admin.open_kyc_case -> compliance.open_kyc_case). No step-up: it decides nothing. */
export async function POST(request: NextRequest) {
  return complianceRoute(request, {
    permission: "compliance.decide",
    back: "/compliance/kyc",
    build: (o, form) => {
      const subject = text(form, "subject", 36);
      const risk = form?.get("risk");
      const summary = text(form, "summary", 500);
      if (!subject || !UUID.test(subject)) return "Choose the investor from a case or the screening list.";
      if (risk !== "standard" && risk !== "high") return "Choose the risk.";
      if (!summary || summary.length < 10) return "Give a summary of at least 10 characters.";
      return { sql: "SELECT admin.open_kyc_case($1, $2, $3, $4) AS r", params: [o.sessionHash, subject, risk, summary] };
    },
    okPath: (r) => `/compliance/kyc/${String(r.id)}`,
    okMessage: () => "Case opened.",
  });
}

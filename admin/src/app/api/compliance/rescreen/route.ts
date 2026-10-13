import type { NextRequest } from "next/server";
import { complianceRoute, text, UUID } from "@/lib/server/compliance-route";

/** Queues a sanctions/PEP re-screening; the KYC service executes it (it alone can unseal a name). */
export async function POST(request: NextRequest) {
  return complianceRoute(request, {
    permission: "compliance.decide",
    back: "/compliance/screening",
    build: (o, form) => {
      const subject = text(form, "subject", 36);
      const reason = text(form, "reason", 500);
      if (!subject || !UUID.test(subject)) return "Choose the investor from the screening list.";
      if (!reason || reason.length < 10) return "Give a reason of at least 10 characters.";
      return { sql: "SELECT admin.request_rescreen($1, $2, $3) AS r", params: [o.sessionHash, subject, reason] };
    },
    okMessage: () => "Re-screening queued: the KYC service runs it against the current lists.",
  });
}

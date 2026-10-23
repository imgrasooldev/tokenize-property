import type { NextRequest } from "next/server";
import { complianceRoute, text, UUID } from "@/lib/server/compliance-route";

/**
 * Any transfer reader (TR-SOD-2): the signed-in officer declares a conflict with an investor; from
 * then on the officer cannot decide a case of that investor (admin.transfer_declare_conflict: step-up).
 */
export async function POST(request: NextRequest) {
  return complianceRoute(request, {
    permission: "transfer.read",
    back: "/transfers",
    build: (o, form) => {
      const subject = text(form, "subject", 36)?.toLowerCase() ?? null;
      const reason = text(form, "reason", 500);
      if (!subject || !UUID.test(subject)) return "Give the investor's reference (KYC subject id).";
      if (!reason || reason.length < 10) return "Give a reason of at least 10 characters.";
      return { sql: "SELECT admin.transfer_declare_conflict($1, $2, $3) AS r", params: [o.sessionHash, subject, reason] };
    },
    okMessage: () => "Conflict declared: you will not decide this investor's transfers.",
  });
}

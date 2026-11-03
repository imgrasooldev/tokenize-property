import type { NextRequest } from "next/server";
import { complianceRoute, text, UUID } from "@/lib/server/compliance-route";

/** Only back to a monitoring page. */
function backPath(form: FormData | undefined): string {
  const b = form?.get("back");
  return typeof b === "string" && /^\/compliance\/monitoring\/[1-9]\d{0,17}$/.test(b) ? b : "/compliance/monitoring";
}

/** An investor's declared annual income (migration 0051 TM-2): compliance officer, step-up; the rules run again for that investor. */
export async function POST(request: NextRequest) {
  return complianceRoute(request, {
    permission: "compliance.decide",
    back: backPath,
    build: (o, form) => {
      const subject = text(form, "subject", 36);
      const rupees = text(form, "rupees", 20)?.replace(/,/g, "") ?? null;
      const reason = text(form, "reason", 500);
      if (!subject || !UUID.test(subject)) return "Unknown investor.";
      if (!rupees || !/^[1-9]\d{0,11}$/.test(rupees)) return "Give the annual income in whole rupees.";
      if (!reason || reason.length < 10) return "Give a reason of at least 10 characters.";
      return { sql: "SELECT admin.tm_set_income($1, $2, $3, $4) AS r", params: [o.sessionHash, subject, `${rupees}00`, reason] };
    },
    okMessage: (r) => `Declared income recorded${r.opened ? `; ${String(r.opened)} new alert(s)` : ""}.`,
  });
}

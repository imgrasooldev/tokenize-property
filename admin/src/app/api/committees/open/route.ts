import type { NextRequest } from "next/server";
import { complianceRoute, text, UUID } from "@/lib/server/compliance-route";

/**
 * A committee member opens an investment-committee meeting for a property and chairs it
 * (admin.open_committee -> property.open_ic under the officer's handle: duty, OB-SOD-1, P7 readiness).
 */
export async function POST(request: NextRequest) {
  return complianceRoute(request, {
    permission: "committee.vote",
    back: "/committees",
    build: (o, form) => {
      const property = form?.get("property");
      const reason = text(form, "reason", 500);
      if (form?.get("decision") !== "open") return "Choose to open the meeting.";
      if (typeof property !== "string" || !UUID.test(property)) return "Unknown property.";
      if (!reason || reason.length < 10) return "Give a reason of at least 10 characters.";
      return { sql: "SELECT admin.open_committee($1, $2, $3) AS r", params: [o.sessionHash, property, reason] };
    },
    okPath: (r) => (typeof r.meeting === "number" ? `/committees/${String(r.meeting)}` : "/committees"),
    okMessage: () => "Meeting opened: you chair it.",
  });
}

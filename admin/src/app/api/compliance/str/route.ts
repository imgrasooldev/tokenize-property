import type { NextRequest } from "next/server";
import { complianceRoute, text, UUID } from "@/lib/server/compliance-route";

const CODE = /^[a-z][a-z_]{2,39}$/;

/** Opens a suspicious transaction report case (admin.open_str). Never visible to operations or the investor. */
export async function POST(request: NextRequest) {
  return complianceRoute(request, {
    permission: "compliance.decide",
    back: "/compliance/str",
    build: (o, form) => {
      const subject = text(form, "subject", 36);
      const category = text(form, "category", 40);
      const summary = text(form, "summary", 2000);
      if (subject && !UUID.test(subject)) return "Unknown investor reference.";
      if (!category || !CODE.test(category)) return "Choose a category.";
      if (!summary || summary.length < 20) return "Give a summary of at least 20 characters.";
      return { sql: "SELECT admin.open_str($1, $2, $3, $4) AS r", params: [o.sessionHash, subject, category, summary] };
    },
    okPath: (r) => `/compliance/str/${String(r.id)}`,
    okMessage: () => "STR case opened.",
  });
}

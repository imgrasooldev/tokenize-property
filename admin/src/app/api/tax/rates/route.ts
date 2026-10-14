import type { NextRequest } from "next/server";
import { complianceRoute, text } from "@/lib/server/compliance-route";
import { DATE, ppmOf } from "@/lib/server/operations-route";
import { INCOME_STATUSES } from "@/lib/server/operations";

/**
 * Tax officer: proposes a new version of a withholding rate (admin.propose_tax_rate ->
 * tax.propose_rate: step-up, effective today or later, never retroactive). A different tax officer
 * approves it (maker-checker). Rates are configuration in the database, never code.
 */
export async function POST(request: NextRequest) {
  return complianceRoute(request, {
    permission: "tax.decide",
    back: "/tax",
    build: (o, form) => {
      const incomeType = text(form, "incomeType", 32);
      const status = form?.get("status");
      const ppm = ppmOf(form?.get("rate"));
      const from = form?.get("effectiveFrom");
      const basis = text(form, "basis", 300);
      if (!incomeType || !/^[a-z][a-z_]{2,31}$/.test(incomeType)) return "Choose the income type.";
      if (typeof status !== "string" || !(INCOME_STATUSES as readonly string[]).includes(status)) return "Choose filer, non-filer or exempt.";
      if (ppm === null || ppm >= 1_000_000) return "Give the rate in percent (e.g. 15 or 12.5), below 100.";
      if (typeof from !== "string" || !DATE.test(from)) return "Give the effective date (YYYY-MM-DD).";
      if (!basis || basis.length < 10) return "Give the legal basis (section, Finance Act), at least 10 characters.";
      return { sql: "SELECT admin.propose_tax_rate($1, $2, $3, $4, $5::date, $6) AS r", params: [o.sessionHash, incomeType, status, ppm, from, basis] };
    },
    okMessage: () => "Proposed: a different tax officer approves it.",
  });
}

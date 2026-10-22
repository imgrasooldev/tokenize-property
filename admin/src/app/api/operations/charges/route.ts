import type { NextRequest } from "next/server";
import { complianceRoute, text } from "@/lib/server/compliance-route";
import { evidenceOf, paisaOf, PERIOD, TOKEN } from "@/lib/server/operations-route";
import { CHARGE_KINDS, FEE_TYPES } from "@/lib/server/operations";

/**
 * Maker: proposes an expense, fee or reserve movement for a period (admin.propose_charge ->
 * ops.propose_charge). The evidence (vendor invoice, fee calculation) is hashed here and only its
 * SHA-256 is stored; the file itself is not kept. An operations checker decides it.
 */
export async function POST(request: NextRequest) {
  const form = await request.clone().formData().catch(() => undefined);
  const evidence = await evidenceOf(form);
  const rawToken = form?.get("token");
  const rawPeriod = form?.get("period");
  const token = typeof rawToken === "string" ? rawToken.trim().toLowerCase() : "";
  const period = typeof rawPeriod === "string" ? rawPeriod.trim() : "";
  const back = TOKEN.test(token) && PERIOD.test(period) ? `/operations?token=${token}&period=${period}` : "/operations";
  return complianceRoute(request, {
    permission: "operations.request",
    back,
    build: (o, f) => {
      const kind = f?.get("kind");
      const feeType = f?.get("feeType");
      const payee = text(f, "payee", 40);
      const description = text(f, "description", 300);
      const amount = paisaOf(f?.get("amount"));
      if (!TOKEN.test(token) || !PERIOD.test(period)) return "Choose the token and the period (YYYY-MM).";
      if (typeof kind !== "string" || !(CHARGE_KINDS as readonly string[]).includes(kind)) return "Choose what kind of charge this is.";
      if (kind === "fee" && (typeof feeType !== "string" || !(FEE_TYPES as readonly string[]).includes(feeType))) return "Choose the fee type.";
      if ((kind === "expense" || kind === "fee") && (!payee || !/^[a-z0-9][a-z0-9_-]{1,39}$/.test(payee))) return "Give the payee reference (lower-case letters, digits, - or _).";
      if (!description || description.length < 5) return "Describe the charge (at least 5 characters).";
      if (!amount) return "Give the amount in rupees (up to two decimals).";
      if (!evidence) return "Attach the evidence (invoice or calculation) or paste its SHA-256.";
      return {
        sql: "SELECT admin.propose_charge($1, $2, $3, $4, $5, $6, $7, $8, $9) AS r",
        params: [o.sessionHash, token, period, kind, kind === "fee" ? feeType : null, kind === "expense" || kind === "fee" ? payee : null, description, amount, evidence],
      };
    },
    okPath: (r) => `/operations/charges/${String(r.id ?? "")}`,
    okMessage: () => "Proposed: an operations checker decides it.",
  });
}

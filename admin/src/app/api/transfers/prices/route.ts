import type { NextRequest } from "next/server";
import { complianceRoute, HEX32, text } from "@/lib/server/compliance-route";

const PAISA = /^[1-9]\d{0,12}$/;
const TOKEN = /^0x[0-9a-f]{40}$/;

/**
 * Operations checker: records a reference price per unit with the valuation's SHA-256 (16.3; the
 * price band of every later sale is measured against it) (admin.transfer_set_price: step-up).
 */
export async function POST(request: NextRequest) {
  return complianceRoute(request, {
    permission: "transfer.price",
    back: "/transfers",
    build: (o, form) => {
      const token = text(form, "token", 42)?.toLowerCase() ?? null;
      const price = text(form, "price", 13);
      const evidence = text(form, "evidence", 64)?.toLowerCase() ?? null;
      const reason = text(form, "reason", 500);
      if (!token || !TOKEN.test(token)) return "Give the token address.";
      if (!price || !PAISA.test(price)) return "Give the price per unit in paisa.";
      if (!evidence || !HEX32.test(evidence)) return "Give the SHA-256 of the valuation (64 hex digits).";
      if (!reason || reason.length < 10) return "Give a reason of at least 10 characters.";
      return { sql: "SELECT admin.transfer_set_price($1, $2, $3, $4, $5) AS r", params: [o.sessionHash, token, price, evidence, reason] };
    },
    okMessage: () => "Reference price recorded.",
  });
}

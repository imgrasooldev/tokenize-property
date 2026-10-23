import type { NextRequest } from "next/server";
import { complianceRoute, HEX32, text, UUID } from "@/lib/server/compliance-route";

const CONSIDERATIONS = new Set(["sale", "gift", "family", "court_order"]);
const PAISA = /^[1-9]\d{0,14}$/;
const UNITS = /^[1-9]\d{0,12}$/;
const TOKEN = /^0x[0-9a-f]{40}$/;

/**
 * Transfer desk (operations maker): opens a case for two investors named by their KYC subject id
 * (admin.transfer_open: step-up; the database checks the parties' wallets, the token named by the
 * signing policy and the terms, and alerts the seller's contacts of record).
 */
export async function POST(request: NextRequest) {
  return complianceRoute(request, {
    permission: "transfer.request",
    back: "/transfers",
    build: (o, form) => {
      const seller = text(form, "seller", 36)?.toLowerCase() ?? null;
      const buyer = text(form, "buyer", 36)?.toLowerCase() ?? null;
      const token = text(form, "token", 42)?.toLowerCase() ?? null;
      const units = text(form, "units", 13);
      const consideration = form?.get("consideration");
      const price = text(form, "price", 15);
      const noPriceReason = text(form, "noPriceReason", 500);
      const agreement = text(form, "agreement", 64)?.toLowerCase() ?? null;
      const explanation = text(form, "explanation", 1000);
      const holdingReason = text(form, "holdingReason", 500);
      if (!seller || !UUID.test(seller)) return "Give the seller's reference (KYC subject id).";
      if (!buyer || !UUID.test(buyer)) return "Give the buyer's reference (KYC subject id).";
      if (seller === buyer) return "Seller and buyer are two different investors.";
      if (!token || !TOKEN.test(token)) return "Give the token address.";
      if (!units || !UNITS.test(units)) return "Give the number of units (a whole number).";
      if (typeof consideration !== "string" || !CONSIDERATIONS.has(consideration)) return "Choose the consideration.";
      const sale = consideration === "sale";
      if (sale && (!price || !PAISA.test(price))) return "A sale needs a price per unit in paisa.";
      if (!sale && (!noPriceReason || noPriceReason.length < 10)) return "A transfer without consideration needs a reason of at least 10 characters.";
      if (!agreement || !HEX32.test(agreement)) return "Give the SHA-256 of the signed agreement or court order (64 hex digits).";
      if (explanation !== null && explanation.length < 10) return "A price explanation has at least 10 characters.";
      if (holdingReason !== null && holdingReason.length < 10) return "A minimum-holding reason has at least 10 characters.";
      return {
        sql: "SELECT admin.transfer_open($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) AS r",
        params: [o.sessionHash, seller, buyer, token, units, consideration, sale ? price : null, sale ? null : noPriceReason, agreement, explanation, holdingReason],
      };
    },
    okPath: (r) => `/transfers/${String(r.id)}`,
    okMessage: () => "Transfer case opened.",
  });
}

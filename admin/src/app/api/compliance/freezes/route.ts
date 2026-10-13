import type { NextRequest } from "next/server";
import { complianceRoute, ID, text } from "@/lib/server/compliance-route";

const WALLET = /^0x[0-9a-fA-F]{40}$/;
const CODE = /^[a-z][a-z_]{2,39}$/;

/** Maker: proposes a freeze or unfreeze (admin.request_freeze: step-up; a second officer decides). */
export async function POST(request: NextRequest) {
  return complianceRoute(request, {
    permission: "compliance.decide",
    back: "/compliance/freezes",
    build: (o, form) => {
      const kind = form?.get("kind");
      const wallet = text(form, "wallet", 42);
      const code = text(form, "reasonCode", 40);
      const reason = text(form, "reason", 500);
      const kycCase = text(form, "kycCase", 18);
      const strCase = text(form, "strCase", 18);
      if (kind !== "freeze" && kind !== "unfreeze") return "Choose freeze or unfreeze.";
      if (!wallet || !WALLET.test(wallet)) return "Give the investor's wallet address (0x + 40 hex digits).";
      if (!code || !CODE.test(code)) return "Choose a reason code.";
      if (!reason || reason.length < 10) return "Give a reason of at least 10 characters.";
      if ((kycCase && !ID.test(kycCase)) || (strCase && !ID.test(strCase))) return "Case references are numbers.";
      return {
        sql: "SELECT admin.request_freeze($1, $2, $3, $4, $5, $6, $7) AS r",
        params: [o.sessionHash, kind, wallet, code, reason, kycCase, strCase],
      };
    },
    okPath: (r) => `/compliance/freezes/${String(r.id)}`,
    okMessage: () => "Proposed: a different compliance officer decides it.",
  });
}

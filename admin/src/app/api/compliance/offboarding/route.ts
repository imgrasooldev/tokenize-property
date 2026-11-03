import type { NextRequest } from "next/server";
import { complianceRoute, text } from "@/lib/server/compliance-route";

const WALLET = /^0x[0-9a-fA-F]{40}$/;

/** Maker: requests the deletion of an offboarded wallet's identity (admin.request_identity_deletion, migration 0055 OB-2). */
export async function POST(request: NextRequest) {
  return complianceRoute(request, {
    permission: "compliance.decide",
    back: "/compliance/offboarding",
    build: (o, form) => {
      const wallet = text(form, "wallet", 42);
      const reason = text(form, "reason", 500);
      if (!wallet || !WALLET.test(wallet)) return "Give the investor's wallet address (0x + 40 hex digits).";
      if (!reason || reason.length < 10) return "Give a reason of at least 10 characters.";
      return { sql: "SELECT admin.request_identity_deletion($1, $2, $3) AS r", params: [o.sessionHash, wallet, reason] };
    },
    okPath: (r) => `/compliance/offboarding/${String(r.id)}`,
    okMessage: () => "Requested: a different compliance officer decides it.",
  });
}

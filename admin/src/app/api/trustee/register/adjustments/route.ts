import type { NextRequest } from "next/server";
import { complianceRoute, HEX32, text } from "@/lib/server/compliance-route";
import { ADDRESS } from "@/lib/server/trustee";

const UNITS = /^-?[1-9][0-9]{0,12}$/;

/** A trustee officer proposes a register adjustment (admin.propose_register_adjustment); a different one decides. */
export async function POST(request: NextRequest) {
  return complianceRoute(request, {
    permission: "trustee.decide",
    back: "/trustee/register",
    build: (o, form) => {
      const token = text(form, "token", 42)?.toLowerCase() ?? null;
      const wallet = text(form, "wallet", 42)?.toLowerCase() ?? null;
      const units = text(form, "units", 14);
      const evidence = text(form, "evidence", 64)?.toLowerCase() ?? null;
      const reason = text(form, "reason", 500);
      if (!token || !ADDRESS.test(token)) return "Choose a token.";
      if (!wallet || !ADDRESS.test(wallet)) return "Give the wallet address (0x and 40 hex characters).";
      if (!units || !UNITS.test(units)) return "Give the units as a non-zero whole number (negative removes units).";
      if (!evidence || !HEX32.test(evidence)) return "Give the SHA-256 of the evidence (64 hex characters).";
      if (!reason || reason.length < 10) return "Give a reason of at least 10 characters.";
      return { sql: "SELECT admin.propose_register_adjustment($1, $2, $3, $4, $5, $6) AS r", params: [o.sessionHash, token, wallet, units, evidence, reason] };
    },
    okPath: (r) => `/trustee/register/adjustments/${String(r.id)}`,
    okMessage: () => "Adjustment proposed: a different trustee officer decides within 72 hours.",
  });
}

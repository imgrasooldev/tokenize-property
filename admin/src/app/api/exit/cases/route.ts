import type { NextRequest } from "next/server";
import { EXIT_ADDRESS, EXIT_HEX32, paisaFromRupees } from "@/lib/exit";
import { complianceRoute, text } from "@/lib/server/compliance-route";

/**
 * Maker (operations): opens an exit case for a token (admin.exit_request 'open': step-up, the
 * officer's handle bound; the database checks the token, the two different valuations and that no
 * other exit case is live).
 */
export async function POST(request: NextRequest) {
  return complianceRoute(request, {
    permission: "exit.request",
    back: "/exit",
    build: (o, form) => {
      const token = text(form, "token", 42)?.toLowerCase() ?? null;
      const rationale = text(form, "rationale", 2000);
      const offer = paisaFromRupees(text(form, "offer", 40));
      const valA = paisaFromRupees(text(form, "valuationA", 40));
      const valB = paisaFromRupees(text(form, "valuationB", 40));
      const costs = paisaFromRupees(text(form, "costs", 40));
      const shaA = text(form, "valuationASha", 64)?.toLowerCase() ?? null;
      const shaB = text(form, "valuationBSha", 64)?.toLowerCase() ?? null;
      const vote = form?.get("voteRequired");
      if (!token || !EXIT_ADDRESS.test(token)) return "Give the token address.";
      if (!rationale || rationale.length < 20) return "Give a rationale of at least 20 characters.";
      if (!offer || offer === "0" || !valA || valA === "0" || !valB || valB === "0") return "Give the offer and both valuations in PKR.";
      if (costs === null) return "Give the estimated costs in PKR (may be 0).";
      if (!shaA || !EXIT_HEX32.test(shaA) || !shaB || !EXIT_HEX32.test(shaB)) return "Give the SHA-256 of both valuation reports (64 hex digits).";
      if (vote !== "true" && vote !== "false") return "Say whether the unit rights require an investor vote.";
      const args = { token, offerPaisa: offer, valuationAPaisa: valA, valuationASha: shaA, valuationBPaisa: valB, valuationBSha: shaB, costsPaisa: costs, voteRequired: vote === "true" };
      return { sql: "SELECT admin.exit_request($1, NULL, 'open', $2::jsonb, $3) AS r", params: [o.sessionHash, JSON.stringify(args), rationale] };
    },
    okPath: (r) => `/exit/${String(r.id)}`,
    okMessage: () => "Exit case opened.",
  });
}

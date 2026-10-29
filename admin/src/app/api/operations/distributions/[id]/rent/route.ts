import type { NextRequest } from "next/server";
import { complianceRoute, ID } from "@/lib/server/compliance-route";

/**
 * Maker: the next on-chain step of an approved distribution (admin.rent_step, migration 0033):
 * publish (ops.request_publish -> outbox -> signer), finalize after the 48-hour window
 * (ops.request_finalize) or book the finalized distribution (ops.book_distribution). The database
 * finds the on-chain distribution from the calculation and applies every rule; step-up required.
 */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const valid = ID.test(id);
  return complianceRoute(request, {
    permission: "operations.request",
    back: valid ? `/operations/distributions/${id}` : "/operations",
    build: (o, form) => {
      if (!valid) return "Unknown distribution.";
      const step = form?.get("step");
      if (step !== "publish" && step !== "finalize" && step !== "book") return "Choose publish, finalize or book.";
      return { sql: "SELECT admin.rent_step($1, $2, $3) AS r", params: [o.sessionHash, id, step] };
    },
    okMessage: (r) =>
      r.status === "booked"
        ? "Booked: withholding and net journals posted."
        : `${r.status === "finalize requested" ? "Finalize" : "Publication"} requested: the signing service sends it; the page updates once the chain confirms.`,
  });
}

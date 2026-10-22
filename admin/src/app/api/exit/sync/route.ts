import type { NextRequest } from "next/server";
import { complianceRoute } from "@/lib/server/compliance-route";

/**
 * "Refresh from chain" (admin.exit_sync -> exit.tick): publishes, rejections and finalization of the
 * final distribution seen in the read model, burns enqueued as lines become eligible, burns seen,
 * supply zero and the payout recorded. Idempotent and deterministic from the read model, the bank
 * and the outbox; normally run by the exit service (npm run exit:tick -- --loop).
 */
export async function POST(request: NextRequest) {
  return complianceRoute(request, {
    permission: "exit.request",
    back: "/exit",
    build: (o, form) => (form?.get("decision") === "sync" ? { sql: "SELECT admin.exit_sync($1) AS r", params: [o.sessionHash] } : "Nothing to do."),
    okMessage: (r) => `Refreshed from the chain: ${r.status ?? "done"}.`,
  });
}

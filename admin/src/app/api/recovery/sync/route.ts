import type { NextRequest } from "next/server";
import { complianceRoute } from "@/lib/server/compliance-route";

/**
 * "Refresh from chain" (admin.recovery_sync -> recovery.tick): links proposals to their on-chain
 * requests, enqueues execute after the delay and cancel for cancelled cases, follows executions.
 * Idempotent and deterministic from the read model and the outbox; normally run by recovery:tick.
 */
export async function POST(request: NextRequest) {
  return complianceRoute(request, {
    permission: "recovery.request",
    back: "/recovery",
    build: (o, form) => (form?.get("decision") === "sync" ? { sql: "SELECT admin.recovery_sync($1) AS r", params: [o.sessionHash] } : "Nothing to do."),
    okMessage: (r) => `Refreshed from the chain: ${r.status ?? "done"}.`,
  });
}

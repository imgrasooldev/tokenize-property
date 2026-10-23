import type { NextRequest } from "next/server";
import { complianceRoute } from "@/lib/server/compliance-route";

/**
 * "Refresh from chain" (admin.transfer_sync -> transfer.tick): books payments into escrow, links
 * proposals to their on-chain requests, enqueues executions after the delay and cancellations,
 * follows executions. Idempotent; normally run by transfer:tick.
 */
export async function POST(request: NextRequest) {
  return complianceRoute(request, {
    permission: "transfer.request",
    back: "/transfers",
    build: (o, form) => (form?.get("decision") === "sync" ? { sql: "SELECT admin.transfer_sync($1) AS r", params: [o.sessionHash] } : "Nothing to do."),
    okMessage: (r) => `Refreshed from the bank and the chain: ${r.status ?? "done"}.`,
  });
}

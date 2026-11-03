import type { NextRequest } from "next/server";
import { complianceRoute } from "@/lib/server/compliance-route";

/** Runs the monitoring rules for every investor now (migration 0051 TM-3; it only opens alerts). */
export async function POST(request: NextRequest) {
  return complianceRoute(request, {
    permission: "compliance.decide",
    back: "/compliance/monitoring",
    build: (o) => ({ sql: "SELECT admin.tm_sweep($1) AS r", params: [o.sessionHash] }),
    okMessage: (r) => `Every investor checked: ${String(r.opened ?? 0)} new alert(s).`,
  });
}

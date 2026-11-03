import type { NextRequest } from "next/server";
import { complianceRoute } from "@/lib/server/compliance-route";

/** "Check now" on /health (migration 0052): evaluates the alerts against the current checks. */
export async function POST(request: NextRequest) {
  return complianceRoute(request, {
    permission: "ops.read",
    back: "/health",
    build: (o) => ({ sql: "SELECT admin.health_refresh($1) AS r", params: [o.sessionHash] }),
    okMessage: (r) => `Checked: ${String(r.opened ?? 0)} alert change(s).`,
  });
}

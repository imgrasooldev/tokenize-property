import type { NextRequest } from "next/server";
import { decideRoute } from "@/lib/server/decide-route";

/** Checker decision on an unfreeze request: admin.decide_unfreeze -> recon.decide_unfreeze (passed run, maker-checker). */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return decideRoute(request, id, {
    permission: "approvals.decide",
    idPattern: /^[1-9]\d{0,17}$/,
    page: (x) => `/approvals/unfreeze/${x}`,
    reviewed: { field: "freezeEvent", pattern: /^[1-9]\d{0,17}$/ },
    sql: "SELECT admin.decide_unfreeze($1, $2, $3, $4, $5) AS r",
    params: (o, x, choice, reason, freezeEvent) => [o.sessionHash, x, choice, reason, freezeEvent],
  });
}

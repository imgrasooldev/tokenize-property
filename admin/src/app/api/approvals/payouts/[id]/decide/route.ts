import type { NextRequest } from "next/server";
import { decideRoute } from "@/lib/server/decide-route";

/** Checker decision on a payout batch: admin.decide_payout_batch -> bank.decide_payout_batch (gate, maker-checker). */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return decideRoute(request, id, {
    permission: "approvals.decide",
    idPattern: /^[1-9]\d{0,17}$/,
    page: (x) => `/approvals/payouts/${x}`,
    reviewed: { field: "itemsDigest", pattern: /^[0-9a-f]{64}$/ },
    sql: "SELECT admin.decide_payout_batch($1, $2, $3, $4, $5) AS r",
    params: (o, x, choice, reason, digest) => [o.sessionHash, x, choice, reason, Buffer.from(digest, "hex")],
  });
}

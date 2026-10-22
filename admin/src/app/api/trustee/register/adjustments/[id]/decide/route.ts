import type { NextRequest } from "next/server";
import { decideRoute } from "@/lib/server/decide-route";

/** Second trustee officer: approves or rejects a register adjustment (admin.decide_register_adjustment, four eyes, digest). */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return decideRoute(request, id, {
    permission: "trustee.decide",
    idPattern: /^[1-9]\d{0,17}$/,
    page: (x) => `/trustee/register/adjustments/${x}`,
    reviewed: { field: "digest", pattern: /^[0-9a-f]{64}$/ },
    sql: "SELECT admin.decide_register_adjustment($1, $2, $3, $4, $5) AS r",
    params: (o, x, choice, reason, digest) => [o.sessionHash, x, choice, reason, Buffer.from(digest, "hex")],
  });
}

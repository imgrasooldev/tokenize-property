import type { NextRequest } from "next/server";
import { decideRoute } from "@/lib/server/decide-route";

/** Checker decision on an S-01 request: admin.decide_property_request -> property.decide_request (duties, SoD, guards). */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return decideRoute(request, id, {
    permission: "property.decide",
    idPattern: /^[1-9]\d{0,17}$/,
    page: (x) => `/approvals/property/${x}`,
    reviewed: { field: "digest", pattern: /^[0-9a-f]{64}$/ },
    sql: "SELECT admin.decide_property_request($1, $2, $3, $4, $5) AS r",
    params: (o, x, choice, reason, digest) => [o.sessionHash, x, choice, reason, Buffer.from(digest, "hex")],
  });
}

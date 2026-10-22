import type { NextRequest } from "next/server";
import { decideRoute } from "@/lib/server/decide-route";

/**
 * Platform vote on an S-02 request (admin.vote_offering_request -> offering.decide under the
 * officer's handle: duties, maker-checker, OF-SOD-1/2, guards), bound to the request digest.
 */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return decideRoute(request, id, {
    permission: "offering.decide",
    idPattern: /^[1-9]\d{0,17}$/,
    page: (x) => `/approvals/offering/${x}`,
    reviewed: { field: "digest", pattern: /^[0-9a-f]{64}$/ },
    sql: "SELECT admin.vote_offering_request($1, $2, $3, $4, $5) AS r",
    params: (o, x, choice, reason, digest) => [o.sessionHash, x, choice, reason, Buffer.from(digest, "hex")],
  });
}

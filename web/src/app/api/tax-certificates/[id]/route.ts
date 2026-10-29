import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { currentSession } from "@/lib/server/session";
import { certificate } from "@/lib/server/tax-certificates";

/**
 * Download of the signed-in investor's tax certificate as the exact JSON that was hashed when it
 * was issued (migration 0035 TC-2); the SHA-256 travels in a header and is checked here before
 * sending. Another investor's id, or no session, reads as not found.
 */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = await currentSession();
  if (!session) return new NextResponse("Not found", { status: 404 });
  const c = await certificate(session.hash, id);
  if (!c) return new NextResponse("Not found", { status: 404 });
  const sha = createHash("sha256").update(c.contentText, "utf8").digest("hex");
  if (sha !== c.sha256) return new NextResponse("The certificate does not match its recorded hash", { status: 500 });
  return new NextResponse(c.contentText, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="tax-certificate-FY${String(c.fiscalYear)}-${String(c.id)}.json"`,
      "cache-control": "no-store",
      "x-content-sha256": sha,
    },
  });
}

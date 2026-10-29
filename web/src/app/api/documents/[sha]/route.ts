import { NextResponse } from "next/server";
import { logError } from "@/lib/server/log";
import { clientKey, take } from "@/lib/server/rate-limit";
import { publicDocument } from "@/lib/server/services";

/**
 * Download of a published offering or property document by its SHA-256 (T-038): the document vault
 * decides what is published, the bytes are checked against the hash here too, and the file is sent
 * as an attachment (never rendered inline on this origin). Anything else is not found.
 */
const EXT: Record<string, string> = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png", "image/tiff": "tif" };

export async function GET(_request: Request, ctx: { params: Promise<{ sha: string }> }) {
  const { sha } = await ctx.params;
  if (!/^[0-9a-f]{64}$/.test(sha)) return new NextResponse("Not found", { status: 404 });
  if (!take("publicVerify", await clientKey())) return new NextResponse("Too many requests", { status: 429 });
  try {
    const doc = await publicDocument(sha);
    if (!doc) return new NextResponse("Not found", { status: 404 });
    const ext = new Map(Object.entries(EXT)).get(doc.media) ?? "bin";
    return new NextResponse(new Uint8Array(doc.bytes), {
      headers: {
        "content-type": doc.media,
        "content-disposition": `attachment; filename="document-${sha.slice(0, 12)}.${ext}"`,
        "x-content-sha256": sha,
        "x-content-type-options": "nosniff",
        "cache-control": "public, max-age=3600, immutable",
      },
    });
  } catch (e) {
    logError("document download", e);
    return new NextResponse("The document service is not available right now", { status: 503 });
  }
}

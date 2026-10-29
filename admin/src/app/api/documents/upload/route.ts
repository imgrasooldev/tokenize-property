import type { NextRequest } from "next/server";
import { officerMessage, pgCode } from "@/lib/server/db";
import { seeOther } from "@/lib/server/http";
import { requireApi } from "@/lib/server/session";
import { storeInVault } from "@/lib/server/vault";

/**
 * Maker: store one document in the encrypted vault (ADR 0017, migration 0042). The upload is
 * audited first (admin.vault_upload, step-up); the portal then sends the file once to the vault
 * service and keeps nothing.
 */
const MEDIA = new Map([
  ["application/pdf", "application/pdf"],
  ["image/jpeg", "image/jpeg"],
  ["image/png", "image/png"],
  ["image/tiff", "image/tiff"],
]);

export async function POST(request: NextRequest) {
  const form = await request.formData().catch(() => undefined);
  const officer = await requireApi(request, "operations.request", form);
  if (!("sessionHash" in officer)) return officer;
  const back = (key: "ok" | "error", msg: string) => seeOther(`/documents?${key}=${encodeURIComponent(msg.slice(0, 300))}`);
  const file = form?.get("document");
  if (!(file instanceof File) || file.size === 0) return back("error", "Choose a document.");
  if (file.size > 25 * 1024 * 1024) return back("error", "A document is at most 25 MB here.");
  const media = MEDIA.get(file.type);
  if (!media) return back("error", "Only PDF, JPEG, PNG or TIFF documents are stored.");
  try {
    const r = await storeInVault(officer.sessionHash, Buffer.from(await file.arrayBuffer()), media);
    return r.ok ? back("ok", `Stored: ${r.storeRef}`) : back("error", r.error);
  } catch (e) {
    if (pgCode(e) === "PTS01") return back("error", "Confirm with your security key first (step-up).");
    const msg = officerMessage(e);
    if (msg) return back("error", msg);
    throw e;
  }
}

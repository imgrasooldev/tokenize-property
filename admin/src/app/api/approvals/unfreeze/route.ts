import type { NextRequest } from "next/server";
import { decision } from "@/lib/server/approvals";
import { officerMessage } from "@/lib/server/db";
import { seeOther } from "@/lib/server/http";
import { requireApi } from "@/lib/server/session";

/** Maker: ask for payouts to be unfrozen (admin.request_unfreeze -> recon.request_unfreeze); a checker decides. */
export async function POST(request: NextRequest) {
  const form = await request.formData().catch(() => undefined);
  const officer = await requireApi(request, "approvals.request", form);
  if (!("sessionHash" in officer)) return officer;
  const reason = form?.get("reason");
  if (typeof reason !== "string" || reason.trim().length < 10 || reason.length > 500) {
    return seeOther(`/approvals?error=${encodeURIComponent("Give a reason of at least 10 characters.")}`);
  }
  try {
    const r = await decision("SELECT admin.request_unfreeze($1, $2) AS r", [officer.sessionHash, reason.trim()]);
    if (!r.ok) return seeOther(`/approvals?error=${encodeURIComponent(r.error ?? "refused")}`);
    return seeOther(`/approvals/unfreeze/${String(r.id)}?ok=${encodeURIComponent("Unfreeze requested: an operations checker decides it.")}`);
  } catch (e) {
    const msg = officerMessage(e);
    if (msg) return seeOther(`/approvals?error=${encodeURIComponent(msg)}`);
    throw e;
  }
}

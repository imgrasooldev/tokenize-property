import type { NextRequest } from "next/server";
import { decision } from "@/lib/server/approvals";
import { officerMessage, pgCode } from "@/lib/server/db";
import { seeOther } from "@/lib/server/http";
import { deny, hashToken, newToken, requireApi } from "@/lib/server/session";
import { signerConfigured, signerDecide } from "@/lib/server/signer";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;

/**
 * Checker decision on a signing request (Step 6b). The portal never decides: (1) the database
 * checks session, approvals.decide, a step-up younger than five minutes, that the request is still
 * what the officer reviewed and that this officer may decide it, and issues a one-time ticket (only
 * its hash is stored); (2) the signing service, called with the portal's preview-and-decide client,
 * recomputes the call, redeems the ticket and runs its maker-checker decision in one transaction.
 */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const form = await request.formData().catch(() => undefined);
  const officer = await requireApi(request, "approvals.decide", form);
  if (!("sessionHash" in officer)) return officer;
  if (!UUID.test(id)) return deny(400, "bad request id");
  const back = (key: "ok" | "error", msg: string) => seeOther(`/approvals/signer/${id}?${key}=${encodeURIComponent(msg)}`);
  const choice = form?.get("decision");
  const reason = form?.get("reason");
  const payloadHash = form?.get("payloadHash");
  const callHash = form?.get("callHash");
  if ((choice !== "approve" && choice !== "reject") || typeof reason !== "string" || reason.trim().length < 10 || reason.length > 500) {
    return back("error", "Give a decision and a reason of at least 10 characters.");
  }
  if (typeof payloadHash !== "string" || !HASH.test(payloadHash) || typeof callHash !== "string" || !HASH.test(callHash)) {
    return back("error", "The exact call was not shown, so nothing can be decided. Reload the page.");
  }
  if (!signerConfigured()) return back("error", "The portal has no client for the signing service: nothing was decided.");
  const ticket = newToken();
  try {
    const issued = await decision("SELECT admin.issue_signer_ticket($1, $2, $3, $4, $5, $6, $7) AS r", [
      officer.sessionHash,
      id,
      choice,
      reason.trim(),
      Buffer.from(payloadHash, "hex"),
      Buffer.from(callHash, "hex"),
      hashToken(ticket),
    ]);
    if (!issued.ok) return back("error", issued.error ?? "refused");
  } catch (e) {
    if (pgCode(e) === "PTS01") return back("error", "Confirm with your security key first (step-up).");
    const msg = officerMessage(e);
    if (msg) return back("error", msg);
    throw e;
  }
  let out;
  try {
    out = await signerDecide({ requestId: id, decision: choice, reason: reason.trim(), ticket, callHash });
  } catch {
    return back("error", "The signing service could not be reached: nothing was decided (the ticket expires unused in 2 minutes).");
  }
  if (out.status === "refused") return back("error", `Refused by the signing service: ${out.reason ?? "?"}`);
  return back("ok", `Decision recorded by the signing service: request is now ${out.status}.`);
}

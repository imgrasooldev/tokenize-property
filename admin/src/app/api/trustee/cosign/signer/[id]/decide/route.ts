import type { NextRequest } from "next/server";
import { decision } from "@/lib/server/approvals";
import { officerMessage, pgCode } from "@/lib/server/db";
import { seeOther } from "@/lib/server/http";
import { deny, hashToken, newToken, requireApi } from "@/lib/server/session";
import { signerConfigured, signerDecide } from "@/lib/server/signer";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;

/**
 * Trustee co-signature on a signing request (Step 6d, the same two steps as 6b): (1) the database
 * checks session, trustee.decide, a step-up younger than five minutes, the payload the officer
 * reviewed and that this request needs the trustee, and issues a one-time ticket of capacity
 * "trustee"; (2) the signing service recomputes the call, refuses a changed one, redeems the
 * ticket and records the trustee approval in its maker-checker.
 */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const form = await request.formData().catch(() => undefined);
  const officer = await requireApi(request, "trustee.decide", form);
  if (!("sessionHash" in officer)) return officer;
  if (!UUID.test(id)) return deny(400, "bad request id");
  const back = (key: "ok" | "error", msg: string) => seeOther(`/trustee/cosign/signer/${id}?${key}=${encodeURIComponent(msg)}`);
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
    const issued = await decision("SELECT admin.issue_trustee_ticket($1, $2, $3, $4, $5, $6, $7) AS r", [
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
  return back("ok", `Trustee decision recorded by the signing service: request is now ${out.status}.`);
}

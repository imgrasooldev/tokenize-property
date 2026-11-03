import type { NextRequest } from "next/server";
import { decision } from "@/lib/server/approvals";
import { text } from "@/lib/server/compliance-route";
import { officerMessage, pgCode } from "@/lib/server/db";
import { seeOther } from "@/lib/server/http";
import { newTicket, sendAssisted } from "@/lib/server/payees";
import { requireApi } from "@/lib/server/session";

const REF = /^[0-9a-f]{8}$/;
const IBAN = /^PK[0-9]{2}[A-Z]{4}[0-9]{16}$/;

/**
 * Maker of an assisted payout-account change (migration 0055 AP-1, AP-2): the admin database
 * issues a one-time ticket (operations.request, step-up, a verified investor, no open request),
 * then the IBAN and the title go with it to the bank service, which stores a pending request. The
 * IBAN is never stored, logged or put in a redirect here.
 */
export async function POST(request: NextRequest) {
  const form = await request.formData().catch(() => undefined);
  const officer = await requireApi(request, "operations.request", form);
  if (!("sessionHash" in officer)) return officer;
  const back = (key: "ok" | "error", msg: string, path = "/operations/payees") => seeOther(`${path}?${key}=${encodeURIComponent(msg.slice(0, 300))}`);
  const ref = text(form, "ref", 8)?.toLowerCase() ?? "";
  const iban = (text(form, "iban", 40) ?? "").replace(/\s+/g, "").toUpperCase();
  const title = text(form, "title", 140);
  const reason = text(form, "reason", 500);
  if (!REF.test(ref)) return back("error", "Give the investor's 8-character support reference.");
  if (!IBAN.test(iban)) return back("error", "Give a Pakistani IBAN (PK, 2 digits, 4-letter bank code, 16 digits).");
  if (!title || title.length < 2) return back("error", "Give the account title as the bank holds it.");
  if (!reason || reason.length < 10) return back("error", "Give a reason of at least 10 characters (how the investor asked).");
  const t = newTicket();
  try {
    const r = await decision("SELECT admin.assisted_payee_ticket($1, $2, $3, $4) AS r", [officer.sessionHash, ref, reason, t.hash]);
    if (!r.ok) return back("error", r.error ?? "refused");
  } catch (e) {
    if (pgCode(e) === "PTS01") return back("error", "Confirm with your security key first (step-up).");
    const msg = officerMessage(e);
    if (msg) return back("error", msg);
    throw e;
  }
  const sent = await sendAssisted(t.token, iban, title);
  if (!sent.ok) return back("error", sent.error);
  return back("ok", "Entered: a different operations checker approves it after calling the investor back.", `/operations/payees/${sent.requestId}`);
}

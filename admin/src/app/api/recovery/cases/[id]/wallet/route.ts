import type { NextRequest } from "next/server";
import { decision } from "@/lib/server/approvals";
import { ID } from "@/lib/server/compliance-route";
import { officerMessage, pgCode } from "@/lib/server/db";
import { seeOther } from "@/lib/server/http";
import { caseDetail } from "@/lib/server/recovery";
import { requireApi } from "@/lib/server/session";
import { signerConfigured, signerCreateWallet } from "@/lib/server/signer";

/**
 * Maker (operations), S-06 RF-9: the signing service creates a new custodial wallet (only the
 * address comes back) and the database sets it as the case's new wallet (admin.recovery_set_wallet:
 * step-up; custodial, unbound, unregistered, empty; only before any approval). The case is checked
 * first, so no wallet is created for a case that can no longer take one.
 */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const valid = ID.test(id);
  const back = valid ? `/recovery/${id}` : "/recovery";
  const form = await request.formData().catch(() => undefined);
  const officer = await requireApi(request, "recovery.request", form);
  if (!("sessionHash" in officer)) return officer;
  const go = (key: "ok" | "error", msg: string) => seeOther(`${back}?${key}=${encodeURIComponent(msg.slice(0, 300))}`);
  if (!valid) return go("error", "Unknown case.");
  if (form?.get("decision") !== "create") return go("error", "Nothing to do.");
  const c = await caseDetail(officer.sessionHash, id);
  if (!c) return go("error", "Unknown case.");
  if (c.kind !== "wallet_recovery") return go("error", "Only a wallet-recovery case has a new wallet.");
  if (c.blockers.maker.length > 0) return go("error", c.blockers.maker.join(" "));
  // The database checks the step-up again; checking it here first means no wallet is created for nothing.
  if (!officer.stepUpAt || Date.now() - officer.stepUpAt.getTime() >= 5 * 60_000) return go("error", "Confirm with your security key first (step-up).");
  if (!signerConfigured()) return go("error", "The signing service is not configured for the portal.");
  let address: string;
  try {
    address = await signerCreateWallet();
  } catch {
    return go("error", "The signing service could not create the wallet: try again later.");
  }
  try {
    const r = await decision("SELECT admin.recovery_set_wallet($1, $2, $3) AS r", [officer.sessionHash, id, address]);
    return r.ok ? go("ok", `New custodial wallet ${address} set for the case.`) : go("error", r.error ?? "refused");
  } catch (e) {
    if (pgCode(e) === "PTS01") return go("error", "Confirm with your security key first (step-up).");
    const msg = officerMessage(e);
    if (msg) return go("error", msg);
    throw e;
  }
}

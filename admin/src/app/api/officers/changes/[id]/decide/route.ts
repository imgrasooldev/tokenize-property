import type { NextRequest } from "next/server";
import { db, officerMessage, pgCode } from "@/lib/server/db";
import { seeOther } from "@/lib/server/http";
import { deny, requireApi } from "@/lib/server/session";

/**
 * Checker: approve or reject an officer change. The database requires a different administrator,
 * no change to one's own account, and a step-up less than five minutes old on this session.
 */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const form = await request.formData().catch(() => undefined);
  const officer = await requireApi(request, "officers.manage", form);
  if (!("sessionHash" in officer)) return officer;
  if (!/^[1-9]\d{0,17}$/.test(id)) return deny(400, "bad change id");
  const decision = form?.get("decision");
  const reason = form?.get("reason");
  if ((decision !== "approve" && decision !== "reject") || typeof reason !== "string" || reason.trim().length < 10 || reason.length > 500) {
    return seeOther("/officers?error=" + encodeURIComponent("Give a decision and a reason of at least 10 characters."));
  }
  try {
    const { rows } = await db().query<{ s: string }>("SELECT admin.decide_change($1, $2, $3, $4) AS s", [
      officer.sessionHash,
      id,
      decision,
      reason.trim(),
    ]);
    return seeOther(`/officers?ok=${encodeURIComponent(`Change #${id}: ${rows[0]?.s ?? "?"}`)}`);
  } catch (e) {
    if (pgCode(e) === "PTS01") return seeOther("/officers?error=" + encodeURIComponent("Confirm with your security key first (step-up)."));
    const msg = officerMessage(e);
    if (msg) return seeOther(`/officers?error=${encodeURIComponent(msg)}`);
    throw e;
  }
}

import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import type { NextRequest } from "next/server";
import { db, officerMessage } from "@/lib/server/db";
import { clearCeremony, json, readJson } from "@/lib/server/http";
import { ceremonyId, deny, requireApi } from "@/lib/server/session";
import { consumeChallenge, credentialFor, credentialIdOk, recordFailure, verifyAssertion } from "@/lib/server/webauthn";

/**
 * Records a fresh WebAuthn assertion on the session. Approval functions in the database refuse to
 * run unless this happened less than five minutes earlier (admin.require_step_up).
 */
export async function POST(request: NextRequest) {
  const officer = await requireApi(request, "officer");
  if (!("sessionHash" in officer)) return officer;
  const body = await readJson(request);
  const response = body?.response as AuthenticationResponseJSON | undefined;
  const ceremony = ceremonyId(request);
  if (!response || !ceremony) return deny(400, "start the confirmation again");
  const challenge = await consumeChallenge(ceremony, "step_up", { session: officer.sessionHash });
  if (!challenge) {
    await recordFailure("stepup", "challenge missing, used or expired", null);
    return clearCeremony(deny(400, "this confirmation expired, try again"));
  }
  if (!credentialIdOk(response.id)) return clearCeremony(deny(400, "malformed credential"));
  const stored = await credentialFor(response.id);
  if (stored?.officer_id !== officer.id) {
    await recordFailure("stepup", "key of another officer or disabled", response.id);
    return clearCeremony(deny(403, "use your own enrolled security key"));
  }
  let counter: number;
  try {
    const result = await verifyAssertion(response, challenge, stored);
    if (!result.verified) throw new Error("assertion not verified");
    counter = result.authenticationInfo.newCounter;
  } catch (e) {
    await recordFailure("stepup", e instanceof Error ? e.message : "verification failed", response.id);
    return clearCeremony(deny(401, "the security key's answer could not be verified"));
  }
  try {
    const { rows } = await db().query<{ at: Date | null }>("SELECT admin.record_step_up($1, $2, $3) AS at", [
      officer.sessionHash,
      response.id,
      counter,
    ]);
    const at = rows[0]?.at;
    if (!at) return clearCeremony(deny(403, "confirmation refused (key not usable)"));
    return clearCeremony(json({ ok: true, stepUpAt: at.toISOString() }));
  } catch (e) {
    const msg = officerMessage(e);
    if (msg) return clearCeremony(deny(403, msg));
    throw e;
  }
}

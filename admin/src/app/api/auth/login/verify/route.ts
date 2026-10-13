import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import type { NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/server/config";
import { db } from "@/lib/server/db";
import { clearCeremony, json, readJson, safeNext } from "@/lib/server/http";
import { clientKey, take } from "@/lib/server/rate-limit";
import { ceremonyId, COOKIE_OPTIONS, deny, hashToken, landingFor, newToken, officerForToken, sameOrigin } from "@/lib/server/session";
import { consumeChallenge, credentialFor, credentialIdOk, recordFailure, verifyAssertion } from "@/lib/server/webauthn";

/**
 * Finishes a sign-in: the challenge is used up first, then the assertion is verified against the
 * stored public key (origin, RP ID, user verification, signature counter). Only then does the
 * database start a session; every failure is audited without personal data.
 */
export async function POST(request: NextRequest) {
  if (!sameOrigin(request)) return deny(403, "cross-origin request refused");
  if (!take("login", clientKey(request))) return deny(429, "too many attempts, wait a minute");
  const body = await readJson(request);
  const response = body?.response as AuthenticationResponseJSON | undefined;
  const ceremony = ceremonyId(request);
  if (!response || !ceremony) return deny(400, "start the sign-in again");
  const challenge = await consumeChallenge(ceremony, "login", {});
  if (!challenge) {
    await recordFailure("login", "challenge missing, used or expired", null);
    return clearCeremony(deny(400, "this sign-in attempt expired, try again"));
  }
  if (!credentialIdOk(response.id)) return clearCeremony(deny(400, "malformed credential"));
  const stored = await credentialFor(response.id);
  if (!stored) {
    await recordFailure("login", "unknown or disabled credential", response.id);
    return clearCeremony(deny(401, "this security key is not enrolled for an active officer"));
  }
  let counter: number;
  try {
    const result = await verifyAssertion(response, challenge, stored);
    if (!result.verified) throw new Error("assertion not verified");
    counter = result.authenticationInfo.newCounter;
  } catch (e) {
    await recordFailure("login", e instanceof Error ? e.message : "verification failed", response.id);
    return clearCeremony(deny(401, "the security key's answer could not be verified"));
  }
  const token = newToken();
  // NULL = refused and audited by the database (officer not active, key disabled or possibly cloned).
  const { rows } = await db().query<{ id: string | null }>("SELECT admin.start_session($1, $2, $3) AS id", [hashToken(token), response.id, counter]);
  if (!rows[0]?.id) return clearCeremony(deny(401, "sign-in refused (key or officer not usable)"));
  const officer = await officerForToken(token);
  if (!officer) return clearCeremony(deny(401, "sign-in refused"));
  const res = json({ ok: true, next: safeNext(body?.next) ?? landingFor(officer.permissions) });
  // A browser session cookie: the database ends the session after 15 min idle or 8 h.
  res.cookies.set(SESSION_COOKIE, token, COOKIE_OPTIONS);
  return clearCeremony(res);
}

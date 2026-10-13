import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import type { NextRequest } from "next/server";
import { db, officerMessage } from "@/lib/server/db";
import { clearCeremony, json, readJson } from "@/lib/server/http";
import { clientKey, take } from "@/lib/server/rate-limit";
import { ceremonyId, deny, hashToken, sameOrigin } from "@/lib/server/session";
import { consumeChallenge, recordFailure, verifyRegistration } from "@/lib/server/webauthn";

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Finishes an enrolment: challenge used up first, attestation verified (origin, RP ID, user
 * verification), then the database stores the key, uses the link and activates the officer. The
 * officer then signs in with the new key (no automatic session).
 */
export async function POST(request: NextRequest) {
  if (!sameOrigin(request)) return deny(403, "cross-origin request refused");
  if (!take("enrol", clientKey(request))) return deny(429, "too many attempts, wait a minute");
  const body = await readJson(request);
  const token = body?.token;
  const response = body?.response as RegistrationResponseJSON | undefined;
  const ceremony = ceremonyId(request);
  if (typeof token !== "string" || !TOKEN.test(token) || !response || !ceremony) return deny(400, "start the enrolment again");
  const tokenHash = hashToken(token);
  const challenge = await consumeChallenge(ceremony, "enrol", { enrolToken: tokenHash });
  if (!challenge) {
    await recordFailure("enrol", "challenge missing, used or expired", null);
    return clearCeremony(deny(400, "this enrolment attempt expired, try again"));
  }
  let info;
  try {
    const result = await verifyRegistration(response, challenge);
    if (!result.verified) throw new Error("attestation not verified");
    info = result.registrationInfo;
  } catch (e) {
    await recordFailure("enrol", e instanceof Error ? e.message : "verification failed", null);
    return clearCeremony(deny(400, "the security key's registration could not be verified"));
  }
  let enrolled: string | null | undefined;
  try {
    const { rows } = await db().query<{ id: string | null }>("SELECT admin.complete_enrolment($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) AS id", [
      tokenHash,
      info.credential.id,
      Buffer.from(info.credential.publicKey),
      info.credential.counter,
      info.credential.transports ?? [],
      info.aaguid,
      info.fmt,
      info.credentialDeviceType,
      info.credentialBackedUp,
      info.userVerified,
    ]);
    enrolled = rows[0]?.id;
  } catch (e) {
    const msg = officerMessage(e);
    if (msg) return clearCeremony(deny(400, msg));
    throw e;
  }
  if (!enrolled) {
    return clearCeremony(
      deny(400, "enrolment refused: the link is no longer valid, or the key is not a device-bound key with PIN or biometric"),
    );
  }
  return clearCeremony(json({ ok: true }));
}

"use server";

import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { ceremonyError, passkeyNameSchema, passkeyRefSchema, responseShapeOk, type PasskeyError } from "@/lib/passkey-rules";
import { db } from "@/lib/server/db";
import { logError } from "@/lib/server/log";
import { passkeyAvailability, passkeyConfig } from "@/lib/server/passkey-config";
import { clientKey, take } from "@/lib/server/rate-limit";
import { CEREMONY_COOKIE, cookieOptions, currentSession, hashToken, newToken, setSessionCookie, validToken, type SessionInfo } from "@/lib/server/session";
import {
  authenticationOptions,
  consumeChallenge,
  createChallenge,
  newChallenge,
  recordFailure,
  registrationOptions,
  storedPasskey,
  verifyAssertion,
  verifyRegistration,
} from "@/lib/server/webauthn";

/**
 * Investor passkey ceremonies (T-030, migration 0024). Server actions: Next.js checks that the
 * request comes from this site's own origin, the cookies are SameSite=Strict, and WebAuthn itself
 * binds every response to the configured origin and RP ID. Each ceremony: options (challenge
 * stored hashed by a random ceremony id kept in an HttpOnly cookie), then the browser's response,
 * then the challenge is used up BEFORE the response is verified, and only a verified response is
 * recorded by the database (which also checks the ceremony was really completed, once).
 */
type Fail = { error: PasskeyError };

async function enabled() {
  const cfg = passkeyConfig();
  if (!cfg.enabled || !(await passkeyAvailability()).enabled) return null;
  return cfg;
}

async function startCeremony(): Promise<{ token: string; hash: Buffer }> {
  const token = newToken();
  (await cookies()).set(CEREMONY_COOKIE, token, cookieOptions(300));
  return { token, hash: hashToken(token) };
}

/** The ceremony id from the cookie (cleared at once: one response per ceremony). */
async function takeCeremony(): Promise<Buffer | null> {
  const jar = await cookies();
  const v = jar.get(CEREMONY_COOKIE)?.value;
  jar.delete(CEREMONY_COOKIE);
  return validToken(v) ? hashToken(v) : null;
}

async function signedIn(): Promise<SessionInfo | null> {
  return currentSession();
}

// ------------------------------------------------------------------ sign-in (discoverable credentials)

export async function passkeyLoginOptions(): Promise<{ options: PublicKeyCredentialRequestOptionsJSON } | Fail> {
  const cfg = await enabled();
  if (!cfg) return { error: "unavailable" };
  if (!take("passkeyLogin", await clientKey())) return { error: "rate" };
  const ceremony = await startCeremony();
  const options = await authenticationOptions(cfg, newChallenge());
  const created = await createChallenge(ceremony.hash, "login", options.challenge, null);
  if (created !== "ok") return { error: ceremonyError(created) };
  return { options };
}

export async function passkeyLoginVerify(response: unknown): Promise<{ ok: true; next: string } | Fail> {
  const cfg = await enabled();
  if (!cfg) return { error: "unavailable" };
  if (!take("passkeyLogin", await clientKey())) return { error: "rate" };
  const ceremony = await takeCeremony();
  if (!ceremony || !responseShapeOk(response)) return { error: "expired" };
  const challenge = await consumeChallenge(ceremony, "login", null);
  if (!challenge) {
    await recordFailure("login", "challenge missing, used or expired", response.id, null);
    return { error: "expired" };
  }
  const stored = await storedPasskey(response.id);
  if (!stored) {
    await recordFailure("login", "unknown or revoked passkey", response.id, null);
    return { error: "refused" };
  }
  let info: { newCounter: number; userVerified: boolean; credentialBackedUp: boolean };
  try {
    const result = await verifyAssertion(cfg, response as unknown as AuthenticationResponseJSON, challenge, stored);
    if (!result.verified) throw new Error("assertion not verified");
    info = result.authenticationInfo;
  } catch (e) {
    await recordFailure("login", e instanceof Error ? e.message : "verification failed", response.id, null);
    return { error: "verify" };
  }
  const token = newToken();
  // NULL = refused and audited by the database (revoked, locked, possibly cloned, ceremony reused).
  const { rows } = await (await db()).query<{ i: string | null }>("SELECT webauth.web_login($1, $2, $3, $4, $5, $6) AS i", [
    ceremony,
    hashToken(token),
    response.id,
    info.newCounter,
    info.userVerified,
    info.credentialBackedUp,
  ]);
  if (!rows[0]?.i) return { error: "refused" };
  await setSessionCookie(token);
  return { ok: true, next: "/account" };
}

// ------------------------------------------------------------------ registration (from /account)

export async function passkeyRegisterOptions(name: unknown): Promise<{ options: PublicKeyCredentialCreationOptionsJSON } | Fail> {
  const cfg = await enabled();
  if (!cfg) return { error: "unavailable" };
  const session = await signedIn();
  if (!session) return { error: "session" };
  if (!take("passkey", session.investorId)) return { error: "rate" };
  if (!passkeyNameSchema.safeParse(name).success) return { error: "name" };
  const pool = await db();
  const [user, existing] = await Promise.all([
    pool.query<{ investor_id: string; display_name: string }>("SELECT * FROM webauth.web_registration_user($1)", [session.hash]),
    pool.query<{ id: string; transports: string[] }>("SELECT * FROM webauth.web_session_credentials($1)", [session.hash]),
  ]);
  const who = user.rows[0];
  if (!who) return { error: "session" };
  const ceremony = await startCeremony();
  const options = await registrationOptions(cfg, { id: who.investor_id, name: who.display_name }, newChallenge(), existing.rows);
  const created = await createChallenge(ceremony.hash, "register", options.challenge, session.hash);
  if (created !== "ok") {
    // An investor who already has a passkey confirms with it first; one without signs in again.
    if (created === "reauth") return { error: session.hasPasskey ? "reauthStepUp" : "reauth" };
    return { error: ceremonyError(created) };
  }
  return { options };
}

export async function passkeyRegisterVerify(response: unknown, name: unknown): Promise<{ ok: true } | Fail> {
  const cfg = await enabled();
  if (!cfg) return { error: "unavailable" };
  const session = await signedIn();
  if (!session) return { error: "session" };
  if (!take("passkey", session.investorId)) return { error: "rate" };
  const label = passkeyNameSchema.safeParse(name);
  const ceremony = await takeCeremony();
  if (!ceremony || !responseShapeOk(response)) return { error: "expired" };
  if (!label.success) return { error: "name" };
  const challenge = await consumeChallenge(ceremony, "register", session.hash);
  if (!challenge) {
    await recordFailure("register", "challenge missing, used or expired", null, session.hash);
    return { error: "expired" };
  }
  let info;
  try {
    const result = await verifyRegistration(cfg, response as unknown as RegistrationResponseJSON, challenge);
    if (!result.verified) throw new Error("registration not verified");
    info = result.registrationInfo;
  } catch (e) {
    await recordFailure("register", e instanceof Error ? e.message : "verification failed", null, session.hash);
    return { error: "verify" };
  }
  const { rows } = await (await db()).query<{ r: string }>(
    "SELECT webauth.web_add_passkey($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) AS r",
    [
      ceremony,
      session.hash,
      info.credential.id,
      Buffer.from(info.credential.publicKey),
      info.credential.counter,
      info.credential.transports ?? [],
      info.aaguid,
      info.fmt,
      info.credentialDeviceType,
      info.credentialBackedUp,
      info.userVerified,
      label.data,
    ],
  );
  const r = rows[0]?.r;
  if (r !== "ok") return { error: ceremonyError(r) };
  revalidatePath("/account");
  return { ok: true };
}

// ------------------------------------------------------------------ step-up (sensitive actions, passkey management)

export async function passkeyStepUpOptions(): Promise<{ options: PublicKeyCredentialRequestOptionsJSON } | Fail> {
  const cfg = await enabled();
  if (!cfg) return { error: "unavailable" };
  const session = await signedIn();
  if (!session) return { error: "session" };
  if (!take("passkey", session.investorId)) return { error: "rate" };
  const { rows } = await (await db()).query<{ id: string; transports: string[] }>("SELECT * FROM webauth.web_session_credentials($1)", [session.hash]);
  if (rows.length === 0) return { error: "none" };
  const ceremony = await startCeremony();
  const options = await authenticationOptions(cfg, newChallenge(), rows);
  const created = await createChallenge(ceremony.hash, "step_up", options.challenge, session.hash);
  if (created !== "ok") return { error: ceremonyError(created) };
  return { options };
}

export async function passkeyStepUpVerify(response: unknown): Promise<{ ok: true } | Fail> {
  const cfg = await enabled();
  if (!cfg) return { error: "unavailable" };
  const session = await signedIn();
  if (!session) return { error: "session" };
  if (!take("passkey", session.investorId)) return { error: "rate" };
  const ceremony = await takeCeremony();
  if (!ceremony || !responseShapeOk(response)) return { error: "expired" };
  const challenge = await consumeChallenge(ceremony, "step_up", session.hash);
  if (!challenge) {
    await recordFailure("stepup", "challenge missing, used or expired", response.id, session.hash);
    return { error: "expired" };
  }
  const stored = await storedPasskey(response.id);
  if (stored?.investor_id !== session.investorId) {
    await recordFailure("stepup", "passkey of another investor, revoked or unknown", response.id, session.hash);
    return { error: "refused" };
  }
  let info: { newCounter: number; userVerified: boolean; credentialBackedUp: boolean };
  try {
    const result = await verifyAssertion(cfg, response as unknown as AuthenticationResponseJSON, challenge, stored);
    if (!result.verified) throw new Error("assertion not verified");
    info = result.authenticationInfo;
  } catch (e) {
    await recordFailure("stepup", e instanceof Error ? e.message : "verification failed", response.id, session.hash);
    return { error: "verify" };
  }
  const { rows } = await (await db()).query<{ at: Date | null }>("SELECT webauth.web_step_up($1, $2, $3, $4, $5, $6) AS at", [
    ceremony,
    session.hash,
    response.id,
    info.newCounter,
    info.userVerified,
    info.credentialBackedUp,
  ]);
  if (!rows[0]?.at) return { error: "refused" };
  return { ok: true };
}

// ------------------------------------------------------------------ revocation

/** Revokes one of the investor's passkeys (needs a passkey step-up within 5 minutes; the database decides). */
export async function revokePasskey(ref: unknown): Promise<{ ok: true } | Fail> {
  const session = await signedIn();
  if (!session) return { error: "session" };
  if (!take("passkey", session.investorId)) return { error: "rate" };
  const parsed = passkeyRefSchema.safeParse(ref);
  if (!parsed.success) return { error: "unknown" };
  try {
    const { rows } = await (await db()).query<{ r: string }>("SELECT webauth.web_revoke_passkey($1, $2) AS r", [session.hash, parsed.data]);
    const r = rows[0]?.r;
    if (r !== "ok") return { error: ceremonyError(r) };
  } catch (e) {
    logError("revoke passkey", e);
    return { error: "generic" };
  }
  revalidatePath("/account");
  return { ok: true };
}

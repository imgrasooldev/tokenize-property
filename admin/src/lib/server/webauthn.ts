import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { randomBytes } from "node:crypto";
import { config } from "./config";
import { db } from "./db";

/**
 * WebAuthn ceremonies (FIDO2, NIST SP 800-63B AAL3 for staff). The server keeps each challenge in
 * the database, single use and at most 5 minutes old, bound to the browser by a ceremony cookie
 * and, for a step-up, to the session. User verification (PIN or biometric on the key) is required;
 * synced passkeys are refused (the database checks device_type and backed_up as well).
 */
const TIMEOUT_MS = 120_000;
/** ES256 and EdDSA cover FIDO2 hardware keys; RS256 for Windows Hello TPM keys. */
const ALGORITHMS = [-7, -8, -257];

/** 32 random bytes; the options carry them base64url-encoded, and that string is what we store. */
export function newChallenge(): Uint8Array<ArrayBuffer> {
  return new Uint8Array(randomBytes(32));
}

export async function storeChallenge(
  ceremonyHash: Buffer,
  purpose: "enrol" | "login" | "step_up",
  challenge: string,
  binding: { enrolToken?: Buffer; session?: Buffer },
): Promise<void> {
  await db().query("SELECT admin.create_challenge($1, $2, $3, $4, $5)", [
    ceremonyHash,
    purpose,
    challenge,
    binding.enrolToken ?? null,
    binding.session ?? null,
  ]);
}

/** Uses the challenge once (before verifying, so a failed attempt cannot be retried with it). */
export async function consumeChallenge(
  ceremonyHash: Buffer,
  purpose: "enrol" | "login" | "step_up",
  binding: { enrolToken?: Buffer; session?: Buffer },
): Promise<string | null> {
  const { rows } = await db().query<{ c: string | null }>("SELECT admin.consume_challenge($1, $2, $3, $4) AS c", [
    ceremonyHash,
    purpose,
    binding.enrolToken ?? null,
    binding.session ?? null,
  ]);
  return rows[0]?.c ?? null;
}

export function registrationOptions(officer: { id: string; handle: string; name: string }, challenge: Uint8Array<ArrayBuffer>) {
  return generateRegistrationOptions({
    rpName: config.rpName,
    rpID: config.rpID,
    userName: officer.handle,
    userDisplayName: officer.name,
    userID: new Uint8Array(Buffer.from(officer.id.replaceAll("-", ""), "hex")),
    challenge,
    timeout: TIMEOUT_MS,
    // Direct attestation: the AAGUID and format are recorded (an AAGUID allow-list of approved key
    // models is a production setting, ADR 0011).
    attestationType: "direct",
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
    supportedAlgorithmIDs: ALGORITHMS,
    preferredAuthenticatorType: "securityKey",
  });
}

export async function verifyRegistration(response: RegistrationResponseJSON, expectedChallenge: string) {
  return verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin: config.origin,
    expectedRPID: config.rpID,
    requireUserPresence: true,
    requireUserVerification: true,
    supportedAlgorithmIDs: ALGORITHMS,
  });
}

export function authenticationOptions(challenge: Uint8Array<ArrayBuffer>, allow: { id: string; transports: string[] }[] = []) {
  return generateAuthenticationOptions({
    rpID: config.rpID,
    challenge,
    timeout: TIMEOUT_MS,
    userVerification: "required",
    // Empty for sign-in: the key offers its own discoverable credential (no user name typed).
    allowCredentials: allow.map((c) => ({ id: c.id, transports: c.transports })),
  });
}

export interface StoredCredential {
  officer_id: string;
  public_key: Buffer;
  counter: string;
  transports: string[];
}

export async function credentialFor(id: string): Promise<StoredCredential | null> {
  const { rows } = await db().query<StoredCredential>("SELECT * FROM admin.credential_for_login($1)", [id]);
  return rows[0] ?? null;
}

export async function verifyAssertion(response: AuthenticationResponseJSON, expectedChallenge: string, stored: StoredCredential) {
  return verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: config.origin,
    expectedRPID: config.rpID,
    requireUserVerification: true,
    credential: {
      id: response.id,
      publicKey: new Uint8Array(stored.public_key),
      counter: Number(stored.counter),
      transports: stored.transports,
    },
  });
}

export async function recordFailure(kind: "login" | "enrol" | "stepup", reason: string, credentialId: string | null): Promise<void> {
  await db()
    .query("SELECT admin.auth_failed($1, $2, $3)", [kind, reason.slice(0, 200), credentialId])
    .catch(() => undefined);
}

/** Credential IDs are base64url; anything else is refused before it reaches the database. */
export function credentialIdOk(id: unknown): id is string {
  return typeof id === "string" && /^[A-Za-z0-9_-]{16,1366}$/.test(id);
}

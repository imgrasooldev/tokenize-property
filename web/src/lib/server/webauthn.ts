import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransport,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { randomBytes } from "node:crypto";
import { db } from "./db";
import type { PasskeyConfig } from "./passkey-config";

/**
 * WebAuthn ceremonies for investors (T-030; NIST SP 800-63B AAL2, ADR 0010 section 8), the same
 * library and approach as the officers' portal (ADR 0011) with investor settings: any passkey
 * (synced or device-bound), discoverable credentials, user verification (PIN or biometric) always
 * required, no attestation (privacy; nothing is decided on the authenticator model). Challenges
 * live in the database: single use, at most 5 minutes, bound to a ceremony cookie and, for a
 * registration or step-up, to the session.
 */
type Enabled = Extract<PasskeyConfig, { enabled: true }>;

const TIMEOUT_MS = 120_000;
/** ES256 and EdDSA (security keys, platform passkeys), RS256 (Windows Hello TPM keys). */
const ALGORITHMS = [-7, -8, -257];
const TRANSPORTS = new Set<AuthenticatorTransport>(["ble", "hybrid", "internal", "nfc", "usb"]);

/** 32 random bytes; the options carry them base64url-encoded, and that string is what the database keeps. */
export function newChallenge(): Uint8Array<ArrayBuffer> {
  return new Uint8Array(randomBytes(32));
}

export function transportsOf(v: string[]): AuthenticatorTransport[] {
  return v.filter((t): t is AuthenticatorTransport => TRANSPORTS.has(t as AuthenticatorTransport));
}

export function registrationOptions(
  cfg: Enabled,
  investor: { id: string; name: string },
  challenge: Uint8Array<ArrayBuffer>,
  exclude: { id: string; transports: string[] }[],
) {
  return generateRegistrationOptions({
    rpName: cfg.rpName,
    rpID: cfg.rpID,
    userName: investor.name,
    userDisplayName: investor.name,
    // The investor id (random UUID) as the user handle: no CNIC, phone or e-mail in the authenticator.
    userID: new Uint8Array(Buffer.from(investor.id.replaceAll("-", ""), "hex")),
    challenge,
    timeout: TIMEOUT_MS,
    attestationType: "none",
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
    supportedAlgorithmIDs: ALGORITHMS,
    excludeCredentials: exclude.map((c) => ({ id: c.id, transports: transportsOf(c.transports) })),
  });
}

export async function verifyRegistration(cfg: Enabled, response: RegistrationResponseJSON, expectedChallenge: string) {
  return verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin: cfg.origin,
    expectedRPID: cfg.rpID,
    requireUserPresence: true,
    requireUserVerification: true,
    supportedAlgorithmIDs: ALGORITHMS,
  });
}

export function authenticationOptions(cfg: Enabled, challenge: Uint8Array<ArrayBuffer>, allow: { id: string; transports: string[] }[] = []) {
  return generateAuthenticationOptions({
    rpID: cfg.rpID,
    challenge,
    timeout: TIMEOUT_MS,
    userVerification: "required",
    // Empty for sign-in: the authenticator offers its own discoverable credential (nothing typed).
    allowCredentials: allow.map((c) => ({ id: c.id, transports: transportsOf(c.transports) })),
  });
}

export interface StoredPasskey {
  investor_id: string;
  public_key: Buffer;
  counter: string;
  transports: string[];
}

export async function storedPasskey(credentialId: string): Promise<StoredPasskey | null> {
  const { rows } = await (await db()).query<StoredPasskey>("SELECT * FROM webauth.web_credential($1)", [credentialId]);
  return rows[0] ?? null;
}

export async function verifyAssertion(cfg: Enabled, response: AuthenticationResponseJSON, expectedChallenge: string, stored: StoredPasskey) {
  return verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: cfg.origin,
    expectedRPID: cfg.rpID,
    requireUserVerification: true,
    credential: {
      id: response.id,
      publicKey: new Uint8Array(stored.public_key),
      // The counter check (clone detection) is the database's, in the same transaction that records
      // the use (webauth.use_passkey): a counter that did not move revokes the passkey, ends its
      // sessions and raises an alert. With 0 here the library never rejects on the counter, so a
      // regression always reaches that path instead of ending as a plain verification failure.
      counter: 0,
      transports: transportsOf(stored.transports),
    },
  });
}

export async function createChallenge(ceremonyHash: Buffer, purpose: "register" | "login" | "step_up", challenge: string, session: Buffer | null): Promise<string> {
  const { rows } = await (await db()).query<{ r: string }>("SELECT webauth.web_create_challenge($1, $2, $3, $4) AS r", [ceremonyHash, purpose, challenge, session]);
  return rows[0]?.r ?? "generic";
}

/** Uses the challenge once (before verifying, so a failed attempt cannot be retried with it). */
export async function consumeChallenge(ceremonyHash: Buffer, purpose: "register" | "login" | "step_up", session: Buffer | null): Promise<string | null> {
  const { rows } = await (await db()).query<{ c: string | null }>("SELECT webauth.web_consume_challenge($1, $2, $3) AS c", [ceremonyHash, purpose, session]);
  return rows[0]?.c ?? null;
}

/** Records a failed ceremony in the audit (and towards the lockout, IP-7); never throws. */
export async function recordFailure(kind: "login" | "register" | "stepup", reason: string, credentialId: string | null, session: Buffer | null): Promise<void> {
  await (await db())
    .query("SELECT webauth.web_auth_failed($1, $2, $3, $4)", [kind, reason.slice(0, 200), credentialId, session])
    .catch(() => undefined);
}

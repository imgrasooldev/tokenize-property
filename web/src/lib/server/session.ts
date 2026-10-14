import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { cache } from "react";
import { stepUpResult, type StepUpError } from "../passkey-rules";
import { db } from "./db";
import { logError } from "./log";
import { keyedHash } from "./secrets";

/**
 * Investor sessions, enforced by the database (T-030, migration 0024 IP-1). The cookie holds a
 * random 256-bit token; the database stores only its SHA-256 and checks 30 minutes idle and 12
 * hours absolute on every request, keeps at most 10 live sessions per investor, and ends them at
 * logout or when the passkey they were signed in with is revoked.
 */
export const SESSION_COOKIE = "pt_session";
/** Binds a WebAuthn ceremony (its challenge) to the browser that started it; 5 minutes. */
export const CEREMONY_COOKIE = "pt_passkey_ceremony";
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const MAX_AGE_SECONDS = 12 * 60 * 60;

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

export function validToken(v: string | undefined): v is string {
  return typeof v === "string" && TOKEN.test(v);
}

/** HttpOnly, SameSite=Strict; Secure everywhere except the plain-HTTP IP demo (WEB_PLAIN_HTTP=1, owner decision) and local development. */
export function cookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    sameSite: "strict" as const,
    secure: process.env.NODE_ENV === "production" && process.env.WEB_PLAIN_HTTP !== "1",
    path: "/",
    maxAge,
  };
}

export async function setSessionCookie(token: string): Promise<void> {
  (await cookies()).set(SESSION_COOKIE, token, cookieOptions(MAX_AGE_SECONDS));
}

/**
 * Starts a session through the demo paths (persona sign-in, or right after sign-up). The database
 * refuses a persona session for a non-persona investor and a sign-up session for an investor older
 * than 30 minutes (IP-2). Passkey sign-in starts its session in webauth.web_login instead.
 */
export async function startSession(investorId: string, method: "persona" | "signup" = "signup"): Promise<void> {
  const token = newToken();
  const { rows } = await (await db()).query<{ e: Date | null }>("SELECT webauth.web_start_session($1, $2, $3) AS e", [hashToken(token), investorId, method]);
  if (!rows[0]?.e) throw new Error("session refused");
  await setSessionCookie(token);
}

async function cookieToken(): Promise<string | null> {
  const raw = (await cookies()).get(SESSION_COOKIE)?.value;
  return validToken(raw) ? raw : null;
}

export async function endSession(): Promise<void> {
  const token = await cookieToken();
  if (token) {
    await (await db())
      .query("SELECT webauth.web_end_session($1)", [hashToken(token)])
      .catch((e: unknown) => {
        logError("end session", e);
      });
  }
  (await cookies()).delete(SESSION_COOKIE);
}

export interface SessionInfo {
  investorId: string;
  method: "passkey" | "persona" | "signup";
  createdAt: Date;
  expiresAt: Date;
  idleUntil: Date;
  passkeyAt: Date | null;
  hasPasskey: boolean;
  /** SHA-256 of the cookie token: what the database functions take. */
  hash: Buffer;
}

interface SessionRow {
  investor_id: string;
  method: SessionInfo["method"];
  created_at: Date;
  expires_at: Date;
  idle_until: Date;
  passkey_at: Date | null;
  has_passkey: boolean;
}

/** One database check per request (the header and the page share it). Fails closed: an error reads as signed out. */
const lookup = cache(async (token: string): Promise<SessionInfo | null> => {
  const hash = hashToken(token);
  try {
    const { rows } = await (await db()).query<SessionRow>("SELECT * FROM webauth.web_session($1)", [hash]);
    const r = rows[0];
    if (!r) return null;
    return {
      investorId: r.investor_id,
      method: r.method,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      idleUntil: r.idle_until,
      passkeyAt: r.passkey_at,
      hasPasskey: r.has_passkey,
      hash,
    };
  } catch (e) {
    logError("session check", e);
    return null;
  }
});

export async function currentSession(): Promise<SessionInfo | null> {
  const token = await cookieToken();
  return token ? lookup(token) : null;
}

/** The signed-in investor id, or null if the cookie is missing, unknown, ended or past a limit. */
export async function currentInvestorId(): Promise<string | null> {
  return (await currentSession())?.investorId ?? null;
}

/** Keyed hash of the current session cookie (never the cookie itself), or null without a valid session. */
export async function sessionFingerprint(): Promise<string | null> {
  const token = await cookieToken();
  if (!token || !(await lookup(token))) return null;
  return keyedHash("offering-session", token);
}

/**
 * requireRecentPasskey (T-030, migration 0024 IP-6): may the signed-in investor run a sensitive
 * action now? A passkey assertion on this session within 5 minutes is needed when the investor has
 * a passkey and the action is listed in webauth.step_up_actions for this amount (or not listed at
 * all: deny by default). Without a passkey the database waives it until webauth.settings
 * require_passkey is switched on, then asks the investor to add one.
 *
 * This is the message check; the decision that counts is taken again inside the action's own SQL
 * wrapper (webauth.web_reserve, webauth.web_cancel; see API_CONTRACTS.md for adopting it).
 */
export async function requireRecentPasskey(action: string, amountPaisa: bigint = 0n): Promise<{ ok: true } | { ok: false; error: StepUpError }> {
  const session = await currentSession();
  if (!session) return { ok: false, error: "session" };
  const { rows } = await (await db()).query<{ r: string }>("SELECT webauth.web_step_up_status($1, $2, $3) AS r", [session.hash, action, amountPaisa.toString()]);
  return stepUpResult(rows[0]?.r);
}

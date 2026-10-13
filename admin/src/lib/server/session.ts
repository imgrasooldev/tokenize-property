import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { forbidden, redirect } from "next/navigation";
import { NextResponse, type NextRequest } from "next/server";
import { isRole, type Permission, type Role } from "../permissions";
import { CEREMONY_COOKIE, config, SESSION_COOKIE } from "./config";
import { db } from "./db";

/**
 * Officer sessions (ADR 0011). The cookie holds a random 256-bit token; the database stores only its
 * SHA-256 and enforces 15 minutes idle, 8 hours absolute and one live session per officer. The
 * CSRF token is derived from the session token, so it needs no extra secret and dies with it.
 */
export interface Officer {
  id: string;
  handle: string;
  name: string;
  roles: Role[];
  permissions: Set<Permission>;
  createdAt: Date;
  expiresAt: Date;
  idleUntil: Date;
  stepUpAt: Date | null;
  sessionHash: Buffer;
  csrf: string;
}

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

export function csrfFor(token: string): string {
  return createHash("sha256").update(`pt-admin-csrf-v1|${token}`, "utf8").digest("base64url");
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export const COOKIE_OPTIONS = { httpOnly: true, secure: true, sameSite: "strict", path: "/" } as const;

interface SessionRow {
  officer_id: string;
  handle: string;
  display_name: string;
  roles: string[];
  permissions: string[];
  created_at: Date;
  expires_at: Date;
  idle_until: Date;
  step_up_at: Date | null;
  allowed: boolean;
}

/**
 * Validates the session in the database (which also ends it at a limit), checks the permission
 * there and audits a denial, or a page view when logView is set.
 */
async function authorize(
  token: string,
  permission: Permission | null,
  resource: string | null,
  logView: boolean,
): Promise<{ officer: Officer; allowed: boolean } | null> {
  if (!TOKEN.test(token)) return null;
  const sessionHash = hashToken(token);
  const { rows } = await db().query<SessionRow>("SELECT * FROM admin.authorize($1, $2, $3, $4)", [
    sessionHash,
    permission,
    resource,
    logView,
  ]);
  const r = rows[0];
  if (!r) return null;
  return {
    allowed: r.allowed,
    officer: {
      id: r.officer_id,
      handle: r.handle,
      name: r.display_name,
      roles: r.roles.filter(isRole),
      permissions: new Set(r.permissions as Permission[]),
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      idleUntil: r.idle_until,
      stepUpAt: r.step_up_at,
      sessionHash,
      csrf: csrfFor(token),
    },
  };
}

async function cookieToken(): Promise<string | null> {
  return (await cookies()).get(SESSION_COOKIE)?.value ?? null;
}

/** The officer behind a token just issued at sign-in (no audit entry). */
export async function officerForToken(token: string): Promise<Officer | null> {
  return (await authorize(token, null, null, false))?.officer ?? null;
}

/** The signed-in officer for a page, or null (no audit entry). */
export async function currentOfficer(): Promise<Officer | null> {
  const token = await cookieToken();
  if (!token) return null;
  return (await authorize(token, null, null, false))?.officer ?? null;
}

/**
 * Guard at the top of every protected page: no session -> sign-in page; missing permission -> 403
 * (audited by the database). Every allowed view is audited as well.
 */
export async function requirePage(access: Permission | "officer", resource: string): Promise<Officer> {
  const token = await cookieToken();
  const next = `/login?next=${encodeURIComponent(resource)}`;
  if (!token) redirect(next);
  const result = await authorize(token, access === "officer" ? null : access, resource, true);
  if (!result) redirect(`${next}&expired=1`);
  if (!result.allowed) forbidden();
  return result.officer;
}

/**
 * Same-origin check for every state-changing request (CSRF defence 1 of 2; SameSite=Strict is 3).
 * With Referrer-Policy: no-referrer, browsers send "Origin: null" on form navigations; that is
 * accepted only together with the browser-set "Sec-Fetch-Site: same-origin".
 */
export function sameOrigin(request: NextRequest | Request): boolean {
  const origin = request.headers.get("origin");
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") return false;
  if (origin === config.origin) return true;
  return origin === "null" && site === "same-origin";
}

export function deny(status: 401 | 403 | 400 | 409 | 429, error: string): NextResponse {
  return NextResponse.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

/**
 * Guard for API routes. Mutating routes need the same origin and the session's CSRF token (header
 * x-csrf-token or form field csrf). Returns the officer or a response to send back.
 */
export async function requireApi(
  request: NextRequest,
  access: Permission | "officer",
  form?: FormData,
): Promise<Officer | NextResponse> {
  if (request.method !== "GET" && !sameOrigin(request)) return deny(403, "cross-origin request refused");
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (!token) return deny(401, "sign in first");
  const resource = `${request.method} ${request.nextUrl.pathname}`;
  const result = await authorize(token, access === "officer" ? null : access, resource, false);
  if (!result) return deny(401, "session ended: sign in again");
  if (request.method !== "GET") {
    const presented = request.headers.get("x-csrf-token") ?? form?.get("csrf");
    if (typeof presented !== "string" || !safeEqual(presented, result.officer.csrf)) return deny(403, "missing or wrong CSRF token");
  }
  if (!result.allowed) return deny(403, "not permitted for your role");
  return result.officer;
}

/** The token of the current request's session (for logout). */
export function requestToken(request: NextRequest): string | null {
  const t = request.cookies.get(SESSION_COOKIE)?.value;
  return t && TOKEN.test(t) ? t : null;
}

export function ceremonyId(request: NextRequest): Buffer | null {
  const v = request.cookies.get(CEREMONY_COOKIE)?.value;
  return v && TOKEN.test(v) ? hashToken(v) : null;
}

/** First page an officer may open, used after sign-in and for "/" when it is not theirs. */
export function landingFor(permissions: Set<Permission>): string {
  if (permissions.has("ops.read")) return "/";
  if (permissions.has("officers.read")) return "/officers";
  if (permissions.has("trustee.read")) return "/trustee";
  return "/account";
}

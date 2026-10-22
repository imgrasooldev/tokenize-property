import { NextResponse, type NextRequest } from "next/server";
import { ROUTES } from "../routes";
import { CEREMONY_COOKIE, config } from "./config";
import { COOKIE_OPTIONS } from "./session";

/** Reads a small JSON body (WebAuthn responses are a few kB); refuses anything larger or not JSON. */
export async function readJson(request: NextRequest, maxBytes = 32_768): Promise<Record<string, unknown> | null> {
  if (!(request.headers.get("content-type") ?? "").startsWith("application/json")) return null;
  const text = await request.text();
  if (text.length > maxBytes) return null;
  try {
    const v: unknown = JSON.parse(text);
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export function withCeremony(res: NextResponse, value: string): NextResponse {
  res.cookies.set(CEREMONY_COOKIE, value, { ...COOKIE_OPTIONS, maxAge: 300 });
  return res;
}

export function clearCeremony(res: NextResponse): NextResponse {
  res.cookies.set(CEREMONY_COOKIE, "", { ...COOKIE_OPTIONS, maxAge: 0 });
  return res;
}

const PAGES = ROUTES.filter((r) => r.kind === "page" && !r.path.includes("[")).map((r) => r.path);

/** Only our own page paths are accepted as "next" after sign-in (no open redirect). */
export function safeNext(v: unknown): string | null {
  if (typeof v !== "string") return null;
  if (/^\/audit\/(signer|recon|ledger|admin|compliance|recovery)$/.test(v)) return v;
  return PAGES.includes(v) && v !== "/login" && v !== "/enrol" ? v : null;
}

/** 303 back to a page after a form POST. */
export function seeOther(path: string): NextResponse {
  return NextResponse.redirect(new URL(path, config.origin), 303);
}

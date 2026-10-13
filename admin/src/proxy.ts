import { NextResponse, type NextRequest } from "next/server";

const ORIGIN = new URL(process.env.ADMIN_ORIGIN ?? "http://localhost:3300");

/**
 * 1. Host check (DNS rebinding): only the configured origin's host is served (421 otherwise, with
 *    a hint to open the right origin: WebAuthn needs the localhost RP ID, not 127.0.0.1).
 * 2. Per-request Content-Security-Policy with a fresh nonce, identical to the website's (OWASP
 *    ASVS V14). Next.js reads the nonce from this header and applies it to its own scripts.
 */
export function proxy(request: NextRequest) {
  const host = request.headers.get("host");
  if (host !== ORIGIN.host) {
    // No redirect: Next.js shortens a same-port Location to a path, which would loop on 127.0.0.1.
    return new NextResponse(`Unknown host. Open ${ORIGIN.origin} (WebAuthn needs this exact origin).\n`, {
      status: 421,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const isDev = process.env.NODE_ENV !== "production";
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    // Inline style attributes are used by React for dynamic sizes; no inline <style> injection from data.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");

  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", csp);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: [{ source: "/((?!_next/static|_next/image|favicon.ico).*)" }],
};

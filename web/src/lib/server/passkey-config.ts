import { headers } from "next/headers";

/**
 * Where passkeys can work (T-030). WebAuthn needs a secure context and an RP ID that is a domain:
 * an https:// origin, or http://localhost (browsers treat localhost as secure). An IP address can
 * never be an RP ID, so the plain-HTTP demo server (http://51.79.144.40) has no passkeys until a
 * domain and TLS exist; the sign-in page then says so and the demo sign-in keeps working.
 *
 * WEB_ORIGIN is the one origin investors use (for example https://app.example.pk). Without it,
 * development uses http://localhost:3100 and production has passkeys switched off.
 */
export type PasskeyConfig =
  | { enabled: true; origin: string; host: string; rpID: string; rpName: string }
  | { enabled: false; reason: "unset" | "insecure" };

/** A dotted IPv4 literal (4 numeric labels); written without nested quantifiers. */
function isIpv4(host: string): boolean {
  const parts = host.split(".");
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p));
}

export function passkeyConfigFrom(env: { WEB_ORIGIN?: string | undefined; NODE_ENV?: string | undefined }): PasskeyConfig {
  const raw = env.WEB_ORIGIN?.trim() || (env.NODE_ENV === "production" ? "" : "http://localhost:3100");
  if (!raw) return { enabled: false, reason: "unset" };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { enabled: false, reason: "unset" };
  }
  // An origin only: no path, query, fragment or credentials.
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "" || url.username !== "" || url.password !== "") return { enabled: false, reason: "unset" };
  const host = url.hostname;
  if (isIpv4(host) || host.startsWith("[") || host.includes(":")) return { enabled: false, reason: "insecure" };
  const secure = url.protocol === "https:" || (url.protocol === "http:" && (host === "localhost" || host.endsWith(".localhost")));
  if (!secure) return { enabled: false, reason: "insecure" };
  return { enabled: true, origin: url.origin, host: url.host, rpID: host, rpName: "Property Token" };
}

export function passkeyConfig(): PasskeyConfig {
  return passkeyConfigFrom({ WEB_ORIGIN: process.env.WEB_ORIGIN, NODE_ENV: process.env.NODE_ENV });
}

/** What the pages show: available, or why not (and, when only the address is wrong, the right one). */
export type PasskeyAvailability = { enabled: true } | { enabled: false; reason: "unset" | "insecure" | "host"; origin?: string };

export async function passkeyAvailability(): Promise<PasskeyAvailability> {
  const cfg = passkeyConfig();
  if (!cfg.enabled) return { enabled: false, reason: cfg.reason };
  // The browser binds a passkey to the page's own address; on another address (127.0.0.1 instead
  // of localhost) every ceremony would fail, so point the investor to the configured one.
  const host = (await headers()).get("host");
  if (host !== cfg.host) return { enabled: false, reason: "host", origin: cfg.origin };
  return { enabled: true };
}

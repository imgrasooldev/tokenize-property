import type { NextRequest } from "next/server";
import { config } from "./config";

/**
 * In-process fixed-window limits for the anonymous ceremonies (sign-in, enrolment). The portal runs
 * as one process behind a VPN or an SSH tunnel; a shared store is needed only with several replicas.
 */
const WINDOW_MS = 60_000;
const LIMITS = { login: 20, enrol: 10, stepup: 20 } as const;
const hits = new Map<string, { start: number; n: number }>();

export function clientKey(request: NextRequest): string {
  // X-Forwarded-For is client-controlled; trusted only behind our own proxy (ADMIN_TRUST_PROXY=1).
  if (config.trustProxy) return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "direct";
  return "direct";
}

export function take(kind: keyof typeof LIMITS, key: string, now = Date.now()): boolean {
  const k = `${kind}:${key}`;
  const h = hits.get(k);
  if (!h || now - h.start >= WINDOW_MS) {
    hits.set(k, { start: now, n: 1 });
    if (hits.size > 10_000) hits.clear();
    return true;
  }
  h.n += 1;
  // eslint-disable-next-line security/detect-object-injection -- kind is a literal union key
  return h.n <= LIMITS[kind];
}

export function resetLimits(): void {
  hits.clear();
}

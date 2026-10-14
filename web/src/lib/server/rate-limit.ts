import { headers } from "next/headers";

/**
 * In-memory token buckets for the prototype (one server process). Production rate limiting sits at
 * the edge (WAF / API gateway, threat model §4.4) keyed on the real client address, with a shared
 * store; this layer only keeps a single demo server from being flooded.
 *
 * Signed-in actions are keyed by investor id (cannot be spoofed). Anonymous actions are keyed by
 * the client address the server sees; in this prototype the server binds to 127.0.0.1 only.
 */
export type Limit = "login" | "signup" | "order" | "topup" | "cancel" | "verify" | "invest" | "publicVerify" | "reserve" | "passkeyLogin" | "passkey";

const RULES: Record<Limit, { capacity: number; perMinute: number }> = {
  login: { capacity: 10, perMinute: 10 },
  signup: { capacity: 10, perMinute: 2 },
  invest: { capacity: 10, perMinute: 10 },
  order: { capacity: 30, perMinute: 30 },
  topup: { capacity: 10, perMinute: 5 },
  cancel: { capacity: 30, perMinute: 30 },
  verify: { capacity: 20, perMinute: 20 },
  // Public verification page (S-07 PV-31): on-chain proof checks by anyone, keyed by client address.
  publicVerify: { capacity: 20, perMinute: 20 },
  // Offering reservations and cancellations (S-02), keyed by investor id.
  reserve: { capacity: 10, perMinute: 10 },
  // Passkey sign-in (T-030), keyed by client address; the database also locks an investor's
  // ceremonies after 10 failures in 15 minutes (migration 0024 IP-7).
  passkeyLogin: { capacity: 10, perMinute: 10 },
  // Passkey registration, step-up and revocation, keyed by investor id.
  passkey: { capacity: 20, perMinute: 20 },
};

const MAX_KEYS = 10_000;
const buckets = new Map<string, { tokens: number; at: number }>();

/** Takes one token for (limit, key); false when the bucket is empty. `now` is for tests. */
export function take(limit: Limit, key: string, now = Date.now()): boolean {
  // eslint-disable-next-line security/detect-object-injection -- `limit` is a fixed literal union
  const rule = RULES[limit];
  const id = `${limit}:${key}`;
  const b = buckets.get(id) ?? { tokens: rule.capacity, at: now };
  b.tokens = Math.min(rule.capacity, b.tokens + ((now - b.at) / 60_000) * rule.perMinute);
  b.at = now;
  if (b.tokens < 1) {
    buckets.set(id, b);
    return false;
  }
  b.tokens -= 1;
  buckets.delete(id); // re-insert so Map order is least-recently-used first
  buckets.set(id, b);
  if (buckets.size > MAX_KEYS) {
    const oldest = buckets.keys().next().value;
    if (oldest !== undefined) buckets.delete(oldest);
  }
  return true;
}

/**
 * Key for anonymous limits. X-Forwarded-For is client-controlled unless a trusted proxy sets it, so
 * it is used only with TRUST_PROXY=1 (behind a proxy that overwrites it). Otherwise every
 * anonymous caller shares one key: right for this prototype, which listens on 127.0.0.1 only.
 */
export async function clientKey(): Promise<string> {
  return keyFromForwarded((await headers()).get("x-forwarded-for"));
}

export function keyFromForwarded(xff: string | null): string {
  if (process.env.TRUST_PROXY !== "1") return "local";
  const first = xff?.split(",")[0]?.trim();
  return first && /^[0-9a-fA-F:.]{2,45}$/.test(first) ? first : "local";
}

// ------------------------------------------------------------------ SSE connection caps

const PER_CLIENT_STREAMS = 8;
const TOTAL_STREAMS = 200;
const streams = new Map<string, number>();
let totalStreams = 0;

/** Reserves a live-feed connection slot; returns a release function, or null when full. */
export function openStream(key: string): (() => void) | null {
  const mine = streams.get(key) ?? 0;
  if (mine >= PER_CLIENT_STREAMS || totalStreams >= TOTAL_STREAMS) return null;
  streams.set(key, mine + 1);
  totalStreams++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    totalStreams--;
    const n = (streams.get(key) ?? 1) - 1;
    if (n <= 0) streams.delete(key);
    else streams.set(key, n);
  };
}

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * HMAC authentication for the internal service APIs (signing service, KYC service). Every request
 * carries an HMAC-SHA256 over method, path, timestamp, a one-time nonce and the body hash. Stale
 * (more than 30 s skew) or replayed requests are refused. Each client may call only the paths in its
 * scope, so a client that may create wallets cannot ask for signatures. Production adds mTLS on a
 * private network; this layer stays as the application-level check.
 */

export interface Client {
  id: string;
  secret: Buffer;
  /** Paths this client may call; undefined = every authenticated path of the service. */
  scope?: readonly string[];
}

export const MAX_SKEW_MS = 30_000;

export function mac(secret: Buffer, method: string, path: string, ts: string, nonce: string, body: string): string {
  const bodyHash = createHash("sha256").update(body).digest("hex");
  return createHmac("sha256", secret).update(`${method}\n${path}\n${ts}\n${nonce}\n${bodyHash}`).digest("hex");
}

/** Headers for one request (client side). */
export function authHeaders(client: Pick<Client, "id" | "secret">, method: string, path: string, body: string, now = Date.now()): Record<string, string> {
  const ts = String(now);
  const nonce = randomBytes(16).toString("hex");
  return { "x-pt-client": client.id, "x-pt-ts": ts, "x-pt-nonce": nonce, "x-pt-sig": mac(client.secret, method, path, ts, nonce, body) };
}

export type AuthResult = { ok: true; client: Client } | { ok: false; status: 401 | 403 };

/** Server side: checks signature, skew, replay and scope. Keeps seen nonces for twice the skew. */
export class HmacAuthenticator {
  private readonly byId: Map<string, Client>;
  private readonly seen = new Map<string, number>();

  constructor(
    clients: readonly Client[],
    private readonly now: () => number = Date.now,
  ) {
    for (const c of clients) {
      if (!/^[a-z][a-z0-9-]{1,40}$/.test(c.id)) throw new Error(`invalid client id ${c.id}`);
      if (c.secret.length < 32) throw new Error(`client ${c.id}: the secret must be at least 32 bytes`);
    }
    this.byId = new Map(clients.map((c) => [c.id, c]));
  }

  authenticate(req: IncomingMessage, path: string, body: string): AuthResult {
    const id = req.headers["x-pt-client"];
    const ts = req.headers["x-pt-ts"];
    const nonce = req.headers["x-pt-nonce"];
    const sig = req.headers["x-pt-sig"];
    if (typeof id !== "string" || typeof ts !== "string" || typeof nonce !== "string" || typeof sig !== "string") return { ok: false, status: 401 };
    const client = this.byId.get(id);
    if (!client || !/^\d{13}$/.test(ts) || !/^[0-9a-f]{32}$/.test(nonce) || !/^[0-9a-f]{64}$/.test(sig)) return { ok: false, status: 401 };
    const t = this.now();
    if (Math.abs(t - Number(ts)) > MAX_SKEW_MS) return { ok: false, status: 401 };
    const expected = Buffer.from(mac(client.secret, req.method ?? "", path, ts, nonce, body), "hex");
    if (!timingSafeEqual(expected, Buffer.from(sig, "hex"))) return { ok: false, status: 401 };
    for (const [k, exp] of this.seen) if (exp < t) this.seen.delete(k);
    const key = `${id}:${nonce}`;
    if (this.seen.has(key)) return { ok: false, status: 401 };
    this.seen.set(key, t + 2 * MAX_SKEW_MS);
    // Authenticated, but this client may not call this path.
    if (client.scope && !client.scope.includes(path)) return { ok: false, status: 403 };
    return { ok: true, client };
  }
}

/** Reads a request body up to `max` bytes; null if it is larger. */
export async function readBody(req: IncomingMessage, max: number): Promise<string | null> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function bigintSafe(_k: string, v: unknown): unknown {
  return typeof v === "bigint" ? v.toString() : v;
}

export function sendJson(res: ServerResponse, code: number, body: unknown): void {
  const s = JSON.stringify(body, bigintSafe);
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store", "content-length": Buffer.byteLength(s) });
  res.end(s);
}

/** A client secret from the environment: base64url of at least 32 bytes. Values are never echoed. */
export function secretFromEnv(env: Record<string, string | undefined>, name: string): Buffer {
  // eslint-disable-next-line security/detect-object-injection -- name is a fixed key chosen by our code
  const v = env[name];
  if (!v || !/^[A-Za-z0-9_-]{43,}$/.test(v)) throw new Error(`${name} is missing or too short (run the setup command)`);
  return Buffer.from(v, "base64url");
}

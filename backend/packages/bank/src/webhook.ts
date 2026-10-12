import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/**
 * Signed webhooks from the bank (Raast credits, payout returns), ADR 0009 B-1.
 *
 * Header:  x-pt-bank-signature: t=<unix ms>,kid=<key id>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
 * - The HMAC covers the exact raw bytes, so a re-serialised or edited body fails.
 * - Timestamps more than 5 minutes from now are refused (stale or future).
 * - Two keys can be active at once (rotation): each has an id.
 * - Replays inside the window are harmless: the event id is recorded once in the database
 *   (bank.ingest_event), so the second delivery is answered "duplicate" and books nothing.
 * The real bank's scheme is not known yet; this mock fixes the properties any scheme must have.
 */

export interface WebhookKey {
  id: string;
  secret: Buffer;
}

export const SIGNATURE_HEADER = "x-pt-bank-signature";
export const MAX_SKEW_MS = 5 * 60_000;
export const MAX_BODY = 16 * 1024;

export function signWebhook(key: WebhookKey, rawBody: string, now = Date.now()): string {
  const t = String(now);
  const mac = createHmac("sha256", key.secret).update(`${t}.${rawBody}`, "utf8").digest("hex");
  return `t=${t},kid=${key.id},v1=${mac}`;
}

export type SignatureCheck = { ok: true; keyId: string } | { ok: false; why: "missing" | "malformed" | "unknown_key" | "stale" | "bad_signature" };

export function verifyWebhook(keys: readonly WebhookKey[], header: string | undefined, rawBody: string, now = Date.now()): SignatureCheck {
  if (!header) return { ok: false, why: "missing" };
  const m = /^t=([0-9]{13}),kid=([a-z0-9][a-z0-9-]{0,31}),v1=([0-9a-f]{64})$/.exec(header);
  if (!m?.[1] || !m[2] || !m[3]) return { ok: false, why: "malformed" };
  const key = keys.find((k) => k.id === m[2]);
  if (!key) return { ok: false, why: "unknown_key" };
  if (Math.abs(now - Number(m[1])) > MAX_SKEW_MS) return { ok: false, why: "stale" };
  const expected = createHmac("sha256", key.secret).update(`${m[1]}.${rawBody}`, "utf8").digest();
  if (!timingSafeEqual(expected, Buffer.from(m[3], "hex"))) return { ok: false, why: "bad_signature" };
  return { ok: true, keyId: key.id };
}

export function bodyHash(rawBody: string): Buffer {
  return createHash("sha256").update(rawBody, "utf8").digest();
}

export interface WebhookHandler {
  /** Called only for a verified body. Returns the HTTP status and response body. */
  handle(rawBody: string, keyId: string): Promise<{ status: number; body: unknown }>;
}

/**
 * The webhook endpoint: POST /v1/bank/events. Bound to an internal interface; in production behind
 * the bank's mTLS link or IP allow-list. Errors never echo internals.
 */
export function createWebhookServer(handler: WebhookHandler, keys: readonly WebhookKey[], opts: { now?: () => number; onError?: (e: unknown) => void } = {}): Server {
  const now = opts.now ?? Date.now;
  const send = (res: ServerResponse, code: number, body: unknown): void => {
    const s = JSON.stringify(body);
    res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store", "content-length": Buffer.byteLength(s) });
    res.end(s);
  };
  const readBody = async (req: IncomingMessage): Promise<string | null> => {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY) return null;
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
  };
  return createServer((req, res) => {
    void (async () => {
      try {
        const path = new URL(req.url ?? "/", "http://internal").pathname;
        if (req.method === "GET" && path === "/v1/health") {
          send(res, 200, { ok: true });
          return;
        }
        if (req.method !== "POST" || path !== "/v1/bank/events") {
          send(res, 404, { error: "not_found" });
          return;
        }
        if (!(req.headers["content-type"] ?? "").startsWith("application/json")) {
          send(res, 415, { error: "json_only" });
          return;
        }
        const body = await readBody(req);
        if (body === null) {
          send(res, 413, { error: "too_large" });
          return;
        }
        const header = req.headers["x-pt-bank-signature"];
        const check = verifyWebhook(keys, typeof header === "string" ? header : undefined, body, now());
        if (!check.ok) {
          send(res, 401, { error: "unauthorized" });
          return;
        }
        const r = await handler.handle(body, check.keyId);
        send(res, r.status, r.body);
      } catch (e) {
        opts.onError?.(e);
        // 500 makes the bank retry; the event id keeps the retry harmless.
        send(res, 500, { error: "internal" });
      }
    })();
  });
}

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { z } from "zod";
import type { SignInput, SignResult } from "./service.ts";

/**
 * Internal HTTP API of the signing service. Bound to an internal interface only (127.0.0.1 here;
 * a private network with mTLS in production). Every request is authenticated with an HMAC over
 * method, path, timestamp, a one-time nonce and the body hash; stale or replayed requests and
 * oversized bodies are refused. Errors never echo internals.
 */

export interface SignerApi {
  request(input: SignInput, requestedBy: string): Promise<SignResult>;
  markBroadcast(requestId: string, actor: string): Promise<boolean>;
  release(requestId: string, actor: string): Promise<boolean>;
}

export interface Client {
  id: string;
  secret: Buffer;
}

const MAX_BODY = 32 * 1024;
const MAX_SKEW_MS = 30_000;

function mac(secret: Buffer, method: string, path: string, ts: string, nonce: string, body: string): string {
  const bodyHash = createHash("sha256").update(body).digest("hex");
  return createHmac("sha256", secret).update(`${method}\n${path}\n${ts}\n${nonce}\n${bodyHash}`).digest("hex");
}

export function authHeaders(client: Client, method: string, path: string, body: string, now = Date.now()): Record<string, string> {
  const ts = String(now);
  const nonce = randomBytes(16).toString("hex");
  return { "x-pt-client": client.id, "x-pt-ts": ts, "x-pt-nonce": nonce, "x-pt-sig": mac(client.secret, method, path, ts, nonce, body) };
}

const idBody = z.object({ requestId: z.uuid() });

function bigintSafe(_k: string, v: unknown): unknown {
  return typeof v === "bigint" ? v.toString() : v;
}

export function createSignerServer(api: SignerApi, clients: Client[], opts: { now?: () => number } = {}): Server {
  const byId = new Map(clients.map((c) => [c.id, c]));
  const seen = new Map<string, number>(); // replay protection: nonce -> expiry
  const now = opts.now ?? Date.now;

  const send = (res: ServerResponse, code: number, body: unknown) => {
    const s = JSON.stringify(body, bigintSafe);
    res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store", "content-length": Buffer.byteLength(s) });
    res.end(s);
  };

  async function readBody(req: IncomingMessage): Promise<string | null> {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY) return null;
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  function authenticate(req: IncomingMessage, path: string, body: string): Client | null {
    const id = req.headers["x-pt-client"];
    const ts = req.headers["x-pt-ts"];
    const nonce = req.headers["x-pt-nonce"];
    const sig = req.headers["x-pt-sig"];
    if (typeof id !== "string" || typeof ts !== "string" || typeof nonce !== "string" || typeof sig !== "string") return null;
    const client = byId.get(id);
    if (!client || !/^\d{13}$/.test(ts) || !/^[0-9a-f]{32}$/.test(nonce) || !/^[0-9a-f]{64}$/.test(sig)) return null;
    const t = now();
    if (Math.abs(t - Number(ts)) > MAX_SKEW_MS) return null;
    const expected = Buffer.from(mac(client.secret, req.method ?? "", path, ts, nonce, body), "hex");
    if (!timingSafeEqual(expected, Buffer.from(sig, "hex"))) return null;
    for (const [k, exp] of seen) if (exp < t) seen.delete(k);
    const key = `${id}:${nonce}`;
    if (seen.has(key)) return null;
    seen.set(key, t + 2 * MAX_SKEW_MS);
    return client;
  }

  return createServer((req, res) => {
    void (async () => {
      try {
        const path = new URL(req.url ?? "/", "http://internal").pathname;
        if (req.method === "GET" && path === "/v1/health") {
          send(res, 200, { ok: true });
          return;
        }
        if (req.method !== "POST" || !["/v1/sign", "/v1/broadcast", "/v1/release"].includes(path)) {
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
        const client = authenticate(req, path, body);
        if (!client) {
          send(res, 401, { error: "unauthorized" });
          return;
        }
        let json: unknown;
        try {
          json = JSON.parse(body);
        } catch {
          send(res, 400, { error: "bad_json" });
          return;
        }
        if (path === "/v1/sign") {
          send(res, 200, await api.request(json as SignInput, client.id));
          return;
        }
        const parsed = idBody.safeParse(json);
        if (!parsed.success) {
          send(res, 400, { error: "bad_request" });
          return;
        }
        const ok = path === "/v1/broadcast" ? await api.markBroadcast(parsed.data.requestId, client.id) : await api.release(parsed.data.requestId, client.id);
        send(res, 200, { ok });
      } catch (e) {
        // Validation errors are the caller's; anything else is internal and not echoed.
        if (e instanceof z.ZodError) send(res, 400, { error: "bad_request" });
        else send(res, 500, { error: "internal" });
      }
    })();
  });
}

/** Typed client for the signer API. */
export class SignerClient {
  constructor(
    private readonly baseUrl: string,
    private readonly client: Client,
  ) {}

  private async post(path: string, body: unknown): Promise<unknown> {
    const s = JSON.stringify(body);
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(this.client, "POST", path, s) },
      body: s,
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`signer ${path} returned ${String(res.status)}`);
    return res.json();
  }

  async sign(input: SignInput): Promise<SignResult> {
    const r = (await this.post("/v1/sign", input)) as Record<string, unknown>;
    if (r.status === "signed" || r.status === "broadcast") return { ...r, nonce: BigInt(r.nonce as string) } as SignResult;
    return r as SignResult;
  }

  async broadcast(requestId: string): Promise<boolean> {
    return ((await this.post("/v1/broadcast", { requestId })) as { ok: boolean }).ok;
  }

  async release(requestId: string): Promise<boolean> {
    return ((await this.post("/v1/release", { requestId })) as { ok: boolean }).ok;
  }
}

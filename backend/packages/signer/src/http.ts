import { createServer, type Server } from "node:http";
import { authHeaders, HmacAuthenticator, readBody, sendJson, type Client } from "@pt/http-auth";
import { z } from "zod";
import type { SignInput, SignResult } from "./service.ts";

/**
 * Internal HTTP API of the signing service. Bound to an internal interface only (127.0.0.1 here;
 * a private network with mTLS in production). Every request is authenticated with an HMAC over
 * method, path, timestamp, a one-time nonce and the body hash (@pt/http-auth); stale or replayed
 * requests and oversized bodies are refused, and each client may call only its own paths (the
 * website may create custodial wallets but never ask for a signature). Errors never echo internals.
 */

export interface SignerApi {
  request(input: SignInput, requestedBy: string): Promise<SignResult>;
  markBroadcast(requestId: string, actor: string): Promise<boolean>;
  release(requestId: string, actor: string): Promise<boolean>;
  /** Creates a custodial wallet inside the signing service; returns its address only. */
  createWallet?(createdBy: string): Promise<{ address: string }>;
}

export { authHeaders, type Client };

const MAX_BODY = 32 * 1024;
const PATHS = ["/v1/sign", "/v1/broadcast", "/v1/release", "/v1/custody/wallets"] as const;
/** What the outbox worker may call; the website's client is limited to custody. */
export const OUTBOX_SCOPE = ["/v1/sign", "/v1/broadcast", "/v1/release"] as const;
export const WEB_SCOPE = ["/v1/custody/wallets"] as const;

const idBody = z.object({ requestId: z.uuid() });
const walletBody = z.strictObject({});

export function createSignerServer(api: SignerApi, clients: Client[], opts: { now?: () => number } = {}): Server {
  const auth = new HmacAuthenticator(clients, opts.now);

  return createServer((req, res) => {
    void (async () => {
      try {
        const path = new URL(req.url ?? "/", "http://internal").pathname;
        if (req.method === "GET" && path === "/v1/health") {
          sendJson(res, 200, { ok: true });
          return;
        }
        if (req.method !== "POST" || !(PATHS as readonly string[]).includes(path)) {
          sendJson(res, 404, { error: "not_found" });
          return;
        }
        if (!(req.headers["content-type"] ?? "").startsWith("application/json")) {
          sendJson(res, 415, { error: "json_only" });
          return;
        }
        const body = await readBody(req, MAX_BODY);
        if (body === null) {
          sendJson(res, 413, { error: "too_large" });
          return;
        }
        const a = auth.authenticate(req, path, body);
        if (!a.ok) {
          sendJson(res, a.status, { error: a.status === 403 ? "forbidden" : "unauthorized" });
          return;
        }
        let json: unknown;
        try {
          json = JSON.parse(body);
        } catch {
          sendJson(res, 400, { error: "bad_json" });
          return;
        }
        if (path === "/v1/sign") {
          sendJson(res, 200, await api.request(json as SignInput, a.client.id));
          return;
        }
        if (path === "/v1/custody/wallets") {
          if (!api.createWallet || !walletBody.safeParse(json).success) {
            sendJson(res, api.createWallet ? 400 : 404, { error: api.createWallet ? "bad_request" : "not_found" });
            return;
          }
          sendJson(res, 200, await api.createWallet(a.client.id));
          return;
        }
        const parsed = idBody.safeParse(json);
        if (!parsed.success) {
          sendJson(res, 400, { error: "bad_request" });
          return;
        }
        const ok = path === "/v1/broadcast" ? await api.markBroadcast(parsed.data.requestId, a.client.id) : await api.release(parsed.data.requestId, a.client.id);
        sendJson(res, 200, { ok });
      } catch (e) {
        // Validation errors are the caller's; anything else is internal and not echoed.
        if (e instanceof z.ZodError) sendJson(res, 400, { error: "bad_request" });
        else sendJson(res, 500, { error: "internal" });
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

  async createWallet(): Promise<{ address: string }> {
    return (await this.post("/v1/custody/wallets", {})) as { address: string };
  }
}

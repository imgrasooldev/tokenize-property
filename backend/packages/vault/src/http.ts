import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { HmacAuthenticator, readBody, sendJson, type Client } from "@pt/http-auth";
import { Vault, VaultError } from "./store.ts";

/**
 * The vault service's HTTP API (127.0.0.1:VAULT_PORT, 4950), HMAC client authentication as every
 * backend service (@pt/http-auth):
 *   POST /v1/public-document {sha256}            decrypted bytes of a published document (client "web" only)
 *   POST /v1/store {mediaType, officer, dataBase64}  encrypt and store one file (client "admin-portal" only,
 *                                                 for an officer the portal signed in with a fresh step-up)
 */
export const WEB_VAULT_SCOPE = ["/v1/public-document"] as const;
export const ADMIN_VAULT_SCOPE = ["/v1/store"] as const;
const MAX_STORE_BYTES = 25 * 1024 * 1024;

async function handle(vault: Vault, auth: HmacAuthenticator, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = (req.url ?? "").split("?")[0] ?? "";
  if (req.method === "GET" && path === "/v1/health") {
    sendJson(res, 200, { ok: true });
    return;
  }
  if (req.method === "POST" && path === "/v1/store") {
    await store(vault, auth, req, res, path);
    return;
  }
  if (req.method !== "POST" || path !== "/v1/public-document") {
    sendJson(res, 404, { error: "not found" });
    return;
  }
  const body = await readBody(req, 1024);
  if (body === null) {
    sendJson(res, 413, { error: "too large" });
    return;
  }
  const a = auth.authenticate(req, path, body);
  if (!a.ok) {
    sendJson(res, a.status, { error: "unauthorized" });
    return;
  }
  let sha: unknown;
  try {
    sha = (JSON.parse(body) as { sha256?: unknown }).sha256;
  } catch {
    sha = undefined;
  }
  if (typeof sha !== "string") {
    sendJson(res, 400, { error: "invalid" });
    return;
  }
  try {
    const doc = await vault.get(sha, a.client.id, "public");
    res.writeHead(200, { "content-type": doc.media, "content-length": doc.bytes.length, "cache-control": "no-store", "x-content-sha256": sha });
    res.end(doc.bytes);
  } catch (e) {
    if (!(e instanceof VaultError)) {
      process.stderr.write(`vault read failed: ${e instanceof Error ? e.name : "error"}\n`);
      sendJson(res, 500, { error: "internal" });
      return;
    }
    // NOT_PUBLIC and NOT_FOUND read the same: nobody learns what the vault holds.
    if (e.code === "INVALID") sendJson(res, 400, { error: "invalid" });
    else if (e.code === "CORRUPT") sendJson(res, 500, { error: "corrupt" });
    else sendJson(res, 404, { error: "not found" });
  }
}

async function store(vault: Vault, auth: HmacAuthenticator, req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  const body = await readBody(req, Math.ceil((MAX_STORE_BYTES * 4) / 3) + 1024);
  if (body === null) {
    sendJson(res, 413, { error: "a document is at most 25 MB here" });
    return;
  }
  const a = auth.authenticate(req, path, body);
  if (!a.ok) {
    sendJson(res, a.status, { error: "unauthorized" });
    return;
  }
  let p: { mediaType?: unknown; officer?: unknown; dataBase64?: unknown };
  try {
    p = JSON.parse(body) as typeof p;
  } catch {
    p = {};
  }
  if (typeof p.mediaType !== "string" || typeof p.officer !== "string" || !/^[a-z][a-z0-9._-]{2,39}$/.test(p.officer) || typeof p.dataBase64 !== "string") {
    sendJson(res, 400, { error: "invalid" });
    return;
  }
  try {
    const r = await vault.put(Buffer.from(p.dataBase64, "base64"), p.mediaType, `officer:${p.officer}`);
    sendJson(res, 200, r);
  } catch (e) {
    if (e instanceof VaultError) {
      sendJson(res, 400, { error: e.message });
      return;
    }
    process.stderr.write(`vault store failed: ${e instanceof Error ? e.name : "error"}\n`);
    sendJson(res, 500, { error: "internal" });
  }
}

export function createVaultServer(vault: Vault, clients: readonly Client[]): Server {
  const auth = new HmacAuthenticator(clients);
  return createServer((req, res) => {
    void handle(vault, auth, req, res);
  });
}

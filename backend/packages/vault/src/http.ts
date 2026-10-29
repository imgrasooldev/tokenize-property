import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { HmacAuthenticator, readBody, sendJson, type Client } from "@pt/http-auth";
import { Vault, VaultError } from "./store.ts";

/**
 * The vault service's HTTP API (127.0.0.1:VAULT_PORT, 4950): POST /v1/public-document {sha256}
 * returns the decrypted bytes of a published document (the website's client "web" may call nothing
 * else). HMAC client authentication as every backend service (@pt/http-auth).
 */
export const WEB_VAULT_SCOPE = ["/v1/public-document"] as const;

async function handle(vault: Vault, auth: HmacAuthenticator, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = (req.url ?? "").split("?")[0] ?? "";
  if (req.method === "GET" && path === "/v1/health") {
    sendJson(res, 200, { ok: true });
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

export function createVaultServer(vault: Vault, clients: readonly Client[]): Server {
  const auth = new HmacAuthenticator(clients);
  return createServer((req, res) => {
    void handle(vault, auth, req, res);
  });
}

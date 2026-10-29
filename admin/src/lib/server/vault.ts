import { createHash, createHmac, randomBytes } from "node:crypto";
import { config } from "./config";
import { db } from "./db";

/**
 * The portal's client of the document vault (ADR 0017, migration 0042). The portal holds no vault
 * key: it audits the upload in the admin database first (admin.vault_upload: operations maker,
 * fresh step-up), then sends the file once to the vault service, which encrypts and stores it under
 * the officer's handle. Same HMAC request authentication as @pt/http-auth.
 */
const SECRET = /^[A-Za-z0-9_-]{43,}$/;
const PATH = "/v1/store";

export function vaultConfigured(): boolean {
  return SECRET.test(config.vaultService.secret);
}

export interface VaultObject {
  sha256: string;
  size: number;
  media: string;
  by: string;
  at: string;
  published: boolean;
  reads: number;
}

export async function vaultObjects(sessionHash: Buffer): Promise<VaultObject[]> {
  const { rows } = await db().query<{ v: VaultObject[] }>("SELECT admin.vault_objects($1) AS v", [sessionHash]);
  return rows[0]?.v ?? [];
}

export type StoreResult = { ok: true; sha256: string; storeRef: string } | { ok: false; error: string };

export async function storeInVault(sessionHash: Buffer, bytes: Buffer, media: string): Promise<StoreResult> {
  if (!vaultConfigured()) return { ok: false, error: "The vault client is not configured (VAULT_CLIENT_SECRET_ADMIN): nothing was stored." };
  const sha = createHash("sha256").update(bytes).digest();
  const { rows } = await db().query<{ r: { ok: boolean; officer?: string; error?: string } }>("SELECT admin.vault_upload($1, $2, $3, $4) AS r", [
    sessionHash,
    sha,
    bytes.length,
    media,
  ]);
  const allowed = rows[0]?.r;
  if (!allowed?.ok || !allowed.officer) return { ok: false, error: allowed?.error ?? "refused" };
  const body = JSON.stringify({ mediaType: media, officer: allowed.officer, dataBase64: bytes.toString("base64") });
  const ts = String(Date.now());
  const nonce = randomBytes(16).toString("hex");
  const bodyHash = createHash("sha256").update(body).digest("hex");
  const sig = createHmac("sha256", Buffer.from(config.vaultService.secret, "base64url")).update(`POST\n${PATH}\n${ts}\n${nonce}\n${bodyHash}`).digest("hex");
  let res: Response;
  try {
    res = await fetch(`${config.vaultService.url}${PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-pt-client": "admin-portal", "x-pt-ts": ts, "x-pt-nonce": nonce, "x-pt-sig": sig },
      body,
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    return { ok: false, error: "The vault service is not reachable: nothing was stored." };
  }
  const json = (await res.json().catch(() => null)) as { sha256?: string; storeRef?: string; error?: string } | null;
  if (res.status !== 200 || !json?.sha256 || !json.storeRef) return { ok: false, error: `The vault refused the file: ${(json?.error ?? String(res.status)).slice(0, 200)}` };
  if (json.sha256 !== sha.toString("hex")) return { ok: false, error: "The vault stored a different hash: check the service." };
  return { ok: true, sha256: json.sha256, storeRef: json.storeRef };
}

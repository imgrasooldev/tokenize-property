import { createHash, createHmac, randomBytes } from "node:crypto";
import { config } from "./config";

/**
 * The portal's client of the tax service (ADR 0014). Same request authentication as the backend's
 * @pt/http-auth (HMAC-SHA256 over method, path, timestamp, one-time nonce and body hash), with its
 * own client id and secret. The service gives this client exactly one path: generate an approved
 * FBR filing export with the one-time ticket the admin database issued to one of the export's two
 * officers. The portal never holds the CNIC key; the file passes through once, unlogged.
 */
const SECRET = /^[A-Za-z0-9_-]{43,}$/;
const PATH = "/v1/filing-exports/generate";

export function taxServiceConfigured(): boolean {
  return SECRET.test(config.taxService.secret);
}

export interface GeneratedExport {
  fileName: string;
  csv: Buffer;
  sha256: string;
  rows: number;
  record: { audit: number; auditHash: string; at: string; officer: string };
}

export type GenerateResult = { ok: true; file: GeneratedExport } | { ok: false; error: string };

export async function generateExport(exportId: string, ticket: Buffer): Promise<GenerateResult> {
  if (!taxServiceConfigured()) return { ok: false, error: "The tax service client is not configured (TAX_CLIENT_SECRET_ADMIN): no export can be generated." };
  const body = JSON.stringify({ exportId, ticket: ticket.toString("base64url") });
  const ts = String(Date.now());
  const nonce = randomBytes(16).toString("hex");
  const bodyHash = createHash("sha256").update(body).digest("hex");
  const sig = createHmac("sha256", Buffer.from(config.taxService.secret, "base64url")).update(`POST\n${PATH}\n${ts}\n${nonce}\n${bodyHash}`).digest("hex");
  let res: Response;
  try {
    res = await fetch(`${config.taxService.url}${PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-pt-client": config.taxService.clientId, "x-pt-ts": ts, "x-pt-nonce": nonce, "x-pt-sig": sig },
      body,
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    return { ok: false, error: "The tax service is not reachable: nothing was generated." };
  }
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (res.status === 409) return { ok: false, error: `Refused by the tax service: ${typeof json?.error === "string" ? json.error.slice(0, 250) : "refused"}` };
  if (res.status !== 200 || !json) return { ok: false, error: `The tax service answered ${String(res.status)}: nothing was released.` };
  const csv = Buffer.from(String(json.csv), "base64");
  const sha256 = String(json.sha256);
  // The file must be exactly what the tax service recorded before release.
  if (createHash("sha256").update(csv).digest("hex") !== sha256) return { ok: false, error: "The file does not match its recorded digest: not released." };
  return {
    ok: true,
    file: { fileName: String(json.fileName), csv, sha256, rows: Number(json.rows), record: json.record as GeneratedExport["record"] },
  };
}

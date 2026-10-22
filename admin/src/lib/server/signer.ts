import { createHash, createHmac, randomBytes } from "node:crypto";
import { config } from "./config";

/**
 * The portal's client of the signing service (ADR 0005, Step 6b). Same request authentication as
 * the backend's @pt/http-auth (HMAC-SHA256 over method, path, timestamp, one-time nonce and body
 * hash), with its own client id and secret. The service gives this client exactly three paths:
 * preview a pending request, decide it with a one-time ticket from the admin database, and create a
 * custodial wallet for a wallet-recovery case (S-06). It can never ask for a signature. No code is
 * shared with the backend at runtime (separate app).
 */

export interface CallArg {
  name: string;
  type: string;
  value: string;
}

/** Mirrors backend/packages/signer/src/preview.ts (CallPreview v1). */
export interface CallPreview {
  version: 1;
  requestId: string;
  kind: string;
  chainId: number;
  policyId: string;
  policyVersion: number;
  from: string | null;
  to: string;
  contract: string;
  functionName: string;
  args: CallArg[];
  data: string | null;
  selector: string;
  gasLimit: string;
  payloadHash: string;
  callHash: string;
  rules: string[];
  note: string | null;
}

export interface SignerPreview {
  requestId: string;
  status: string;
  call: CallPreview | null;
  problem: string | null;
  live: { state: "pass" | "fail" | "unavailable" | "skipped"; reason: string | null; approvalsNeeded: number | null };
}

export type DecideResult = { status: string; reason?: string };

const SECRET = /^[A-Za-z0-9_-]{43,}$/;

export function signerConfigured(): boolean {
  return SECRET.test(config.signer.secret);
}

function headers(path: string, body: string): Record<string, string> {
  const ts = String(Date.now());
  const nonce = randomBytes(16).toString("hex");
  const bodyHash = createHash("sha256").update(body).digest("hex");
  const sig = createHmac("sha256", Buffer.from(config.signer.secret, "base64url"))
    .update(`POST\n${path}\n${ts}\n${nonce}\n${bodyHash}`)
    .digest("hex");
  return { "content-type": "application/json", "x-pt-client": config.signer.clientId, "x-pt-ts": ts, "x-pt-nonce": nonce, "x-pt-sig": sig };
}

async function post(path: string, body: unknown, timeoutMs: number): Promise<{ status: number; json: unknown }> {
  if (!signerConfigured()) throw new Error("the signing service client is not configured (SIGNER_CLIENT_SECRET_ADMIN)");
  const s = JSON.stringify(body);
  const res = await fetch(`${config.signer.url}${path}`, { method: "POST", headers: headers(path, s), body: s, signal: AbortSignal.timeout(timeoutMs) });
  const json: unknown = await res.json().catch(() => null);
  return { status: res.status, json };
}

/** What the signing service would sign for this request (null: unknown request). Throws if unreachable. */
export async function signerPreview(requestId: string): Promise<SignerPreview | null> {
  const r = await post("/v1/requests/preview", { requestId }, 8_000);
  if (r.status === 404) return null;
  if (r.status !== 200) throw new Error(`signing service answered ${String(r.status)}`);
  return r.json as SignerPreview;
}

/**
 * S-06 RF-9: a new custodial wallet inside the signing service for a wallet-recovery case. Only the
 * address comes back; the key has no rights until an executed recovery binds it.
 */
export async function signerCreateWallet(): Promise<string> {
  const r = await post("/v1/custody/wallets", {}, 15_000);
  const address = (r.json as { address?: unknown } | null)?.address;
  if (r.status !== 200 || typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error(`signing service answered ${String(r.status)}`);
  return address.toLowerCase();
}

/** The decision, carried by the one-time ticket the admin database issued for it. */
export async function signerDecide(input: { requestId: string; decision: "approve" | "reject"; reason: string; ticket: string; callHash: string }): Promise<DecideResult> {
  const r = await post("/v1/decide", input, 15_000);
  if (r.status !== 200) throw new Error(`signing service answered ${String(r.status)}`);
  return r.json as DecideResult;
}

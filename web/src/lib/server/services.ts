import { createHash, createHmac, randomBytes } from "node:crypto";
import type { Address } from "viem";
import { backendEnv } from "./db";

/**
 * Clients for the two backend services the website calls directly (ADR 0010): the signing
 * service, only to create a custodial wallet for a new investor (its client "web" may do nothing
 * else), and the KYC service for sign-up. Same HMAC request signing as backend/packages/http-auth
 * (method, path, time, one-time nonce, body hash). Secrets come from backend/.env.local; they are
 * never logged or sent anywhere else.
 */

function secret(name: "SIGNER_CLIENT_SECRET_WEB" | "KYC_CLIENT_SECRET_WEB"): Buffer {
  const v = backendEnv().get(name);
  if (!v || !/^[A-Za-z0-9_-]{43,}$/.test(v)) throw new Error(`${name} is not set up (backend: npm run signer:setup / npm run kyc:setup).`);
  return Buffer.from(v, "base64url");
}

async function post(baseUrl: string, path: string, key: Buffer, body: unknown): Promise<{ status: number; json: unknown }> {
  const s = JSON.stringify(body);
  const ts = String(Date.now());
  const nonce = randomBytes(16).toString("hex");
  const bodyHash = createHash("sha256").update(s).digest("hex");
  const sig = createHmac("sha256", key).update(`POST\n${path}\n${ts}\n${nonce}\n${bodyHash}`).digest("hex");
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-pt-client": "web", "x-pt-ts": ts, "x-pt-nonce": nonce, "x-pt-sig": sig },
    body: s,
    signal: AbortSignal.timeout(15_000),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

const signerUrl = (): string => process.env.SIGNER_URL ?? "http://127.0.0.1:4900";
const kycUrl = (): string => process.env.KYC_URL ?? "http://127.0.0.1:4910";

/** A new custodial wallet, generated and held by the signing service; only its address comes back. */
export async function createCustodialWallet(): Promise<Address> {
  const r = await post(signerUrl(), "/v1/custody/wallets", secret("SIGNER_CLIENT_SECRET_WEB"), {});
  const address = (r.json as { address?: unknown } | null)?.address;
  if (r.status !== 200 || typeof address !== "string" || !/^0x[0-9a-f]{40}$/.test(address)) throw new Error(`signing service returned ${String(r.status)}`);
  return address as Address;
}

export type KycCheck = { kind: "nadra" | "liveness" | "sanctions"; outcome: "pass" | "fail" | "review" | "error"; reason: string };
export type KycResult =
  | { ok: true; subjectId: string; status: string; reason: string; checks: KycCheck[] }
  | { ok: false; error: "duplicate" | "invalid" | "unavailable" };

/** Sign-up KYC through the KYC service (ADR 0009): the website keeps none of what it sends. */
export async function kycOnboard(input: { cnic: string; fullName: string; livenessSessionId: string; wallet: Address }): Promise<KycResult> {
  let r: { status: number; json: unknown };
  try {
    r = await post(kycUrl(), "/v1/onboard", secret("KYC_CLIENT_SECRET_WEB"), input);
  } catch {
    return { ok: false, error: "unavailable" };
  }
  if (r.status === 409) return { ok: false, error: "duplicate" };
  if (r.status === 400) return { ok: false, error: "invalid" };
  const j = r.json as { subjectId?: unknown; status?: unknown; reason?: unknown; checks?: unknown } | null;
  if (r.status !== 200 || typeof j?.subjectId !== "string" || typeof j.status !== "string" || !Array.isArray(j.checks)) return { ok: false, error: "unavailable" };
  return { ok: true, subjectId: j.subjectId, status: j.status, reason: typeof j.reason === "string" ? j.reason : "", checks: j.checks as KycCheck[] };
}

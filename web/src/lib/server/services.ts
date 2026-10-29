import { createHash, createHmac, randomBytes } from "node:crypto";
import type { Address } from "viem";
import { backendEnv } from "./db";

/**
 * Clients for the backend services the website calls directly (ADR 0010): the signing service,
 * only to create a custodial wallet for a new investor (its client "web" may do nothing else), the
 * KYC service for sign-up and the bank service for payout accounts (T-045). Same HMAC request
 * signing as backend/packages/http-auth (method, path, time, one-time nonce, body hash). Secrets
 * come from backend/.env.local; they are never logged or sent anywhere else.
 */

function secret(name: "SIGNER_CLIENT_SECRET_WEB" | "KYC_CLIENT_SECRET_WEB" | "BANK_CLIENT_SECRET_WEB" | "VAULT_CLIENT_SECRET_WEB"): Buffer {
  const v = backendEnv().get(name);
  if (!v || !/^[A-Za-z0-9_-]{43,}$/.test(v)) throw new Error(`${name} is not set up (backend: npm run signer:setup / kyc:setup / bank:setup / vault:setup).`);
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

const bankPayeesUrl = (): string => process.env.BANK_PAYEES_URL ?? "http://127.0.0.1:4920";

export type PayoutAccountError = "invalid_iban" | "title_not_found" | "title_mismatch" | "not_verified" | "in_use" | "unavailable";
const PAYOUT_ERRORS: readonly string[] = ["invalid_iban", "title_not_found", "title_mismatch", "not_verified", "in_use"];

/**
 * Registers or changes the signed-in investor's payout account through the bank service (T-045).
 * The website holds no KYC pepper and no BANK_DATA_KEY: the bank service hashes and seals the IBAN,
 * and the database checks the account title against the KYC-verified name and starts the 72-hour
 * cooling-off. `subjectId` must be the signed-in investor's own KYC subject.
 */
export async function registerPayoutAccount(input: {
  subjectId: string;
  iban: string;
  title: string;
}): Promise<{ ok: true; payeeId: string } | { ok: false; error: PayoutAccountError }> {
  let r: { status: number; json: unknown };
  try {
    r = await post(bankPayeesUrl(), "/v1/payees", secret("BANK_CLIENT_SECRET_WEB"), { subjectId: input.subjectId, iban: input.iban, title: input.title });
  } catch {
    return { ok: false, error: "unavailable" };
  }
  const j = r.json as { payeeId?: unknown; error?: unknown } | null;
  if (r.status === 200 && typeof j?.payeeId === "string" && /^[1-9][0-9]*$/.test(j.payeeId)) return { ok: true, payeeId: j.payeeId };
  // Known refusals pass through; a malformed request (400 "invalid") or any other answer is "unavailable".
  if (typeof j?.error === "string" && PAYOUT_ERRORS.includes(j.error)) return { ok: false, error: j.error as PayoutAccountError };
  return { ok: false, error: "unavailable" };
}

const vaultUrl = (): string => process.env.VAULT_URL ?? "http://127.0.0.1:4950";

/**
 * A published offering or property document from the document vault (T-038, ADR 0017): the vault
 * decides what is published and checks the bytes against the hash; null when it is not published
 * (or not stored). The website never holds a vault key.
 */
export async function publicDocument(sha256: string): Promise<{ bytes: Buffer; media: string } | null> {
  if (!/^[0-9a-f]{64}$/.test(sha256)) return null;
  const path = "/v1/public-document";
  const s = JSON.stringify({ sha256 });
  const key = secret("VAULT_CLIENT_SECRET_WEB");
  const ts = String(Date.now());
  const nonce = randomBytes(16).toString("hex");
  const sig = createHmac("sha256", key).update(`POST\n${path}\n${ts}\n${nonce}\n${createHash("sha256").update(s).digest("hex")}`).digest("hex");
  const res = await fetch(`${vaultUrl()}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-pt-client": "web", "x-pt-ts": ts, "x-pt-nonce": nonce, "x-pt-sig": sig },
    body: s,
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 404) return null;
  if (res.status !== 200) throw new Error(`vault service returned ${String(res.status)}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== sha256) throw new Error("the vault returned bytes that do not match the hash");
  return { bytes, media: res.headers.get("content-type") ?? "application/octet-stream" };
}


import { createHash, createHmac, randomBytes } from "node:crypto";
import { config } from "./config";
import { db } from "./db";

/**
 * Assisted payout-account changes (migration 0055 AP-1..AP-4). The portal's client of the bank
 * service's payout-account API: same request authentication as @pt/http-auth (HMAC-SHA256 over
 * method, path, timestamp, one-time nonce and body hash), client "admin", one path only. The IBAN
 * and the title pass through once with the one-time ticket the admin database issued; they are
 * never stored, logged or echoed by the portal.
 */
const SECRET = /^[A-Za-z0-9_-]{43,}$/;
const PATH = "/v1/payees/assisted";

export function bankPayeesConfigured(): boolean {
  return SECRET.test(config.bankPayees.secret);
}

/** A new one-time ticket: the secret goes to the bank service, its SHA-256 to the admin database. */
export function newTicket(): { token: string; hash: Buffer } {
  const raw = randomBytes(32);
  return { token: raw.toString("base64url"), hash: createHash("sha256").update(raw).digest() };
}

const ERRORS: Readonly<Record<string, string>> = {
  invalid_iban: "That is not a valid Pakistani IBAN.",
  title_not_found: "The bank returned no title for this account.",
  title_mismatch: "The account title does not match the investor's verified name: nothing was stored.",
  in_use: "This account is already the payout account of another investor.",
  unchanged: "This account is already the investor's payout account.",
  pending: "An assisted change for this investor is already waiting for a decision.",
  ticket_invalid: "The one-time ticket expired: enter the account again.",
  not_rda: "The investor lives abroad: only a Roshan Digital Account can be their payout account.",
};

export type AssistResult = { ok: true; requestId: string } | { ok: false; error: string };

export async function sendAssisted(token: string, iban: string, title: string): Promise<AssistResult> {
  if (!bankPayeesConfigured()) return { ok: false, error: "The bank service client is not configured (BANK_CLIENT_SECRET_ADMIN): no assisted change can be entered." };
  const body = JSON.stringify({ ticket: token, iban, title });
  const ts = String(Date.now());
  const nonce = randomBytes(16).toString("hex");
  const bodyHash = createHash("sha256").update(body).digest("hex");
  const sig = createHmac("sha256", Buffer.from(config.bankPayees.secret, "base64url")).update(`POST\n${PATH}\n${ts}\n${nonce}\n${bodyHash}`).digest("hex");
  let res: Response;
  try {
    res = await fetch(`${config.bankPayees.url}${PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-pt-client": config.bankPayees.clientId, "x-pt-ts": ts, "x-pt-nonce": nonce, "x-pt-sig": sig },
      body,
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return { ok: false, error: "The bank service is not reachable: nothing was stored." };
  }
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (res.status === 200 && typeof json?.requestId === "string") return { ok: true, requestId: json.requestId };
  const code = typeof json?.error === "string" ? json.error : "";
  return { ok: false, error: new Map(Object.entries(ERRORS)).get(code) ?? `The bank service answered ${String(res.status)}: nothing was stored.` };
}

export interface PayeeDesk {
  canRequest: boolean;
  requests: { id: number; ref: string; last4: string; bankCode: string; status: string; requestedBy: string; requestedAt: string; decidedBy: string | null; decidedAt: string | null }[];
}

export async function payeeDesk(sessionHash: Buffer): Promise<PayeeDesk> {
  const { rows } = await db().query<{ v: PayeeDesk }>("SELECT admin.assisted_payees($1) AS v", [sessionHash]);
  const v = rows[0]?.v;
  if (!v) throw new Error("no payee desk");
  return v;
}

export interface AssistedPayee {
  id: number;
  last4: string;
  bankCode: string;
  reason: string;
  requestedBy: string;
  requestedAt: string;
  expiresAt: string;
  status: string;
  decidedBy: string | null;
  decisionReason: string | null;
  decidedAt: string | null;
  payee: { id: number; activeFrom: string } | null;
  current: { last4: string; bankCode: string; since: string } | null;
  subject: { ref: string; cnic: string; status: string };
  digest: string;
  blockers: string[];
  approveBlockers: string[];
}

export async function assistedPayee(sessionHash: Buffer, id: string): Promise<AssistedPayee | null> {
  const { rows } = await db().query<{ v: AssistedPayee | null }>("SELECT admin.assisted_payee($1, $2) AS v", [sessionHash, id]);
  return rows[0]?.v ?? null;
}

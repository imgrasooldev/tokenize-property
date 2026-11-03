import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { HmacAuthenticator, readBody, sendJson, type Client } from "@pt/http-auth";
import { z } from "zod";
import { BankError } from "./service.ts";

/**
 * Internal HTTP API of the bank service for the website (task T-045): an investor registers or
 * changes the payout account. Same authentication as the KYC service (@pt/http-auth: HMAC over
 * method, path, time, one-time nonce and body; client scopes). Bound to 127.0.0.1 (production:
 * private network + mTLS). The website never holds the KYC peppers or BANK_DATA_KEY: this service
 * hashes and seals the IBAN, and the database (bank.register_payee, B-4) checks the title against
 * the KYC-verified name and starts the 72-hour cooling-off. The IBAN and the title are never logged
 * and never echoed in a response.
 */
export interface PayeeApi {
  registerPayee(subjectId: string, iban: string, claimedTitle: string): Promise<bigint>;
  /** Migration 0055: an assisted change entered in PT Control, stored as a pending request. */
  requestAssistedPayee(ticketHash: Buffer, iban: string, claimedTitle: string): Promise<bigint>;
}

export const WEB_BANK_SCOPE = ["/v1/payees"] as const;
/** PT Control (client "admin"): only the assisted change, with a one-time ticket from the admin database. */
export const ADMIN_BANK_SCOPE = ["/v1/payees/assisted"] as const;
const MAX_BODY = 2 * 1024;

const assistedBody = z.strictObject({
  ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  iban: z.string().max(40),
  title: z.string().min(2).max(140),
});

const payeeBody = z.strictObject({
  subjectId: z.uuid(),
  iban: z.string().max(40),
  title: z.string().min(2).max(140),
});

/** Maps a refusal to a fixed error code; never the input, never the database message. */
function refusal(e: unknown): { status: number; error: string } {
  if (e instanceof BankError) {
    if (e.code === "INVALID_INPUT") return { status: 400, error: "invalid_iban" };
    if (e.code === "TITLE_NOT_FOUND") return { status: 422, error: "title_not_found" };
    if (e.code === "TICKET_INVALID") return { status: 403, error: "ticket_invalid" };
    return { status: 500, error: "internal" };
  }
  const { code, message } = e as { code?: unknown; message?: unknown };
  const msg = typeof message === "string" ? message : "";
  if (code === "23514" && msg.includes("does not match the verified name")) return { status: 422, error: "title_mismatch" };
  if (code === "23514" && msg.includes("only a KYC-verified investor")) return { status: 403, error: "not_verified" };
  if (code === "23505" && msg.includes("already the payout account of another investor")) return { status: 409, error: "in_use" };
  if (code === "23505" && msg.includes("already the investor's payout account")) return { status: 409, error: "unchanged" };
  if (code === "23505" && msg.includes("already waiting for a decision")) return { status: 409, error: "pending" };
  if (code === "42501" && msg.includes("assist ticket is not valid")) return { status: 403, error: "ticket_invalid" };
  return { status: 500, error: "internal" };
}

export function createPayeeServer(api: PayeeApi, clients: Client[], opts: { now?: () => number } = {}): Server {
  const auth = new HmacAuthenticator(clients, opts.now);
  return createServer((req, res) => {
    void (async () => {
      try {
        const path = new URL(req.url ?? "/", "http://internal").pathname;
        if (req.method === "GET" && path === "/v1/health") {
          sendJson(res, 200, { ok: true });
          return;
        }
        if (req.method !== "POST" || (path !== "/v1/payees" && path !== "/v1/payees/assisted")) {
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
        if (path === "/v1/payees/assisted") {
          const assisted = assistedBody.safeParse(json);
          if (!assisted.success) {
            sendJson(res, 400, { error: "invalid" });
            return;
          }
          const ticketHash = createHash("sha256").update(Buffer.from(assisted.data.ticket, "base64url")).digest();
          const id = await api.requestAssistedPayee(ticketHash, assisted.data.iban, assisted.data.title);
          sendJson(res, 200, { requestId: id.toString() });
          return;
        }
        const parsed = payeeBody.safeParse(json);
        if (!parsed.success) {
          sendJson(res, 400, { error: "invalid" });
          return;
        }
        const id = await api.registerPayee(parsed.data.subjectId, parsed.data.iban, parsed.data.title);
        sendJson(res, 200, { payeeId: id.toString() });
      } catch (e) {
        const r = refusal(e);
        sendJson(res, r.status, { error: r.error });
      }
    })();
  });
}

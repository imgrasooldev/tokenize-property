import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { authHeaders, type Client } from "@pt/http-auth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPayeeServer, WEB_BANK_SCOPE, type PayeeApi } from "../src/http.ts";
import { BankError } from "../src/service.ts";

/** The bank service's payout-account API for the website (T-045): authentication, validation, fixed error codes. */
const web: Client = { id: "web", secret: Buffer.alloc(32, 5), scope: WEB_BANK_SCOPE };
const other: Client = { id: "other", secret: Buffer.alloc(32, 6), scope: ["/v1/other"] };
const SUBJECT = "5b0b2c1e-9d4a-4c1e-8f2a-1b2c3d4e5f60";
const IBAN = "PK36SCBL0000001123456702";

const pgError = (code: string, message: string): Error => Object.assign(new Error(message), { code });
const seen: { subjectId: string; iban: string; title: string }[] = [];
/** The title selects the outcome. */
const api: PayeeApi = {
  registerPayee: (subjectId, iban, title) => {
    seen.push({ subjectId, iban, title });
    switch (title) {
      case "bad iban": return Promise.reject(new BankError("INVALID_INPUT", `not an IBAN: ${iban}`));
      case "no title": return Promise.reject(new BankError("TITLE_NOT_FOUND", "no title"));
      case "mismatch": return Promise.reject(pgError("23514", "the bank account title does not match the verified name"));
      case "unverified": return Promise.reject(pgError("23514", "only a KYC-verified investor can register a payout account"));
      case "in use": return Promise.reject(pgError("23505", "this account is already the payout account of another investor"));
      case "other check": return Promise.reject(pgError("23514", "subject, account hash ... are required"));
      case "tampered": return Promise.reject(new BankError("TAMPERED", "x"));
      case "boom": return Promise.reject(new Error(`connection lost while handling ${iban}`));
      default: return Promise.resolve(42n);
    }
  },
};

let server: Server;
let base: string;
beforeAll(async () => {
  server = createPayeeServer(api, [web, other]);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});
afterAll(() => {
  server.close();
});

const body = (title = "Ayesha Khan", extra: Record<string, unknown> = {}) => JSON.stringify({ subjectId: SUBJECT, iban: IBAN, title, ...extra });
const post = (b: string, headers: Record<string, string>, contentType = "application/json") =>
  fetch(`${base}/v1/payees`, { method: "POST", headers: { "content-type": contentType, ...headers }, body: b });
const signed = (b: string, client: Client = web) => post(b, authHeaders(client, "POST", "/v1/payees", b));

describe("bank payee API", () => {
  it("registers through the service and answers with the payee id only", async () => {
    const res = await signed(body());
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ payeeId: "42" });
    expect(seen.at(-1)).toEqual({ subjectId: SUBJECT, iban: IBAN, title: "Ayesha Khan" });
  });

  it("requires a valid signature and the payees scope", async () => {
    const b = body();
    expect((await post(b, {})).status).toBe(401);
    const h = authHeaders(web, "POST", "/v1/payees", b);
    expect((await post(b, h)).status).toBe(200);
    expect((await post(b, h)).status).toBe(401); // replayed nonce
    const wrongKey = authHeaders({ id: "web", secret: Buffer.alloc(32, 9) }, "POST", "/v1/payees", b);
    expect((await post(b, wrongKey)).status).toBe(401);
    const r = await signed(b, other);
    expect(r.status).toBe(403);
    expect(await r.text()).toBe('{"error":"forbidden"}');
  });

  it("refuses non-JSON, bad JSON, oversized and invalid bodies", async () => {
    const b = body();
    expect((await post(b, authHeaders(web, "POST", "/v1/payees", b), "text/plain")).status).toBe(415);
    const bad = "{not json";
    const r1 = await signed(bad);
    expect(r1.status).toBe(400);
    expect(await r1.text()).toBe('{"error":"bad_json"}');
    for (const b2 of [
      body("Ayesha Khan", { extra: true }),
      JSON.stringify({ subjectId: "not-a-uuid", iban: IBAN, title: "Ayesha Khan" }),
      JSON.stringify({ subjectId: SUBJECT, iban: "P".repeat(41), title: "Ayesha Khan" }),
      body("A"),
      body("A".repeat(141)),
      JSON.stringify({ subjectId: SUBJECT, iban: IBAN }),
    ]) {
      const r = await signed(b2);
      expect(r.status).toBe(400);
      expect(await r.text()).toBe('{"error":"invalid"}');
    }
    const big = body("A".repeat(140), { pad: "x".repeat(3000) });
    expect((await signed(big)).status).toBe(413);
  });

  it.each([
    ["bad iban", 400, "invalid_iban"],
    ["no title", 422, "title_not_found"],
    ["mismatch", 422, "title_mismatch"],
    ["unverified", 403, "not_verified"],
    ["in use", 409, "in_use"],
    ["other check", 500, "internal"],
    ["tampered", 500, "internal"],
    ["boom", 500, "internal"],
  ])("maps %s to %i %s without echoing the input", async (title, status, error) => {
    const res = await signed(body(title));
    expect(res.status).toBe(status);
    const text = await res.text();
    expect(text).toBe(JSON.stringify({ error }));
    expect(text).not.toContain(IBAN);
  });

  it("answers health and nothing else", async () => {
    const h = await fetch(`${base}/v1/health`);
    expect(h.status).toBe(200);
    expect(await h.json()).toEqual({ ok: true });
    expect((await fetch(`${base}/v1/payees`)).status).toBe(404);
    expect((await fetch(`${base}/v1/other`, { method: "POST" })).status).toBe(404);
  });
});

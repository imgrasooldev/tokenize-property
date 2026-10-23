import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { authHeaders, type Client } from "@pt/http-auth";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DemoTitleFetch } from "../src/demo-titles.ts";
import { createPayeeServer, WEB_BANK_SCOPE } from "../src/http.ts";
import { makeIban } from "../src/iban.ts";
import { BankService } from "../src/service.ts";
import { ESCROW, world, type World } from "./setup.ts";

/**
 * T-045 end to end on a scratch database: the website's payout-account API with the demo title fetch.
 * The database (bank.register_payee, B-4) still checks the title against the KYC-verified name, keeps
 * an account to one investor and starts the 72-hour cooling-off.
 */
const web: Client = { id: "web", secret: Buffer.alloc(32, 7), scope: WEB_BANK_SCOPE };
let w: World;
let server: Server;
let base: string;
let seq = 0;

beforeAll(async () => {
  w = await world();
  // As the bank-payees process: a login in pt_svc_bank (T-012, migration 0029).
  const bank = new BankService(w.servicePool, w.peppers, w.dataKey, new DemoTitleFetch(), { escrowAccount: ESCROW, actor: "bank-payees" });
  server = createPayeeServer(bank, [web]);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}, 120_000);

afterAll(async () => {
  server.close();
  await w.drop();
});

async function subject(name: string, session = "sess-good"): Promise<string> {
  seq++;
  const r = await w.kyc.onboard({ cnic: `35203${String(2_000_000 + seq).slice(-7)}${String(1 + (seq % 7))}`, fullName: name, livenessSessionId: `${session}-${String(seq).padStart(4, "0")}` });
  return r.subjectId;
}

async function register(subjectId: string, iban: string, title: string): Promise<{ status: number; body: unknown }> {
  const b = JSON.stringify({ subjectId, iban, title });
  const res = await fetch(`${base}/v1/payees`, { method: "POST", headers: { "content-type": "application/json", ...authHeaders(web, "POST", "/v1/payees", b) }, body: b });
  return { status: res.status, body: await res.json() };
}

describe("payout account registration through the website API (demo title fetch)", () => {
  it("registers with the exact KYC name; usable 72 hours later; a different title or another investor's account is refused", async () => {
    const ayesha = await subject("Ayesha Khan");
    const iban = makeIban("MEZN", "7000000000000001");

    expect(await register(ayesha, iban, "Bilal Ahmed")).toEqual({ status: 422, body: { error: "title_mismatch" } });

    const ok = await register(ayesha, iban, "Ayesha Khan");
    expect(ok.status).toBe(200);
    const payeeId = (ok.body as { payeeId: string }).payeeId;
    expect(payeeId).toMatch(/^[1-9][0-9]*$/);
    const { rows } = await w.db.query<{ subject_id: string; iban_last4: string; cooling: boolean }>(
      "SELECT subject_id, iban_last4, active_from = registered_at + interval '72 hours' AS cooling FROM bank.payees WHERE id = $1",
      [payeeId],
    );
    expect(rows).toEqual([{ subject_id: ayesha, iban_last4: iban.slice(-4), cooling: true }]);

    const bilal = await subject("Bilal Ahmed");
    expect(await register(bilal, iban, "Bilal Ahmed")).toEqual({ status: 409, body: { error: "in_use" } });

    expect(await register(ayesha, "PK00NOTANIBAN", "Ayesha Khan")).toEqual({ status: 400, body: { error: "invalid_iban" } });
  });

  it("refuses an investor who is not KYC-verified", async () => {
    const spoof = await subject("Sana Malik", "sess-spoof");
    expect(await register(spoof, makeIban("MEZN", "7000000000000002"), "Sana Malik")).toEqual({ status: 403, body: { error: "not_verified" } });
  });

  it("the demo title fetch refuses to exist in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      expect(() => new DemoTitleFetch()).toThrow(/production/);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(new DemoTitleFetch()).toBeInstanceOf(DemoTitleFetch);
  });
});

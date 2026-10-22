import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { authHeaders } from "@pt/http-auth";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { officer, type TestOfficer } from "../../db/test/officers.ts";
import { rupees } from "../src/arithmetic.ts";
import { AtlUnavailable, MockAtl } from "../src/atl.ts";
import { CnicKeys, formatCnic } from "../src/crypto.ts";
import { ADMIN_TAX_SCOPE, createTaxServer } from "../src/http.ts";
import { EXPORT_COLUMNS, TaxError, TaxService } from "../src/service.ts";
import {
  allowPlaceholders,
  calculate,
  code,
  collect,
  createWorld,
  investor,
  publishAndBook,
  token,
  transfer,
  ZERO,
  type Investor,
  type World,
} from "./world.ts";

/**
 * ADR 0014: the sealed CNIC for tax. Sealing only for the subject's own verified CNIC; nothing
 * readable in the database; ATL checks by the tax service with the OP-41 fallback; the FBR filing
 * export only through two different tax officers (fresh step-ups), a one-time ticket, the tax
 * service's HMAC API, and the file's SHA-256 recorded before it is released. No partial export.
 */
let w: World;
let portal: pg.Client;
let keys: CnicKeys;
let svc: TaxService;
let server: Server;
let url = "";
const client = { id: "admin-portal", secret: randomBytes(32) };
let A: TestOfficer;
let B: TestOfficer;
let C: TestOfficer;
let i1: Investor;
let i2: Investor;
let i3: Investor;
let i4: Investor;
let today = "";
const logged: string[] = [];

beforeAll(async () => {
  w = await createWorld();
  today = (await w.su.query<{ d: string }>("SELECT ops.pkt_today()::text AS d")).rows[0]?.d ?? "";
  keys = CnicKeys.of(1, [{ version: 1, key: randomBytes(32) }]);
  svc = new TaxService(w.taxdb, keys, { peppers: w.peppers, atl: new MockAtl("2026-10-01") });
  server = createTaxServer(svc, [{ ...client, scope: ADMIN_TAX_SCOPE }]);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  portal = new pg.Client(w.settings);
  await portal.connect();
  await portal.query("SET ROLE pt_admin_portal");
  A = await officer(w.su, "tax.amna", "tax_officer");
  B = await officer(w.su, "tax.bilal", "tax_officer");
  C = await officer(w.su, "tax.chaudhry", "tax_officer");
  [i1, i2, i3, i4] = [await investor(w, 1), await investor(w, 2), await investor(w, 3), await investor(w, 5)];
  // Nothing in this file may print a CNIC.
  for (const m of ["log", "error", "warn", "info"] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
      logged.push(a.map(String).join(" "));
    });
  }
}, 240_000);

afterAll(async () => {
  vi.restoreAllMocks();
  server.close();
  await portal.end();
  await w.drop();
}, 240_000);

const digits = (c: string): string => c.replace(/\D/g, "");

describe("sealing a CNIC for tax (ADR 0014)", () => {
  it("only the subject's own verified CNIC is sealed; a mismatch is refused and audited", async () => {
    await expect(svc.enrolCnic(i1.subjectId, i2.cnic)).rejects.toBeInstanceOf(TaxError);
    const refused = await w.pool.query("SELECT 1 FROM ops.audit WHERE action = 'cnic.refused' AND detail->>'subject' = $1", [i1.subjectId]);
    expect(refused.rowCount).toBe(1);
    for (const i of [i1, i2, i3]) expect(await svc.enrolCnic(i.subjectId, i.cnic)).toMatch(/^\d+$/);
    expect(await code(svc.enrolCnic(i1.subjectId, i1.cnic))).toBe("23505");
    await expect(svc.enrolCnic(i1.subjectId, "12345")).rejects.toThrow(/13 digits/);
  });

  it("the database holds no readable CNIC (ciphertext bound to the subject, hash and pepper version)", async () => {
    const { rows } = await w.su.query<{ t: string }>(
      `SELECT string_agg(x::text, ' ') AS t FROM (
         SELECT row_to_json(a)::text AS x FROM tax.sealed_cnics a UNION ALL SELECT row_to_json(a)::text FROM tax.filer_checks a
         UNION ALL SELECT row_to_json(a)::text FROM ops.audit a UNION ALL SELECT row_to_json(a)::text FROM admin.audit a) q`,
    );
    const dump = rows[0]?.t ?? "";
    for (const i of [i1, i2, i3]) {
      expect(dump).not.toContain(digits(i.cnic));
      expect(dump).not.toContain(formatCnic(digits(i.cnic)));
      expect(dump).not.toContain(Buffer.from(digits(i.cnic)).toString("hex"));
    }
    const s = await w.su.query<{ subject_id: string; sealed: Buffer; cnic_hash: Buffer; pepper_version: number }>("SELECT subject_id, sealed, cnic_hash, pepper_version FROM tax.sealed_cnics WHERE subject_id = $1", [i1.subjectId]);
    const r = s.rows[0];
    if (!r) throw new Error("no sealed CNIC");
    expect(keys.open(1, r.subject_id, r.cnic_hash, r.pepper_version, r.sealed)).toBe(digits(i1.cnic));
    // Moved to another investor, the ciphertext no longer opens.
    expect(() => keys.open(1, i2.subjectId, r.cnic_hash, r.pepper_version, r.sealed)).toThrow();
    // The sealed CNIC is not readable by the operations service either.
    expect(await code(w.ops.query("SELECT sealed FROM tax.sealed_cnics"))).toBe("42501");
  });
});

describe("ATL checks and the filer status at a record date (OP-41)", () => {
  it("checks every enrolled investor once per ATL edition; status counts for 30 days", async () => {
    expect(await svc.runAtlChecks("2026-10-01")).toEqual({ checked: 3, filer: 2, nonFiler: 1, unavailable: 0 });
    expect(await svc.runAtlChecks("2026-10-01")).toEqual({ checked: 0, filer: 0, nonFiler: 0, unavailable: 0 });
    const status = async (s: string, on: string) =>
      (await w.pool.query<{ status: string; as_of: string | null; flagged: boolean; flag: string | null }>("SELECT status, as_of::text, flagged, flag FROM tax.filer_status($1, $2::date)", [s, on])).rows[0];
    expect(await status(i1.subjectId, today)).toEqual({ status: "filer", as_of: "2026-10-01", flagged: false, flag: null });
    expect(await status(i2.subjectId, today)).toMatchObject({ status: "non_filer", flagged: false });
    // 40 days later the result is stale: non-filer rate, flagged for review.
    const later = (await w.su.query<{ d: string }>("SELECT ($1::date + 40)::text AS d", [today])).rows[0]?.d ?? "";
    expect(await status(i1.subjectId, later)).toMatchObject({ status: "non_filer", flagged: true });
    // A record date before any check: non-filer, flagged.
    expect(await status(i1.subjectId, "2026-01-01")).toMatchObject({ status: "non_filer", flagged: true });
  });

  it("FBR unavailable: the last result not older than 30 days is used and flagged", async () => {
    class Down extends MockAtl {
      override check(cnic: string): ReturnType<MockAtl["check"]> {
        return cnic === digits(i3.cnic) ? Promise.reject(new AtlUnavailable("test outage")) : super.check(cnic);
      }
    }
    const down = new TaxService(w.taxdb, keys, { atl: new Down("2026-10-08") });
    expect(await down.runAtlChecks("2026-10-08")).toEqual({ checked: 3, filer: 1, nonFiler: 1, unavailable: 1 });
    const r = (await w.pool.query<{ status: string; flagged: boolean; flag: string }>("SELECT status, flagged, flag FROM tax.filer_status($1, $2::date)", [i3.subjectId, today])).rows[0];
    expect(r).toMatchObject({ status: "filer", flagged: true });
    expect(r?.flag).toMatch(/unavailable/);
  });
});

/** A booked distribution over these investors (placeholder rates allowed: local test only). */
async function booked(investors: Investor[], onchainId: number): Promise<string> {
  await allowPlaceholders(w, true);
  const tk = await token(w);
  for (const [n, i] of investors.entries()) await transfer(w, tk, ZERO, i.wallet, BigInt(1000 * (n + 1)), 2);
  await collect(w, tk, "2026-09-12", 6_000_000n);
  const calc = await calculate(w, tk, "2026-09", today, 3);
  await publishAndBook(w, tk, calc, onchainId);
  return tk.token;
}

async function act(sql: string, params: unknown[]): Promise<{ ok: boolean; id?: number; error?: string; status?: string }> {
  const { rows } = await portal.query<{ r: { ok: boolean; id?: number; error?: string; status?: string } }>(sql, params);
  const r = rows[0]?.r;
  if (!r) throw new Error("no result");
  return r;
}

async function generate(exportId: string | number, ticket: Buffer, who = client): Promise<{ status: number; json: Record<string, unknown> }> {
  const path = "/v1/filing-exports/generate";
  const body = JSON.stringify({ exportId: String(exportId), ticket: ticket.toString("base64url") });
  const res = await fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json", ...authHeaders(who, "POST", path, body) }, body });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function approvedExport(tk: string, by: TestOfficer, checker: TestOfficer): Promise<number> {
  const req = await act("SELECT admin.request_tax_export($1, $2, '2026-09', '2026-09', 'withholding statement for FBR, September') AS r", [by.sessionHash, tk]);
  expect(req.ok, req.error).toBe(true);
  const id = req.id ?? 0;
  const view = (await portal.query<{ v: { digest: string } }>("SELECT admin.tax_export($1, $2) AS v", [checker.sessionHash, id])).rows[0]?.v;
  const ok = await act("SELECT admin.decide_tax_export($1, $2, 'approve', 'scope and reason checked', decode($3, 'hex')) AS r", [checker.sessionHash, id, view?.digest]);
  expect(ok.ok, ok.error).toBe(true);
  return id;
}

async function ticketFor(o: TestOfficer, id: number): Promise<{ ticket: Buffer; r: { ok: boolean; error?: string } }> {
  const ticket = randomBytes(32);
  const r = await act("SELECT admin.issue_tax_export_ticket($1, $2, $3) AS r", [o.sessionHash, id, createHash("sha256").update(ticket).digest()]);
  return { ticket, r };
}

describe("FBR filing export: two officers, one-time ticket, recorded before release (OT-9)", () => {
  let tk = "";
  let exportId = 0;

  it("the requesting officer cannot approve; a third officer cannot generate", async () => {
    tk = await booked([i1, i2, i3], 1);
    const req = await act("SELECT admin.request_tax_export($1, $2, '2026-09', '2026-09', 'withholding statement for FBR, September') AS r", [A.sessionHash, tk]);
    exportId = req.id ?? 0;
    const digest = (await portal.query<{ v: { digest: string; linesInScope: number; missingCnic: number } }>("SELECT admin.tax_export($1, $2) AS v", [A.sessionHash, exportId])).rows[0]?.v;
    expect(digest).toMatchObject({ linesInScope: 3, missingCnic: 0 });
    const self = await act("SELECT admin.decide_tax_export($1, $2, 'approve', 'scope and reason checked', decode($3, 'hex')) AS r", [A.sessionHash, exportId, digest?.digest]);
    expect(self).toMatchObject({ ok: false });
    expect(self.error).toMatch(/two officers/);
    expect((await act("SELECT admin.decide_tax_export($1, $2, 'approve', 'scope and reason checked', decode($3, 'hex')) AS r", [B.sessionHash, exportId, digest?.digest])).ok).toBe(true);
    const third = await ticketFor(C, exportId);
    expect(third.r.ok).toBe(false);
    expect(third.r.error).toMatch(/two officers/);
  });

  it("a stale step-up is refused", async () => {
    await w.su.query("ALTER TABLE admin.sessions DISABLE TRIGGER sessions_guard");
    await w.su.query("UPDATE admin.sessions SET step_up_at = step_up_at - interval '5 minutes 1 second' WHERE token_hash = $1", [A.sessionHash]);
    await w.su.query("ALTER TABLE admin.sessions ENABLE TRIGGER sessions_guard");
    expect(await code(ticketFor(A, exportId))).toBe("PTS01");
    A = await officer(w.su, A.handle, "tax_officer"); // signs in again: fresh step-up
  });

  it("generates the file once through the tax service; its SHA-256 is recorded first; full CNICs only in the file", async () => {
    const { ticket, r } = await ticketFor(A, exportId);
    expect(r.ok, r.error).toBe(true);
    expect((await generate(exportId, ticket, { id: "admin-portal", secret: randomBytes(32) })).status).toBe(401);
    const res = await generate(exportId, ticket);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const csv = Buffer.from(String(res.json.csv), "base64");
    expect(createHash("sha256").update(csv).digest("hex")).toBe(res.json.sha256);
    const rec = (await w.su.query<{ status: string; file_sha256: Buffer; row_count: number; generated_by: string }>("SELECT status, file_sha256, row_count, generated_by FROM tax.filing_exports WHERE id = $1", [exportId])).rows[0];
    expect(rec).toMatchObject({ status: "generated", row_count: 3, generated_by: A.handle });
    expect(rec?.file_sha256.toString("hex")).toBe(res.json.sha256);
    const [head, ...lines] = csv.toString("utf8").trim().split("\n");
    expect(head).toBe(EXPORT_COLUMNS.join(","));
    const byWallet = new Map(lines.map((l) => [l.split(",").at(-1), l.split(",")]));
    for (const i of [i1, i2, i3]) {
      const cols = byWallet.get(i.wallet);
      expect(cols?.[0]).toBe(formatCnic(digits(i.cnic)));
      const line = (await w.pool.query<{ gross: string; wht: string }>("SELECT l.gross::text, l.wht::text FROM ops.distribution_lines l JOIN ops.distributions d ON d.id = l.distribution_id WHERE d.token = $1 AND l.wallet = $2", [tk, i.wallet])).rows[0];
      expect(cols?.[8]).toBe(rupees(BigInt(line?.gross ?? "0")));
      expect(cols?.[10]).toBe(rupees(BigInt(line?.wht ?? "0")));
    }
    // Once only: the same ticket, and a new ticket for a generated export, are refused.
    expect((await generate(exportId, ticket)).status).toBe(409);
    expect((await ticketFor(B, exportId)).r.ok).toBe(false);
    const released = await w.pool.query<{ detail: { purpose: string; lines: number; officer: string } }>("SELECT detail FROM ops.audit WHERE action = 'cnic.released' AND detail->>'purpose' = 'filing_export'");
    expect(released.rows.map((x) => x.detail)).toContainEqual(expect.objectContaining({ lines: 3, officer: A.handle }));
  });

  it("no partial export: a line without a sealed CNIC refuses the whole file (the ticket stays unused)", async () => {
    const tk2 = await booked([i1, i4], 2);
    const id = await approvedExport(tk2, B, A);
    const { ticket } = await ticketFor(B, id);
    const res = await generate(id, ticket);
    expect(res.status).toBe(409);
    expect(String(res.json.error)).toMatch(/no sealed CNIC/);
    const st = (await w.su.query<{ status: string }>("SELECT status FROM tax.filing_exports WHERE id = $1", [id])).rows[0];
    expect(st?.status).toBe("approved");
    // Enrol the missing investor, then the same ticket (still unused, still valid) works.
    await svc.enrolCnic(i4.subjectId, i4.cnic);
    expect((await generate(id, ticket)).status).toBe(200);
  });

  it("an expired ticket is refused", async () => {
    const tk3 = await booked([i2], 3);
    const id = await approvedExport(tk3, A, B);
    const { ticket } = await ticketFor(A, id);
    const h = createHash("sha256").update(ticket).digest();
    await w.su.query("ALTER TABLE tax.export_tickets DISABLE TRIGGER export_tickets_guard");
    await w.su.query("UPDATE tax.export_tickets SET created_at = created_at - interval '1 hour', expires_at = expires_at - interval '1 hour' WHERE token_hash = $1", [h]);
    await w.su.query("ALTER TABLE tax.export_tickets ENABLE TRIGGER export_tickets_guard");
    const res = await generate(id, ticket);
    expect(res.status).toBe(409);
    expect(String(res.json.error)).toMatch(/not valid/);
  });

  it("the service exposes one path to one client; audit chains verify; nothing printed a CNIC", async () => {
    expect((await fetch(`${url}/v1/other`, { method: "POST" })).status).toBe(404);
    expect((await w.su.query("SELECT * FROM ops.verify_audit()")).rows).toEqual([]);
    expect((await w.su.query("SELECT * FROM admin.verify_audit()")).rows).toEqual([]);
    const out = logged.join("\n");
    for (const i of [i1, i2, i3, i4]) {
      expect(out).not.toContain(digits(i.cnic));
      expect(out).not.toContain(formatCnic(digits(i.cnic)));
    }
  });
});

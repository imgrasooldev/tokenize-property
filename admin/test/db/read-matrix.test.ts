import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cast, createWorld, sha, token, type Cast, type World } from "../support/world";

/**
 * Authorisation inside the database (defence in depth): every function the portal can call, for
 * every role and for no session, against an explicit expected table (not derived from the code).
 */
type Who = "ops_maker" | "ops_checker" | "compliance_officer" | "trustee_officer" | "auditor" | "admin" | "nobody";
const WHO: Who[] = ["ops_maker", "ops_checker", "compliance_officer", "trustee_officer", "auditor", "admin", "nobody"];

const EXPECT: Record<string, Who[]> = {
  ops_overview: ["ops_maker", "ops_checker", "compliance_officer", "auditor"],
  "audit_rows:signer": ["ops_maker", "ops_checker", "compliance_officer", "auditor"],
  "audit_rows:recon": ["ops_maker", "ops_checker", "compliance_officer", "auditor"],
  "audit_rows:ledger": ["ops_maker", "ops_checker", "compliance_officer", "auditor"],
  "audit_rows:admin": ["compliance_officer", "auditor", "admin"],
  "record_export:signer": ["compliance_officer", "auditor"],
  "record_export:admin": ["compliance_officer", "auditor"],
  officers_list: ["auditor", "admin"],
  changes_list: ["auditor", "admin"],
  my_account: ["ops_maker", "ops_checker", "compliance_officer", "trustee_officer", "auditor", "admin"],
  session_credentials: ["ops_maker", "ops_checker", "compliance_officer", "trustee_officer", "auditor", "admin"],
  request_change: ["admin"],
};

const CALLS: Record<string, string> = {
  ops_overview: "SELECT admin.ops_overview($1)",
  "audit_rows:signer": "SELECT * FROM admin.audit_rows($1, 'signer', NULL, NULL, NULL, NULL, NULL, 5)",
  "audit_rows:recon": "SELECT * FROM admin.audit_rows($1, 'recon', NULL, NULL, NULL, NULL, NULL, 5)",
  "audit_rows:ledger": "SELECT * FROM admin.audit_rows($1, 'ledger', NULL, NULL, NULL, NULL, NULL, 5)",
  "audit_rows:admin": "SELECT * FROM admin.audit_rows($1, 'admin', NULL, NULL, NULL, NULL, NULL, 5)",
  "record_export:signer": `SELECT * FROM admin.record_export($1, 'signer', '{}', 0, 'csv', '${"a".repeat(64)}')`,
  "record_export:admin": `SELECT * FROM admin.record_export($1, 'admin', '{}', 0, 'json', '${"b".repeat(64)}')`,
  officers_list: "SELECT * FROM admin.officers_list($1)",
  changes_list: "SELECT * FROM admin.changes_list($1, 10)",
  my_account: "SELECT * FROM admin.my_account($1)",
  session_credentials: "SELECT * FROM admin.session_credentials($1)",
  // An invitation with a valid shape: only the permission decides.
  request_change: "SELECT admin.request_change($1, 'invite', NULL, 'auditor', 'matrix.' || substr(md5(random()::text), 1, 8), 'Matrix Person', 'matrix permission probe')",
};

let w: World;
let c: Cast;
beforeAll(async () => {
  w = await createWorld();
  c = await cast(w);
});
afterAll(async () => {
  await w.drop();
});

function sessionOf(who: Who): Buffer {
  // eslint-disable-next-line security/detect-object-injection
  return who === "nobody" ? sha(token()) : c[who].sessionHash;
}

describe("database authorisation matrix", () => {
  for (const [fn, allowed] of Object.entries(EXPECT)) {
    for (const who of WHO) {
      const ok = allowed.includes(who);
      it(`${fn} × ${who}: ${ok ? "allowed" : "denied"}`, async () => {
        const sql = new Map(Object.entries(CALLS)).get(fn) ?? "";
        const outcome = await w.portal.query(sql, [sessionOf(who)]).then(
          () => "allowed",
          (e: unknown) => {
            const code = (e as { code?: string }).code;
            return code === "42501" ? "denied" : `error ${code ?? "?"}`;
          },
        );
        expect(outcome).toBe(ok ? "allowed" : "denied");
      });
    }
  }

  it("verify_chains returns only the chains the officer may read", async () => {
    const chains = async (who: Who) =>
      (await w.portal.query<{ source: string }>("SELECT source FROM admin.verify_chains($1, NULL)", [sessionOf(who)])).rows.map((r) => r.source).sort();
    expect(await chains("auditor")).toEqual(["admin", "ledger", "recon", "signer"]);
    expect(await chains("ops_maker")).toEqual(["ledger", "recon", "signer"]);
    expect(await chains("admin")).toEqual(["admin"]);
    expect(await chains("trustee_officer")).toEqual([]);
    const code = await w.portal.query("SELECT * FROM admin.verify_chains($1, NULL)", [sessionOf("nobody")]).then(
      () => "ok",
      (e: unknown) => (e as { code?: string }).code,
    );
    expect(code).toBe("42501");
  });

  it("the overview holds no personal data or payloads", async () => {
    const { rows } = await w.portal.query<{ v: unknown }>("SELECT admin.ops_overview($1) AS v", [c.auditor.sessionHash]);
    const text = JSON.stringify(rows[0]?.v);
    expect(text).not.toMatch(/payload|cnic|iban|name_enc|name_hash|public_key/i);
  });
});

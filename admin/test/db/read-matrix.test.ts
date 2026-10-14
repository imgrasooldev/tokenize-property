import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cast, createWorld, sha, token, type Cast, type World } from "../support/world";

/**
 * Authorisation inside the database (defence in depth): every function the portal can call, for
 * every role and for no session, against an explicit expected table (not derived from the code).
 */
type Who = "ops_maker" | "ops_checker" | "compliance_officer" | "trustee_officer" | "tax_officer" | "auditor" | "admin" | "nobody";
const WHO: Who[] = ["ops_maker", "ops_checker", "compliance_officer", "trustee_officer", "tax_officer", "auditor", "admin", "nobody"];
const OPERATIONS: Who[] = ["ops_maker", "ops_checker", "trustee_officer", "tax_officer", "auditor"];

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
  my_account: ["ops_maker", "ops_checker", "compliance_officer", "trustee_officer", "tax_officer", "auditor", "admin"],
  session_credentials: ["ops_maker", "ops_checker", "compliance_officer", "trustee_officer", "tax_officer", "auditor", "admin"],
  request_change: ["admin"],
  // Step 6b (migration 0016)
  approvals_inbox: ["ops_maker", "ops_checker", "compliance_officer", "auditor"],
  signer_request: ["ops_maker", "ops_checker", "auditor"],
  payout_batch: ["ops_maker", "ops_checker", "auditor"],
  unfreeze_request: ["ops_maker", "ops_checker", "auditor"],
  property_request: ["ops_maker", "ops_checker", "compliance_officer", "auditor"],
  issue_signer_ticket: ["ops_checker"],
  decide_payout_batch: ["ops_checker"],
  decide_unfreeze: ["ops_checker"],
  request_unfreeze: ["ops_maker"],
  decide_property_request: ["ops_checker", "compliance_officer"],
  // Step 6c (migration 0019): compliance officers act, auditors read, nobody else (operations included).
  "audit_rows:compliance": ["compliance_officer", "auditor"],
  "record_export:compliance": ["compliance_officer", "auditor"],
  compliance_dashboard: ["compliance_officer", "auditor"],
  kyc_queue: ["compliance_officer", "auditor"],
  kyc_case: ["compliance_officer", "auditor"],
  screenings: ["compliance_officer", "auditor"],
  freeze_requests: ["compliance_officer", "auditor"],
  freeze_request: ["compliance_officer", "auditor"],
  str_cases: ["compliance_officer", "auditor"],
  str_case: ["compliance_officer", "auditor"],
  str_export_data: ["compliance_officer"],
  open_kyc_case: ["compliance_officer"],
  kyc_case_act: ["compliance_officer"],
  request_rescreen: ["compliance_officer"],
  request_freeze: ["compliance_officer"],
  decide_freeze: ["compliance_officer"],
  open_str: ["compliance_officer"],
  add_str_note: ["compliance_officer"],
  str_act: ["compliance_officer"],
  record_str_export: ["compliance_officer"],
  // S-03 (migration 0021): operations makers propose, checkers decide; tax officers act on tax; auditors read.
  operations_periods: OPERATIONS,
  operations_statement: OPERATIONS,
  operations_charge: OPERATIONS,
  operations_distribution: OPERATIONS,
  tax_overview: ["tax_officer", "auditor"],
  tax_exports: ["tax_officer", "auditor"],
  tax_export: ["tax_officer", "auditor"],
  propose_charge: ["ops_maker"],
  decide_charge: ["ops_checker"],
  decide_distribution: ["ops_checker"],
  propose_tax_rate: ["tax_officer"],
  decide_tax_rate: ["tax_officer"],
  request_tax_export: ["tax_officer"],
  decide_tax_export: ["tax_officer"],
  issue_tax_export_ticket: ["tax_officer"],
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
  // Unknown items: reads return NULL and decisions an audited refusal, so only the permission decides.
  approvals_inbox: "SELECT admin.approvals_inbox($1)",
  signer_request: "SELECT admin.signer_request($1, gen_random_uuid())",
  payout_batch: "SELECT admin.payout_batch($1, 999999)",
  unfreeze_request: "SELECT admin.unfreeze_request($1, 999999)",
  property_request: "SELECT admin.property_request($1, 999999)",
  issue_signer_ticket: `SELECT admin.issue_signer_ticket($1, gen_random_uuid(), 'approve', 'matrix permission probe', '\\x${"a".repeat(64)}', '\\x${"b".repeat(64)}', sha256(random()::text::bytea))`,
  decide_payout_batch: `SELECT admin.decide_payout_batch($1, 999999, 'approve', 'matrix permission probe', '\\x${"a".repeat(64)}')`,
  decide_unfreeze: "SELECT admin.decide_unfreeze($1, 999999, 'approve', 'matrix permission probe', 1)",
  request_unfreeze: "SELECT admin.request_unfreeze($1, 'matrix permission probe')",
  decide_property_request: `SELECT admin.decide_property_request($1, 999999, 'approve', 'matrix permission probe', '\\x${"a".repeat(64)}')`,
  "audit_rows:compliance": "SELECT * FROM admin.audit_rows($1, 'compliance', NULL, NULL, NULL, NULL, NULL, 5)",
  "record_export:compliance": `SELECT * FROM admin.record_export($1, 'compliance', '{}', 0, 'csv', '${"c".repeat(64)}')`,
  compliance_dashboard: "SELECT admin.compliance_dashboard($1)",
  kyc_queue: "SELECT admin.kyc_queue($1, NULL)",
  kyc_case: "SELECT admin.kyc_case($1, 999999)",
  screenings: "SELECT admin.screenings($1, NULL)",
  freeze_requests: "SELECT admin.freeze_requests($1)",
  freeze_request: "SELECT admin.freeze_request($1, 999999)",
  str_cases: "SELECT admin.str_cases($1)",
  str_case: "SELECT admin.str_case($1, 999999)",
  str_export_data: "SELECT admin.str_export_data($1, 999999)",
  // Unknown subjects, wallets and cases: refusals are audited and returned, so only the permission decides.
  open_kyc_case: "SELECT admin.open_kyc_case($1, gen_random_uuid(), 'standard', 'matrix permission probe')",
  kyc_case_act: `SELECT admin.kyc_case_act($1, 999999, 'approve', 'matrix permission probe', '\\x${"a".repeat(64)}')`,
  request_rescreen: "SELECT admin.request_rescreen($1, gen_random_uuid(), 'matrix permission probe')",
  request_freeze: `SELECT admin.request_freeze($1, 'freeze', '0x${"9".repeat(40)}', 'court_order', 'matrix permission probe', NULL, NULL)`,
  decide_freeze: `SELECT admin.decide_freeze($1, 999999, 'approve', 'matrix permission probe', '\\x${"a".repeat(64)}')`,
  open_str: "SELECT admin.open_str($1, gen_random_uuid(), 'other', 'matrix permission probe for the STR log')",
  add_str_note: "SELECT admin.add_str_note($1, 999999, 'matrix permission probe')",
  str_act: `SELECT admin.str_act($1, 999999, 'start_review', 'matrix permission probe', NULL, '\\x${"a".repeat(64)}')`,
  record_str_export: `SELECT admin.record_str_export($1, 999999, '${"d".repeat(64)}')`,
  operations_periods: "SELECT admin.operations_periods($1)",
  operations_statement: `SELECT admin.operations_statement($1, '0x${"a".repeat(40)}', '2026-09')`,
  operations_charge: "SELECT admin.operations_charge($1, 999999)",
  operations_distribution: "SELECT admin.operations_distribution($1, 999999)",
  tax_overview: "SELECT admin.tax_overview($1)",
  tax_exports: "SELECT admin.tax_exports($1)",
  tax_export: "SELECT admin.tax_export($1, 999999)",
  // Invalid or unknown items: refusals are audited and returned, so only the permission decides.
  propose_charge: `SELECT admin.propose_charge($1, '0x${"a".repeat(40)}', '2026-09', 'expense', NULL, 'probe-co', 'matrix probe', 100, 'not-a-digest')`,
  decide_charge: `SELECT admin.decide_charge($1, 999999, 'approve', 'matrix permission probe', '\\x${"a".repeat(64)}')`,
  decide_distribution: `SELECT admin.decide_distribution($1, 999999, 'approve', 'matrix permission probe', '\\x${"a".repeat(64)}')`,
  propose_tax_rate: "SELECT admin.propose_tax_rate($1, 'no_such_type', 'filer', 1, current_date + 1, 'matrix permission probe')",
  decide_tax_rate: `SELECT admin.decide_tax_rate($1, 999999, 'approve', 'matrix permission probe', '\\x${"a".repeat(64)}')`,
  request_tax_export: "SELECT admin.request_tax_export($1, NULL, 'bad', 'bad', 'matrix permission probe')",
  decide_tax_export: `SELECT admin.decide_tax_export($1, 999999, 'approve', 'matrix permission probe', '\\x${"a".repeat(64)}')`,
  issue_tax_export_ticket: "SELECT admin.issue_tax_export_ticket($1, 999999, sha256(random()::text::bytea))",
};

const DECISIONS = new Set([
  "issue_signer_ticket",
  "decide_payout_batch",
  "decide_unfreeze",
  "decide_property_request",
  "kyc_case_act",
  "request_freeze",
  "decide_freeze",
  "str_act",
  "record_str_export",
  "decide_charge",
  "decide_distribution",
  "propose_tax_rate",
  "decide_tax_rate",
  "request_tax_export",
  "decide_tax_export",
  "issue_tax_export_ticket",
]);
let stepCounter = Date.now();
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
        // Decisions also need a step-up younger than five minutes: refresh it, so only the permission decides.
        if (DECISIONS.has(fn) && who !== "nobody") {
          // eslint-disable-next-line security/detect-object-injection
          const a = c[who];
          await w.portal.query("SELECT admin.record_step_up($1, $2, $3)", [a.sessionHash, a.credentialId, ++stepCounter]);
        }
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
    expect(await chains("auditor")).toEqual(["admin", "compliance", "ledger", "recon", "signer"]);
    expect(await chains("compliance_officer")).toEqual(["admin", "compliance", "ledger", "recon", "signer"]);
    expect(await chains("ops_maker")).toEqual(["ledger", "recon", "signer"]);
    expect(await chains("admin")).toEqual(["admin"]);
    expect(await chains("trustee_officer")).toEqual([]);
    expect(await chains("tax_officer")).toEqual([]);
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

import { fileURLToPath } from "node:url";
import { openAccount } from "@pt/ledger";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../db/src/migrate.ts";
import { scratchDatabase } from "../../db/test/helpers.ts";
import { buildStatement, importStatement } from "../src/bank.ts";
import { completeRun, decideUnfreeze, failRun, payoutGate, registerBankAccount, requestUnfreeze, startRun } from "../src/store.ts";
import type { Finding } from "../src/types.ts";

/** Database rules of migration 0006_recon.sql (R-1 .. R-7) on a scratch database. */
const MIGRATIONS = fileURLToPath(new URL("../../db/migrations", import.meta.url));

let db: pg.Client;
let drop: () => Promise<void>;

const BLOCKING: Finding = { check: "cash.amount_mismatch", severity: "blocking", subject: "TEST-ACCOUNT RAAST-1 in", expected: "1", actual: "2" };
const WARNING: Finding = { check: "cash.statement_stale", severity: "warning", subject: "bank account TEST" };

async function finishRun(findings: Finding[]): Promise<{ run: bigint; status: string }> {
  const run = await startRun(db, "test-runner", "test-deployment", { test: true });
  return { run, status: await completeRun(db, run, "test-runner", 10n, findings, { test: true }) };
}

async function asRole<T>(role: string, fn: () => Promise<T>): Promise<T> {
  await db.query("BEGIN");
  try {
    await db.query(`SET LOCAL ROLE ${role}`);
    return await fn();
  } finally {
    await db.query("ROLLBACK");
  }
}

/** Changes rows the way a rogue administrator could: with the protecting trigger disabled. */
async function rogue(table: string, trigger: string, sql: string, params: unknown[] = []): Promise<void> {
  await db.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
  try {
    await db.query(sql, params);
  } finally {
    await db.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);
  }
}

async function audit(action: string): Promise<number> {
  const { rows } = await db.query<{ n: string }>("SELECT count(*) AS n FROM recon.audit WHERE action = $1", [action]);
  return Number(rows[0]?.n ?? 0);
}

beforeAll(async () => {
  ({ client: db, drop } = await scratchDatabase());
  await migrate(db, MIGRATIONS);
  await openAccount(db, { code: "bank:escrow", kind: "asset", asset: "PKR" });
  await openAccount(db, { code: "income:rent", kind: "income", asset: "PKR" });
});

afterAll(async () => {
  await drop();
});

describe("payout gate (R-2, R-4)", () => {
  it("denies payouts until a run has passed (deny by default)", async () => {
    const g = await payoutGate(db);
    expect(g).toMatchObject({ allowed: false, frozen: false, reason: "no reconciliation run has finished yet" });
    const { rows } = await db.query<{ ok: boolean }>("SELECT recon.payouts_allowed() AS ok");
    expect(rows[0]?.ok).toBe(false);
  });

  it("allows payouts after a passed run; warnings do not block", async () => {
    expect((await finishRun([WARNING])).status).toBe("passed");
    expect(await payoutGate(db)).toMatchObject({ allowed: true, frozen: false, lastStatus: "passed" });
  });

  it("denies (without freezing) while the latest run ended in error", async () => {
    const run = await startRun(db, "test-runner", "test-deployment", {});
    await failRun(db, run, "test-runner", "chain unreachable");
    expect(await payoutGate(db)).toMatchObject({ allowed: false, frozen: false, lastStatus: "error" });
    await finishRun([]);
    expect((await payoutGate(db)).allowed).toBe(true);
  });

  // Builds and drops its own database: on Windows the drop's checkpoint fsyncs every new file (~25 s here).
  it("denies when the latest passed run is older than 26 hours", async () => {
    // Own database: ageing a run by hand is itself a tampering the audit chain reports.
    const s = await scratchDatabase();
    try {
      await migrate(s.client, MIGRATIONS);
      const run = await startRun(s.client, "test-runner", "d", {});
      await completeRun(s.client, run, "test-runner", 1n, [], {});
      expect((await payoutGate(s.client)).allowed).toBe(true);
      await s.client.query("ALTER TABLE recon.runs DISABLE TRIGGER runs_guard");
      await s.client.query("UPDATE recon.runs SET finished_at = now() - interval '27 hours' WHERE id = $1", [run.toString()]);
      await s.client.query("ALTER TABLE recon.runs ENABLE TRIGGER runs_guard");
      expect(await payoutGate(s.client)).toMatchObject({ allowed: false, frozen: false });
      expect((await payoutGate(s.client)).reason).toMatch(/older than 26 hours/);
    } finally {
      await s.drop();
    }
  }, 120_000);
});

describe("freeze and maker-checker unfreeze (R-2, R-3)", () => {
  let request: bigint;

  it("freezes on any blocking finding, in the same transaction, and audits it", async () => {
    const freezes = await audit("gate.freeze");
    const { status } = await finishRun([BLOCKING, WARNING]);
    expect(status).toBe("failed");
    const g = await payoutGate(db);
    expect(g).toMatchObject({ allowed: false, frozen: true });
    expect(g.reason).toMatch(/frozen/);
    expect(await audit("gate.freeze")).toBe(freezes + 1);
  });

  it("never unfreezes automatically, even after a passed run", async () => {
    await finishRun([]);
    expect(await payoutGate(db)).toMatchObject({ allowed: false, frozen: true, lastStatus: "passed" });
  });

  it("requires a reason and refuses a second open request for the same freeze", async () => {
    await expect(requestUnfreeze(db, "maker", "too short")).rejects.toThrow(/reason/);
    request = await requestUnfreeze(db, "maker", "fixed the bank import mapping, re-ran reconciliation");
    await expect(requestUnfreeze(db, "maker-2", "another request for the same freeze")).rejects.toThrow(/already open/);
  });

  it("refuses the maker as checker and a checker without a reason", async () => {
    await expect(decideUnfreeze(db, request, "maker", "approve", "I approve my own request")).rejects.toThrow(/maker-checker/);
    await expect(decideUnfreeze(db, request, "checker", "approve", "ok")).rejects.toThrow(/reason/);
    // Also enforced against a direct UPDATE (CHECK constraint).
    await expect(db.query("UPDATE recon.unfreeze_requests SET status = 'approved', decided_by = 'maker', decision_reason = 'self approval!!', decided_at = now() WHERE id = $1", [request.toString()]))
      .rejects.toThrow(/check constraint/);
  });

  it("needs a run that passed AFTER the freeze", async () => {
    await finishRun([BLOCKING]); // frozen again: the open request is now stale
    expect(await decideUnfreeze(db, request, "checker", "approve", "looks fine to me now")).toBe("expired");
    request = await requestUnfreeze(db, "maker", "second attempt after fixing the data");
    await expect(decideUnfreeze(db, request, "checker", "approve", "approving without a clean run")).rejects.toThrow(/passed after run/);
  });

  it("unfreezes when a different operator approves after a passed run, with everything audited", async () => {
    await finishRun([]);
    const before = await audit("gate.unfreeze");
    expect(await decideUnfreeze(db, request, "checker", "approve", "verified the clean run and the fix")).toBe("approved");
    expect(await payoutGate(db)).toMatchObject({ allowed: true, frozen: false });
    expect(await audit("gate.unfreeze")).toBe(before + 1);
    const { rows } = await db.query<{ status: string; decided_by: string; decision_reason: string }>("SELECT status, decided_by, decision_reason FROM recon.unfreeze_requests WHERE id = $1", [request.toString()]);
    expect(rows[0]).toEqual({ status: "approved", decided_by: "checker", decision_reason: "verified the clean run and the fix" });
    // Deciding again changes nothing.
    expect(await decideUnfreeze(db, request, "checker-2", "reject", "too late to change this")).toBe("approved");
    await expect(requestUnfreeze(db, "maker", "nothing is frozen right now")).rejects.toThrow(/not frozen/);
  });

  it("supports rejection and expiry after 24 hours", async () => {
    await finishRun([BLOCKING]);
    const r1 = await requestUnfreeze(db, "maker", "please unfreeze, false alarm");
    expect(await decideUnfreeze(db, r1, "checker", "reject", "not a false alarm, investigate")).toBe("rejected");
    const r2 = await requestUnfreeze(db, "maker", "please unfreeze, investigated");
    await rogue("recon.unfreeze_requests", "unfreeze_requests_guard", "UPDATE recon.unfreeze_requests SET expires_at = now() - interval '1 minute' WHERE id = $1", [r2.toString()]);
    await finishRun([]);
    expect(await decideUnfreeze(db, r2, "checker", "approve", "approving an old request")).toBe("expired");
    expect((await payoutGate(db)).frozen).toBe(true);
    // Leave the gate open for the following tests.
    const r3 = await requestUnfreeze(db, "maker", "investigated and fixed, clean run done");
    expect(await decideUnfreeze(db, r3, "checker", "approve", "checked the evidence and run")).toBe("approved");
  });
});

describe("runs and findings (R-1)", () => {
  it("are append-only and finished exactly once", async () => {
    const { run } = await finishRun([BLOCKING]);
    await expect(completeRun(db, run, "x", 1n, [], {})).rejects.toThrow(/final/);
    await expect(db.query("UPDATE recon.runs SET status = 'passed' WHERE id = $1", [run.toString()])).rejects.toThrow(/final/);
    await expect(db.query("UPDATE recon.findings SET severity = 'warning' WHERE run_id = $1", [run.toString()])).rejects.toThrow(/append-only/);
    await expect(db.query("DELETE FROM recon.findings")).rejects.toThrow(/append-only/);
    await expect(db.query("TRUNCATE recon.findings, recon.runs, recon.gate_events, recon.audit CASCADE")).rejects.toThrow(/append-only/);
    await expect(db.query("DELETE FROM recon.gate_events")).rejects.toThrow(/append-only/);
    await expect(db.query("UPDATE recon.audit SET actor = 'x'")).rejects.toThrow(/append-only/);
  });

  it("derive the status from the findings and refuse malformed ones", async () => {
    const run = await startRun(db, "test-runner", "d", {});
    await expect(completeRun(db, run, "t", 1n, [{ ...BLOCKING, check: "Bad Name" as Finding["check"] }], {})).rejects.toThrow(/check/);
    await expect(db.query("SELECT recon.complete_run($1, 't', 1, '[{\"check\":\"a.b\"}]'::jsonb, '{}'::jsonb)", [run.toString()])).rejects.toThrow(/malformed/);
    await expect(completeRun(db, run, "t", 1n, [{ ...BLOCKING, severity: "info" as Finding["severity"] }], {})).rejects.toThrow(/severity/);
    // Nothing was recorded by the refused calls; the run can still finish.
    expect(await completeRun(db, run, "t", 1n, [WARNING], {})).toBe("passed");
  });

  it("allow one run at a time and close a run abandoned for an hour", async () => {
    const run = await startRun(db, "test-runner", "d", {});
    await expect(startRun(db, "other-runner", "d", {})).rejects.toThrow(/in progress/);
    await rogue("recon.runs", "runs_guard", "UPDATE recon.runs SET started_at = now() - interval '61 minutes' WHERE id = $1", [run.toString()]);
    const next = await startRun(db, "other-runner", "d", {});
    const { rows } = await db.query<{ status: string; error: string }>("SELECT status, error FROM recon.runs WHERE id = $1", [run.toString()]);
    expect(rows[0]).toEqual({ status: "error", error: "abandoned: still running after one hour" });
    expect(await completeRun(db, next, "t", 1n, [], {})).toBe("passed");
  });
});

describe("bank statements (R-5)", () => {
  const line = (reference: string, amount: bigint, valueDate = "2026-10-12") => ({ valueDate, amountPaisa: amount, reference, counterparty: "Test Payer" });

  it("registers an account only for an existing PKR asset ledger account, once", async () => {
    await expect(registerBankAccount(db, "NOPE-01", "bank:missing", "ops")).rejects.toThrow(/must exist/);
    await expect(registerBankAccount(db, "NOPE-02", "income:rent", "ops")).rejects.toThrow(/asset/);
    expect(await registerBankAccount(db, "TEST-ESCROW-01", "bank:escrow", "ops")).toBe(true);
    expect(await registerBankAccount(db, "TEST-ESCROW-01", "bank:escrow", "ops")).toBe(false);
    await expect(registerBankAccount(db, "TEST-ESCROW-01", "income:rent", "ops")).rejects.toThrow(/already mapped/);
  });

  it("imports a statement once: the same content again is the same statement", async () => {
    const st = buildStatement("TEST-ESCROW-01", "2026-10-12", 0n, [line("RAAST-A-0001", 1_000n), line("RAAST-A-0002", 500n), line("RAAST-A-0001", -1_000n)]);
    const before = await audit("bank.imported");
    const id = await importStatement(db, st, "ops");
    expect(await importStatement(db, st, "ops-again")).toBe(id);
    expect(await audit("bank.imported")).toBe(before + 1);
    const { rows } = await db.query<{ n: string }>("SELECT count(*) AS n FROM recon.bank_lines WHERE statement_id = $1", [id.toString()]);
    expect(rows[0]?.n).toBe("3");
  });

  it("refuses a different statement for the same day, broken balances and reused references", async () => {
    const day2 = (lines: ReturnType<typeof line>[], opening = 500n) => buildStatement("TEST-ESCROW-01", "2026-10-13", opening, lines.map((l) => ({ ...l, valueDate: "2026-10-13" })));
    await expect(importStatement(db, buildStatement("TEST-ESCROW-01", "2026-10-12", 0n, [line("RAAST-B-0001", 7n)]), "ops")).rejects.toThrow(/different statement/);
    const wrongClosing = { ...day2([line("RAAST-C-0001", 10n)]), closingPaisa: 999n };
    await expect(importStatement(db, wrongClosing, "ops")).rejects.toThrow(/closing balance/);
    const wrongRunning = day2([line("RAAST-C-0001", 10n), line("RAAST-C-0002", 5n)]);
    const tampered = { ...wrongRunning, lines: wrongRunning.lines.map((l, i) => (i === 0 ? { ...l, balancePaisa: l.balancePaisa + 1n } : l)) };
    await expect(importStatement(db, tampered, "ops")).rejects.toThrow(/running balance/);
    await expect(importStatement(db, day2([line("RAAST-C-0003", 1n), line("RAAST-C-0003", 2n)]), "ops")).rejects.toThrow(/repeated/);
    await expect(importStatement(db, day2([line("RAAST-A-0002", 3n)]), "ops")).rejects.toThrow(/already imported/);
    await expect(importStatement(db, buildStatement("TEST-ESCROW-01", "2026-10-13", 500n, [line("RAAST-C-0004", 3n, "2026-10-14")]), "ops")).rejects.toThrow(/after the statement date/);
    await expect(importStatement(db, buildStatement("UNKNOWN-01", "2026-10-13", 0n, []), "ops")).rejects.toThrow(/unknown bank account/);
    // Same reference in the other direction (a refund) is fine.
    expect(await importStatement(db, day2([line("RAAST-A-0002", -500n)]), "ops")).toBeGreaterThan(0n);
  });

  it("refuses malformed amounts even when the client is bypassed", async () => {
    for (const amount of ["1.5", "0", "abc", 100]) {
      await expect(db.query("SELECT recon.import_bank_statement('ops', 'TEST-ESCROW-01', '2026-10-20', 0, 0, $1::jsonb)", [
        JSON.stringify([{ valueDate: "2026-10-20", amountPaisa: amount, reference: "RAAST-X-0001", counterparty: "x", balancePaisa: "0" }]),
      ])).rejects.toThrow(/malformed/);
    }
  });
});

describe("roles (R-7)", () => {
  it("lets the writer run reconciliations but never unfreeze or write tables", async () => {
    await asRole("pt_recon_writer", async () => {
      await expect(db.query("SELECT recon.request_unfreeze('w', 'writer wants to unfreeze')")).rejects.toThrow(/permission denied/);
    });
    await asRole("pt_recon_writer", async () => {
      await expect(db.query("INSERT INTO recon.gate_events (action, request_id, actor, reason) VALUES ('unfreeze', 1, 'w', 'x')")).rejects.toThrow(/permission denied/);
    });
    await asRole("pt_recon_writer", async () => {
      await expect(db.query("UPDATE recon.runs SET status = 'passed'")).rejects.toThrow(/permission denied/);
    });
    await asRole("pt_recon_writer", async () => {
      const { rows } = await db.query<{ id: string }>("SELECT recon.start_run('w', 'd', '{}'::jsonb) AS id");
      expect(Number(rows[0]?.id)).toBeGreaterThan(0);
    });
  });

  it("lets the operator decide but not record runs; readers only read; services only ask the gate", async () => {
    await asRole("pt_recon_operator", async () => {
      await expect(db.query("SELECT recon.complete_run(1, 'o', 1, '[]'::jsonb, '{}'::jsonb)")).rejects.toThrow(/permission denied/);
    });
    await asRole("pt_recon_reader", async () => {
      await expect(db.query("SELECT recon.start_run('r', 'd', '{}'::jsonb)")).rejects.toThrow(/permission denied/);
    });
    await asRole("pt_recon_reader", async () => {
      expect((await db.query("SELECT * FROM recon.findings LIMIT 1")).rowCount).toBeGreaterThanOrEqual(0);
    });
    for (const role of ["pt_signer", "pt_outbox_worker"]) {
      await asRole(role, async () => {
        const { rows } = await db.query<{ ok: boolean }>("SELECT recon.payouts_allowed() AS ok");
        expect(typeof rows[0]?.ok).toBe("boolean");
      });
      await asRole(role, async () => {
        await expect(db.query("SELECT * FROM recon.runs")).rejects.toThrow(/permission denied/);
      });
    }
  });
});

describe("audit chain (R-6)", () => {
  it("is intact, whatever the session time zone", async () => {
    expect((await db.query("SELECT * FROM recon.verify_audit()")).rows).toEqual([]);
    await db.query("SET TimeZone = 'America/New_York'");
    expect((await db.query("SELECT * FROM recon.verify_audit()")).rows).toEqual([]);
    await db.query("RESET TimeZone");
  });

  it("detects changed findings, changed statements, direct inserts and edited audit rows", async () => {
    const { run } = await finishRun([BLOCKING]);
    await rogue("recon.findings", "findings_append_only", "UPDATE recon.findings SET severity = 'warning' WHERE run_id = $1", [run.toString()]);
    await rogue("recon.bank_lines", "bank_lines_append_only", "UPDATE recon.bank_lines SET amount_paisa = amount_paisa + 1 WHERE line_no = 1");
    await db.query("INSERT INTO recon.gate_events (action, run_id, actor, reason) VALUES ('freeze', $1, 'rogue', 'inserted directly')", [run.toString()]);
    await rogue("recon.audit", "audit_append_only", "UPDATE recon.audit SET actor = 'someone-else' WHERE id = 1");
    const problems = (await db.query<{ problem: string }>("SELECT problem FROM recon.verify_audit()")).rows.map((r) => r.problem);
    expect(problems).toEqual(expect.arrayContaining([
      "content does not match its hash",
      `run ${run.toString()} or its findings changed after it finished`,
      expect.stringMatching(/^bank statement \d+ changed after import$/),
      expect.stringMatching(/^gate event \d+ has no audit entry$/),
    ]));
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cast, createWorld, type Cast, type World } from "../support/world";

/**
 * Health and alerts (migration 0052 MH-1..MH-5): the database checks, the servers' pt-health
 * reports, alerts that open, rise and resolve with the checks, and acknowledgements by operations
 * officers only.
 */
let w: World;
let c: Cast;
type R = { ok: boolean; status?: string; error?: string; opened?: number };
type Check = { source: string; check: string; level: string; detail: string; since: string | null };
type Alert = { id: number; check: string; level: string; detail: string; acknowledgedBy: string | null; resolvedAt: string | null };
type Health = { checks: Check[]; open: Alert[]; closed: Alert[]; reports: { host: string }[]; canAcknowledge: boolean };

beforeAll(async () => {
  w = await createWorld();
  c = await cast(w);
});
afterAll(async () => {
  await w.drop();
});

async function code(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return (e as { code?: string }).code;
  }
}

async function one<T>(sql: string, params: unknown[]): Promise<T> {
  const { rows } = await w.portal.query<{ r: T }>(sql, params);
  return rows[0]?.r as T;
}

const read = (s: Buffer) => one<Health>("SELECT admin.health($1) AS r", [s]);
const report = async (host: string, text: string) => (await w.su.query<{ r: { lines: number; changed: number } }>("SELECT monitor.record_report($1, $2) AS r", [host, text])).rows[0]?.r;

describe("health and alerts (migration 0052)", () => {
  it("the database checks are live; ops.read reads them, other roles do not", async () => {
    const h = await read(c.auditor.sessionHash);
    const keys = h.checks.filter((x) => x.source === "database").map((x) => x.check);
    expect(keys).toEqual(expect.arrayContaining(["outbox", "signer", "recon", "anchor", "notify"]));
    // A fresh database has no reconciliation run: payouts are not allowed, which is a warning.
    expect(h.checks.find((x) => x.check === "recon")).toMatchObject({ level: "WARN" });
    expect(h.canAcknowledge).toBe(false);
    expect((await read(c.ops_maker.sessionHash)).canAcknowledge).toBe(true);
    for (const r of [c.legal_officer, c.trustee_officer, c.tax_officer, c.admin, c.property_manager, c.support_agent]) {
      expect(await code(read(r.sessionHash))).toBe("42501");
    }
  });

  it("a server report opens one alert per failing line, skips the database lines and garbage, and never repeats", async () => {
    const text = ["OK   memory: 41% available (1630 MB)", "WARN disk /: 84% used", "CRIT unit pt-backup-db.service: failed (journalctl -u pt-backup-db.service)", "CRIT indexer dep-1: HALTED at block 9", "not a health line", "N/A  backup: not scheduled on this host", "CRIT http http://127.0.0.1/login: got 000 (want 200)"].join("\n");
    expect(await report("demo-1", text)).toMatchObject({ lines: 5 });
    let h = await read(c.ops_checker.sessionHash);
    expect(h.reports.map((r) => r.host)).toEqual(["demo-1"]);
    const server = h.checks.filter((x) => x.source === "server").map((x) => `${x.level} ${x.check}`);
    expect(server).toEqual(expect.arrayContaining(["OK report:demo-1", "WARN host:demo-1:disk /", "CRIT host:demo-1:unit pt-backup-db.service", "OK host:demo-1:memory", "CRIT host:demo-1:http http://127.0.0.1/login"]));
    expect(server.some((x) => x.includes("indexer"))).toBe(false);
    const open = h.open.filter((a) => a.check.startsWith("host:demo-1"));
    expect(open.map((a) => `${a.level} ${a.check}`).sort()).toEqual(["CRIT host:demo-1:http http://127.0.0.1/login", "CRIT host:demo-1:unit pt-backup-db.service", "WARN host:demo-1:disk /"]);
    // The same report again: no second alert, the detail follows the check.
    await report("demo-1", text.replace("84%", "86%"));
    h = await read(c.ops_checker.sessionHash);
    const disk = h.open.filter((a) => a.check === "host:demo-1:disk /");
    expect(disk).toHaveLength(1);
    expect(disk[0]?.detail).toBe("86% used");
    expect(h.checks.find((x) => x.check === "host:demo-1:disk /")?.since).not.toBeNull();
  });

  it("operations officers acknowledge; a rise to CRIT clears it; OK resolves the alert", async () => {
    const id = (await read(c.ops_maker.sessionHash)).open.find((a) => a.check === "host:demo-1:disk /")?.id;
    expect(await code(one("SELECT admin.health_acknowledge($1, $2, 'cleaning old logs') AS r", [c.auditor.sessionHash, id]))).toBe("42501");
    expect(await code(one("SELECT admin.health_acknowledge($1, $2, 'cleaning old logs') AS r", [c.compliance_officer.sessionHash, id]))).toBe("42501");
    expect((await one<R>("SELECT admin.health_acknowledge($1, $2, 'ok') AS r", [c.ops_maker.sessionHash, id])).ok).toBe(false);
    expect(await one<R>("SELECT admin.health_acknowledge($1, $2, 'cleaning old logs') AS r", [c.ops_maker.sessionHash, id])).toEqual({ ok: true, status: "acknowledged" });
    const again = await one<R>("SELECT admin.health_acknowledge($1, $2, 'cleaning old logs too') AS r", [c.platform_owner.sessionHash, id]);
    expect(again.ok).toBe(false);
    expect(again.error).toMatch(/already acknowledged by ops\.maker/);

    await report("demo-1", "CRIT disk /: 95% used");
    let a = (await read(c.ops_maker.sessionHash)).open.find((x) => x.id === id);
    expect(a).toMatchObject({ level: "CRIT", acknowledgedBy: null });

    // The unit line is gone and the disk is fine again: both alerts resolve.
    await report("demo-1", "OK   disk /: 52% used");
    const h = await read(c.ops_maker.sessionHash);
    expect(h.open.some((x) => x.check.startsWith("host:demo-1:"))).toBe(false);
    a = h.closed.find((x) => x.id === id);
    expect(a?.resolvedAt).not.toBeNull();
    const events = await w.su.query<{ action: string; actor: string }>("SELECT action, actor FROM monitor.alert_events WHERE alert_id = $1 ORDER BY id", [id]);
    expect(events.rows.map((e) => `${e.action}:${e.actor}`)).toEqual(["opened:monitor:demo-1", "acknowledged:ops.maker", "raised:monitor:demo-1", "resolved:monitor:demo-1"]);
    const audit = await w.su.query("SELECT 1 FROM admin.audit WHERE action = 'health.acknowledged'");
    expect(audit.rowCount).toBe(1);
  });

  it("an old report is a warning; Check now evaluates; nothing is deleted or written around the API", async () => {
    await w.su.query("UPDATE monitor.reports SET received_at = received_at - interval '1 hour' WHERE host = 'demo-1'");
    const changed = await one<R>("SELECT admin.health_refresh($1) AS r", [c.ops_checker.sessionHash]);
    expect(changed.ok).toBe(true);
    const h = await read(c.ops_checker.sessionHash);
    expect(h.checks.find((x) => x.check === "report:demo-1")).toMatchObject({ level: "WARN" });
    expect(h.open.map((x) => x.check)).toContain("report:demo-1");
    expect(await code(one("SELECT admin.health_refresh($1) AS r", [c.legal_officer.sessionHash]))).toBe("42501");

    const id = h.open.find((x) => x.check === "report:demo-1")?.id;
    expect(await code(w.su.query("UPDATE monitor.alerts SET acknowledged_by = 'ops.maker', acknowledged_at = now(), ack_note = 'written around the API' WHERE id = $1", [id]))).toBe("42501");
    expect(await code(w.su.query("DELETE FROM monitor.alerts WHERE id = $1", [id]))).toBe("42501");
    expect(await code(w.su.query("DELETE FROM monitor.alert_events"))).toBe("42501");
    expect(await code(w.su.query("SELECT monitor.record_report('bad host!', 'OK x: y')"))).toBe("23514");
    expect(await code(w.portal.query("SELECT monitor.record_report('demo-2', 'OK x: y')"))).toBe("42501");
  });

  it("details carry no control characters and at most 300 characters", async () => {
    await report("demo-3", `WARN swap: ${"x".repeat(400)}\u0007`);
    const a = (await read(c.ops_maker.sessionHash)).open.find((x) => x.check === "host:demo-3:swap");
    expect(a?.detail).toHaveLength(300);
    expect(a?.detail.endsWith("x")).toBe(true);
  });
});

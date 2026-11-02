import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cast, createWorld, type Actor, type Cast, type World } from "../support/world";

/**
 * goAML (migration 0050 GA-1..GA-4): placeholder settings and indicator codes, changed only by a
 * compliance officer with a step-up; the goAML data of an STR case for compliance.export only.
 */
let w: World;
let c: Cast;
let counter = Date.now() + 5_000_000;
type R = { ok: boolean; status?: string; error?: string };

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

async function stepUp(a: Actor): Promise<void> {
  await w.portal.query("SELECT admin.record_step_up($1, $2, $3)", [a.sessionHash, a.credentialId, ++counter]);
}

describe("goAML values and data (migration 0050)", () => {
  it("every value starts as a placeholder; only a compliance officer replaces one, audited", async () => {
    const cfg = await one<{ settings: { key: string; placeholder: boolean }[]; indicators: { category: string; placeholder: boolean }[] }>("SELECT admin.goaml_config($1) AS r", [
      c.auditor.sessionHash,
    ]);
    expect(cfg.settings.length).toBeGreaterThan(5);
    expect(cfg.settings.every((s) => s.placeholder)).toBe(true);
    expect(cfg.indicators.map((i) => i.category)).toContain("structuring");

    expect(await code(one("SELECT admin.goaml_set($1, 'setting', 'rentity_id', '1234', 'confirmed by the FMU letter') AS r", [c.ops_maker.sessionHash]))).toBe("42501");
    await stepUp(c.compliance_officer);
    const bad = await one<R>("SELECT admin.goaml_set($1, 'setting', 'nonsense', '1', 'confirmed by the FMU letter') AS r", [c.compliance_officer.sessionHash]);
    expect(bad).toMatchObject({ ok: false, error: "unknown goAML setting" });
    expect(await one<R>("SELECT admin.goaml_set($1, 'setting', 'rentity_id', '1234', 'confirmed by the FMU letter') AS r", [c.compliance_officer.sessionHash])).toEqual({
      ok: true,
      status: "saved",
    });
    expect(await one<R>("SELECT admin.goaml_set($1, 'indicator', 'structuring', 'IND-STR-01', 'FMU indicator list, version 3') AS r", [c.compliance_officer.sessionHash])).toMatchObject({
      ok: true,
    });
    const after = await one<{ settings: { key: string; value: string; placeholder: boolean }[] }>("SELECT admin.goaml_config($1) AS r", [c.compliance_officer.sessionHash]);
    expect(after.settings.find((s) => s.key === "rentity_id")).toMatchObject({ value: "1234", placeholder: false });
    const audit = await w.su.query<{ action: string }>("SELECT action FROM compliance.audit WHERE action = 'goaml.set'");
    expect(audit.rows).toHaveLength(2);
    expect((await w.su.query("SELECT * FROM compliance.verify_audit()")).rows).toEqual([]);
  });

  it("the goAML data of a case: indicator, settings and no personal data; compliance.export only", async () => {
    await stepUp(c.compliance_officer);
    const opened = await one<{ ok: boolean; id: number }>("SELECT admin.open_str($1, NULL, 'structuring', 'Several deposits just below the reporting threshold in one week') AS r", [
      c.compliance_officer.sessionHash,
    ]);
    expect(opened.ok).toBe(true);
    const d = await one<{ case: number; indicator: { code: string; placeholder: boolean }; settings: Record<string, { value: string }>; transactions: unknown[]; subject: unknown }>(
      "SELECT admin.str_goaml_data($1, $2) AS r",
      [c.compliance_officer.sessionHash, opened.id],
    );
    expect(d).toMatchObject({ case: opened.id, indicator: { code: "IND-STR-01", placeholder: false }, transactions: [], subject: null });
    expect(d.settings.rentity_id?.value).toBe("1234");
    expect(await code(one("SELECT admin.str_goaml_data($1, $2) AS r", [c.auditor.sessionHash, opened.id]))).toBe("42501");
    expect(await one("SELECT admin.str_goaml_data($1, 999999) AS r", [c.compliance_officer.sessionHash])).toBeNull();
  });
});

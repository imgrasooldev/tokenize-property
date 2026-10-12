import { rmSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../db/src/migrate.ts";
import { addMigrationsAfter, migrationsUpTo, scratchDatabase } from "../../db/test/helpers.ts";

/**
 * RF-1 (migration 0008): signer.verify_audit() must not depend on the session TimeZone.
 * Rows written before 0008 (digest v1) are verified under any TimeZone without being re-hashed;
 * rows written after use digest v2 (UTC text). Tampering is still detected in both.
 */
const ZONES = ["UTC", "Asia/Karachi", "America/St_Johns", "Asia/Kathmandu", "Pacific/Kiritimati", "Pacific/Pago_Pago"];

let admin: pg.Client;
let drop: () => Promise<void>;
let dir: string;

async function verifyUnder(zone: string): Promise<{ audit_id: string; problem: string }[]> {
  await admin.query(`SET TIME ZONE '${zone}'`);
  const { rows } = await admin.query<{ audit_id: string; problem: string }>("SELECT audit_id::text, problem FROM signer.verify_audit()");
  return rows;
}

async function append(zone: string, n: number, label: string): Promise<void> {
  await admin.query(`SET TIME ZONE '${zone}'`);
  for (let i = 0; i < n; i++) {
    await admin.query("SELECT signer.audit_append($1, 'request.created', gen_random_uuid(), $2::jsonb)", [
      `tester-${label}`,
      JSON.stringify({ i, label, amount: "1000", note: "اردو اور English" }),
    ]);
  }
}

beforeAll(async () => {
  ({ client: admin, drop } = await scratchDatabase());
  dir = migrationsUpTo("0007");
  await migrate(admin, dir);
});

afterAll(async () => {
  await drop();
  rmSync(dir, { recursive: true, force: true });
});

describe("RF-1 signer audit and TimeZone", () => {
  it("reproduces the bug before 0008: rows written in Karachi fail verification in UTC", async () => {
    await append("Asia/Karachi", 5, "legacy");
    expect(await verifyUnder("Asia/Karachi")).toEqual([]);
    const utc = await verifyUnder("UTC");
    expect(utc).toHaveLength(5);
    expect(utc.every((r) => r.problem === "content does not match its hash")).toBe(true);
  });

  it("after 0008, legacy rows verify under every TimeZone without being re-hashed", async () => {
    const before = await admin.query<{ id: string; hash: string }>("SELECT id::text, encode(hash, 'hex') AS hash FROM signer.audit ORDER BY id");
    addMigrationsAfter(dir, "0007");
    await migrate(admin, dir);
    const after = await admin.query<{ id: string; hash: string; digest_version: number }>(
      "SELECT id::text, encode(hash, 'hex') AS hash, digest_version FROM signer.audit ORDER BY id",
    );
    expect(after.rows.map(({ id, hash }) => ({ id, hash }))).toEqual(before.rows); // nothing rewritten
    expect(after.rows.every((r) => r.digest_version === 1)).toBe(true);
    for (const zone of ZONES) expect(await verifyUnder(zone), zone).toEqual([]);
  });

  it("new rows use digest v2 and verify under every TimeZone, mixed with legacy rows", async () => {
    await append("Asia/Kathmandu", 3, "v2-kathmandu");
    await append("America/St_Johns", 3, "v2-stjohns");
    const { rows } = await admin.query<{ v: number; n: string }>("SELECT digest_version AS v, count(*)::text AS n FROM signer.audit GROUP BY 1 ORDER BY 1");
    expect(rows).toEqual([{ v: 1, n: "5" }, { v: 2, n: "6" }]);
    for (const zone of ZONES) expect(await verifyUnder(zone), zone).toEqual([]);
  });

  it("verification leaves the session TimeZone as it was", async () => {
    await admin.query("SET TIME ZONE 'Asia/Kathmandu'");
    await admin.query("BEGIN");
    try {
      await admin.query("SELECT * FROM signer.verify_audit()");
      const { rows } = await admin.query<{ tz: string }>("SELECT current_setting('TimeZone') AS tz");
      expect(rows[0]?.tz).toBe("Asia/Kathmandu");
    } finally {
      await admin.query("COMMIT");
    }
  });

  it("still detects tampering in a legacy row and in a v2 row, under any TimeZone", async () => {
    const ids = await admin.query<{ legacy: string; v2: string }>(
      "SELECT min(id) FILTER (WHERE digest_version = 1)::text AS legacy, max(id) FILTER (WHERE digest_version = 2)::text AS v2 FROM signer.audit",
    );
    const { legacy, v2 } = ids.rows[0] ?? { legacy: "", v2: "" };
    await admin.query("ALTER TABLE signer.audit DISABLE TRIGGER audit_append_only");
    await admin.query(`UPDATE signer.audit SET detail = detail || '{"amount":"9999999"}' WHERE id IN (${legacy}, ${v2})`);
    await admin.query("ALTER TABLE signer.audit ENABLE TRIGGER audit_append_only");
    for (const zone of ["UTC", "Asia/Karachi", "Pacific/Kiritimati"]) {
      const problems = await verifyUnder(zone);
      expect(problems.map((p) => p.audit_id).sort(), zone).toEqual([legacy, v2].sort());
      expect(problems.every((p) => p.problem === "content does not match its hash")).toBe(true);
    }
  });

  it("the new column cannot be used to downgrade a row: rows stay append-only", async () => {
    await expect(admin.query("UPDATE signer.audit SET digest_version = 1 WHERE digest_version = 2")).rejects.toThrow(/append-only/);
  });
});

import { mkdtempSync, rmSync, writeFileSync, appendFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import { migrate } from "../src/migrate.ts";
import { scratchDatabase } from "./helpers.ts";

const REAL_MIGRATIONS = fileURLToPath(new URL("../migrations", import.meta.url));

describe("migrate", () => {
  let client: pg.Client;
  let drop: () => Promise<void>;
  let dir: string;

  beforeEach(async () => {
    ({ client, drop } = await scratchDatabase());
    dir = mkdtempSync(join(tmpdir(), "pt-migrations-"));
  });

  afterEach(async () => {
    await drop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("applies the real migrations and is idempotent", async () => {
    const first = await migrate(client, REAL_MIGRATIONS);
    expect(first.applied.length).toBeGreaterThan(0);
    const second = await migrate(client, REAL_MIGRATIONS);
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toEqual(first.applied);
    const { rows } = await client.query<{ nspname: string }>(
      "SELECT nspname FROM pg_namespace WHERE nspname = ANY($1) ORDER BY 1",
      [["chain", "ledger", "outbox", "recon", "signer"]],
    );
    expect(rows.map((r) => r.nspname)).toEqual(["chain", "ledger", "outbox", "recon", "signer"]);
  });

  it("refuses to run when an applied migration was changed (tamper detection)", async () => {
    writeFileSync(join(dir, "0001_a.sql"), "CREATE TABLE t (id int);");
    await migrate(client, dir);
    appendFileSync(join(dir, "0001_a.sql"), "\n-- edited later");
    await expect(migrate(client, dir)).rejects.toThrow(/changed after it was applied/);
  });

  it("refuses to run when an applied migration is missing on disk", async () => {
    writeFileSync(join(dir, "0001_a.sql"), "SELECT 1;");
    await migrate(client, dir);
    unlinkSync(join(dir, "0001_a.sql"));
    await expect(migrate(client, dir)).rejects.toThrow(/missing on disk/);
  });

  it("rejects bad names and numbering gaps", async () => {
    writeFileSync(join(dir, "0001_a.sql"), "SELECT 1;");
    writeFileSync(join(dir, "0003_c.sql"), "SELECT 1;");
    await expect(migrate(client, dir)).rejects.toThrow(/numbering gap/);
    rmSync(join(dir, "0003_c.sql"));
    writeFileSync(join(dir, "0002_Bad-Name.sql"), "SELECT 1;");
    await expect(migrate(client, dir)).rejects.toThrow(/Bad migration file name/);
  });

  it("rolls back a failing migration completely and records nothing", async () => {
    writeFileSync(join(dir, "0001_a.sql"), "CREATE TABLE partial (id int); SELECT * FROM does_not_exist;");
    await expect(migrate(client, dir)).rejects.toThrow(/0001_a.sql failed/);
    const tables = await client.query("SELECT 1 FROM pg_tables WHERE tablename = 'partial'");
    expect(tables.rowCount).toBe(0);
    const recorded = await client.query("SELECT 1 FROM public.schema_migrations");
    expect(recorded.rowCount).toBe(0);
  });
});

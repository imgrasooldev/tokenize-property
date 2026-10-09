import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type pg from "pg";

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
}

const FILE_PATTERN = /^(\d{4})_[a-z0-9_]+\.sql$/;
/** Arbitrary constant: serialises concurrent migration runs across processes. */
const LOCK_KEY = 586_586_001;

/**
 * Applies `*.sql` files from `dir` in order, each in its own transaction.
 *
 * Safety properties:
 * - Every applied migration's SHA-256 is recorded. If a file that was already applied has changed,
 *   the run stops before touching anything (drift or tampering).
 * - A migration recorded in the database but missing on disk also stops the run.
 * - Names must be `NNNN_lower_snake.sql` with no gaps in numbering.
 * - A session advisory lock prevents two processes migrating at once.
 */
export async function migrate(client: pg.ClientBase, dir: string): Promise<MigrationResult> {
  // `dir` is the migrations folder shipped with the code, never user input.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  files.forEach((f, i) => {
    const m = FILE_PATTERN.exec(f);
    if (!m) throw new Error(`Bad migration file name: ${f}`);
    if (Number(m[1]) !== i + 1) throw new Error(`Migration numbering gap or duplicate at ${f}`);
  });

  await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.schema_migrations (
        name       text PRIMARY KEY,
        sha256     text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const { rows } = await client.query<{ name: string; sha256: string }>(
      "SELECT name, sha256 FROM public.schema_migrations ORDER BY name",
    );
    const recorded = new Map(rows.map((r) => [r.name, r.sha256]));

    for (const name of recorded.keys()) {
      if (!files.includes(name)) throw new Error(`Applied migration ${name} is missing on disk`);
    }

    const result: MigrationResult = { applied: [], alreadyApplied: [] };
    for (const name of files) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      const sql = readFileSync(join(dir, name), "utf8");
      const sha = createHash("sha256").update(sql).digest("hex");
      const known = recorded.get(name);
      if (known !== undefined) {
        if (known !== sha) throw new Error(`Migration ${name} changed after it was applied (checksum mismatch)`);
        result.alreadyApplied.push(name);
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO public.schema_migrations (name, sha256) VALUES ($1, $2)", [name, sha]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${name} failed: ${(err as Error).message}`, { cause: err });
      }
      result.applied.push(name);
    }
    return result;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]);
  }
}

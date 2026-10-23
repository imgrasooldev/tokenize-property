import { copyFileSync, mkdtempSync, readdirSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { migrate } from "../../db/src/migrate.ts";
import { scratchDatabase } from "../../db/test/helpers.ts";
import { ContactSecrets } from "../src/crypto.ts";
import { kindSpec, type EventKind } from "../src/events.ts";

/**
 * A temporary copy of the migrations directory with contiguous numbering. While 0015 (S-02
 * offering) and 0016 (Step 6b) are on other branches, 0017_notify.sql follows a gap that the runner
 * refuses; this copy renumbers every file after a gap (0017 becomes 0015 here). Once those branches
 * are merged the copy is identical to the real directory. Scratch databases only; nothing is
 * committed and no stub migration is written into the repository.
 */
export function contiguousMigrations(): string {
  const src = fileURLToPath(new URL("../../db/migrations", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "pt-migrations-notify-"));
  const files = readdirSync(src)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  files.forEach((f, i) => {
    copyFileSync(join(src, f), join(dir, `${String(i + 1).padStart(4, "0")}${f.slice(4)}`));
  });
  return dir;
}

export interface NotifyDb {
  client: pg.Client;
  pool: pg.Pool;
  settings: pg.ClientConfig;
  secrets: ContactSecrets;
  drop: () => Promise<void>;
}

/** A scratch database with every migration (admin connection) and fresh notify keys. */
export async function makeNotifyDb(): Promise<NotifyDb> {
  const s = await scratchDatabase();
  await migrate(s.client, contiguousMigrations());
  const pool = new pg.Pool({ ...s.settings, max: 8 });
  return {
    client: s.client,
    pool,
    settings: s.settings,
    secrets: ContactSecrets.of(randomBytes(32), randomBytes(32)),
    drop: async () => {
      await pool.end();
      await s.drop();
    },
  };
}

/** A new investor subject id (a KYC subject uuid in production). */
export const investor = (): { type: "investor"; id: string } => ({ type: "investor", id: randomUUID() });

let seq = Math.floor(Math.random() * 1_000_000);
/** A distinct, valid Pakistani mobile number and e-mail address per call. */
export function contacts(): { phone: string; email: string } {
  seq += 1;
  return { phone: `0300${String(1_000_000 + (seq % 9_000_000)).padStart(7, "0")}`, email: `investor${String(seq)}@example.pk` };
}

/**
 * Test-only time travel: makes every pending delivery due and every lease expired. Lease and
 * schedule fields are processing state, not protected by the delivery guard (like the outbox tests).
 */
export async function fastForward(db: pg.ClientBase | pg.Pool): Promise<void> {
  await db.query("UPDATE notify.deliveries SET available_at = now() - interval '1 second' WHERE status = 'pending' AND available_at > now()");
  await db.query("UPDATE notify.deliveries SET lease_until = now() - interval '1 second' WHERE status IN ('claimed', 'sending')");
}

/** The longest values each placeholder type allows: the worst case for SMS length. */
export function longest(kind: EventKind, variant: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, p] of Object.entries(kindSpec(kind).placeholders) as [string, { type: string; choices?: readonly string[] }][]) {
    const v =
      p.type === "utc"
        ? "2026-12-31T23:59:59.999999Z"
        : p.type === "paisa" || p.type === "count"
          ? "999999999999999999"
          : p.type === "last4"
            ? "9999"
            : p.type === "code"
              ? "ABCDEF-123456-ABCDEF-123456-ABCDEF-12345"
              : p.type === "label"
                ? "Samsung Galaxy S24 Ultra (Android 15) Lahore PK"
                : (p.choices?.[variant % p.choices.length] ?? "");
    // eslint-disable-next-line security/detect-object-injection -- names from the catalogue
    out[name] = v;
  }
  return out;
}

export interface NoteRow {
  id: string;
  kind: string;
  category: string;
  status: string;
  key: string;
  params: Record<string, string>;
}

/**
 * Notifications of one recipient (investor = KYC subject uuid, officer = handle), oldest first,
 * optionally of one kind. Producers (migration 0030) write them when the business transaction ends.
 */
export async function notesOf(db: pg.ClientBase | pg.Pool, subjectType: "investor" | "officer", subjectId: string, kind?: string): Promise<NoteRow[]> {
  const { rows } = await db.query<NoteRow>(
    `SELECT n.id::text AS id, n.kind, n.category, n.status, n.idempotency_key AS key, n.params
     FROM notify.notifications n JOIN notify.recipients r ON r.id = n.recipient_id
     WHERE r.subject_type = $1 AND r.subject_id = $2 AND ($3::text IS NULL OR n.kind = $3) ORDER BY n.id`,
    [subjectType, subjectId, kind ?? null],
  );
  return rows;
}

/** Kinds of the investor's notifications, oldest first. */
export async function kindsOf(db: pg.ClientBase | pg.Pool, subjectId: string): Promise<string[]> {
  return (await notesOf(db, "investor", subjectId)).map((n) => n.kind);
}

/** NP-3: how many producers failed (and were recorded) in this database. */
export async function producerFailureCount(db: pg.ClientBase | pg.Pool): Promise<number> {
  const { rows } = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM notify.producer_failures");
  return rows[0]?.n ?? 0;
}


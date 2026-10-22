import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type pg from "pg";
import { keccak256, toBytes, type Hex } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { computeCommitment } from "../src/lib/anchor-commitment";

/**
 * T-047 against PostgreSQL through the website's own role (pt_web_app, member of pt_web) on a
 * throw-away database at the latest migration: the anchor section of /verify and the status rail
 * read anchor.web_status() / anchor.web_recent() (migration 0025), never the anchor tables; the
 * components they return recompute to the recorded commitment; a pending and a failed anchor show
 * as coarse states; the signed transaction, nonce, sender and failure reason never reach the view.
 * Skipped without PostgreSQL or the website role (CI without backend/.env.local).
 */
const backend = join(import.meta.dirname, "..", "..", "backend");
const envFile = join(backend, ".env.local");

async function databaseReady(): Promise<boolean> {
  if (!existsSync(join(backend, "node_modules", "pg")) || !existsSync(envFile)) return false;
  const env = readFileSync(envFile, "utf8");
  if (!/^WEB_PG_USER=/m.test(env) || !/^WEB_PG_PASSWORD=/m.test(env)) return false;
  const port = Number(/^PG_PORT=(\d+)/m.exec(env)?.[1] ?? 5433);
  return new Promise((resolve) => {
    const s = connect({ host: "127.0.0.1", port }, () => {
      s.end();
      resolve(true);
    });
    s.on("error", () => {
      resolve(false);
    });
    s.setTimeout(2_000, () => {
      s.destroy();
      resolve(false);
    });
  });
}
const ready = await databaseReady();

interface Helpers {
  scratchDatabase(): Promise<{ client: pg.Client; settings: pg.ClientConfig; drop: () => Promise<void> }>;
  contiguousMigrations(): string;
}
type Anchors = typeof import("../src/lib/server/anchors");

const CHAIN = 586_650;
const CONTRACT = `0x${"5a".repeat(20)}`;
const BESU_CHAIN = 586_586n;
const hex32 = (): Hex => `0x${randomBytes(32).toString("hex")}`;

let admin: pg.Client;
let drop: (() => Promise<void>) | undefined;
let anchors: Anchors;
let dbm: typeof import("../src/lib/server/db") | undefined;
let block = 1_000n;
let journal = 10n;

/** Records an anchor through the writer API with a real v1 commitment of its components. */
async function record(): Promise<string> {
  block += 25n;
  journal += 3n;
  const besuBlockHash = keccak256(toBytes(`besu-${block.toString()}`));
  const ledgerHeadHash: Hex = `0x${createHash("sha256").update(`head-${journal.toString()}`).digest("hex")}`;
  const commitment = computeCommitment({ besuChainId: BESU_CHAIN, besuBlock: block, besuBlockHash, ledgerJournalId: journal, ledgerHeadHash });
  const { rows } = await admin.query<{ id: string }>("SELECT anchor.record($1, $2, $3, $4, $5, $6, $7, $8, 'web-test') AS id", [
    CHAIN, CONTRACT, BESU_CHAIN.toString(), block.toString(), besuBlockHash, journal.toString(), ledgerHeadHash, commitment,
  ]);
  return rows[0]?.id ?? "";
}

async function confirm(id: string): Promise<{ tx: Hex; raw: string; from: string }> {
  const tx = hex32();
  const raw = `0x02f8${randomBytes(100).toString("hex")}`;
  const from = `0x${randomBytes(20).toString("hex")}`;
  await admin.query("SELECT anchor.mark_sent($1, $2, 41, $3, $4, 'web-test')", [id, tx, from, raw]);
  await admin.query("SELECT anchor.confirm($1, $2, 77, $3, 'web-test')", [id, tx, hex32()]);
  return { tx, raw, from };
}

describe.skipIf(!ready)("T-047 anchor status for the website against PostgreSQL (pt_web_app)", () => {
  beforeAll(async () => {
    const helpers = (await import(/* @vite-ignore */ pathToFileURL(join(backend, "packages", "db", "test", "helpers.ts")).href)) as Helpers;
    const { migrate } = (await import(/* @vite-ignore */ pathToFileURL(join(backend, "packages", "db", "src", "migrate.ts")).href)) as {
      migrate: (c: pg.ClientBase, dir: string) => Promise<unknown>;
    };
    const s = await helpers.scratchDatabase();
    admin = s.client;
    drop = s.drop;
    await migrate(admin, helpers.contiguousMigrations());
    const name = s.settings.database ?? "";
    if (!/^pt_scratch_/.test(name)) throw new Error("expected a scratch database");
    process.env.WEB_DB_NAME = name;
    // No anchor chain in this test: the public value is unreadable and the page says so.
    process.env.ANCHOR_RPC_URL = "http://127.0.0.1:9";
    process.env.ANCHOR_INTERVAL_SECONDS = "900";
    delete process.env.ANCHOR_CONTRACT;
    anchors = await import("../src/lib/server/anchors");
    dbm = await import("../src/lib/server/db");
  }, 300_000);

  afterAll(async () => {
    if (dbm) await (await dbm.db()).end();
    if (drop) await drop();
  }, 120_000);

  it("connects as the website's role, which cannot read the anchor tables", async () => {
    const pool = await dbm?.db();
    if (!pool) throw new Error("no pool");
    const { rows } = await pool.query<{ u: string; member: boolean }>("SELECT current_user AS u, pg_has_role(current_user, 'pt_web', 'USAGE') AS member");
    expect(rows[0]?.member).toBe(true);
    expect(rows[0]?.u).not.toBe("pt_admin");
    await expect(pool.query("SELECT 1 FROM anchor.anchors LIMIT 1")).rejects.toMatchObject({ code: "42501" });
    await expect(pool.query("SELECT 1 FROM anchor.history LIMIT 1")).rejects.toMatchObject({ code: "42501" });
  });

  it("says none before the first anchor", async () => {
    anchors.resetAnchorCaches();
    expect((await anchors.anchorSection()).state).toBe("none");
    expect(await anchors.anchorRailStatus()).toEqual({ state: "none" });
  });

  it("shows confirmed anchors with components that recompute to the recorded commitment, and a pending one", async () => {
    const secrets: { raw: string; from: string }[] = [];
    for (let i = 0; i < 2; i++) secrets.push(await confirm(await record()));
    const pending = await record();
    anchors.resetAnchorCaches();
    const a = await anchors.anchorSection();
    if (a.state !== "ok") throw new Error(`state ${a.state}`);
    expect(a).toMatchObject({ chainId: CHAIN, contract: CONTRACT, publicReachable: false, maxAgeMs: 1_800_000 });
    expect(a.status).toMatchObject({ count: 2, open: "pending", anchorBlock: "77" });
    expect(a.status.besuBlock).toBe((block - 25n).toString());
    expect(a.anchors.map((x) => x.status)).toEqual(["recorded", "confirmed", "confirmed"]);
    expect(a.anchors[0]?.id).toBe(pending);
    for (const x of a.anchors) {
      expect(x.publicValue).toBeNull();
      const again = computeCommitment({
        besuChainId: BigInt(x.besuChainId),
        besuBlock: BigInt(x.besuBlock),
        besuBlockHash: x.besuBlockHash,
        ledgerJournalId: BigInt(x.ledgerJournalId),
        ledgerHeadHash: x.ledgerHeadHash,
      });
      expect(again).toBe(x.recorded);
    }
    expect(a.status.commitment).toBe(a.anchors[1]?.recorded);
    // Never the signed transaction or its sender.
    const json = JSON.stringify(a);
    for (const s of secrets) {
      expect(json).not.toContain(s.raw.slice(6, 60));
      expect(json).not.toContain(s.from.slice(2));
    }

    const rail = await anchors.anchorRailStatus();
    if (rail.state !== "ok") throw new Error(`rail ${rail.state}`);
    expect(rail).toMatchObject({ chainId: CHAIN, count: 2, open: "pending", maxAgeMs: 1_800_000 });
    expect(Date.now() - (rail.confirmedAt ?? 0)).toBeLessThan(60_000);
  });

  it("shows a failed anchor as a coarse state without its reason, and never lists it", async () => {
    const { rows } = await admin.query<{ id: string }>("SELECT id::text FROM anchor.anchors WHERE status = 'recorded'");
    const open = rows[0]?.id ?? "";
    await admin.query("SELECT anchor.fail($1, 'reverted: secret-internal-detail 10.1.2.3', 'web-test')", [open]);
    anchors.resetAnchorCaches();
    const a = await anchors.anchorSection();
    if (a.state !== "ok") throw new Error(`state ${a.state}`);
    expect(a.status.open).toBe("failed");
    expect(a.anchors.map((x) => x.id)).not.toContain(open);
    expect(JSON.stringify(a)).not.toContain("secret-internal-detail");
    expect(await anchors.anchorRailStatus()).toMatchObject({ state: "ok", open: "failed" });
  });
});

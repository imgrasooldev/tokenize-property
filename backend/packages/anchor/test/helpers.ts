import { fileURLToPath } from "node:url";
import { openAccount, postJournal } from "@pt/ledger";
import pg from "pg";
import { migrate } from "../../db/src/migrate.ts";
import { scratchDatabase, serviceLogin } from "../../db/test/helpers.ts";

export const MIGRATIONS = fileURLToPath(new URL("../../db/migrations", import.meta.url));

/**
 * A migrated throw-away database with an admin pool (`pool`, for fixtures such as ledger journals)
 * and `anchor`, a pool connected as a login in pt_svc_anchor (T-012, migration 0029): the anchoring
 * job and verify run as in production.
 */
export async function migratedDatabase(): Promise<{ admin: pg.Client; pool: pg.Pool; anchor: pg.Pool; settings: pg.ClientConfig; drop: () => Promise<void> }> {
  const { client, settings, drop } = await scratchDatabase();
  await migrate(client, MIGRATIONS);
  const pool = new pg.Pool({ ...settings, max: 8 });
  const login = await serviceLogin("anchor", String(settings.database));
  const anchor = new pg.Pool({ ...login.settings, max: 4 });
  return {
    admin: client,
    pool,
    anchor,
    settings,
    drop: async () => {
      await pool.end();
      await anchor.end();
      await drop();
      await login.drop();
    },
  };
}

let seq = 0;

/** Posts `n` small balanced journals (opening the two accounts once). Returns the last journal id. */
export async function postJournals(db: pg.ClientBase | pg.Pool, n: number, memo?: string): Promise<bigint> {
  await openAccount(db, { code: "bank:hbl", kind: "asset", asset: "PKR" });
  await openAccount(db, { code: "investor:test", kind: "liability", asset: "PKR" });
  let id = 0n;
  for (let i = 0; i < n; i++) {
    seq++;
    id = await postJournal(db, {
      idempotencyKey: `anchor-test:${String(process.pid)}:${String(Date.now())}:${String(seq)}`,
      kind: "investor_deposit",
      memo: memo ?? `deposit ${String(seq)}`,
      createdBy: "anchor-test",
      postings: [
        { account: "bank:hbl", amount: BigInt(100 + seq) },
        { account: "investor:test", amount: -BigInt(100 + seq) },
      ],
    });
  }
  return id;
}

/**
 * A rogue DBA rewrites history: changes a journal's memo with the triggers off, then recomputes the
 * whole hash chain with the database's own digest so ledger.verify_chain() is clean again.
 */
export async function rehashLedgerAfterEdit(admin: pg.Client, journalId: bigint, memo: string): Promise<void> {
  await admin.query("BEGIN");
  await admin.query("SET LOCAL session_replication_role = replica");
  await admin.query("UPDATE ledger.journal SET memo = $2 WHERE id = $1", [journalId.toString(), memo]);
  await admin.query(`DO $$
    DECLARE j record; v_prev bytea := decode(repeat('00', 32), 'hex'); v_rows jsonb; v_hash bytea;
    BEGIN
      FOR j IN SELECT * FROM ledger.journal ORDER BY id LOOP
        SELECT jsonb_agg(jsonb_build_array(p.account_id, p.asset, p.amount::text) ORDER BY p.id) INTO v_rows
        FROM ledger.postings p WHERE p.journal_id = j.id;
        v_hash := ledger.digest(v_prev, j.id, j.idempotency_key, j.kind, j.memo, j.external_ref, j.created_by, j.created_at, v_rows);
        UPDATE ledger.journal SET prev_hash = v_prev, hash = v_hash WHERE id = j.id;
        v_prev := v_hash;
      END LOOP;
    END $$`);
  await admin.query("COMMIT");
}

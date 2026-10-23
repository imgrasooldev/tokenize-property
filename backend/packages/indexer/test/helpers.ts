import { fileURLToPath } from "node:url";
import pg from "pg";
import { migrate } from "../../db/src/migrate.ts";
import { scratchDatabase, serviceLogin } from "../../db/test/helpers.ts";
import { decodeLog } from "../src/decode.ts";
import { rolesByAddress, type Address, type Deployment, type Hex } from "../src/deployment.ts";
import { ReadModel, type Snapshot } from "../src/model.ts";
import { readSnapshot } from "../src/snapshot.ts";
import type { ChainSource } from "../src/source.ts";

export const MIGRATIONS = fileURLToPath(new URL("../../db/migrations", import.meta.url));

/** A migrated throw-away database. */
export async function migratedDatabase(): Promise<{ admin: pg.Client; settings: pg.ClientConfig; drop: () => Promise<void> }> {
  const { client, settings, drop } = await scratchDatabase();
  await migrate(client, MIGRATIONS);
  return { admin: client, settings, drop };
}

/** What the read model must contain: every log of the deployment up to `to`, folded through the reference model. */
export async function expected(source: ChainSource, d: Deployment, to: bigint): Promise<Snapshot> {
  const model = new ReadModel(d);
  const roles = rolesByAddress(d);
  const logs = to >= d.fromBlock ? await source.logs([...roles.keys()] as Address[], d.fromBlock, to) : [];
  for (const l of logs) {
    const role = roles.get(l.address.toLowerCase());
    if (!role) continue;
    const { name, args } = decodeLog(role, l.topics, l.data);
    model.apply({
      blockNumber: l.blockNumber, blockHash: l.blockHash.toLowerCase() as Hex, logIndex: l.logIndex, txHash: l.transactionHash.toLowerCase() as Hex,
      txIndex: l.transactionIndex, address: l.address.toLowerCase(), role, name, args, topics: l.topics.map((t) => t.toLowerCase() as Hex), data: l.data.toLowerCase() as Hex,
    });
  }
  return model.snapshot();
}

/** A pool connected as a login in pt_svc_indexer (T-012, migration 0029): the indexer runs as in production. */
export async function indexerPool(settings: pg.ClientConfig, max: number): Promise<{ pool: pg.Pool; drop: () => Promise<void> }> {
  const login = await serviceLogin("indexer", String(settings.database));
  const pool = new pg.Pool({ ...login.settings, max });
  return {
    pool,
    drop: async () => {
      await pool.end();
      await login.drop();
    },
  };
}

export async function actual(db: pg.ClientBase, d: Deployment): Promise<Snapshot> {
  return readSnapshot(db, d);
}

import { fileURLToPath } from "node:url";
import { LOCAL_DEV_CHAIN_ID, readEnvFile } from "@pt/config";
import { createLogger } from "@pt/logger";
import pg from "pg";
import { deploymentFromBroadcast, LOCAL_BROADCAST, type Deployment } from "./deployment.ts";
import { Indexer } from "./indexer.ts";
import { rpcSource } from "./source.ts";
import { verify } from "./verify.ts";

/**
 * Indexer commands (run from backend/):
 *   npm run indexer              follow the chain into schema `chain` (Ctrl+C to stop)
 *   npm run indexer:verify       rebuild from the chain and compare with the read model (exit 1 on any difference)
 *   npm run indexer:status       cursor, lag and halt state
 *   npm run indexer:reset-local -- --yes   LOCAL DEV ONLY: empty the read model after `python chain/net.py reset`
 * Settings: CHAIN_RPC_URL (default http://127.0.0.1:8545), CHAIN_ID (default 586586),
 * INDEXER_DEPLOYMENT_FILE (default: the local DeployLib broadcast), PG_* from backend/.env.local.
 * Locally this connects as the admin; in production it runs as a login role in pt_chain_writer
 * (verify and status need only pt_chain_reader).
 */
const BACKEND = fileURLToPath(new URL("../../../", import.meta.url));

function env(): Record<string, string | undefined> {
  return { ...readEnvFile(`${BACKEND}.env.local`), ...process.env };
}

function pool(): pg.Pool {
  const e = env();
  return new pg.Pool({
    host: e.PG_HOST ?? "127.0.0.1",
    port: Number(e.PG_PORT ?? 5433),
    user: e.INDEXER_PG_USER ?? e.PG_ADMIN_USER ?? "pt_admin",
    password: e.INDEXER_PG_PASSWORD ?? e.PG_ADMIN_PASSWORD,
    database: e.PG_DATABASE ?? "property_token",
    application_name: "indexer",
    max: 4,
    statement_timeout: 15_000,
    idle_in_transaction_session_timeout: 150_000,
    connectionTimeoutMillis: 5_000,
  });
}

function deployment(): Deployment {
  const e = env();
  const chainId = Number(e.CHAIN_ID ?? LOCAL_DEV_CHAIN_ID);
  if (e.NODE_ENV === "production" && chainId === LOCAL_DEV_CHAIN_ID) throw new Error("the local dev chain ID is not allowed in production");
  const file = e.INDEXER_DEPLOYMENT_FILE ?? LOCAL_BROADCAST;
  const d = deploymentFromBroadcast(file, chainId);
  if (!d) throw new Error(`no deployment in ${file}; run python chain/flow.py (or set INDEXER_DEPLOYMENT_FILE)`);
  return d;
}

const rpc = (): string => env().CHAIN_RPC_URL ?? "http://127.0.0.1:8545";

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function run(): Promise<void> {
  const log = createLogger({ service: "indexer", level: env().LOG_LEVEL ?? "info" });
  const db = pool();
  const d = deployment();
  let halted = false;
  const indexer = new Indexer(db, rpcSource(rpc()), d, {
    actor: `indexer@${process.pid.toString()}`,
    onBatch: (r) => {
      log.info({ from: r.from.toString(), to: r.to.toString(), events: r.events, behind: r.behind.toString() }, "batch applied");
    },
    onError: (err) => {
      log.warn({ err }, "transient error; retrying");
    },
    onHalt: (err) => {
      halted = true;
      log.fatal({ err }, "INDEXER HALTED: the chain does not match the read model. Investigate before restarting (ADR 0006).");
      process.exitCode = 3;
      void indexer.stop().then(() => db.end());
    },
  });
  await indexer.start();
  log.info({ deployment: d.id, fromBlock: d.fromBlock.toString(), rpc: rpc() }, "indexer following the chain");
  const shutdown = (): void => {
    if (halted) return;
    log.info("stopping");
    void indexer.stop().then(() => db.end());
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

async function runVerify(): Promise<void> {
  const db = pool();
  const source = rpcSource(rpc());
  try {
    const report = await verify(db, source, deployment(), { state: source.client });
    out(`${report.ok ? "OK" : "MISMATCH"} · deployment ${report.deployment} · pinned block ${report.pinnedBlock.toString()} · ` +
      `${String(report.events)} events · ${String(report.holders)} holders · ${String(report.stateReads)} contract reads · ${String(report.ms)} ms`);
    for (const p of report.problems) out(`  - ${p}`);
    if (!report.ok) process.exitCode = 1;
  } finally {
    await db.end();
  }
}

async function status(): Promise<void> {
  const db = pool();
  const source = rpcSource(rpc());
  try {
    const d = deployment();
    const { rows } = await db.query<{ block_number: string; batches: string; events: string; updated_at: Date; halt_reason: string | null }>(
      "SELECT block_number, batches, events, updated_at, halt_reason FROM chain.cursors WHERE deployment = $1", [d.id]);
    const c = rows[0];
    if (!c) {
      out(`deployment ${d.id} is not indexed yet (npm run indexer)`);
      return;
    }
    const head = await source.head();
    out(`deployment ${d.id} · block ${c.block_number} of ${head.toString()} (${(head - BigInt(c.block_number)).toString()} behind) · ` +
      `${c.events} events in ${c.batches} batches · updated ${c.updated_at.toISOString()}`);
    if (c.halt_reason) {
      out(`HALTED: ${c.halt_reason}`);
      process.exitCode = 3;
    }
  } finally {
    await db.end();
  }
}

/**
 * A reset local network reuses chain ID 586586 with new block hashes, which the read model refuses
 * (one database follows one network; history is append-only). This empties schema `chain` so the
 * new network can be indexed. Refused outside development, for any other chain ID, and without --yes.
 * Uses the admin's session_replication_role to bypass the append-only triggers for this one session.
 */
async function resetLocal(args: string[]): Promise<void> {
  const e = env();
  if (e.NODE_ENV === "production" || Number(e.CHAIN_ID ?? LOCAL_DEV_CHAIN_ID) !== LOCAL_DEV_CHAIN_ID) {
    throw new Error("reset-local is only for the local dev chain (586586) outside production");
  }
  if (!args.includes("--yes")) throw new Error("this deletes the local read model; add --yes");
  const db = pool();
  const client = await db.connect();
  try {
    const { rows } = await client.query<{ chain_id: string }>("SELECT DISTINCT chain_id FROM chain.deployments");
    if (rows.some((r) => Number(r.chain_id) !== LOCAL_DEV_CHAIN_ID)) throw new Error("the read model holds another chain; refusing");
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(`TRUNCATE chain.transfers, chain.issuances, chain.freeze_actions, chain.events, chain.blocks, chain.holdings,
      chain.freezes, chain.tokens, chain.distributions, chain.documents, chain.recoveries, chain.investors, chain.halts,
      chain.cursors, chain.contracts, chain.deployments`);
    await client.query("COMMIT");
    out(`local read model emptied (${e.PG_DATABASE ?? "property_token"}); run npm run indexer to rebuild it`);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
    await db.end();
  }
}

const [cmd, ...rest] = process.argv.slice(2);
// Unknown extra arguments are refused, so a mistyped command never silently starts following.
const strict = (fn: () => Promise<void>) => (): Promise<void> => (rest.length ? Promise.reject(new Error(`unexpected arguments: ${rest.join(" ")}`)) : fn());
const command = { run: strict(run), verify: strict(runVerify), status: strict(status), "reset-local": () => resetLocal(rest) }[cmd ?? ""];
if (!command) {
  out("commands: run | verify | status | reset-local --yes");
  process.exitCode = 2;
} else {
  command().catch((e: unknown) => {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  });
}

import { randomBytes } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { LOCAL_DEV_CHAIN_ID, readEnvFile, servicePgAuth } from "@pt/config";
import { createLogger } from "@pt/logger";
import pg from "pg";
import { z } from "zod";
import { AnchorAlarm, Anchorer, type RunResult } from "./anchorer.ts";
import { rpcAnchorChain, rpcBesu } from "./chains.ts";
import { anchorDeploymentFromBroadcast, type AnchorDeployment } from "./deployment.ts";
import { ANCHOR_KEY_REF, createDevAnchorKey, openDevAnchorKeys } from "./keys.ts";
import { LOCAL_ANCHOR_CHAIN_ID } from "./network.ts";
import { anchorsOf } from "./store.ts";
import { verifyAnchors } from "./verify.ts";

/**
 * Public-chain anchoring (run from backend/; ADR 0008):
 *   npm run anchor:setup     LOCAL DEV ONLY: create the anchor key in its own encrypted keystore
 *   npm run anchor           anchor every ANCHOR_INTERVAL_SECONDS (default 3600) until Ctrl+C
 *   npm run anchor:once      one anchoring step (finish the open anchor, or write a new one)
 *   npm run anchor:verify    check every public anchor against the private chain and the ledger (exit 1 on any mismatch)
 *   npm run anchor:status    the anchor records in this database
 * Exit code 3 = alarm (fail closed): a human must look before anchoring continues.
 * Connects as the anchoring job's own login (ANCHOR_PG_USER, group pt_svc_anchor, migration 0029;
 * `npm run db:service-roles`); PT_DB_ADMIN_FALLBACK=1 lets local development use the admin.
 */
const BACKEND = fileURLToPath(new URL("../../../", import.meta.url));
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const ENV_FILE = `${BACKEND}.env.local`;

function env(): Record<string, string | undefined> {
  return { ...readEnvFile(ENV_FILE), ...process.env };
}

const settingsSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  CHAIN_RPC_URL: z.url().default("http://127.0.0.1:8545"),
  CHAIN_ID: z.coerce.number().int().positive().default(LOCAL_DEV_CHAIN_ID),
  ANCHOR_RPC_URL: z.url().default("http://127.0.0.1:8650"),
  ANCHOR_CHAIN_ID: z.coerce.number().int().positive().default(LOCAL_ANCHOR_CHAIN_ID),
  ANCHOR_ALLOW_CHAIN_ID: z.coerce.number().int().positive().optional(),
  ANCHOR_CONTRACT: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  ANCHOR_FROM_BLOCK: z.coerce.bigint().nonnegative().optional(),
  ANCHOR_INTERVAL_SECONDS: z.coerce.number().int().min(10).max(86_400).default(3_600),
  ANCHOR_RETRY_SECONDS: z.coerce.number().int().min(5).max(3_600).default(60),
  ANCHOR_CONFIRMATIONS: z.coerce.bigint().nonnegative().optional(),
  ANCHOR_BESU_CONFIRMATIONS: z.coerce.bigint().nonnegative().default(0n),
  ANCHOR_GAS_LIMIT: z.coerce.bigint().min(50_000n).max(1_000_000n).default(150_000n),
  ANCHOR_MAX_GAS_PRICE_WEI: z.coerce.bigint().positive().default(50_000_000_000n),
  ANCHOR_MAX_PRIORITY_FEE_WEI: z.coerce.bigint().nonnegative().default(2_000_000_000n),
  ANCHOR_LOG_WINDOW: z.coerce.bigint().min(1n).max(5_000n).default(2_000n),
  ANCHOR_KEYSTORE_DIR: z.string().min(1).default(`${BACKEND}data/keystore-anchor`),
  ANCHOR_KEYSTORE_PASSPHRASE: z.string().min(32).optional(),
});
type Settings = z.infer<typeof settingsSchema>;

function settings(): Settings {
  const parsed = settingsSchema.safeParse(env());
  // Only key names are reported, never values (the passphrase is among them).
  if (!parsed.success) throw new Error(`Invalid configuration: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const s = parsed.data;
  if (s.ANCHOR_CHAIN_ID !== LOCAL_ANCHOR_CHAIN_ID && s.ANCHOR_CONFIRMATIONS === undefined) {
    throw new Error("ANCHOR_CONFIRMATIONS must be set explicitly for any chain other than the local stand-in");
  }
  return s;
}

function pool(): pg.Pool {
  const e = env();
  return new pg.Pool({
    host: e.PG_HOST ?? "127.0.0.1",
    port: Number(e.PG_PORT ?? 5433),
    ...servicePgAuth(e, "anchor"),
    database: e.PG_DATABASE ?? "property_token",
    application_name: "anchor",
    max: 3,
    statement_timeout: 15_000,
    idle_in_transaction_session_timeout: 30_000,
    connectionTimeoutMillis: 5_000,
  });
}

function deployment(s: Settings): AnchorDeployment {
  if (s.ANCHOR_CONTRACT) {
    return { contract: s.ANCHOR_CONTRACT.toLowerCase() as `0x${string}`, chainId: s.ANCHOR_CHAIN_ID, fromBlock: s.ANCHOR_FROM_BLOCK ?? 0n };
  }
  const file = `${ROOT}contracts/broadcast/DeployAnchor.s.sol/${String(s.ANCHOR_CHAIN_ID)}/run-latest.json`;
  const d = anchorDeploymentFromBroadcast(file, s.ANCHOR_CHAIN_ID);
  if (!d) throw new Error(`no StateAnchor deployment in ${file}; run python chain/anchor.py deploy (or set ANCHOR_CONTRACT)`);
  return s.ANCHOR_FROM_BLOCK === undefined ? d : { ...d, fromBlock: s.ANCHOR_FROM_BLOCK };
}

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function setup(): Promise<void> {
  const s = settings();
  if (s.NODE_ENV === "production") throw new Error("anchor:setup creates a local dev key and is for development only");
  if (!s.ANCHOR_KEYSTORE_PASSPHRASE) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed path inside backend/
    await appendFile(ENV_FILE, `\n# anchor keystore (local dev, generated)\nANCHOR_KEYSTORE_PASSPHRASE=${randomBytes(32).toString("base64url")}\n`, { mode: 0o600 });
  }
  const passphrase = settings().ANCHOR_KEYSTORE_PASSPHRASE ?? "";
  try {
    const keys = await openDevAnchorKeys(s.ANCHOR_KEYSTORE_DIR, passphrase);
    out(`anchor key exists: ${keys.address(ANCHOR_KEY_REF)} (${s.ANCHOR_KEYSTORE_DIR})`);
  } catch {
    const address = await createDevAnchorKey(s.ANCHOR_KEYSTORE_DIR, passphrase);
    out(`anchor key created: ${address} (${s.ANCHOR_KEYSTORE_DIR}); next: python chain/anchor.py deploy`);
  }
}

async function anchorer(s: Settings, db: pg.Pool): Promise<Anchorer> {
  if (!s.ANCHOR_KEYSTORE_PASSPHRASE) throw new Error("run npm run anchor:setup first (no ANCHOR_KEYSTORE_PASSPHRASE)");
  const d = deployment(s);
  const keys = await openDevAnchorKeys(s.ANCHOR_KEYSTORE_DIR, s.ANCHOR_KEYSTORE_PASSPHRASE);
  return new Anchorer(db, rpcAnchorChain(s.ANCHOR_RPC_URL), rpcBesu(s.CHAIN_RPC_URL), {
    target: { anchorChainId: s.ANCHOR_CHAIN_ID, contract: d.contract },
    besuChainId: s.CHAIN_ID,
    keys,
    keyRef: ANCHOR_KEY_REF,
    // The only key provider built so far is the local encrypted keystore; the HSM/MPC provider
    // plugs in here. The network policy refuses a dev keystore on any public chain.
    custody: "dev-file",
    production: s.NODE_ENV === "production",
    allowChainId: s.ANCHOR_ALLOW_CHAIN_ID,
    actor: `anchor@${String(process.pid)}`,
    besuConfirmations: s.ANCHOR_BESU_CONFIRMATIONS,
    confirmations: s.ANCHOR_CONFIRMATIONS ?? 0n,
    gasLimit: s.ANCHOR_GAS_LIMIT,
    maxGasPriceWei: s.ANCHOR_MAX_GAS_PRICE_WEI,
    maxPriorityFeeWei: s.ANCHOR_MAX_PRIORITY_FEE_WEI,
  });
}

function describe(r: RunResult): string {
  switch (r.action) {
    case "anchored":
      return `anchored private block ${r.besuBlock.toString()} · commitment ${r.commitment} · tx ${r.txHash} · anchor-chain block ${r.anchorBlock.toString()} · ${String(r.ms)} ms`;
    case "pending":
      return `pending (anchor ${r.id.toString()}): ${r.reason} · ${String(r.ms)} ms`;
    case "skipped":
      return `skipped: ${r.reason} · ${String(r.ms)} ms`;
    case "busy":
      return "busy: another anchoring process holds the lock";
  }
}

async function once(): Promise<void> {
  const s = settings();
  const db = pool();
  try {
    out(describe(await (await anchorer(s, db)).runOnce()));
  } catch (e) {
    if (e instanceof AnchorAlarm) process.exitCode = 3;
    throw e;
  } finally {
    await db.end();
  }
}

async function run(): Promise<void> {
  const s = settings();
  const log = createLogger({ service: "anchor", level: s.LOG_LEVEL });
  const db = pool();
  const job = await anchorer(s, db);
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const stop = (): void => {
    stopped = true;
    if (timer) clearTimeout(timer);
    void db.end();
  };
  const tick = async (): Promise<void> => {
    let next = s.ANCHOR_INTERVAL_SECONDS;
    try {
      const r = await job.runOnce();
      log.info({ action: r.action, ms: r.ms }, describe(r));
      // An open anchor is finished soon instead of an hour later.
      if (r.action === "pending" || r.action === "busy") next = s.ANCHOR_RETRY_SECONDS;
    } catch (e) {
      if (e instanceof AnchorAlarm) {
        log.fatal({ err: e }, "ANCHORING HALTED: investigate before restarting (ADR 0008)");
        process.exitCode = 3;
        stop();
        return;
      }
      log.warn({ err: e }, "anchoring step failed; retrying");
      next = s.ANCHOR_RETRY_SECONDS;
    }
    if (!stopped) timer = setTimeout(() => void tick(), next * 1000);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  log.info({ interval: s.ANCHOR_INTERVAL_SECONDS, anchorRpc: s.ANCHOR_RPC_URL, anchorChainId: s.ANCHOR_CHAIN_ID }, "anchoring started");
  await tick();
}

async function verify(): Promise<void> {
  const s = settings();
  const d = deployment(s);
  const db = pool();
  try {
    const r = await verifyAnchors(db, rpcAnchorChain(s.ANCHOR_RPC_URL), rpcBesu(s.CHAIN_RPC_URL), {
      target: { anchorChainId: s.ANCHOR_CHAIN_ID, contract: d.contract },
      besuChainId: s.CHAIN_ID,
      fromBlock: d.fromBlock,
      logWindow: s.ANCHOR_LOG_WINDOW,
    });
    out(
      `${r.ok ? "OK" : "MISMATCH"} · contract ${d.contract} on chain ${String(s.ANCHOR_CHAIN_ID)} · ${String(r.anchors)} public anchors · ` +
        `${String(r.records)} records · ${String(r.ledgerJournals)} ledger journals · last private block ${r.lastAnchoredBlock.toString()} · ` +
        `blocks ${r.scanned.from.toString()}..${r.scanned.to.toString()} in ${String(r.scanned.windows)} windows · ${String(r.ms)} ms`,
    );
    for (const p of r.problems) out(`  - ${p}`);
    if (!r.ok) process.exitCode = 1;
  } finally {
    await db.end();
  }
}

async function status(): Promise<void> {
  const s = settings();
  const d = deployment(s);
  const db = pool();
  try {
    const records = await anchorsOf(db, { anchorChainId: s.ANCHOR_CHAIN_ID, contract: d.contract });
    out(`contract ${d.contract} on chain ${String(s.ANCHOR_CHAIN_ID)} · ${String(records.length)} anchor records`);
    for (const r of records.slice(-10)) {
      out(`  #${r.id.toString()} private block ${r.besuBlock.toString()} · journal ${r.ledgerJournalId.toString()} · ${r.status}` +
        `${r.tx ? ` · tx ${r.tx.hash}` : ""}${r.failure ? ` · ${r.failure}` : ""} · ${r.createdAt.toISOString()}`);
    }
  } finally {
    await db.end();
  }
}

const [cmd, ...rest] = process.argv.slice(2);
const commands = new Map<string, () => Promise<void>>([["setup", setup], ["run", run], ["once", once], ["verify", verify], ["status", status]]);
const command = commands.get(cmd ?? "");
if (!command) {
  out("commands: setup | run | once | verify | status");
  process.exitCode = 2;
} else if (rest.length) {
  process.stderr.write(`unexpected arguments: ${rest.join(" ")}\n`);
  process.exitCode = 2;
} else {
  command().catch((e: unknown) => {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    if (!process.exitCode) process.exitCode = 1;
  });
}

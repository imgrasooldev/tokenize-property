import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { fileURLToPath } from "node:url";
import { LOCAL_DEV_CHAIN_ID, readEnvFile, servicePgAuth } from "@pt/config";
import { deploymentFromBroadcast, LOCAL_BROADCAST, rpcSource, verify, type Deployment } from "@pt/indexer";
import pg from "pg";
import { importStatement, parseStatement } from "./bank.ts";
import { viemChainState } from "./chain.ts";
import { formatReport, reconcile, reportJson } from "./run.ts";
import { decideUnfreeze, payoutGate, registerBankAccount, requestUnfreeze } from "./store.ts";

/**
 * Reconciliation commands (run from backend/):
 *   npm run recon [-- --json] [-- --sla-minutes 30] [-- --no-verify]
 *        one run; exit 0 = no findings, 1 = findings (blocking ones freeze payouts), 2 = error
 *   npm run recon:import-bank -- <statement.jsonl> [--by <name>]      mock bank format pt-mock-bank-v1
 *   npm run recon:register-account -- <BANK-ACCOUNT> <ledger account code> <operator>
 *   npm run recon:status                                             gate, latest runs, open unfreeze requests
 *   npm run recon:unfreeze -- --request <operator> "<reason>"         maker
 *   npm run recon:unfreeze -- --approve|--reject <requestId> <operator> "<reason>"   checker (a different operator)
 * Settings: CHAIN_RPC_URL, CHAIN_ID, INDEXER_DEPLOYMENT_FILE (default: the local DeployLib broadcast),
 * PG_* from backend/.env.local. run and status use the login RECON_PG_USER (group pt_svc_recon,
 * migration 0029); unfreezing belongs in the operations portal as pt_recon_operator.
 */
const BACKEND = fileURLToPath(new URL("../../../", import.meta.url));

function env(): Record<string, string | undefined> {
  return { ...readEnvFile(`${BACKEND}.env.local`), ...process.env };
}

/**
 * run and status connect as the reconciliation job's own login (RECON_PG_USER, group pt_svc_recon,
 * migration 0029; fail closed). The operator commands (import-bank, register-account, unfreeze) are
 * break-glass tools until their portal screens exist and keep the admin login (`asAdmin`).
 */
function pool(asAdmin = false): pg.Pool {
  const e = env();
  return new pg.Pool({
    host: e.PG_HOST ?? "127.0.0.1",
    port: Number(e.PG_PORT ?? 5433),
    ...(asAdmin ? { user: e.PG_ADMIN_USER ?? "pt_admin", password: e.PG_ADMIN_PASSWORD } : servicePgAuth(e, "recon")),
    database: e.PG_DATABASE ?? "property_token",
    application_name: "recon",
    max: 4,
    statement_timeout: 120_000,
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

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

class UsageError extends Error {}

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v === undefined) throw new UsageError(`${name} needs a value`);
  args.splice(i, 2);
  return v;
}

function flag(args: string[], name: string): boolean {
  const i = args.indexOf(name);
  if (i >= 0) args.splice(i, 1);
  return i >= 0;
}

async function run(args: string[]): Promise<number> {
  const json = flag(args, "--json");
  const noVerify = flag(args, "--no-verify");
  const sla = Number(option(args, "--sla-minutes") ?? "30");
  if (args.length) throw new UsageError(`unexpected arguments: ${args.join(" ")}`);
  if (!Number.isInteger(sla) || sla < 1 || sla > 10_080) throw new UsageError("--sla-minutes must be 1..10080");
  const db = pool();
  const d = deployment();
  const source = rpcSource(env().CHAIN_RPC_URL ?? "http://127.0.0.1:8545");
  try {
    if ((await source.chainId()) !== d.chainId) throw new Error(`the node is not chain ${String(d.chainId)}`);
    const report = await reconcile(db, {
      deployment: d,
      chain: viemChainState(source.client),
      actor: env().RECON_ACTOR ?? `recon@${hostname()}:${String(process.pid)}`,
      slaMinutes: sla,
      verifyIndexer: noVerify ? null : async () => {
        const v = await verify(db, source, d, { state: source.client });
        return { pinnedBlock: v.pinnedBlock, problems: v.problems };
      },
    });
    out(json ? reportJson(report) : formatReport(report));
    return report.status === "error" ? 2 : report.findings.length > 0 ? 1 : 0;
  } finally {
    await db.end();
  }
}

async function importBank(args: string[]): Promise<number> {
  const by = option(args, "--by") ?? env().RECON_ACTOR ?? "recon-cli";
  const [file, ...rest] = args;
  if (!file || rest.length) throw new UsageError("usage: import-bank <statement.jsonl> [--by <name>]");
  // The operator names the file to import on the command line; it is parsed strictly before use.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const st = parseStatement(readFileSync(file, "utf8"));
  const db = pool(true);
  try {
    const id = await importStatement(db, st, by);
    out(`statement ${id.toString()}: ${st.account} ${st.date}, ${String(st.lines.length)} lines, opening ${st.openingPaisa.toString()}, closing ${st.closingPaisa.toString()} paisa`);
    return 0;
  } finally {
    await db.end();
  }
}

async function registerAccount(args: string[]): Promise<number> {
  const [account, ledgerAccount, operator, ...rest] = args;
  if (!account || !ledgerAccount || !operator || rest.length) throw new UsageError("usage: register-account <BANK-ACCOUNT> <ledger account code> <operator>");
  const db = pool(true);
  try {
    const created = await registerBankAccount(db, account, ledgerAccount, operator);
    out(created ? `registered ${account} -> ${ledgerAccount}` : `${account} was already registered for ${ledgerAccount}`);
    return 0;
  } finally {
    await db.end();
  }
}

async function status(args: string[]): Promise<number> {
  if (args.length) throw new UsageError(`unexpected arguments: ${args.join(" ")}`);
  const db = pool();
  try {
    const g = await payoutGate(db);
    out(`payouts: ${g.allowed ? "ALLOWED" : "DENIED"}${g.frozen ? " (FROZEN)" : ""} · ${g.reason}`);
    const runs = await db.query<{ id: string; status: string; started_at: Date; pinned_block: string | null; blocking: number | null; warnings: number | null; error: string | null }>(
      "SELECT id, status, started_at, pinned_block, blocking, warnings, error FROM recon.runs ORDER BY id DESC LIMIT 5");
    for (const r of runs.rows) {
      out(`  run ${r.id} ${r.status} · ${r.started_at.toISOString()} · block ${r.pinned_block ?? "-"} · ${String(r.blocking ?? "-")} blocking, ${String(r.warnings ?? "-")} warnings${r.error ? ` · ${r.error}` : ""}`);
    }
    const reqs = await db.query<{ id: string; requested_by: string; reason: string; expires_at: Date }>(
      "SELECT id, requested_by, reason, expires_at FROM recon.unfreeze_requests WHERE status = 'open' AND expires_at > now() ORDER BY id");
    for (const q of reqs.rows) out(`  unfreeze request ${q.id} by ${q.requested_by} (expires ${q.expires_at.toISOString()}): ${q.reason}`);
    const audit = await db.query<{ n: string }>("SELECT count(*) AS n FROM recon.verify_audit()");
    out(`  audit chain: ${audit.rows[0]?.n === "0" ? "intact" : `${audit.rows[0]?.n ?? "?"} problem(s)`}`);
    return g.allowed ? 0 : 1;
  } finally {
    await db.end();
  }
}

async function unfreeze(args: string[]): Promise<number> {
  const [mode, ...rest] = args;
  const db = pool(true);
  try {
    if (mode === "--request") {
      const [operator, reason, ...extra] = rest;
      if (!operator || !reason || extra.length) throw new UsageError('usage: unfreeze --request <operator> "<reason>"');
      out(`unfreeze request ${(await requestUnfreeze(db, operator, reason)).toString()} created; a different operator must approve it`);
      return 0;
    }
    if (mode === "--approve" || mode === "--reject") {
      const [id, operator, reason, ...extra] = rest;
      if (!id || !/^[1-9][0-9]{0,17}$/.test(id) || !operator || !reason || extra.length) throw new UsageError(`usage: unfreeze ${mode} <requestId> <operator> "<reason>"`);
      const result = await decideUnfreeze(db, BigInt(id), operator, mode === "--approve" ? "approve" : "reject", reason);
      out(`unfreeze request ${id}: ${result}`);
      return result === "approved" || result === "rejected" ? 0 : 1;
    }
    throw new UsageError('usage: unfreeze --request <operator> "<reason>" | --approve|--reject <requestId> <operator> "<reason>"');
  } finally {
    await db.end();
  }
}

// A Map, so a name like "constructor" can never resolve to an inherited property.
const commands = new Map<string, (args: string[]) => Promise<number>>([
  ["run", run],
  ["import-bank", importBank],
  ["register-account", registerAccount],
  ["status", status],
  ["unfreeze", unfreeze],
]);
const [cmd, ...rest] = process.argv.slice(2);
const command = commands.get(cmd ?? "");
if (!command) {
  out("commands: run | import-bank <file> | register-account <account> <ledger> <operator> | status | unfreeze --request|--approve|--reject");
  process.exitCode = 2;
} else {
  command(rest).then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = 2;
    },
  );
}

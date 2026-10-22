import { fileURLToPath } from "node:url";
import { readEnvFile } from "@pt/config";
import pg from "pg";
import { tick, verifyAudit } from "./service.ts";

/**
 * Recovery command line (spec S-06 section 14):
 *   npm run recovery:tick            one pass of recovery.tick (chain read model -> cases -> outbox)
 *   npm run recovery:tick -- --loop  every RECOVERY_TICK_SECONDS (default 60) until stopped (service)
 *   npm run recovery:audit           verify the recovery audit hash chain (exit 3 on a problem)
 * Settings: PG_* (PG_DATABASE, default property_token); in production a login role in pt_recovery_worker.
 */
const BACKEND = fileURLToPath(new URL("../../../", import.meta.url));

function env(): Record<string, string> {
  return { ...readEnvFile(`${BACKEND}.env.local`), ...(process.env as Record<string, string>) };
}

function pool(): pg.Pool {
  const e = env();
  return new pg.Pool({
    host: e.PG_HOST ?? "127.0.0.1",
    port: Number(e.PG_PORT ?? 5433),
    user: e.RECOVERY_PG_USER ?? e.PG_ADMIN_USER ?? "pt_admin",
    password: e.RECOVERY_PG_PASSWORD ?? e.PG_ADMIN_PASSWORD,
    database: e.PG_DATABASE ?? "property_token",
    application_name: "recovery",
    max: 2,
    statement_timeout: 30_000,
  });
}

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function runTick(loop: boolean): Promise<void> {
  const db = pool();
  const seconds = Math.max(5, Number(env().RECOVERY_TICK_SECONDS ?? 60));
  const state = { stop: !loop };
  process.once("SIGINT", () => (state.stop = true));
  process.once("SIGTERM", () => (state.stop = true));
  try {
    for (;;) {
      const n = await tick(db, "recovery-worker");
      out(`${new Date().toISOString()} recovery tick: ${String(n)} change(s)`);
      for (let i = 0; i < seconds && !state.stop; i++) await new Promise((r) => setTimeout(r, 1_000));
      if (state.stop) break;
    }
  } finally {
    await db.end();
  }
}

async function audit(): Promise<void> {
  const db = pool();
  try {
    const problems = await verifyAudit(db);
    const n = await db.query<{ n: string }>("SELECT count(*) AS n FROM recovery.audit");
    if (problems.length === 0) out(`recovery audit chain intact (${n.rows[0]?.n ?? "0"} entries)`);
    else {
      out(`PROBLEMS:\n${problems.map((p) => `#${p.auditId ?? "-"}: ${p.problem}`).join("\n")}`);
      process.exitCode = 3;
    }
  } finally {
    await db.end();
  }
}

const [cmd, ...rest] = process.argv.slice(2);
const run = cmd === "tick" ? () => runTick(rest.includes("--loop")) : cmd === "audit" ? audit : null;
if (!run) {
  out("commands: tick [--loop] | audit");
  process.exitCode = 2;
} else {
  run().catch((e: unknown) => {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  });
}

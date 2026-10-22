import { fileURLToPath } from "node:url";
import { readEnvFile } from "@pt/config";
import pg from "pg";
import { ExitService } from "./service.ts";

/**
 * Exit command line (spec S-05 sections 14-16, migration 0027). Operators use it for the steps that
 * need keccak (statement hashes, refIds); everything else is in PT Control. Every step names its
 * actor (EXIT_ACTOR, never an officer's handle: the database refuses one outside the portal).
 *   npm run exit:tick                         one pass of exit.tick (read model, bank, outbox -> cases)
 *   npm run exit:tick -- --loop               every EXIT_TICK_SECONDS (default 60) until stopped (service)
 *   npm run exit:run -- calculate <case> <recordBlock>   the final distribution at the record block
 *   npm run exit:run -- attach <final>        build and attach the statement and the tax schedule
 *   npm run exit:run -- verify <final>        independent recomputation of the stored documents (exit 3 on a problem)
 *   npm run exit:run -- redeem <case> [after_payment|after_finalization]   the redemption batch (refIds)
 *   npm run exit:audit                        verify the exit audit hash chain (exit 3 on a problem)
 * Settings: PG_* (PG_DATABASE, default property_token); in production a login role in pt_exit_operator.
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
    user: e.EXIT_PG_USER ?? e.PG_ADMIN_USER ?? "pt_admin",
    password: e.EXIT_PG_PASSWORD ?? e.PG_ADMIN_PASSWORD,
    database: e.PG_DATABASE ?? "property_token",
    application_name: "exit",
    max: 2,
    statement_timeout: 60_000,
  });
}

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

function actor(): string {
  const a = env().EXIT_ACTOR ?? "exit-operator";
  if (!/^[A-Za-z0-9][A-Za-z0-9@._:+-]{1,99}$/.test(a)) throw new Error("EXIT_ACTOR must be 2-100 characters (letters, digits, @._:+-)");
  return a;
}

function id(v: string | undefined, what: string): string {
  if (!v || !/^[1-9][0-9]{0,17}$/.test(v)) throw new Error(`${what} (a positive number) is required`);
  return v;
}

async function tick(loop: boolean): Promise<void> {
  const db = pool();
  const seconds = Math.max(5, Number(env().EXIT_TICK_SECONDS ?? 60));
  const state = { stop: !loop };
  process.once("SIGINT", () => (state.stop = true));
  process.once("SIGTERM", () => (state.stop = true));
  try {
    const svc = new ExitService(db);
    for (;;) {
      const n = await svc.tick("exit-worker");
      out(`${new Date().toISOString()} exit tick: ${String(n)} change(s)`);
      for (let i = 0; i < seconds && !state.stop; i++) await new Promise((r) => setTimeout(r, 1_000));
      if (state.stop) break;
    }
  } finally {
    await db.end();
  }
}

async function run(args: string[]): Promise<number> {
  const [cmd, a, b] = args;
  const db = pool();
  const svc = new ExitService(db);
  try {
    switch (cmd) {
      case "calculate":
        out(`final distribution ${await svc.calculate(id(a, "case"), BigInt(id(b, "record block")), actor())} calculated`);
        return 0;
      case "attach": {
        const docs = await svc.attach(id(a, "final"), actor());
        out(`statement attached: root ${docs.root}, statement ${docs.statementHash}, ${String(docs.entitlements.length)} entitlement(s)`);
        return 0;
      }
      case "verify": {
        const problems = await svc.verify(id(a, "final"));
        for (const p of problems) out(`PROBLEM ${p}`);
        out(problems.length ? `${String(problems.length)} problem(s)` : "documents consistent");
        return problems.length ? 3 : 0;
      }
      case "redeem": {
        const rule = b === undefined ? null : b === "after_payment" || b === "after_finalization" ? b : null;
        if (b !== undefined && rule === null) throw new Error("burn rule must be after_payment or after_finalization");
        out(`redemption batch ${await svc.createRedemption(id(a, "case"), actor(), rule)} created (an operations checker, then a trustee officer, approve it in PT Control)`);
        return 0;
      }
      default:
        out("usage: exit:run -- calculate <case> <block> | attach <final> | verify <final> | redeem <case> [after_payment|after_finalization]");
        return 2;
    }
  } finally {
    await db.end();
  }
}

async function audit(): Promise<number> {
  const db = pool();
  try {
    const problems = await new ExitService(db).verifyAudit();
    for (const p of problems) out(`PROBLEM ${p.auditId ?? "-"}: ${p.problem}`);
    out(problems.length ? `${String(problems.length)} problem(s) in the exit audit` : "exit audit chain intact");
    return problems.length ? 3 : 0;
  } finally {
    await db.end();
  }
}

const [mode, ...rest] = process.argv.slice(2);
try {
  if (mode === "tick") await tick(rest.includes("--loop"));
  else if (mode === "run") process.exitCode = await run(rest);
  else if (mode === "audit") process.exitCode = await audit();
  else {
    out("usage: cli.ts tick [--loop] | run <command> ... | audit");
    process.exitCode = 2;
  }
} catch (e) {
  process.stderr.write(`exit: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
}

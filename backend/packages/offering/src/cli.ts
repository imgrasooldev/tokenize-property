import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readEnvFile } from "@pt/config";
import pg from "pg";
import {
  ACTIONS,
  activeOfferings,
  dryRun,
  isAction,
  OfferingError,
  offeringOverview,
  runAction,
  subscriptionsOf,
  verifyAudit,
  workQueue,
  type ActionInput,
  type ActionName,
} from "./service.ts";

/**
 * Offering command line (spec S-02), for operators until the portal screens exist.
 *   npm run offering:run -- <action> '<json>'   one workflow operation (list: offering:run -- actions);
 *                                               '@file.json' reads the input from a file
 *   npm run offering:show -- <offeringId>       state, units, subscriptions and the issuance dry run
 *   npm run offering:queue                      open maker-checker requests
 *   npm run offering:tick [-- <offeringId>]     the offering clock (open, expiries, waitlist, close,
 *                                               outcome proposals, refund completion, settlement);
 *                                               without an id: every active offering (scheduled)
 *   npm run offering:audit                      verify the offering audit hash chain (exit 3 on a problem)
 * Refunds are sent by the bank service (executeApprovedRefunds), which instructs the bank after the
 * refund is recorded; this CLI has no bank connection.
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
    user: e.PG_ADMIN_USER ?? "pt_admin",
    password: e.PG_ADMIN_PASSWORD,
    database: e.PG_DATABASE ?? "property_token",
    application_name: "offering",
    max: 2,
  });
}

function readInput(arg: string | undefined): unknown {
  if (!arg) return {};
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- an operator-chosen input file
  const raw = arg.startsWith("@") ? readFileSync(arg.slice(1), "utf8") : arg;
  return JSON.parse(raw) as unknown;
}

const replacer = (_k: string, v: unknown): unknown => (typeof v === "bigint" ? v.toString() : v);

async function main(): Promise<void> {
  const [cmd, a1, a2] = process.argv.slice(2);
  if (cmd === "run" && a1 === "actions") {
    console.log(Object.keys(ACTIONS).join("\n"));
    return;
  }
  const db = pool();
  try {
    if (cmd === "run" && a1) {
      if (!isAction(a1)) throw new OfferingError("INVALID_INPUT", `unknown action ${a1} (see: offering:run -- actions)`);
      const result = await runAction(db, a1, readInput(a2) as ActionInput<ActionName>);
      console.log(JSON.stringify({ ok: true, result }, replacer));
    } else if (cmd === "show" && a1) {
      const overview = await offeringOverview(db, a1);
      if (!overview) console.log("unknown offering");
      else console.log(JSON.stringify({ ...overview, subscriptions: await subscriptionsOf(db, a1), dryRun: await dryRun(db, a1) }, replacer, 2));
    } else if (cmd === "queue") {
      const q = await workQueue(db);
      for (const x of q) console.log(`${x.since.toISOString()}  #${x.requestId}  ${x.code.padEnd(4)} ${x.offeringId}  ${x.subscriptionId ?? ""}  by ${x.requestedBy}`);
      console.log(`${String(q.length)} item(s)`);
    } else if (cmd === "tick") {
      const actor = "system:offering-clock";
      for (const id of a1 ? [a1] : await activeOfferings(db)) {
        const tick = await runAction(db, "tick", { offeringId: id, actor });
        const settled = await runAction(db, "settle", { offeringId: id, actor });
        console.log(JSON.stringify({ offeringId: id, tick, settled }, replacer));
      }
    } else if (cmd === "audit") {
      const problems = await verifyAudit(db);
      for (const p of problems) console.log(`audit ${p.auditId ?? "-"}: ${p.problem}`);
      console.log(problems.length === 0 ? "offering audit chain intact" : `${String(problems.length)} problem(s)`);
      if (problems.length) process.exitCode = 3;
    } else {
      console.log("usage: offering run <action> '<json>' | run actions | show <offeringId> | queue | tick [offeringId] | audit");
      process.exitCode = 2;
    }
  } finally {
    await db.end();
  }
}

main().catch((e: unknown) => {
  if (e instanceof OfferingError) {
    console.error(JSON.stringify({ ok: false, code: e.code, error: e.message }));
    process.exitCode = 4;
    return;
  }
  console.error((e as Error).message);
  process.exitCode = 1;
});

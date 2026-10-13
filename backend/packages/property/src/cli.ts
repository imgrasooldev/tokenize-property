import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { readEnvFile } from "@pt/config";
import pg from "pg";
import { SponsorSecrets } from "./crypto.ts";
import {
  ACTIONS,
  findDuplicates,
  isAction,
  PropertyError,
  propertyOverview,
  PropertyService,
  reviewStatus,
  runAction,
  sponsorOverview,
  valuationStatus,
  verifyAudit,
  workQueue,
  type ActionInput,
  type ActionName,
} from "./service.ts";

/**
 * Property onboarding command line (spec S-01), for operators until the Step 6 portal screens exist.
 *   npm run property:setup                       LOCAL DEV ONLY: pepper and sealing key in backend/.env.local
 *   npm run property:run -- <action> '<json>'    one workflow operation (list: property:run -- actions);
 *                                                '@file.json' reads the input from a file
 *   npm run property:show -- sponsor|property <id>   state and review status (no personal data)
 *   npm run property:queue                       open requests, possible duplicates, blocked submissions
 *   npm run property:audit                       verify the property audit hash chain (exit 3 on a problem)
 *   npm run property:expire                      record K7 for every lapsed KYB (scheduled)
 * Every operation names the acting officer in its input; the database checks their duty.
 */
const BACKEND = fileURLToPath(new URL("../../../", import.meta.url));
const ENV_FILE = `${BACKEND}.env.local`;

function env(): Record<string, string> {
  return { ...readEnvFile(ENV_FILE), ...(process.env as Record<string, string>) };
}

function pool(): pg.Pool {
  const e = env();
  return new pg.Pool({
    host: e.PG_HOST ?? "127.0.0.1",
    port: Number(e.PG_PORT ?? 5433),
    user: e.PG_ADMIN_USER ?? "pt_admin",
    password: e.PG_ADMIN_PASSWORD,
    database: e.PG_DATABASE ?? "property_token",
    application_name: "property",
    max: 2,
  });
}

async function setup(): Promise<void> {
  if (process.env.NODE_ENV === "production") throw new Error("property:setup is for local development only; production keys live in the KMS");
  const e = env();
  const add: string[] = [];
  if (!e.PROPERTY_PEPPER_V1) add.push(`PROPERTY_PEPPER_V1=${randomBytes(32).toString("hex")}`, "PROPERTY_PEPPER_CURRENT=1");
  if (!e.PROPERTY_DATA_KEY) add.push(`PROPERTY_DATA_KEY=${randomBytes(32).toString("hex")}`);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed path inside backend/
  if (add.length) await appendFile(ENV_FILE, `\n# Property onboarding (local dev, generated)\n${add.join("\n")}\n`, { mode: 0o600 });
  console.log(add.length ? `added ${String(add.length)} property secret(s) to backend/.env.local` : "property secrets already present");
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
  if (cmd === "setup") return setup();
  if (cmd === "run" && a1 === "actions") {
    console.log(["createSponsor", ...Object.keys(ACTIONS)].join("\n"));
    return;
  }
  const db = pool();
  try {
    if (cmd === "run" && a1) {
      const input = readInput(a2);
      let result: unknown;
      if (a1 === "createSponsor") {
        const service = new PropertyService(db, SponsorSecrets.fromEnv(env()));
        result = await service.createSponsor(input as Parameters<PropertyService["createSponsor"]>[0]);
      } else if (isAction(a1)) {
        result = await runAction(db, a1, input as ActionInput<ActionName>);
      } else {
        throw new PropertyError("INVALID_INPUT", `unknown action ${a1} (see: property:run -- actions)`);
      }
      console.log(JSON.stringify({ ok: true, result }, replacer));
    } else if (cmd === "show" && a1 === "sponsor" && a2) {
      console.log(JSON.stringify(await sponsorOverview(db, a2), replacer, 2));
    } else if (cmd === "show" && a1 === "property" && a2) {
      const overview = await propertyOverview(db, a2);
      if (!overview) {
        console.log("unknown property");
      } else {
        const out = { ...overview, reviews: await reviewStatus(db, a2), valuation: await valuationStatus(db, a2), duplicates: await findDuplicates(db, a2) };
        console.log(JSON.stringify(out, replacer, 2));
      }
    } else if (cmd === "queue") {
      const q = await workQueue(db);
      for (const x of q) console.log(`${x.since.toISOString()}  ${x.kind.padEnd(19)} #${x.id}  ${x.entityId}  ${x.what}`);
      console.log(`${String(q.length)} item(s)`);
    } else if (cmd === "audit") {
      const problems = await verifyAudit(db);
      for (const p of problems) console.log(`audit ${p.auditId ?? "-"}: ${p.problem}`);
      console.log(problems.length === 0 ? "property audit chain intact" : `${String(problems.length)} problem(s)`);
      if (problems.length) process.exitCode = 3;
    } else if (cmd === "expire") {
      const n = await runAction(db, "expireSponsors", { actor: a1 ?? "system:kyb-expiry" });
      console.log(`${String(n)} KYB file(s) expired`);
    } else {
      console.log("usage: property setup | run <action> '<json>' | run actions | show sponsor|property <id> | queue | audit | expire [actor]");
      process.exitCode = 2;
    }
  } finally {
    await db.end();
  }
}

main().catch((e: unknown) => {
  if (e instanceof PropertyError) {
    console.error(JSON.stringify({ ok: false, code: e.code, error: e.message }));
    process.exitCode = 4;
    return;
  }
  console.error((e as Error).message);
  process.exitCode = 1;
});

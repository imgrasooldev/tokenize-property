import { randomBytes } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { readEnvFile } from "@pt/config";
import pg from "pg";
import { statusOf, verifyAudit } from "./service.ts";

/**
 * KYC command line (ADR 0009).
 *   npm run kyc:setup                LOCAL DEV ONLY: generates the pepper and the data key in backend/.env.local
 *   npm run kyc:status -- <subject>  status of one subject (no personal data)
 *   npm run kyc:audit                verify the KYC audit hash chain
 * Sanctions reviews (maker-checker) are decided in the compliance portal (Step 6) through
 * requestClearance / decideClearance.
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
    application_name: "kyc",
    max: 2,
  });
}

async function setup(): Promise<void> {
  if (process.env.NODE_ENV === "production") throw new Error("kyc:setup is for local development only; production keys live in the KMS");
  const e = env();
  const add: string[] = [];
  if (!e.KYC_PEPPER_V1) add.push(`KYC_PEPPER_V1=${randomBytes(32).toString("hex")}`, "KYC_PEPPER_CURRENT=1");
  if (!e.KYC_DATA_KEY) add.push(`KYC_DATA_KEY=${randomBytes(32).toString("hex")}`);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed path inside backend/
  if (add.length) await appendFile(ENV_FILE, `\n# KYC service (local dev, generated)\n${add.join("\n")}\n`, { mode: 0o600 });
  console.log(add.length ? `added ${String(add.length)} KYC secret(s) to backend/.env.local` : "KYC secrets already present");
}

async function main(): Promise<void> {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === "setup") return setup();
  const db = pool();
  try {
    if (cmd === "status" && arg) {
      const v = await statusOf(db, arg);
      console.log(v ? JSON.stringify(v, null, 2) : "unknown subject");
    } else if (cmd === "audit") {
      const problems = await verifyAudit(db);
      for (const p of problems) console.log(`audit ${p.auditId ?? "-"}: ${p.problem}`);
      console.log(problems.length === 0 ? "KYC audit chain intact" : `${String(problems.length)} problem(s)`);
      if (problems.length) process.exitCode = 3;
    } else {
      console.log("usage: kyc setup | status <subjectId> | audit");
      process.exitCode = 2;
    }
  } finally {
    await db.end();
  }
}

main().catch((e: unknown) => {
  console.error((e as Error).message);
  process.exitCode = 1;
});

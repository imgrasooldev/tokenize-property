import { randomBytes } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { readEnvFile } from "@pt/config";
import { keyFromEnv, Peppers } from "@pt/kyc";
import pg from "pg";
import { BankService, verifyAudit, type TitleFetch } from "./service.ts";
import { createWebhookServer, type WebhookKey } from "./webhook.ts";

/**
 * Bank service command line (ADR 0009).
 *   npm run bank:setup     LOCAL DEV ONLY: generates the data key and a webhook secret in backend/.env.local
 *   npm run bank           serve the webhook endpoint on 127.0.0.1:4910 (POST /v1/bank/events)
 *   npm run bank:audit     verify the bank audit hash chain
 * Webhook keys: BANK_WEBHOOK_SECRET_<KID>=<64 hex> (two may be active during a rotation).
 */
const BACKEND = fileURLToPath(new URL("../../../", import.meta.url));
const ENV_FILE = `${BACKEND}.env.local`;
const PORT = Number(process.env.BANK_PORT ?? 4910);

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
    application_name: "bank",
    max: 8,
    statement_timeout: 15_000,
  });
}

function webhookKeys(e: Record<string, string>): WebhookKey[] {
  const keys: WebhookKey[] = [];
  for (const [k, v] of Object.entries(e)) {
    const m = /^BANK_WEBHOOK_SECRET_([A-Z0-9]{1,16})$/.exec(k);
    if (!m?.[1]) continue;
    if (!/^[0-9a-f]{64}$/.test(v)) throw new Error(`${k} must be 64 lower-case hex characters`);
    keys.push({ id: m[1].toLowerCase(), secret: Buffer.from(v, "hex") });
  }
  if (keys.length === 0) throw new Error("no BANK_WEBHOOK_SECRET_<KID> configured (run npm run bank:setup)");
  return keys;
}

async function setup(): Promise<void> {
  if (process.env.NODE_ENV === "production") throw new Error("bank:setup is for local development only; production keys live in the KMS");
  const e = env();
  const add: string[] = [];
  if (!e.BANK_DATA_KEY) add.push(`BANK_DATA_KEY=${randomBytes(32).toString("hex")}`);
  if (!Object.keys(e).some((k) => k.startsWith("BANK_WEBHOOK_SECRET_"))) add.push(`BANK_WEBHOOK_SECRET_K1=${randomBytes(32).toString("hex")}`);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed path inside backend/
  if (add.length) await appendFile(ENV_FILE, `\n# bank service (local dev, generated)\n${add.join("\n")}\n`, { mode: 0o600 });
  console.log(add.length ? `added ${String(add.length)} bank secret(s) to backend/.env.local` : "bank secrets already present");
}

/** Without a bank connection there is no title inquiry: payout accounts cannot be registered. */
const noTitles: TitleFetch = { accountTitle: () => Promise.resolve(null) };

async function serve(): Promise<void> {
  const e = env();
  const db = pool();
  // Fail fast when the database is unreachable or not migrated to 0009.
  await db.query("SELECT 1 FROM bank.events LIMIT 0");
  const service = new BankService(db, Peppers.fromEnv(e), keyFromEnv(e, "BANK_DATA_KEY"), noTitles, { escrowAccount: e.BANK_ESCROW_ACCOUNT ?? "TRUSTEE-ESCROW-01" });
  const server = createWebhookServer(service, webhookKeys(e), { onError: (err) => { console.error(`webhook error: ${(err as Error).name}`); } });
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`bank webhook endpoint on http://127.0.0.1:${String(PORT)}/v1/bank/events`);
  });
  const stop = (): void => {
    server.close(() => void db.end());
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

async function main(): Promise<void> {
  const [cmd] = process.argv.slice(2);
  if (cmd === "setup") return setup();
  if (cmd === "serve") return serve();
  if (cmd === "audit") {
    const db = pool();
    try {
      const problems = await verifyAudit(db);
      for (const p of problems) console.log(`audit ${p.auditId ?? "-"}: ${p.problem}`);
      console.log(problems.length === 0 ? "bank audit chain intact" : `${String(problems.length)} problem(s)`);
      if (problems.length) process.exitCode = 3;
    } finally {
      await db.end();
    }
    return;
  }
  console.log("usage: bank setup | serve | audit");
  process.exitCode = 2;
}

main().catch((e: unknown) => {
  console.error((e as Error).message);
  process.exitCode = 1;
});

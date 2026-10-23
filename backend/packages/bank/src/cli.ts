import { randomBytes } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { readEnvFile, servicePgAuth, type ServiceName } from "@pt/config";
import { secretFromEnv } from "@pt/http-auth";
import { keyFromEnv, Peppers } from "@pt/kyc";
import pg from "pg";
import { DemoTitleFetch } from "./demo-titles.ts";
import { createPayeeServer, WEB_BANK_SCOPE } from "./http.ts";
import { BankService, verifyAudit, type TitleFetch } from "./service.ts";
import { createWebhookServer, type WebhookKey } from "./webhook.ts";

/**
 * Bank service command line (ADR 0009).
 *   npm run bank:setup     LOCAL DEV ONLY: generates the data key, a webhook secret and the website's
 *                          payee API secret (BANK_CLIENT_SECRET_WEB) in backend/.env.local
 *   npm run bank           serve the webhook endpoint on 127.0.0.1:4910 (POST /v1/bank/events)
 *   npm run bank:payees    DEMO / LOCAL ONLY: the website's payout-account API on 127.0.0.1:4920
 *                          (POST /v1/payees, HMAC client "web"; demo title fetch, refused in production)
 *   npm run bank:audit     verify the bank audit hash chain
 * Webhook keys: BANK_WEBHOOK_SECRET_<KID>=<64 hex> (two may be active during a rotation).
 */
const BACKEND = fileURLToPath(new URL("../../../", import.meta.url));
const ENV_FILE = `${BACKEND}.env.local`;
const PORT = Number(process.env.BANK_PORT ?? 4910);

function env(): Record<string, string> {
  return { ...readEnvFile(ENV_FILE), ...(process.env as Record<string, string>) };
}

/** Fail closed: the bank service's own login (BANK_PG_USER) or, for audit, the audit login (migration 0029). */
function pool(service: ServiceName = "bank", applicationName = "bank"): pg.Pool {
  const e = env();
  return new pg.Pool({
    host: e.PG_HOST ?? "127.0.0.1",
    port: Number(e.PG_PORT ?? 5433),
    ...servicePgAuth(e, service),
    database: e.PG_DATABASE ?? "property_token",
    application_name: applicationName,
    max: 8,
    statement_timeout: 15_000,
    connectionTimeoutMillis: 5_000,
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
  if (!e.BANK_CLIENT_SECRET_WEB) add.push(`BANK_CLIENT_SECRET_WEB=${randomBytes(32).toString("base64url")}`);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed path inside backend/
  if (add.length) await appendFile(ENV_FILE, `\n# bank service (local dev, generated)\n${add.join("\n")}\n`, { mode: 0o600 });
  console.log(add.length ? `added ${String(add.length)} bank secret(s) to backend/.env.local` : "bank secrets already present");
}

/** Without a bank connection there is no title inquiry: payout accounts cannot be registered. */
const noTitles: TitleFetch = { accountTitle: () => Promise.resolve(null) };

async function serve(): Promise<void> {
  const e = env();
  const db = pool();
  // Fail fast when the database is unreachable, not migrated to 0009 or the login lacks the bank grants
  // (bank.payee_status is the one bank relation the service role may read).
  await db.query("SELECT 1 FROM bank.payee_status LIMIT 0");
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

/**
 * The website's payout-account API (task T-045) on 127.0.0.1:BANK_PAYEES_PORT (4920). There is no
 * bank connection yet, so the title inquiry is the demo fetch (it answers the title the investor
 * typed; the database still compares it with the KYC-verified name). Refuses to start in production.
 */
async function servePayees(): Promise<void> {
  if (process.env.NODE_ENV === "production") throw new Error("bank:payees uses the demo title fetch and does not run in production");
  const e = env();
  const titles = new DemoTitleFetch();
  const db = pool("bank", "bank-payees");
  // Fail fast when the database is unreachable, not migrated to 0009 or the login lacks the bank grants.
  await db.query("SELECT 1 FROM bank.payee_status LIMIT 0");
  const service = new BankService(db, Peppers.fromEnv(e), keyFromEnv(e, "BANK_DATA_KEY"), titles, {
    escrowAccount: e.BANK_ESCROW_ACCOUNT ?? "TRUSTEE-ESCROW-01",
    actor: "bank-payees",
  });
  const port = Number(e.BANK_PAYEES_PORT ?? 4920);
  const server = createPayeeServer(service, [{ id: "web", secret: secretFromEnv(e, "BANK_CLIENT_SECRET_WEB"), scope: WEB_BANK_SCOPE }]);
  server.listen(port, "127.0.0.1", () => {
    console.log(`bank payee API listening on 127.0.0.1:${String(port)} (demo title fetch)`);
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
  if (cmd === "serve-payees") return servePayees();
  if (cmd === "audit") {
    const db = pool("audit", "bank-audit");
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
  console.log("usage: bank setup | serve | serve-payees | audit");
  process.exitCode = 2;
}

main().catch((e: unknown) => {
  console.error((e as Error).message);
  process.exitCode = 1;
});

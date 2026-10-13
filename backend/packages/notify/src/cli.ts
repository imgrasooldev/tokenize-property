import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { appendFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { readEnvFile } from "@pt/config";
import pg from "pg";
import { ContactSecrets } from "./crypto.ts";
import { MockProvider, type MockRecord } from "./providers.ts";
import { deadLetters, stats, undeliverable, verifyAudit } from "./service.ts";
import { NotifyWorker, redact } from "./worker.ts";

/**
 * Notifications command line (ADR 0013).
 *   npm run notify:setup            LOCAL DEV ONLY: creates NOTIFY_DATA_KEY and NOTIFY_LOOKUP_KEY in
 *                                   backend/.env.local once (never printed; production keys live in the KMS)
 *   npm run notify:run [-- --once]  the delivery worker with MOCK providers (records what would be
 *                                   sent; real SMS/e-mail providers are task T-031)
 *   npm run notify:status           queue health, dead letters, undeliverable security notices, audit check
 * Exit codes: 0 fine, 1 error, 2 usage, 3 status found dead letters, undeliverable notices or an audit problem.
 */
const BACKEND = fileURLToPath(new URL("../../../", import.meta.url));

function envFile(): string {
  // Tests point setup at a temporary file; never in production.
  const override = process.env.NOTIFY_ENV_FILE;
  if (override && process.env.NODE_ENV !== "production") return override;
  return `${BACKEND}.env.local`;
}

function env(): Record<string, string> {
  return { ...readEnvFile(envFile()), ...(process.env as Record<string, string>) };
}

function pool(max: number, user?: string, password?: string): pg.Pool {
  const e = env();
  return new pg.Pool({
    host: e.PG_HOST ?? "127.0.0.1",
    port: Number(e.PG_PORT ?? 5433),
    user: user ?? e.PG_ADMIN_USER ?? "pt_admin",
    password: password ?? e.PG_ADMIN_PASSWORD,
    database: e.PG_DATABASE ?? "property_token",
    application_name: "notify",
    max,
    statement_timeout: 15_000,
    connectionTimeoutMillis: 5_000,
  });
}

async function setup(): Promise<void> {
  if (process.env.NODE_ENV === "production") throw new Error("notify:setup is for local development only; production keys live in the KMS");
  const e = env();
  const add: string[] = [];
  // Created once: an existing key is never replaced (sealed contacts would no longer open).
  if (!e.NOTIFY_DATA_KEY) add.push(`NOTIFY_DATA_KEY=${randomBytes(32).toString("hex")}`);
  if (!e.NOTIFY_LOOKUP_KEY) add.push(`NOTIFY_LOOKUP_KEY=${randomBytes(32).toString("hex")}`);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- backend/.env.local (or a test file)
  if (add.length) await appendFile(envFile(), `\n# Notifications (local dev, generated)\n${add.join("\n")}\n`, { mode: 0o600 });
  console.log(add.length ? `added ${String(add.length)} notify key(s) to ${envFile() === `${BACKEND}.env.local` ? "backend/.env.local" : "the env file"}` : "notify keys already present");
}

function printAccepted(r: MockRecord): void {
  // Never the contact or the text: the delivery's key, the message id and the size only.
  console.log(`[mock] accepted ${r.idempotencyKey} -> ${r.messageId} (${String(r.text.length)} chars${r.subject === undefined ? "" : ", e-mail"})`);
}

async function run(once: boolean): Promise<void> {
  if (process.env.NODE_ENV === "production") throw new Error("notify:run uses mock providers and does not run in production (real providers: task T-031)");
  const e = env();
  const secrets = ContactSecrets.fromEnv(e);
  const db = pool(4, e.NOTIFY_PG_USER, e.NOTIFY_PG_PASSWORD);
  const worker = new NotifyWorker(db, {
    workerId: `notify-${String(process.pid)}@${hostname().replace(/[^\w.-]/g, "").slice(0, 60) || "host"}`,
    providers: { sms: new MockProvider("sms", { onAccept: printAccepted }), email: new MockProvider("email", { onAccept: printAccepted }) },
    secrets,
    onError: (context, err) => {
      console.error(`${context}: ${redact((err as Error).message)}`);
    },
  });
  if (once) {
    try {
      const n = await worker.runOnce();
      console.log(`handled ${String(n)} deliver${n === 1 ? "y" : "ies"}`);
    } finally {
      await db.end();
    }
    return;
  }
  await worker.start();
  console.log("notify worker running (mock SMS and e-mail providers; LISTEN notify + polling)");
  const stop = (): void => {
    void worker.stop().then(() => db.end());
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

async function status(): Promise<void> {
  const db = pool(2);
  try {
    const s = await stats(db);
    for (const x of s) console.log(`${x.status.padEnd(28)} ${String(x.count).padStart(7)}  oldest ${String(x.oldestSeconds)} s`);
    if (s.length === 0) console.log("no deliveries yet");
    const dead = await deadLetters(db);
    for (const d of dead) console.log(`dead #${d.id.toString()} ${d.kind} ${d.channel} attempts=${String(d.attempts)} ${d.lastError ?? ""}`);
    const lost = await undeliverable(db);
    for (const n of lost) console.log(`undeliverable #${n.id.toString()} ${n.kind} ${n.subjectType}:${n.subjectId} (no contact on file)`);
    const problems = await verifyAudit(db);
    for (const p of problems) console.log(`audit ${p.auditId?.toString() ?? "-"}: ${p.problem}`);
    console.log(problems.length === 0 ? "notify audit chain intact" : `${String(problems.length)} audit problem(s)`);
    console.log(`${String(dead.length)} dead letter(s), ${String(lost.length)} undeliverable security notice(s)`);
    if (dead.length || lost.length || problems.length) process.exitCode = 3;
  } finally {
    await db.end();
  }
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "setup") return setup();
  if (cmd === "run") return run(rest.includes("--once"));
  if (cmd === "status") return status();
  console.log("usage: notify setup | run [--once] | status");
  process.exitCode = 2;
}

main().catch((e: unknown) => {
  console.error(redact((e as Error).message));
  process.exitCode = 1;
});

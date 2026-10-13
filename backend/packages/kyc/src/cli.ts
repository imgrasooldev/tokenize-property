import { randomBytes } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { readEnvFile } from "@pt/config";
import { secretFromEnv } from "@pt/http-auth";
import pg from "pg";
import { keyFromEnv, Peppers } from "./crypto.ts";
import { createKycServer, WEB_KYC_SCOPE } from "./http.ts";
import { OffboardingWorker } from "./offboarding.ts";
import { mockProviders } from "./providers.ts";
import { RescreenWorker } from "./rescreen.ts";
import { KycService, statusOf, verifyAudit } from "./service.ts";

/**
 * KYC command line (ADR 0009).
 *   npm run kyc:setup                LOCAL DEV ONLY: generates the pepper and the data key in backend/.env.local
 *   npm run kyc:status -- <subject>  status of one subject (no personal data)
 *   npm run kyc:audit                verify the KYC audit hash chain
 *   npm run kyc:serve                the KYC API for the website's sign-up (127.0.0.1:4910, mock providers)
 *   npm run kyc:offboard             queue a freeze for every wallet whose owner lost the verification
 *                                    (on kyc_alert and every minute; KYC_FREEZE_GUARD or the local deployment)
 *   npm run kyc:rescreen             execute the re-screenings compliance officers queue in the portal
 *                                    (on compliance_rescreen and every 30 s; mock providers, not in production)
 * Sanctions and PEP reviews (maker-checker) are decided in the compliance portal (Step 6c, migration
 * 0019), which runs requestClearance / decideClearance under the officers' handles.
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
  if (!e.KYC_CLIENT_SECRET_WEB) add.push(`KYC_CLIENT_SECRET_WEB=${randomBytes(32).toString("base64url")}`);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed path inside backend/
  if (add.length) await appendFile(ENV_FILE, `\n# KYC service (local dev, generated)\n${add.join("\n")}\n`, { mode: 0o600 });
  console.log(add.length ? `added ${String(add.length)} KYC secret(s) to backend/.env.local` : "KYC secrets already present");
}

async function offboard(): Promise<void> {
  let freezeGuard = env().KYC_FREEZE_GUARD;
  if (!freezeGuard) {
    const { latestDeployment } = await import("../../demo-console/src/local.ts");
    freezeGuard = latestDeployment()?.freezeGuard;
  }
  if (!freezeGuard) throw new Error("set KYC_FREEZE_GUARD or deploy the local chain first");
  const db = pool();
  const worker = new OffboardingWorker(db, { freezeGuard, onError: (e) => { console.error(`offboarding pass failed: ${(e as Error).message}`); } });
  await worker.start();
  console.log(`offboarding worker running (FreezeGuard ${freezeGuard}); freezes go through the outbox and the signing service`);
  const stop = (): void => {
    void worker.stop().then(() => db.end());
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

/**
 * The KYC API for the website's sign-up (ADR 0010) on 127.0.0.1:KYC_PORT (4910). Mock providers
 * only (there are no real provider contracts yet), so it refuses to start in production.
 */
function serve(): Promise<void> {
  const e = env();
  if (process.env.NODE_ENV === "production") return Promise.reject(new Error("kyc:serve uses mock providers and does not run in production"));
  const peppers = Peppers.fromEnv(e);
  const dataKey = keyFromEnv(e, "KYC_DATA_KEY");
  const db = new pg.Pool({
    host: e.PG_HOST ?? "127.0.0.1",
    port: Number(e.PG_PORT ?? 5433),
    user: e.KYC_PG_USER ?? e.PG_ADMIN_USER ?? "pt_admin",
    password: e.KYC_PG_PASSWORD ?? e.PG_ADMIN_PASSWORD,
    database: e.PG_DATABASE ?? "property_token",
    application_name: "kyc-service",
    max: 6,
    statement_timeout: 15_000,
    connectionTimeoutMillis: 5_000,
  });
  const service = new KycService(db, mockProviders(), peppers, dataKey, "kyc-service");
  const port = Number(e.KYC_PORT ?? 4910);
  const server = createKycServer(service, [{ id: "web", secret: secretFromEnv(e, "KYC_CLIENT_SECRET_WEB"), scope: WEB_KYC_SCOPE }]);
  server.listen(port, "127.0.0.1", () => {
    console.log(`KYC service listening on 127.0.0.1:${String(port)} (mock NADRA, liveness and sanctions providers)`);
  });
  const stop = (): void => {
    server.close();
    void db.end();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  return Promise.resolve();
}

/** Executes queued re-screenings (Step 6c): the KYC service alone can unseal a name. */
async function rescreen(): Promise<void> {
  const e = env();
  if (process.env.NODE_ENV === "production") throw new Error("kyc:rescreen uses mock providers and does not run in production");
  const db = pool();
  const service = new KycService(db, mockProviders(), Peppers.fromEnv(e), keyFromEnv(e, "KYC_DATA_KEY"), "kyc-service");
  const worker = new RescreenWorker(db, service, {
    worker: "kyc-rescreen",
    onError: (err) => {
      console.error(`re-screening failed: ${err instanceof Error ? err.name : "error"}`);
    },
  });
  await worker.start();
  console.log("re-screening worker running (mock sanctions and PEP lists); results appear in the compliance portal");
  const stop = (): void => {
    void worker.stop().then(() => db.end());
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

async function main(): Promise<void> {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === "setup") return setup();
  if (cmd === "offboard") return offboard();
  if (cmd === "serve") return serve();
  if (cmd === "rescreen") return rescreen();
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
      console.log("usage: kyc setup | serve | status <subjectId> | audit | offboard | rescreen");
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

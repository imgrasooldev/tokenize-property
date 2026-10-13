import { hostname } from "node:os";
import { fileURLToPath } from "node:url";
import { readEnvFile } from "@pt/config";
import { secretFromEnv } from "@pt/http-auth";
import { createLogger } from "@pt/logger";
import { OutboxWorker, type Executor } from "@pt/outbox";
import pg from "pg";
import { signerExecutor } from "./executor.ts";
import { SignerClient } from "./http.ts";
import { KINDS } from "./policy.ts";

/**
 * The outbox worker process (Step 5h, ADR 0010): executes every command kind that has a signing
 * policy through the signing service (`signerExecutor`: policy, maker-checker, nonce reservation,
 * audit; record before broadcast). A kind without a policy is failed by the worker, never sent.
 *   npm run outbox
 * Settings: PG_* (PG_DATABASE, default property_token), CHAIN_RPC_URL, SIGNER_URL
 * (http://127.0.0.1:4900), SIGNER_CLIENT_SECRET_OUTBOX, OUTBOX_APPROVAL_POLL_SECONDS (10).
 * Locally this connects as the admin; in production as a login role in pt_outbox_worker.
 */
const BACKEND = fileURLToPath(new URL("../../../", import.meta.url));

function env(): Record<string, string | undefined> {
  return { ...readEnvFile(`${BACKEND}.env.local`), ...process.env };
}

async function main(): Promise<void> {
  const e = env();
  const log = createLogger({ service: "outbox", level: e.LOG_LEVEL ?? "info" });
  const rpcUrl = e.CHAIN_RPC_URL ?? "http://127.0.0.1:8545";
  const signer = new SignerClient(e.SIGNER_URL ?? "http://127.0.0.1:4900", { id: "outbox-worker", secret: secretFromEnv(e, "SIGNER_CLIENT_SECRET_OUTBOX") });
  const executor = signerExecutor(signer, { rpcUrl, approvalPollSeconds: Number(e.OUTBOX_APPROVAL_POLL_SECONDS ?? 10) });
  const executors: Record<string, Executor> = Object.fromEntries(KINDS.map((k) => [k, executor]));
  const pool = new pg.Pool({
    host: e.PG_HOST ?? "127.0.0.1",
    port: Number(e.PG_PORT ?? 5433),
    user: e.OUTBOX_PG_USER ?? e.PG_ADMIN_USER ?? "pt_admin",
    password: e.OUTBOX_PG_PASSWORD ?? e.PG_ADMIN_PASSWORD,
    database: e.PG_DATABASE ?? "property_token",
    application_name: "outbox-worker",
    max: 6,
    statement_timeout: 15_000,
    connectionTimeoutMillis: 5_000,
  });
  const worker = new OutboxWorker(pool, {
    workerId: `outbox@${hostname()}:${String(process.pid)}`.slice(0, 100),
    executors,
    pollMs: Number(e.OUTBOX_POLL_MS ?? 1_000),
    waitMs: 30_000,
    onError: (context, err) => {
      log.warn({ context, err: err instanceof Error ? err.message : String(err) }, "outbox error (decided from the database and the chain)");
    },
  });
  await worker.start();
  log.info({ kinds: KINDS, database: e.PG_DATABASE ?? "property_token" }, "outbox worker running");
  const stop = (): void => {
    log.info("stopping");
    void worker.stop().then(() => pool.end());
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
});

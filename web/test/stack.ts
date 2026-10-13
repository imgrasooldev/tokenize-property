import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

/**
 * The backend services the website needs since Step 5h (ADR 0010), started for tests against the
 * TEST database only (property_token_test): chain indexer, signing service, outbox worker and KYC
 * service, as the separate processes they are in production. Used by the integration tests
 * (vitest globalSetup) and the end-to-end tests (Playwright webServer, test/stack-cli.ts).
 *
 * Preparation is idempotent: migrations on the test database, the website's database role, the
 * KYC and signing-service secrets (backend/.env.local, git-ignored; never printed), and the
 * signing service's keystore for the test database (backend/data/keystore-test, git-ignored).
 * Nothing touches the main database or redeploys contracts.
 */
const WEB = join(import.meta.dirname, "..");
const BACKEND = join(WEB, "..", "backend");
const RPC = process.env.CHAIN_RPC_URL ?? "http://127.0.0.1:8545";

export const STACK = {
  signerUrl: "http://127.0.0.1:4901",
  kycUrl: "http://127.0.0.1:4911",
  database: "property_token_test",
} as const;

const serviceEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  PG_DATABASE: STACK.database,
  SIGNER_KEYSTORE_DIR: join(BACKEND, "data", "keystore-test"),
  SIGNER_PORT: "4901",
  SIGNER_URL: STACK.signerUrl,
  KYC_PORT: "4911",
  OUTBOX_APPROVAL_POLL_SECONDS: "2",
  LOG_LEVEL: "warn",
  NODE_ENV: "development",
});

function tsx(script: string, args: string[] = []): string[] {
  return [join(BACKEND, "node_modules", "tsx", "dist", "cli.mjs"), join(BACKEND, script), ...args];
}

/** Whether the local chain with a deployment is up (otherwise integration tests skip). */
export async function chainUp(): Promise<boolean> {
  if (!existsSync(join(WEB, "..", "contracts", "broadcast", "Deploy.s.sol", "586586", "run-latest.json"))) return false;
  try {
    const res = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: AbortSignal.timeout(3_000),
    });
    return ((await res.json()) as { result?: string }).result === "0x8f35a";
  } catch {
    return false;
  }
}

function runOnce(label: string, args: string[]): void {
  const r = spawnSync(process.execPath, args, { cwd: BACKEND, env: serviceEnv(), encoding: "utf8", windowsHide: true, timeout: 300_000 });
  // Output of the setup commands names files and counts only, never secret values.
  if (r.status !== 0) throw new Error(`${label} failed: ${(r.stderr || r.stdout).slice(-800)}`);
}

/** Idempotent setup of the test database and the services' secrets and keys. */
export function prepare(): void {
  runOnce("migrate (test database)", tsx("packages/db/src/cli.ts", ["--test"]));
  runOnce("db:web-role", tsx("packages/db/src/web-role.ts", ["--test"]));
  runOnce("kyc:setup", tsx("packages/kyc/src/cli.ts", ["setup"]));
  runOnce("signer:setup (test database)", tsx("packages/signer/src/cli.ts", ["setup"]));
}

export function adminDb(): pg.Client {
  const env = new Map<string, string>();
  for (const line of readFileSync(join(BACKEND, ".env.local"), "utf8").split(/\r?\n/)) {
    const eq = line.indexOf("=");
    if (eq > 0 && !line.startsWith("#")) env.set(line.slice(0, eq), line.slice(eq + 1));
  }
  return new pg.Client({
    host: env.get("PG_HOST") ?? "127.0.0.1",
    port: Number(env.get("PG_PORT") ?? 5433),
    user: env.get("PG_ADMIN_USER") ?? "pt_admin",
    password: env.get("PG_ADMIN_PASSWORD") ?? "",
    database: STACK.database,
  });
}

export interface Stack {
  stop(): Promise<void>;
  /** Stops and restarts the outbox worker (crash tests). */
  stopWorker(): Promise<void>;
  startWorker(): void;
}

function kill(p: ChildProcess | null): Promise<void> {
  if (!p?.pid || p.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    p.once("exit", () => {
      resolve();
    });
    // tsx runs the service in a child process: end the whole tree.
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(p.pid), "/T", "/F"], { windowsHide: true });
    else p.kill("SIGTERM");
    setTimeout(resolve, 5_000).unref();
  });
}

function service(label: string, script: string, args: string[]): ChildProcess {
  const p = spawn(process.execPath, tsx(script, args), { cwd: BACKEND, env: serviceEnv(), windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  p.stderr.on("data", (d: Buffer) => {
    if (process.env.STACK_VERBOSE === "1") process.stderr.write(`[${label}] ${d.toString()}`);
  });
  return p;
}

async function waitFor(what: string, check: () => Promise<boolean>, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Starts the services and waits until they answer and the read model has caught up with the chain. */
export async function start(): Promise<Stack> {
  const procs: { indexer: ChildProcess; signer: ChildProcess; kyc: ChildProcess; worker: ChildProcess | null } = {
    indexer: service("indexer", "packages/indexer/src/cli.ts", ["run"]),
    signer: service("signer", "packages/signer/src/cli.ts", ["serve"]),
    kyc: service("kyc", "packages/kyc/src/cli.ts", ["serve"]),
    worker: null,
  };
  const startWorker = (): void => {
    procs.worker = service("outbox", "packages/signer/src/outbox-worker.ts", []);
  };
  startWorker();
  const stop = async (): Promise<void> => {
    await Promise.all([kill(procs.worker), kill(procs.indexer), kill(procs.signer), kill(procs.kyc)]);
  };
  try {
    await waitFor("signing service", async () => (await fetch(`${STACK.signerUrl}/v1/health`)).ok, 60_000);
    await waitFor("KYC service", async () => (await fetch(`${STACK.kycUrl}/v1/health`)).ok, 60_000);
    const admin = adminDb();
    await admin.connect();
    try {
      await waitFor(
        "the indexer to catch up",
        async () => {
          const head = await fetch(RPC, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
          });
          const n = BigInt(((await head.json()) as { result: string }).result);
          const { rows } = await admin.query<{ b: string | null }>("SELECT max(block_number) AS b FROM chain.cursors");
          const b = rows[0]?.b;
          return b !== null && b !== undefined && n - BigInt(b) < 10n;
        },
        240_000,
      );
    } finally {
      await admin.end();
    }
  } catch (e) {
    await stop();
    throw e;
  }
  return { stop, stopWorker: () => kill(procs.worker), startWorker };
}

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { LOCAL_DEV_CHAIN_ID, readEnvFile } from "@pt/config";
import pg from "pg";
import { FileKeystore, writeKeyFile } from "./keystore.ts";
import { createSignerServer, type Client } from "./http.ts";
import { SignerService, viemChainReader } from "./service.ts";

/**
 * Signing service commands (run from backend/):
 *   npm run signer:setup                 LOCAL DEV ONLY: keystore from dev keys, first mint policy
 *   npm run signer                       start the service on 127.0.0.1:4900
 *   npm run signer:decide -- <requestId> <operator> approve|reject "<reason>"
 *   npm run signer:audit                 verify the audit hash chain
 */
const BACKEND = fileURLToPath(new URL("../../../", import.meta.url));
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const ENV_FILE = `${BACKEND}.env.local`;
const KEYSTORE = `${BACKEND}data/keystore`;
const RPC = process.env.CHAIN_RPC_URL ?? "http://127.0.0.1:8545";

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
    application_name: "signer",
    max: 8,
    statement_timeout: 15_000,
    connectionTimeoutMillis: 5_000,
  });
}

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function setup(): Promise<void> {
  if (process.env.NODE_ENV === "production") throw new Error("signer:setup imports dev keys and is for local development only");
  const e = env();
  const add: string[] = [];
  if (!e.SIGNER_MASTER_KEY) add.push(`SIGNER_MASTER_KEY=${randomBytes(32).toString("base64url")}`);
  if (!e.SIGNER_CLIENT_SECRET_OUTBOX) add.push(`SIGNER_CLIENT_SECRET_OUTBOX=${randomBytes(32).toString("base64url")}`);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed path inside backend/
  if (add.length) await appendFile(ENV_FILE, `\n# signing service (local dev, generated)\n${add.join("\n")}\n`, { mode: 0o600 });
  const master = env().SIGNER_MASTER_KEY ?? "";
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed path inside backend/
  if (!existsSync(KEYSTORE)) mkdirSync(KEYSTORE, { recursive: true, mode: 0o700 });

  const dev = readEnvFile(`${ROOT}chain/network/dev-accounts.env`);
  const devKey = dev.ISSUANCE_SAFE_KEY;
  if (!devKey) throw new Error("no ISSUANCE_SAFE_KEY in chain/network/dev-accounts.env; run python chain/net.py setup");
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed path inside backend/
  if (!existsSync(`${KEYSTORE}/issuance.json`)) await writeKeyFile(KEYSTORE, "issuance", devKey as `0x${string}`, master);
  const ks = await FileKeystore.open(KEYSTORE, master);

  const { latestDeployment } = await import("../../demo-console/src/local.ts");
  const d = latestDeployment();
  if (!d) throw new Error("no local deployment; run python chain/flow.py");
  const db = pool();
  try {
    await db.query("INSERT INTO signer.keys (key_ref, address, purpose) VALUES ('issuance', $1, 'Issuance Safe (local dev key)') ON CONFLICT DO NOTHING", [ks.address("issuance")]);
    const rule = {
      chainId: LOCAL_DEV_CHAIN_ID,
      keyRef: "issuance",
      issuance: d.issuance.toLowerCase(),
      token: d.token.toLowerCase(),
      identityRegistry: d.ir.toLowerCase(),
      maxPerCommand: "100000",
      maxPerDay: "300000",
      approvalAbove: "10000",
      approvals: 2,
    };
    const active = await db.query<{ rule: unknown }>("SELECT rule FROM signer.policies WHERE kind = 'issuance.mint' AND approved_at IS NOT NULL AND retired_at IS NULL");
    if (JSON.stringify(active.rows[0]?.rule) !== JSON.stringify(rule)) {
      const { rows } = await db.query<{ id: string }>("SELECT signer.propose_policy('issuance.mint', $1::jsonb, 'dev-maker') AS id", [JSON.stringify(rule)]);
      await db.query("SELECT signer.approve_policy($1, 'dev-checker')", [rows[0]?.id]);
      out("mint policy activated (maker dev-maker, checker dev-checker)");
    }
    out(`keystore: ${KEYSTORE} · key issuance = ${ks.address("issuance")}`);
  } finally {
    await db.end();
  }
}

async function serve(): Promise<void> {
  const e = env();
  if (!e.SIGNER_MASTER_KEY || !e.SIGNER_CLIENT_SECRET_OUTBOX) throw new Error("run npm run signer:setup first");
  const keys = await FileKeystore.open(KEYSTORE, e.SIGNER_MASTER_KEY);
  const service = new SignerService(pool(), keys, viemChainReader(RPC));
  const clients: Client[] = [{ id: "outbox-worker", secret: Buffer.from(e.SIGNER_CLIENT_SECRET_OUTBOX, "base64url") }];
  const port = Number(e.SIGNER_PORT ?? 4900);
  createSignerServer(service, clients).listen(port, "127.0.0.1", () => {
    out(`signer listening on 127.0.0.1:${String(port)} · keys: ${keys.refs().join(", ")}`);
  });
}

async function decide(args: string[]): Promise<void> {
  const [requestId, operator, decision, ...reason] = args;
  if (!requestId || !operator || (decision !== "approve" && decision !== "reject")) {
    throw new Error('usage: signer:decide -- <requestId> <operator> approve|reject "<reason>"');
  }
  const db = pool();
  try {
    const { rows } = await db.query<{ s: string }>("SELECT signer.decide($1, $2, $3, $4) AS s", [requestId, operator, decision, reason.join(" ") || null]);
    out(`request ${requestId}: ${rows[0]?.s ?? "?"}`);
  } finally {
    await db.end();
  }
}

async function audit(): Promise<void> {
  const db = pool();
  try {
    const { rows } = await db.query<{ audit_id: string; problem: string }>("SELECT * FROM signer.verify_audit()");
    const n = await db.query<{ n: string }>("SELECT count(*) AS n FROM signer.audit");
    out(rows.length === 0 ? `audit chain intact (${n.rows[0]?.n ?? "0"} entries)` : `PROBLEMS:\n${rows.map((r) => `#${r.audit_id}: ${r.problem}`).join("\n")}`);
    if (rows.length) process.exitCode = 1;
  } finally {
    await db.end();
  }
}

const [cmd, ...rest] = process.argv.slice(2);
const run = { setup, serve, decide: () => decide(rest), audit }[cmd ?? ""];
if (!run) {
  out("commands: setup | serve | decide | audit");
  process.exitCode = 2;
} else {
  run().catch((e: unknown) => {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  });
}

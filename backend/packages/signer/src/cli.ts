import { createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { LOCAL_DEV_CHAIN_ID, readEnvFile } from "@pt/config";
import { secretFromEnv } from "@pt/http-auth";
import pg from "pg";
import { createPublicClient, http, type Hex } from "viem";
import { FileKeystore, writeKeyFile } from "./keystore.ts";
import { ADMIN_SCOPE, createSignerServer, OUTBOX_SCOPE, WEB_SCOPE, type Client } from "./http.ts";
import { SignerService, viemChainReader } from "./service.ts";

/**
 * Signing service commands (run from backend/):
 *   npm run signer:setup                 LOCAL DEV CHAIN ONLY: keystore from dev keys, persona wallets, policies
 *   npm run signer                       start the service on 127.0.0.1:4900
 *   npm run signer:decide -- <requestId> <operator> approve|reject "<reason>"
 *   npm run signer:audit                 verify the audit hash chain
 *   npm run signer:import-web-wallets    LOCAL/DEMO ONLY: move earlier web sign-ups' wallets into custody
 *   npm run signer:admin-client          the admin portal's client secret (preview + decide only), idempotent;
 *                                        written to backend/.env.local and admin/.env.local, never printed
 * Settings: PG_* (PG_DATABASE, default property_token), CHAIN_RPC_URL, SIGNER_PORT (4900),
 * SIGNER_KEYSTORE_DIR (default backend/data/keystore); secrets from backend/.env.local.
 */
const BACKEND = fileURLToPath(new URL("../../../", import.meta.url));
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const ENV_FILE = `${BACKEND}.env.local`;

function env(): Record<string, string> {
  return { ...readEnvFile(ENV_FILE), ...(process.env as Record<string, string>) };
}

const rpc = (): string => env().CHAIN_RPC_URL ?? "http://127.0.0.1:8545";
const keystoreDir = (): string => env().SIGNER_KEYSTORE_DIR ?? `${BACKEND}data/keystore`;

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

/** Refuses anything but the local dev chain (586586) outside production: dev keys must never sign elsewhere. */
async function assertLocalDevChain(what: string): Promise<void> {
  if (process.env.NODE_ENV === "production") throw new Error(`${what} imports dev keys and is for the local dev chain only`);
  const id = await createPublicClient({ transport: http(rpc(), { timeout: 5_000 }) }).getChainId();
  if (id !== LOCAL_DEV_CHAIN_ID) throw new Error(`${what}: the node is chain ${String(id)}, not the local dev chain ${String(LOCAL_DEV_CHAIN_ID)}`);
}

/** Platform keys imported from chain/network/dev-accounts.env: ref -> dev role. */
const PLATFORM_KEYS = [
  ["issuance", "ISSUANCE_SAFE", "Issuance Safe (local dev key)"],
  ["ops", "OPS_SAFE", "Ops Safe (local dev key)"],
  ["identity", "IDENTITY_OPERATOR", "Identity operator (local dev key)"],
  ["registrar", "REGISTRAR", "Registrar (local dev key)"],
  ["claims", "CLAIM_SIGNER", "Claim signer of the trusted ClaimIssuer (local dev key)"],
] as const;
const PERSONAS = ["ALICE", "BOB"] as const;
const PAKISTAN = 586;

async function setup(): Promise<void> {
  await assertLocalDevChain("signer:setup");
  const e = env();
  const add: string[] = [];
  if (!e.SIGNER_MASTER_KEY) add.push(`SIGNER_MASTER_KEY=${randomBytes(32).toString("base64url")}`);
  if (!e.SIGNER_CLIENT_SECRET_OUTBOX) add.push(`SIGNER_CLIENT_SECRET_OUTBOX=${randomBytes(32).toString("base64url")}`);
  if (!e.SIGNER_CLIENT_SECRET_WEB) add.push(`SIGNER_CLIENT_SECRET_WEB=${randomBytes(32).toString("base64url")}`);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed path inside backend/
  if (add.length) await appendFile(ENV_FILE, `\n# signing service (local dev, generated)\n${add.join("\n")}\n`, { mode: 0o600 });
  const master = env().SIGNER_MASTER_KEY ?? "";
  const dir = keystoreDir();
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- configured directory
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });

  const dev = readEnvFile(`${ROOT}chain/network/dev-accounts.env`);
  for (const [ref, role] of PLATFORM_KEYS) {
    const key = dev[`${role}_KEY`];
    if (!key) throw new Error(`no ${role}_KEY in chain/network/dev-accounts.env; run python chain/net.py setup`);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- ref is a fixed name
    if (!existsSync(`${dir}/${ref}.json`)) await writeKeyFile(dir, ref, key as Hex, master);
  }
  const ks = await FileKeystore.open(dir, master);

  const { latestDeployment } = await import("../../demo-console/src/local.ts");
  const d = latestDeployment();
  const factories = readDeploymentExtras();
  if (!d || !factories) throw new Error("no local deployment; run python chain/flow.py");
  const db = pool();
  try {
    for (const [ref, , purpose] of PLATFORM_KEYS) {
      await db.query("INSERT INTO signer.keys (key_ref, address, purpose) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [ref, ks.address(ref), purpose]);
    }
    // The demo personas trade on the website: their dev keys become custodial wallets of the service.
    for (const persona of PERSONAS) {
      const key = dev[`${persona}_KEY`];
      if (!key) throw new Error(`no ${persona}_KEY in chain/network/dev-accounts.env`);
      const w = await ks.importCustodialKey(key as Hex);
      await db.query("SELECT signer.register_custodial_wallet($1, 'imported_dev', 'signer:setup')", [w.address]);
    }
    const lc = (a: string): string => a.toLowerCase();
    const policies: [string, object][] = [
      ["issuance.mint", { chainId: LOCAL_DEV_CHAIN_ID, keyRef: "issuance", issuance: lc(d.issuance), token: lc(d.token), identityRegistry: lc(d.ir),
        maxPerCommand: "100000", maxPerDay: "300000", approvalAbove: "10000", approvals: 2 }],
      ["token.transfer", { chainId: LOCAL_DEV_CHAIN_ID, token: lc(d.token), identityRegistry: lc(d.ir),
        maxPerCommand: "100000", maxPerDay: "1000000", approvalAbove: "10000", approvals: 2 }],
      ["compliance.freeze", { chainId: LOCAL_DEV_CHAIN_ID, keyRef: "ops", freezeGuard: lc(d.freezeGuard), token: lc(d.token), maxPerDay: 20, approvals: 0 }],
      ["rent.record_payout", { chainId: LOCAL_DEV_CHAIN_ID, keyRef: "ops", registry: lc(d.distributions), token: lc(d.token), approvals: 0 }],
      ["identity.create", { chainId: LOCAL_DEV_CHAIN_ID, keyRef: "identity", idFactory: lc(factories.idFactory), maxPerDay: 500 }],
      ["identity.add_claim", { chainId: LOCAL_DEV_CHAIN_ID, claimKeyRef: "claims", idFactory: lc(factories.idFactory), claimIssuer: lc(factories.claimIssuer),
        topics: [1, 2], maxPerDay: 1000 }],
      ["identity.register", { chainId: LOCAL_DEV_CHAIN_ID, keyRef: "registrar", registrarGuard: lc(d.registrarGuard), identityRegistry: lc(d.ir),
        idFactory: lc(factories.idFactory), claimIssuer: lc(factories.claimIssuer), countries: [PAKISTAN], topics: [1, 2], maxPerDay: 500 }],
    ];
    for (const [kind, rule] of policies) {
      const active = await db.query<{ rule: unknown }>("SELECT rule FROM signer.policies WHERE kind = $1 AND approved_at IS NOT NULL AND retired_at IS NULL", [kind]);
      // jsonb reorders keys: compare canonically, so a re-run does not propose an identical version.
      if (canonical(active.rows[0]?.rule) === canonical(rule)) continue;
      const { rows } = await db.query<{ id: string }>("SELECT signer.propose_policy($1, $2::jsonb, 'dev-maker') AS id", [kind, JSON.stringify(rule)]);
      await db.query("SELECT signer.approve_policy($1, 'dev-checker')", [rows[0]?.id]);
      out(`${kind} policy activated (maker dev-maker, checker dev-checker)`);
    }
    out(`keystore: ${dir} · ${String(ks.refs().length)} keys (${PLATFORM_KEYS.map(([r]) => r).join(", ")} + persona wallets)`);
  } finally {
    await db.end();
  }
}

function canonical(v: unknown): string {
  if (v === null || v === undefined || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const o = v as Record<string, unknown>;
  // eslint-disable-next-line security/detect-object-injection -- keys come from the object itself
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
}

/** idFactory and claimIssuer from the DeployLib broadcast (the demo console's helper does not list them). */
function readDeploymentExtras(): { idFactory: string; claimIssuer: string } | null {
  const file = `${ROOT}contracts/broadcast/Deploy.s.sol/${String(LOCAL_DEV_CHAIN_ID)}/run-latest.json`;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed path inside the repository
  if (!existsSync(file)) return null;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed path inside the repository
  const run = JSON.parse(readFileSync(file, "utf8")) as { returns?: { d?: { value?: string } } };
  const values = run.returns?.d?.value?.match(/0x[0-9a-fA-F]{40}/g) ?? [];
  // DeployLib.Deployment order: timelock, oidAuthority, trexAuthority, idFactory, factory, claimIssuer, ...
  if (values.length !== 17) return null;
  const idFactory = values.at(3);
  const claimIssuer = values.at(5);
  return idFactory && claimIssuer ? { idFactory, claimIssuer } : null;
}

async function serve(): Promise<void> {
  const e = env();
  if (!e.SIGNER_MASTER_KEY) throw new Error("run npm run signer:setup first");
  const keys = await FileKeystore.open(keystoreDir(), e.SIGNER_MASTER_KEY);
  const service = new SignerService(pool(), keys, viemChainReader(rpc()));
  const clients: Client[] = [{ id: "outbox-worker", secret: secretFromEnv(e, "SIGNER_CLIENT_SECRET_OUTBOX"), scope: OUTBOX_SCOPE }];
  // The website may only create custodial wallets (ADR 0010); it can never ask for a signature.
  if (e.SIGNER_CLIENT_SECRET_WEB) clients.push({ id: "web", secret: secretFromEnv(e, "SIGNER_CLIENT_SECRET_WEB"), scope: WEB_SCOPE });
  // The admin portal may only preview and decide pending requests (Step 6b); it can never ask for a signature.
  if (e.SIGNER_CLIENT_SECRET_ADMIN) clients.push({ id: "admin-portal", secret: secretFromEnv(e, "SIGNER_CLIENT_SECRET_ADMIN"), scope: ADMIN_SCOPE });
  const port = Number(e.SIGNER_PORT ?? 4900);
  createSignerServer(service, clients).listen(port, "127.0.0.1", () => {
    out(`signer listening on 127.0.0.1:${String(port)} · ${String(keys.refs().length)} keys · clients: ${clients.map((c) => c.id).join(", ")}`);
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

/**
 * LOCAL/DEMO ONLY, once: before Step 5h the website generated sign-up wallets itself and kept the
 * keys encrypted in webdemo.investors. This moves each key into the signing service's custody
 * (encrypted keystore + signer.custodial_wallets) and then deletes the website's copy, so exactly
 * one custodian remains. Needs WEB_WALLET_KEY from web/.env.local on the same machine.
 */
async function importWebWallets(): Promise<void> {
  await assertLocalDevChain("signer:import-web-wallets");
  const e = env();
  const db = pool();
  try {
    const exists = await db.query<{ ok: boolean }>("SELECT to_regclass('webdemo.investors') IS NOT NULL AS ok");
    const { rows } = exists.rows[0]?.ok === true
      ? await db.query<{ id: string; wallet_address: string; wallet_key_enc: Buffer }>(
        "SELECT id, wallet_address, wallet_key_enc FROM webdemo.investors WHERE wallet_key_enc IS NOT NULL ORDER BY created_at")
      : { rows: [] };
    if (rows.length === 0) {
      out("no website-held wallet keys: nothing to import");
      return;
    }
    const webKey = readEnvFile(`${ROOT}web/.env.local`).WEB_WALLET_KEY;
    if (!webKey) throw new Error("WEB_WALLET_KEY not found in web/.env.local");
    if (!e.SIGNER_MASTER_KEY) throw new Error("run npm run signer:setup first");
    const ks = await FileKeystore.open(keystoreDir(), e.SIGNER_MASTER_KEY);
    let moved = 0;
    for (const r of rows) {
      const blob = r.wallet_key_enc;
      const d = createDecipheriv("aes-256-gcm", Buffer.from(webKey, "base64url"), blob.subarray(0, 12));
      d.setAuthTag(blob.subarray(12, 28));
      const key = Buffer.concat([d.update(blob.subarray(28)), d.final()]).toString("utf8") as Hex;
      const w = await ks.importCustodialKey(key);
      if (w.address !== r.wallet_address.toLowerCase()) throw new Error(`investor ${r.id}: the stored key does not match the wallet on record`);
      await db.query("SELECT signer.register_custodial_wallet($1, 'imported_dev', 'signer:import-web-wallets')", [w.address]);
      await db.query("UPDATE webdemo.investors SET wallet_key_enc = NULL WHERE id = $1", [r.id]);
      moved++;
    }
    out(`moved ${String(moved)} wallet key(s) into the signing service's custody; restart the signer to load them`);
  } finally {
    await db.end();
  }
}

/**
 * The admin portal's client of the signing service (Step 6b, ADR 0011 section 10): a 32-byte secret,
 * appended to backend/.env.local only when missing, and copied with the signer's URL into
 * admin/.env.local (lines replaced, file mode 0600). Idempotent; the secret is never printed.
 * Restart the signer and the portal afterwards.
 */
async function adminClient(): Promise<void> {
  if (!env().SIGNER_CLIENT_SECRET_ADMIN) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed path inside backend/
    await appendFile(ENV_FILE, `\n# signing service: admin portal client (generated)\nSIGNER_CLIENT_SECRET_ADMIN=${randomBytes(32).toString("base64url")}\n`, { mode: 0o600 });
  }
  const e = env();
  const secret = e.SIGNER_CLIENT_SECRET_ADMIN ?? "";
  secretFromEnv(e, "SIGNER_CLIENT_SECRET_ADMIN"); // validates the format
  const url = `http://127.0.0.1:${e.SIGNER_PORT ?? "4900"}`;
  const adminEnv = `${ROOT}admin/.env.local`;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed path inside the repository
  const before = existsSync(adminEnv) ? readFileSync(adminEnv, "utf8") : "# admin portal settings (never commit)";
  const keep = before.split(/\r?\n/).filter((l) => l && !/^(SIGNER_URL|SIGNER_CLIENT_SECRET_ADMIN)=/.test(l));
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed path inside the repository
  writeFileSync(adminEnv, [...keep, `SIGNER_URL=${url}`, `SIGNER_CLIENT_SECRET_ADMIN=${secret}`, ""].join("\n"), { mode: 0o600 });
  out(`admin portal client ready: backend/.env.local and admin/.env.local hold SIGNER_CLIENT_SECRET_ADMIN (not shown); signer at ${url}. Restart the signer and the portal.`);
}

const [cmd, ...rest] = process.argv.slice(2);
const commands = new Map<string, () => Promise<void>>([
  ["setup", setup],
  ["serve", serve],
  ["decide", () => decide(rest)],
  ["audit", audit],
  ["import-web-wallets", importWebWallets],
  ["admin-client", adminClient],
]);
const run = commands.get(cmd ?? "");
if (!run) {
  out("commands: setup | serve | decide | audit | import-web-wallets | admin-client");
  process.exitCode = 2;
} else {
  run().catch((e: unknown) => {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  });
}

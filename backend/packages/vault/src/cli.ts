import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { readEnvFile, servicePgAuth } from "@pt/config";
import { secretFromEnv, type Client } from "@pt/http-auth";
import pg from "pg";
import { ADMIN_VAULT_SCOPE, createVaultServer, WEB_VAULT_SCOPE } from "./http.ts";
import { MasterKeys, Vault } from "./store.ts";

/**
 * Encrypted document vault (T-038, ADR 0017, migration 0041).
 *   npm run vault:setup                        LOCAL DEV ONLY: master key v1, the website's and the portal's client secrets
 *   npm run vault:serve                        the vault service on 127.0.0.1:4950 (published documents for the website)
 *   npm run vault:put -- <file> <media type>   encrypt and store one document; prints its store reference (vault://<sha256>)
 *   npm run vault:rotate                       re-wrap every data key under VAULT_KEY_CURRENT (keep the old VAULT_MASTER_KEY_V<n> loaded until it reports 0)
 * Files live in VAULT_DIR (default backend/data/vault, git-ignored). The service and put connect as
 * VAULT_PG_USER (group pt_svc_vault): register, look up, check publication, log reads; nothing else.
 */
const BACKEND = fileURLToPath(new URL("../../../", import.meta.url));
const ENV_FILE = `${BACKEND}.env.local`;
const ADMIN_ENV = fileURLToPath(new URL("../../../../admin/.env.local", import.meta.url));

function env(): Record<string, string | undefined> {
  return { ...readEnvFile(ENV_FILE), ...process.env };
}

function pool(): pg.Pool {
  const e = env();
  return new pg.Pool({
    host: e.PG_HOST ?? "127.0.0.1",
    port: Number(e.PG_PORT ?? 5433),
    ...servicePgAuth(e, "vault"),
    database: e.PG_DATABASE ?? "property_token",
    application_name: "vault",
    max: 4,
    statement_timeout: 15_000,
    connectionTimeoutMillis: 5_000,
  });
}

const vaultDir = (): string => env().VAULT_DIR ?? `${BACKEND}data/vault`;

async function setup(): Promise<void> {
  if (process.env.NODE_ENV === "production") throw new Error("vault:setup is for local development only; production keys live in the KMS");
  const e = env();
  const add: string[] = [];
  if (!e.VAULT_MASTER_KEY_V1) add.push(`VAULT_MASTER_KEY_V1=${randomBytes(32).toString("hex")}`, "VAULT_KEY_CURRENT=1");
  if (!e.VAULT_CLIENT_SECRET_WEB) add.push(`VAULT_CLIENT_SECRET_WEB=${randomBytes(32).toString("base64url")}`);
  let admin = e.VAULT_CLIENT_SECRET_ADMIN;
  if (!admin) {
    admin = randomBytes(32).toString("base64url");
    add.push(`VAULT_CLIENT_SECRET_ADMIN=${admin}`);
  }
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed path inside backend/
  if (add.length) await appendFile(ENV_FILE, `\n# Document vault (local dev, generated)\n${add.join("\n")}\n`, { mode: 0o600 });
  // The portal's copy of its client secret (PT Control uploads documents through the service).
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed path inside admin/
  const adminEnv = existsSync(ADMIN_ENV) ? readFileSync(ADMIN_ENV, "utf8") : "";
  if (!/^VAULT_CLIENT_SECRET_ADMIN=/m.test(adminEnv)) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed path inside admin/
    await appendFile(ADMIN_ENV, `\n# Document vault client (written by backend npm run vault:setup)\nVAULT_CLIENT_SECRET_ADMIN=${admin}\n`, { mode: 0o600 });
  }
  console.log(add.length ? `added ${String(add.length)} vault secret(s) to backend/.env.local` : "vault secrets already present");
}

function serve(): void {
  const e = env();
  const db = pool();
  const vault = new Vault(db, vaultDir(), MasterKeys.fromEnv(e));
  const clients: Client[] = [{ id: "web", secret: secretFromEnv(e, "VAULT_CLIENT_SECRET_WEB"), scope: WEB_VAULT_SCOPE }];
  if (e.VAULT_CLIENT_SECRET_ADMIN) clients.push({ id: "admin-portal", secret: secretFromEnv(e, "VAULT_CLIENT_SECRET_ADMIN"), scope: ADMIN_VAULT_SCOPE });
  const port = Number(e.VAULT_PORT ?? 4950);
  const server = createVaultServer(vault, clients);
  server.listen(port, "127.0.0.1", () => {
    console.log(`vault service listening on 127.0.0.1:${String(port)}`);
  });
  const stop = (): void => {
    server.close();
    void db.end();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

async function put(file: string | undefined, media: string | undefined): Promise<void> {
  if (!file || !media) throw new Error("usage: vault:put -- <file> <application/pdf|image/jpeg|image/png|image/tiff>");
  const db = pool();
  try {
    const vault = new Vault(db, vaultDir(), MasterKeys.fromEnv(env()));
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- an operator's own file path
    const r = await vault.put(await readFile(file), media, "vault:put");
    console.log(`${r.storeRef} (sha256 ${r.sha256})`);
  } finally {
    await db.end();
  }
}

async function rotate(): Promise<void> {
  const db = pool();
  try {
    const keys = MasterKeys.fromEnv(env());
    const r = await new Vault(db, vaultDir(), keys).rotate();
    console.log(`${String(r.rewrapped)} document key(s) re-wrapped under vault key v${String(keys.current)}`);
    for (const h of r.failed) console.log(`NOT re-wrapped (does not decrypt to its hash): ${h}`);
    if (r.failed.length) process.exitCode = 3;
  } finally {
    await db.end();
  }
}

async function main(): Promise<void> {
  const [cmd, a1, a2] = process.argv.slice(2);
  if (cmd === "setup") return setup();
  if (cmd === "serve") {
    serve();
    return;
  }
  if (cmd === "put") return put(a1, a2);
  if (cmd === "rotate") return rotate();
  console.log("usage: vault setup | serve | put <file> <media type> | rotate");
  process.exitCode = 2;
}

main().catch((e: unknown) => {
  // Messages only: never a stack with values.
  console.error(e instanceof Error ? e.message : "failed");
  process.exitCode = 1;
});

/**
 * Officer bootstrap and enrolment links (run on the server by an operator with database access):
 *
 *   npm run officer -- bootstrap <handle> "<Full Name>"   # only while no non-bootstrap officer exists (max 2)
 *   npm run officer -- enrol-link <handle> [minutes]       # approved (or bootstrap) officer without a key
 *   npm run officer -- list
 *   npm run officer -- verify                              # admin audit chain (exit 3 on a problem)
 *
 * Connects with the PostgreSQL credentials in the environment (ADMIN_CLI_PG_USER/PASSWORD, else
 * PG_ADMIN_* or backend/.env.local) and immediately drops to the pt_admin_cli role, so it can do
 * nothing but these functions. The token is printed ONCE and only its SHA-256 is stored.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { userInfo } from "node:os";
import pg from "pg";

function envFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  // Fixed paths inside the repository.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  if (!existsSync(file)) return out;
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const eq = line.indexOf("=");
    if (eq > 0 && !line.startsWith("#")) out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

const app = envFile(join(process.cwd(), ".env.local"));
const backend = envFile(join(process.cwd(), "..", "backend", ".env.local"));
const sources = [process.env, app, backend].map((o) => new Map(Object.entries(o)));
const pick = (...keys: string[]): string | undefined => {
  for (const k of keys) {
    const v = sources.map((m) => m.get(k)).find((x) => x);
    if (v) return v;
  }
  return undefined;
};

const ORIGIN = pick("ADMIN_ORIGIN") ?? "http://localhost:3300";
const HANDLE = /^[a-z][a-z0-9._-]{2,39}$/;

async function connect(): Promise<pg.Client> {
  const client = new pg.Client({
    host: pick("ADMIN_PG_HOST", "PG_HOST") ?? "127.0.0.1",
    port: Number(pick("ADMIN_PG_PORT", "PG_PORT") ?? 5433),
    database: pick("ADMIN_PG_DATABASE") ?? "pt_admin_dev",
    user: pick("ADMIN_CLI_PG_USER", "PG_ADMIN_USER") ?? "pt_admin",
    password: pick("ADMIN_CLI_PG_PASSWORD", "PG_ADMIN_PASSWORD") ?? "",
    application_name: "admin-officer-cli",
  });
  await client.connect();
  await client.query("SET ROLE pt_admin_cli");
  return client;
}

function actor(): string {
  return `cli:${userInfo().username}`.slice(0, 100);
}

function newLink(): { token: string; hash: Buffer; url: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: createHash("sha256").update(token, "utf8").digest(), url: `${ORIGIN}/enrol#token=${token}` };
}

function printLink(handle: string, url: string, expires: Date): void {
  process.stdout.write(
    [
      "",
      `One-time enrolment link for ${handle} (valid until ${expires.toISOString()}, single use):`,
      "",
      `  ${url}`,
      "",
      "Give it to the officer in person or over a separate trusted channel. It is not shown again;",
      "issuing a new link revokes this one. Open it in a browser on the officer's own machine.",
      "",
    ].join("\n"),
  );
}

async function main(): Promise<number> {
  const [cmd, a, b] = process.argv.slice(2);
  const client = await connect();
  try {
    if (cmd === "bootstrap") {
      if (!a || !HANDLE.test(a) || !b) throw new Error('usage: bootstrap <handle> "<Full Name>"');
      const link = newLink();
      await client.query("SELECT admin.bootstrap_admin($1, $2, $3, $4)", [a, b, link.hash, actor()]);
      printLink(a, link.url, new Date(Date.now() + 30 * 60_000));
      return 0;
    }
    if (cmd === "enrol-link") {
      if (!a || !HANDLE.test(a)) throw new Error("usage: enrol-link <handle> [minutes 5-30]");
      const minutes = b ? Number(b) : 30;
      const link = newLink();
      const { rows } = await client.query<{ e: Date }>("SELECT admin.issue_enrolment($1, $2, $3, $4) AS e", [a, link.hash, actor(), minutes]);
      printLink(a, link.url, rows[0]?.e ?? new Date());
      return 0;
    }
    if (cmd === "list") {
      const { rows } = await client.query<{ handle: string; display_name: string; status: string; roles: string[]; credentials: string; bootstrap: boolean }>(
        "SELECT * FROM admin.directory()",
      );
      for (const r of rows) {
        process.stdout.write(
          `${r.handle.padEnd(24)} ${r.status.padEnd(9)} keys ${r.credentials}  ${r.roles.join(",")}${r.bootstrap ? "  (bootstrap)" : ""}  ${r.display_name}\n`,
        );
      }
      return 0;
    }
    if (cmd === "verify") {
      const { rows } = await client.query<{ audit_id: string | null; problem: string }>("SELECT * FROM admin.verify_audit()");
      if (rows.length === 0) {
        process.stdout.write("admin audit chain: intact\n");
        return 0;
      }
      for (const r of rows) process.stdout.write(`problem at ${r.audit_id ?? "-"}: ${r.problem}\n`);
      return 3;
    }
    process.stderr.write("commands: bootstrap <handle> \"<Full Name>\" | enrol-link <handle> [minutes] | list | verify\n");
    return 2;
  } finally {
    await client.end();
  }
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  },
);

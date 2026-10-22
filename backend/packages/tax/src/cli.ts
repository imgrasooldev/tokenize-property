import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { readEnvFile } from "@pt/config";
import { secretFromEnv } from "@pt/http-auth";
import { Peppers } from "@pt/kyc";
import pg from "pg";
import { z } from "zod";
import { MockAtl } from "./atl.ts";
import { CnicKeys } from "./crypto.ts";
import { ADMIN_TAX_SCOPE, createTaxServer } from "./http.ts";
import { OpsService, TaxService } from "./service.ts";

/**
 * Operations and tax command line (spec S-03, migration 0021, ADR 0014). Operators use it until the
 * remaining portal screens exist; every operation names its actor (never an officer's handle:
 * officers act in the portal) and the database enforces maker-checker.
 *   npm run tax:setup                         LOCAL DEV ONLY: CNIC sealing key + portal client secret
 *   npm run tax:serve                         the tax service (127.0.0.1:4940): filing exports for the portal
 *   npm run tax:atl -- <YYYY-MM-DD>           ATL checks for that ATL edition (MOCK provider, never in production)
 *   npm run tax:enrol-cnic -- <subject>       seal an investor's CNIC for tax use; the CNIC is read from stdin
 *   npm run tax:audit                         verify the operations/tax audit chain (exit 3 on a problem)
 *   npm run tax:reconcile -- <token>          tax consistency findings for one token (exit 3 if any)
 *   npm run ops:statement -- <token> <YYYY-MM>     the operating statement of a period (JSON)
 *   npm run ops:run -- <action> '<json>'      one operation (ops:run -- actions lists them)
 */
const BACKEND = fileURLToPath(new URL("../../../", import.meta.url));
const ENV_FILE = `${BACKEND}.env.local`;
const ADMIN_ENV = fileURLToPath(new URL("../../../../admin/.env.local", import.meta.url));
const RENT_DIR = fileURLToPath(new URL("../../../../chain/data/rent/", import.meta.url));

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
    application_name: "tax",
    max: 4,
  });
}

async function setup(): Promise<void> {
  if (process.env.NODE_ENV === "production") throw new Error("tax:setup is for local development only; production keys live in the KMS");
  const e = env();
  const add: string[] = [];
  if (!e.TAX_CNIC_KEY_V1) add.push(`TAX_CNIC_KEY_V1=${randomBytes(32).toString("hex")}`, "TAX_CNIC_KEY_CURRENT=1");
  let secret = e.TAX_CLIENT_SECRET_ADMIN;
  if (!secret) {
    secret = randomBytes(32).toString("base64url");
    add.push(`TAX_CLIENT_SECRET_ADMIN=${secret}`);
  }
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed path inside backend/
  if (add.length) await appendFile(ENV_FILE, `\n# Tax service (local dev, generated)\n${add.join("\n")}\n`, { mode: 0o600 });
  // The portal's copy of its client secret (admin/.env.local, git-ignored); never printed.
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed path of the admin app
  const adminEnv = existsSync(ADMIN_ENV) ? readFileSync(ADMIN_ENV, "utf8") : "";
  if (!/^TAX_CLIENT_SECRET_ADMIN=/m.test(adminEnv)) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed path of the admin app
    await appendFile(ADMIN_ENV, `\n# Tax service client (written by backend npm run tax:setup)\nTAX_CLIENT_SECRET_ADMIN=${secret}\n`, { mode: 0o600 });
  }
  console.log(add.length ? `added ${String(add.length)} tax secret(s) to backend/.env.local` : "tax secrets already present");
}

function serve(): void {
  const e = env();
  const db = pool();
  const svc = new TaxService(db, CnicKeys.fromEnv(e));
  const server = createTaxServer(svc, [{ id: "admin-portal", secret: secretFromEnv(e, "TAX_CLIENT_SECRET_ADMIN"), scope: ADMIN_TAX_SCOPE }], {
    onError: (err) => {
      console.error(`tax service request failed: ${err instanceof Error ? err.name : "error"}`);
    },
  });
  const port = Number(e.TAX_PORT ?? 4940);
  server.listen(port, "127.0.0.1", () => {
    console.log(`tax service on 127.0.0.1:${String(port)} (filing exports for the admin portal)`);
  });
  const stop = (): void => {
    server.close();
    void db.end();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

const SQL_ACTIONS = {
  collect: { sql: "SELECT ops.propose_collection($1, $2, $3, $4, $5) AS r", args: ["token", "statementId", "lineNo", "note", "actor"] },
  "decide-collection": { sql: "SELECT ops.decide_collection($1, $2, $3, $4) AS r", args: ["id", "actor", "decision", "reason"] },
  charge: {
    sql: "SELECT ops.propose_charge($1, $2, $3, $4, $5, $6, $7, decode($8, 'hex'), $9) AS r",
    args: ["token", "period", "kind", "feeType", "payee", "description", "amountPaisa", "evidenceSha256", "actor"],
  },
  "decide-charge": { sql: "SELECT ops.decide_charge($1, $2, $3, $4) AS r", args: ["id", "actor", "decision", "reason"] },
  calculate: {
    sql: "SELECT ops.calculate_distribution($1, $2, $3, $4, $5, $6) AS r",
    args: ["token", "period", "recordDate", "recordBlock", "incomeType", "actor"],
  },
  "decide-distribution": { sql: "SELECT ops.decide_distribution($1, $2, $3, $4) AS r", args: ["id", "actor", "decision", "reason"] },
  book: { sql: "SELECT ops.book_distribution($1, $2, $3, $4) AS r", args: ["id", "registry", "onchainId", "actor"] },
  remit: {
    sql: "SELECT tax.propose_remittance($1, $2, $3, $4, $5, $6, $7, $8) AS r",
    args: ["token", "period", "amountPaisa", "cpr", "bankReference", "bankAccount", "paymentDate", "actor"],
  },
  "decide-remit": { sql: "SELECT tax.decide_remittance($1, $2, $3, $4) AS r", args: ["id", "actor", "decision", "reason"] },
  certificate: { sql: "SELECT tax.issue_certificate($1, $2, $3) AS r", args: ["subject", "fiscalYear", "actor"] },
} as const;
type SqlAction = keyof typeof SQL_ACTIONS;
const isSqlAction = (a: string): a is SqlAction => Object.hasOwn(SQL_ACTIONS, a);

async function run(action: string | undefined, input: string | undefined): Promise<void> {
  if (!action || action === "actions") {
    console.log(["attach {id, actor}", "statement-file {id, onchainId}", "verify {id}", ...Object.entries(SQL_ACTIONS).map(([k, v]) => `${k} {${v.args.join(", ")}}`)].join("\n"));
    return;
  }
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- an operator-chosen input file
  const json = z.record(z.string(), z.union([z.string(), z.number()])).parse(JSON.parse(input?.startsWith("@") ? readFileSync(input.slice(1), "utf8") : (input ?? "{}")));
  const fields = new Map(Object.entries(json));
  const val = (k: string): string | null => {
    const v = fields.get(k);
    return v === undefined ? null : String(v);
  };
  const db = pool();
  try {
    const ops = new OpsService(db);
    if (action === "attach") {
      const d = await ops.attach(val("id") ?? "", val("actor") ?? "");
      console.log(JSON.stringify({ root: d.root, statementHash: d.statementHash, taxScheduleHash: d.scheduleHash, entitlements: d.entitlements.length }));
    } else if (action === "verify") {
      const p = await ops.verify(val("id") ?? "");
      console.log(p.length ? p.join("\n") : "consistent");
      if (p.length) process.exitCode = 3;
    } else if (action === "statement-file") {
      const id = val("id") ?? "";
      const onchainId = Number(val("onchainId"));
      const f = await ops.statementFile(id, onchainId);
      const token = JSON.parse(f.statement) as { token: string };
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed directory of the local chain data
      mkdirSync(RENT_DIR, { recursive: true });
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- name from a validated address and id
      writeFileSync(`${RENT_DIR}${token.token}-${String(onchainId)}.json`, JSON.stringify(f, null, 2));
      console.log(`statement file written for distribution ${String(onchainId)} (${String(f.entitlements.length)} entitlements, net amounts)`);
    } else if (isSqlAction(action)) {
      // eslint-disable-next-line security/detect-object-injection -- action checked against the fixed list above
      const a = SQL_ACTIONS[action];
      const { rows } = await db.query<{ r: unknown }>(a.sql, a.args.map(val));
      console.log(JSON.stringify(rows[0]?.r ?? null));
    } else {
      throw new Error(`unknown action ${action} (ops:run -- actions)`);
    }
  } finally {
    await db.end();
  }
}

async function main(): Promise<void> {
  const [cmd, a1, a2] = process.argv.slice(2);
  switch (cmd) {
    case "setup":
      return setup();
    case "serve":
      serve();
      return;
    case "atl": {
      if (process.env.NODE_ENV === "production") throw new Error("only the mock ATL provider exists (task T-031): not in production");
      if (!a1 || !/^\d{4}-\d{2}-\d{2}$/.test(a1)) throw new Error("usage: tax:atl -- <ATL edition YYYY-MM-DD>");
      const db = pool();
      try {
        const r = await new TaxService(db, CnicKeys.fromEnv(env()), { atl: new MockAtl(a1) }).runAtlChecks(a1, 1000);
        console.log(JSON.stringify(r));
      } finally {
        await db.end();
      }
      return;
    }
    case "enrol-cnic": {
      if (!a1) throw new Error("usage: echo <cnic> | npm run tax:enrol-cnic -- <subject id>");
      const db = pool();
      try {
        const id = await new TaxService(db, CnicKeys.fromEnv(env()), { peppers: Peppers.fromEnv(env()), actor: "tax:enrol-cnic" }).enrolCnic(a1, await readStdin());
        console.log(`sealed CNIC record ${id}`);
      } finally {
        await db.end();
      }
      return;
    }
    case "audit": {
      const db = pool();
      try {
        const { rows } = await db.query<{ audit_id: string | null; problem: string }>("SELECT audit_id::text, problem FROM ops.verify_audit()");
        for (const r of rows) console.log(`${r.audit_id ?? "-"}: ${r.problem}`);
        console.log(rows.length ? `${String(rows.length)} problem(s)` : "operations/tax audit chain intact");
        if (rows.length) process.exitCode = 3;
      } finally {
        await db.end();
      }
      return;
    }
    case "reconcile": {
      const db = pool();
      try {
        const { rows } = await db.query<{ check_name: string; subject: string; expected: string; actual: string }>("SELECT * FROM tax.reconcile($1)", [(a1 ?? "").toLowerCase()]);
        for (const r of rows) console.log(`${r.check_name} ${r.subject}: expected ${r.expected}; actual ${r.actual}`);
        console.log(rows.length ? `${String(rows.length)} finding(s)` : "consistent");
        if (rows.length) process.exitCode = 3;
      } finally {
        await db.end();
      }
      return;
    }
    case "statement": {
      const db = pool();
      try {
        const { rows } = await db.query<{ s: unknown }>("SELECT ops.operating_statement($1, $2) AS s", [(a1 ?? "").toLowerCase(), a2 ?? ""]);
        console.log(JSON.stringify(rows[0]?.s ?? null, null, 2));
      } finally {
        await db.end();
      }
      return;
    }
    case "run":
      return run(a1, a2);
    default:
      throw new Error("commands: setup | serve | atl | enrol-cnic | audit | reconcile | statement | run");
  }
}

main().catch((e: unknown) => {
  // Messages only: never a stack with values (inputs may hold personal data).
  console.error(e instanceof Error ? e.message : "failed");
  process.exitCode = 1;
});

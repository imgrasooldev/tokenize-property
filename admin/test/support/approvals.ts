import { spawn, type ChildProcess } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { join } from "node:path";
import type pg from "pg";
import { adminSettings, REPO_ROOT } from "../../scripts/lib-db.mjs";

/**
 * Step 6b test fixtures shared by the HTTP matrix and the end-to-end tests: a real signing service
 * (backend/packages/signer/scripts/serve-test.ts: SignerService + HTTP API, temporary key, fixed
 * chain facts) on the test database, a signing request created through its outbox client exactly
 * like the outbox worker does, and reconciliation and payout rows written as the backend would.
 */

const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;

export interface TestSigner {
  url: string;
  adminSecret: string;
  outboxSecret: string;
  stop: () => void;
  log: () => string;
}

export async function startTestSigner(database: string, port: number): Promise<TestSigner> {
  const backend = join(REPO_ROOT, "backend");
  const s = adminSettings(database);
  const adminSecret = randomBytes(32).toString("base64url");
  const outboxSecret = randomBytes(32).toString("base64url");
  let log = "";
  const child: ChildProcess = spawn(process.execPath, [join(backend, "node_modules", "tsx", "dist", "cli.mjs"), join("packages", "signer", "scripts", "serve-test.ts")], {
    cwd: backend,
    env: {
      ...process.env,
      PG_HOST: String(s.host),
      PG_PORT: String(s.port),
      PG_ADMIN_USER: String(s.user),
      PG_ADMIN_PASSWORD: String(s.password),
      PG_DATABASE: database,
      SIGNER_PORT: String(port),
      SIGNER_CLIENT_SECRET_ADMIN: adminSecret,
      SIGNER_CLIENT_SECRET_OUTBOX: outboxSecret,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d: Buffer) => (log += d.toString()));
  child.stderr?.on("data", (d: Buffer) => (log += d.toString()));
  const url = `http://127.0.0.1:${String(port)}`;
  for (let i = 0; i < 120; i++) {
    const ok = await fetch(`${url}/v1/health`).then(
      (r) => r.ok,
      () => false,
    );
    if (ok) return { url, adminSecret, outboxSecret, stop: () => child.kill(), log: () => log };
    if (child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill();
  throw new Error(`test signer did not start:\n${log}`);
}

/** A mint above the approval threshold, asked for by the outbox client: returns the pending request id. */
export async function pendingMint(signer: TestSigner, amount = "20000"): Promise<string> {
  const path = "/v1/sign";
  const body = JSON.stringify({
    commandRef: `cmd:test:${randomBytes(6).toString("hex")}`,
    kind: "issuance.mint",
    payload: { issuance: A(1), to: A(9), amount, refId: `0x${randomBytes(32).toString("hex")}` },
  });
  const ts = String(Date.now());
  const nonce = randomBytes(16).toString("hex");
  const sig = createHmac("sha256", Buffer.from(signer.outboxSecret, "base64url"))
    .update(`POST\n${path}\n${ts}\n${nonce}\n${createHash("sha256").update(body).digest("hex")}`)
    .digest("hex");
  const res = await fetch(`${signer.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-pt-client": "outbox-worker", "x-pt-ts": ts, "x-pt-nonce": nonce, "x-pt-sig": sig },
    body,
  });
  const out = (await res.json()) as { status: string; requestId?: string };
  if (out.status !== "pending_approval" || !out.requestId) throw new Error(`expected a pending request, got ${JSON.stringify(out)}`);
  return out.requestId;
}

/** A failed reconciliation run: payouts frozen. Returns the freeze event. */
export async function freezePayouts(su: pg.Client): Promise<string> {
  const { rows } = await su.query<{ id: string }>("SELECT recon.start_run('test', NULL, '{}') AS id");
  await su.query(`SELECT recon.complete_run($1, 'test', 0, '[{"check":"cash.closing_mismatch","severity":"blocking","subject":"test"}]', '{}')`, [rows[0]?.id]);
  return (await su.query<{ id: string }>("SELECT id FROM recon.gate_events ORDER BY id DESC LIMIT 1")).rows[0]?.id ?? "";
}

/** A reconciliation run that passed now. */
export async function passRecon(su: pg.Client): Promise<void> {
  const { rows } = await su.query<{ id: string }>("SELECT recon.start_run('test', NULL, '{}') AS id");
  await su.query("SELECT recon.complete_run($1, 'test', 0, '[]', '{}')", [rows[0]?.id]);
}

/**
 * A created payout batch of one line, written as bank.create_payout_batch leaves it (subject and
 * payout account with sealed stand-in bytes; no names). Returns the batch id.
 */
export async function payoutBatch(su: pg.Client): Promise<string> {
  const subject = await su.query<{ id: string }>(
    "INSERT INTO kyc.subjects (name_hash, name_enc, pepper_version, cnic_last4, created_by) VALUES ($1, $2, 1, '1234', 'test') RETURNING id",
    [randomBytes(32), randomBytes(48)],
  );
  const subjectId = subject.rows[0]?.id;
  const payee = await su.query<{ id: string }>(
    `INSERT INTO bank.payees (subject_id, iban_hash, iban_enc, iban_last4, bank_code, registered_at, active_from, registered_by)
     VALUES ($1, $2, $3, '4321', 'MEZN', now() - interval '80 hours', now() - interval '8 hours', 'test') RETURNING id`,
    [subjectId, randomBytes(32), randomBytes(60)],
  );
  const batch = await su.query<{ id: string }>(
    `INSERT INTO bank.payout_batches (reference, token, distribution_id, total_paisa, item_count, items_digest, created_by, kind, paid_paisa, items_digest_version)
     VALUES ($1, $2, 1, 150000, 1, $3, 'operator:maker', 'distribution', 150000, 2) RETURNING id`,
    [`PTPAY-TEST-${randomBytes(3).toString("hex").toUpperCase()}`, `0x${randomBytes(20).toString("hex")}`, randomBytes(32)],
  );
  await su.query("INSERT INTO bank.payout_items (batch_id, line_no, subject_id, payee_id, amount_paisa) VALUES ($1, 1, $2, $3, 150000)", [
    batch.rows[0]?.id,
    subjectId,
    payee.rows[0]?.id,
  ]);
  return batch.rows[0]?.id ?? "";
}

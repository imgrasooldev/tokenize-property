import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeferredError, enqueue, getCommand, OutboxWorker, type Executor } from "@pt/outbox";
import pg from "pg";
import { generatePrivateKey } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../db/src/migrate.ts";
import { contiguousMigrations, scratchDatabase } from "../../db/test/helpers.ts";
import { officer, signIn, type TestOfficer } from "../../db/test/officers.ts";
import { ADMIN_SCOPE, createSignerServer, OUTBOX_SCOPE, SignerClient, type Client } from "../src/http.ts";
import { FileKeystore, writeKeyFile } from "../src/keystore.ts";
import { SignerService, type ChainReader } from "../src/service.ts";

/**
 * Step 6b end to end without a chain: a mint above the approval threshold waits in the outbox; two
 * operations checkers decide it the way the admin portal does (database ticket after session,
 * permission and step-up checks, then the signing service's HTTP API with the admin-scoped client);
 * the outbox then proceeds and the request is signed. Refusals: maker == checker, the same officer
 * twice, a reused ticket, a stale step-up, a changed call, a non-checker, an officer name used
 * outside the portal, wrong client scopes.
 */
const PASS = "a-long-local-test-passphrase-0123456789";
const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const sha = (s: string): Buffer => createHash("sha256").update(s, "utf8").digest();

let admin: pg.Client;
let portal: pg.Client;
let pool: pg.Pool;
let drop: () => Promise<void>;
let server: Server;
let base: string;
let svc: SignerService;
let checker1: TestOfficer;
let checker2: TestOfficer;
let maker: TestOfficer;
let n = 0;

const outboxClient: Client = { id: "outbox-worker", secret: randomBytes(32), scope: OUTBOX_SCOPE };
const adminClient: Client = { id: "admin-portal", secret: randomBytes(32), scope: ADMIN_SCOPE };

const chain: ChainReader = {
  chainId: () => Promise.resolve(586586),
  pendingNonce: () => Promise.resolve(0n),
  simulate: () => Promise.resolve(),
  mintFacts: () => Promise.resolve({ recipientVerified: true, supply: 0n, cap: 1_000_000n, paused: false }),
  txState: () => Promise.resolve("pending"),
  isFrozen: () => Promise.resolve(false),
  distribution: () => Promise.resolve({ status: "none", token: A(2) }),
};

const mint = (amount: string) => ({ issuance: A(1), to: A(9), amount, refId: `0x${(++n).toString(16).padStart(64, "0")}` });

/** The outbox side of the signer executor, without a chain: signed = submitted, then confirmed. */
function executor(signer: SignerClient): Executor {
  return {
    async submit(cmd, record) {
      const r = await signer.sign({ commandRef: cmd.idempotencyKey, kind: "issuance.mint", payload: cmd.payload });
      if (r.status === "pending_approval") throw new DeferredError(`awaiting ${String(r.approvalsNeeded)} approvals (request ${r.requestId})`, 60);
      if (r.status !== "signed") throw new Error(`unexpected ${r.status}`);
      const signed = { hash: r.hash, nonce: r.nonce, from: r.from };
      return (await record(signed)) ? signed : null;
    },
    wait: () => Promise.resolve("success"),
    outcome: () => Promise.resolve("success"),
  };
}

async function ticket(o: TestOfficer, requestId: string, decision: "approve" | "reject", payloadHash: string, callHash: string, reason = "checked against the subscription"): Promise<{ token: string; result: { ok: boolean; error?: string } }> {
  const token = randomBytes(32).toString("base64url");
  const { rows } = await portal.query<{ r: { ok: boolean; error?: string } }>("SELECT admin.issue_signer_ticket($1, $2, $3, $4, $5, $6, $7) AS r", [
    o.sessionHash,
    requestId,
    decision,
    reason,
    Buffer.from(payloadHash, "hex"),
    Buffer.from(callHash, "hex"),
    sha(token),
  ]);
  return { token, result: rows[0]?.r ?? { ok: false } };
}

async function pgCode(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return (e as { code?: string }).code;
  }
}

beforeAll(async () => {
  let settings: pg.ClientConfig;
  ({ client: admin, settings, drop } = await scratchDatabase());
  await migrate(admin, contiguousMigrations());
  pool = new pg.Pool({ ...settings, max: 10 });
  portal = new pg.Client(settings);
  await portal.connect();
  // Exactly the rights of the portal's login (member of pt_admin_portal only).
  await portal.query("SET ROLE pt_admin_portal");
  const dir = await mkdtemp(join(tmpdir(), "ks-"));
  await writeKeyFile(dir, "issuance", generatePrivateKey(), PASS);
  const keys = await FileKeystore.open(dir, PASS);
  await admin.query("INSERT INTO signer.keys (key_ref, address, purpose) VALUES ('issuance', $1, 'test')", [keys.address("issuance")]);
  const rule = { chainId: 586586, keyRef: "issuance", issuance: A(1), token: A(2), identityRegistry: A(3), maxPerCommand: "100000", maxPerDay: "300000", approvalAbove: "10000", approvals: 2 };
  const { rows } = await admin.query<{ id: string }>("SELECT signer.propose_policy('issuance.mint', $1::jsonb, 'maker') AS id", [JSON.stringify(rule)]);
  await admin.query("SELECT signer.approve_policy($1, 'checker')", [rows[0]?.id]);
  svc = new SignerService(pool, keys, chain);
  server = createSignerServer(svc, [outboxClient, adminClient]);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  checker1 = await officer(admin, "ops.checker.one", "ops_checker");
  checker2 = await officer(admin, "ops.checker.two", "ops_checker");
  maker = await officer(admin, "ops.maker.one", "ops_maker");
}, 180_000);

afterAll(async () => {
  await new Promise((r) => server.close(r));
  await portal.end();
  await pool.end();
  await drop();
}, 180_000);

describe("officer decisions through the signing service (Step 6b)", () => {
  it("a mint waits in the outbox, two checkers approve it via tickets, then the outbox proceeds and it is signed", async () => {
    const signer = new SignerClient(base, outboxClient);
    const decider = new SignerClient(base, adminClient);
    const worker = new OutboxWorker(pool, { workerId: "approval-test", executors: { "issuance.mint": executor(signer) }, waitMs: 50 });
    const key = `cmd:approval:${randomBytes(6).toString("hex")}`;
    const payload = mint("20000");
    const id = await enqueue(pool, { idempotencyKey: key, kind: "issuance.mint", payload, createdBy: "web:subscription" });
    await worker.runOnce();
    const waiting = await getCommand(pool, id);
    expect(waiting?.status).toBe("pending");
    expect(waiting?.lastError).toMatch(/awaiting 2 approvals/);
    const req = (await admin.query<{ id: string; payload_hash: Buffer }>("SELECT id, payload_hash FROM signer.requests WHERE command_ref = $1", [key])).rows[0];
    if (!req) throw new Error("no signing request");
    const payloadHash = req.payload_hash.toString("hex");

    // What the checker sees: the exact call, decoded from its bytes, and the live policy check.
    const preview = await decider.preview(req.id);
    expect(preview?.call).toMatchObject({ kind: "issuance.mint", functionName: "mint", to: A(1), payloadHash, chainId: 586586 });
    expect(preview?.call?.args.map((a) => [a.name, a.type, a.value.toLowerCase()])).toEqual([
      ["to", "address", A(9)],
      ["amount", "uint256", "20000"],
      ["refId", "bytes32", payload.refId],
    ]);
    expect(preview?.call?.data?.startsWith(preview.call.selector)).toBe(true);
    expect(preview?.live).toMatchObject({ state: "pass", approvalsNeeded: 2 });
    const callHash = preview?.call?.callHash ?? "";
    expect(await decider.preview(randomUUID())).toBeNull();

    // The maker role cannot even ask for a ticket (database permission).
    expect(await pgCode(ticket(maker, req.id, "approve", payloadHash, callHash))).toBe("42501");

    // First checker.
    const t1 = await ticket(checker1, req.id, "approve", payloadHash, callHash);
    expect(t1.result.ok).toBe(true);
    expect(await decider.decide({ requestId: req.id, decision: "approve", reason: "checked against the subscription", ticket: t1.token, callHash })).toEqual({ status: "pending_approval" });
    // The same ticket cannot be used twice.
    expect(await decider.decide({ requestId: req.id, decision: "approve", reason: "checked against the subscription", ticket: t1.token, callHash })).toMatchObject({
      status: "refused",
      reason: expect.stringMatching(/ticket is not valid/) as unknown,
    });
    // The same officer cannot give the second approval.
    expect((await ticket(checker1, req.id, "approve", payloadHash, callHash)).result).toMatchObject({ ok: false, error: expect.stringMatching(/already decided/) as unknown });
    // The command keeps waiting.
    await admin.query("UPDATE outbox.commands SET available_at = now() - interval '1 second' WHERE id = $1", [id.toString()]);
    await worker.runOnce();
    expect((await getCommand(pool, id))?.status).toBe("pending");

    // A decision on a call other than the one shown is refused by the signing service.
    const wrong = await ticket(checker2, req.id, "approve", payloadHash, "ab".repeat(32));
    expect(wrong.result.ok).toBe(true);
    expect(await decider.decide({ requestId: req.id, decision: "approve", reason: "checked against the subscription", ticket: wrong.token, callHash: "ab".repeat(32) })).toMatchObject({
      status: "refused",
      reason: expect.stringMatching(/changed since you reviewed/) as unknown,
    });
    // A payload other than the one shown: no ticket.
    expect((await ticket(checker2, req.id, "approve", "cd".repeat(32), callHash)).result).toMatchObject({ ok: false, error: expect.stringMatching(/differs/) as unknown });

    // Second checker: approved; the outbox proceeds and the request is signed.
    const t2 = await ticket(checker2, req.id, "approve", payloadHash, callHash, "trustee confirmed the subscription");
    expect(await decider.decide({ requestId: req.id, decision: "approve", reason: "trustee confirmed the subscription", ticket: t2.token, callHash })).toEqual({ status: "approved" });
    await admin.query("UPDATE outbox.commands SET available_at = now() - interval '1 second' WHERE id = $1", [id.toString()]);
    await worker.runOnce();
    expect((await getCommand(pool, id))?.status).toBe("confirmed");
    const after = await admin.query<{ status: string }>("SELECT status FROM signer.requests WHERE id = $1", [req.id]);
    expect(after.rows[0]?.status).toBe("signed");
    const approvals = await admin.query<{ operator: string }>("SELECT operator FROM signer.approvals WHERE request_id = $1 ORDER BY at", [req.id]);
    expect(approvals.rows.map((r) => r.operator)).toEqual(["ops.checker.one", "ops.checker.two"]);

    // Both audit chains hold the decisions and are intact.
    const actions = await admin.query<{ action: string }>("SELECT action FROM admin.audit WHERE action LIKE 'approval.%' ORDER BY id");
    expect(actions.rows.map((r) => r.action)).toEqual(expect.arrayContaining(["approval.ticket", "approval.decided", "approval.refused"]));
    expect((await admin.query("SELECT * FROM admin.verify_audit()")).rows).toEqual([]);
    expect((await admin.query("SELECT * FROM signer.verify_audit()")).rows).toEqual([]);
    const signerAudit = await admin.query<{ actor: string; action: string }>("SELECT actor, action FROM signer.audit WHERE request_id = $1 AND action = 'request.approve'", [req.id]);
    expect(signerAudit.rows.map((r) => r.actor).sort()).toEqual(["ops.checker.one", "ops.checker.two"]);
  });

  it("a rejection by one checker is final and the outbox command fails without sending", async () => {
    const decider = new SignerClient(base, adminClient);
    const r = await svc.request({ commandRef: `cmd:reject:${randomBytes(6).toString("hex")}`, kind: "issuance.mint", payload: mint("15000") }, "outbox-worker");
    if (r.status !== "pending_approval") throw new Error("expected pending");
    const p = await decider.preview(r.requestId);
    const payloadHash = (await admin.query<{ h: Buffer }>("SELECT payload_hash AS h FROM signer.requests WHERE id = $1", [r.requestId])).rows[0]?.h.toString("hex") ?? "";
    const t = await ticket(checker1, r.requestId, "reject", payloadHash, p?.call?.callHash ?? "", "wrong investor wallet on the order");
    expect(await decider.decide({ requestId: r.requestId, decision: "reject", reason: "wrong investor wallet on the order", ticket: t.token, callHash: p?.call?.callHash ?? "" })).toEqual({
      status: "rejected",
    });
    expect((await ticket(checker2, r.requestId, "approve", payloadHash, p?.call?.callHash ?? "")).result).toMatchObject({ ok: false, error: expect.stringMatching(/rejected/) as unknown });
  });

  it("needs a step-up younger than five minutes, also when the ticket is redeemed", async () => {
    const decider = new SignerClient(base, adminClient);
    const r = await svc.request({ commandRef: `cmd:stepup:${randomBytes(6).toString("hex")}`, kind: "issuance.mint", payload: mint("12000") }, "outbox-worker");
    if (r.status !== "pending_approval") throw new Error("expected pending");
    const p = await decider.preview(r.requestId);
    const callHash = p?.call?.callHash ?? "";
    const payloadHash = (await admin.query<{ h: Buffer }>("SELECT payload_hash AS h FROM signer.requests WHERE id = $1", [r.requestId])).rows[0]?.h.toString("hex") ?? "";
    const age = async (o: TestOfficer) => {
      await admin.query("ALTER TABLE admin.sessions DISABLE TRIGGER sessions_guard");
      await admin.query("UPDATE admin.sessions SET step_up_at = step_up_at - interval '5 minutes 1 second' WHERE token_hash = $1", [o.sessionHash]);
      await admin.query("ALTER TABLE admin.sessions ENABLE TRIGGER sessions_guard");
    };
    const fresh = await signIn(admin, checker1);
    await age(fresh);
    expect(await pgCode(ticket(fresh, r.requestId, "approve", payloadHash, callHash))).toBe("PTS01");
    // A ticket issued with a fresh step-up is refused if the step-up is stale when it is redeemed.
    const again = await signIn(admin, checker1);
    const t = await ticket(again, r.requestId, "approve", payloadHash, callHash);
    expect(t.result.ok).toBe(true);
    await age(again);
    expect(await decider.decide({ requestId: r.requestId, decision: "approve", reason: "checked against the subscription", ticket: t.token, callHash })).toMatchObject({
      status: "refused",
      reason: expect.stringMatching(/step-up required/) as unknown,
    });
    expect((await admin.query<{ n: string }>("SELECT count(*) AS n FROM signer.approvals WHERE request_id = $1", [r.requestId])).rows[0]?.n).toBe("0");
    checker1 = await signIn(admin, checker1);
  });

  it("officer names are bound to officer sessions: the command line cannot decide under an officer's handle", async () => {
    const r = await svc.request({ commandRef: `cmd:binding:${randomBytes(6).toString("hex")}`, kind: "issuance.mint", payload: mint("11000") }, "outbox-worker");
    if (r.status !== "pending_approval") throw new Error("expected pending");
    await expect(admin.query("SELECT signer.decide($1, 'ops.checker.one', 'approve', 'pretending to be the officer')", [r.requestId])).rejects.toThrow(/officer of the admin portal/);
    // Ordinary operator names of the command line keep working.
    expect((await admin.query<{ s: string }>("SELECT signer.decide($1, 'ops-ana', 'approve', 'command line operator') AS s", [r.requestId])).rows[0]?.s).toBe("pending_approval");
  });

  it("each client may call only its own paths", async () => {
    const asAdmin = new SignerClient(base, adminClient);
    const asOutbox = new SignerClient(base, outboxClient);
    await expect(asAdmin.sign({ commandRef: "cmd:scope:admin-sign", kind: "issuance.mint", payload: mint("1") })).rejects.toThrow(/403/);
    await expect(asOutbox.preview("00000000-0000-4000-8000-000000000000")).rejects.toThrow(/403/);
    await expect(
      asOutbox.decide({ requestId: "00000000-0000-4000-8000-000000000000", decision: "approve", reason: "outbox cannot decide", ticket: "a".repeat(43), callHash: "a".repeat(64) }),
    ).rejects.toThrow(/403/);
    // Malformed decisions are refused before anything is read.
    await expect(asAdmin.decide({ requestId: "not-a-uuid", decision: "approve", reason: "short", ticket: "x", callHash: "y" })).rejects.toThrow(/400/);
  });
});

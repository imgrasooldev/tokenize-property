import { createHash, randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { generatePrivateKey } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../db/src/migrate.ts";
import { contiguousMigrations, scratchDatabase } from "../../db/test/helpers.ts";
import { officer, type TestOfficer } from "../../db/test/officers.ts";
import { ADMIN_SCOPE, createSignerServer, SignerClient, type Client } from "../src/http.ts";
import { FileKeystore, writeKeyFile } from "../src/keystore.ts";
import { SignerService, type ChainReader } from "../src/service.ts";

/**
 * Step 6d (migration 0023, ADR 0005 amendment): the trustee co-signs every mint that needs
 * maker-checker, in addition to the platform approvals. The requirement is set by the database on
 * insert (deny by default), an approval's capacity follows the approver's role, the trustee decides
 * through a one-time ticket of capacity "trustee" redeemed by the signing service (call preview
 * equal to the signed calldata), and neither side can stand in for the other.
 */
const PASS = "a-long-local-test-passphrase-0123456789";
const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const sha = (s: string): Buffer => createHash("sha256").update(s, "utf8").digest();

let admin: pg.Client;
let portal: pg.Client;
let pool: pg.Pool;
let drop: () => Promise<void>;
let server: Server;
let decider: SignerClient;
let svc: SignerService;
let checker1: TestOfficer;
let checker2: TestOfficer;
let trustee1: TestOfficer;
let trustee2: TestOfficer;
let n = 0;

const adminClient: Client = { id: "admin-portal", secret: randomBytes(32), scope: ADMIN_SCOPE };
const chain: ChainReader = {
  chainId: () => Promise.resolve(586586),
  pendingNonce: () => Promise.resolve(0n),
  simulate: () => Promise.resolve(),
  mintFacts: () => Promise.resolve({ recipientVerified: true, supply: 0n, cap: 10_000_000n, paused: false }),
  txState: () => Promise.resolve("pending"),
  isFrozen: () => Promise.resolve(false),
  distribution: () => Promise.resolve({ status: "none", token: A(2) }),
};
const mint = (amount: string) => ({ issuance: A(1), to: A(9), amount, refId: `0x${(++n).toString(16).padStart(64, "0")}` });

interface Pending {
  id: string;
  payloadHash: string;
  callHash: string;
  commandRef: string;
  payload: Record<string, unknown>;
}

async function pending(amount: string): Promise<Pending> {
  const commandRef = `cmd:trustee:${randomBytes(6).toString("hex")}`;
  const payload = mint(amount);
  const r = await svc.request({ commandRef, kind: "issuance.mint", payload }, "outbox-worker");
  if (r.status !== "pending_approval") throw new Error(`expected pending, got ${r.status}`);
  const p = await decider.preview(r.requestId);
  const payloadHash = (await admin.query<{ h: Buffer }>("SELECT payload_hash AS h FROM signer.requests WHERE id = $1", [r.requestId])).rows[0]?.h.toString("hex") ?? "";
  return { id: r.requestId, payloadHash, callHash: p?.call?.callHash ?? "", commandRef, payload };
}

type Issued = { token: string; result: { ok: boolean; error?: string } };
async function ticket(fn: "issue_signer_ticket" | "issue_trustee_ticket", o: TestOfficer, r: Pick<Pending, "id" | "payloadHash" | "callHash">, decision: "approve" | "reject", reason: string): Promise<Issued> {
  const token = randomBytes(32).toString("base64url");
  const { rows } = await portal.query<{ r: Issued["result"] }>(`SELECT admin.${fn}($1, $2, $3, $4, $5, $6, $7) AS r`, [
    o.sessionHash,
    r.id,
    decision,
    reason,
    Buffer.from(r.payloadHash, "hex"),
    Buffer.from(r.callHash, "hex"),
    sha(token),
  ]);
  return { token, result: rows[0]?.r ?? { ok: false } };
}

async function decide(fn: "issue_signer_ticket" | "issue_trustee_ticket", o: TestOfficer, r: Pick<Pending, "id" | "payloadHash" | "callHash">, decision: "approve" | "reject" = "approve"): Promise<{ status: string; reason?: string | undefined }> {
  const reason = fn === "issue_trustee_ticket" ? "trustee checked the register entry" : "subscription and payment checked";
  const t = await ticket(fn, o, r, decision, reason);
  if (!t.result.ok) return { status: "refused", reason: t.result.error ?? "?" };
  return decider.decide({ requestId: r.id, decision, reason, ticket: t.token, callHash: r.callHash });
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
  await portal.query("SET ROLE pt_admin_portal");
  const dir = await mkdtemp(join(tmpdir(), "ks-"));
  await writeKeyFile(dir, "issuance", generatePrivateKey(), PASS);
  const keys = await FileKeystore.open(dir, PASS);
  await admin.query("INSERT INTO signer.keys (key_ref, address, purpose) VALUES ('issuance', $1, 'test')", [keys.address("issuance")]);
  const rule = { chainId: 586586, keyRef: "issuance", issuance: A(1), token: A(2), identityRegistry: A(3), maxPerCommand: "100000", maxPerDay: "900000", approvalAbove: "10000", approvals: 2 };
  const { rows } = await admin.query<{ id: string }>("SELECT signer.propose_policy('issuance.mint', $1::jsonb, 'maker') AS id", [JSON.stringify(rule)]);
  await admin.query("SELECT signer.approve_policy($1, 'checker')", [rows[0]?.id]);
  svc = new SignerService(pool, keys, chain);
  server = createSignerServer(svc, [adminClient]);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  decider = new SignerClient(`http://127.0.0.1:${String((server.address() as AddressInfo).port)}`, adminClient);
  checker1 = await officer(admin, "ops.checker.one", "ops_checker");
  checker2 = await officer(admin, "ops.checker.two", "ops_checker");
  trustee1 = await officer(admin, "trustee.officer.one", "trustee_officer");
  trustee2 = await officer(admin, "trustee.officer.two", "trustee_officer");
}, 180_000);

afterAll(async () => {
  await new Promise((r) => server.close(r));
  await portal.end();
  await pool.end();
  await drop();
}, 180_000);

describe("trustee co-signature in the signer's maker-checker (migration 0023)", () => {
  it("a mint at or below the threshold needs nobody; above it the database adds the trustee to the platform approvals", async () => {
    const small = await svc.request({ commandRef: `cmd:small:${randomBytes(6).toString("hex")}`, kind: "issuance.mint", payload: mint("10000") }, "outbox-worker");
    expect(small.status).toBe("signed");
    const r = await pending("20000");
    const row = await admin.query<{ approvals_needed: number; trustee_approvals_needed: number }>(
      "SELECT approvals_needed, trustee_approvals_needed FROM signer.requests WHERE id = $1",
      [r.id],
    );
    expect(row.rows[0]).toEqual({ approvals_needed: 2, trustee_approvals_needed: 1 });
    // The requirement is set by the database, not by whoever inserts the row, and never changes.
    const forged = await admin.query<{ t: number }>(
      `INSERT INTO signer.requests (command_ref, kind, key_ref, payload, payload_hash, amount, requested_by, status, approvals_needed, trustee_approvals_needed)
       VALUES ($1, 'issuance.mint', 'issuance', '{}'::jsonb, $2, 50000, 'outbox-worker', 'pending_approval', 2, 0) RETURNING trustee_approvals_needed AS t`,
      [`cmd:forged:${randomBytes(6).toString("hex")}`, randomBytes(32)],
    );
    expect(forged.rows[0]?.t).toBe(1);
    expect(await pgCode(admin.query("UPDATE signer.requests SET trustee_approvals_needed = 0 WHERE id = $1", [r.id]))).toBe("23514");
    // The call shown to the trustee is the exact calldata the signing service signs.
    const p = await decider.preview(r.id);
    expect(p?.call).toMatchObject({ kind: "issuance.mint", functionName: "mint", callHash: r.callHash });
    expect(p?.call?.rules.join(" ")).toMatch(/trustee officer's co-signature/);
  });

  it("two checkers are not enough; the trustee co-signs through its own ticket and the request is approved and signed", async () => {
    const r = await pending("25000");
    expect(await decide("issue_signer_ticket", checker1, r)).toEqual({ status: "pending_approval" });
    expect(await decide("issue_signer_ticket", checker2, r)).toEqual({ status: "pending_approval" });
    // A third platform officer cannot stand in for the trustee (database blocker and signer.decide).
    const checker3 = await officer(admin, "ops.checker.three", "ops_checker");
    expect(await decide("issue_signer_ticket", checker3, r)).toMatchObject({ status: "refused", reason: expect.stringMatching(/trustee co-signs next/) as unknown });
    expect(await pgCode(admin.query("SELECT signer.decide($1, 'ops-cli', 'approve', 'command line stand-in')", [r.id]))).toBe("23514");
    // Nor can the platform force the state: approved needs both capacities (deny by default).
    expect(await pgCode(admin.query("UPDATE signer.requests SET status = 'approved' WHERE id = $1", [r.id]))).toBe("23514");
    // Roles: an operations checker cannot obtain a trustee ticket, a trustee officer no platform ticket.
    expect(await pgCode(ticket("issue_trustee_ticket", checker1, r, "approve", "operations pretending to be the trustee"))).toBe("42501");
    expect(await pgCode(ticket("issue_signer_ticket", trustee1, r, "approve", "trustee pretending to be operations"))).toBe("42501");
    // The trustee officer's handle is refused on the command line (bound to the portal session).
    await expect(admin.query("SELECT signer.decide($1, 'trustee.officer.one', 'approve', 'pretending to be the trustee')", [r.id])).rejects.toThrow(/officer of the admin portal/);
    // A changed call is refused by the signing service.
    const t = await ticket("issue_trustee_ticket", trustee1, { ...r, callHash: "ab".repeat(32) }, "approve", "trustee checked the register entry");
    expect(t.result.ok).toBe(true);
    expect(await decider.decide({ requestId: r.id, decision: "approve", reason: "trustee checked the register entry", ticket: t.token, callHash: "ab".repeat(32) })).toMatchObject({
      status: "refused",
      reason: expect.stringMatching(/changed since you reviewed/) as unknown,
    });
    // The trustee co-signs: approved, then signed on the next request from the outbox.
    expect(await decide("issue_trustee_ticket", trustee1, r)).toEqual({ status: "approved" });
    const caps = await admin.query<{ operator: string; capacity: string }>("SELECT operator, capacity FROM signer.approvals WHERE request_id = $1 ORDER BY at", [r.id]);
    expect(caps.rows).toEqual([
      { operator: "ops.checker.one", capacity: "platform" },
      { operator: "ops.checker.two", capacity: "platform" },
      { operator: "trustee.officer.one", capacity: "trustee" },
    ]);
    expect(await svc.request({ commandRef: r.commandRef, kind: "issuance.mint", payload: r.payload }, "outbox-worker")).toMatchObject({ status: "signed" });
    // A second trustee officer adds nothing.
    expect((await ticket("issue_trustee_ticket", trustee2, r, "approve", "trustee checked the register entry")).result).toMatchObject({
      ok: false,
      error: expect.stringMatching(/no longer waiting|already recorded/) as unknown,
    });
  });

  it("the trustee may co-sign first; a trustee rejection is final; only requests that need the trustee accept a trustee", async () => {
    const r = await pending("30000");
    expect(await decide("issue_trustee_ticket", trustee1, r)).toEqual({ status: "pending_approval" });
    expect(await decide("issue_trustee_ticket", trustee2, r)).toMatchObject({ status: "refused", reason: expect.stringMatching(/already recorded/) as unknown });
    expect(await decide("issue_signer_ticket", checker1, r)).toEqual({ status: "pending_approval" });
    expect(await decide("issue_signer_ticket", checker2, r)).toEqual({ status: "approved" });

    const x = await pending("40000");
    expect(await decide("issue_trustee_ticket", trustee2, x, "reject")).toEqual({ status: "rejected" });
    expect(await decide("issue_signer_ticket", checker1, x)).toMatchObject({ status: "refused", reason: expect.stringMatching(/rejected/) as unknown });

    // A kind the specs do not assign to the trustee: no trustee requirement, and a trustee ticket is refused.
    const other = await admin.query<{ id: string; payload_hash: Buffer; t: number }>(
      `INSERT INTO signer.requests (command_ref, kind, key_ref, payload, payload_hash, requested_by, status, approvals_needed)
       VALUES ($1, 'token.transfer', 'issuance', '{}'::jsonb, $2, 'outbox-worker', 'pending_approval', 2) RETURNING id, payload_hash, trustee_approvals_needed AS t`,
      [`cmd:transfer:${randomBytes(6).toString("hex")}`, randomBytes(32)],
    );
    const o = other.rows[0];
    expect(o?.t).toBe(0);
    const t = await ticket("issue_trustee_ticket", trustee1, { id: o?.id ?? "", payloadHash: o?.payload_hash.toString("hex") ?? "", callHash: "cd".repeat(32) }, "approve", "trustee where no trustee is needed");
    expect(t.result).toMatchObject({ ok: false, error: expect.stringMatching(/needs no trustee/) as unknown });
  });

  it("the trustee and admin audit chains hold every co-signature; a forged trustee approval is found", async () => {
    expect((await admin.query("SELECT * FROM trustee.verify_audit()")).rows).toEqual([]);
    expect((await admin.query("SELECT * FROM admin.verify_audit()")).rows).toEqual([]);
    expect((await admin.query("SELECT * FROM signer.verify_audit()")).rows).toEqual([]);
    const actions = await admin.query<{ action: string; n: string }>("SELECT action, count(*) AS n FROM trustee.audit GROUP BY action");
    expect(actions.rows.find((a) => a.action === "cosign.signer")?.n).toBe("3");
    // A superuser writing an approval around the API under a bound trustee officer: capacity
    // becomes "trustee" by the trigger, but no co-signature entry exists, so verification reports it.
    const r = await pending("15000");
    await admin.query("BEGIN");
    await admin.query("SELECT admin.bind_officer('trustee.officer.two')");
    await admin.query("INSERT INTO signer.approvals (request_id, operator, decision, reason, capacity) VALUES ($1, 'trustee.officer.two', 'approve', 'forged around the API', 'platform')", [r.id]);
    await admin.query("COMMIT");
    const forged = await admin.query<{ problem: string }>("SELECT problem FROM trustee.verify_audit()");
    expect(forged.rows.map((x) => x.problem)).toEqual([expect.stringMatching(/trustee co-signature on signing request .* by trustee.officer.two has no matching audit entry/)]);
  });
});

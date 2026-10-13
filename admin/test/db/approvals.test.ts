import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditActions, cast, createWorld, verify, type Actor, type Cast, type World } from "../support/world";

/**
 * Step 6b database rules (migration 0016): the portal reaches backend decisions only through admin.*
 * functions that check session, permission and a fresh step-up; officer names are bound to officer
 * sessions; maker == checker is refused by the backend itself; signer tickets are single use and
 * bound to what the officer reviewed; everything is audited.
 */
let w: World;
let c: Cast;
let counter = Date.now();
const sha = (s: string): Buffer => createHash("sha256").update(s, "utf8").digest();
const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;

beforeAll(async () => {
  w = await createWorld();
  c = await cast(w);
});
afterAll(async () => {
  await w.drop();
});

async function code(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return (e as { code?: string }).code;
  }
}

async function freshStepUp(a: Actor): Promise<void> {
  await w.portal.query("SELECT admin.record_step_up($1, $2, $3)", [a.sessionHash, a.credentialId, ++counter]);
}

async function staleStepUp(a: Actor): Promise<void> {
  await w.su.query("ALTER TABLE admin.sessions DISABLE TRIGGER sessions_guard");
  await w.su.query("UPDATE admin.sessions SET step_up_at = step_up_at - interval '5 minutes 1 second' WHERE token_hash = $1", [a.sessionHash]);
  await w.su.query("ALTER TABLE admin.sessions ENABLE TRIGGER sessions_guard");
}

/** A failed reconciliation run: payouts frozen (recon.complete_run with a blocking finding). */
async function freeze(): Promise<string> {
  const { rows } = await w.su.query<{ id: string }>("SELECT recon.start_run('test', NULL, '{}') AS id");
  await w.su.query(`SELECT recon.complete_run($1, 'test', 0, '[{"check":"cash.closing_mismatch","severity":"blocking","subject":"test"}]', '{}')`, [rows[0]?.id]);
  const e = await w.su.query<{ id: string }>("SELECT id FROM recon.gate_events ORDER BY id DESC LIMIT 1");
  return e.rows[0]?.id ?? "";
}

/** A signing request waiting for two approvals, inserted as the signing service would. */
async function signingRequest(requestedBy = "outbox-worker"): Promise<{ id: string; payloadHash: string }> {
  await w.su.query("INSERT INTO signer.keys (key_ref, address, purpose) VALUES ('issuance', $1, 'test') ON CONFLICT DO NOTHING", [A(0xabc)]);
  const policy = await w.su.query<{ id: string }>("SELECT id FROM signer.policies WHERE kind = 'issuance.mint' AND retired_at IS NULL AND approved_at IS NOT NULL");
  let policyId = policy.rows[0]?.id;
  if (!policyId) {
    const rule = { chainId: 586586, keyRef: "issuance", issuance: A(1), token: A(2), identityRegistry: A(3), maxPerCommand: "100000", maxPerDay: "300000", approvalAbove: "10000", approvals: 2 };
    const p = await w.su.query<{ id: string }>("SELECT signer.propose_policy('issuance.mint', $1::jsonb, 'maker') AS id", [JSON.stringify(rule)]);
    await w.su.query("SELECT signer.approve_policy($1, 'checker')", [p.rows[0]?.id]);
    policyId = p.rows[0]?.id;
  }
  const payload = { issuance: A(1), to: A(9), amount: "20000", refId: `0x${randomBytes(32).toString("hex")}` };
  const hash = sha(JSON.stringify(["issuance.mint", payload]));
  const { rows } = await w.su.query<{ id: string }>(
    `INSERT INTO signer.requests (command_ref, kind, key_ref, payload, payload_hash, policy_id, amount, requested_by, status, approvals_needed)
     VALUES ($1, 'issuance.mint', 'issuance', $2::jsonb, $3, $4, 20000, $5, 'pending_approval', 2) RETURNING id`,
    [`cmd:${randomBytes(8).toString("hex")}`, JSON.stringify(payload), hash, policyId, requestedBy],
  );
  return { id: rows[0]?.id ?? "", payloadHash: hash.toString("hex") };
}

const ticket = (a: Actor, requestId: string, payloadHash: string, tok: string, decision = "approve") =>
  w.portal.query<{ r: { ok: boolean; error?: string } }>("SELECT admin.issue_signer_ticket($1, $2, $3, 'checked against the order', $4, $5, $6) AS r", [
    a.sessionHash,
    requestId,
    decision,
    Buffer.from(payloadHash, "hex"),
    Buffer.alloc(32, 7),
    sha(tok),
  ]);

describe("the portal never decides by itself", () => {
  it("its database role cannot call any backend decision function, redeem tickets or bind names", async () => {
    const calls = [
      "SELECT signer.decide(gen_random_uuid(), 'x.y', 'approve', 'portal trying directly')",
      `SELECT signer.decide_officer('\\x${"00".repeat(32)}', gen_random_uuid(), 'approve', 'portal trying directly', '\\x${"00".repeat(32)}')`,
      "SELECT recon.decide_unfreeze(1, 'x.y', 'approve', 'portal trying directly')",
      "SELECT recon.request_unfreeze('x.y', 'portal trying directly')",
      "SELECT bank.decide_payout_batch(1, 'x.y', 'approve', 'portal trying directly')",
      "SELECT property.decide_request(1, 'x.y', true, 'portal trying directly')",
      `SELECT admin.redeem_signer_ticket('\\x${"00".repeat(32)}', gen_random_uuid(), 'approve', 'portal trying directly', '\\x${"00".repeat(32)}')`,
      "SELECT admin.bind_officer('ops.checker')",
      "INSERT INTO admin.decision_context (txid, handle) VALUES (txid_current(), 'ops.checker')",
      "SELECT * FROM admin.signer_tickets",
    ];
    for (const sql of calls) expect(await code(w.portal.query(sql)), sql).toBe("42501");
  });
});

describe("step-up (fresh security-key assertion) for every decision", () => {
  it("refuses each decision with PTS01 when the last assertion is older than five minutes", async () => {
    const r = await signingRequest();
    await staleStepUp(c.ops_checker);
    await staleStepUp(c.compliance_officer);
    const tok = randomBytes(32).toString("base64url");
    expect(await code(ticket(c.ops_checker, r.id, r.payloadHash, tok))).toBe("PTS01");
    expect(await code(w.portal.query("SELECT admin.decide_unfreeze($1, 1, 'approve', 'stale step-up probe', 1)", [c.ops_checker.sessionHash]))).toBe("PTS01");
    expect(await code(w.portal.query(`SELECT admin.decide_payout_batch($1, 1, 'approve', 'stale step-up probe', '\\x${"00".repeat(32)}')`, [c.ops_checker.sessionHash]))).toBe("PTS01");
    expect(
      await code(w.portal.query(`SELECT admin.decide_property_request($1, 1, 'approve', 'stale step-up probe', '\\x${"00".repeat(32)}')`, [c.compliance_officer.sessionHash])),
    ).toBe("PTS01");
    await freshStepUp(c.ops_checker);
    await freshStepUp(c.compliance_officer);
    expect((await ticket(c.ops_checker, r.id, r.payloadHash, tok)).rows[0]?.r.ok).toBe(true);
  });
});

describe("maker-checker is enforced by the backend, end to end", () => {
  it("an unfreeze requested under the checker's own name is refused when that checker decides", async () => {
    const event = await freeze();
    // As if the officer had asked through the portal (binding in the same transaction).
    await w.su.query("BEGIN");
    await w.su.query("INSERT INTO admin.decision_context (txid, handle) VALUES (txid_current(), $1)", [c.ops_checker.handle]);
    const { rows } = await w.su.query<{ id: string }>("SELECT recon.request_unfreeze($1, 'difference explained by a late bank file') AS id", [c.ops_checker.handle]);
    await w.su.query("DELETE FROM admin.decision_context");
    await w.su.query("COMMIT");
    await freshStepUp(c.ops_checker);
    const r = await w.portal.query<{ r: { ok: boolean; error?: string } }>("SELECT admin.decide_unfreeze($1, $2, 'approve', 'approving my own request', $3) AS r", [
      c.ops_checker.sessionHash,
      rows[0]?.id,
      event,
    ]);
    expect(r.rows[0]?.r).toMatchObject({ ok: false, error: expect.stringMatching(/maker-checker/) as unknown });
    const detail = await w.portal.query<{ d: { blockers: string[] } }>("SELECT admin.unfreeze_request($1, $2) AS d", [c.ops_checker.sessionHash, rows[0]?.id]);
    expect(detail.rows[0]?.d.blockers.join(" ")).toMatch(/You requested it/);
  });

  it("a signing request asked for under the officer's name cannot be approved by that officer", async () => {
    const r = await signingRequest(c.ops_checker.handle);
    await freshStepUp(c.ops_checker);
    const out = await ticket(c.ops_checker, r.id, r.payloadHash, randomBytes(32).toString("base64url"));
    expect(out.rows[0]?.r).toMatchObject({ ok: false, error: expect.stringMatching(/You requested it/) as unknown });
  });

  it("officer names are bound to officer sessions: the command line cannot use them", async () => {
    await freeze();
    expect(await code(w.su.query("SELECT recon.request_unfreeze($1, 'pretending to be the maker officer')", [c.ops_maker.handle]))).toBe("42501");
    const r = await signingRequest();
    expect(await code(w.su.query("SELECT signer.decide($1, $2, 'approve', 'pretending to be the checker')", [r.id, c.ops_checker.handle]))).toBe("42501");
    // An ordinary command-line operator name still works.
    expect((await w.su.query<{ s: string }>("SELECT signer.decide($1, 'ops-ana', 'approve', 'command line operator') AS s", [r.id])).rows[0]?.s).toBe("pending_approval");
  });
});

describe("signer decision tickets", () => {
  it("are single use, short-lived, bound to request, decision, reason and call, and need the officer's live session", async () => {
    const r = await signingRequest();
    await freshStepUp(c.ops_checker);
    const tok = randomBytes(32).toString("base64url");
    expect((await ticket(c.ops_checker, r.id, r.payloadHash, tok)).rows[0]?.r.ok).toBe(true);
    const call = Buffer.alloc(32, 7);
    const redeem = (over: { request?: string; decision?: string; reason?: string; call?: Buffer; token?: string } = {}) =>
      code(
        w.su.query("SELECT signer.decide_officer($1, $2, $3, $4, $5)", [
          sha(over.token ?? tok),
          over.request ?? r.id,
          over.decision ?? "approve",
          over.reason ?? "checked against the order",
          over.call ?? call,
        ]),
      );
    expect(await redeem({ decision: "reject" })).toBe("42501");
    expect(await redeem({ reason: "a different reason given later" })).toBe("42501");
    expect(await redeem({ call: Buffer.alloc(32, 8) })).toBe("42501");
    expect(await redeem({ token: randomBytes(32).toString("base64url") })).toBe("42501");
    const other = await signingRequest();
    expect(await redeem({ request: other.id })).toBe("42501");
    // Expired (older than two minutes).
    await w.su.query("ALTER TABLE admin.signer_tickets DISABLE TRIGGER signer_tickets_guard");
    await w.su.query("UPDATE admin.signer_tickets SET created_at = created_at - interval '2 minutes 1 second', expires_at = expires_at - interval '2 minutes 1 second' WHERE token_hash = $1", [sha(tok)]);
    await w.su.query("ALTER TABLE admin.signer_tickets ENABLE TRIGGER signer_tickets_guard");
    expect(await redeem()).toBe("42501");

    // A valid ticket is used once; then the approval stands under the officer's handle.
    const tok2 = randomBytes(32).toString("base64url");
    expect((await ticket(c.ops_checker, r.id, r.payloadHash, tok2)).rows[0]?.r.ok).toBe(true);
    const ok = await w.su.query<{ s: string }>("SELECT signer.decide_officer($1, $2, 'approve', 'checked against the order', $3) AS s", [sha(tok2), r.id, call]);
    expect(ok.rows[0]?.s).toBe("pending_approval");
    expect(await redeem({ token: tok2 })).toBe("42501");
    const approvals = await w.su.query<{ operator: string }>("SELECT operator FROM signer.approvals WHERE request_id = $1", [r.id]);
    expect(approvals.rows.map((x) => x.operator)).toEqual([c.ops_checker.handle]);
    // Nothing is left bound after the decision.
    expect((await w.su.query("SELECT * FROM admin.decision_context")).rows).toEqual([]);
    // Tickets cannot be edited or deleted.
    expect(await code(w.su.query("DELETE FROM admin.signer_tickets"))).toBe("42501");
    expect(await code(w.su.query("UPDATE admin.signer_tickets SET used_at = NULL"))).toBe("23514");
  });

  it("are refused after the officer's session ended (step-up cannot outlive the session)", async () => {
    const r = await signingRequest();
    await freshStepUp(c.ops_checker);
    const tok = randomBytes(32).toString("base64url");
    expect((await ticket(c.ops_checker, r.id, r.payloadHash, tok)).rows[0]?.r.ok).toBe(true);
    await w.portal.query("SELECT admin.end_session($1, 'logout')", [c.ops_checker.sessionHash]);
    expect(await code(w.su.query("SELECT signer.decide_officer($1, $2, 'approve', 'checked against the order', $3)", [sha(tok), r.id, Buffer.alloc(32, 7)]))).toBe("42501");
  });
});

describe("audit", () => {
  it("records tickets, decisions and refusals, and the chain (with the new role matrix) verifies", async () => {
    const actions = (await auditActions(w)).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["approval.ticket", "approval.decided", "approval.refused"]));
    expect(await verify(w)).toEqual([]);
  });
});

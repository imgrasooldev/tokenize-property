import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accept, investor, liveOffering, makeWorld, OF, pay, reserve, submittedOffering, type World } from "./world.ts";

/** Database rules on their own: transitions, append-only records, roles, audit tamper detection. */

let w: World;
beforeAll(async () => {
  w = await makeWorld();
}, 120_000);
afterAll(async () => {
  await w.drop();
}, 120_000);

describe("state machines in the database", () => {
  it("lists exactly the S-02 transitions and refuses any other, whoever writes the event", async () => {
    const { rows } = await w.client.query<{ entity: string; n: string }>("SELECT entity, count(DISTINCT code)::text AS n FROM offering.transitions GROUP BY entity ORDER BY entity");
    expect(rows).toEqual([
      { entity: "offering", n: "18" },
      { entity: "subscription", n: "22" },
    ]);
    const o = await submittedOffering(w);
    // Skipping approval (pending_approval -> live) is refused even for the administrator.
    await expect(
      w.client.query("INSERT INTO offering.offering_events (offering_id, code, from_state, to_state, actor) VALUES ($1, 'L5', 'pending_approval', 'live', 'dba')", [o.id]),
    ).rejects.toThrow(/not allowed/);
    // A listed transition that does not start from the current state is refused too.
    await expect(
      w.client.query("INSERT INTO offering.offering_events (offering_id, code, from_state, to_state, actor) VALUES ($1, 'L4', 'approved', 'ready', 'dba')", [o.id]),
    ).rejects.toThrow(/not allowed/);
    // Records are append-only.
    await expect(w.client.query("DELETE FROM offering.offering_events WHERE offering_id = $1", [o.id])).rejects.toThrow(/append-only/);
    await expect(w.client.query("UPDATE offering.audit SET actor = 'x'")).rejects.toThrow(/append-only/);
    await expect(w.client.query("TRUNCATE offering.audit")).rejects.toThrow(/append-only/);
    await expect(w.client.query("UPDATE offering.settings SET value = 0")).rejects.toThrow(/append-only/);
  });

  it("subscriptions: payment facts are set once and the state follows the event log", async () => {
    const o = await liveOffering(w, { cap: 100n, maxUnits: 50n });
    const inv = await investor(w, o.d);
    await accept(w, o.id, inv, o.docs);
    const r = await reserve(w, o.id, inv, 10n);
    await pay(w, inv, r.paymentCode, BigInt(r.amountPaisa));
    await expect(w.client.query("UPDATE offering.subscriptions SET units = 11 WHERE id = $1", [r.subscriptionId])).rejects.toThrow(/never changes/);
    await expect(w.client.query("UPDATE offering.subscriptions SET raast_ref = NULL, paid_journal = NULL, paid_at = NULL WHERE id = $1", [r.subscriptionId])).rejects.toThrow(/set once/);
    await expect(w.client.query("UPDATE offering.subscriptions SET state = 'refunded' WHERE id = $1", [r.subscriptionId])).rejects.toThrow(/event log/);
    await expect(
      w.client.query("INSERT INTO offering.subscription_events (subscription_id, code, from_state, to_state, actor) VALUES ($1, 'V14', 'payment_confirmed', 'tokens_issued', 'dba')", [r.subscriptionId]),
    ).rejects.toThrow(/not allowed/);
  }, 120_000);

  it("verify_audit finds a forged audit entry and a row written around the API", async () => {
    expect((await w.client.query("SELECT * FROM offering.verify_audit()")).rows).toEqual([]);
    const o = await submittedOffering(w);
    await w.client.query("ALTER TABLE offering.audit DISABLE TRIGGER USER");
    try {
      await w.client.query("UPDATE offering.audit SET detail = detail || '{\"forged\": true}'::jsonb WHERE id = (SELECT max(id) FROM offering.audit)");
    } finally {
      await w.client.query("ALTER TABLE offering.audit ENABLE TRIGGER USER");
    }
    await w.client.query("INSERT INTO offering.acceptances (offering_id, subject_id, kind, language, doc_sha, session_hash, device_hash, actor) SELECT $1, id, 'risk_disclosure', 'en', $2, $2, $2, 'dba' FROM kyc.subjects LIMIT 1", [
      o.id,
      Buffer.alloc(32, 1),
    ]);
    const problems = (await w.client.query<{ problem: string }>("SELECT problem FROM offering.verify_audit()")).rows.map((r) => r.problem);
    expect(problems).toEqual(expect.arrayContaining(["content does not match its hash", expect.stringMatching(/^acceptance \d+ has no matching audit entry/)]));
  }, 120_000);
});

describe("least privilege (OFR-9)", () => {
  it("service, officer, admin, reader and signer roles reach only their functions; nobody writes tables", async () => {
    const o = await submittedOffering(w);
    const tryAs = async (role: string, sql: string, params: unknown[] = []): Promise<string> => {
      const c = await w.pool.connect();
      try {
        await c.query("BEGIN");
        await c.query(`SET LOCAL ROLE ${role}`);
      } catch (e) {
        throw new Error(`cannot become ${role}: ${(e as Error).message}`, { cause: e });
      }
      try {
        await c.query(sql, params);
        return "ok";
      } catch (e) {
        return (e as { code?: string }).code === "42501" && /permission denied/.test((e as Error).message) ? "denied" : `refused:${(e as { code?: string }).code ?? "?"}`;
      } finally {
        await c.query("ROLLBACK").catch(() => undefined);
        c.release();
      }
    };
    for (const role of ["pt_offering_service", "pt_offering_officer", "pt_offering_admin", "pt_offering_reader", "pt_signer"]) {
      expect(await tryAs(role, "INSERT INTO offering.audit (at, actor, action, detail, prev_hash, hash) VALUES (now(), 'x', 'x.x', '{}', '\\x00', '\\x00')")).toBe("denied");
      expect(await tryAs(role, "UPDATE offering.offerings SET state = 'live'")).toBe("denied");
    }
    // The investor-facing service cannot decide or create offerings; the officer cannot reserve.
    expect(await tryAs("pt_offering_service", "SELECT offering.decide(1, 'x', true, 'approve something')")).toBe("denied");
    expect(await tryAs("pt_offering_service", "SELECT offering.create_offering($1, 'x', NULL, '{}')", [o.propertyId])).toBe("denied");
    expect(await tryAs("pt_offering_officer", "SELECT offering.reserve($1, gen_random_uuid(), $2, gen_random_uuid(), 10, 'retail', 'idem-00000001', 'x')", [o.id, `0x${"a".repeat(64)}`])).toBe("denied");
    expect(await tryAs("pt_offering_officer", "SELECT offering.request_duty('a-1', 'trustee', 'b-1', 'grant myself a duty')")).toBe("denied");
    // Bank internals are not reachable directly.
    expect(await tryAs("pt_offering_service", "SELECT bank.refund_credit('RAAST-1', 'x', 'refund outside the offering flow')")).toBe("denied");
    expect(await tryAs("pt_bank_service", "SELECT bank.refund_credit('RAAST-1', 'x', 'refund outside the offering flow')")).toBe("denied");
    // The signing service may ask whether a mint is allowed, and nothing else.
    expect(await tryAs("pt_signer", "SELECT offering.mint_allowed($1, $2, 10)", [`0x${"a".repeat(64)}`, `0x${"b".repeat(40)}`])).toBe("ok");
    expect(await tryAs("pt_signer", "SELECT offering.start_minting($1, 'signer')", [o.id])).toBe("denied");
    // Readers see the overview, never the internal subscription reasons.
    expect(await tryAs("pt_offering_reader", "SELECT * FROM offering.overview")).toBe("ok");
    expect(await tryAs("pt_offering_reader", "SELECT reason FROM offering.subscriptions")).toBe("denied");
    expect(await tryAs("pt_recon_reader", "SELECT * FROM offering.recon_subscriptions")).toBe("ok");
    // Within its own role a legitimate call works (checks still apply inside).
    expect(await tryAs("pt_offering_officer", "SELECT offering.decide($1, $2, true, 'terms checked by the checker')", [o.l3.toString(), OF.checker])).toBe("ok");
  }, 120_000);
});

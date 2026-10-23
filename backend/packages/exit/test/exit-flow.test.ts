import pg from "pg";
import type { Hex } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkExit, checkIssuance } from "../../recon/src/checks.ts";
import { loadData } from "../../recon/src/load.ts";
import { ExitService } from "../src/service.ts";
import { redemptionRefId } from "../src/refid.ts";
import { balance } from "../../tax/test/world.ts";
import {
  burned,
  caseJson,
  chainDistribution,
  createWorld,
  decide,
  decision,
  escrowStatement,
  exitToken,
  investor,
  openGate,
  payee,
  ref,
  refresh,
  request,
  sha,
  type Investor,
  type World,
} from "./world.ts";

/**
 * S-05 end to end in the database (migration 0027), the way PT Control and the exit service drive it:
 * committee, vote, trustee, buyer, proceeds from the trustee escrow statement, waterfall (maker,
 * checker, trustee), record date, final distribution (statement, trustee pre-check, approval), the
 * on-chain publish/finalize seen by the tick, the redemption batch (maker, checker, trustee) that
 * books the final distribution and enqueues burns only for paid lines (burn rule after_payment), a
 * held line released by checker + trustee, burns seen (supply 0), payout recorded, waterfall paid and
 * the closure. Money and units are checked at every step.
 */
let w: World;
let A: Investor;
let B: Investor;
let C: Investor;
let t: Awaited<ReturnType<typeof exitToken>>;
let caseId = 0;
let finalId = "";
let redemptionId = 0;
const svc = (): ExitService => new ExitService(w.pool);

const SALE = 1_000_000_000n; // PKR 10,000,000
const DEPOSIT = 100_000_000n;

beforeAll(async () => {
  w = await createWorld();
  A = await investor(w);
  B = await investor(w);
  C = await investor(w);
  t = await exitToken(w, [{ inv: A, units: 600n }, { inv: B, units: 300n }, { inv: C, units: 100n }]);
  await w.su.query("UPDATE ops.settings SET value = 'true' WHERE key = 'allow_placeholder_rates'");
  await w.su.query("UPDATE exit.settings SET value = '0' WHERE key IN ('vote_notice_days', 'record_notice_days')");
  await openGate(w);
}, 240_000);

afterAll(async () => {
  await w.drop();
}, 240_000);

describe("S-05 exit end to end", () => {
  it("opens a case (maker) and takes the committee and vote decisions (X2, X5)", async () => {
    const o = await request(w, w.officers.maker, null, "open", {
      token: t.token, offerPaisa: SALE.toString(), valuationAPaisa: "990000000", valuationASha: sha("valuation A"),
      valuationBPaisa: "1010000000", valuationBSha: sha("valuation B"), costsPaisa: "30000000", voteRequired: true,
    }, "an offer above both independent valuations was received for the whole building");
    expect(o).toMatchObject({ ok: true, status: "proposed" });
    caseId = o.id ?? 0;
    // A second live case for the token is refused.
    const again = await request(w, w.officers.maker, null, "open", {
      token: t.token, offerPaisa: "1", valuationAPaisa: "1", valuationASha: sha("a2"), valuationBPaisa: "1", valuationBSha: sha("b2"), costsPaisa: "0", voteRequired: true,
    }, "a second proposal for the same building");
    expect(again.ok).toBe(false);
    // X3 is refused: the unit rights require a vote.
    const x3 = await request(w, w.officers.maker, caseId, "propose", { code: "X3", detail: { minutesSha: sha("minutes") } }, "committee minutes attached for the record");
    expect(x3.error).toMatch(/require an investor vote/);
    expect(await decision(w, caseId, "X2", { minutesSha: sha("minutes"), noticeSha: sha("notice"), voteRecordBlock: "10" }, [w.officers.checker, w.officers.compliance]))
      .toMatchObject({ ok: true, status: "approved" });
    expect((await caseJson(w, w.officers.checker, caseId)).state).toBe("vote_open");
    // A failing count cannot be recorded as a pass.
    const bad = await request(w, w.officers.maker, caseId, "propose", {
      code: "X5", detail: { eligibleUnits: "1000", votesFor: "300", votesAgainst: "400", votesAbstain: "0", ballotsSha: sha("ballots"), lowerPriceApproved: false },
    }, "scrutineer result attached for the record");
    expect(bad.error).toMatch(/quorum and majority/);
    expect(await decision(w, caseId, "X5", { eligibleUnits: "1000", votesFor: "700", votesAgainst: "100", votesAbstain: "0", ballotsSha: sha("ballots"), lowerPriceApproved: false },
      [w.officers.checker, w.officers.trustee])).toMatchObject({ ok: true, status: "approved" });
    expect((await caseJson(w, w.officers.checker, caseId)).state).toBe("trustee_review");
  });

  it("trustee approves (X7), buyer clears and signs (X9)", async () => {
    await refresh(w);
    expect(await decision(w, caseId, "X7", { legalAdviceSha: sha("legal advice"), conflictsCleared: true }, [w.officers.legal, w.officers.trustee])).toMatchObject({ ok: true });
    expect(await decision(w, caseId, "X9", {
      buyerRef: "KYB-BUYER-001", buyerChecksSha: sha("buyer checks"), agreementSha: sha("agreement"), salePricePaisa: SALE.toString(),
      depositPaisa: DEPOSIT.toString(), cpDeadline: "2099-12-31",
    }, [w.officers.compliance, w.officers.legal, w.officers.trustee])).toMatchObject({ ok: true });
    const c = await caseJson(w, w.officers.checker, caseId);
    expect(c.state).toBe("contracted");
    expect(c.facts.salePricePaisa).toBe(SALE.toString());
  });

  it("books deposit and proceeds from the trustee escrow statement (maker-checker) and completes (X11, X12)", async () => {
    await refresh(w);
    const st = await escrowStatement(w, [{ amount: DEPOSIT, reference: ref("DEP") }, { amount: SALE - DEPOSIT, reference: ref("PRC") }]);
    const d = await request(w, w.officers.maker, caseId, "proceeds", { kind: "deposit", statementId: st.toString(), lineNo: 1 }, "buyer deposit per the agreement");
    const p = await request(w, w.officers.maker, caseId, "proceeds", { kind: "proceeds", statementId: st.toString(), lineNo: 2 }, "balance of the sale price");
    expect(d.ok && p.ok).toBe(true);
    // X11 is refused while proceeds are still pending.
    const early = await request(w, w.officers.maker, caseId, "propose", { code: "X11", detail: { deedSha: sha("deed") } }, "deed registered at the sub-registrar");
    expect(early.error).toMatch(/pending proceeds/);
    // The maker cannot approve his own record (the portal role says so too); the checker approves.
    let c = await caseJson(w, w.officers.checker, caseId);
    for (const r of c.proceeds as { id: number; digest: string }[]) {
      expect(await decide(w, w.officers.checker, "proceeds", r.id, "approve", r.digest)).toMatchObject({ ok: true, status: "approved" });
    }
    expect(await balance(w, `exit:pool:${t.token}`)).toBe(-SALE);
    expect(await decision(w, caseId, "X11", { deedSha: sha("deed") }, [w.officers.legal])).toMatchObject({ ok: true });
    expect(await decision(w, caseId, "X12", {}, [w.officers.checker])).toMatchObject({ ok: true });
    c = await caseJson(w, w.officers.checker, caseId);
    expect(c.state).toBe("waterfall");
    expect(c.proceedsApproved).toBe(SALE.toString());
  });

  it("waterfall: maker drafts, checker checks, trustee approves; the journals post together", async () => {
    await refresh(w);
    const lines: [string, string | null, bigint][] = [
      ["secured_debt", "bank-alfalah", 200_000_000n],
      ["transaction_cost", "broker-one", 20_000_000n],
      ["sale_tax", null, 10_000_000n],
      ["closure_reserve", null, 5_000_000n],
    ];
    for (const [kind, payee, amount] of lines) {
      const r = await request(w, w.officers.maker, caseId, "line", { kind, payee, amountPaisa: amount.toString(), evidenceSha: sha(kind) }, `${kind} per the evidence`);
      expect(r).toMatchObject({ ok: true });
    }
    // A line that would pay out more than the pool holds blocks the submission.
    const huge = await request(w, w.officers.maker, caseId, "line", { kind: "payable", payee: "vendor-x", amountPaisa: "999000000000", evidenceSha: sha("huge") }, "an impossible payable");
    expect(await request(w, w.officers.maker, caseId, "submit_waterfall", {}, "waterfall ready for the checker")).toMatchObject({ ok: false });
    expect(await request(w, w.officers.maker, caseId, "withdraw_line", { lineId: huge.id }, "withdrawn: entered by mistake")).toMatchObject({ ok: true });
    expect(await request(w, w.officers.maker, caseId, "submit_waterfall", {}, "waterfall ready for the checker")).toMatchObject({ ok: true, status: "submitted" });
    let c = await caseJson(w, w.officers.checker, caseId);
    // The trustee cannot approve before the operations check.
    expect((await decide(w, w.officers.trustee, "waterfall", c.waterfall.id, "approve", c.waterfall.digest)).error).toMatch(/operations checker checks/);
    expect(await decide(w, w.officers.checker, "waterfall", c.waterfall.id, "approve", c.waterfall.digest)).toMatchObject({ ok: true, status: "checked" });
    c = await caseJson(w, w.officers.trustee, caseId);
    expect(await decide(w, w.officers.trustee, "waterfall", c.waterfall.id, "approve", c.waterfall.digest)).toMatchObject({ ok: true, status: "approved" });
    expect(await balance(w, `exit:pool:${t.token}`)).toBe(-(SALE - 235_000_000n));
    expect(await balance(w, "debt:payable:bank-alfalah")).toBe(-200_000_000n);
    expect(await balance(w, `reserve:${t.token}:closure`)).toBe(-5_000_000n);
  });

  it("final distribution: record date, calculation, statement, trustee pre-check, approval", async () => {
    await refresh(w);
    const today = (await w.pool.query<{ d: string }>("SELECT exit.pkt_today()::text AS d")).rows[0]?.d ?? "";
    expect(await request(w, w.officers.maker, caseId, "announce", { recordDate: today, noticeSha: sha("record notice") }, "final record date announced")).toMatchObject({ ok: true });
    finalId = await svc().calculate(String(caseId), 10n, "operator:ali");
    const lines = await svc().lines(finalId);
    expect(lines.map((l) => [l.wallet, l.units])).toEqual(
      [[A.wallet, "600"], [B.wallet, "300"], [C.wallet, "100"]].sort((x, y) => (String(x[0]) < String(y[0]) ? -1 : 1)),
    );
    const gross = lines.reduce((s, l) => s + l.gross, 0n);
    expect(gross).toBe(SALE - 235_000_000n);
    for (const l of lines) expect(l.gross).toBe(l.net + l.wht);
    const docs = await svc().attach(finalId, "operator:omar");
    expect(await svc().verify(finalId)).toEqual([]);
    let c = await caseJson(w, w.officers.trustee, caseId);
    // The checker cannot approve before the trustee's pre-check.
    expect((await decide(w, w.officers.checker, "final", Number(finalId), "approve", c.final.digest)).error).toMatch(/pre-check/);
    expect((await decide(w, w.officers.trustee, "precheck", Number(finalId), "approve", c.final.digest, { root: `0x${"12".repeat(32)}` })).error).toMatch(/root differs/);
    expect(await decide(w, w.officers.trustee, "precheck", Number(finalId), "approve", c.final.digest, { root: docs.root })).toMatchObject({ ok: true });
    c = await caseJson(w, w.officers.checker, caseId);
    expect(await decide(w, w.officers.checker, "final", Number(finalId), "approve", c.final.digest)).toMatchObject({ ok: true, status: "approved" });
  });

  it("publish and finalize on chain are followed by the tick (X13, X15)", async () => {
    const f = (await w.pool.query<{ root: string; net: string; hash: string }>("SELECT merkle_root AS root, sum_net::text AS net, statement_hash AS hash FROM exit.finals WHERE id = $1", [finalId])).rows[0];
    await chainDistribution(w, t, 7, { recordBlock: 10, root: f?.root ?? "", total: BigInt(f?.net ?? "0"), statementHash: f?.hash ?? "", status: "published" });
    expect(await svc().tick("exit-worker")).toBeGreaterThan(0);
    expect((await caseJson(w, w.officers.checker, caseId)).state).toBe("final_published");
    await chainDistribution(w, t, 7, { recordBlock: 10, root: f?.root ?? "", total: BigInt(f?.net ?? "0"), statementHash: f?.hash ?? "", status: "finalized" });
    await svc().tick("exit-worker");
    expect((await caseJson(w, w.officers.checker, caseId)).state).toBe("final_finalized");
  });

  it("redemption batch: refIds, checker, trustee; booking and Redeeming in one step; no burn before payment", async () => {
    await refresh(w);
    redemptionId = Number(await svc().createRedemption(String(caseId), "operator:ali"));
    const items = (await w.pool.query<{ wallet: string; units: string; ref_id: string }>("SELECT wallet, units::text, ref_id FROM exit.redemption_lines WHERE redemption_id = $1", [redemptionId])).rows;
    for (const i of items) expect(i.ref_id).toBe(redemptionRefId(t.token, 7n, i.wallet));
    let c = await caseJson(w, w.officers.checker, caseId);
    expect(c.redemption.burnRule).toBe("after_payment");
    expect(await decide(w, w.officers.checker, "redemption", redemptionId, "approve", c.redemption.digest)).toMatchObject({ ok: true, status: "checked" });
    c = await caseJson(w, w.officers.trustee, caseId);
    expect(await decide(w, w.officers.trustee, "redemption", redemptionId, "approve", c.redemption.digest)).toMatchObject({ ok: true, status: "approved" });
    c = await caseJson(w, w.officers.checker, caseId);
    expect(c.state).toBe("redeeming");
    expect(c.final.status).toBe("booked");
    // The final distribution is booked from the exit pool (rent: family, S-05 Q-3): only the closure reserve stays out of it.
    expect(await balance(w, `exit:pool:${t.token}`)).toBe(0n);
    const j = await w.pool.query("SELECT 1 FROM ledger.journal WHERE idempotency_key = $1", [`rent:distribution:${t.token}:7`]);
    expect(j.rowCount).toBe(1);
    // after_payment: nothing is paid yet, so nothing is enqueued.
    expect((await w.pool.query("SELECT 1 FROM outbox.commands WHERE kind = 'issuance.burn'")).rowCount).toBe(0);
  });

  it("paid lines become burnable; the held line waits for a checker + trustee release", async () => {
    await refresh(w);
    await payee(w, A.subjectId);
    await payee(w, B.subjectId);
    const lines = (await w.pool.query<{ subject_id: string; net: string }>("SELECT subject_id::text, net::text FROM exit.final_lines WHERE final_id = $1 ORDER BY wallet", [finalId])).rows;
    const items = lines.map((l) => ({ subject: l.subject_id, amountPaisa: l.net }));
    const { rows } = await w.su.query<{ id: string }>("SELECT bank.create_payout_batch('PTPAY-EXIT-7', $1, 7, $2::jsonb, 'bank:maker') AS id", [t.token, JSON.stringify(items)]);
    const batch = rows[0]?.id;
    await w.su.query("SELECT bank.decide_payout_batch($1, 'bank:checker', 'approve', 'lines checked against the statement')", [batch]);
    await w.su.query("SELECT bank.submit_payout_batch($1, 'bank:sender', $2)", [batch, Buffer.alloc(32, 7)]);
    await svc().tick("exit-worker");
    const cmds = (await w.pool.query<{ payload: { from: string; amount: string; refId: string; issuance: string } }>(
      "SELECT payload FROM outbox.commands WHERE kind = 'issuance.burn' ORDER BY id")).rows.map((r) => r.payload);
    expect(cmds.map((p) => p.from).sort()).toEqual([A.wallet, B.wallet].sort());
    for (const p of cmds) expect(p.issuance).toBe(t.issuance);
    // The held line (C has no payout account): not enqueued; HR releases it.
    let c = await caseJson(w, w.officers.checker, caseId);
    const held = (c.redemption.items as { wallet: string; payment: string }[]).find((i) => i.wallet === C.wallet);
    expect(held?.payment).toBe("held");
    expect(await decision(w, caseId, "HR", { wallet: C.wallet }, [w.officers.checker, w.officers.trustee])).toMatchObject({ ok: true, status: "approved" });
    c = await caseJson(w, w.officers.checker, caseId);
    expect((c.redemption.items as { wallet: string; released: boolean }[]).find((i) => i.wallet === C.wallet)?.released).toBe(true);
    expect((await w.pool.query("SELECT 1 FROM outbox.commands WHERE kind = 'issuance.burn'")).rowCount).toBe(3);
  });

  it("burns seen and the payout recorded take the case to Paid Out (X17)", async () => {
    const lines = (await w.pool.query<{ wallet: string; units: string; ref_id: string }>("SELECT wallet, units::text, ref_id FROM exit.redemption_lines WHERE redemption_id = $1", [redemptionId])).rows;
    for (const l of lines) await burned(w, t, l.wallet, BigInt(l.units), l.ref_id, 20);
    await svc().tick("exit-worker");
    expect((await caseJson(w, w.officers.checker, caseId)).state).toBe("redeeming");
    const f = (await w.pool.query<{ root: string; net: string; hash: string }>("SELECT merkle_root AS root, sum_net::text AS net, statement_hash AS hash FROM exit.finals WHERE id = $1", [finalId])).rows[0];
    await chainDistribution(w, t, 7, { recordBlock: 10, root: f?.root ?? "", total: BigInt(f?.net ?? "0"), statementHash: f?.hash ?? "", status: "paid" });
    await svc().tick("exit-worker");
    const c = await caseJson(w, w.officers.checker, caseId);
    expect(c.state).toBe("paid_out");
    expect(c.chain.supply).toBe("0");
    expect(c.closeProblem).toMatch(/not paid yet/);
  });

  it("closes once every line, the waterfall and the closure reserve are paid and the cap is 0 (X18)", async () => {
    await refresh(w);
    // The held line is paid by a follow-up batch once C has an account.
    await payee(w, C.subjectId);
    const parent = (await w.su.query<{ id: string }>("SELECT id FROM bank.payout_batches WHERE reference = 'PTPAY-EXIT-7'")).rows[0]?.id;
    const fu = (await w.su.query<{ id: string }>("SELECT bank.create_followup_batch('PTPAY-EXIT-7-F1', $1, $2::jsonb, 'bank:maker') AS id", [parent, JSON.stringify([C.subjectId])])).rows[0]?.id;
    await w.su.query("SELECT bank.decide_payout_batch($1, 'bank:checker', 'approve', 'held line now payable to the investor')", [fu]);
    await w.su.query("SELECT bank.submit_payout_batch($1, 'bank:sender', $2)", [fu, Buffer.alloc(32, 8)]);
    // Waterfall lines are paid from escrow debits (maker-checker).
    let c = await caseJson(w, w.officers.checker, caseId);
    const out = (c.waterfall.lines as { id: number; kind: string; amount: string; withdrawn: boolean }[]).filter((l) => !l.withdrawn);
    const refs = out.map((l) => ({ l, reference: ref("PAY") }));
    const st = await escrowStatement(w, refs.map((r) => ({ amount: -BigInt(r.l.amount), reference: r.reference })));
    for (const [i, r] of refs.entries()) {
      expect(await request(w, w.officers.maker, caseId, "payment", { lineId: r.l.id, statementId: st.toString(), lineNo: i + 1 }, `paid ${r.l.kind}`)).toMatchObject({ ok: true });
    }
    c = await caseJson(w, w.officers.checker, caseId);
    for (const l of c.waterfall.lines as { payments: { id: number; digest: string; status: string }[] }[]) {
      for (const p of l.payments.filter((x) => x.status === "proposed")) {
        expect(await decide(w, w.officers.checker, "payment", p.id, "approve", p.digest)).toMatchObject({ ok: true });
      }
    }
    expect(await balance(w, `reserve:${t.token}:closure`)).toBe(0n);
    c = await caseJson(w, w.officers.checker, caseId);
    expect(c.closeProblem).toMatch(/trustee cap/);
    await w.su.query("UPDATE chain.tokens SET trustee_cap = 0 WHERE token = $1", [t.token]);
    expect(await decision(w, caseId, "X18", { finalAccountsSha: sha("final accounts"), windupSha: sha("wind-up") }, [w.officers.checker, w.officers.trustee]))
      .toMatchObject({ ok: true, status: "approved" });
    c = await caseJson(w, w.officers.checker, caseId);
    expect(c.state).toBe("closed");
    // Money: escrow paid out exactly what came in (proceeds - waterfall - WHT - net = 0 apart from WHT owed to FBR).
    const wht = BigInt((await w.pool.query<{ v: string }>("SELECT sum_wht::text AS v FROM exit.finals WHERE id = $1", [finalId])).rows[0]?.v ?? "0");
    expect(await balance(w, `tax:wht-payable:${t.token}`)).toBe(-wht);
    expect(await svc().verifyAudit()).toEqual([]);
    expect((await w.pool.query("SELECT * FROM ledger.verify_chain()")).rowCount).toBe(0);
    expect((await w.pool.query("SELECT * FROM exit.recon_lines WHERE payment NOT IN ('paid', 'nothing_to_pay')")).rowCount).toBe(0);
  });

  it("reconciliation loads the exit (as its reader role) and finds burns, supply, pool and register consistent", async () => {
    const reader = new pg.Pool({ ...w.settings, max: 2, options: "-c role=pt_recon_reader" });
    try {
      expect((await reader.query("SELECT count(*)::int AS n FROM exit.recon_lines")).rows[0]).toEqual({ n: 3 });
    } finally {
      await reader.end();
    }
    const holdings = async (): Promise<Map<string, bigint>> =>
      new Map((await w.pool.query<{ holder: string; balance: string }>("SELECT holder, balance::text FROM chain.holdings WHERE token = $1", [t.token])).rows.map((r) => [r.holder, BigInt(r.balance)]));
    const loaded = await loadData(w.pool, {
      deployment: { id: t.deployment, chainId: 586586, fromBlock: 0n, contracts: { token: t.token as Hex, issuance: t.issuance as Hex, distributions: t.registry as Hex } },
      chain: { head: () => Promise.resolve(100n), totalSupply: () => Promise.resolve(0n), balances: () => holdings() },
      slaMinutes: 60,
      verifyIndexer: null,
    });
    expect(loaded.data.exit?.lines).toHaveLength(3);
    const findings = [...checkExit(loaded.data), ...checkIssuance(loaded.data)].filter((x) => x.check.startsWith("exit.") || x.check.includes("burn"));
    expect(findings).toEqual([]);
  });
});

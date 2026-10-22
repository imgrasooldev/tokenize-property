import fc from "fast-check";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { officer } from "../../db/test/officers.ts";
import { splitDistribution } from "../src/arithmetic.ts";
import { OpsService } from "../src/service.ts";
import {
  address,
  allowPlaceholders,
  trusteeDecideCharge,
  trusteePrecheck,
  balance,
  bankLines,
  calculate,
  chainDistribution,
  charge,
  code,
  collect,
  createWorld,
  filerCheck,
  investor,
  message,
  proposeCharge,
  token,
  transfer,
  ZERO,
  type Investor,
  type TestToken,
  type World,
} from "./world.ts";

/**
 * Spec S-03 operations and FBR withholding against a real PostgreSQL (migration 0021): collections
 * from bank lines, charges with evidence, maker-checker, the operating statement of the worked
 * example, the calculation at the record block (largest remainder + WHT, compared with the
 * TypeScript arithmetic under random data), the statement and tax schedule checked line by line,
 * placeholder rates refused, booking against the finalized on-chain distribution, remittances,
 * certificates, tax reconciliation (and that it finds tampering), audit, officer binding, roles.
 */
let w: World;
let t: TestToken;
let alice: Investor;
let bob: Investor;
let carol: Investor;
const dave = address();
let today: string;
const PERIOD = "2026-09";
let calcId = "";
const RECORD_BLOCK = 10;

beforeAll(async () => {
  w = await createWorld();
  today = (await w.su.query<{ d: string }>("SELECT ops.pkt_today()::text AS d")).rows[0]?.d ?? "";
  t = await token(w);
  [alice, bob, carol] = [await investor(w, 1), await investor(w, 2), await investor(w, 3)];
  await filerCheck(w, alice.subjectId, "filer", "2026-09-01");
  await filerCheck(w, bob.subjectId, "non_filer", "2026-09-01");
  // The worked example's 1,000,000 units; Carol gets her 7 by a transfer; a later transfer must not count.
  await transfer(w, t, ZERO, alice.wallet, 100_000n, 5);
  await transfer(w, t, ZERO, bob.wallet, 2_500n, 5);
  await transfer(w, t, ZERO, dave, 897_500n, 6);
  await transfer(w, t, dave, carol.wallet, 7n, 8);
  await transfer(w, t, alice.wallet, dave, 50_000n, 20);
}, 240_000);

afterAll(async () => {
  await w.drop();
}, 240_000);

describe("collections from bank statement lines (OT-1)", () => {
  it("maker-checker; the journal credits the rent pool with the bank reference; a line is used once", async () => {
    const st = await bankLines(w, "2026-09-10", [
      { amount: 230_000_000n, reference: "RENTSEPT0001" },
      { amount: -5_000n, reference: "BANKCHARGE01" },
    ]);
    const { rows } = await w.ops.query<{ id: string }>("SELECT ops.propose_collection($1, $2, 1, 'September rent, tower A', 'operator:ali')::text AS id", [t.token, st]);
    const id = rows[0]?.id ?? "";
    expect(await message(w.ops.query("SELECT ops.decide_collection($1, 'operator:ali', 'approve', 'matches the tenant invoice')", [id]))).toMatch(/maker-checker/);
    await w.ops.query("SELECT ops.decide_collection($1, 'operator:sara', 'approve', 'matches the tenant invoice')", [id]);
    const j = await w.pool.query<{ external_ref: string; created_by: string }>("SELECT external_ref, created_by FROM ledger.journal WHERE idempotency_key = $1", [
      `rent:collected:${t.token}:${PERIOD}-c${id}`,
    ]);
    expect(j.rows[0]).toEqual({ external_ref: "RENTSEPT0001", created_by: "operator:sara" });
    expect(await balance(w, `rent:pool:${t.token}`)).toBe(-230_000_000n);
    expect(await code(w.ops.query("SELECT ops.propose_collection($1, $2, 1, 'the same line again', 'operator:ali')", [t.token, st]))).toBe("23505");
    expect(await message(w.ops.query("SELECT ops.propose_collection($1, $2, 2, 'a debit is not rent', 'operator:ali')", [t.token, st]))).toMatch(/incoming/);
  });

  it("a line already booked as something else is refused", async () => {
    const st = await bankLines(w, "2026-09-11", [{ amount: 1_000n, reference: "SUBSCRIPTION01" }]);
    const ledger = (await w.pool.query<{ l: string }>("SELECT b.ledger_account AS l FROM recon.bank_lines x JOIN recon.bank_accounts b ON b.account = x.account WHERE x.statement_id = $1", [st])).rows[0]?.l ?? "";
    await w.pool.query("SELECT ledger.open_account('test:elsewhere', 'liability', 'PKR')");
    await w.pool.query(
      `SELECT ledger.post_journal('test:elsewhere:1', 'test_booking', 'booked elsewhere', 'SUBSCRIPTION01', 'test', jsonb_build_array(
         jsonb_build_object('account', $1::text, 'amount', '1000'), jsonb_build_object('account', 'test:elsewhere', 'amount', '-1000')))`,
      [ledger],
    );
    expect(await message(w.ops.query("SELECT ops.propose_collection($1, $2, 1, 'is this rent?', 'operator:ali')", [t.token, st]))).toMatch(/already booked/);
  });
});

describe("charges with evidence, maker-checker, operating statement (OT-2, OT-3)", () => {
  it("reproduces the S-03 worked example: distributable gross Rs 1,752,300.00", async () => {
    await charge(w, t, PERIOD, "expense", 17_500_000n, { payee: "maintenance-co" });
    await charge(w, t, PERIOD, "fee", 11_500_000n, { feeType: "property_manager", payee: "pm-co" });
    await charge(w, t, PERIOD, "fee", 4_000_000n, { feeType: "trustee", payee: "trustee-co" });
    await charge(w, t, PERIOD, "fee", 2_300_000n, { feeType: "platform", payee: "platform" });
    await charge(w, t, PERIOD, "reserve_contribution", 19_470_000n);
    const { rows } = await w.ops.query<{ s: { totals: Record<string, unknown> } }>("SELECT ops.operating_statement($1, $2) AS s", [t.token, PERIOD]);
    expect(rows[0]?.s.totals).toMatchObject({
      collected: "230000000",
      expenses: "17500000",
      fees: { propertyManager: "11500000", trustee: "4000000", platform: "2300000", total: "17800000" },
      reserveContribution: "19470000",
      netOperatingCash: "194700000",
      distributableGross: "175230000",
      shortfall: "0",
      pending: 0,
    });
    expect(await balance(w, `reserve:${t.token}`)).toBe(-19_470_000n);
    expect(await balance(w, "vendor:payable:maintenance-co")).toBe(-17_500_000n);
  });

  it("refuses a second fee of a type, a self-approval, and an expense above the operations limit", async () => {
    expect(await code(proposeCharge(w, t, PERIOD, "fee", 1n, { feeType: "platform", payee: "platform" }))).toBe("23505");
    const big = await proposeCharge(w, t, PERIOD, "expense", 100_000_001n, { payee: "roof-co" });
    expect(await message(w.ops.query("SELECT ops.decide_charge($1, 'operator:ali', 'approve', 'roof replacement invoice')", [big]))).toMatch(/maker-checker/);
    expect(await message(w.ops.query("SELECT ops.decide_charge($1, 'operator:sara', 'approve', 'roof replacement invoice')", [big]))).toMatch(/trustee approves it first/);
    // Step 6d (OP-21): the trustee rejects it; the operations checker can then only reject it.
    expect(await trusteeDecideCharge(w, big, "reject")).toMatchObject({ ok: true, status: "rejected" });
    expect(await message(w.ops.query("SELECT ops.decide_charge($1, 'operator:sara', 'approve', 'roof replacement invoice')", [big]))).toMatch(/trustee rejected it/);
    // While it is pending the period cannot be calculated.
    expect(await message(calculate(w, t, PERIOD, today, RECORD_BLOCK))).toMatch(/pending/);
    await w.ops.query("SELECT ops.decide_charge($1, 'operator:sara', 'reject', 'goes to the trustee as capital expense')", [big]);
    expect(await code(w.ops.query("SELECT ops.propose_charge($1, $2, 'expense', NULL, 'x-co', 'no evidence', 100, NULL, 'operator:ali')", [t.token, PERIOD]))).toBe("23514");
  });
});

describe("calculation at the record block: largest remainder + withholding (OT-4)", () => {
  it("refuses a record date inside the period, an unindexed block and an income type without rates", async () => {
    expect(await message(calculate(w, t, PERIOD, "2026-09-30", RECORD_BLOCK))).toMatch(/record date/);
    expect(await message(calculate(w, t, PERIOD, today, 101))).toMatch(/indexed/);
    expect(await message(calculate(w, t, PERIOD, today, RECORD_BLOCK, "rent"))).toMatch(/no filer rate/);
  });

  it("splits by units at the record block; WHT by filer status; flags missing ATL results and wallets without KYC", async () => {
    calcId = await calculate(w, t, PERIOD, today, RECORD_BLOCK);
    const { rows } = await w.pool.query<{ wallet: string; units: string; gross: string; wht: string; net: string; filer_status: string; flagged: boolean; flag_reason: string | null; placeholder_rate: boolean }>(
      "SELECT wallet, units::text, gross::text, wht::text, net::text, filer_status, flagged, flag_reason, placeholder_rate FROM ops.distribution_lines WHERE distribution_id = $1 ORDER BY wallet",
      [calcId],
    );
    const rate = (wallet: string): number => (wallet === alice.wallet ? 150_000 : 300_000);
    const units = new Map([[alice.wallet, 100_000n], [bob.wallet, 2_500n], [carol.wallet, 7n], [dave, 897_493n]]);
    const expected = splitDistribution(175_230_000n, [...units].map(([wallet, u]) => ({ wallet, units: u, ratePpm: rate(wallet) })));
    expect(rows.map((r) => ({ wallet: r.wallet, units: BigInt(r.units), gross: BigInt(r.gross), wht: BigInt(r.wht), net: BigInt(r.net) }))).toEqual(expected);
    const by = new Map(rows.map((r) => [r.wallet, r]));
    expect(by.get(alice.wallet)).toMatchObject({ gross: "17523000", wht: "2628450", net: "14894550", filer_status: "filer", flagged: false });
    expect(by.get(bob.wallet)).toMatchObject({ gross: "438075", wht: "131423", filer_status: "non_filer", flagged: false });
    expect(by.get(carol.wallet)?.flag_reason).toMatch(/no ATL result/);
    expect(by.get(dave)?.flag_reason).toMatch(/no KYC subject/);
    expect(rows.every((r) => r.placeholder_rate)).toBe(true);
    const d = (await w.pool.query<{ sum_gross: string; sum_wht: string; sum_net: string; flagged_lines: number }>("SELECT sum_gross::text, sum_wht::text, sum_net::text, flagged_lines FROM ops.distributions WHERE id = $1", [calcId])).rows[0];
    expect(BigInt(d?.sum_wht ?? "0") + BigInt(d?.sum_net ?? "0")).toBe(175_230_000n);
    expect(d?.flagged_lines).toBe(2);
  });

  it("locks the period and allows one live calculation per period", async () => {
    expect(await message(proposeCharge(w, t, PERIOD, "expense", 5n, { payee: "late-co" }))).toMatch(/locked/);
    expect(await message(collect(w, t, "2026-09-20", 1_000n))).toMatch(/locked/);
    expect(await message(calculate(w, t, PERIOD, today, RECORD_BLOCK))).toMatch(/locked|already/);
  });

  it("the database refuses a line that breaks gross = net + WHT or the rounding rule, whoever writes it", async () => {
    await w.su.query("BEGIN");
    try {
      await w.su.query("ALTER TABLE ops.distribution_lines DISABLE TRIGGER distribution_lines_append_only");
      expect(await code(w.su.query("UPDATE ops.distribution_lines SET net = net + 1 WHERE distribution_id = $1 AND wallet = $2", [calcId, alice.wallet]))).toBe("23514");
    } finally {
      await w.su.query("ROLLBACK");
    }
    await w.su.query("BEGIN");
    try {
      await w.su.query("ALTER TABLE ops.distribution_lines DISABLE TRIGGER distribution_lines_append_only");
      expect(await code(w.su.query("UPDATE ops.distribution_lines SET wht = wht + 1, net = net - 1 WHERE distribution_id = $1 AND wallet = $2", [calcId, alice.wallet]))).toBe("23514");
    } finally {
      await w.su.query("ROLLBACK");
    }
  });
});

describe("statement and tax schedule, approval (OT-5, OT-6)", () => {
  it("a statement that differs from the calculation is refused", async () => {
    const ops = new OpsService(w.ops);
    const docs = await ops.documents(calcId);
    const forged = docs.statement.replace(/"netPaisa":"14894550"/, '"netPaisa":"14894551"');
    expect(forged).not.toBe(docs.statement);
    expect(await message(w.ops.query("SELECT ops.attach_statement($1, $2, $3, $4, $5, $6, 'operator:omar')", [calcId, docs.root, forged, docs.statementHash, docs.schedule, docs.scheduleHash]))).toMatch(/differs/);
    const forgedSchedule = docs.schedule.replace(/"ratePpm":"150000"/, '"ratePpm":"100000"');
    expect(await message(w.ops.query("SELECT ops.attach_statement($1, $2, $3, $4, $5, $6, 'operator:omar')", [calcId, docs.root, docs.statement, docs.statementHash, forgedSchedule, docs.scheduleHash]))).toMatch(/schedule/);
  });

  it("attached by the operations service; independent recomputation is clean; maker-checker and placeholder rates on approval", async () => {
    const ops = new OpsService(w.ops);
    await ops.attach(calcId, "operator:omar");
    expect(await ops.verify(calcId)).toEqual([]);
    const decide = (actor: string) => w.ops.query("SELECT ops.decide_distribution($1, $2, 'approve', 'recomputed from chain and statement')", [calcId, actor]);
    expect(await message(decide("operator:ali"))).toMatch(/maker-checker/);
    expect(await message(decide("operator:omar"))).toMatch(/maker-checker/);
    expect(await message(decide("operator:sara"))).toMatch(/PLACEHOLDER/);
    await allowPlaceholders(w, true);
    // Step 6d (D4): the trustee's pre-check (recomputed root) comes first.
    expect(await message(decide("operator:sara"))).toMatch(/not pre-checked/);
    expect(await trusteePrecheck(w, calcId)).toMatchObject({ ok: true, status: "approved" });
    await decide("operator:sara");
    const a = await w.pool.query<{ action: string }>("SELECT action FROM ops.audit WHERE action = 'setting.changed'");
    expect(a.rowCount).toBeGreaterThan(0);
  });
});

describe("booking against the finalized on-chain distribution (D9)", () => {
  it("refuses a distribution that is not finalized or differs from the calculation; books WHT and net in one transaction", async () => {
    const docs = await new OpsService(w.ops).documents(calcId);
    const d = (await w.pool.query<{ sum_net: string; sum_wht: string }>("SELECT sum_net::text, sum_wht::text FROM ops.distributions WHERE id = $1", [calcId])).rows[0];
    const net = BigInt(d?.sum_net ?? "0");
    const wht = BigInt(d?.sum_wht ?? "0");
    await chainDistribution(w, t, 1, { recordBlock: RECORD_BLOCK, root: docs.root, total: net, statementHash: docs.statementHash, status: "published" });
    expect(await message(w.ops.query("SELECT ops.book_distribution($1, $2, 1, 'operator:omar')", [calcId, t.registry]))).toMatch(/finalized/);
    // On chain: the GROSS total (as if the leaf were gross) is refused.
    await chainDistribution(w, t, 2, { recordBlock: RECORD_BLOCK, root: docs.root, total: net + wht, statementHash: docs.statementHash, status: "finalized" });
    expect(await message(w.ops.query("SELECT ops.book_distribution($1, $2, 2, 'operator:omar')", [calcId, t.registry]))).toMatch(/differs/);
    await chainDistribution(w, t, 3, { recordBlock: RECORD_BLOCK, root: docs.root, total: net, statementHash: docs.statementHash, status: "finalized" });
    await w.ops.query("SELECT ops.book_distribution($1, $2, 3, 'operator:omar')", [calcId, t.registry]);

    const j = await w.pool.query<{ key: string; external_ref: string; debit: string }>(
      `SELECT j.idempotency_key AS key, j.external_ref, sum(p.amount) FILTER (WHERE p.amount > 0)::text AS debit
       FROM ledger.journal j JOIN ledger.postings p ON p.journal_id = j.id WHERE j.idempotency_key LIKE $1 GROUP BY 1, 2 ORDER BY 1`,
      [`rent:%:${t.token}:3`],
    );
    expect(j.rows).toEqual([
      { key: `rent:distribution:${t.token}:3`, external_ref: docs.statementHash, debit: net.toString() },
      { key: `rent:wht:${t.token}:3`, external_ref: docs.statementHash, debit: wht.toString() },
    ]);
    // Every rupee of the period's pool ended in a charge, the reserve, WHT or an investor payable (acceptance 4).
    expect(await balance(w, `rent:pool:${t.token}`)).toBe(0n);
    expect(await balance(w, `tax:wht-payable:${t.token}`)).toBe(-wht);
    expect(await balance(w, `rent:payable:${alice.subjectId}`)).toBe(-14_894_550n);
    expect(await balance(w, `rent:payable:wallet:${dave}`)).toBeLessThan(0n);
    expect((await w.ops.query("SELECT * FROM tax.reconcile($1)", [t.token])).rows).toEqual([]);
  });
});

describe("remittance to FBR, certificates, reconciliation (OT-10, OP-51)", () => {
  it("issues a certificate; a remittance never exceeds what was withheld; a re-issued certificate supersedes the first", async () => {
    const fy = Number(today.slice(0, 4)) + (Number(today.slice(5, 7)) >= 7 ? 1 : 0);
    const c1 = (await w.ops.query<{ id: string }>("SELECT tax.issue_certificate($1, $2, 'operator:omar')::text AS id", [alice.subjectId, fy])).rows[0]?.id;
    const again = (await w.ops.query<{ id: string }>("SELECT tax.issue_certificate($1, $2, 'operator:omar')::text AS id", [alice.subjectId, fy])).rows[0]?.id;
    expect(again).toBe(c1);
    const { rows } = await w.ops.query<{ p: { withheld: string; outstanding: string } }>("SELECT row_to_json(x) AS p FROM tax.period_position($1, $2) x", [t.token, PERIOD]);
    const withheld = BigInt(rows[0]?.p.withheld ?? "0");
    expect(withheld).toBeGreaterThan(0n);
    // Paid to FBR from the account the rent arrived in (its statement will show the debit).
    const account = (await w.pool.query<{ a: string }>("SELECT bank_account AS a FROM ops.collections WHERE token = $1 AND status = 'approved' LIMIT 1", [t.token])).rows[0]?.a;
    const remit = (amount: bigint, cpr: string) =>
      w.ops.query<{ id: string }>("SELECT tax.propose_remittance($1, $2, $3, $4, 'FBRPAY0001', $5, $6, 'operator:omar')::text AS id", [t.token, PERIOD, amount.toString(), cpr, account, today]);
    expect(await message(remit(withheld + 1n, "CPR-IT-000001"))).toMatch(/exceeds/);
    const id = (await remit(withheld, "CPR-IT-000002")).rows[0]?.id ?? "";
    expect(await message(w.ops.query("SELECT tax.decide_remittance($1, 'operator:omar', 'approve', 'CPR matches the bank debit')", [id]))).toMatch(/maker-checker/);
    await w.ops.query("SELECT tax.decide_remittance($1, 'operator:sara', 'approve', 'CPR matches the bank debit')", [id]);
    expect(await balance(w, `tax:wht-payable:${t.token}`)).toBe(0n);
    expect((await w.ops.query("SELECT * FROM tax.reconcile($1)", [t.token])).rows).toEqual([]);
    const c2 = (await w.ops.query<{ id: string }>("SELECT tax.issue_certificate($1, $2, 'operator:omar')::text AS id", [alice.subjectId, fy])).rows[0]?.id;
    expect(c2).not.toBe(c1);
    const cert = (await w.pool.query<{ content: { lines: { whtPaisa: string; cprs: string[] }[]; totals: { grossPaisa: string } }; supersedes: string }>(
      "SELECT content, supersedes::text FROM tax.certificates WHERE id = $1",
      [c2],
    )).rows[0];
    expect(cert?.supersedes).toBe(c1);
    expect(cert?.content.lines[0]).toMatchObject({ whtPaisa: "2628450", cprs: ["CPR-IT-000002"] });
    expect(cert?.content.totals.grossPaisa).toBe("17523000");
  });

  it("reconciliation finds a posting to the FBR payable that no distribution or remittance explains, and edited lines", async () => {
    await w.su.query("BEGIN");
    try {
      await w.su.query(
        `SELECT ledger.post_journal('test:rogue:wht', 'test_rogue', 'rogue', NULL, 'rogue', jsonb_build_array(
           jsonb_build_object('account', 'bank:trustee-escrow', 'amount', '1'), jsonb_build_object('account', $1::text, 'amount', '-1')))`,
        [`tax:wht-payable:${t.token}`],
      );
      const { rows } = await w.su.query<{ check_name: string }>("SELECT * FROM tax.reconcile($1)", [t.token]);
      expect(rows.map((r) => r.check_name)).toContain("tax.payable_mismatch");
    } finally {
      await w.su.query("ROLLBACK");
    }
    await w.su.query("BEGIN");
    try {
      await w.su.query("ALTER TABLE ops.distribution_lines DISABLE TRIGGER distribution_lines_append_only");
      // Consistent with the per-line CHECKs (rate, WHT, net changed together), but no longer the calculation's totals.
      await w.su.query("UPDATE ops.distribution_lines SET rate_ppm = 0, wht = 0, net = gross WHERE distribution_id = $1 AND wallet = $2", [calcId, bob.wallet]);
      const { rows } = await w.su.query<{ check_name: string; subject: string }>("SELECT * FROM tax.reconcile($1)", [t.token]);
      expect(rows).toContainEqual(expect.objectContaining({ check_name: "tax.line_arithmetic", subject: `calculation ${calcId}` }));
    } finally {
      await w.su.query("ROLLBACK");
    }
  });
});

describe("SQL and TypeScript agree under random holders, balances and statuses (property)", () => {
  it("lines, sums and rounding are identical", async () => {
    await allowPlaceholders(w, true);
    const filers = [await investor(w, 3), await investor(w, 5)];
    const nonFilers = [await investor(w, 4), await investor(w, 6)];
    for (const f of filers) await filerCheck(w, f.subjectId, "filer", "2026-09-01");
    for (const f of nonFilers) await filerCheck(w, f.subjectId, "non_filer", "2026-09-01");
    const pool = [...filers.map((x) => ({ wallet: x.wallet, rate: 150_000 })), ...nonFilers.map((x) => ({ wallet: x.wallet, rate: 300_000 }))];
    let runs = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.bigInt({ min: 1n, max: 10_000_000_000n }),
        fc.array(fc.bigInt({ min: 1n, max: 1_000_000_000n }), { minLength: 1, maxLength: 4 }),
        fc.array(fc.bigInt({ min: 1n, max: 1_000_000n }), { minLength: 0, maxLength: 3 }),
        async (rent, kycUnits, anonUnits) => {
          runs++;
          const tk = await token(w);
          const holders = [
            ...kycUnits.map((u, i) => ({ wallet: pool[i % pool.length]?.wallet ?? "", units: u, ratePpm: pool[i % pool.length]?.rate ?? 0 })),
            ...anonUnits.map((u) => ({ wallet: address(), units: u, ratePpm: 300_000 })),
          ];
          const merged = new Map<string, { wallet: string; units: bigint; ratePpm: number }>();
          for (const h of holders) merged.set(h.wallet, { ...h, units: (merged.get(h.wallet)?.units ?? 0n) + h.units });
          for (const h of merged.values()) await transfer(w, tk, ZERO, h.wallet, h.units, 3);
          await collect(w, tk, "2026-09-15", rent);
          const id = await calculate(w, tk, PERIOD, today, 4);
          const { rows } = await w.pool.query<{ wallet: string; units: string; gross: string; wht: string; net: string }>(
            "SELECT wallet, units::text, gross::text, wht::text, net::text FROM ops.distribution_lines WHERE distribution_id = $1 ORDER BY wallet",
            [id],
          );
          const sql = rows.map((r) => ({ wallet: r.wallet, units: BigInt(r.units), gross: BigInt(r.gross), wht: BigInt(r.wht), net: BigInt(r.net) }));
          expect(sql).toEqual(splitDistribution(rent, [...merged.values()]));
          expect(sql.reduce((a, l) => a + l.gross, 0n)).toBe(rent);
          expect((await w.ops.query("SELECT * FROM tax.reconcile($1)", [tk.token])).rows).toEqual([]);
        },
      ),
      { numRuns: 10 },
    );
    expect(runs).toBeGreaterThanOrEqual(10);
  }, 300_000);
});

describe("audit, officer binding and roles (OT-11)", () => {
  it("the audit chain verifies, and finds an edited entry", async () => {
    expect((await w.ops.query("SELECT * FROM ops.verify_audit()")).rows).toEqual([]);
    await w.su.query("BEGIN");
    try {
      await w.su.query("ALTER TABLE ops.audit DISABLE TRIGGER audit_append_only");
      await w.su.query("UPDATE ops.audit SET detail = detail || '{\"amount\": \"1\"}' WHERE action = 'charge.proposed' AND id = (SELECT min(id) FROM ops.audit WHERE action = 'charge.proposed')");
      const { rows } = await w.su.query<{ problem: string }>("SELECT * FROM ops.verify_audit()");
      expect(rows.map((r) => r.problem).join()).toMatch(/content does not match its hash/);
    } finally {
      await w.su.query("ROLLBACK");
    }
  });

  it("an officer's handle is refused outside the portal; roles have exactly their functions", async () => {
    const o = await officer(w.su, "ops.checker.z", "ops_checker");
    const id = await proposeCharge(w, t, "2026-10", "expense", 100n, { payee: "binding-co" });
    expect(await code(w.ops.query("SELECT ops.decide_charge($1, $2, 'approve', 'approved outside the portal')", [id, o.handle]))).toBe("42501");
    const reader = new pg.Client(w.settings);
    await reader.connect();
    try {
      await reader.query("SET ROLE pt_ops_reader");
      expect(await code(reader.query("SELECT ops.decide_charge($1, 'operator:x', 'approve', 'reader may not decide')", [id]))).toBe("42501");
      expect((await reader.query("SELECT * FROM tax.reconcile($1)", [t.token])).rowCount).toBe(0);
      await reader.query("RESET ROLE");
      await reader.query("SET ROLE pt_admin_portal");
      expect(await code(reader.query("SELECT ops.decide_charge($1, 'operator:x', 'approve', 'portal role only uses admin.*')", [id]))).toBe("42501");
      await reader.query("RESET ROLE");
      await reader.query("SET ROLE pt_tax_service");
      expect(await code(reader.query("SELECT ops.calculate_distribution($1, '2026-10', $2, 1, 'reit_dividend', 'tax-service')", [t.token, today]))).toBe("42501");
      expect(await code(reader.query("SELECT sealed FROM tax.sealed_cnics"))).toBe("42501");
    } finally {
      await reader.end();
    }
  });
});

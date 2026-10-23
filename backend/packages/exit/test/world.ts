import { createHash, randomBytes } from "node:crypto";
import pg from "pg";
import { officer, type TestOfficer } from "../../db/test/officers.ts";
import { buildStatement, importStatement } from "@pt/recon";
import { address, createWorld as createTaxWorld, investor, token, transfer, ZERO, type Investor, type TestToken, type World as TaxWorld } from "../../tax/test/world.ts";

/**
 * A scratch database (all migrations, through the S-03 tax world) with what an S-05 exit needs: a
 * paused token with holders in the read model, its IssuanceGuard, the portal officers of every
 * capacity, a client logged in as PT Control (pt_admin_portal), trustee-escrow statements, payout
 * accounts, an open reconciliation gate and read-model helpers for publish/finalize/burns.
 */
export interface World extends TaxWorld {
  portal: pg.Client;
  officers: {
    maker: TestOfficer;
    checker: TestOfficer;
    checker2: TestOfficer;
    compliance: TestOfficer;
    legal: TestOfficer;
    trustee: TestOfficer;
    trustee2: TestOfficer;
  };
}

export async function createWorld(): Promise<World> {
  const w = await createTaxWorld();
  const portal = new pg.Client(w.settings);
  await portal.connect();
  await portal.query("SET ROLE pt_admin_portal");
  const officers = {
    maker: await officer(w.su, "exit.maker", "ops_maker"),
    checker: await officer(w.su, "exit.checker", "ops_checker"),
    checker2: await officer(w.su, "exit.checker.two", "ops_checker"),
    compliance: await officer(w.su, "exit.compliance", "compliance_officer"),
    legal: await officer(w.su, "exit.legal", "legal_officer"),
    trustee: await officer(w.su, "exit.trustee", "trustee_officer"),
    trustee2: await officer(w.su, "exit.trustee.two", "trustee_officer"),
  };
  const drop = w.drop;
  return {
    ...w,
    portal,
    officers,
    drop: async () => {
      await portal.end();
      await drop();
    },
  };
}

export const sha = (label: string): string => createHash("sha256").update(label).digest("hex");
export { address, investor, ZERO, type Investor, type TestToken };

/** Signs every officer in again (a fresh step-up: sessions in tests outlive the five-minute window). */
export async function refresh(w: World): Promise<void> {
  for (const [k, o] of Object.entries(w.officers)) {
    // eslint-disable-next-line security/detect-object-injection -- k comes from the object itself
    (w.officers as Record<string, TestOfficer>)[k] = await officer(w.su, o.handle, "unused");
  }
}

export interface Holding {
  inv: Investor;
  units: bigint;
}

/**
 * A paused token whose holders were minted at `mintBlock` (read model: transfers, holdings, supply,
 * cap) with its IssuanceGuard and DistributionRegistry registered as contracts of the deployment.
 */
export async function exitToken(w: World, holdings: Holding[], mintBlock = 10, head = 100): Promise<TestToken & { issuance: string }> {
  const t = await token(w, head);
  const issuance = address();
  await w.su.query("INSERT INTO chain.contracts (deployment, role, address) VALUES ($1, 'issuance', $2), ($1, 'distributions', $3)", [t.deployment, issuance, t.registry]);
  let supply = 0n;
  for (const h of holdings) {
    await transfer(w, t, ZERO, h.inv.wallet, h.units, mintBlock);
    await w.su.query("INSERT INTO chain.holdings (token, holder, balance, updated_block) VALUES ($1, $2, $3, $4)", [t.token, h.inv.wallet, h.units.toString(), mintBlock]);
    supply += h.units;
  }
  await w.su.query("UPDATE chain.tokens SET total_supply = $2, trustee_cap = $2, paused = true WHERE token = $1", [t.token, supply.toString()]);
  return { ...t, issuance };
}

/** One trustee-escrow statement (account TRUSTEE-ESCROW of the tax world) per call, on its own date. */
let statementDay = 0;
export async function escrowStatement(w: World, lines: { amount: bigint; reference: string }[]): Promise<bigint> {
  const { rows } = await w.pool.query<{ closing: string | null; d: string | null }>(
    "SELECT closing_paisa::text AS closing, (max(statement_date) OVER ())::text AS d FROM recon.bank_statements WHERE account = 'TRUSTEE-ESCROW' ORDER BY statement_date DESC LIMIT 1",
  );
  const opening = BigInt(rows[0]?.closing ?? "0");
  const date = new Date(Date.UTC(2026, 0, 1) + ++statementDay * 86_400_000).toISOString().slice(0, 10);
  const st = buildStatement("TRUSTEE-ESCROW", date, opening, lines.map((l) => ({ valueDate: date, amountPaisa: l.amount, reference: l.reference, counterparty: "Exit (test)" })));
  return importStatement(w.pool, st, "test:import");
}

export const ref = (prefix: string): string => `${prefix}${randomBytes(6).toString("hex").toUpperCase()}`;

/** A payout account whose 72-hour cooling-off is over (as the bank service registers it, back-dated). */
export async function payee(w: World, subject: string): Promise<void> {
  await w.su.query(
    `INSERT INTO bank.payees (subject_id, iban_hash, iban_enc, iban_last4, bank_code, registered_at, active_from, registered_by)
     VALUES ($1, $2, $3, '1234', 'ABCD', now() - interval '5 days', now() - interval '1 day', 'test:payee')`,
    [subject, randomBytes(32), randomBytes(60)],
  );
}

/** A reconciliation run that passed just now: the payout gate is open. */
export async function openGate(w: World): Promise<void> {
  const { rows } = await w.su.query<{ id: string }>("SELECT recon.start_run('test', NULL, '{}') AS id");
  await w.su.query("SELECT recon.complete_run($1, 'test', 0, '[]', '{}')", [rows[0]?.id]);
}

export interface PortalResult {
  ok: boolean;
  id?: number;
  status?: string;
  error?: string;
  state?: string;
}

export async function request(w: World, o: TestOfficer, caseId: number | null, action: string, args: object, reason: string): Promise<PortalResult> {
  const { rows } = await w.portal.query<{ r: PortalResult }>("SELECT admin.exit_request($1, $2, $3, $4::jsonb, $5) AS r", [
    o.sessionHash,
    caseId,
    action,
    JSON.stringify(args),
    reason,
  ]);
  return rows[0]?.r ?? { ok: false };
}

export async function decide(w: World, o: TestOfficer, kind: string, refId: number, decision: "approve" | "reject", digest: string, args: object = {},
  reason = "checked against the evidence on file"): Promise<PortalResult> {
  const { rows } = await w.portal.query<{ r: PortalResult }>("SELECT admin.exit_decide($1, $2, $3, $4, $5, $6, $7::jsonb) AS r", [
    o.sessionHash,
    kind,
    refId,
    decision,
    reason,
    Buffer.from(digest, "hex"),
    JSON.stringify(args),
  ]);
  return rows[0]?.r ?? { ok: false };
}

/** The parts of admin.exit_case the tests read. */
export interface CaseJson {
  state: string;
  caseDigest: string;
  closeProblem: string | null;
  proceedsApproved: string;
  facts: Record<string, string | number | boolean | null>;
  chain: { supply: string; cap: string; paused: boolean };
  decisions: { id: number; code: string; status: string; digest: string }[];
  proceeds: { id: number; digest: string; status: string }[];
  waterfall: { id: number; status: string; digest: string; lines: { id: number; kind: string; amount: string; withdrawn: boolean; payments: { id: number; digest: string; status: string }[] }[] };
  final: { id: number; status: string; digest: string };
  redemption: { id: number; status: string; burnRule: string; digest: string; items: { wallet: string; payment: string; released: boolean }[] };
}

export async function caseJson(w: World, o: TestOfficer, id: number): Promise<CaseJson> {
  const { rows } = await w.portal.query<{ v: CaseJson }>("SELECT admin.exit_case($1, $2) AS v", [o.sessionHash, id]);
  if (!rows[0]?.v) throw new Error(`case ${String(id)} not readable`);
  return rows[0].v;
}

/** Proposes a decision (maker) and lets every capacity in `voters` approve it, each reading the digest first. */
export async function decision(w: World, caseId: number, code: string, detail: object, voters: TestOfficer[]): Promise<PortalResult> {
  const p = await request(w, w.officers.maker, caseId, "propose", { code, detail }, `proposal ${code} with its evidence on file`);
  if (!p.ok) return p;
  let last: PortalResult = p;
  for (const v of voters) {
    const c = await caseJson(w, v, caseId);
    const d = c.decisions.find((x) => x.id === p.id);
    last = await decide(w, v, "vote", p.id ?? 0, "approve", d?.digest ?? "");
    if (!last.ok) return last;
  }
  return last;
}

/** The read model learns of a published (or other status) distribution. */
export async function chainDistribution(w: World, t: TestToken, id: number, d: { recordBlock: number; root: string; total: bigint; statementHash: string; status: string }): Promise<void> {
  await w.su.query(
    `INSERT INTO chain.distributions (registry, id, token, record_block, merkle_root, total_paisa, statement_hash, status, published_block, updated_block)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, 1)
     ON CONFLICT (registry, id) DO UPDATE SET status = EXCLUDED.status, payout_batch_hash = CASE WHEN EXCLUDED.status = 'paid' THEN $9 ELSE chain.distributions.payout_batch_hash END`,
    [t.registry, id, t.token, d.recordBlock, d.root, d.total.toString(), d.statementHash, d.status, `0x${"ab".repeat(32)}`],
  );
}

/**
 * Drives a fresh case on a fresh token all the way to Redeeming (no vote needed, one waterfall line)
 * through the portal functions and the exit service. Returns the ids the caller needs.
 */
export async function toRedeeming(
  w: World,
  holdings: Holding[],
  burnRule: "after_payment" | "after_finalization" = "after_payment",
  onchainId = 1,
): Promise<{ t: TestToken & { issuance: string }; caseId: number; finalId: string; redemptionId: number }> {
  const { ExitService } = await import("../src/service.ts");
  const svc = new ExitService(w.pool);
  const t = await exitToken(w, holdings);
  await refresh(w);
  const o = await request(w, w.officers.maker, null, "open", {
    token: t.token, offerPaisa: "500000000", valuationAPaisa: "500000000", valuationASha: sha(`va${t.token}`), valuationBPaisa: "510000000",
    valuationBSha: sha(`vb${t.token}`), costsPaisa: "0", voteRequired: false,
  }, "sale of the whole building to a cleared buyer at valuation");
  const caseId = o.id ?? 0;
  const must = (r: PortalResult, what: string): void => {
    if (!r.ok) throw new Error(`${what}: ${r.error ?? "refused"}`);
  };
  must(await decision(w, caseId, "X3", { minutesSha: sha("ic") }, [w.officers.checker, w.officers.compliance]), "X3");
  must(await decision(w, caseId, "X7", { legalAdviceSha: sha("legal"), conflictsCleared: true }, [w.officers.legal, w.officers.trustee]), "X7");
  must(await decision(w, caseId, "X9", { buyerRef: `KYB-${t.token.slice(2, 10)}`, buyerChecksSha: sha("buyer"), agreementSha: sha("spa"), salePricePaisa: "500000000",
    depositPaisa: "0", cpDeadline: "2099-01-01" }, [w.officers.compliance, w.officers.legal, w.officers.trustee]), "X9");
  await refresh(w);
  const st = await escrowStatement(w, [{ amount: 500_000_000n, reference: ref("PRC") }]);
  const p = await request(w, w.officers.maker, caseId, "proceeds", { kind: "proceeds", statementId: st.toString(), lineNo: 1 }, "full sale price received");
  must(p, "proceeds");
  let c = await caseJson(w, w.officers.checker, caseId);
  must(await decide(w, w.officers.checker, "proceeds", p.id ?? 0, "approve", c.proceeds.find((x) => x.id === p.id)?.digest ?? ""), "proceeds decide");
  must(await decision(w, caseId, "X11", { deedSha: sha("deed") }, [w.officers.legal]), "X11");
  await openGate(w);
  must(await decision(w, caseId, "X12", {}, [w.officers.checker]), "X12");
  await refresh(w);
  must(await request(w, w.officers.maker, caseId, "line", { kind: "transaction_cost", payee: "broker-two", amountPaisa: "10000000", evidenceSha: sha("brokerage") }, "brokerage invoice"), "line");
  must(await request(w, w.officers.maker, caseId, "submit_waterfall", {}, "waterfall ready"), "submit");
  c = await caseJson(w, w.officers.checker, caseId);
  must(await decide(w, w.officers.checker, "waterfall", c.waterfall.id, "approve", c.waterfall.digest), "check waterfall");
  c = await caseJson(w, w.officers.trustee, caseId);
  must(await decide(w, w.officers.trustee, "waterfall", c.waterfall.id, "approve", c.waterfall.digest), "approve waterfall");
  const today = (await w.pool.query<{ d: string }>("SELECT exit.pkt_today()::text AS d")).rows[0]?.d ?? "";
  must(await request(w, w.officers.maker, caseId, "announce", { recordDate: today, noticeSha: sha("notice") }, "record date"), "announce");
  const finalId = await svc.calculate(String(caseId), 10n, "operator:ali");
  const docs = await svc.attach(finalId, "operator:omar");
  await refresh(w);
  c = await caseJson(w, w.officers.trustee, caseId);
  must(await decide(w, w.officers.trustee, "precheck", Number(finalId), "approve", c.final.digest, { root: docs.root }), "precheck");
  c = await caseJson(w, w.officers.checker, caseId);
  must(await decide(w, w.officers.checker, "final", Number(finalId), "approve", c.final.digest), "final");
  const f = (await w.pool.query<{ net: string }>("SELECT sum_net::text AS net FROM exit.finals WHERE id = $1", [finalId])).rows[0];
  await chainDistribution(w, t, onchainId, { recordBlock: 10, root: docs.root, total: BigInt(f?.net ?? "0"), statementHash: docs.statementHash, status: "finalized" });
  await svc.tick("exit-worker");
  const redemptionId = Number(await svc.createRedemption(String(caseId), "operator:ali", burnRule));
  c = await caseJson(w, w.officers.checker, caseId);
  must(await decide(w, w.officers.checker, "redemption", redemptionId, "approve", c.redemption.digest), "check redemption");
  c = await caseJson(w, w.officers.trustee, caseId);
  must(await decide(w, w.officers.trustee, "redemption", redemptionId, "approve", c.redemption.digest), "approve redemption");
  return { t, caseId, finalId, redemptionId };
}

/** The read model learns of a Burned event (IssuanceGuard) and the burn Transfer. */
let burnLog = 900_000;
export async function burned(w: World, t: TestToken & { issuance: string }, wallet: string, units: bigint, refId: string, at: number): Promise<void> {
  await transfer(w, t, wallet, ZERO, units, at);
  const { rows } = await w.su.query<{ tx_hash: string; block_hash: string }>(
    "SELECT e.tx_hash, e.block_hash FROM chain.transfers x JOIN chain.events e USING (deployment, block_number, log_index) WHERE x.deployment = $1 AND x.block_number = $2 ORDER BY x.log_index DESC LIMIT 1",
    [t.deployment, at],
  );
  const e = rows[0];
  const li = ++burnLog;
  await w.su.query(
    `INSERT INTO chain.events (deployment, block_number, log_index, block_hash, tx_hash, tx_index, address, contract, name, args, topics, data)
     VALUES ($1, $2, $3, $4, $5, 0, $6, 'issuance', 'Burned', '{}'::jsonb, '{}', '0x')`,
    [t.deployment, at, li, e?.block_hash, e?.tx_hash, t.issuance],
  );
  await w.su.query(
    `INSERT INTO chain.issuances (guard, ref_id, kind, account, amount, deployment, block_number, log_index, tx_hash)
     VALUES ($1, $2, 'burn', $3, $4, $5, $6, $7, $8)`,
    [t.issuance, refId, wallet, units.toString(), t.deployment, at, li, e?.tx_hash],
  );
  await w.su.query("UPDATE chain.holdings SET balance = balance - $3 WHERE token = $1 AND holder = $2", [t.token, wallet, units.toString()]);
  await w.su.query("UPDATE chain.tokens SET total_supply = total_supply - $2 WHERE token = $1", [t.token, units.toString()]);
}

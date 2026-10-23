import type { Deployment } from "@pt/indexer";
import type pg from "pg";
import type { ChainState } from "./chain.ts";
import type {
  BankStatement,
  ChainDistribution,
  ChainRecoveryRequest,
  RecoveryData,
  ChainIssuance,
  DistributionStatus,
  ExitData,
  ExitLine,
  ExpectedMint,
  LedgerJournal,
  OfferingData,
  OfferingSubscription,
  OutboxCommand,
  PayoutBatch,
  ReconData,
  TaxData,
  TransferData,
} from "./types.ts";

export interface LoadOptions {
  deployment: Deployment;
  chain: ChainState;
  slaMinutes: number;
  /**
   * The indexer's full verification (rebuild from the chain + contract state, ADR 0006). Its
   * problems become blocking findings. null = not run (recorded in the summary).
   */
  verifyIndexer: (() => Promise<{ pinnedBlock: bigint; problems: string[] }>) | null;
}

export interface Loaded {
  data: ReconData;
  timings: { snapshotMs: number; chainMs: number; verifyMs: number };
  /** Facts for the run summary. */
  sources: { webdemo: boolean; outboxMintCommands: number };
}

const lower = (x: string): string => x.toLowerCase();

/**
 * Reads everything a run compares:
 *  1. one REPEATABLE READ snapshot of the database (read model, ledger, outbox, bank, audits), so
 *     every database fact is from the same instant; the read model's cursor is the pinned block P;
 *  2. the contracts' own totalSupply and balanceOf at block P (the read model is exactly block P);
 *  3. optionally the indexer's full verify.
 * Nothing is written.
 */
export async function loadData(pool: pg.Pool, o: LoadOptions): Promise<Loaded> {
  const d = o.deployment;
  const t0 = performance.now();
  const client = await pool.connect();
  let snap: Omit<ReconData, "chain" | "integrity"> & {
    chain: Omit<ReconData["chain"], "onChain">;
    integrity: Omit<ReconData["integrity"], "indexer"> & { halted: string | null };
  };
  let sources: Loaded["sources"];
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const q = async <T extends pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> => (await client.query<T>(sql, params)).rows;

    const [{ now } = { now: new Date() }] = await q<{ now: Date }>("SELECT now() AS now");
    const cursor = (await q<{ block_number: string; halt_reason: string | null }>(
      "SELECT block_number, halt_reason FROM chain.cursors WHERE deployment = $1", [d.id]))[0];
    if (!cursor) throw new Error(`deployment ${d.id} is not indexed (run the indexer first)`);
    const pinned = BigInt(cursor.block_number);

    const token = (await q<{ total_supply: string }>("SELECT total_supply::text FROM chain.tokens WHERE deployment = $1", [d.id]))[0];
    const holdings = new Map((await q<{ holder: string; balance: string }>(
      "SELECT holder, balance::text FROM chain.holdings WHERE token = $1 AND balance > 0", [lower(d.contracts.token)]))
      .map((r) => [r.holder, BigInt(r.balance)]));
    const issuances: ChainIssuance[] = (await q<{ ref_id: string; kind: "mint" | "burn"; account: string; amount: string; block_number: string; tx_hash: string; block_time: Date }>(
      `SELECT i.ref_id, i.kind, i.account, i.amount::text, i.block_number, i.tx_hash, b.block_time
       FROM chain.issuances i JOIN chain.blocks b ON b.number = i.block_number
       WHERE i.deployment = $1 ORDER BY i.block_number, i.log_index`, [d.id]))
      .map((r) => ({ refId: r.ref_id, kind: r.kind, account: r.account, amount: BigInt(r.amount), blockNumber: BigInt(r.block_number), blockTime: r.block_time, txHash: r.tx_hash }));
    const distributions: ChainDistribution[] = d.contracts.distributions
      ? (await q<{ id: string; token: string; total_paisa: string; statement_hash: string; status: DistributionStatus; payout_batch_hash: string | null }>(
        `SELECT id::text, token, total_paisa::text, statement_hash, status, payout_batch_hash FROM chain.distributions WHERE registry = $1`,
        [lower(d.contracts.distributions)]))
        .map((r) => ({ id: BigInt(r.id), token: r.token, totalPaisa: BigInt(r.total_paisa), statementHash: r.statement_hash, status: r.status, payoutBatchHash: r.payout_batch_hash }))
      : [];

    const accounts = (await q<{ account: string; ledger_account: string }>("SELECT account, ledger_account FROM recon.bank_accounts ORDER BY account"))
      .map((r) => ({ account: r.account, ledgerAccount: r.ledger_account }));
    const journals: LedgerJournal[] = (await q<{ id: string; idempotency_key: string; kind: string; external_ref: string | null; created_at: Date; postings: [string, string][] }>(
      `WITH linked AS (
         SELECT id FROM ledger.journal
         WHERE idempotency_key LIKE 'web:sub:%' OR idempotency_key LIKE 'sub:%' OR idempotency_key LIKE 'rent:%' OR kind = 'reversal'
         UNION
         SELECT p.journal_id FROM ledger.postings p JOIN ledger.accounts a ON a.id = p.account_id WHERE a.code = ANY($1)
       )
       SELECT j.id, j.idempotency_key, j.kind, j.external_ref, j.created_at,
              json_agg(json_build_array(a.code, p.amount::text) ORDER BY p.id) AS postings
       FROM ledger.journal j
       JOIN ledger.postings p ON p.journal_id = j.id
       JOIN ledger.accounts a ON a.id = p.account_id
       WHERE j.id IN (SELECT id FROM linked)
       GROUP BY j.id ORDER BY j.id`, [accounts.map((a) => a.ledgerAccount)]))
      .map((r) => ({ id: BigInt(r.id), key: r.idempotency_key, kind: r.kind, externalRef: r.external_ref, createdAt: r.created_at,
        postings: r.postings.map(([account, amount]) => ({ account, amount: BigInt(amount) })) }));

    const expectedMints = new Map<string, ExpectedMint>();
    let mintCommands = 0;
    const outbox: OutboxCommand[] = [];
    for (const c of await q<{ id: string; kind: string; status: string; updated_at: Date; last_error: string | null; payload: Record<string, unknown> }>(
      "SELECT id, kind, status, updated_at, last_error, payload FROM outbox.commands WHERE kind = 'issuance.mint' OR status NOT IN ('confirmed', 'failed') ORDER BY id")) {
      if (c.status !== "confirmed" && c.status !== "failed") {
        outbox.push({ id: BigInt(c.id), kind: c.kind, status: c.status as OutboxCommand["status"], updatedAt: c.updated_at, lastError: c.last_error });
      }
      const p = c.payload;
      if (c.kind !== "issuance.mint" || typeof p.refId !== "string" || typeof p.to !== "string" || typeof p.amount !== "string") continue;
      if (typeof p.issuance === "string" && d.contracts.issuance && lower(p.issuance) !== lower(d.contracts.issuance)) continue;
      mintCommands++;
      const refId = lower(p.refId);
      const prev = expectedMints.get(refId);
      expectedMints.set(refId, prev ? { ...prev, commands: prev.commands + 1 } : { refId, to: lower(p.to), amount: BigInt(p.amount), source: "outbox", commands: 1 });
    }
    // The web prototype's subscription register (schema webdemo), read-only, when it exists.
    const webdemo = (await q<{ ok: boolean }>("SELECT to_regclass('webdemo.subscriptions') IS NOT NULL AND to_regclass('webdemo.investors') IS NOT NULL AS ok"))[0]?.ok ?? false;
    if (webdemo) {
      for (const r of await q<{ ref_id: string; tokens: string; wallet: string }>(
        "SELECT s.ref_id, s.tokens::text, lower(i.wallet_address) AS wallet FROM webdemo.subscriptions s JOIN webdemo.investors i ON i.id = s.investor_id")) {
        if (!expectedMints.has(lower(r.ref_id))) expectedMints.set(lower(r.ref_id), { refId: lower(r.ref_id), to: r.wallet, amount: BigInt(r.tokens), source: "webdemo", commands: 0 });
      }
    }

    // S-02 offerings of this token (migration 0015), read-only, when the schema exists.
    let offerings: OfferingData | undefined;
    const hasOfferings = (await q<{ ok: boolean }>("SELECT to_regclass('offering.recon_subscriptions') IS NOT NULL AS ok"))[0]?.ok ?? false;
    if (hasOfferings) {
      const token = lower(d.contracts.token);
      const subscriptions: OfferingSubscription[] = (await q<{ subscription_id: string; ref_id: string; offering_id: string; offering_state: string; hard_cap_units: string;
        mint_started_at: Date | null; failed_at: Date | null; state: string; units: string; wallet: string | null; amount_paisa: string; token: string | null }>(
        `SELECT subscription_id, ref_id, offering_id, offering_state, hard_cap_units::text, mint_started_at, failed_at, state, units::text, wallet, amount_paisa::text, token
         FROM offering.recon_subscriptions ORDER BY offering_id, subscription_id`))
        .map((r) => ({ subscriptionId: r.subscription_id, token: r.token, refId: r.ref_id, offeringId: r.offering_id, offeringState: r.offering_state, hardCap: BigInt(r.hard_cap_units),
          mintStartedAt: r.mint_started_at, failedAt: r.failed_at, state: r.state, units: BigInt(r.units), wallet: r.wallet, amountPaisa: BigInt(r.amount_paisa) }));
      const sla = (await q<{ v: string }>("SELECT value::text AS v FROM offering.settings WHERE key = 'refund_sla_hours'"))[0]?.v ?? "48";
      const cap = (await q<{ cap: string }>("SELECT trustee_cap::text AS cap FROM chain.tokens WHERE token = $1", [token]))[0]?.cap ?? "0";
      const paymentAnomalies = (await q<{ subscription_id: string; raast_ref: string; state: string }>(
        `SELECT a.subscription_id, a.raast_ref, a.state FROM offering.payment_anomalies a JOIN offering.recon_subscriptions s ON s.subscription_id = a.subscription_id
         WHERE s.token = $1 ORDER BY a.id`, [token])).map((r) => ({ subscriptionId: r.subscription_id, raastRef: r.raast_ref, state: r.state }));
      offerings = { subscriptions, refundSlaMs: Number(sla) * 3_600_000, trusteeCap: BigInt(cap), paymentAnomalies };
    }

    // S-06 recovery cases and reversals (migration 0020), read-only, when the schema exists.
    let recovery: RecoveryData | undefined;
    const hasRecovery = (await q<{ ok: boolean }>("SELECT to_regclass('recovery.recon_requests') IS NOT NULL AS ok"))[0]?.ok ?? false;
    if (hasRecovery) {
      const guard = d.contracts.recovery ? lower(d.contracts.recovery) : null;
      const requests = guard
        ? (await q<{ id: string; kind: ChainRecoveryRequest["kind"]; status: ChainRecoveryRequest["status"]; from_addr: string; to_addr: string; amount: string }>(
          "SELECT id::text, kind, status, from_addr, to_addr, amount::text FROM chain.recoveries WHERE guard = $1 ORDER BY id", [guard]))
          .map((r) => ({ id: BigInt(r.id), kind: r.kind, status: r.status, from: r.from_addr, to: r.to_addr, amount: BigInt(r.amount) }))
        : [];
      const caseRequestIds = guard
        ? (await q<{ request_id: string }>("SELECT request_id::text FROM recovery.recon_requests WHERE guard = $1 ORDER BY request_id", [guard])).map((r) => BigInt(r.request_id))
        : [];
      const reversals = (await q<{ case_id: string; journal_id: string; reversal_journal_id: string }>(
        "SELECT case_id::text, journal_id::text, reversal_journal_id::text FROM recovery.recon_reversals ORDER BY case_id"))
        .map((r) => ({ caseId: BigInt(r.case_id), journalId: BigInt(r.journal_id), reversalJournalId: BigInt(r.reversal_journal_id) }));
      recovery = { requests, caseRequestIds, reversals };
    }

    // S-03 operations and FBR withholding of this token (migration 0021), read-only, when the schema exists.
    let tax: TaxData | undefined;
    const hasTax = (await q<{ ok: boolean }>("SELECT to_regprocedure('tax.reconcile(text)') IS NOT NULL AS ok"))[0]?.ok ?? false;
    if (hasTax) {
      const token = lower(d.contracts.token);
      const findings = (await q<{ check_name: string; subject: string; expected: string; actual: string }>("SELECT check_name, subject, expected, actual FROM tax.reconcile($1)", [token]))
        .map((r) => ({ check: r.check_name, subject: r.subject, expected: r.expected, actual: r.actual }));
      const documents = (await q<{ id: string; status: string; onchain_id: string | null; statement: string; statement_hash: string; tax_schedule: string; tax_schedule_hash: string; merkle_root: string }>(
        `SELECT id::text, status, onchain_id::text, statement, statement_hash, tax_schedule, tax_schedule_hash, merkle_root FROM ops.distributions
         WHERE token = $1 AND statement IS NOT NULL ORDER BY id`, [token]))
        .map((r) => ({ id: r.id, status: r.status, onchainId: r.onchain_id === null ? null : BigInt(r.onchain_id), statement: r.statement, statementHash: r.statement_hash,
          schedule: r.tax_schedule, scheduleHash: r.tax_schedule_hash, root: r.merkle_root }));
      tax = { findings, documents };
    }

    // S-04 phase 0 transfers of this token (migration 0028), read-only, when the schema exists.
    let transfers: TransferData | undefined;
    const hasTransfers = (await q<{ ok: boolean }>("SELECT to_regprocedure('transfer.reconcile(text)') IS NOT NULL AS ok"))[0]?.ok ?? false;
    if (hasTransfers) {
      const token = lower(d.contracts.token);
      const guard = d.contracts.recovery ? lower(d.contracts.recovery) : null;
      const findings = (await q<{ check_name: string; subject: string; expected: string; actual: string }>("SELECT check_name, subject, expected, actual FROM transfer.reconcile($1)", [token]))
        .map((r) => ({ check: r.check_name, subject: r.subject, expected: r.expected, actual: r.actual }));
      const caseRequestIds = guard
        ? (await q<{ request_id: string }>("SELECT request_id::text FROM transfer.recon_requests WHERE guard = $1 ORDER BY request_id", [guard])).map((r) => BigInt(r.request_id))
        : [];
      transfers = { findings, caseRequestIds };
    }

    // S-05 exits of this token (migration 0027), read-only, when the schema exists.
    let exit: ExitData | undefined;
    const hasExit = (await q<{ ok: boolean }>("SELECT to_regclass('exit.recon_lines') IS NOT NULL AS ok"))[0]?.ok ?? false;
    if (hasExit) {
      const token = lower(d.contracts.token);
      const lines = (await q<{ case_id: string; case_state: string; redemption_status: string; burn_rule: ExitLine["burnRule"]; distribution_id: string | null;
        wallet: string; units: string; ref_id: string; payment: string; released: boolean }>(
        `SELECT case_id::text, case_state, redemption_status, burn_rule, distribution_id::text, wallet, units::text, ref_id, payment, released
         FROM exit.recon_lines WHERE token = $1 ORDER BY case_id, wallet`, [token]))
        .map((r) => ({ caseId: BigInt(r.case_id), caseState: r.case_state, redemptionStatus: r.redemption_status, burnRule: r.burn_rule,
          distributionId: r.distribution_id === null ? null : BigInt(r.distribution_id), wallet: r.wallet, units: BigInt(r.units), refId: r.ref_id,
          payment: r.payment, released: r.released }));
      const cases = (await q<{ case_id: string; state: string; redeeming_at: Date | null; final_id: string | null; pool_balance: string; closure_reserve_balance: string; register_units: string }>(
        "SELECT case_id::text, state, redeeming_at, final_id::text, pool_balance::text, closure_reserve_balance::text, register_units::text FROM exit.recon_cases WHERE token = $1 ORDER BY case_id",
        [token])).map((r) => ({ caseId: BigInt(r.case_id), state: r.state, redeemingAt: r.redeeming_at, finalBooked: r.final_id !== null,
          poolBalance: BigInt(r.pool_balance), closureReserve: BigInt(r.closure_reserve_balance), registerUnits: BigInt(r.register_units) }));
      const finals = (await q<{ id: string; status: string; onchain_id: string | null; statement: string; statement_hash: string; tax_schedule: string; tax_schedule_hash: string; merkle_root: string }>(
        "SELECT id::text, status, onchain_id::text, statement, statement_hash, tax_schedule, tax_schedule_hash, merkle_root FROM exit.recon_finals WHERE token = $1 ORDER BY id", [token]))
        .map((r) => ({ id: r.id, status: r.status, onchainId: r.onchain_id === null ? null : BigInt(r.onchain_id), statement: r.statement, statementHash: r.statement_hash,
          schedule: r.tax_schedule, scheduleHash: r.tax_schedule_hash, root: r.merkle_root }));
      const sla = (await q<{ v: string }>("SELECT value #>> '{}' AS v FROM exit.settings WHERE key = 'redeeming_sla_hours'"))[0]?.v ?? "72";
      exit = { lines, cases, finals, redeemingSlaMs: Number(sla) * 3_600_000 };
    }

    const statements = new Map<string, BankStatement>();
    for (const r of await q<{ id: string; account: string; statement_date: string; opening_paisa: string; closing_paisa: string }>(
      "SELECT id, account, statement_date::text, opening_paisa::text, closing_paisa::text FROM recon.bank_statements ORDER BY account, statement_date")) {
      statements.set(r.id, { id: BigInt(r.id), account: r.account, date: r.statement_date, opening: BigInt(r.opening_paisa), closing: BigInt(r.closing_paisa), lines: [] });
    }
    for (const r of await q<{ statement_id: string; line_no: number; value_date: string; amount_paisa: string; reference: string; counterparty: string; balance_paisa: string }>(
      "SELECT statement_id, line_no, value_date::text, amount_paisa::text, reference, counterparty, balance_paisa::text FROM recon.bank_lines ORDER BY statement_id, line_no")) {
      statements.get(r.statement_id)?.lines.push({ lineNo: r.line_no, valueDate: r.value_date, amount: BigInt(r.amount_paisa), reference: r.reference, counterparty: r.counterparty, balance: BigInt(r.balance_paisa) });
    }

    const ledgerProblems = (await q<{ journal_id: string; problem: string }>("SELECT journal_id::text, problem FROM ledger.verify_chain()"))
      .map((r) => ({ journalId: r.journal_id, problem: r.problem }));
    const ledgerBalances = await q<{ code: string; cached: string | null; actual: string }>(
      "SELECT code, cached::text, actual::text FROM ledger.verify_balances()");
    const signerAudit = (await q<{ audit_id: string; problem: string }>("SELECT audit_id::text, problem FROM signer.verify_audit()"))
      .map((r) => ({ auditId: r.audit_id, problem: r.problem }));
    const reconAudit = (await q<{ audit_id: string | null; problem: string }>("SELECT audit_id::text, problem FROM recon.verify_audit()"))
      .map((r) => ({ auditId: r.audit_id, problem: r.problem }));
    const payoutBatches: PayoutBatch[] = (await q<{ reference: string; kind: PayoutBatch["kind"]; parent: string | null; token: string; distribution_id: string; total_paisa: string; paid_paisa: string; sha: string }>(
      `SELECT b.reference, b.kind, p.reference AS parent, b.token, b.distribution_id::text, b.total_paisa::text, b.paid_paisa::text,
              '0x' || encode(b.file_sha256, 'hex') AS sha
       FROM bank.payout_batches b LEFT JOIN bank.payout_batches p ON p.id = b.parent_id
       WHERE b.status = 'submitted' ORDER BY b.id`))
      .map((r) => ({ reference: r.reference, kind: r.kind, parentReference: r.parent, token: r.token, distributionId: BigInt(r.distribution_id),
        totalPaisa: BigInt(r.total_paisa), paidPaisa: BigInt(r.paid_paisa), fileSha256: r.sha }));
    await client.query("COMMIT");

    sources = { webdemo, outboxMintCommands: mintCommands };
    snap = {
      asOf: now,
      slaMs: o.slaMinutes * 60_000,
      deployment: { id: d.id, token: lower(d.contracts.token) },
      pinnedBlock: pinned,
      chain: { issuances, distributions, readModel: { totalSupply: BigInt(token?.total_supply ?? "0"), holdings } },
      ledger: { journals },
      expectedMints,
      ...(offerings ? { offerings } : {}),
      ...(recovery ? { recovery } : {}),
      ...(tax ? { tax } : {}),
      ...(transfers ? { transfers } : {}),
      ...(exit ? { exit } : {}),
      bank: { accounts, statements: [...statements.values()], payoutBatches },
      integrity: { ledger: ledgerProblems, ledgerBalances, signerAudit, reconAudit, outbox, halted: cursor.halt_reason },
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  const t1 = performance.now();

  // The contracts at the pinned block. Before the deployment block nothing exists yet.
  const deployed = snap.pinnedBlock >= d.fromBlock;
  const holders = [...snap.chain.readModel.holdings.keys()];
  const [totalSupply, balances, head] = await Promise.all([
    deployed ? o.chain.totalSupply(d.contracts.token, snap.pinnedBlock) : Promise.resolve(0n),
    deployed ? o.chain.balances(d.contracts.token, holders, snap.pinnedBlock) : Promise.resolve(new Map<string, bigint>()),
    o.chain.head(),
  ]);
  const t2 = performance.now();

  let verify: ReconData["integrity"]["indexer"]["verify"] = { ran: false, pinnedBlock: null, problems: [] };
  if (o.verifyIndexer) {
    const v = await o.verifyIndexer();
    verify = { ran: true, pinnedBlock: v.pinnedBlock, problems: v.problems };
  }
  const t3 = performance.now();

  const { halted, ...integrity } = snap.integrity;
  return {
    data: {
      ...snap,
      chain: { ...snap.chain, onChain: { totalSupply, balances: new Map([...balances].map(([h, b]) => [lower(h), b])) } },
      integrity: { ...integrity, indexer: { halted, lagBlocks: head - snap.pinnedBlock, verify } },
    },
    timings: { snapshotMs: Math.round(t1 - t0), chainMs: Math.round(t2 - t1), verifyMs: Math.round(t3 - t2) },
    sources,
  };
}

import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { KycService, mockProviders, Peppers } from "@pt/kyc";
import { openAccount, postJournal } from "@pt/ledger";
import { checkCash, type LedgerJournal, type ReconData, type Statement } from "@pt/recon";
import pg from "pg";
import { migrate } from "../../db/src/migrate.ts";
import { scratchDatabase } from "../../db/test/helpers.ts";
import { makeIban } from "../src/iban.ts";
import { MockBank } from "../src/mockbank.ts";
import { BankService } from "../src/service.ts";
import { verifyWebhook, type WebhookKey } from "../src/webhook.ts";

/** A scratch database at the latest migration with KYC, the bank service and a mock bank wired together. */

export const ESCROW = "TRUSTEE-ESCROW-01";
export const ESCROW_LEDGER = "bank:trustee-escrow";
const MIGRATIONS = fileURLToPath(new URL("../../db/migrations", import.meta.url));

export interface Investor {
  subjectId: string;
  name: string;
  iban: string;
}

export interface World {
  db: pg.Client;
  pool: pg.Pool;
  settings: pg.ClientConfig;
  kyc: KycService;
  bank: BankService;
  mock: MockBank;
  key: WebhookKey;
  peppers: Peppers;
  dataKey: Buffer;
  drop: () => Promise<void>;
}

let accountSeq = 0;

/** deliver: in-process by default (signature verified exactly like the HTTP server). */
export async function world(opts: { deliver?: (raw: string, sig: string) => Promise<number> } = {}): Promise<World> {
  const s = await scratchDatabase();
  await migrate(s.client, MIGRATIONS);
  const pool = new pg.Pool({ ...s.settings, max: 12 });
  const peppers = Peppers.of([{ version: 1, key: randomBytes(32) }]);
  const dataKey = randomBytes(32);
  const key: WebhookKey = { id: "k1", secret: randomBytes(32) };
  const kyc = new KycService(pool, mockProviders(), peppers, randomBytes(32));
  const mock: MockBank = new MockBank({
    account: ESCROW,
    key,
    deliver:
      opts.deliver ??
      (async (raw, sig) => {
        const check = verifyWebhook([key], sig, raw);
        if (!check.ok) return 401;
        return (await bank.handle(raw, check.keyId)).status;
      }),
  });
  const bank: BankService = new BankService(pool, peppers, dataKey, mock, { escrowAccount: ESCROW });
  await s.client.query("SELECT recon.register_bank_account($1, $2, 'operator:setup')", [ESCROW, ESCROW_LEDGER]);
  return {
    db: s.client,
    pool,
    settings: s.settings,
    kyc,
    bank,
    mock,
    key,
    peppers,
    dataKey,
    drop: async () => {
      await pool.end();
      await s.drop();
    },
  };
}

/** A KYC-verified investor with an account at the mock bank, registered as payout account. */
export async function investor(w: World, name = `Investor ${randomUUID().slice(0, 6).replace(/[0-9]/g, "x")}`, opts: { active?: boolean } = {}): Promise<Investor> {
  const cnic = `35202${String(1_000_000 + ++accountSeq).slice(-7)}${String(1 + (accountSeq % 7))}`;
  const r = await w.kyc.onboard({ cnic, fullName: name, livenessSessionId: `sess-good-${String(accountSeq).padStart(4, "0")}` });
  if (r.status !== "verified") throw new Error(`test investor not verified: ${r.reason}`);
  const iban = newAccount(w, name);
  await w.bank.registerPayee(r.subjectId, iban);
  await openAccount(w.db, { code: `rent:payable:${r.subjectId}`, kind: "liability", asset: "PKR" });
  await openAccount(w.db, { code: `investor:${r.subjectId}:subscriptions`, kind: "liability", asset: "PKR" });
  if (opts.active !== false) await ageCoolingOff(w, r.subjectId);
  return { subjectId: r.subjectId, name, iban };
}

/** An account at the mock bank with the given title. */
export function newAccount(w: World, title: string, bankCode = "MEZN"): string {
  const iban = makeIban(bankCode, String(++accountSeq).padStart(16, "0"));
  w.mock.openAccount(iban, title);
  return iban;
}

/**
 * TEST ONLY: moves a payout account's registration 73 hours into the past (the administrator
 * disables the guard on a scratch database). Production has no such path.
 */
export async function ageCoolingOff(w: World, subjectId: string): Promise<void> {
  await w.db.query("ALTER TABLE bank.payees DISABLE TRIGGER payees_guard");
  try {
    await w.db.query(
      "UPDATE bank.payees SET registered_at = registered_at - interval '73 hours', active_from = active_from - interval '73 hours' WHERE subject_id = $1 AND superseded_at IS NULL",
      [subjectId],
    );
  } finally {
    await w.db.query("ALTER TABLE bank.payees ENABLE TRIGGER payees_guard");
  }
}

/** A reconciliation run that passed now (opens the payout gate, ADR 0007 R-4). */
export async function passRecon(w: World): Promise<void> {
  const { rows } = await w.db.query<{ id: string }>("SELECT recon.start_run('test', NULL, '{}') AS id");
  await w.db.query("SELECT recon.complete_run($1, 'test', 0, '[]', '{}')", [rows[0]?.id]);
}

/** A failed run: payouts frozen until two operators unfreeze. */
export async function freezeRecon(w: World): Promise<void> {
  const { rows } = await w.db.query<{ id: string }>("SELECT recon.start_run('test', NULL, '{}') AS id");
  await w.db.query(
    `SELECT recon.complete_run($1, 'test', 0, '[{"check":"cash.closing_mismatch","severity":"blocking","subject":"test"}]', '{}')`,
    [rows[0]?.id],
  );
}

export const token = (): string => `0x${randomBytes(20).toString("hex")}`;

/** The read model's view of a finalized distribution (written by the indexer in production). */
export async function finalizedDistribution(w: World, tokenAddr: string, id: bigint, totalPaisa: bigint, status = "finalized"): Promise<void> {
  await w.db.query(
    `INSERT INTO chain.distributions (registry, id, token, record_block, merkle_root, total_paisa, statement_hash, status, published_block, updated_block)
     VALUES ($1, $2, $3, 1, $4, $5, $4, $6, 1, 1)`,
    [`0x${randomBytes(20).toString("hex")}`, id.toString(), tokenAddr, `0x${randomBytes(32).toString("hex")}`, totalPaisa.toString(), status],
  );
}

/**
 * Rent owed to investors: the property manager pays the rent into escrow with a rent-collection
 * payment code (bank -> rent pool), then the distribution is booked (rent pool -> each payable).
 */
export async function rentOwed(w: World, tokenAddr: string, id: bigint, owed: { subjectId: string; amountPaisa: bigint }[]): Promise<void> {
  const total = owed.reduce((s, o) => s + o.amountPaisa, 0n);
  const pool = `rent:pool:${tokenAddr}`;
  await openAccount(w.db, { code: pool, kind: "liability", asset: "PKR" });
  const code = await w.bank.createIntent({ purpose: "rent_collection", subjectId: null, amountPaisa: total, ledgerKey: `rent:collected:${tokenAddr}:d${id.toString()}`, creditAccount: pool });
  const manager = newAccount(w, "Property Manager Ltd");
  const paid = await w.mock.receiveRaast({ payerIban: manager, amountPaisa: total, narration: `Rent ${code}` });
  if (paid.event?.status !== 200) throw new Error("rent payment not delivered");
  await postJournal(w.db, {
    idempotencyKey: `rent:distribution:${tokenAddr}:${id.toString()}`,
    kind: "rent_distribution",
    externalRef: `0x${randomBytes(32).toString("hex")}`,
    createdBy: "test",
    postings: [{ account: pool, amount: total }, ...owed.map((o) => ({ account: `rent:payable:${o.subjectId}`, amount: -o.amountPaisa }))],
  });
}

/** What reconciliation's cash check needs, read from the database plus a bank statement. */
export async function cashData(w: World, statements: Statement[]): Promise<ReconData> {
  const { rows } = await w.db.query<{ id: string; idempotency_key: string; kind: string; external_ref: string | null; created_at: Date; postings: [string, string][] }>(
    `SELECT j.id, j.idempotency_key, j.kind, j.external_ref, j.created_at,
            json_agg(json_build_array(a.code, p.amount::text) ORDER BY p.id) AS postings
     FROM ledger.journal j JOIN ledger.postings p ON p.journal_id = j.id JOIN ledger.accounts a ON a.id = p.account_id
     WHERE j.id IN (SELECT p2.journal_id FROM ledger.postings p2 JOIN ledger.accounts a2 ON a2.id = p2.account_id WHERE a2.code = $1)
     GROUP BY j.id ORDER BY j.id`,
    [ESCROW_LEDGER],
  );
  const journals: LedgerJournal[] = rows.map((r) => ({
    id: BigInt(r.id),
    key: r.idempotency_key,
    kind: r.kind,
    externalRef: r.external_ref,
    createdAt: r.created_at,
    postings: r.postings.map(([account, amount]) => ({ account, amount: BigInt(amount) })),
  }));
  const { rows: now } = await w.db.query<{ now: Date }>("SELECT now() AS now");
  return {
    asOf: now[0]?.now ?? new Date(),
    bank: {
      accounts: [{ account: ESCROW, ledgerAccount: ESCROW_LEDGER }],
      statements: statements.map((st, i) => ({
        id: BigInt(i + 1),
        account: st.account,
        date: st.date,
        opening: st.openingPaisa,
        closing: st.closingPaisa,
        lines: st.lines.map((l, n) => ({ lineNo: n + 1, valueDate: l.valueDate, amount: l.amountPaisa, reference: l.reference, counterparty: l.counterparty, balance: l.balancePaisa })),
      })),
      payoutFiles: new Map(),
    },
    ledger: { journals },
  } as unknown as ReconData;
}

/** Cash findings for today's mock bank statement. */
export async function cashFindings(w: World, statement?: Statement): Promise<string[]> {
  const { rows } = await w.db.query<{ d: string }>("SELECT to_char(now() AT TIME ZONE 'Asia/Karachi', 'YYYY-MM-DD') AS d");
  const st = statement ?? w.mock.statement(rows[0]?.d ?? "");
  return checkCash(await cashData(w, [st])).map((f) => `${f.check}: ${f.subject}`);
}

export async function escrowBalance(w: World): Promise<bigint> {
  const { rows } = await w.db.query<{ b: string }>("SELECT balance::text AS b FROM ledger.balances WHERE code = $1", [ESCROW_LEDGER]);
  return BigInt(rows[0]?.b ?? "0");
}

export async function today(w: World): Promise<string> {
  const { rows } = await w.db.query<{ d: string }>("SELECT to_char(now() AT TIME ZONE 'Asia/Karachi', 'YYYY-MM-DD') AS d");
  return rows[0]?.d ?? "";
}

export const refId = (): string => `0x${randomBytes(32).toString("hex")}`;

import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openAccount, postJournal } from "@pt/ledger";
import { buildStatement, dayStart, importStatement, pktDate, registerBankAccount } from "@pt/recon";
import type pg from "pg";
import { keccak256, stringToBytes } from "viem";

const addDaysPkt = (date: string, days: number): string => pktDate(new Date(dayStart(date).getTime() + days * 86_400_000));

/**
 * LOCAL / DEMO bookings so that a freshly set-up local stack reconciles with zero findings
 * (Step 5h, ADR 0010). Each one books what really happened, with evidence, under the ADR 0007 /
 * ADR 0009 key conventions; none of them excuses a difference (there is no exceptions list):
 *
 *  - seedLocal: chain/flow.py's scenario mint (60,000 tokens to Alice, refId 0xa1…a1) becomes
 *    Alice's seed subscription: a webdemo subscription row (the expected amount and wallet for
 *    reconciliation) and the `sub:<refId>:paid|settled` journals. Refused unless the read model
 *    shows exactly that mint.
 *  - bookRent: per distribution in the read model, the rent collected (`rent:collected:<token>:d<id>`,
 *    bank -> rent pool, when published) and, once finalized, the distribution
 *    (`rent:distribution:<token>:<id>`, pool -> each investor's payable, external_ref = statement
 *    hash), split exactly as the published statement whose hash the chain holds.
 *  - demoBankStatements: the demo bank's statements for the website's demo bank accounts, built
 *    from the website's own payment records (webdemo), not from the ledger, so reconciliation
 *    compares two independent records line by line.
 */

type Db = pg.Pool;

export interface Contracts {
  token: string;
  issuance: string;
  distributions: string;
}

// ------------------------------------------------------------------ seed: flow.py's mint

export const FLOW_REF_ID = `0x${"a1".repeat(32)}`;

export async function seedLocal(
  db: Db,
  o: { contracts: Contracts; alice: string; symbol?: string; navPaisa?: bigint; refId?: string; tokens?: bigint },
): Promise<"booked" | "already booked"> {
  const symbol = o.symbol ?? "GPF3";
  const refId = (o.refId ?? FLOW_REF_ID).toLowerCase();
  const tokens = o.tokens ?? 60_000n;
  const alice = o.alice.toLowerCase();
  const { rows: minted } = await db.query<{ account: string; amount: string; tx_hash: string }>(
    "SELECT account, amount::text, tx_hash FROM chain.issuances WHERE guard = $1 AND ref_id = $2 AND kind = 'mint'",
    [o.contracts.issuance.toLowerCase(), refId],
  );
  const m = minted[0];
  if (m?.account !== alice || BigInt(m.amount) !== tokens) {
    throw new Error(`the read model does not show the scenario mint (${tokens.toString()} to Alice with refId ${refId}); run the indexer first`);
  }
  const amount = tokens * (o.navPaisa ?? 50_000n);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows: inv } = await client.query<{ id: string }>(
      `INSERT INTO webdemo.investors (persona, display_name, wallet_address, kyc_status) VALUES ('ALICE', 'Alice (demo)', $1, 'verified')
       ON CONFLICT (persona) DO UPDATE SET persona = EXCLUDED.persona RETURNING id`,
      [alice],
    );
    const investorId = inv[0]?.id ?? "";
    const existing = await client.query<{ bank_ref: string; investor_id: string; tokens: string; amount_paisa: string }>(
      "SELECT bank_ref, investor_id, tokens::text, amount_paisa::text FROM webdemo.subscriptions WHERE ref_id = $1", [refId]);
    const prior = existing.rows[0];
    if (prior && (prior.investor_id !== investorId || BigInt(prior.tokens) !== tokens || BigInt(prior.amount_paisa) !== amount)) {
      throw new Error(`another subscription already uses refId ${refId}; nothing booked (operations must look at it)`);
    }
    const bankRef = existing.rows[0]?.bank_ref ?? `RAAST-DEMO-${randomBytes(6).toString("hex").toUpperCase()}`;
    const fresh = existing.rowCount === 0;
    if (fresh) {
      await client.query(
        `INSERT INTO webdemo.subscriptions (id, request_id, investor_id, symbol, tokens, amount_paisa, bank_ref, ref_id, status, mint_tx, note)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'done', $9, 'seed: chain/flow.py scenario mint')`,
        [randomUUID(), randomUUID(), investorId, symbol, tokens.toString(), amount.toString(), bankRef, refId, m.tx_hash],
      );
    }
    const investorAccount = `web:investor:${investorId}:subscription`;
    const capital = `web:property:${symbol.toLowerCase()}:capital`;
    await openAccount(client, { code: "web:bank:subscriptions", kind: "asset", asset: "PKR" });
    await openAccount(client, { code: investorAccount, kind: "liability", asset: "PKR" });
    await openAccount(client, { code: capital, kind: "equity", asset: "PKR" });
    await postJournal(client, {
      idempotencyKey: `sub:${refId}:paid`,
      kind: "subscription_paid",
      memo: `Seed subscription: ${tokens.toString()} ${symbol} (chain/flow.py scenario)`,
      externalRef: bankRef,
      createdBy: "seed:local",
      postings: [
        { account: "web:bank:subscriptions", amount },
        { account: investorAccount, amount: -amount },
      ],
    });
    await postJournal(client, {
      idempotencyKey: `sub:${refId}:settled`,
      kind: "subscription_settled",
      memo: `Seed subscription minted`,
      externalRef: m.tx_hash,
      createdBy: "seed:local",
      postings: [
        { account: investorAccount, amount },
        { account: capital, amount: -amount },
      ],
    });
    await client.query("COMMIT");
    return fresh ? "booked" : "already booked";
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

// ------------------------------------------------------------------ rent

export interface StatementFile {
  id: number;
  statementHash: string;
  statement: string;
  entitlements: { wallet: string; amountPaisa: number }[];
}

export interface RentReport {
  collected: bigint[];
  distributed: bigint[];
  /** Finalized distributions without a matching statement: nothing booked (reconciliation reports them). */
  missingStatement: bigint[];
}

/** Statement files written by chain/rent.py (`<token>-<id>.json`); undefined if there is none. */
export function statementReader(dir: string, token: string): (id: string) => StatementFile | undefined {
  return (id) => {
    if (!/^[1-9][0-9]{0,8}$/.test(id)) return undefined;
    const file = join(dir, `${token.toLowerCase()}-${id}.json`);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed directory, name built from a validated address and id
    if (!existsSync(file)) return undefined;
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const f = JSON.parse(readFileSync(file, "utf8")) as StatementFile;
    return String(f.id) === id ? f : undefined;
  };
}

export async function bookRent(db: Db, o: { contracts: Contracts; statement: (id: string) => StatementFile | undefined }): Promise<RentReport> {
  const token = o.contracts.token.toLowerCase();
  const report: RentReport = { collected: [], distributed: [], missingStatement: [] };
  const { rows } = await db.query<{ id: string; status: string; total_paisa: string; statement_hash: string }>(
    "SELECT id::text, status, total_paisa::text, statement_hash FROM chain.distributions WHERE registry = $1 AND token = $2 ORDER BY id",
    [o.contracts.distributions.toLowerCase(), token],
  );
  const pool = `rent:pool:${token}`;
  for (const d of rows) {
    if (d.status === "rejected") continue;
    const total = BigInt(d.total_paisa);
    const collectedKey = `rent:collected:${token}:d${d.id}`;
    const done = await db.query("SELECT 1 FROM ledger.journal WHERE idempotency_key = $1", [collectedKey]);
    if (done.rowCount === 0) {
      // The tenant's rent arrives in the trustee's escrow and is held for this distribution.
      await openAccount(db, { code: "bank:trustee-escrow", kind: "asset", asset: "PKR" });
      await openAccount(db, { code: pool, kind: "liability", asset: "PKR" });
      await postJournal(db, {
        idempotencyKey: collectedKey,
        kind: "rent_collected",
        memo: `Rent for distribution ${d.id} (demo collection)`,
        externalRef: `RENT-DEMO-${d.id}-${token.slice(2, 10).toUpperCase()}`,
        createdBy: "rent:book",
        postings: [
          { account: "bank:trustee-escrow", amount: total },
          { account: pool, amount: -total },
        ],
      });
      report.collected.push(BigInt(d.id));
    }
    if (d.status !== "finalized" && d.status !== "paid") continue;
    const key = `rent:distribution:${token}:${d.id}`;
    if ((await db.query("SELECT 1 FROM ledger.journal WHERE idempotency_key = $1", [key])).rowCount === 1) continue;
    const st = o.statement(d.id);
    // The split must be the statement the chain committed to, and add up to the on-chain total.
    const lines = st?.entitlements ?? [];
    const sum = lines.reduce((a, l) => a + BigInt(l.amountPaisa), 0n);
    if (!st || keccak256(stringToBytes(st.statement)) !== d.statement_hash || sum !== total) {
      report.missingStatement.push(BigInt(d.id));
      continue;
    }
    const postings: { account: string; amount: bigint }[] = [{ account: pool, amount: total }];
    for (const l of lines) {
      // Payable per KYC subject (ADR 0009); a wallet without a subject (demo personas) by wallet.
      const { rows: s } = await db.query<{ subject_id: string }>("SELECT subject_id FROM kyc.wallets WHERE wallet = $1", [l.wallet.toLowerCase()]);
      const account = s[0] ? `rent:payable:${s[0].subject_id}` : `rent:payable:wallet:${l.wallet.toLowerCase()}`;
      await openAccount(db, { code: account, kind: "liability", asset: "PKR" });
      postings.push({ account, amount: -BigInt(l.amountPaisa) });
    }
    await postJournal(db, { idempotencyKey: key, kind: "rent_distribution", memo: `Rent distribution ${d.id}`, externalRef: d.statement_hash, createdBy: "rent:book", postings });
    report.distributed.push(BigInt(d.id));
  }
  return report;
}

// ------------------------------------------------------------------ the demo bank's statements

/** The website's demo bank accounts: bank account -> ledger account. */
export const DEMO_BANK_ACCOUNTS = [
  { account: "WEB-DEMO-SUBSCRIPTIONS", ledger: "web:bank:subscriptions" },
  { account: "WEB-DEMO-CLIENT-MONEY", ledger: "web:bank:client-money" },
] as const;

/**
 * Builds and imports one statement per account and PKT day, from the first day with a payment up
 * to `through` (default: today), from the website's payment records. Days already imported are
 * skipped. Returns how many statements were imported.
 */
export async function demoBankStatements(db: Db, o: { actor: string; through?: string }): Promise<number> {
  const exists = await db.query<{ ok: boolean }>("SELECT to_regclass('webdemo.subscriptions') IS NOT NULL AS ok");
  if (exists.rows[0]?.ok !== true) return 0;
  type Line = { at: Date; amount: bigint; ref: string; who: string };
  const records = new Map<string, Line[]>([
    [
      "WEB-DEMO-SUBSCRIPTIONS",
      [
        ...(await db.query<{ created_at: Date; amount_paisa: string; bank_ref: string }>("SELECT created_at, amount_paisa::text, bank_ref FROM webdemo.subscriptions")).rows.map((r) => ({
          at: r.created_at, amount: BigInt(r.amount_paisa), ref: r.bank_ref, who: "Investor subscription (Raast)",
        })),
        ...(await db.query<{ updated_at: Date; amount_paisa: string; bank_ref: string }>("SELECT updated_at, amount_paisa::text, bank_ref FROM webdemo.subscriptions WHERE status = 'refunded'")).rows.map((r) => ({
          at: r.updated_at, amount: -BigInt(r.amount_paisa), ref: r.bank_ref, who: "Refund to investor (Raast)",
        })),
      ],
    ],
    [
      "WEB-DEMO-CLIENT-MONEY",
      (await db.query<{ created_at: Date; amount_paisa: string; bank_ref: string }>("SELECT created_at, amount_paisa::text, bank_ref FROM webdemo.topups")).rows.map((r) => ({
        at: r.created_at, amount: BigInt(r.amount_paisa), ref: r.bank_ref, who: "Investor cash top-up (Raast)",
      })),
    ],
  ]);
  const through = o.through ?? pktDate(new Date());
  let imported = 0;
  for (const a of DEMO_BANK_ACCOUNTS) {
    const lines = (records.get(a.account) ?? []).sort((x, y) => x.at.getTime() - y.at.getTime());
    const first = lines[0];
    if (!first) continue;
    await registerBankAccount(db, a.account, a.ledger, o.actor);
    const { rows: last } = await db.query<{ d: string; closing: string }>(
      "SELECT statement_date::text AS d, closing_paisa::text AS closing FROM recon.bank_statements WHERE account = $1 ORDER BY statement_date DESC LIMIT 1",
      [a.account],
    );
    let opening = BigInt(last[0]?.closing ?? "0");
    let day = last[0] ? addDaysPkt(last[0].d, 1) : pktDate(first.at);
    while (day <= through) {
      const st = buildStatement(a.account, day, opening, lines.filter((l) => pktDate(l.at) === day).map((l) => ({ valueDate: day, amountPaisa: l.amount, reference: l.ref, counterparty: l.who })));
      await importStatement(db, st, o.actor);
      imported++;
      opening = st.closingPaisa;
      day = addDaysPkt(day, 1);
    }
  }
  return imported;
}

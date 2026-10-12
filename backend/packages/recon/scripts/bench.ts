/**
 * Reconciliation speed at a realistic size, in a THROW-AWAY database (npm run recon:bench [-- subscriptions]).
 * Builds N paid + settled subscriptions (ledger, outbox commands), N mints on a fake chain indexed by
 * the real indexer, a bank statement with N lines, then times full runs (with and without the
 * indexer's rebuild). Nothing touches property_token or the local chain.
 */
import { fileURLToPath } from "node:url";
import { openAccount } from "@pt/ledger";
import pg from "pg";
import { keccak256, toHex } from "viem";
import { migrate } from "../../db/src/migrate.ts";
import { scratchDatabase } from "../../db/test/helpers.ts";
import { Indexer, verify } from "../../indexer/src/index.ts";
import { FakeChain, fakeDeployment } from "../../indexer/test/fake-chain.ts";
import { buildStatement, importStatement } from "../src/bank.ts";
import type { ChainState } from "../src/chain.ts";
import { pktDate } from "../src/conventions.ts";
import { reconcile } from "../src/run.ts";
import { registerBankAccount } from "../src/store.ts";

const N = Number(process.argv[2] ?? "10000");
const WALLETS = 2_000;
const BANK = "bench:bank:escrow";
const ZERO = "0x0000000000000000000000000000000000000000";
const wallet = (i: number): string => `0x${(0xbe000000 + (i % WALLETS)).toString(16).padStart(40, "0")}`;
const refId = (i: number): string => keccak256(toHex(`bench-subscription:${String(i)}`));

const s = await scratchDatabase();
const pool = new pg.Pool({ ...s.settings, max: 6 });
const t = (): number => performance.now();
const secs = (ms: number): string => `${(ms / 1000).toFixed(2)} s`;
try {
  await migrate(s.client, fileURLToPath(new URL("../../db/migrations", import.meta.url)));
  const chain = new FakeChain();
  const d = fakeDeployment(1n);
  const balances = new Map<string, bigint>();
  for (let i = 0; i < N; i += 50) {
    const events = [];
    for (let k = i; k < Math.min(N, i + 50); k++) {
      const amount = BigInt(1 + (k % 97));
      events.push({ role: "issuance" as const, name: "Minted", args: { to: wallet(k), amount, refId: refId(k) } });
      events.push({ role: "token" as const, name: "Transfer", args: { from: ZERO, to: wallet(k), value: amount } });
      balances.set(wallet(k), (balances.get(wallet(k)) ?? 0n) + amount);
    }
    chain.mine(d, events);
  }
  const supply = [...balances.values()].reduce((a, b) => a + b, 0n);
  const state: ChainState = {
    head: () => chain.head(),
    totalSupply: () => Promise.resolve(supply),
    balances: (_t, holders) => Promise.resolve(new Map(holders.map((h) => [h, balances.get(h) ?? 0n]))),
  };

  let t0 = t();
  const ix = new Indexer(pool, chain, d);
  await ix.register();
  await ix.catchUp();
  const indexMs = t() - t0;

  t0 = t();
  await openAccount(pool, { code: BANK, kind: "asset", asset: "PKR" });
  await openAccount(pool, { code: "bench:capital", kind: "equity", asset: "PKR" });
  await s.client.query("SELECT ledger.open_account('bench:investor:' || g, 'liability', 'PKR', false) FROM generate_series(0, $1::int - 1) g", [WALLETS]);
  for (let i = 0; i < N; i += 1_000) {
    const rows = [];
    for (let k = i; k < Math.min(N, i + 1_000); k++) {
      const paisa = (BigInt(1 + (k % 97)) * 1_000_000n).toString();
      const investor = `bench:investor:${String(k % WALLETS)}`;
      rows.push({ k: `sub:${refId(k)}:paid`, kind: "subscription_paid", ref: `RAAST-BENCH-${String(k).padStart(8, "0")}`, p: [{ account: BANK, amount: paisa }, { account: investor, amount: `-${paisa}` }] });
      rows.push({ k: `sub:${refId(k)}:settled`, kind: "subscription_settled", ref: `0x${String(k)}`, p: [{ account: investor, amount: paisa }, { account: "bench:capital", amount: `-${paisa}` }] });
    }
    await s.client.query(`SELECT ledger.post_journal(x.e->>'k', x.e->>'kind', null, x.e->>'ref', 'bench', x.e->'p')
      FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY AS x(e, n) ORDER BY x.n`, [JSON.stringify(rows)]);
    const cmds = [];
    for (let k = i; k < Math.min(N, i + 1_000); k++) cmds.push({ key: `mint:${refId(k)}`, payload: { issuance: d.contracts.issuance, to: wallet(k), amount: String(1 + (k % 97)), refId: refId(k) } });
    await s.client.query("SELECT outbox.enqueue(x.key, 'issuance.mint', x.payload, null, 'bench') FROM jsonb_to_recordset($1::jsonb) AS x(key text, payload jsonb)", [JSON.stringify(cmds)]);
  }
  // The commands were executed: mark them confirmed the way an administrator would for a bench.
  await s.client.query("ALTER TABLE outbox.commands DISABLE TRIGGER commands_guard");
  await s.client.query("UPDATE outbox.commands SET status = 'confirmed', tx_hash = '0x' || repeat('0', 64), tx_nonce = 0, tx_from = '0x' || repeat('0', 40)");
  await s.client.query("ALTER TABLE outbox.commands ENABLE TRIGGER commands_guard");
  const ledgerMs = t() - t0;

  t0 = t();
  await registerBankAccount(pool, "BENCH-ESCROW-01", BANK, "bench");
  const { rows } = await s.client.query<{ created_at: Date; external_ref: string; amount: string }>(
    `SELECT j.created_at, j.external_ref, p.amount::text FROM ledger.postings p JOIN ledger.journal j ON j.id = p.journal_id
     JOIN ledger.accounts a ON a.id = p.account_id WHERE a.code = $1 ORDER BY p.id`, [BANK]);
  let opening = 0n;
  for (const date of [...new Set(rows.map((r) => pktDate(r.created_at)))]) {
    const st = buildStatement("BENCH-ESCROW-01", date, opening, rows.filter((r) => pktDate(r.created_at) === date)
      .map((r) => ({ valueDate: date, amountPaisa: BigInt(r.amount), reference: r.external_ref, counterparty: "bench" })));
    await importStatement(pool, st, "bench");
    opening = st.closingPaisa;
  }
  const importMs = t() - t0;

  const runs: string[] = [];
  for (const withVerify of [false, true, false]) {
    const r = await reconcile(pool, {
      deployment: d, chain: state, actor: "bench",
      verifyIndexer: withVerify ? async () => {
        const v = await verify(pool, chain, d, { state: null });
        return { pinnedBlock: v.pinnedBlock, problems: v.problems };
      } : null,
    });
    if (r.findings.length) throw new Error(`bench data should be clean: ${JSON.stringify(r.findings.slice(0, 3))}`);
    runs.push(`${withVerify ? "with indexer verify" : "without verify"}: ${secs(r.ms)} ${JSON.stringify(r.summary.timings)}`);
  }
  process.stdout.write(`recon bench: ${String(N)} subscriptions, ${String(N * 2)} journals, ${String(N)} mints (${String(N * 2)} events), ${String(balances.size)} holders, ${String(rows.length)} bank lines\n` +
    `  setup: index ${secs(indexMs)}, ledger+outbox ${secs(ledgerMs)}, bank import ${secs(importMs)}\n${runs.map((x) => `  run ${x}`).join("\n")}\n`);
} finally {
  await pool.end();
  await s.drop();
}

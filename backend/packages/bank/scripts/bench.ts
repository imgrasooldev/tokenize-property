/**
 * KYC and bank speed in a THROW-AWAY database (npm run bank:bench [-- investors]).
 * Onboards N investors through the mock providers, books N Raast credits through the real HTTP
 * webhook endpoint (signature check, schema, database), then creates, approves and submits one
 * payout batch for all N investors and reconciles the day. Nothing touches property_token.
 */
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { KycService, mockProviders, Peppers } from "@pt/kyc";
import { openAccount, postJournal } from "@pt/ledger";
import { checkCash, type ReconData } from "@pt/recon";
import pg from "pg";
import { migrate } from "../../db/src/migrate.ts";
import { scratchDatabase } from "../../db/test/helpers.ts";
import { makeIban } from "../src/iban.ts";
import { MockBank } from "../src/mockbank.ts";
import { BankService, decidePayoutBatch } from "../src/service.ts";
import { createWebhookServer, SIGNATURE_HEADER } from "../src/webhook.ts";

const N = Number(process.argv[2] ?? "1000");
const s = await scratchDatabase();
const pool = new pg.Pool({ ...s.settings, max: 8 });
const t = (): number => performance.now();
const pct = (xs: number[], p: number): string => `${([...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))] ?? 0).toFixed(1)} ms`;
let target = "";
try {
  await migrate(s.client, fileURLToPath(new URL("../../db/migrations", import.meta.url)));
  const peppers = Peppers.of([{ version: 1, key: randomBytes(32) }]);
  const key = { id: "k1", secret: randomBytes(32) };
  const mock = new MockBank({
    account: "TRUSTEE-ESCROW-01",
    key,
    deliver: async (raw, sig) => (await fetch(target, { method: "POST", headers: { "content-type": "application/json", [SIGNATURE_HEADER]: sig }, body: raw })).status,
  });
  const kyc = new KycService(pool, mockProviders(), peppers, randomBytes(32));
  const bank = new BankService(pool, peppers, randomBytes(32), mock, { escrowAccount: "TRUSTEE-ESCROW-01" });
  const server = createWebhookServer(bank, [key]);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  target = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/v1/bank/events`;
  await s.client.query("SELECT recon.register_bank_account('TRUSTEE-ESCROW-01', 'bank:trustee-escrow', 'bench')");

  const onboard: number[] = [];
  const investors: { subjectId: string; iban: string }[] = [];
  for (let i = 0; i < N; i++) {
    const name = `Bench Investor ${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + (Math.floor(i / 26) % 26))}${String.fromCharCode(65 + (Math.floor(i / 676) % 26))}`;
    const t0 = t();
    const r = await kyc.onboard({ cnic: String(3_000_000_000_000 + i * 10 + 1), fullName: name, livenessSessionId: `sess-bench-${String(i).padStart(6, "0")}` });
    onboard.push(t() - t0);
    const iban = makeIban("MEZN", String(i).padStart(16, "0"));
    mock.openAccount(iban, name);
    await bank.registerPayee(r.subjectId, iban);
    await openAccount(s.client, { code: `rent:payable:${r.subjectId}`, kind: "liability", asset: "PKR" });
    await openAccount(s.client, { code: `investor:${r.subjectId}:subscriptions`, kind: "liability", asset: "PKR" });
    investors.push({ subjectId: r.subjectId, iban });
  }
  await s.client.query("ALTER TABLE bank.payees DISABLE TRIGGER payees_guard");
  await s.client.query("UPDATE bank.payees SET registered_at = registered_at - interval '73 hours', active_from = active_from - interval '73 hours'");
  await s.client.query("ALTER TABLE bank.payees ENABLE TRIGGER payees_guard");

  const ingest: number[] = [];
  const t1 = t();
  for (const inv of investors) {
    const code = await bank.createIntent({ purpose: "subscription", subjectId: inv.subjectId, amountPaisa: 100_000n, ledgerKey: `sub:0x${randomBytes(32).toString("hex")}:paid`, creditAccount: `investor:${inv.subjectId}:subscriptions` });
    const t0 = t();
    const r = await mock.receiveRaast({ payerIban: inv.iban, amountPaisa: 100_000n, narration: code });
    ingest.push(t() - t0);
    if (r.event?.status !== 200) throw new Error(`delivery failed: ${String(r.event?.status)}`);
  }
  const ingestTotal = t() - t1;

  const tok = `0x${randomBytes(20).toString("hex")}`;
  await openAccount(s.client, { code: `rent:pool:${tok}`, kind: "liability", asset: "PKR", allowOverdraft: true });
  await postJournal(s.client, { idempotencyKey: `rent:distribution:${tok}:1`, kind: "rent_distribution", externalRef: "0x00", createdBy: "bench", postings: [{ account: `rent:pool:${tok}`, amount: BigInt(N) * 1_000n }, ...investors.map((i) => ({ account: `rent:payable:${i.subjectId}`, amount: -1_000n }))] });
  await s.client.query("INSERT INTO chain.distributions (registry, id, token, record_block, merkle_root, total_paisa, statement_hash, status, published_block, updated_block) VALUES ('0xr', 1, $1, 1, '0x', $2, '0x', 'finalized', 1, 1)", [tok, (BigInt(N) * 1_000n).toString()]);
  const { rows } = await s.client.query<{ id: string }>("SELECT recon.start_run('bench', NULL, '{}') AS id");
  await s.client.query("SELECT recon.complete_run($1, 'bench', 0, '[]', '{}')", [rows[0]?.id]);
  const t2 = t();
  const batch = await bank.createPayoutBatch({ token: tok, distributionId: 1n, items: investors.map((i) => ({ subjectId: i.subjectId, amountPaisa: 1_000n })), createdBy: "bench:maker" });
  const tCreate = t() - t2;
  const t3 = t();
  await decidePayoutBatch(pool, batch, "bench:checker", "approve", "benchmark approval");
  const tApprove = t() - t3;
  const t4 = t();
  const sent = await bank.submitPayoutBatch(batch, mock);
  const tSubmit = t() - t4;

  const date = new Date(Date.now() + 5 * 3_600_000).toISOString().slice(0, 10);
  const st = mock.statement(date);
  const j = await s.client.query<{ id: string; idempotency_key: string; kind: string; external_ref: string | null; created_at: Date; postings: [string, string][] }>(
    `SELECT j.id, j.idempotency_key, j.kind, j.external_ref, j.created_at, json_agg(json_build_array(a.code, p.amount::text)) AS postings
     FROM ledger.journal j JOIN ledger.postings p ON p.journal_id = j.id JOIN ledger.accounts a ON a.id = p.account_id
     WHERE j.id IN (SELECT journal_id FROM ledger.postings WHERE account_id = (SELECT id FROM ledger.accounts WHERE code = 'bank:trustee-escrow')) GROUP BY j.id`,
  );
  const t5 = t();
  const findings = checkCash({
    asOf: new Date(),
    bank: {
      accounts: [{ account: "TRUSTEE-ESCROW-01", ledgerAccount: "bank:trustee-escrow" }],
      statements: [{ id: 1n, account: st.account, date: st.date, opening: st.openingPaisa, closing: st.closingPaisa, lines: st.lines.map((l, n) => ({ lineNo: n + 1, valueDate: l.valueDate, amount: l.amountPaisa, reference: l.reference, counterparty: l.counterparty, balance: l.balancePaisa })) }],
      payoutBatches: [],
    },
    ledger: { journals: j.rows.map((r) => ({ id: BigInt(r.id), key: r.idempotency_key, kind: r.kind, externalRef: r.external_ref, createdAt: r.created_at, postings: r.postings.map(([account, amount]) => ({ account, amount: BigInt(amount) })) })) },
  } as unknown as ReconData);
  const tCash = t() - t5;
  await new Promise<void>((r) => {
    server.close(() => {
      r();
    });
  });

  console.log(`investors: ${String(N)}`);
  console.log(`KYC onboarding (3 mock providers + database): p50 ${pct(onboard, 0.5)}, p99 ${pct(onboard, 0.99)}`);
  console.log(`Raast credit via signed HTTP webhook, booked in the ledger: p50 ${pct(ingest, 0.5)}, p99 ${pct(ingest, 0.99)}, ${(N / (ingestTotal / 1000)).toFixed(0)} credits/s incl. payment-code creation`);
  console.log(`payout batch of ${String(N)} lines: create ${(tCreate / 1000).toFixed(2)} s, approve ${(tApprove / 1000).toFixed(2)} s, submit (file + ledger) ${(tSubmit / 1000).toFixed(2)} s, file ${String(sent.file.length)} bytes`);
  console.log(`cash check on ${String(st.lines.length)} statement lines: ${tCash.toFixed(1)} ms, findings: ${String(findings.length)}`);
} finally {
  await pool.end();
  await s.drop();
}

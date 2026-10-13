import { createHash, randomBytes, randomUUID } from "node:crypto";
import { BankService, makeIban, MockBank, verifyWebhook, type WebhookKey } from "@pt/bank";
import { KycService, mockProviders, Peppers } from "@pt/kyc";
import { approvedSponsor, makeWorld as makePropertyWorld, propertyIn, type World as PropertyWorld } from "../../property/test/world.ts";
import { runAction, type ActionInput, type ActionName, type ActionResult, type SubscriptionView, type Terms } from "../src/service.ts";

/**
 * A scratch database at the latest migration with the S-01 officers (property world), KYC, the bank
 * service with a mock bank, the S-02 officers, and helpers that stand in for the chain read model
 * (written by the indexer in production). Time is moved by test-only UPDATEs with the guard
 * triggers disabled on the scratch database; production has no such path.
 */

export const OF = {
  maker: "off-maker",
  checker: "off-checker",
  checker2: "off-checker-2",
  legalHead: "off-legal-head",
  compliance: "off-compliance",
  trustee: "off-trustee",
  bank1: "bank-op-1",
  bank2: "bank-op-2",
  bank3: "bank-op-3",
  admin1: "off-admin-1",
  admin2: "off-admin-2",
  system: "system:offering-clock",
} as const;

const DUTIES: [string, string][] = [
  [OF.maker, "offering"],
  [OF.checker, "offering"],
  [OF.checker2, "offering"],
  [OF.legalHead, "legal_head"],
  [OF.compliance, "compliance"],
  [OF.trustee, "trustee"],
  [OF.bank1, "bank_operator"],
  [OF.bank2, "bank_operator"],
  [OF.bank3, "bank_operator"],
];

export const ESCROW = "TRUSTEE-ESCROW-01";
const CHAIN_ID = 586586;

export interface World extends PropertyWorld {
  bank: BankService;
  mock: MockBank;
  ikyc: KycService;
  of: <K extends ActionName>(name: K, input: ActionInput<K>) => Promise<ActionResult<K>>;
}

export async function makeWorld(): Promise<World> {
  const pw = await makePropertyWorld();
  const peppers = Peppers.of([{ version: 1, key: randomBytes(32) }]);
  const key: WebhookKey = { id: "k1", secret: randomBytes(32) };
  const ikyc = new KycService(pw.pool, mockProviders(), peppers, randomBytes(32));
  const mock: MockBank = new MockBank({
    account: ESCROW,
    key,
    deliver: async (raw, sig) => {
      const check = verifyWebhook([key], sig, raw);
      if (!check.ok) return 401;
      return (await bank.handle(raw, check.keyId)).status;
    },
  });
  const bank: BankService = new BankService(pw.pool, peppers, randomBytes(32), mock, { escrowAccount: ESCROW });
  await pw.client.query("SELECT recon.register_bank_account($1, 'bank:trustee-escrow', 'operator:setup')", [ESCROW]);
  const w: World = { ...pw, bank, mock, ikyc, of: (name, input) => runAction(pw.pool, name, input) };
  for (const [actor, duty] of DUTIES) {
    const id = await w.of("requestDuty", { actor, duty: duty as "offering", by: OF.admin1, reason: "assigned by the operations head" });
    await w.of("decideDuty", { dutyId: id, by: OF.admin2, approve: true, reason: "checked against the HR record" });
  }
  return w;
}

export const hex32 = (): string => randomBytes(32).toString("hex");
export const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
const addr = (): string => `0x${randomBytes(20).toString("hex")}`;

// ------------------------------------------------------------------ chain read model stand-ins
export interface Deployment {
  id: string;
  token: string;
  issuance: string;
  identityRegistry: string;
  documents: string;
}

let block = 0;
async function nextBlock(w: World): Promise<{ n: number; hash: string }> {
  const { rows } = await w.client.query<{ n: number }>("SELECT coalesce(max(number), 0)::int + 1 AS n FROM chain.blocks");
  block = Math.max(block + 1, rows[0]?.n ?? 1);
  const hash = `0x${randomBytes(32).toString("hex")}`;
  await w.client.query("INSERT INTO chain.blocks (number, hash, parent_hash, block_time) VALUES ($1, $2, $3, now())", [block, hash, `0x${randomBytes(32).toString("hex")}`]);
  return { n: block, hash };
}

/** A deployed, paused token with its contracts, the trustee cap set and the offering documents anchored. */
export async function deployToken(w: World, opts: { cap: bigint; docs: string[] }): Promise<Deployment> {
  const d: Deployment = { id: `dep-${randomUUID().slice(0, 8)}`, token: addr(), issuance: addr(), identityRegistry: addr(), documents: addr() };
  await w.client.query("SELECT chain.register_deployment($1, $2, 0, $3::jsonb, NULL)", [
    d.id,
    CHAIN_ID,
    JSON.stringify({ token: d.token, issuance: d.issuance, identityRegistry: d.identityRegistry, documents: d.documents }),
  ]);
  await w.client.query("UPDATE chain.tokens SET trustee_cap = $2, paused = true WHERE token = $1", [d.token, opts.cap.toString()]);
  let i = 1;
  for (const doc of opts.docs) {
    await w.client.query(
      "INSERT INTO chain.documents (registry, id, token, doc_type, sha256_hash, uri, added_block, updated_block) VALUES ($1, $2, $3, 0, $4, 'vault://offering', 0, 0)",
      [d.documents, i++, d.token, `0x${doc}`],
    );
  }
  return d;
}

/** The indexer saw IssuanceGuard mint `units` to `wallet` under `refId`. */
export async function mintOnChain(w: World, d: Deployment, refId: string, wallet: string, units: bigint): Promise<string> {
  const b = await nextBlock(w);
  const tx = `0x${randomBytes(32).toString("hex")}`;
  await w.client.query(
    `INSERT INTO chain.events (deployment, block_number, log_index, block_hash, tx_hash, tx_index, address, contract, name, args, topics, data)
     VALUES ($1, $2, 0, $3, $4, 0, $5, 'issuance', 'Minted', '{}'::jsonb, '{}', '0x')`,
    [d.id, b.n, b.hash, tx, d.issuance],
  );
  await w.client.query(
    "INSERT INTO chain.issuances (guard, ref_id, kind, account, amount, deployment, block_number, log_index, tx_hash) VALUES ($1, $2, 'mint', $3, $4, $5, $6, 0, $7)",
    [d.issuance, refId, wallet, units.toString(), d.id, b.n, tx],
  );
  await w.client.query(
    `INSERT INTO chain.holdings (token, holder, balance, updated_block) VALUES ($1, $2, $3, $4)
     ON CONFLICT (token, holder) DO UPDATE SET balance = chain.holdings.balance + EXCLUDED.balance, updated_block = EXCLUDED.updated_block`,
    [d.token, wallet, units.toString(), b.n],
  );
  await w.client.query("UPDATE chain.tokens SET total_supply = total_supply + $2, updated_block = $3 WHERE token = $1", [d.token, units.toString(), b.n]);
  await w.client.query("UPDATE chain.cursors SET block_number = $2, block_hash = $3 WHERE deployment = $1", [d.id, b.n, b.hash]);
  return tx;
}

// ------------------------------------------------------------------ investors
export interface Investor {
  subjectId: string;
  name: string;
  iban: string;
  wallet: string;
}

let seq = Math.floor(Math.random() * 100_000);
const letters = (n: number): string =>
  String(n)
    .split("")
    .map((c) => "ABCDEFGHIJ".charAt(Number(c)))
    .join("");

/** A KYC-verified investor with a bound wallet registered on the token's identity registry and a bank account. */
export async function investor(w: World, d: Deployment, opts: { registered?: boolean; payee?: boolean } = {}): Promise<Investor> {
  const n = ++seq;
  const name = `Investor ${letters(n)}`;
  const wallet = addr();
  const r = await w.ikyc.onboard({ cnic: `35202${String(1_000_000 + n).slice(-7)}${String(1 + (n % 7))}`, fullName: name, livenessSessionId: `sess-good-${String(n).padStart(6, "0")}`, wallet });
  if (r.status !== "verified") throw new Error(`test investor not verified: ${r.reason}`);
  const iban = makeIban("MEZN", String(n).padStart(16, "0"));
  w.mock.openAccount(iban, name);
  if (opts.payee !== false) await w.bank.registerPayee(r.subjectId, iban);
  if (opts.registered !== false) {
    await w.client.query("INSERT INTO chain.investors (registry, wallet, identity, country, registered, updated_block) VALUES ($1, $2, $3, 586, true, 0)", [
      d.identityRegistry,
      wallet,
      addr(),
    ]);
  }
  return { subjectId: r.subjectId, name, iban, wallet };
}

/** OF-10: the investor accepts the English offering document and the risk disclosure. */
export async function accept(w: World, offeringId: string, inv: Investor, docs: Docs): Promise<void> {
  const common = { offeringId, subjectId: inv.subjectId, sessionHash: hex32(), deviceHash: hex32(), actor: `investor:${inv.subjectId}` };
  await w.of("acceptDocument", { ...common, kind: "offering_document", language: "en", sha256: docs.en });
  await w.of("acceptDocument", { ...common, kind: "risk_disclosure", language: "en", sha256: docs.risk });
}

export async function reserve(w: World, offeringId: string, inv: Investor, units: bigint, key = `idem-${randomUUID()}`): Promise<SubscriptionView> {
  return w.of("reserve", { offeringId, subjectId: inv.subjectId, units, idempotencyKey: key, actor: `investor:${inv.subjectId}` });
}

/** The investor pays by Raast with the payment code in the narration (from their account, unless another is given). */
export async function pay(w: World, inv: Investor, code: string | null, amountPaisa: bigint, fromIban = inv.iban): Promise<string> {
  const r = await w.mock.receiveRaast({ payerIban: fromIban, amountPaisa, narration: code ? `Subscription ${code}` : "no code" });
  return r.raastRef;
}

// ------------------------------------------------------------------ offerings
export interface Docs {
  en: string;
  ur: string;
  risk: string;
}

export interface Offering {
  id: string;
  propertyId: string;
  d: Deployment;
  docs: Docs;
  price: bigint;
  cap: bigint;
}

export interface OfferingOpts {
  cap?: bigint;
  price?: bigint;
  minUnits?: bigint;
  maxUnits?: bigint;
  reservationMinutes?: number;
  earlyClose?: boolean;
}

export function terms(o: { cap: bigint; price: bigint; minUnits: bigint; maxUnits: bigint; docs: Docs; reservationMinutes?: number; earlyClose?: boolean }): Terms {
  const total = o.cap * o.price;
  const costs = total / 20n;
  return {
    pricePaisa: o.price,
    minRaiseUnits: o.cap,
    targetUnits: o.cap,
    hardCapUnits: o.cap,
    minUnits: o.minUnits,
    maxUnits: o.maxUnits,
    opensAt: new Date(Date.now() - 60_000).toISOString(),
    closesAt: new Date(Date.now() + 10 * 86_400_000).toISOString(),
    useOfProceeds: [
      { line: "purchase_price", paisa: total - costs },
      { line: "stamp_duty_registration", paisa: costs },
    ],
    docEnSha: o.docs.en,
    docUrSha: o.docs.ur,
    riskSha: o.docs.risk,
    ...(o.reservationMinutes ? { reservationMinutes: o.reservationMinutes } : {}),
    ...(o.earlyClose === undefined ? {} : { earlyClose: o.earlyClose }),
  };
}

/** A property through S-01 to Tokenization Ready, then an offering created and submitted (L1). */
export async function submittedOffering(w: World, opts: OfferingOpts = {}): Promise<Offering & { l3: bigint }> {
  const s = await approvedSponsor(w);
  const propertyId = await propertyIn(w, s, "tokenization_ready");
  const docs: Docs = { en: hex32(), ur: hex32(), risk: hex32() };
  const cap = opts.cap ?? 1000n;
  const price = opts.price ?? 100_000n;
  const id = await w.of("createOffering", {
    propertyId,
    actor: OF.maker,
    terms: terms({ cap, price, minUnits: opts.minUnits ?? 10n, maxUnits: opts.maxUnits ?? cap / 2n, docs, ...opts }),
  });
  const l3 = await w.of("submit", { offeringId: id, actor: OF.maker, reason: "terms complete, documents attached" });
  return { id, propertyId, d: undefined as unknown as Deployment, docs, price, cap, l3 };
}

/** L3 by the four approvers, L4 against a deployed token, L5 by the clock. */
export async function liveOffering(w: World, opts: OfferingOpts = {}): Promise<Offering> {
  const o = await submittedOffering(w, opts);
  for (const officer of [OF.checker, OF.legalHead, OF.compliance, OF.trustee]) {
    await w.of("decide", { requestId: o.l3, officer, approve: true, reason: "reviewed and approved" });
  }
  const d = await deployToken(w, { cap: o.cap, docs: [o.docs.en, o.docs.ur] });
  await w.of("markReady", { offeringId: o.id, token: d.token, actor: OF.maker });
  const t = await w.of("tick", { offeringId: o.id, actor: OF.system });
  if (t.state !== "live") throw new Error(`offering did not open: ${JSON.stringify(t)}`);
  return { ...o, d };
}

// ------------------------------------------------------------------ time (TEST ONLY: guard triggers disabled on the scratch database)
async function withTriggersOff(w: World, tables: string[], f: () => Promise<void>): Promise<void> {
  for (const t of tables) await w.client.query(`ALTER TABLE ${t} DISABLE TRIGGER USER`);
  try {
    await f();
  } finally {
    for (const t of tables) await w.client.query(`ALTER TABLE ${t} ENABLE TRIGGER USER`);
  }
}

/** Moves a reservation (and its payment code) past its expiry. */
export async function ageReservation(w: World, subscriptionId: string): Promise<void> {
  await withTriggersOff(w, ["offering.subscriptions", "bank.payment_intents"], async () => {
    await w.client.query("UPDATE bank.payment_intents SET created_at = now() - interval '2 days', expires_at = now() - interval '1 second' WHERE code = (SELECT intent_code FROM offering.subscriptions WHERE id = $1)", [subscriptionId]);
    await w.client.query("UPDATE offering.subscriptions SET expires_at = now() - interval '1 second' WHERE id = $1", [subscriptionId]);
  });
}

/** Moves the close time (and the payment grace) into the past, as if the offering period ended. */
export async function ageClose(w: World, offeringId: string): Promise<void> {
  await withTriggersOff(w, ["offering.offerings"], async () => {
    await w.client.query(
      `UPDATE offering.offerings SET opens_at = now() - interval '30 days', closes_at = now() - interval '20 days',
              extended_close_at = CASE WHEN extended_close_at IS NULL THEN NULL ELSE now() - interval '1 day' END WHERE id = $1`,
      [offeringId],
    );
  });
}

/** Moves the completion deadline into the past. */
export async function ageDeadline(w: World, offeringId: string): Promise<void> {
  await withTriggersOff(w, ["offering.offerings"], async () => {
    await w.client.query("UPDATE offering.offerings SET completion_deadline = now() - interval '1 minute' WHERE id = $1", [offeringId]);
  });
}

/** Moves a refund-pending window past the refund SLA (for the recon overdue check). */
export async function ageFailure(w: World, offeringId: string, hours: number): Promise<void> {
  await withTriggersOff(w, ["offering.offerings"], async () => {
    await w.client.query("UPDATE offering.offerings SET failed_at = failed_at - make_interval(hours => $2) WHERE id = $1", [offeringId, hours]);
  });
}

/** A reconciliation run that passed now (opens the payout gate, ADR 0007 R-4). */
export async function passRecon(w: World): Promise<void> {
  const { rows } = await w.client.query<{ id: string }>("SELECT recon.start_run('test', NULL, '{}') AS id");
  await w.client.query("SELECT recon.complete_run($1, 'test', 0, '[]', '{}')", [rows[0]?.id]);
}

export async function subState(w: World, subscriptionId: string): Promise<string> {
  const { rows } = await w.client.query<{ state: string }>("SELECT state FROM offering.subscriptions WHERE id = $1", [subscriptionId]);
  return rows[0]?.state ?? "unknown";
}

export async function offeringState(w: World, offeringId: string): Promise<string> {
  const { rows } = await w.client.query<{ state: string }>("SELECT state FROM offering.offerings WHERE id = $1", [offeringId]);
  return rows[0]?.state ?? "unknown";
}

export async function units(w: World, offeringId: string): Promise<{ held: bigint; reserved: bigint; paid: bigint; waitlisted: bigint }> {
  const { rows } = await w.client.query<{ held: string; reserved: string; paid: string; waitlisted: string }>("SELECT * FROM offering.units($1)", [offeringId]);
  const r = rows[0];
  return { held: BigInt(r?.held ?? 0), reserved: BigInt(r?.reserved ?? 0), paid: BigInt(r?.paid ?? 0), waitlisted: BigInt(r?.waitlisted ?? 0) };
}

/** Sum of ledger journals by phase for the subscriptions of an offering (paisa). */
export async function money(w: World, offeringId: string): Promise<{ paid: bigint; refunded: bigint; settled: bigint; held: bigint }> {
  const { rows } = await w.client.query<{ phase: string; total: string }>(
    `SELECT split_part(j.idempotency_key, ':', 3) AS phase, coalesce(sum(p.amount), 0)::text AS total
     FROM offering.subscriptions s
     JOIN ledger.journal j ON j.idempotency_key IN ('sub:' || s.ref_id || ':paid', 'sub:' || s.ref_id || ':refunded', 'sub:' || s.ref_id || ':settled')
     JOIN ledger.postings p ON p.journal_id = j.id AND p.amount > 0
     WHERE s.offering_id = $1 GROUP BY 1`,
    [offeringId],
  );
  const get = (k: string): bigint => BigInt(rows.find((r) => r.phase === k)?.total ?? "0");
  const { rows: held } = await w.client.query<{ held: string }>(
    `SELECT coalesce(sum(amount_paisa), 0)::text AS held FROM offering.subscriptions
     WHERE offering_id = $1 AND paid_journal IS NOT NULL AND settled_journal IS NULL AND refund_journal IS NULL`,
    [offeringId],
  );
  return { paid: get("paid"), refunded: get("refunded"), settled: get("settled"), held: BigInt(held[0]?.held ?? "0") };
}

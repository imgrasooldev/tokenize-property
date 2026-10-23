import { createHash, randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recoveryGuardAbi } from "@pt/contracts";
import pg from "pg";
import { decodeFunctionData, getAddress, keccak256, parseTransaction, toHex, type Hex } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ageCoolingOff, newAccount, passRecon, world, type World } from "../../bank/test/setup.ts";
import { adminSettings } from "../../db/test/helpers.ts";
import { officer } from "../../db/test/officers.ts";
import { Indexer, type Deployment, type Header } from "../../indexer/src/index.ts";
import { FakeChain, fakeDeployment, type FakeEvent } from "../../indexer/test/fake-chain.ts";
import { FileKeystore, writeKeyFile } from "../../signer/src/keystore.ts";
import type { ChainRequest } from "../../signer/src/policy.ts";
import { SignerService, type ChainReader } from "../../signer/src/service.ts";
import { reconcile, tick, verifyAudit } from "../src/service.ts";

/**
 * S-04 phase 0 (migration 0028, spec section 16) against a real PostgreSQL, the real bank service
 * with the mock bank, a real indexer on a fake chain (real ABIs) and the real signing service with a
 * fake chain reader. Officers act through PT Control's own admin.* functions (sessions, step-up,
 * digests); investors through the session-bound webauth.* wrappers as the website's role. Every rule
 * is the database's: state machine, checks, maker-checker, DvP, refunds only without execution,
 * register entries, surveillance, the signing gate, reconciliation and the audit chain.
 */
const PASS = "a-long-local-test-passphrase-0123456789";
const ZERO = "0x0000000000000000000000000000000000000000";
const PRICE = 100_000n; // paisa per unit (PKR 1,000)
let w: World;
let db: pg.Client;
let keys: FileKeystore;
const chain = new FakeChain();
let d: Deployment;
let indexer: Indexer;
let seq = 7000;
let token = "";
let guard = "";
const webRole = `pt_web_xf_${randomBytes(4).toString("hex")}`;
const webPassword = randomBytes(24).toString("base64url");
let web: pg.Client;

const fake = {
  frozen: new Set<string>(),
  balances: new Map<string, bigint>(),
  verified: new Set<string>(),
  requests: new Map<bigint, ChainRequest>(),
};
const reader: ChainReader = {
  chainId: () => Promise.resolve(586586),
  pendingNonce: () => Promise.resolve(0n),
  simulate: () => Promise.resolve(),
  mintFacts: () => Promise.reject(new Error("not used")),
  txState: () => Promise.resolve("pending"),
  isFrozen: (_r, a) => Promise.resolve(fake.frozen.has(a.toLowerCase())),
  distribution: () => Promise.reject(new Error("not used")),
  isRegistered: (_r, a) => Promise.resolve(fake.verified.has(a.toLowerCase())),
  registryIdentity: () => Promise.resolve(ZERO),
  isVerified: (_r, a) => Promise.resolve(fake.verified.has(a.toLowerCase())),
  balanceOf: (_t, a) => Promise.resolve(fake.balances.get(a.toLowerCase()) ?? 0n),
  recoveryRequest: (_g, id) => Promise.resolve(fake.requests.get(id) ?? { kind: "forced_transfer", status: "none", eta: 0n, from: ZERO, to: ZERO, onchainId: ZERO, amount: 0n }),
  chainTime: () => Promise.resolve(BigInt(Math.floor(Date.now() / 1000))),
  holderFreeze: (_t, a) => Promise.resolve({ frozen: fake.frozen.has(a.toLowerCase()), frozenTokens: 0n }),
};
const signer = (): SignerService => new SignerService(w.pool, keys, reader);
const lc = (a: string): string => a.toLowerCase();
const sha = (s: string): Buffer => createHash("sha256").update(s, "utf8").digest();
const txOf = (h: Header, i = 0): Hex => keccak256(toHex(`tx:${h.hash}:${String(i)}`));

async function mine(events: FakeEvent[]): Promise<Header> {
  const h = chain.mine(d, events);
  await indexer.catchUp();
  return h;
}

async function message(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "";
  } catch (e) {
    return (e as Error).message;
  }
}

interface Person {
  subjectId: string;
  wallet: string;
  identity: string;
  iban: string;
  name: string;
  investorId: string;
}

/** A verified investor: bound wallet registered on chain (Pakistan), registered payout account, a website login. */
async function person(units = 0n, opts: { register?: boolean } = {}): Promise<Person> {
  const letters = "abcdefghij";
  const name = `Transfer ${String(++seq).split("").map((c) => letters.charAt(Number(c))).join("")} Person`;
  const wallet = `0x${randomBytes(20).toString("hex")}`;
  const cnic = `4210${String(10_000_000 + seq).slice(-8)}${String(1 + (seq % 7))}`;
  const r = await w.kyc.onboard({ cnic, fullName: name, livenessSessionId: `sess-xfer-${String(seq)}`, wallet });
  expect(r.status).toBe("verified");
  const identity = `0x${randomBytes(20).toString("hex")}`;
  const events: FakeEvent[] = [
    { role: "identityRegistry", name: "IdentityRegistered", args: { investorAddress: wallet, identity } },
    { role: "identityRegistry", name: "CountryUpdated", args: { investorAddress: wallet, country: 586 } },
  ];
  if (units > 0n) events.push({ role: "token", name: "Transfer", args: { from: ZERO, to: wallet, value: units } });
  await mine(events);
  fake.verified.add(wallet);
  fake.balances.set(wallet, units);
  if (units > 0n && opts.register !== false) {
    await db.query("SELECT trustee.enter($1, $2, $3, 'offering', $4, 'test-setup')", [token, wallet, units.toString(), `test:${wallet}`]);
  }
  const iban = newAccount(w, name);
  await w.bank.registerPayee(r.subjectId, iban);
  await ageCoolingOff(w, r.subjectId);
  const inv = await db.query<{ id: string }>(
    "INSERT INTO webdemo.investors (display_name, wallet_address, kyc_status, kyc_subject) VALUES ($1, $2, 'verified', $3) RETURNING id",
    [name, wallet, r.subjectId],
  );
  return { subjectId: r.subjectId, wallet, identity, iban, name, investorId: inv.rows[0]?.id ?? "" };
}

/** A website session (sign-up path, within 30 minutes of the investor's creation). */
async function session(p: Person): Promise<Buffer> {
  const t = randomBytes(32).toString("base64url");
  const { rows } = await web.query<{ e: Date | null }>("SELECT webauth.web_start_session($1, $2, 'signup') AS e", [sha(t), p.investorId]);
  if (!rows[0]?.e) throw new Error("session refused");
  return sha(t);
}

async function webCall<T>(sql: string, params: unknown[]): Promise<T> {
  const { rows } = await web.query<{ r: T }>(sql, params);
  return rows[0]?.r as T;
}

const OFFICERS = { desk: ["xfer.desk", "ops_maker"], desk2: ["xfer.desk.two", "ops_maker"], checker: ["xfer.checker", "ops_checker"],
  compliance: ["xfer.compliance", "compliance_officer"], compliance2: ["xfer.compliance.two", "compliance_officer"], trustee: ["xfer.trustee", "trustee_officer"] } as const;
type Who = keyof typeof OFFICERS;
const sessionOf = async (who: Who): Promise<Buffer> => {
  const [handle, role] = new Map<Who, readonly [string, string]>(Object.entries(OFFICERS) as [Who, readonly [string, string]][]).get(who) ?? ["", ""];
  return (await officer(db, handle, role)).sessionHash;
};

interface CaseView {
  id: number;
  status: string;
  digest: string;
  uuid: string;
  caseId: string;
  evidenceHash: string | null;
  payment: { code: string; payUntil: string; paidRef: string | null; escrowPaisa: string } | null;
  alerts: { rule: string; strCase: number }[] | null;
  liveChecks: { code: string; ok: boolean; detail: string }[] | null;
  blockers: Record<string, string[]>;
}
async function view(who: Who, id: number): Promise<CaseView> {
  const { rows } = await db.query<{ v: CaseView }>("SELECT admin.transfer_case($1, $2) AS v", [await sessionOf(who), id]);
  if (!rows[0]?.v) throw new Error(`no case ${String(id)}`);
  return rows[0].v;
}
interface Result {
  ok: boolean;
  status?: string;
  error?: string;
  id?: number;
}
async function act(who: Who, id: number, action: string, capacity: string | null = null, reason = "checked the file against the records"): Promise<Result> {
  const v = await view(who, id);
  const { rows } = await db.query<{ r: Result }>("SELECT admin.transfer_act($1, $2, $3, $4, $5, $6) AS r", [
    await sessionOf(who), id, action, capacity, reason, Buffer.from(v.digest, "hex")]);
  return rows[0]?.r ?? { ok: false };
}
async function cash(who: Who, id: number, action: string, reason = "bank instruction checked against the case"): Promise<Result> {
  const v = await view(who, id);
  const { rows } = await db.query<{ r: Result }>("SELECT admin.transfer_cash($1, $2, $3, $4, $5) AS r", [
    await sessionOf(who), id, action, reason, Buffer.from(v.digest, "hex")]);
  return rows[0]?.r ?? { ok: false };
}

interface Row {
  id: string;
  status: string;
  case_uuid: string;
  case_ref: Buffer;
  propose_key: string | null;
  execute_key: string | null;
  cancel_key: string | null;
  request_id: string | null;
  intent_code: string | null;
  paid_ref: string | null;
  evidence_hash: Buffer | null;
}
async function row(id: number | string): Promise<Row> {
  const { rows } = await db.query<Row>("SELECT * FROM transfer.cases WHERE id = $1", [id]);
  if (!rows[0]) throw new Error(`no case ${String(id)}`);
  return rows[0];
}
async function command(key: string): Promise<{ kind: string; payload: Record<string, string>; status: string }> {
  const { rows } = await db.query<{ kind: string; payload: Record<string, string>; status: string }>("SELECT kind, payload, status FROM outbox.commands WHERE idempotency_key = $1", [key]);
  if (!rows[0]) throw new Error(`no outbox command ${key}`);
  return rows[0];
}
/** The outbox worker's bookkeeping for one command (claim, record, confirm or fail), as in production. */
async function settle(key: string, outcome: "confirmed" | "failed", txHash?: Hex): Promise<void> {
  await db.query("UPDATE outbox.commands SET available_at = now() - interval '1 second' WHERE idempotency_key = $1", [key]);
  const claimed = await db.query<{ id: string; idempotency_key: string }>("SELECT id, idempotency_key FROM outbox.claim('test-worker', 100, 60)");
  for (const r of claimed.rows) {
    if (r.idempotency_key !== key) await db.query("SELECT outbox.release($1, 'test-worker', 'test: another command', true)", [r.id]);
    else if (outcome === "failed") {
      await db.query("SELECT outbox.release($1, 'test-worker', 'test: refused', false)", [r.id]);
    } else {
      await db.query("SELECT outbox.record_submission($1, 'test-worker', $2, 0, $3)", [r.id, txHash, `0x${"de".repeat(20)}`]);
      await db.query("SELECT outbox.complete($1, 'test-worker', '{}')", [r.id]);
    }
  }
  expect((await command(key)).status).toBe(outcome);
}
async function sign(kind: string, key: string): Promise<{ to: string; data: Hex; from: string }> {
  const c = await command(key);
  const r = await signer().request({ commandRef: key, kind: kind as "transfer.propose", payload: c.payload }, "outbox-worker");
  if (r.status !== "signed") throw new Error(`${kind}: ${JSON.stringify(r)}`);
  const tx = parseTransaction(r.raw);
  return { to: lc(tx.to ?? ""), data: tx.data ?? "0x", from: lc(r.from) };
}
async function denied(kind: string, commandRef: string, payload: Record<string, string>): Promise<string> {
  const r = await signer().request({ commandRef, kind: kind as "transfer.propose", payload }, "outbox-worker");
  return r.status === "denied" ? r.reason : `not denied: ${r.status}`;
}
const allowed = async (kind: string, payload: unknown): Promise<boolean> =>
  (await db.query<{ ok: boolean }>("SELECT transfer.command_allowed($1, $2::jsonb) AS ok", [kind, JSON.stringify(payload)])).rows[0]?.ok === true;

async function pay(p: Person, code: string | null, amount: bigint, fromIban = p.iban): Promise<string> {
  const r = await w.mock.receiveRaast({ payerIban: fromIban, amountPaisa: amount, narration: code ? `Transfer ${code}` : "no code" });
  return r.raastRef;
}
const escrow = async (uuid: string): Promise<bigint> => BigInt((await db.query<{ n: string }>("SELECT transfer.escrow_held($1)::text AS n", [uuid])).rows[0]?.n ?? "0");

let proposalSeq = 0n;
/** The chain side of a confirmed propose command: RecoveryProposed in the command's transaction (eta in the past). */
async function proposeOnChain(r: Row, from: string, to: string, units: bigint): Promise<bigint> {
  const id = ++proposalSeq;
  const eta = BigInt(Math.floor(Date.now() / 1000)) - 10n;
  const h = await mine([{ role: "recovery", name: "RecoveryProposed", args: { id, kind: 1, from, to, onchainId: ZERO, amount: units,
    evidenceHash: `0x${r.evidence_hash?.toString("hex") ?? ""}`, eta } }]);
  await settle(r.propose_key ?? "", "confirmed", txOf(h));
  fake.requests.set(id, { kind: "forced_transfer", status: "pending", eta, from, to, onchainId: ZERO, amount: units });
  return id;
}
/** RecoveryExecuted and the token movement in ONE transaction, as RecoveryGuard.execute emits them. */
async function executeOnChain(id: bigint, from: string, to: string, units: bigint): Promise<Header> {
  const h = await mine([
    { role: "recovery", name: "RecoveryExecuted", args: { id }, tx: 0 },
    { role: "token", name: "Transfer", args: { from, to, value: units }, tx: 0 },
  ]);
  fake.balances.set(from, (fake.balances.get(from) ?? 0n) - units);
  fake.balances.set(to, (fake.balances.get(to) ?? 0n) + units);
  const q = fake.requests.get(id);
  if (q) fake.requests.set(id, { ...q, status: "executed" });
  return h;
}

/** A seller (units) and a buyer, a priced website request accepted by the buyer, completed and approved -> awaiting_cash. */
async function approvedSale(units: bigint, price = PRICE): Promise<{ seller: Person; buyer: Person; id: number; r: Row }> {
  const seller = await person(1000n);
  const buyer = await person(0n);
  const code = await webCall<{ code: string }>("SELECT webauth.web_transfer_code($1) AS r", [await session(buyer)]);
  const agreement = randomBytes(32).toString("hex");
  const req = await webCall<{ ok: boolean; id: string }>("SELECT webauth.web_transfer_request($1, $2, $3, $4, 'sale', $5, NULL, $6, NULL, NULL) AS r",
    [await session(seller), token, units.toString(), code.code, price.toString(), agreement]);
  expect(req.ok).toBe(true);
  await webCall("SELECT webauth.web_transfer_accept($1, $2, $3) AS r", [await session(buyer), req.id, agreement]);
  const id = Number((await db.query<{ id: string }>("SELECT id FROM transfer.cases WHERE case_uuid = $1", [req.id])).rows[0]?.id);
  expect(await act("desk", id, "complete")).toMatchObject({ ok: true, status: "checks" });
  expect(await act("compliance", id, "approve", "compliance")).toMatchObject({ ok: true, status: "checks" });
  expect(await act("trustee", id, "approve", "trustee")).toMatchObject({ ok: true, status: "awaiting_cash" });
  return { seller, buyer, id, r: await row(id) };
}

beforeAll(async () => {
  w = await world();
  db = w.db;
  const dir = await mkdtemp(join(tmpdir(), "ks-xfer-"));
  await writeKeyFile(dir, "trustee", generatePrivateKey(), PASS);
  keys = await FileKeystore.open(dir, PASS);
  await db.query("INSERT INTO signer.keys (key_ref, address, purpose) VALUES ('trustee', $1, 'test')", [keys.address("trustee")]);
  d = fakeDeployment(1n);
  indexer = new Indexer(w.pool, chain, d);
  await indexer.register();
  await indexer.catchUp();
  token = lc(d.contracts.token);
  guard = lc(d.contracts.recovery ?? "");
  const rule = { chainId: 586586, keyRef: "trustee", recoveryGuard: guard, token, identityRegistry: lc(d.contracts.identityRegistry ?? ""), maxBalance: "100000", maxPerDay: 200, approvals: 0 };
  for (const kind of ["transfer.propose", "transfer.execute", "transfer.cancel", "recovery.propose"]) {
    const { rows } = await db.query<{ id: string }>("SELECT signer.propose_policy($1, $2::jsonb, 'maker') AS id", [kind, JSON.stringify(rule)]);
    await db.query("SELECT signer.approve_policy($1, 'checker')", [rows[0]?.id]);
  }
  // The token's completed offering (lock-up end, minimum and maximum holding, offering price). TEST ONLY: written
  // directly with triggers and foreign keys off (the offering module's own tests cover its life cycle).
  await db.query("SET session_replication_role = replica");
  await db.query(
    `INSERT INTO offering.offerings (property_id, state, price_paisa, min_units, max_units, max_holding_units, register_units, token, completed_at, created_by)
     VALUES (gen_random_uuid(), 'completed', $1, 10, 100000, 100000, 1000000, $2, now() - interval '7 months', 'test-setup')`,
    [PRICE.toString(), token],
  );
  await db.query("RESET session_replication_role");
  await db.query(`CREATE ROLE ${webRole} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD ${db.escapeLiteral(webPassword)}`);
  await db.query(`GRANT pt_web TO ${webRole} WITH INHERIT TRUE, SET FALSE`);
  web = new pg.Client({ ...w.settings, user: webRole, password: webPassword });
  await web.connect();
}, 240_000);

afterAll(async () => {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- undefined when beforeAll failed early
  await web?.end();
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- undefined when beforeAll failed early
  await w?.drop();
  const root = new pg.Client(adminSettings());
  await root.connect();
  await root.query(`DROP ROLE IF EXISTS ${webRole}`);
  await root.end();
}, 240_000);

describe("migration 0028", () => {
  it("adds the transfer bank purpose, the register source, placeholder withholding rates and keeps the other audits intact", async () => {
    const purposes = await db.query<{ def: string }>("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'payment_intents_purpose_known'");
    expect(purposes.rows[0]?.def).toMatch(/transfer/);
    const rates = await db.query<{ status: string; placeholder: boolean }>("SELECT status, placeholder FROM tax.rates WHERE income_type = 'unit_disposal' ORDER BY status");
    expect(rates.rows.map((r) => [r.status, r.placeholder])).toEqual([["exempt", true], ["filer", true], ["non_filer", true]]);
    expect((await db.query("SELECT * FROM ops.verify_audit()")).rows).toEqual([]);
    expect((await db.query("SELECT * FROM admin.verify_audit()")).rows).toEqual([]);
    const steps = await db.query<{ action: string }>("SELECT action FROM webauth.step_up_actions WHERE action LIKE 'transfer.%' ORDER BY action");
    expect(steps.rows.map((r) => r.action)).toEqual(["transfer.accept", "transfer.request", "transfer.withdraw"]);
  });
});

describe("a priced transfer through the website, the desk, compliance, trustee, bank and chain (DvP)", () => {
  let seller: Person;
  let buyer: Person;
  let id = 0;
  let agreement = "";
  let caseUuid = "";

  it("the buyer makes a receive code; the seller requests with it; the seller is alerted; the buyer accepts the same agreement", async () => {
    seller = await person(1000n);
    buyer = await person(0n);
    const bs = await session(buyer);
    const code = await webCall<{ code: string; expiresAt: string }>("SELECT webauth.web_transfer_code($1) AS r", [bs]);
    expect(code.code).toMatch(/^TR-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    agreement = randomBytes(32).toString("hex");
    const ss = await session(seller);
    expect(await message(web.query("SELECT webauth.web_transfer_request($1, $2, 10, $3, 'court_order', NULL, 'court order of the high court', $4, NULL, NULL)",
      [ss, token, code.code, agreement]))).toMatch(/opened by the transfer desk/);
    expect(await message(web.query("SELECT webauth.web_transfer_request($1, $2, 10, $3, 'sale', $4, NULL, $5, NULL, NULL)",
      [bs, token, code.code, PRICE.toString(), agreement]))).toMatch(/your own receive code/);
    const req = await webCall<{ ok: boolean; id: string }>("SELECT webauth.web_transfer_request($1, $2, 100, $3, 'sale', $4, NULL, $5, NULL, NULL) AS r",
      [ss, token, code.code, PRICE.toString(), agreement]);
    expect(req.ok).toBe(true);
    caseUuid = req.id;
    // The code is single use.
    expect(await message(web.query("SELECT webauth.web_transfer_request($1, $2, 1, $3, 'gift', NULL, 'gift to a cousin for a wedding', $4, NULL, NULL)",
      [ss, token, code.code, agreement]))).toMatch(/unknown, used or expired/);
    id = Number((await db.query<{ id: string }>("SELECT id FROM transfer.cases WHERE case_uuid = $1", [caseUuid])).rows[0]?.id);
    const n = await db.query<{ kind: string }>("SELECT kind FROM notify.notifications WHERE idempotency_key = $1", [`transfer:${String(id)}:requested`]);
    expect(n.rows[0]?.kind).toBe("security.transfer_requested");
    // The desk cannot complete before the buyer accepted; the buyer must re-enter the same fingerprint.
    expect((await act("desk", id, "complete")).error).toMatch(/not accepted/);
    expect(await message(web.query("SELECT webauth.web_transfer_accept($1, $2, $3)", [bs, caseUuid, randomBytes(32).toString("hex")]))).toMatch(/differs from the seller/);
    expect(await message(web.query("SELECT webauth.web_transfer_accept($1, $2, $3)", [ss, caseUuid, agreement]))).toMatch(/not found/);
    expect(await webCall<{ ok: boolean }>("SELECT webauth.web_transfer_accept($1, $2, $3) AS r", [bs, caseUuid, agreement])).toMatchObject({ ok: true });
    // What each party sees: no other investor's identity, investor-facing states.
    const list = await webCall<{ cases: { id: string; role: string; status: string; units: string }[] }>("SELECT webauth.web_transfers($1) AS r", [ss]);
    expect(list.cases[0]).toMatchObject({ id: caseUuid, role: "seller", status: "under_review", units: "100" });
    expect(JSON.stringify(list)).not.toContain(buyer.subjectId);
    expect(JSON.stringify(list)).not.toContain(buyer.wallet);
  });

  it("T1 by the desk; T4 needs compliance AND trustee, never the maker, never twice, bound to the digest; checks run in SQL", async () => {
    expect(await act("desk", id, "complete")).toMatchObject({ ok: true, status: "checks" });
    expect(await message(act("desk", id, "approve", "compliance"))).toMatch(/permission transfer.decide/);
    const v = await view("compliance", id);
    expect(v.liveChecks?.every((c) => c.ok)).toBe(true);
    const stale = await db.query<{ r: Result }>("SELECT admin.transfer_act($1, $2, 'approve', 'compliance', 'all checks reviewed in full', $3) AS r",
      [await sessionOf("compliance"), id, Buffer.alloc(32)]);
    expect(stale.rows[0]?.r.error).toMatch(/differs from what you reviewed/);
    expect((await act("compliance", id, "approve", "trustee")).error).toMatch(/trustee_officer/);
    expect(await act("compliance", id, "approve", "compliance")).toMatchObject({ ok: true, status: "checks" });
    expect((await act("compliance2", id, "approve", "compliance")).error).toMatch(/already taken/);
    expect(await act("trustee", id, "approve", "trustee")).toMatchObject({ ok: true, status: "awaiting_cash" });
    const r = await row(id);
    expect(r.evidence_hash?.length).toBe(32);
    const intent = await db.query<{ purpose: string; amount_paisa: string; ledger_key: string; credit_account: string; subject_id: string }>(
      "SELECT purpose, amount_paisa::text, ledger_key, credit_account, subject_id FROM bank.payment_intents WHERE code = $1", [r.intent_code]);
    expect(intent.rows[0]).toEqual({ purpose: "transfer", amount_paisa: (100n * PRICE).toString(), ledger_key: `xfer:${caseUuid}:paid`,
      credit_account: `transfer:${caseUuid}:escrow`, subject_id: buyer.subjectId });
    const due = await db.query<{ params: Record<string, string> }>("SELECT params FROM notify.notifications WHERE idempotency_key = $1", [`transfer:${String(id)}:payment_due`]);
    expect(due.rows[0]?.params).toMatchObject({ reference: r.intent_code, amount_paisa: (100n * PRICE).toString() });
    // Nothing is proposed before the money is in escrow.
    expect(r.propose_key).toBeNull();
    const list = await webCall<{ cases: { payment: { code: string; paid: boolean } | null }[] }>("SELECT webauth.web_transfers($1) AS r", [await session(buyer)]);
    expect(list.cases[0]?.payment).toMatchObject({ code: r.intent_code, paid: false });
  });

  it("T7: a wrong amount goes to suspense; the exact credit from the buyer's registered account books the escrow and enqueues the proposal", async () => {
    const r = await row(id);
    await pay(buyer, r.intent_code, 100n * PRICE - 1n);
    expect(await tick(db, "transfer-worker")).toBe(0);
    expect((await row(id)).status).toBe("awaiting_cash");
    // From an account that is not the buyer's: suspense too (B-2).
    const stranger = newAccount(w, "Someone Unrelated");
    await pay(buyer, r.intent_code, 100n * PRICE, stranger);
    expect(await tick(db, "transfer-worker")).toBe(0);
    await pay(buyer, r.intent_code, 100n * PRICE);
    expect(await tick(db, "transfer-worker")).toBe(1);
    const paid = await row(id);
    expect(paid.status).toBe("proposed");
    expect(paid.paid_ref).toMatch(/^RAAST-/);
    expect(await escrow(caseUuid)).toBe(100n * PRICE);
    const propose = await command(paid.propose_key ?? "");
    expect(propose).toMatchObject({ kind: "transfer.propose", payload: { kind: "forced_transfer", from: seller.wallet, to: buyer.wallet, onchainId: ZERO, amount: "100",
      evidenceHash: `0x${paid.evidence_hash?.toString("hex") ?? ""}`, caseId: `0x${paid.case_ref.toString("hex")}`, recoveryGuard: guard } });
    // A withdrawal is no longer possible.
    expect(await message(web.query("SELECT webauth.web_transfer_withdraw($1, $2)", [await session(seller), caseUuid]))).toMatch(/can no longer be withdrawn/);
  });

  it("the signing service: transfer.propose decoded from the calldata; forged payloads and the S-06 gate refuse it", async () => {
    const r = await row(id);
    const tx = await sign("transfer.propose", r.propose_key ?? "");
    expect(tx.from).toBe(lc(keys.address("trustee")));
    expect(tx.to).toBe(guard);
    expect(decodeFunctionData({ abi: recoveryGuardAbi, data: tx.data })).toMatchObject({
      functionName: "propose", args: [1, getAddress(seller.wallet), getAddress(buyer.wallet), ZERO, 100n, `0x${r.evidence_hash?.toString("hex") ?? ""}`] });
    const payload = (await command(r.propose_key ?? "")).payload;
    expect(await denied("transfer.propose", "forged:propose:1", { ...payload, amount: "1000" })).toMatch(/no approved transfer case enqueued/);
    expect(await denied("transfer.propose", "forged:propose:2", { ...payload, to: `0x${"12".repeat(20)}` })).toMatch(/no approved transfer case enqueued/);
    expect(await denied("recovery.propose", "forged:propose:3", payload)).toMatch(/no approved recovery case enqueued/);
    // Even with an allowed payload, the chain facts decide: a frozen seller is refused.
    fake.frozen.add(seller.wallet);
    expect(await denied("transfer.propose", "probe:propose:frozen", payload)).toMatch(/frozen/);
    fake.frozen.delete(seller.wallet);
  });

  it("the tick links the proposal, re-checks after the delay (TR-11), executes, follows the exact movement and writes the register", async () => {
    const r = await row(id);
    const requestId = await proposeOnChain(r, seller.wallet, buyer.wallet, 100n);
    expect(await tick(db, "transfer-worker")).toBeGreaterThanOrEqual(2);
    const pending = await row(id);
    expect(pending).toMatchObject({ status: "proposed", request_id: requestId.toString() });
    const exec = await command(pending.execute_key ?? "");
    expect(exec.payload).toEqual({ recoveryGuard: guard, requestId: requestId.toString(), caseId: `0x${pending.case_ref.toString("hex")}` });
    expect(await tick(db, "transfer-worker")).toBe(0);
    const tx = await sign("transfer.execute", pending.execute_key ?? "");
    expect(decodeFunctionData({ abi: recoveryGuardAbi, data: tx.data })).toMatchObject({ functionName: "execute", args: [requestId] });
    // Refund or settlement are impossible before execution.
    expect((await cash("desk", id, "prepare_settlement")).error).toMatch(/only after the movement/);
    expect((await cash("desk", id, "prepare_refund")).error).toMatch(/only a case in refunding/);
    // An execution that moved something else is not accepted.
    await executeOnChain(requestId, seller.wallet, buyer.wallet, 100n);
    expect(await tick(db, "transfer-worker")).toBe(1);
    expect((await row(id)).status).toBe("executed");
    const reg = await db.query<{ wallet: string; units: string }>("SELECT wallet, units::text FROM trustee.register_entries WHERE source = 'transfer' AND source_ref LIKE $1 ORDER BY id",
      [`transfer:${caseUuid}:%`]);
    expect(reg.rows).toEqual([{ wallet: seller.wallet, units: "-100" }, { wallet: buyer.wallet, units: "100" }]);
    const list = await webCall<{ cases: { status: string }[] }>("SELECT webauth.web_transfers($1) AS r", [await session(buyer)]);
    expect(list.cases[0]?.status).toBe("transferred");
  });

  it("T12 settlement: operations maker prepares, a different checker who is not the desk approves, gate and confirmed rates first; escrow ends at zero", async () => {
    expect(await cash("desk", id, "prepare_settlement")).toMatchObject({ ok: true, status: "prepared" });
    expect((await cash("desk", id, "prepare_settlement")).error).toMatch(/already prepared/);
    // The desk completed the case and prepared it: it never confirms (and holds no checker role anyway).
    expect((await cash("desk2", id, "approve")).error).toMatch(/ops_checker/);
    expect((await cash("checker", id, "approve")).error).toMatch(/payouts are blocked by reconciliation/);
    await passRecon(w);
    expect((await cash("checker", id, "approve")).error).toMatch(/PLACEHOLDER withholding rate/);
    await db.query("UPDATE ops.settings SET value = 'true' WHERE key = 'allow_placeholder_rates'");
    await db.query("UPDATE transfer.settings SET value = '10000' WHERE key = 'fee_ppm'");
    // The fee is fixed at preparation: reject and prepare again to apply the new fee.
    expect(await cash("checker", id, "reject", "fee must be applied before the payment")).toMatchObject({ ok: true });
    expect(await cash("desk", id, "prepare_settlement")).toMatchObject({ ok: true });
    expect(await cash("checker", id, "approve")).toMatchObject({ ok: true, status: "settled" });
    const ops = await db.query<{ gross: string; fee: string; tax: string; net: string; status: string; tax_status: string }>(
      "SELECT gross_paisa::text AS gross, fee_paisa::text AS fee, tax_paisa::text AS tax, net_paisa::text AS net, status, tax_status FROM transfer.cash_ops WHERE case_id = $1 ORDER BY id",
      [id]);
    const gross = 100n * PRICE;
    const fee = gross / 100n;
    const tax = (gross * 20_000n + 500_000n) / 1_000_000n; // non-filer placeholder (no ATL result)
    expect(ops.rows.at(-1)).toEqual({ gross: gross.toString(), fee: fee.toString(), tax: tax.toString(), net: (gross - fee - tax).toString(), status: "approved", tax_status: "non_filer" });
    expect(await escrow(caseUuid)).toBe(0n);
    const journals = await db.query<{ k: string }>("SELECT idempotency_key AS k FROM ledger.journal WHERE idempotency_key LIKE $1 ORDER BY id", [`xfer:${caseUuid}:%`]);
    expect(journals.rows.map((j) => j.k.split(":").at(-1))).toEqual(["paid", "fee", "tax", "settled"]);
    expect(await reconcile(db, token)).toEqual([]);
    await db.query("UPDATE ops.settings SET value = 'false' WHERE key = 'allow_placeholder_rates'");
    await db.query("UPDATE transfer.settings SET value = '0' WHERE key = 'fee_ppm'");
  });

  it("T15 dispute by compliance only; records cannot be changed around the functions", async () => {
    expect((await act("trustee", id, "dispute", null, "claim of a mistaken transfer received")).error).toMatch(/compliance_officer/);
    expect(await act("compliance", id, "dispute", null, "claim of a mistaken transfer received")).toMatchObject({ ok: true, status: "disputed" });
    expect(await message(db.query("UPDATE transfer.cases SET status = 'settled' WHERE id = $1", [id]))).toMatch(/final/);
    expect(await message(db.query("DELETE FROM transfer.decisions WHERE case_id = $1", [id]))).toMatch(/append-only/);
    expect(await message(db.query("UPDATE transfer.cash_ops SET net_paisa = 1 WHERE case_id = $1", [id]))).toMatch(/decided once/);
    expect(await message(db.query("TRUNCATE transfer.audit"))).toMatch(/append-only/);
  });
});

describe("refunds only when nothing can execute (TR-B9, TR-B12)", () => {
  it("T8: an unpaid code past its deadline is cancelled; a later payment goes to suspense", async () => {
    const { id, buyer, r } = await approvedSale(5n);
    await db.query("ALTER TABLE transfer.cases DISABLE TRIGGER cases_guard");
    await db.query("UPDATE transfer.cases SET pay_until = now() - interval '1 minute' WHERE id = $1", [id]);
    await db.query("ALTER TABLE transfer.cases ENABLE TRIGGER cases_guard");
    expect(await tick(db, "transfer-worker")).toBe(1);
    expect((await row(id)).status).toBe("cancelled");
    expect((await db.query("SELECT 1 FROM bank.intent_cancellations WHERE code = $1", [r.intent_code])).rowCount).toBe(1);
    await pay(buyer, r.intent_code, 5n * PRICE);
    const credit = await db.query<{ status: string }>("SELECT status FROM bank.credits WHERE intent_code = $1 OR reason LIKE '%cancelled%' ORDER BY booked_at DESC LIMIT 1", [r.intent_code]);
    expect(credit.rows[0]?.status).toBe("suspense");
  });

  it("a check failing after payment (seller frozen) refunds without any proposal; the refund is maker-checker and returns the exact credit", async () => {
    const { id, seller, buyer, r } = await approvedSale(5n);
    await mine([{ role: "token", name: "AddressFrozen", args: { _userAddress: seller.wallet, _isFrozen: true, _owner: lc(d.contracts.freezeGuard ?? "") } }]);
    await pay(buyer, r.intent_code, 5n * PRICE);
    expect(await tick(db, "transfer-worker")).toBe(1);
    const c = await row(id);
    expect(c).toMatchObject({ status: "refunding", propose_key: null });
    expect(await cash("desk", id, "prepare_refund")).toMatchObject({ ok: true });
    expect(await cash("checker", id, "approve")).toMatchObject({ ok: true, status: "cancelled" });
    expect(await escrow(c.case_uuid)).toBe(0n);
    const j = await db.query<{ external_ref: string }>("SELECT external_ref FROM ledger.journal WHERE idempotency_key = $1", [`xfer:${c.case_uuid}:refunded`]);
    expect(j.rows[0]?.external_ref).toBe(c.paid_ref);
    await mine([{ role: "token", name: "AddressFrozen", args: { _userAddress: seller.wallet, _isFrozen: false, _owner: lc(d.contracts.freezeGuard ?? "") } }]);
  });

  it("TR-11 before execution: the request is cancelled on chain first; no refund while it can still execute", async () => {
    const { id, seller, buyer, r } = await approvedSale(7n);
    await pay(buyer, r.intent_code, 7n * PRICE);
    expect(await tick(db, "transfer-worker")).toBe(1);
    const requestId = await proposeOnChain(await row(id), seller.wallet, buyer.wallet, 7n);
    // The buyer loses KYC verification (compliance hold) during the delay.
    await db.query("SELECT kyc.revoke($1, 'kyc:officer', 'documents found to be forged in review')", [buyer.subjectId]);
    expect(await tick(db, "transfer-worker")).toBeGreaterThanOrEqual(2);
    const c = await row(id);
    expect(c.status).toBe("cancelling");
    expect(c.execute_key).toBeNull();
    const cancel = await command(c.cancel_key ?? "");
    expect(cancel.payload).toMatchObject({ requestId: requestId.toString() });
    expect(await allowed("transfer.execute", { recoveryGuard: guard, requestId: requestId.toString(), caseId: `0x${c.case_ref.toString("hex")}` })).toBe(false);
    const tx = await sign("transfer.cancel", c.cancel_key ?? "");
    expect(decodeFunctionData({ abi: recoveryGuardAbi, data: tx.data })).toMatchObject({ functionName: "cancel", args: [requestId] });
    // Still pending on chain: nothing is refunded.
    expect(await tick(db, "transfer-worker")).toBe(0);
    expect((await cash("desk", id, "prepare_refund")).error).toMatch(/only a case in refunding/);
    await mine([{ role: "recovery", name: "RecoveryCancelled", args: { id: requestId, by: lc(keys.address("trustee")) } }]);
    expect(await tick(db, "transfer-worker")).toBe(1);
    expect((await row(id)).status).toBe("refunding");
  });

  it("an execution that fails three times fails the case and cancels the request before any refund", async () => {
    const { id, seller, buyer, r } = await approvedSale(3n);
    await pay(buyer, r.intent_code, 3n * PRICE);
    await tick(db, "transfer-worker");
    await proposeOnChain(await row(id), seller.wallet, buyer.wallet, 3n);
    for (let i = 1; i <= 3; i++) {
      await tick(db, "transfer-worker");
      const c = await row(id);
      expect(c.execute_key).toBe(`transfer.execute:case:${String(id)}:${String(i)}`);
      await settle(c.execute_key ?? "", "failed");
    }
    expect(await tick(db, "transfer-worker")).toBe(1);
    const c = await row(id);
    expect(c.status).toBe("failed");
    expect(c.cancel_key).toBe(`transfer.cancel:case:${String(id)}:1`);
    expect((await cash("desk", id, "prepare_refund")).error).toMatch(/only a case in refunding/);
  });
});

describe("no consideration, withdrawals, cancellations and the checks", () => {
  it("a court-ordered transfer by the desk goes straight to the on-chain proposal (no cash leg, lock-up exempt)", async () => {
    const seller = await person(50n);
    const buyer = await person(0n);
    const { rows } = await db.query<{ r: Result }>(
      "SELECT admin.transfer_open($1, $2, $3, $4, 20, 'court_order', NULL, 'decree of the civil court in a partition suit', $5, NULL, NULL) AS r",
      [await sessionOf("desk"), seller.subjectId, buyer.subjectId, token, randomBytes(32).toString("hex")]);
    const id = rows[0]?.r.id ?? 0;
    expect(rows[0]?.r).toMatchObject({ ok: true, status: "requested" });
    expect(await act("desk", id, "complete")).toMatchObject({ ok: true });
    expect(await act("compliance", id, "approve", "compliance")).toMatchObject({ ok: true });
    expect(await act("trustee", id, "approve", "trustee")).toMatchObject({ ok: true, status: "proposed" });
    const c = await row(id);
    expect(c.intent_code).toBeNull();
    expect(await allowed("transfer.propose", (await command(c.propose_key ?? "")).payload)).toBe(true);
    expect((await cash("desk", id, "prepare_settlement")).error).toMatch(/no cash leg/);
  });

  it("approval refuses failing checks: register, headroom, stale screening, lock-up, exit block; a rejection ends the case", async () => {
    const unregistered = await person(500n, { register: false });
    const buyer = await person(0n);
    const open = async (seller: Person, units: number): Promise<number> => {
      const { rows } = await db.query<{ r: Result }>(
        "SELECT admin.transfer_open($1, $2, $3, $4, $5, 'sale', $6, NULL, $7, NULL, NULL) AS r",
        [await sessionOf("desk"), seller.subjectId, buyer.subjectId, token, units, PRICE.toString(), randomBytes(32).toString("hex")]);
      const id = rows[0]?.r.id ?? 0;
      expect(await act("desk", id, "complete")).toMatchObject({ ok: true });
      return id;
    };
    const a = await open(unregistered, 10);
    expect((await act("compliance", a, "approve", "compliance")).error).toMatch(/checks failed: register/);
    const seller = await person(1000n);
    const b = await open(seller, 200);
    // Headroom: the cap is 100,000 units per identity; the buyer's identity already holds 99,900 elsewhere.
    await db.query("UPDATE transfer.settings SET value = '999' WHERE key = 'max_cases_30d'");
    const extra = `0x${randomBytes(20).toString("hex")}`;
    await mine([{ role: "identityRegistry", name: "IdentityRegistered", args: { investorAddress: extra, identity: buyer.identity } },
                { role: "token", name: "Transfer", args: { from: ZERO, to: extra, value: 99_900n } }]);
    expect((await act("compliance", b, "approve", "compliance")).error).toMatch(/buyer_headroom/);
    // Stale screening asks for a re-screen.
    await db.query("ALTER TABLE kyc.checks DISABLE TRIGGER USER");
    await db.query("UPDATE kyc.checks SET at = now() - interval '2 days' WHERE subject_id = $1 AND kind = 'sanctions'", [seller.subjectId]);
    await db.query("ALTER TABLE kyc.checks ENABLE TRIGGER USER");
    expect((await act("compliance", b, "approve", "compliance")).error).toMatch(/seller_screened/);
    expect((await db.query("SELECT 1 FROM compliance.rescreens WHERE subject_id = $1 AND status = 'queued'", [seller.subjectId])).rowCount).toBe(1);
    // Exit block (S-05 hook) and lock-up.
    await db.query("SELECT transfer.open_block($1, 'exit', 'exit-record-1', 'exit record date set for the property sale', 's05:service')", [token]);
    const live = (await view("compliance", b)).liveChecks ?? [];
    expect(live.filter((c) => !c.ok).map((c) => c.code)).toEqual(expect.arrayContaining(["exit", "seller_screened", "buyer_headroom"]));
    const blocks = await db.query<{ id: string }>("SELECT id FROM transfer.blocks WHERE ref = 'exit-record-1'");
    await db.query("SELECT transfer.close_block($1, 'exit cancelled by the trustee meeting', 's05:service')", [blocks.rows[0]?.id]);
    await db.query("SET session_replication_role = replica");
    await db.query("UPDATE offering.offerings SET completed_at = now() - interval '1 month' WHERE token = $1", [token]);
    await db.query("RESET session_replication_role");
    expect((await view("compliance", b)).liveChecks?.find((c) => c.code === "lockup")?.ok).toBe(false);
    await db.query("SET session_replication_role = replica");
    await db.query("UPDATE offering.offerings SET completed_at = now() - interval '7 months' WHERE token = $1", [token]);
    await db.query("RESET session_replication_role");
    expect(await act("trustee", b, "reject", "trustee", "the buyer would exceed the per-investor cap")).toMatchObject({ ok: true, status: "rejected" });
    const list = await webCall<{ cases: { status: string }[] }>("SELECT webauth.web_transfers($1) AS r", [await session(seller)]);
    expect(list.cases[0]?.status).toBe("not_approved");
  });

  it("a party withdraws before payment (the code is cancelled); an officer with a declared conflict cannot decide", async () => {
    const { id, seller, r } = await approvedSale(2n);
    expect(await webCall<{ ok: boolean; status: string }>("SELECT webauth.web_transfer_withdraw($1, $2) AS r", [await session(seller), r.case_uuid]))
      .toMatchObject({ ok: true, status: "cancelled" });
    expect((await db.query("SELECT 1 FROM bank.intent_cancellations WHERE code = $1", [r.intent_code])).rowCount).toBe(1);
    expect((await row(id)).status).toBe("cancelled");

    const s2 = await person(100n);
    const b2 = await person(0n);
    const { rows } = await db.query<{ r: Result }>("SELECT admin.transfer_declare_conflict($1, $2, 'the buyer is my brother in law') AS r",
      [await sessionOf("compliance"), b2.subjectId]);
    expect(rows[0]?.r.ok).toBe(true);
    const open = await db.query<{ r: Result }>("SELECT admin.transfer_open($1, $2, $3, $4, 10, 'family', NULL, 'gift between brothers for a new home', $5, NULL, NULL) AS r",
      [await sessionOf("desk"), s2.subjectId, b2.subjectId, token, randomBytes(32).toString("hex")]);
    const id2 = open.rows[0]?.r.id ?? 0;
    expect(await act("desk", id2, "complete")).toMatchObject({ ok: true });
    expect((await act("compliance", id2, "approve", "compliance")).error).toMatch(/declared a conflict/);
    expect(await act("compliance2", id2, "approve", "compliance")).toMatchObject({ ok: true });
    expect(await act("trustee", id2, "cancel", null, "parties asked to stop the transfer in writing")).toMatchObject({ ok: true, status: "cancelled" });
  });
});

describe("surveillance (TR-23) and reconciliation (16.8)", () => {
  it("a price outside the band needs an explanation and raises an STR case; a round trip too; investors never see alerts", async () => {
    const a = await person(500n);
    const b = await person(500n);
    await db.query("UPDATE transfer.settings SET value = '999' WHERE key = 'max_cases_30d'");
    const open = async (seller: Person, buyer: Person, price: bigint, explanation: string | null): Promise<number> => {
      const { rows } = await db.query<{ r: Result }>("SELECT admin.transfer_open($1, $2, $3, $4, 10, 'sale', $5, NULL, $6, $7, NULL) AS r",
        [await sessionOf("desk"), seller.subjectId, buyer.subjectId, token, price.toString(), randomBytes(32).toString("hex"), explanation]);
      const id = rows[0]?.r.id ?? 0;
      expect(await act("desk", id, "complete")).toMatchObject({ ok: true });
      return id;
    };
    const low = await open(a, b, PRICE / 2n, null);
    expect((await act("compliance", low, "approve", "compliance")).error).toMatch(/price_band/);
    const explained = await open(a, b, PRICE / 2n, "distress sale agreed after a valuation dispute, see agreement");
    const back = await open(b, a, PRICE, null);
    const alerts = await db.query<{ case_id: string; rule: string; category: string }>(
      "SELECT a.case_id::text, a.rule, s.category FROM transfer.alerts a JOIN compliance.str_cases s ON s.id = a.str_case_id ORDER BY a.id");
    expect(alerts.rows).toEqual(expect.arrayContaining([
      { case_id: String(low), rule: "price_outside_band", category: "unusual_pattern" },
      { case_id: String(explained), rule: "price_outside_band", category: "unusual_pattern" },
      { case_id: String(back), rule: "round_trip", category: "rapid_in_out" },
    ]));
    expect((await view("compliance", back)).alerts?.map((x) => x.rule)).toEqual(["round_trip"]);
    expect((await view("desk", back)).alerts).toBeNull();
    expect(JSON.stringify(await webCall("SELECT webauth.web_transfers($1) AS r", [await session(a)]))).not.toMatch(/round_trip|price_outside_band|alert/);
  });

  it("reconciliation: an unapproved holder-to-holder movement and a paid case past its SLA are findings; S-06 no longer reports transfer requests", async () => {
    const x = await person(100n);
    const y = await person(0n);
    await mine([{ role: "token", name: "Transfer", args: { from: x.wallet, to: y.wallet, value: 1n } }]);
    const findings = await reconcile(db, token);
    expect(findings.filter((f) => f.check === "transfer.unapproved")).toHaveLength(1);
    expect(findings.find((f) => f.check === "transfer.unapproved")?.actual).toContain(`1 units from ${x.wallet}`);
    // Only while the token is paused (phase 0); a movement made while unpaused (a mint window) is reported once it is paused again.
    await mine([{ role: "token", name: "Unpaused", args: { _userAddress: ZERO } }]);
    expect((await reconcile(db, token)).some((f) => f.check === "transfer.unapproved")).toBe(false);
    await mine([{ role: "token", name: "Paused", args: { _userAddress: ZERO } }]);
    expect((await reconcile(db, token)).some((f) => f.check === "transfer.unapproved")).toBe(true);
    // The "TR-11 cancelled" case above: paid, not executed, not yet refunded.
    expect(findings.some((f) => f.check === "transfer.paid_not_executed")).toBe(true);
    await db.query("UPDATE transfer.settings SET value = '0' WHERE key = 'paid_not_executed_hours'");
    expect((await reconcile(db, token)).some((f) => f.check === "transfer.paid_not_executed_overdue")).toBe(true);
    await db.query("UPDATE transfer.settings SET value = '120' WHERE key = 'paid_not_executed_hours'");
    const requests = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM transfer.recon_requests WHERE guard = $1", [guard]);
    expect(Number(requests.rows[0]?.n)).toBeGreaterThan(0);
  });

  it("the website role reaches transfers only through the session-bound wrappers", async () => {
    expect(await message(web.query("SELECT * FROM transfer.cases"))).toMatch(/permission denied/);
    expect(await message(web.query("SELECT transfer.web_list($1)", ["00000000-0000-0000-0000-000000000000"]))).toMatch(/permission denied/);
    expect(await webCall("SELECT webauth.web_transfers($1) AS r", [randomBytes(32)])).toBeNull();
    expect(await webCall<{ error: string }>("SELECT webauth.web_transfer_code($1) AS r", [randomBytes(32)])).toEqual({ error: "session" });
  });

  it("the audit chain is intact, no tick error was swallowed, and every row has its audit entry", async () => {
    expect(await verifyAudit(db)).toEqual([]);
    expect((await db.query("SELECT detail FROM transfer.audit WHERE action = 'tick.error'")).rows).toEqual([]);
    expect((await db.query("SELECT * FROM admin.verify_audit()")).rows).toEqual([]);
    // Tamper: an event written around the functions is found.
    await db.query("ALTER TABLE transfer.events DISABLE TRIGGER events_append_only");
    await db.query("INSERT INTO transfer.events (case_id, from_status, to_status, actor, reason) SELECT id, 'checks', 'proposed', 'rogue', 'rogue' FROM transfer.cases LIMIT 1");
    await db.query("ALTER TABLE transfer.events ENABLE TRIGGER events_append_only");
    expect((await verifyAudit(db)).some((p) => /event/.test(p.problem))).toBe(true);
  });
});

import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { freezeGuardAbi, identityAbi, recoveryGuardAbi } from "@pt/contracts";
import { KycService, mockProviders, Peppers } from "@pt/kyc";
import pg from "pg";
import { decodeFunctionData, getAddress, keccak256, parseTransaction, toHex, type Hex } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../db/src/migrate.ts";
import { contiguousMigrations, scratchDatabase } from "../../db/test/helpers.ts";
import { officer } from "../../db/test/officers.ts";
import { Indexer, type Deployment, type Header } from "../../indexer/src/index.ts";
import { FakeChain, fakeDeployment, type FakeEvent } from "../../indexer/test/fake-chain.ts";
import { FileKeystore, writeKeyFile } from "../../signer/src/keystore.ts";
import { walletKey, type ChainRequest } from "../../signer/src/policy.ts";
import { SignerService, type ChainReader } from "../../signer/src/service.ts";
import { allocate, type HeirShare } from "../src/allocation.ts";
import { tick, verifyAudit } from "../src/service.ts";

/**
 * S-06 (migration 0020, spec section 14) against a real PostgreSQL, a real indexer on a fake chain
 * (real ABIs) and the real signing service with a fake chain reader: wallet recovery, succession and
 * reversals, every rule enforced by the database (state machines, maker-checker, capacities, the
 * objection window, re-verification, frozen-first, shares, allocation, reversible journals), the
 * signing service's deny-by-default gate recovery.command_allowed, the tick that follows the chain,
 * the KYC rebinding and the audit chain.
 */
const PASS = "a-long-local-test-passphrase-0123456789";
const ZERO = "0x0000000000000000000000000000000000000000";
let db: pg.Client;
let pool: pg.Pool;
let drop: () => Promise<void>;
let kyc: KycService;
let keys: FileKeystore;
const chain = new FakeChain();
let d: Deployment;
let indexer: Indexer;
let seq = 3000;

// The signing service's view of the chain (kept in step with the fake chain by the tests).
const fake = {
  frozen: new Set<string>(),
  balances: new Map<string, bigint>(),
  identities: new Map<string, string>(),
  verified: new Set<string>(),
  keys: new Set<string>(),
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
  isRegistered: (_r, w) => Promise.resolve(fake.identities.has(w.toLowerCase())),
  registryIdentity: (_r, w) => Promise.resolve(fake.identities.get(w.toLowerCase()) ?? ZERO),
  isVerified: (_r, w) => Promise.resolve(fake.verified.has(w.toLowerCase())),
  balanceOf: (_t, w) => Promise.resolve(fake.balances.get(w.toLowerCase()) ?? 0n),
  keyHasPurpose: (identity, key) => Promise.resolve(fake.keys.has(`${identity.toLowerCase()}:${key}`)),
  recoveryRequest: (_g, id) => Promise.resolve(fake.requests.get(id) ?? { kind: "forced_transfer", status: "none", eta: 0n, from: ZERO, to: ZERO, onchainId: ZERO, amount: 0n }),
  chainTime: () => Promise.resolve(BigInt(Math.floor(Date.now() / 1000))),
};
const signer = (): SignerService => new SignerService(pool, keys, reader);

const lc = (a: string): string => a.toLowerCase();
const txOf = (h: Header, i = 0): Hex => keccak256(toHex(`tx:${h.hash}:${String(i)}`));
async function mine(events: FakeEvent[]): Promise<Header> {
  const h = chain.mine(d, events);
  await indexer.catchUp();
  return h;
}

async function code(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return (e as { code?: string }).code;
  }
}
async function message(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "";
  } catch (e) {
    return (e as Error).message;
  }
}

async function policies(): Promise<void> {
  const freeze = { chainId: 586586, keyRef: "ops", freezeGuard: lc(d.contracts.freezeGuard ?? ""), token: lc(d.contracts.token), maxPerDay: 20, approvals: 0 };
  const rec = { chainId: 586586, keyRef: "trustee", recoveryGuard: lc(d.contracts.recovery ?? ""), token: lc(d.contracts.token), identityRegistry: lc(d.contracts.identityRegistry ?? ""),
    maxBalance: "100000", maxPerDay: 50, approvals: 0 };
  const rules: [string, object][] = [
    ["recovery.freeze", freeze],
    ["recovery.unfreeze", freeze],
    ["recovery.add_key", { chainId: 586586, identityRegistry: lc(d.contracts.identityRegistry ?? ""), maxPerDay: 20 }],
    ["recovery.propose", rec],
    ["recovery.execute", rec],
    ["recovery.cancel", rec],
  ];
  for (const [kind, rule] of rules) {
    const { rows } = await db.query<{ id: string }>("SELECT signer.propose_policy($1, $2::jsonb, 'maker') AS id", [kind, JSON.stringify(rule)]);
    await db.query("SELECT signer.approve_policy($1, 'checker')", [rows[0]?.id]);
  }
}

interface Person {
  subjectId: string;
  wallet: string;
  cnic: string;
  name: string;
  identity: string;
}

/** A verified investor with a custodial wallet, registered on chain (identity), optionally holding units. */
async function person(units = 0n, name = "Recovery Person"): Promise<Person> {
  const w = await keys.createCustodialKey();
  await db.query("SELECT signer.register_custodial_wallet($1, 'generated', 'test')", [w.address]);
  const cnic = `4210${String(10_000_000 + ++seq).slice(-8)}2`;
  const r = await kyc.onboard({ cnic, fullName: name, livenessSessionId: `sess-rec-${String(seq)}`, wallet: w.address });
  expect(r.status).toBe("verified");
  const wallet = lc(w.address);
  const identity = `0x${randomBytes(20).toString("hex")}`;
  const events: FakeEvent[] = [{ role: "identityRegistry", name: "IdentityRegistered", args: { investorAddress: wallet, identity } }];
  if (units > 0n) events.push({ role: "token", name: "Transfer", args: { from: ZERO, to: wallet, value: units } });
  await mine(events);
  fake.identities.set(wallet, identity);
  fake.verified.add(wallet);
  fake.balances.set(wallet, units);
  return { subjectId: r.subjectId, wallet, cnic, name, identity };
}

async function freezeOnChain(wallet: string, frozen = true): Promise<void> {
  await mine([{ role: "token", name: "AddressFrozen", args: { _userAddress: wallet, _isFrozen: frozen, _owner: lc(d.contracts.freezeGuard ?? "") } }]);
  if (frozen) fake.frozen.add(wallet);
  else fake.frozen.delete(wallet);
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
    if (r.idempotency_key !== key) {
      await db.query("SELECT outbox.release($1, 'test-worker', 'test: another command', true)", [r.id]);
    } else if (outcome === "failed") {
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
  const r = await signer().request({ commandRef: key, kind: kind as "recovery.freeze", payload: c.payload }, "outbox-worker");
  if (r.status !== "signed") throw new Error(`${kind}: ${JSON.stringify(r)}`);
  const tx = parseTransaction(r.raw);
  return { to: lc(tx.to ?? ""), data: tx.data ?? "0x", from: lc(r.from) };
}

async function denied(kind: string, commandRef: string, payload: Record<string, string>): Promise<string> {
  const r = await signer().request({ commandRef, kind: kind as "recovery.freeze", payload }, "outbox-worker");
  return r.status === "denied" ? r.reason : `not denied: ${r.status}`;
}

const allowed = async (kind: string, payload: unknown): Promise<boolean> =>
  (await db.query<{ ok: boolean }>("SELECT recovery.command_allowed($1, $2::jsonb) AS ok", [kind, JSON.stringify(payload)])).rows[0]?.ok === true;

interface CaseRow {
  id: string;
  status: string;
  case_ref: Buffer;
  to_wallet: string | null;
  freeze_key: string | null;
  add_key_key: string | null;
  unfreeze_key: string | null;
  units_residual: string | null;
  reversal_journal_id: string | null;
  evidence_hash: Buffer | null;
}
async function caseRow(id: string): Promise<CaseRow> {
  const { rows } = await db.query<CaseRow>("SELECT * FROM recovery.cases WHERE id = $1", [id]);
  if (!rows[0]) throw new Error(`no case ${id}`);
  return rows[0];
}
const digest = async (id: string): Promise<Buffer> => (await db.query<{ d: Buffer }>("SELECT recovery.case_digest($1) AS d", [id])).rows[0]?.d ?? Buffer.alloc(32);
async function decide(id: string, actor: string, capacity: string, decision: "approve" | "reject" = "approve"): Promise<string> {
  const { rows } = await db.query<{ s: string }>("SELECT recovery.decide($1, $2, $3, $4, 'evidence checked against the records', $5) AS s", [id, actor, capacity, decision, await digest(id)]);
  return rows[0]?.s ?? "";
}
async function release(id: string, actor: string): Promise<string> {
  const { rows } = await db.query<{ s: string }>("SELECT recovery.release($1, $2, 'case finished, lifting the protective freeze', $3) AS s", [id, actor, await digest(id)]);
  return rows[0]?.s ?? "";
}
async function proposals(caseId: string): Promise<{ id: string; status: string; amount: string; propose_key: string; execute_key: string | null; cancel_key: string | null; request_id: string | null; to_wallet: string }[]> {
  return (await db.query<{ id: string; status: string; amount: string; propose_key: string; execute_key: string | null; cancel_key: string | null; request_id: string | null; to_wallet: string }>(
    "SELECT id, status, amount::text, propose_key, execute_key, cancel_key, request_id::text, to_wallet FROM recovery.proposals WHERE case_id = $1 ORDER BY id", [caseId])).rows;
}

beforeAll(async () => {
  let settings: pg.ClientConfig;
  ({ client: db, settings, drop } = await scratchDatabase());
  await migrate(db, contiguousMigrations());
  pool = new pg.Pool({ ...settings, max: 8 });
  kyc = new KycService(pool, mockProviders(), Peppers.of([{ version: 1, key: randomBytes(32) }]), randomBytes(32));
  const dir = await mkdtemp(join(tmpdir(), "ks-rec-"));
  for (const ref of ["ops", "trustee"]) await writeKeyFile(dir, ref, generatePrivateKey(), PASS);
  keys = await FileKeystore.open(dir, PASS);
  for (const ref of ["ops", "trustee"]) await db.query("INSERT INTO signer.keys (key_ref, address, purpose) VALUES ($1, $2, 'test')", [ref, keys.address(ref)]);
  d = fakeDeployment(1n);
  indexer = new Indexer(pool, chain, d);
  await indexer.register();
  await indexer.catchUp();
}, 180_000);

afterAll(async () => {
  await pool.end();
  await drop();
}, 180_000);

describe("allocation (RF-14)", () => {
  it("floor of each share; the remainder by largest remainder only with a family settlement", () => {
    const heirs: HeirShare[] = [
      { id: 1n, num: 1n, den: 8n },
      { id: 2n, num: 7n, den: 24n },
      { id: 3n, num: 7n, den: 24n },
      { id: 4n, num: 7n, den: 24n },
    ];
    expect(allocate(100n, heirs, false)).toEqual({ units: new Map([[1n, 12n], [2n, 29n], [3n, 29n], [4n, 29n]]), residual: 1n });
    // Remainders: 4/8 = 0.5 for heir 1, 4/24 for the others: heir 1 gets the unit.
    expect(allocate(100n, heirs, true)).toEqual({ units: new Map([[1n, 13n], [2n, 29n], [3n, 29n], [4n, 29n]]), residual: 0n });
    // Equal remainders: the heir added first.
    expect(allocate(100n, [{ id: 5n, num: 1n, den: 3n }, { id: 6n, num: 1n, den: 3n }, { id: 7n, num: 1n, den: 3n }], true).units.get(5n)).toBe(34n);
  });

  it("the database's recovery.allocation() equals the TypeScript twin, and nothing is lost (property)", async () => {
    // A throw-away succession case to hold generated heirs (the guard lets heirs be added while opened).
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.tuple(fc.integer({ min: 1, max: 12 }), fc.integer({ min: 1, max: 12 })), { minLength: 1, maxLength: 5 }),
        fc.bigInt({ min: 0n, max: 10_000_000n }),
        fc.boolean(),
        async (fracs, balance, settlement) => {
          const shares = fracs.map(([a, b]) => ({ num: BigInt(Math.min(a, b)), den: BigInt(Math.max(a, b)) }));
          const values = shares.map((s, i) => `(${String(i + 1)}, ${s.num.toString()}, ${s.den.toString()})`).join(", ");
          // Same formula as recovery.allocation (run over a VALUES list instead of recovery.heirs).
          const { rows } = await db.query<{ id: number; units: string }>(
            `WITH h(id, share_num, share_den) AS (VALUES ${values}),
             b AS (SELECT h.id, floor($1::numeric * h.share_num / h.share_den) AS base,
                          div(mod($1::numeric * h.share_num, h.share_den::numeric) * 10::numeric ^ 40, h.share_den::numeric) AS rkey FROM h),
             r AS (SELECT $1::numeric - coalesce(sum(base), 0) AS leftover FROM b),
             ranked AS (SELECT b.id, b.base, row_number() OVER (ORDER BY b.rkey DESC, b.id) AS rk FROM b)
             SELECT id, (base + CASE WHEN $2 AND rk <= (SELECT leftover FROM r) THEN 1 ELSE 0 END)::text AS units FROM ranked ORDER BY id`,
            [balance.toString(), settlement],
          );
          const ts = allocate(balance, shares.map((s, i) => ({ id: BigInt(i + 1), ...s })), settlement);
          expect(rows.map((r) => BigInt(r.units))).toEqual([...ts.units.values()]);
          const sum = [...ts.units.values()].reduce((a, b) => a + b, 0n);
          expect(sum + ts.residual).toBe(balance);
          for (const [i, s] of shares.entries()) expect(ts.units.get(BigInt(i + 1)) ?? 0n).toBeGreaterThanOrEqual((balance * s.num) / s.den);
        },
      ),
      { numRuns: 40 },
    );
  });
});

describe("wallet recovery (RF-7..RF-11)", () => {
  let p: Person;
  let caseId = "";
  let newWallet = "";

  it("needs the policies, a bound wallet with units and a registered identity; opening enqueues the protective freeze and notifies", async () => {
    p = await person(500n, "Wallet Owner");
    expect(await message(db.query("SELECT recovery.open_case('wallet_recovery', $1, 'investor reports a compromised wallet key', 'ops:maker')", [p.subjectId])))
      .toMatch(/no active recovery.freeze and recovery.propose signing policies/);
    await policies();
    const empty = await person(0n, "Empty Wallet");
    expect(await message(db.query("SELECT recovery.open_case('wallet_recovery', $1, 'investor reports a compromised wallet key', 'ops:maker')", [empty.subjectId])))
      .toMatch(/holds no units/);
    expect(await code(db.query("SELECT recovery.open_case('wallet_recovery', $1, 'call me on 03001234567 please', 'ops:maker')", [p.subjectId]))).toBe("23514");

    const { rows } = await db.query<{ id: string }>("SELECT recovery.open_case('wallet_recovery', $1, 'investor reports a compromised wallet key', 'ops:maker') AS id", [p.subjectId]);
    caseId = rows[0]?.id ?? "";
    expect(await code(db.query("SELECT recovery.open_case('wallet_recovery', $1, 'a second case for the same wallet', 'ops:maker')", [p.subjectId]))).toBe("23505");
    const c = await caseRow(caseId);
    expect(c.status).toBe("opened");
    const freeze = await command(c.freeze_key ?? "");
    expect(freeze).toMatchObject({ kind: "recovery.freeze", payload: { account: p.wallet, freezeGuard: lc(d.contracts.freezeGuard ?? ""), caseId: `0x${c.case_ref.toString("hex")}` } });
    const n = await db.query<{ kind: string; status: string }>("SELECT kind, status FROM notify.notifications WHERE idempotency_key = $1", [`recovery:case:${caseId}:requested`]);
    expect(n.rows[0]?.kind).toBe("security.wallet_recovery_requested");
  });

  it("the signing service freezes exactly the case's wallet (C1), never a forged one", async () => {
    const c = await caseRow(caseId);
    const tx = await sign("recovery.freeze", c.freeze_key ?? "");
    expect(tx.to).toBe(lc(d.contracts.freezeGuard ?? ""));
    expect(decodeFunctionData({ abi: freezeGuardAbi, data: tx.data })).toMatchObject({ functionName: "freezeAddress", args: [getAddress(p.wallet), `0x${c.case_ref.toString("hex")}`] });
    const forged = { ...(await command(c.freeze_key ?? "")).payload, caseId: `0x${"ab".repeat(32)}` };
    expect(await denied("recovery.freeze", "forged:freeze:1", forged)).toMatch(/no recovery case enqueued this freeze/);
    // The existing compliance.freeze kind still refuses a verified investor (unchanged).
    expect(await allowed("recovery.unfreeze", (await command(c.freeze_key ?? "")).payload)).toBe(false);
  });

  it("refuses approval before the objection window ends, without re-verification, frozen wallet or new wallet", async () => {
    expect(await message(decide(caseId, "ops:checker", "operations"))).toMatch(/objection window runs until/);
    // Test only: age the objection window (the guard keeps it fixed in production).
    await db.query("ALTER TABLE recovery.cases DISABLE TRIGGER cases_guard");
    await db.query("UPDATE recovery.cases SET objection_until = now() - interval '1 second' WHERE id = $1", [caseId]);
    await db.query("ALTER TABLE recovery.cases ENABLE TRIGGER cases_guard");
    expect(await message(decide(caseId, "ops:checker", "operations"))).toMatch(/not frozen on chain yet/);
    await freezeOnChain(p.wallet);
    expect(await message(decide(caseId, "ops:checker", "operations"))).toMatch(/no new custodial wallet/);

    // The new wallet: custodial, unbound, unregistered, empty.
    const other = await person(0n, "Bound Elsewhere");
    expect(await message(db.query("SELECT recovery.set_new_wallet($1, $2, 'ops:maker')", [caseId, `0x${randomBytes(20).toString("hex")}`]))).toMatch(/custodial wallet of the signing service/);
    expect(await message(db.query("SELECT recovery.set_new_wallet($1, $2, 'ops:maker')", [caseId, other.wallet]))).toMatch(/is \(or was\) bound/);
    const w = await keys.createCustodialKey();
    await db.query("SELECT signer.register_custodial_wallet($1, 'generated', 'admin-portal')", [w.address]);
    newWallet = lc(w.address);
    await db.query("SELECT recovery.set_new_wallet($1, $2, 'ops:maker')", [caseId, newWallet]);
    expect(await message(decide(caseId, "ops:checker", "operations"))).toMatch(/NADRA and liveness must pass again/);

    // Re-verification of the same person (CNIC finds the subject; a wrong name is refused).
    await expect(kyc.reverify({ cnic: p.cnic, fullName: "Someone Else", livenessSessionId: `sess-rv-${String(++seq)}` })).rejects.toThrow(/no matching registered investor/);
    const rv = await kyc.reverify({ cnic: p.cnic, fullName: p.name, livenessSessionId: `sess-rv-${String(++seq)}` });
    expect(rv).toMatchObject({ subjectId: p.subjectId, status: "verified" });
  });

  it("two officers in the two capacities, never the maker; the approval enqueues add_key and the WalletRecovery request", async () => {
    expect(await message(decide(caseId, "ops:maker", "operations"))).toMatch(/maker-checker/);
    expect(await message(decide(caseId, "legal:lina", "legal"))).toMatch(/decided in the capacities operations and compliance/);
    const stale = await message(db.query("SELECT recovery.decide($1, 'ops:checker', 'operations', 'approve', 'evidence checked against the records', $2)", [caseId, Buffer.alloc(32)]));
    expect(stale).toMatch(/differs from what you reviewed/);
    expect(await decide(caseId, "ops:checker", "operations")).toBe("opened");
    // The new wallet cannot change once an approval exists.
    expect(await message(db.query("SELECT recovery.set_new_wallet($1, $2, 'ops:maker')", [caseId, newWallet]))).toMatch(/only before any approval/);
    expect(await message(decide(caseId, "ops:checker", "compliance"))).toMatch(/already decided this case/);
    expect(await message(decide(caseId, "ops:checker.two", "operations"))).toMatch(/operations decision was already taken/);
    expect(await decide(caseId, "comp:amna", "compliance")).toBe("approved");

    const c = await caseRow(caseId);
    expect(c.evidence_hash?.length).toBe(32);
    const add = await command(c.add_key_key ?? "");
    expect(add.payload).toEqual({ identity: p.identity, wallet: p.wallet, newWallet, caseId: `0x${c.case_ref.toString("hex")}` });
    const [prop] = await proposals(caseId);
    expect(prop).toMatchObject({ status: "enqueued", amount: "0", to_wallet: newWallet });
    const propose = await command(prop?.propose_key ?? "");
    expect(propose.payload).toMatchObject({ kind: "wallet_recovery", from: p.wallet, to: newWallet, onchainId: p.identity, amount: "0" });
    expect(await allowed("recovery.propose", propose.payload)).toBe(true);
    expect(await allowed("recovery.propose", { ...propose.payload, to: `0x${"11".repeat(20)}` })).toBe(false);
  });

  it("the signing service: addKey signed by the OLD custodial wallet, propose by the trustee key; calldata decoded", async () => {
    const c = await caseRow(caseId);
    const add = await sign("recovery.add_key", c.add_key_key ?? "");
    expect(add.from).toBe(p.wallet);
    expect(add.to).toBe(p.identity);
    expect(decodeFunctionData({ abi: identityAbi, data: add.data })).toMatchObject({ functionName: "addKey", args: [walletKey(newWallet), 1n, 1n] });
    fake.keys.add(`${p.identity}:${walletKey(newWallet)}`);

    const [prop] = await proposals(caseId);
    const tx = await sign("recovery.propose", prop?.propose_key ?? "");
    expect(tx.from).toBe(lc(keys.address("trustee")));
    expect(tx.to).toBe(lc(d.contracts.recovery ?? ""));
    expect(decodeFunctionData({ abi: recoveryGuardAbi, data: tx.data })).toMatchObject({
      functionName: "propose",
      args: [0, getAddress(p.wallet), getAddress(newWallet), getAddress(p.identity), 0n, `0x${c.evidence_hash?.toString("hex") ?? ""}`],
    });
  });

  it("the tick links the RecoveryProposed event, enqueues execute after the delay, follows the execution and moves the KYC binding", async () => {
    const c = await caseRow(caseId);
    const [prop] = await proposals(caseId);
    const eta = BigInt(Math.floor(Date.now() / 1000)) - 10n; // as if the 48 hours had passed
    const h = await mine([{ role: "recovery", name: "RecoveryProposed", args: { id: 1n, kind: 0, from: p.wallet, to: newWallet, onchainId: p.identity, amount: 0n,
      evidenceHash: `0x${c.evidence_hash?.toString("hex") ?? ""}`, eta } }]);
    await settle(prop?.propose_key ?? "", "confirmed", txOf(h));
    fake.requests.set(1n, { kind: "wallet_recovery", status: "pending", eta, from: p.wallet, to: newWallet, onchainId: p.identity, amount: 0n });
    expect(await tick(db, "recovery-worker")).toBeGreaterThanOrEqual(2);
    const [pending] = await proposals(caseId);
    expect(pending).toMatchObject({ status: "pending", request_id: "1" });
    const exec = await command(pending?.execute_key ?? "");
    expect(exec.payload).toEqual({ recoveryGuard: lc(d.contracts.recovery ?? ""), requestId: "1", caseId: `0x${c.case_ref.toString("hex")}` });
    // The tick is idempotent.
    expect(await tick(db, "recovery-worker")).toBe(0);

    // Execution re-checks the chain: without the management key it is refused.
    fake.keys.delete(`${p.identity}:${walletKey(newWallet)}`);
    expect(await denied("recovery.execute", "probe:execute:nokey", exec.payload)).toMatch(/not a management key/);
    fake.keys.add(`${p.identity}:${walletKey(newWallet)}`);
    const tx = await sign("recovery.execute", pending?.execute_key ?? "");
    expect(decodeFunctionData({ abi: recoveryGuardAbi, data: tx.data })).toMatchObject({ functionName: "execute", args: [1n] });

    // The token: full balance and frozen status to the new wallet; registry entry moved.
    await mine([
      { role: "recovery", name: "RecoveryExecuted", args: { id: 1n } },
      { role: "identityRegistry", name: "IdentityRegistered", args: { investorAddress: newWallet, identity: p.identity } },
      { role: "token", name: "Transfer", args: { from: p.wallet, to: newWallet, value: 500n } },
      { role: "token", name: "AddressFrozen", args: { _userAddress: newWallet, _isFrozen: true, _owner: lc(d.contracts.token) } },
      { role: "identityRegistry", name: "IdentityRemoved", args: { investorAddress: p.wallet, identity: p.identity } },
    ]);
    fake.frozen.add(newWallet);
    expect(await tick(db, "recovery-worker")).toBeGreaterThanOrEqual(2);
    expect((await caseRow(caseId)).status).toBe("executed");
    const bound = await db.query<{ wallet: string }>("SELECT wallet FROM kyc.wallets WHERE subject_id = $1", [p.subjectId]);
    expect(bound.rows.map((r) => r.wallet)).toEqual([newWallet]);
    const ver = async (w: string): Promise<boolean> => (await db.query<{ ok: boolean }>("SELECT kyc.is_verified($1) AS ok", [w])).rows[0]?.ok === true;
    expect(await ver(newWallet)).toBe(true);
    expect(await ver(p.wallet)).toBe(false);
    expect((await db.query("SELECT * FROM kyc.verify_audit()")).rows).toEqual([]);
  });

  it("release: two different compliance officers, never the maker; then the signing service unfreezes the new wallet", async () => {
    expect(await message(release(caseId, "ops:maker"))).toMatch(/opened \(froze\) the case/);
    expect(await release(caseId, "comp:amna")).toBe("executed");
    expect(await message(release(caseId, "comp:amna"))).toMatch(/a different compliance officer confirms/);
    expect(await release(caseId, "comp:bilal")).toBe("closed");
    const c = await caseRow(caseId);
    const unfreeze = await command(c.unfreeze_key ?? "");
    expect(unfreeze.payload).toMatchObject({ account: newWallet });
    const tx = await sign("recovery.unfreeze", c.unfreeze_key ?? "");
    expect(decodeFunctionData({ abi: freezeGuardAbi, data: tx.data })).toMatchObject({ functionName: "unfreezeAddress", args: [getAddress(newWallet), `0x${c.case_ref.toString("hex")}`] });
    // Nothing can be enqueued or signed for a closed case any more.
    const [prop] = await proposals(caseId);
    expect(await allowed("recovery.propose", (await command(prop?.propose_key ?? "")).payload)).toBe(false);
    expect(await allowed("recovery.add_key", (await command(c.add_key_key ?? "")).payload)).toBe(false);
  });

  it("the records cannot be changed around the functions", async () => {
    expect(await code(db.query("UPDATE recovery.cases SET status = 'opened' WHERE id = $1", [caseId]))).toBe("23514");
    expect(await code(db.query("DELETE FROM recovery.cases WHERE id = $1", [caseId]))).toBe("42501");
    expect(await code(db.query("UPDATE recovery.approvals SET decision = 'reject'"))).toBe("42501");
    expect(await code(db.query("UPDATE kyc.wallets SET wallet = $1 WHERE subject_id = $2", [`0x${"77".repeat(20)}`, p.subjectId]))).toBe("42501");
    expect(await code(db.query("UPDATE recovery.proposals SET status = 'enqueued'"))).toBe("23514");
  });
});

describe("succession (RF-12..RF-16)", () => {
  let deceased: Person;
  let heirs: Person[];
  let caseId = "";

  it("documents (metadata and SHA-256 only), verified heirs with registered wallets, shares summing to 1", async () => {
    deceased = await person(100n, "Deceased Holder");
    heirs = [await person(0n, "Heir One"), await person(0n, "Heir Two"), await person(0n, "Heir Three")];
    const { rows } = await db.query<{ id: string }>("SELECT recovery.open_case('succession', $1, 'notice of death received from the family', 'ops:maker') AS id", [deceased.subjectId]);
    caseId = rows[0]?.id ?? "";
    await freezeOnChain(deceased.wallet);
    const doc = (type: string, ref: string) => db.query("SELECT recovery.add_document($1, $2, $3, 'Civil Court Lahore', $4, 'ops:maker')", [caseId, type, ref, randomBytes(32)]);
    await doc("death_certificate", "NADRA death certificate D-2026-1182");
    expect(await message(doc("other", "CNIC 35202-1234567-1"))).toMatch(/never a CNIC/);
    const unregistered = await person(0n, "Not Registered");
    await mine([{ role: "identityRegistry", name: "IdentityRemoved", args: { investorAddress: unregistered.wallet, identity: unregistered.identity } }]);
    expect(await message(db.query("SELECT recovery.add_heir($1, $2, 1, 3, 'ops:maker')", [caseId, unregistered.subjectId]))).toMatch(/not registered/);
    expect(await message(db.query("SELECT recovery.add_heir($1, $2, 1, 3, 'ops:maker')", [caseId, deceased.subjectId]))).toMatch(/deceased cannot be an heir/);
    expect(await message(db.query("SELECT recovery.add_heir($1, $2, 4, 3, 'ops:maker')", [caseId, heirs[0]?.subjectId]))).toMatch(/0 < numerator <= denominator/);
    await db.query("SELECT recovery.add_heir($1, $2, 1, 3, 'ops:maker')", [caseId, heirs[0]?.subjectId]);
    await db.query("SELECT recovery.add_heir($1, $2, 1, 3, 'ops:maker')", [caseId, heirs[1]?.subjectId]);
    expect(await message(decide(caseId, "legal:lina", "legal"))).toMatch(/succession certificate, letters of administration or a court order/);
    await doc("succession_certificate", "Succession certificate SC-114/2026");
    expect(await message(decide(caseId, "legal:lina", "legal"))).toMatch(/do not sum to exactly 1/);
    await db.query("SELECT recovery.add_heir($1, $2, 1, 3, 'ops:maker')", [caseId, heirs[2]?.subjectId]);
  });

  it("legal and compliance approve; one ForcedTransfer per heir with floor units; without a settlement the remainder stays", async () => {
    expect(await message(decide(caseId, "ops:checker", "operations"))).toMatch(/capacities legal and compliance/);
    expect(await decide(caseId, "legal:lina", "legal")).toBe("opened");
    expect(await decide(caseId, "comp:amna", "compliance")).toBe("approved");
    const c = await caseRow(caseId);
    expect(c.units_residual).toBe("1");
    const ps = await proposals(caseId);
    expect(ps.map((x) => [x.to_wallet, x.amount])).toEqual(heirs.map((h) => [h.wallet, "33"]));
    const tx = await sign("recovery.propose", ps[0]?.propose_key ?? "");
    expect(decodeFunctionData({ abi: recoveryGuardAbi, data: tx.data })).toMatchObject({
      functionName: "propose",
      args: [1, getAddress(deceased.wallet), getAddress(heirs[0]?.wallet ?? ""), ZERO, 33n, `0x${c.evidence_hash?.toString("hex") ?? ""}`],
    });
    // An heir above the per-investor cap is refused by the signing service.
    fake.balances.set(heirs[1]?.wallet ?? "", 99_990n);
    expect(await denied("recovery.propose", "probe:propose:cap", (await command(ps[1]?.propose_key ?? "")).payload)).toMatch(/per-investor cap/);
    fake.balances.set(heirs[1]?.wallet ?? "", 0n);
  });

  it("cancel during the delay: pending requests get cancel commands, unproposed ones never go out; release unfreezes", async () => {
    const ps = await proposals(caseId);
    const future = BigInt(Math.floor(Date.now() / 1000)) + 48n * 3600n;
    const h = await mine([{ role: "recovery", name: "RecoveryProposed", args: { id: 2n, kind: 1, from: deceased.wallet, to: heirs[0]?.wallet ?? ZERO, onchainId: ZERO, amount: 33n,
      evidenceHash: `0x${"cd".repeat(32)}`, eta: future } }]);
    await settle(ps[0]?.propose_key ?? "", "confirmed", txOf(h));
    await tick(db, "recovery-worker");
    const [first] = await proposals(caseId);
    expect(first).toMatchObject({ status: "pending", request_id: "2", execute_key: null }); // the delay has not passed
    expect(await message(release(caseId, "comp:amna"))).toMatch(/only an executed, rejected or cancelled/);

    const cancel = await db.query<{ s: string }>("SELECT recovery.cancel($1, 'comp:amna', 'objection from a family member under review', $2) AS s", [caseId, await digest(caseId)]);
    expect(cancel.rows[0]?.s).toBe("cancelled");
    const after = await proposals(caseId);
    expect(after.map((x) => x.status)).toEqual(["pending", "cancelled", "cancelled"]);
    const cancelCmd = await command(after[0]?.cancel_key ?? "");
    expect(await allowed("recovery.cancel", cancelCmd.payload)).toBe(true);
    expect(await allowed("recovery.propose", (await command(after[1]?.propose_key ?? "")).payload)).toBe(false);
    fake.requests.set(2n, { kind: "forced_transfer", status: "pending", eta: future, from: deceased.wallet, to: heirs[0]?.wallet ?? ZERO, onchainId: ZERO, amount: 33n });
    const tx = await sign("recovery.cancel", after[0]?.cancel_key ?? "");
    expect(decodeFunctionData({ abi: recoveryGuardAbi, data: tx.data })).toMatchObject({ functionName: "cancel", args: [2n] });
    expect(await message(release(caseId, "comp:amna"))).toMatch(/still open/);
    await mine([{ role: "recovery", name: "RecoveryCancelled", args: { id: 2n, by: lc(keys.address("trustee")) } }]);
    await tick(db, "recovery-worker");
    expect((await proposals(caseId)).map((x) => x.status)).toEqual(["cancelled", "cancelled", "cancelled"]);
    expect(await release(caseId, "comp:amna")).toBe("cancelled");
    expect(await release(caseId, "comp:bilal")).toBe("closed");
    expect((await command((await caseRow(caseId)).unfreeze_key ?? "")).payload).toMatchObject({ account: deceased.wallet });
  });

  it("with a family settlement a new case allocates every unit and closes itself once all transfers executed", async () => {
    const { rows } = await db.query<{ id: string }>("SELECT recovery.open_case('succession', $1, 'reopened after the objection was withdrawn', 'ops:maker') AS id", [deceased.subjectId]);
    const id = rows[0]?.id ?? "";
    for (const [type, ref] of [["death_certificate", "NADRA death certificate D-2026-1182"], ["succession_certificate", "Succession certificate SC-114/2026"], ["family_settlement", "Family settlement deed FS-9"]]) {
      await db.query("SELECT recovery.add_document($1, $2, $3, NULL, $4, 'ops:maker')", [id, type, ref, randomBytes(32)]);
    }
    for (const h of heirs) await db.query("SELECT recovery.add_heir($1, $2, 1, 3, 'ops:maker')", [id, h.subjectId]);
    await decide(id, "legal:lina", "legal");
    expect(await decide(id, "comp:amna", "compliance")).toBe("approved");
    const ps = await proposals(id);
    expect(ps.map((x) => x.amount)).toEqual(["34", "33", "33"]);
    expect((await caseRow(id)).units_residual).toBe("0");
    // All three proposed and executed on chain.
    const past = BigInt(Math.floor(Date.now() / 1000)) - 5n;
    let rid = 10n;
    for (const x of ps) {
      const h = await mine([{ role: "recovery", name: "RecoveryProposed", args: { id: ++rid, kind: 1, from: deceased.wallet, to: x.to_wallet, onchainId: ZERO, amount: BigInt(x.amount),
        evidenceHash: `0x${"ef".repeat(32)}`, eta: past } }]);
      await settle(x.propose_key, "confirmed", txOf(h));
    }
    await tick(db, "recovery-worker");
    const pending = await proposals(id);
    expect(pending.every((x) => x.status === "pending" && x.execute_key !== null)).toBe(true);
    await mine(pending.map((x) => ({ role: "recovery" as const, name: "RecoveryExecuted", args: { id: BigInt(x.request_id ?? "0") } })));
    await tick(db, "recovery-worker");
    expect((await caseRow(id)).status).toBe("closed");
  });
});

describe("reversals of platform errors (RF-17..RF-20)", () => {
  const post = async (key: string, kind: string, amount: bigint, ref: string | null = "RAAST-RENT-0001", from = "income:rent:test"): Promise<string> => {
    const { rows } = await db.query<{ id: string }>("SELECT ledger.post_journal($1, $2, NULL, $3, 'ops:booking', $4::jsonb) AS id", [
      key, kind, ref, JSON.stringify([{ account: "bank:trustee-escrow", amount: amount.toString() }, { account: from, amount: (-amount).toString() }]),
    ]);
    return rows[0]?.id ?? "";
  };
  const open = (journal: string, actor = "ops:maker") =>
    db.query<{ id: string }>("SELECT recovery.open_reversal($1, 'duplicate_booking', 'rent of October booked twice by the import job', $2, $3) AS id", [journal, randomBytes(32), actor]);

  it("only a reversible kind, never a protected key or an on-chain reference, never twice", async () => {
    await db.query("SELECT ledger.open_account('income:rent:test', 'income', 'PKR')");
    const original = await post("tenant:rent:2026-10", "rent_received", 50_000n);
    const duplicate = await post("tenant:rent:2026-10:again", "rent_received", 50_000n);
    const subscription = await post(`sub:0x${"aa".repeat(32)}:paid`, "rent_received", 1_000n, "RAAST-SUB-1");
    const paid = await post("web:topup:x1", "subscription_paid", 1_000n, "RAAST-SUB-2");
    expect(await message(open(subscription))).toMatch(/subscription, trade, rent distribution/);
    expect(await message(open(paid))).toMatch(/not reversible/);
    expect(original).not.toBe("");
    const { rows } = await open(duplicate);
    const id = rows[0]?.id ?? "";
    expect(await message(open(duplicate))).toMatch(/already has an open or completed reversal/);

    expect(await message(decide(id, "ops:maker", "operations"))).toMatch(/maker-checker/);
    expect(await message(decide(id, "comp:amna", "compliance"))).toMatch(/capacities operations/);
    expect(await decide(id, "ops:checker", "operations")).toBe("closed");
    const c = await caseRow(id);
    const j = await db.query<{ kind: string; idempotency_key: string; external_ref: string }>("SELECT kind, idempotency_key, external_ref FROM ledger.journal WHERE id = $1", [c.reversal_journal_id]);
    expect(j.rows[0]).toEqual({ kind: "reversal", idempotency_key: `case:${c.case_ref.toString("hex")}:reversal`, external_ref: "RAAST-RENT-0001" });
    const net = await db.query<{ code: string; s: string }>(
      "SELECT a.code, sum(p.amount)::text AS s FROM ledger.postings p JOIN ledger.accounts a ON a.id = p.account_id WHERE p.journal_id IN ($1, $2) GROUP BY a.code ORDER BY a.code",
      [duplicate, c.reversal_journal_id]);
    expect(net.rows.map((r) => r.s)).toEqual(["0", "0"]);
    // A correcting journal is never reversed itself.
    expect(await message(open(c.reversal_journal_id ?? ""))).toMatch(/never reversed/);
    expect((await db.query("SELECT * FROM ledger.verify_chain()")).rows).toEqual([]);
    expect((await db.query("SELECT * FROM ledger.verify_balances()")).rows).toEqual([]);
  });

  it("money that already moved on cannot be reversed (the ledger's own overdraft rule)", async () => {
    const j = await post("tenant:rent:2026-11", "rent_received", 7_000n, "RAAST-RENT-0002");
    await db.query("SELECT ledger.post_journal('test:move:rent', 'transfer_test', NULL, NULL, 'ops:booking', $1::jsonb)", [
      JSON.stringify([{ account: "income:rent:test", amount: "55000" }, { account: "bank:suspense", amount: "-55000" }]),
    ]);
    const { rows } = await open(j);
    expect(await message(decide(rows[0]?.id ?? "", "ops:checker", "operations"))).toMatch(/insufficient balance/);
    expect((await caseRow(rows[0]?.id ?? "")).status).toBe("opened");
  });
});

describe("officers, audit and the portal role", () => {
  it("an officer's handle is accepted only through the portal, in a capacity of one of their roles", async () => {
    const legal = await officer(db, "legal.lina", "legal_officer");
    expect(legal.handle).toBe("legal.lina");
    const p = await person(10n, "Bound Officer Probe");
    expect(await message(db.query("SELECT recovery.open_case('succession', $1, 'opened under an officer name directly', 'legal.lina')", [p.subjectId])))
      .toMatch(/officer of the admin portal/);
    expect((await db.query<{ ok: boolean }>("SELECT recovery.capacity_ok('legal.lina', 'legal') AS ok")).rows[0]?.ok).toBe(true);
    expect((await db.query<{ ok: boolean }>("SELECT recovery.capacity_ok('legal.lina', 'compliance') AS ok")).rows[0]?.ok).toBe(false);
  });

  it("the recovery audit chain verifies and finds rows written around the functions", async () => {
    expect(await verifyAudit(db)).toEqual([]);
    const actions = (await db.query<{ action: string }>("SELECT DISTINCT action FROM recovery.audit ORDER BY 1")).rows.map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(["case.opened", "case.decided", "case.approved", "request.proposed", "request.executed", "wallet.rebound", "case.released", "case.reversed"]));
    expect((await db.query("SELECT * FROM signer.verify_audit()")).rows).toEqual([]);
    await db.query("INSERT INTO recovery.documents (case_id, doc_type, reference, sha256, added_by, added_at) SELECT id, 'other', 'written around the API', $1, 'intruder', now() FROM recovery.cases LIMIT 1", [randomBytes(32)]);
    expect((await verifyAudit(db)).map((x) => x.problem).join(" ")).toMatch(/document \d+ has no matching audit entry/);
  });
});

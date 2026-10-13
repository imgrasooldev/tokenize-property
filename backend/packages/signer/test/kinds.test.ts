import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { revoke } from "@pt/kyc";
import { decodeFunctionData, parseTransaction, type Hex } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { distributionRegistryAbi, freezeGuardAbi } from "@pt/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decidePayoutBatch } from "../../bank/src/service.ts";
import { finalizedDistribution, freezeRecon, investor, passRecon, rentOwed, token, world, type World } from "../../bank/test/setup.ts";
import { FileKeystore, writeKeyFile } from "../src/keystore.ts";
import { SignerService, type ChainReader } from "../src/service.ts";

/**
 * Step 5h signing kinds: compliance.freeze (offboarding after a lost verification) and
 * rent.record_payout (the bank file hash on chain). Scratch database with KYC and the bank wired
 * in, scripted chain.
 */
const PASS = "a-long-local-test-passphrase-0123456789";
const A = (n: number): Hex => `0x${n.toString(16).padStart(40, "0")}`;
const FREEZE_GUARD = A(0xf1);
const REGISTRY = A(0xd1);
let w: World;
let keys: FileKeystore;
let tokenAddr: string;
let n = 0;
const state = { frozen: new Set<string>(), distStatus: "finalized" };
const chain: ChainReader = {
  chainId: () => Promise.resolve(586586),
  pendingNonce: () => Promise.resolve(0n),
  simulate: () => Promise.resolve(),
  mintFacts: () => Promise.reject(new Error("not used")),
  txState: () => Promise.resolve("pending"),
  isFrozen: (_r, account) => Promise.resolve(state.frozen.has(account.toLowerCase())),
  distribution: () => Promise.resolve({ status: state.distStatus, token: tokenAddr }),
};
const svc = (): SignerService => new SignerService(w.pool, keys, chain);
const ref = (): string => `cmd:kinds:${String(++n)}:${String(Date.now())}`;

async function policy(kind: string, rule: object): Promise<void> {
  const { rows } = await w.db.query<{ id: string }>("SELECT signer.propose_policy($1, $2::jsonb, 'maker') AS id", [kind, JSON.stringify(rule)]);
  await w.db.query("SELECT signer.approve_policy($1, 'checker')", [rows[0]?.id]);
}

beforeAll(async () => {
  w = await world();
  tokenAddr = token();
  const dir = await mkdtemp(join(tmpdir(), "ks-"));
  await writeKeyFile(dir, "ops", generatePrivateKey(), PASS);
  keys = await FileKeystore.open(dir, PASS);
  await w.db.query("INSERT INTO signer.keys (key_ref, address, purpose) VALUES ('ops', $1, 'test')", [keys.address("ops")]);
  await policy("compliance.freeze", { chainId: 586586, keyRef: "ops", freezeGuard: FREEZE_GUARD, token: tokenAddr, maxPerDay: 2, approvals: 0 });
  await policy("rent.record_payout", { chainId: 586586, keyRef: "ops", registry: REGISTRY, token: tokenAddr, approvals: 0 });
});

afterAll(async () => {
  await w.drop();
});

/** A verified investor with a bound wallet. */
async function walletOwner(): Promise<{ subjectId: string; wallet: Hex }> {
  const wallet: Hex = `0x${randomBytes(20).toString("hex")}`;
  const r = await w.kyc.onboard({ cnic: `4210${String(10_000_000 + ++n).slice(-8)}1`, fullName: "Freeze Candidate", livenessSessionId: `sess-freeze-${String(n).padStart(4, "0")}`, wallet });
  expect(r.status).toBe("verified");
  return { subjectId: r.subjectId, wallet };
}

const freeze = (account: Hex, caseId = `0x${"11".repeat(32)}`) => ({ freezeGuard: FREEZE_GUARD, account, caseId });

describe("compliance.freeze", () => {
  it("never freezes a verified investor; freezes one who lost the verification, encoding FreezeGuard.freezeAddress", async () => {
    const o = await walletOwner();
    expect(await svc().request({ commandRef: ref(), kind: "compliance.freeze", payload: freeze(o.wallet) }, "kyc-worker")).toMatchObject({ status: "denied", reason: /KYC-verified/ });
    await revoke(w.db, o.subjectId, "officer:amna", "Sanctions match confirmed by two officers");
    const r = await svc().request({ commandRef: ref(), kind: "compliance.freeze", payload: freeze(o.wallet) }, "kyc-worker");
    expect(r.status).toBe("signed");
    if (r.status !== "signed") return;
    const tx = parseTransaction(r.raw);
    expect(tx.to).toBe(FREEZE_GUARD);
    const call = decodeFunctionData({ abi: freezeGuardAbi, data: tx.data ?? "0x" });
    expect(call.functionName).toBe("freezeAddress");
    expect(call.args.map((x) => String(x).toLowerCase())).toEqual([o.wallet, `0x${"11".repeat(32)}`]);
  });

  it.each([
    ["an already frozen wallet", (x: Hex) => { state.frozen.add(x); return freeze(x); }, /already frozen/],
    ["another FreezeGuard", (x: Hex) => ({ ...freeze(x), freezeGuard: A(0xee) }), /approved FreezeGuard/],
    ["a zero case id", (x: Hex) => freeze(x, `0x${"00".repeat(32)}`), /zero caseId/],
    ["a malformed payload", (x: Hex) => ({ account: x }), /malformed/],
  ])("denies %s", async (_label, payload, reason) => {
    const o = await walletOwner();
    await revoke(w.db, o.subjectId, "officer:amna", "Investor offboarded by compliance");
    expect(await svc().request({ commandRef: ref(), kind: "compliance.freeze", payload: payload(o.wallet) }, "kyc-worker")).toMatchObject({ status: "denied", reason });
  });

  it("limits automated freezes per day (a compromised caller cannot freeze everyone)", async () => {
    // One freeze was signed in the first test; the policy allows two a day.
    const a = await walletOwner();
    const b = await walletOwner();
    for (const o of [a, b]) await revoke(w.db, o.subjectId, "officer:amna", "Investor offboarded by compliance");
    expect((await svc().request({ commandRef: ref(), kind: "compliance.freeze", payload: freeze(a.wallet) }, "kyc-worker")).status).toBe("signed");
    expect(await svc().request({ commandRef: ref(), kind: "compliance.freeze", payload: freeze(b.wallet) }, "kyc-worker")).toMatchObject({ status: "denied", reason: /daily limit of 2/ });
  });
});

describe("rent.record_payout", () => {
  it("records only the SHA-256 of the submitted bank file, for a finalized distribution, through the reconciliation gate", async () => {
    const inv = await investor(w, "Record Payout");
    await rentOwed(w, tokenAddr, 7n, [{ subjectId: inv.subjectId, amountPaisa: 4_000n }]);
    await finalizedDistribution(w, tokenAddr, 7n, 4_000n);
    await passRecon(w);
    const payload = (hash: string) => ({ registry: REGISTRY, distributionId: "7", payoutBatchHash: hash });
    const anyHash = `0x${"ab".repeat(32)}`;
    expect(await svc().request({ commandRef: ref(), kind: "rent.record_payout", payload: payload(anyHash) }, "bank-service")).toMatchObject({ status: "denied", reason: /no submitted bank payout batch/ });

    const batch = await w.bank.createPayoutBatch({ token: tokenAddr, distributionId: 7n, items: [{ subjectId: inv.subjectId, amountPaisa: 4_000n }], createdBy: "operator:maker" });
    await decidePayoutBatch(w.db, batch, "operator:checker", "approve", "Matches the distribution");
    const sent = await w.bank.submitPayoutBatch(batch, w.mock);
    expect(await svc().request({ commandRef: ref(), kind: "rent.record_payout", payload: payload(anyHash) }, "bank-service")).toMatchObject({ status: "denied", reason: /not the SHA-256 of the submitted bank file/ });

    state.distStatus = "published";
    expect(await svc().request({ commandRef: ref(), kind: "rent.record_payout", payload: payload(sent.fileSha256) }, "bank-service")).toMatchObject({ status: "denied", reason: /published, not finalized/ });
    state.distStatus = "finalized";

    await freezeRecon(w);
    expect(await svc().request({ commandRef: ref(), kind: "rent.record_payout", payload: payload(sent.fileSha256) }, "bank-service")).toMatchObject({ status: "denied", reason: /payouts are not allowed by reconciliation/ });
    await w.db.query("SELECT recon.request_unfreeze('operator:ali', 'Test freeze investigated and resolved')");
    await passRecon(w);
    const { rows } = await w.db.query<{ id: string }>("SELECT id FROM recon.unfreeze_requests WHERE status = 'open'");
    await w.db.query("SELECT recon.decide_unfreeze($1, 'operator:sara', 'approve', 'Checked the investigation notes')", [rows[0]?.id]);

    const r = await svc().request({ commandRef: ref(), kind: "rent.record_payout", payload: payload(sent.fileSha256) }, "bank-service");
    expect(r.status).toBe("signed");
    if (r.status !== "signed") return;
    const tx = parseTransaction(r.raw);
    expect(tx.to).toBe(REGISTRY);
    expect(decodeFunctionData({ abi: distributionRegistryAbi, data: tx.data ?? "0x" })).toEqual({ functionName: "recordPayout", args: [7n, sent.fileSha256] });
  });

  it("the signer role can read the bank file hash but not the bank tables", async () => {
    const c = await w.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL ROLE pt_signer");
      await expect(c.query("SELECT bank.distribution_file_hash($1, 7)", [tokenAddr])).resolves.toBeDefined();
      await c.query("SAVEPOINT s");
      await expect(c.query("SELECT * FROM bank.payout_batches")).rejects.toThrow(/permission denied/);
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  });
});

import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { idFactoryAbi, identityAbi, registrarGuardAbi, tokenAbi } from "@pt/contracts";
import { revoke } from "@pt/kyc";
import { openAccount, postJournal } from "@pt/ledger";
import { decodeFunctionData, parseTransaction, recoverMessageAddress, recoverTransactionAddress, type Hex } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { world, type World } from "../../bank/test/setup.ts";
import { custodialRef, FileKeystore, writeKeyFile } from "../src/keystore.ts";
import { claimHash, claimId } from "../src/policy.ts";
import { SignerService, type ChainReader } from "../src/service.ts";

/**
 * Step 5h kinds for the website (ADR 0010): custody of investor wallets, token.transfer (DvP
 * delivery) and the onboarding kinds identity.create / identity.add_claim / identity.register.
 * Scratch database with KYC and the ledger wired in; scripted chain.
 */
const PASS = "a-long-local-test-passphrase-0123456789";
const A = (n: number): Hex => `0x${n.toString(16).padStart(40, "0")}`;
const ZERO = A(0);
const TOKEN = A(0x70);
const IR = A(0x71);
const ID_FACTORY = A(0x72);
const ISSUER = A(0x73);
const REGISTRAR_GUARD = A(0x74);
let w: World;
let keys: FileKeystore;
let keyDir: string;
let n = 0;

const chainState = {
  verified: new Set<string>(),
  frozen: new Set<string>(),
  paused: false,
  balances: new Map<string, bigint>(),
  identities: new Map<string, string>(),
  registered: new Set<string>(),
  claims: new Map<string, string>(),
};
const chain: ChainReader = {
  chainId: () => Promise.resolve(586586),
  pendingNonce: () => Promise.resolve(0n),
  simulate: () => Promise.resolve(),
  mintFacts: () => Promise.reject(new Error("not used")),
  txState: () => Promise.resolve("pending"),
  isFrozen: () => Promise.resolve(false),
  distribution: () => Promise.reject(new Error("not used")),
  transferFacts: (_rule, from, to) =>
    Promise.resolve({
      recipientVerified: chainState.verified.has(to),
      paused: chainState.paused,
      senderFrozen: chainState.frozen.has(from),
      freeBalance: chainState.balances.get(from) ?? 0n,
    }),
  identityOf: (_f, wallet) => Promise.resolve(chainState.identities.get(wallet) ?? ZERO),
  isRegistered: (_r, wallet) => Promise.resolve(chainState.registered.has(wallet)),
  claimIssuerOf: (identity, id) => Promise.resolve(chainState.claims.get(`${identity}:${id}`) ?? ZERO),
};
const svc = (): SignerService => new SignerService(w.pool, keys, chain);
const ref = (): string => `cmd:web:${String(++n)}:${String(Date.now())}`;

async function policy(kind: string, rule: object): Promise<void> {
  const { rows } = await w.db.query<{ id: string }>("SELECT signer.propose_policy($1, $2::jsonb, 'maker') AS id", [kind, JSON.stringify(rule)]);
  await w.db.query("SELECT signer.approve_policy($1, 'checker')", [rows[0]?.id]);
}

beforeAll(async () => {
  w = await world();
  keyDir = await mkdtemp(join(tmpdir(), "ks-"));
  for (const r of ["identity", "registrar", "claims"]) await writeKeyFile(keyDir, r, generatePrivateKey(), PASS);
  keys = await FileKeystore.open(keyDir, PASS);
  for (const r of ["identity", "registrar", "claims"]) {
    await w.db.query("INSERT INTO signer.keys (key_ref, address, purpose) VALUES ($1, $2, 'test')", [r, keys.address(r)]);
  }
  await policy("token.transfer", { chainId: 586586, token: TOKEN, identityRegistry: IR, maxPerCommand: "1000", maxPerDay: "5000", approvalAbove: "500", approvals: 2 });
  await policy("identity.create", { chainId: 586586, keyRef: "identity", idFactory: ID_FACTORY, maxPerDay: 50 });
  await policy("identity.add_claim", { chainId: 586586, claimKeyRef: "claims", idFactory: ID_FACTORY, claimIssuer: ISSUER, topics: [1, 2], maxPerDay: 100 });
  await policy("identity.register", {
    chainId: 586586, keyRef: "registrar", registrarGuard: REGISTRAR_GUARD, identityRegistry: IR, idFactory: ID_FACTORY, claimIssuer: ISSUER,
    countries: [586], topics: [1, 2], maxPerDay: 50,
  });
});

afterAll(async () => {
  await w.drop();
});

describe("custody (W-1)", () => {
  it("creates a wallet inside the signing service: encrypted key file, custodial record, audit; only the address leaves", async () => {
    const { address } = await svc().createWallet("web");
    expect(address).toMatch(/^0x[0-9a-f]{40}$/);
    expect(existsSync(join(keyDir, `${custodialRef(address)}.json`))).toBe(true);
    const { rows } = await w.db.query<{ origin: string; created_by: string }>("SELECT origin, created_by FROM signer.custodial_wallets WHERE address = $1", [address]);
    expect(rows).toEqual([{ origin: "generated", created_by: "web" }]);
    const audit = await w.db.query("SELECT 1 FROM signer.audit WHERE action = 'custody.created' AND detail->>'address' = $1", [address]);
    expect(audit.rowCount).toBe(1);
    // A reopened keystore (service restart) still holds it.
    expect((await FileKeystore.open(keyDir, PASS)).address(custodialRef(address))).toBe(address);
  });

  it("is append-only and never takes over a platform key", async () => {
    const { address } = await svc().createWallet("web");
    await expect(w.db.query("DELETE FROM signer.custodial_wallets WHERE address = $1", [address])).rejects.toThrow(/append-only/);
    await expect(w.db.query("SELECT signer.register_custodial_wallet($1, 'generated', 'x')", [keys.address("registrar")])).rejects.toThrow(/belongs to a signing key/);
    expect((await w.db.query<{ ok: boolean }>("SELECT signer.register_custodial_wallet($1, 'generated', 'x') AS ok", [address])).rows[0]?.ok).toBe(false);
  });
});

// ------------------------------------------------------------------ token.transfer

async function escrow(paisa: bigint): Promise<string> {
  const order = randomUUID();
  const account = `web:order:${order}:escrow`;
  const cash = `web:investor:${order.slice(0, 8)}:cash`;
  await openAccount(w.pool, { code: "web:bank:client-money", kind: "asset", asset: "PKR" });
  await openAccount(w.pool, { code: cash, kind: "liability", asset: "PKR" });
  await openAccount(w.pool, { code: account, kind: "liability", asset: "PKR" });
  await postJournal(w.pool, { idempotencyKey: `t:${order}:topup`, kind: "cash_topup", createdBy: "test", externalRef: `RAAST-${order.slice(0, 8).toUpperCase()}`, postings: [{ account: "web:bank:client-money", amount: paisa }, { account: cash, amount: -paisa }] });
  await postJournal(w.pool, { idempotencyKey: `t:${order}:reserve`, kind: "order_reserve", createdBy: "test", postings: [{ account: cash, amount: paisa }, { account, amount: -paisa }] });
  return account;
}

async function seller(tokens: bigint): Promise<Hex> {
  const { address } = await svc().createWallet("web");
  chainState.balances.set(address, tokens);
  return address as Hex;
}

function buyer(): Hex {
  const b: Hex = `0x${randomBytes(20).toString("hex")}`;
  chainState.verified.add(b);
  return b;
}

const transfer = (from: string, to: string, amount: bigint, escrowAccount: string, cost: bigint) => ({
  token: TOKEN, from, to, amount: amount.toString(), trade: randomUUID(), escrowAccount, costPaisa: cost.toString(),
});

describe("token.transfer (DvP delivery)", () => {
  it("signs a delivery from the seller's custodial wallet to a verified buyer while the payment is in escrow", async () => {
    const from = await seller(100n);
    const to = buyer();
    const r = await svc().request({ commandRef: ref(), kind: "token.transfer", payload: transfer(from, to, 40n, await escrow(40n * 50_000n), 40n * 50_000n) }, "outbox-worker");
    expect(r.status).toBe("signed");
    if (r.status !== "signed") return;
    expect((await recoverTransactionAddress({ serializedTransaction: r.raw as never })).toLowerCase()).toBe(from);
    const tx = parseTransaction(r.raw);
    expect(tx.to).toBe(TOKEN);
    const call = decodeFunctionData({ abi: tokenAbi, data: tx.data ?? "0x" });
    expect(call.functionName).toBe("transfer");
    expect(call.args.map((x) => String(x).toLowerCase())).toEqual([to, "40"]);
  });

  it("delivers nothing unless the buyer's payment is locked (delivery versus payment)", async () => {
    const from = await seller(100n);
    const cost = 10n * 50_000n;
    expect(await svc().request({ commandRef: ref(), kind: "token.transfer", payload: transfer(from, buyer(), 10n, await escrow(cost - 1n), cost) }, "w")).toMatchObject({
      status: "denied",
      reason: /not locked in escrow/,
    });
    const emptyEscrow = `web:order:${randomUUID()}:escrow`;
    expect(await svc().request({ commandRef: ref(), kind: "token.transfer", payload: transfer(from, buyer(), 10n, emptyEscrow, cost) }, "w")).toMatchObject({ status: "denied", reason: /escrow/ });
    // The escrow fact cannot be pointed at another ledger account.
    await expect(w.db.query("SELECT ledger.escrow_held('web:bank:client-money')")).rejects.toThrow(/not a market escrow/);
  });

  it.each([
    ["a wallet the service does not hold", async () => transfer(`0x${randomBytes(20).toString("hex")}`, buyer(), 5n, await escrow(5n), 5n), /not a custodial wallet/],
    ["an unverified buyer", async () => transfer(await seller(10n), `0x${randomBytes(20).toString("hex")}`, 5n, await escrow(5n), 5n), /recipient is not verified/],
    ["a frozen seller", async () => {
      const s = await seller(10n);
      chainState.frozen.add(s);
      return transfer(s, buyer(), 5n, await escrow(5n), 5n);
    }, /sender is frozen/],
    ["more tokens than the seller holds", async () => transfer(await seller(4n), buyer(), 5n, await escrow(5n), 5n), /enough unfrozen tokens/],
    ["another token", async () => ({ ...transfer(await seller(10n), buyer(), 5n, await escrow(5n), 5n), token: A(0x99) }), /approved token/],
    ["a transfer to oneself", async () => {
      const s = await seller(10n);
      chainState.verified.add(s);
      return transfer(s, s, 5n, await escrow(5n), 5n);
    }, /same wallet/],
    ["an amount over the per-command limit", async () => transfer(await seller(5000n), buyer(), 1001n, await escrow(1001n), 1001n), /per-command limit/],
    ["a malformed payload", async () => ({ ...transfer(await seller(10n), buyer(), 5n, await escrow(5n), 5n), escrowAccount: "web:bank:client-money" }), /malformed/],
  ])("denies %s", async (_label, payload, reason) => {
    expect(await svc().request({ commandRef: ref(), kind: "token.transfer", payload: await payload() }, "w")).toMatchObject({ status: "denied", reason });
  });

  it("refuses everything while the token is paused", async () => {
    chainState.paused = true;
    try {
      expect(await svc().request({ commandRef: ref(), kind: "token.transfer", payload: transfer(await seller(10n), buyer(), 5n, await escrow(5n), 5n) }, "w")).toMatchObject({ status: "denied", reason: /paused/ });
    } finally {
      chainState.paused = false;
    }
  });

  it("waits for two distinct operators above the threshold, then signs", async () => {
    const from = await seller(900n);
    const r = ref();
    const p = transfer(from, buyer(), 600n, await escrow(600n), 600n);
    const first = await svc().request({ commandRef: r, kind: "token.transfer", payload: p }, "outbox-worker");
    expect(first).toMatchObject({ status: "pending_approval", approvalsNeeded: 2 });
    if (first.status !== "pending_approval") return;
    await expect(w.db.query("SELECT signer.decide($1, 'outbox-worker', 'approve', 'self')", [first.requestId])).rejects.toThrow(/maker-checker/);
    await w.db.query("SELECT signer.decide($1, 'ops-ana', 'approve', 'trade checked')", [first.requestId]);
    await w.db.query("SELECT signer.decide($1, 'ops-bilal', 'approve', 'trade checked')", [first.requestId]);
    expect(await svc().request({ commandRef: r, kind: "token.transfer", payload: p }, "outbox-worker")).toMatchObject({ status: "signed" });
  });

  it("limits the tokens delivered per day across all wallets", async () => {
    const used = await w.db.query<{ n: string }>("SELECT coalesce(sum(amount), 0) AS n FROM signer.requests WHERE kind = 'token.transfer' AND status IN ('approved', 'signed', 'broadcast')");
    let room = 5000n - BigInt(used.rows[0]?.n ?? "0");
    while (room > 0n) {
      const amt = room > 500n ? 500n : room;
      expect((await svc().request({ commandRef: ref(), kind: "token.transfer", payload: transfer(await seller(amt), buyer(), amt, await escrow(amt), amt) }, "w")).status).toBe("signed");
      room -= amt;
    }
    expect(await svc().request({ commandRef: ref(), kind: "token.transfer", payload: transfer(await seller(1n), buyer(), 1n, await escrow(1n), 1n) }, "w")).toMatchObject({ status: "denied", reason: /daily limit/ });
  });
});

// ------------------------------------------------------------------ onboarding

/** A custodial wallet whose owner passed KYC (mock providers). */
async function verifiedWallet(): Promise<{ wallet: Hex; subjectId: string }> {
  const { address } = await svc().createWallet("web");
  const r = await w.kyc.onboard({ cnic: `4220${String(10_000_000 + ++n).slice(-8)}1`, fullName: "Onboard Candidate", livenessSessionId: `sess-onb-${String(n).padStart(4, "0")}`, wallet: address });
  expect(r.status).toBe("verified");
  return { wallet: address as Hex, subjectId: r.subjectId };
}

describe("identity.create", () => {
  it("creates an identity only for a KYC-verified custodial wallet that has none, with the identity operator's key", async () => {
    const { address: unverified } = await svc().createWallet("web");
    const create = (wallet: string) => ({ idFactory: ID_FACTORY, wallet, salt: `web-${wallet.slice(2, 14)}` });
    expect(await svc().request({ commandRef: ref(), kind: "identity.create", payload: create(unverified) }, "w")).toMatchObject({ status: "denied", reason: /not KYC-verified/ });

    const { wallet } = await verifiedWallet();
    const r = await svc().request({ commandRef: ref(), kind: "identity.create", payload: create(wallet) }, "w");
    expect(r.status).toBe("signed");
    if (r.status !== "signed") return;
    expect((await recoverTransactionAddress({ serializedTransaction: r.raw as never })).toLowerCase()).toBe(keys.address("identity"));
    const call = decodeFunctionData({ abi: idFactoryAbi, data: parseTransaction(r.raw).data ?? "0x" });
    expect(call.functionName).toBe("createIdentity");

    chainState.identities.set(wallet, A(0xabc));
    expect(await svc().request({ commandRef: ref(), kind: "identity.create", payload: create(wallet) }, "w")).toMatchObject({ status: "denied", reason: /already has an identity/ });
    expect(await svc().request({ commandRef: ref(), kind: "identity.create", payload: { ...create(wallet), idFactory: A(0x99) } }, "w")).toMatchObject({ status: "denied", reason: /approved IdFactory/ });
  });

  it("never acts for a KYC-verified wallet the service does not hold", async () => {
    const outside: Hex = `0x${randomBytes(20).toString("hex")}`;
    const r = await w.kyc.onboard({ cnic: `4230${String(10_000_000 + ++n).slice(-8)}1`, fullName: "Outside Wallet", livenessSessionId: `sess-out-${String(n).padStart(4, "0")}`, wallet: outside });
    expect(r.status).toBe("verified");
    expect(await svc().request({ commandRef: ref(), kind: "identity.create", payload: { idFactory: ID_FACTORY, wallet: outside, salt: "web-outside" } }, "w")).toMatchObject({
      status: "denied",
      reason: /not a custodial wallet/,
    });
  });
});

describe("identity.add_claim", () => {
  it("adds a KYC or AML claim signed by the claim key, as a transaction of the investor's own wallet", async () => {
    const { wallet } = await verifiedWallet();
    const identity = `0x${randomBytes(20).toString("hex")}`;
    const claim = (topic: number, id = identity) => ({ wallet, identity: id, topic });
    expect(await svc().request({ commandRef: ref(), kind: "identity.add_claim", payload: claim(1) }, "w")).toMatchObject({ status: "denied", reason: /no identity yet/ });
    chainState.identities.set(wallet, identity);

    const r = await svc().request({ commandRef: ref(), kind: "identity.add_claim", payload: claim(1) }, "w");
    expect(r.status).toBe("signed");
    if (r.status !== "signed") return;
    expect((await recoverTransactionAddress({ serializedTransaction: r.raw as never })).toLowerCase()).toBe(wallet);
    const tx = parseTransaction(r.raw);
    expect(tx.to).toBe(identity);
    const call = decodeFunctionData({ abi: identityAbi, data: tx.data ?? "0x" });
    expect(call.functionName).toBe("addClaim");
    if (call.functionName !== "addClaim") return;
    const [topic, scheme, issuer, signature] = call.args;
    expect([topic, scheme, issuer.toLowerCase()]).toEqual([1n, 1n, ISSUER]);
    expect((await recoverMessageAddress({ message: { raw: claimHash(identity, 1) }, signature })).toLowerCase()).toBe(keys.address("claims"));

    expect(await svc().request({ commandRef: ref(), kind: "identity.add_claim", payload: claim(3) }, "w")).toMatchObject({ status: "denied", reason: /topic 3/ });
    expect(await svc().request({ commandRef: ref(), kind: "identity.add_claim", payload: claim(2, A(0x55)) }, "w")).toMatchObject({ status: "denied", reason: /not the wallet's identity/ });
  });

  it("signs no claim once the owner lost the verification", async () => {
    const { wallet, subjectId } = await verifiedWallet();
    chainState.identities.set(wallet, A(0xdef));
    await revoke(w.db, subjectId, "officer:amna", "Investor offboarded by compliance");
    const before = (await w.db.query<{ n: string }>("SELECT count(*) AS n FROM signer.requests WHERE status = 'signed'")).rows[0]?.n;
    expect(await svc().request({ commandRef: ref(), kind: "identity.add_claim", payload: { wallet, identity: A(0xdef), topic: 1 } }, "w")).toMatchObject({ status: "denied", reason: /not KYC-verified/ });
    expect((await w.db.query<{ n: string }>("SELECT count(*) AS n FROM signer.requests WHERE status = 'signed'")).rows[0]?.n).toBe(before);
  });
});

describe("identity.register", () => {
  it("registers only once both claims from the trusted issuer are on the wallet's identity, for an allowed country, once", async () => {
    const { wallet } = await verifiedWallet();
    const identity = `0x${randomBytes(20).toString("hex")}`;
    chainState.identities.set(wallet, identity);
    const reg = (country = 586) => ({ registrarGuard: REGISTRAR_GUARD, wallet, identity, country });
    expect(await svc().request({ commandRef: ref(), kind: "identity.register", payload: reg() }, "w")).toMatchObject({ status: "denied", reason: /topic 1, 2/ });
    chainState.claims.set(`${identity}:${claimId(ISSUER, 1)}`, ISSUER);
    chainState.claims.set(`${identity}:${claimId(ISSUER, 2)}`, A(0x66)); // AML claim from someone else
    expect(await svc().request({ commandRef: ref(), kind: "identity.register", payload: reg() }, "w")).toMatchObject({ status: "denied", reason: /topic 2/ });
    chainState.claims.set(`${identity}:${claimId(ISSUER, 2)}`, ISSUER);
    expect(await svc().request({ commandRef: ref(), kind: "identity.register", payload: reg(1) }, "w")).toMatchObject({ status: "denied", reason: /country 1/ });

    const r = await svc().request({ commandRef: ref(), kind: "identity.register", payload: reg() }, "w");
    expect(r.status).toBe("signed");
    if (r.status !== "signed") return;
    expect((await recoverTransactionAddress({ serializedTransaction: r.raw as never })).toLowerCase()).toBe(keys.address("registrar"));
    const tx = parseTransaction(r.raw);
    expect(tx.to).toBe(REGISTRAR_GUARD);
    const call = decodeFunctionData({ abi: registrarGuardAbi, data: tx.data ?? "0x" });
    expect(call.functionName).toBe("register");
    expect(call.args.map((x) => String(x).toLowerCase())).toEqual([wallet, identity, "586"]);

    chainState.registered.add(wallet);
    expect(await svc().request({ commandRef: ref(), kind: "identity.register", payload: reg() }, "w")).toMatchObject({ status: "denied", reason: /already registered/ });
  });

  it("records a denial against the wallet's custodial key in the audit, with a reason", async () => {
    const { address } = await svc().createWallet("web");
    const r = await svc().request({ commandRef: ref(), kind: "identity.add_claim", payload: { wallet: address, identity: A(0x1), topic: 1 } }, "w");
    expect(r).toMatchObject({ status: "denied" });
    const { rows } = await w.db.query<{ key_ref: string; status: string }>("SELECT key_ref, status FROM signer.requests WHERE id = $1", [r.status === "denied" ? r.requestId : null]);
    expect(rows).toEqual([{ key_ref: custodialRef(address), status: "denied" }]);
    expect((await w.db.query("SELECT * FROM signer.verify_audit()")).rows).toEqual([]);
  });
});

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { parseTransaction, recoverTransactionAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { FileKeystore, writeKeyFile } from "../src/keystore.ts";
import { evaluateMint, mintRule, type MintFacts, type MintRule } from "../src/policy.ts";

const PASS = "a-long-local-test-passphrase-0123456789";

describe("FileKeystore (S-1)", () => {
  it("round-trips a key, signs, and never exposes key material", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ks-"));
    const pk = generatePrivateKey();
    const address = await writeKeyFile(dir, "issuance", pk, PASS);
    expect(address).toBe(privateKeyToAccount(pk).address.toLowerCase());
    const file = await readFile(join(dir, "issuance.json"), "utf8");
    expect(file).not.toContain(pk.slice(2));

    const ks = await FileKeystore.open(dir, PASS);
    expect(ks.address("issuance")).toBe(address);
    const raw = await ks.signTransaction("issuance", { type: "legacy", chainId: 586586, nonce: 3, to: address, data: "0x", gas: 21000n, gasPrice: 0n });
    expect((await recoverTransactionAddress({ serializedTransaction: raw as never })).toLowerCase()).toBe(address);
    expect(parseTransaction(raw).nonce).toBe(3);

    const shown = `${JSON.stringify(ks)} ${inspect(ks)}`;
    expect(shown).not.toContain(pk.slice(2));
    expect(shown).not.toContain(pk.slice(2, 20));
  });

  it("refuses a wrong passphrase, a tampered file and a renamed file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ks-"));
    await writeKeyFile(dir, "issuance", generatePrivateKey(), PASS);
    await expect(FileKeystore.open(dir, `${PASS}x`)).rejects.toThrow(/cannot decrypt/);

    const f = JSON.parse(await readFile(join(dir, "issuance.json"), "utf8")) as { cipher: { data: string } };
    const flipped = (f.cipher.data.startsWith("0") ? "1" : "0") + f.cipher.data.slice(1);
    await writeFile(join(dir, "issuance.json"), JSON.stringify({ ...f, cipher: { ...f.cipher, data: flipped } }));
    await expect(FileKeystore.open(dir, PASS)).rejects.toThrow(/cannot decrypt/);

    const dir2 = await mkdtemp(join(tmpdir(), "ks-"));
    await writeKeyFile(dir2, "issuance", generatePrivateKey(), PASS);
    await writeFile(join(dir2, "ops_key.json"), await readFile(join(dir2, "issuance.json")));
    await expect(FileKeystore.open(dir2, PASS)).rejects.toThrow(/does not match its ref/);
  });

  it("refuses short passphrases and never overwrites an existing key file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ks-"));
    await expect(writeKeyFile(dir, "issuance", generatePrivateKey(), "short")).rejects.toThrow(/at least 32/);
    await writeKeyFile(dir, "issuance", generatePrivateKey(), PASS);
    await expect(writeKeyFile(dir, "issuance", generatePrivateKey(), PASS)).rejects.toThrow();
  });
});

const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const rule: MintRule = mintRule.parse({
  chainId: 586586,
  keyRef: "issuance",
  issuance: A(1),
  token: A(2),
  identityRegistry: A(3),
  maxPerCommand: "100000",
  maxPerDay: "300000",
  approvalAbove: "10000",
  approvals: 2,
});
const facts: MintFacts = { chainId: 586586, recipientVerified: true, supply: 0n, cap: 1_000_000n, paused: false, signedToday: 0n };
const payload = (amount: string, extra: object = {}) => ({ issuance: A(1), to: A(9), amount, refId: `0x${"ab".repeat(32)}`, ...extra });

describe("mint policy (deny by default)", () => {
  it("allows a small mint without approval and encodes IssuanceGuard.mint", () => {
    const d = evaluateMint(rule, payload("10000"), facts);
    expect(d).toMatchObject({ decision: "allow", approvalsNeeded: 0, amount: 10000n, to: A(1) });
    if (d.decision === "allow") expect(d.data.startsWith("0x")).toBe(true);
  });

  it("requires maker-checker approval above the threshold", () => {
    expect(evaluateMint(rule, payload("10001"), facts)).toMatchObject({ decision: "allow", approvalsNeeded: 2 });
  });

  it.each([
    ["per-command limit", payload("100001"), facts, /per-command/],
    ["daily limit", payload("50000"), { ...facts, signedToday: 250_001n }, /daily/],
    ["wrong target", payload("10", { issuance: A(7) }), facts, /IssuanceGuard/],
    ["wrong chain", payload("10"), { ...facts, chainId: 1 }, /wrong chain/],
    ["unverified recipient", payload("10"), { ...facts, recipientVerified: false }, /not verified/],
    ["paused token", payload("10"), { ...facts, paused: true }, /paused/],
    ["trustee cap", payload("10"), { ...facts, supply: 999_995n }, /cap/],
    ["zero refId", payload("10", { refId: `0x${"00".repeat(32)}` }), facts, /zero refId/],
    ["malformed amount", payload("-5"), facts, /malformed/],
    ["missing field", { issuance: A(1), amount: "5" }, facts, /malformed/],
  ])("denies: %s", (_label, p, f, reason) => {
    const d = evaluateMint(rule, p, f);
    expect(d.decision).toBe("deny");
    if (d.decision === "deny") expect(d.reason).toMatch(reason);
  });

  it("rejects malformed policies", () => {
    expect(() => mintRule.parse({ ...rule, approvals: 0 })).toThrow();
    expect(() => mintRule.parse({ ...rule, maxPerDay: "-1" })).toThrow();
  });
});

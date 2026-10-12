import { describe, expect, it } from "vitest";
import { normalizeCnic, normalizeName, Peppers, seal, unseal } from "../src/crypto.ts";
import { evidenceHash, MockLiveness, MockNadra, MockSanctions, nameScore, ProviderUnavailable } from "../src/providers.ts";

const key = (n: number): Buffer => Buffer.alloc(32, n);

describe("normalisation", () => {
  it("accepts a CNIC with or without dashes and nothing else", () => {
    expect(normalizeCnic("35202-1234567-1")).toBe("3520212345671");
    expect(normalizeCnic(" 3520212345671 ")).toBe("3520212345671");
    for (const bad of ["35202-1234567", "3520212345671x", "35202 1234567 1", "352021234567123", "", "٣٥٢٠٢١٢٣٤٥٦٧١"]) {
      expect(() => normalizeCnic(bad), bad).toThrow();
    }
  });

  it("makes equivalent spellings of a name equal and keeps non-Latin scripts", () => {
    expect(normalizeName("  Ali   Khan. ")).toBe("ALI KHAN");
    expect(normalizeName("ali-khan")).toBe("ALI KHAN");
    expect(normalizeName("ＡＬＩ ＫＨＡＮ")).toBe("ALI KHAN"); // full-width forms (NFKC)
    expect(normalizeName("علی خان")).toBe("علی خان");
    expect(() => normalizeName("1")).toThrow();
  });
});

describe("peppers", () => {
  it("hashes with domain separation and versions", () => {
    const p = Peppers.of([{ version: 2, key: key(2) }, { version: 1, key: key(1) }]);
    expect(p.current.version).toBe(2);
    expect(p.hash(2, "cnic", "3520212345671")).not.toEqual(p.hash(1, "cnic", "3520212345671"));
    expect(p.hash(2, "cnic", "X")).not.toEqual(p.hash(2, "name", "X"));
    expect(p.hashAll("cnic", "3520212345671").map((h) => h.version)).toEqual([2, 1]);
  });

  it("refuses bad configuration without echoing secrets", () => {
    expect(() => Peppers.of([])).toThrow();
    expect(() => Peppers.of([{ version: 1, key: Buffer.alloc(16) }])).toThrow(/32 bytes/);
    expect(() => Peppers.of([{ version: 1, key: key(1) }, { version: 1, key: key(2) }])).toThrow(/twice/);
    const secret = "ab".repeat(31) + "zz";
    expect(() => Peppers.fromEnv({ KYC_PEPPER_V1: secret, KYC_PEPPER_CURRENT: "1" })).toThrow(/KYC_PEPPER_V1 must be/);
    try {
      Peppers.fromEnv({ KYC_PEPPER_V1: secret, KYC_PEPPER_CURRENT: "1" });
    } catch (e) {
      expect((e as Error).message).not.toContain(secret);
    }
    expect(() => Peppers.fromEnv({ KYC_PEPPER_V1: "00".repeat(32), KYC_PEPPER_CURRENT: "2" })).toThrow(/KYC_PEPPER_CURRENT/);
    expect(Peppers.fromEnv({ KYC_PEPPER_V1: "00".repeat(32), KYC_PEPPER_V2: "11".repeat(32), KYC_PEPPER_CURRENT: "1" }).list.map((x) => x.version)).toEqual([1, 2]);
  });
});

describe("sealing", () => {
  it("round-trips and refuses another record's associated data, a wrong key or a flipped bit", () => {
    const s = seal(key(7), "pt-name-v1:aa", "ALI KHAN");
    expect(unseal(key(7), "pt-name-v1:aa", s)).toBe("ALI KHAN");
    expect(s.toString("utf8")).not.toContain("ALI");
    expect(() => unseal(key(7), "pt-name-v1:bb", s)).toThrow();
    expect(() => unseal(key(8), "pt-name-v1:aa", s)).toThrow();
    const flipped = Buffer.from(s);
    flipped[20] = (flipped[20] ?? 0) ^ 1;
    expect(() => unseal(key(7), "pt-name-v1:aa", flipped)).toThrow();
    expect(seal(key(7), "a", "x")).not.toEqual(seal(key(7), "a", "x")); // random IV
  });
});

describe("mock providers", () => {
  it("NADRA follows the documented last-digit convention", async () => {
    const n = new MockNadra();
    expect((await n.verify({ cnic: "3520212345671", fullName: "ALI" })).outcome).toBe("pass");
    expect((await n.verify({ cnic: "3520212345670", fullName: "ALI" })).reason).toBe("not_found");
    expect((await n.verify({ cnic: "3520212345678", fullName: "ALI" })).reason).toBe("name_mismatch");
    await expect(n.verify({ cnic: "3520212345679", fullName: "ALI" })).rejects.toBeInstanceOf(ProviderUnavailable);
  });

  it("liveness scores and the 80 threshold", async () => {
    const l = new MockLiveness();
    expect(await l.check({ sessionId: "sess-good-0001" })).toMatchObject({ outcome: "pass", score: 93 });
    expect(await l.check({ sessionId: "sess-spoof-0001" })).toMatchObject({ outcome: "fail", score: 12, reason: "spoof_detected" });
    expect(await l.check({ sessionId: "sess-lowlight-01" })).toMatchObject({ outcome: "fail", score: 61, reason: "low_score" });
  });

  it("sanctions: exact hit fails, a partial match goes to review, others are clear", async () => {
    const s = new MockSanctions();
    expect(await s.screen({ fullName: "Zargham Testkhan" })).toMatchObject({ outcome: "fail", reason: "list_hit", score: 100 });
    expect(await s.screen({ fullName: "Bilal Fictitious Khan" })).toMatchObject({ outcome: "review", reason: "possible_match", score: 80 });
    expect(await s.screen({ fullName: "Ayesha Siddiqui" })).toMatchObject({ outcome: "pass", reason: "clear", listVersion: "mock-2026-10-01" });
    expect(nameScore("Testkhan Zargham", "ZARGHAM TESTKHAN")).toBe(100); // word order does not hide a hit
  });

  it("evidence hashes are canonical (key order does not matter)", () => {
    expect(evidenceHash({ a: 1, b: [1, { c: 2, d: 3 }] })).toEqual(evidenceHash({ b: [1, { d: 3, c: 2 }], a: 1 }));
    expect(evidenceHash({ a: 1 })).not.toEqual(evidenceHash({ a: 2 }));
  });
});

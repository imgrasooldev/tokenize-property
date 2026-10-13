import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyDict } from "../src/lib/i18n-verify";
import {
  ageParts,
  ANCHOR_MAX_AGE_MS,
  anchorFresh,
  docTypeName,
  indexGate,
  matchDocument,
  registerCheck,
  sha256Hex,
  type PublicDocument,
} from "../src/lib/verify-rules";
import { serializeRegister } from "../src/lib/server/verify";

const doc = (id: string, sha256: string, supersededBy: string | null = null): PublicDocument => ({
  id,
  docType: "Other",
  sha256,
  uri: `pt-doc://${id}`,
  supersededBy,
  addedBlock: "10",
  addedAt: "2026-10-13T00:00:00.000Z",
});

const H1 = `0x${"11".repeat(32)}`;
const H2 = `0x${"22".repeat(32)}`;

describe("document hash check (PV-11)", () => {
  it("SHA-256 with Web Crypto equals Node's SHA-256 (known vector and random data)", async () => {
    expect(await sha256Hex(new TextEncoder().encode("abc"))).toBe("0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    const big = randomBytes(3 * 1024 * 1024 + 7);
    expect(await sha256Hex(big)).toBe(`0x${createHash("sha256").update(big).digest("hex")}`);
    expect(await sha256Hex(big.buffer.slice(big.byteOffset, big.byteOffset + big.byteLength))).toBe(`0x${createHash("sha256").update(big).digest("hex")}`);
  });

  it("matches a current record, a superseded one, or none", () => {
    const docs = [doc("2", H2), doc("1", H1, "2")];
    expect(matchDocument(H2, docs)).toEqual({ kind: "current", doc: docs[0] });
    expect(matchDocument(H1.toUpperCase().replace("0X", "0x"), docs)).toEqual({ kind: "superseded", doc: docs[1] });
    expect(matchDocument(`0x${"33".repeat(32)}`, docs)).toEqual({ kind: "none" });
    expect(matchDocument(H1, [])).toEqual({ kind: "none" });
  });

  it("prefers a current record when the same hash was recorded again", () => {
    const docs = [doc("1", H1, "2"), doc("3", H1)];
    expect(matchDocument(H1, docs)).toEqual({ kind: "current", doc: docs[1] });
  });

  it("names the DocumentRegistry types in contract order", () => {
    expect(docTypeName(0)).toBe("TitleDeed");
    expect(docTypeName(5)).toBe("AuditReport");
    expect(docTypeName(9)).toBe("Other");
    expect(docTypeName(10)).toBe("Unknown");
  });
});

describe("supply against the trustee register (PV-2)", () => {
  it("is never green without an attestation", () => {
    expect(registerCheck(100n, null)).toEqual({ kind: "not-published" });
  });

  it("is green only when equal; any difference is a mismatch with its size", () => {
    const asOf = new Date("2026-10-13T00:00:00Z");
    expect(registerCheck(60_000n, { units: 60_000n, asOf })).toEqual({ kind: "match", units: 60_000n });
    expect(registerCheck(60_001n, { units: 60_000n, asOf })).toEqual({ kind: "mismatch", units: 60_000n, supply: 60_001n, difference: 1n });
    expect(registerCheck(59_999n, { units: 60_000n, asOf })).toEqual({ kind: "mismatch", units: 60_000n, supply: 59_999n, difference: -1n });
    expect(serializeRegister(registerCheck(5n, { units: 7n, asOf }))).toEqual({ kind: "mismatch", units: "7", supply: "5", difference: "-2" });
  });
});

describe("anchor freshness (PV-23) and read-model gate (section 6)", () => {
  const now = new Date("2026-10-13T12:00:00Z");
  it("warns only above two hours", () => {
    expect(anchorFresh(null, now)).toEqual({ ageMs: null, fresh: false });
    expect(anchorFresh(new Date(now.getTime() - ANCHOR_MAX_AGE_MS), now).fresh).toBe(true);
    expect(anchorFresh(new Date(now.getTime() - ANCHOR_MAX_AGE_MS - 1), now).fresh).toBe(false);
    expect(anchorFresh(new Date(now.getTime() + 5_000), now)).toEqual({ ageMs: 0, fresh: true });
    expect(ageParts(119 * 60_000)).toEqual({ unit: "min", value: 119 });
    expect(ageParts(150 * 60_000)).toEqual({ unit: "h", value: 2 });
  });

  it("never treats a halted or missing read model as current", () => {
    expect(indexGate(null)).toBe("unavailable");
    expect(indexGate({ halted: "chain mismatch", stale: false })).toBe("halted");
    expect(indexGate({ halted: "chain mismatch", stale: true })).toBe("halted");
    expect(indexGate({ halted: null, stale: true })).toBe("stale");
    expect(indexGate({ halted: null, stale: false })).toBe("ok");
  });
});

describe("page texts", () => {
  it("has every text in English and Urdu with the same placeholders", () => {
    const en = verifyDict("en");
    const ur = verifyDict("ur");
    expect(Object.keys(ur).sort()).toEqual(Object.keys(en).sort());
    const holes = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();
    for (const [k, v] of Object.entries(en)) {
      expect(holes(ur[k as keyof typeof ur]), k).toEqual(holes(v));
      expect(ur[k as keyof typeof ur].length, k).toBeGreaterThan(0);
    }
  });
});

import { randomBytes } from "node:crypto";
import fc from "fast-check";
import { Peppers } from "@pt/kyc";
import { describe, expect, it } from "vitest";
import { normalizeRegistration, SponsorSecrets } from "../src/crypto.ts";
import { distanceM, icOutcome, normIdentifier, propertyKey, valuationOutcome, type Vote } from "../src/normalize.ts";
import { checkDocumentAnchors, checkTokenApprovals } from "../src/recon.ts";

/** Pure S-01 rules (no database): normalisation, valuation tolerance, quorum, consistency checks, secrets. */

describe("identifier normalisation (OB-11)", () => {
  it("is idempotent and ignores case, spacing and punctuation that is not between digits", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (s) => {
        const n = normIdentifier(s);
        expect(normIdentifier(n)).toBe(n);
        expect(normIdentifier(` ${s.toUpperCase()} `)).toBe(normIdentifier(s.toUpperCase()));
      }),
      { numRuns: 500 },
    );
  });

  it("Urdu and Arabic-Indic digits equal Western digits; permuted spacing gives the same key", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 999_999 }), fc.integer({ min: 1, max: 9999 }), (plot, soc) => {
        const urdu = String(plot).replace(/[0-9]/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)] ?? d);
        const arabic = String(plot).replace(/[0-9]/g, (d) => "٠١٢٣٤٥٦٧٨٩"[Number(d)] ?? d);
        const a = propertyKey({ province: "sindh", district: "Karachi South", society: `Block ${String(soc)} Clifton`, plot_no: String(plot) });
        expect(propertyKey({ province: "sindh", district: " karachi  south", society: `block${String(soc)}clifton`, plot_no: urdu })).toBe(a);
        expect(propertyKey({ province: "sindh", district: "KARACHI-SOUTH", society: `Block-${String(soc)}, Clifton`, plot_no: arabic })).toBe(a);
      }),
      { numRuns: 200 },
    );
  });

  it("keeps parcels apart that differ only by a separator between digits, and the province", () => {
    expect(normIdentifier("123/4")).not.toBe(normIdentifier("1234"));
    expect(normIdentifier("12/34")).not.toBe(normIdentifier("123/4"));
    expect(propertyKey({ province: "punjab", district: "D", mauza: "M", khasra: "1" })).not.toBe(propertyKey({ province: "kp", district: "D", mauza: "M", khasra: "1" }));
    expect(propertyKey({ province: "punjab", district: "AB", mauza: "C", khasra: "1" })).not.toBe(propertyKey({ province: "punjab", district: "A", mauza: "BC", khasra: "1" }));
  });

  it("GPS distance: 0.0002 degrees of latitude is about 22 m", () => {
    expect(distanceM(31.5, 74.3, 31.5002, 74.3)).toBeGreaterThan(21);
    expect(distanceM(31.5, 74.3, 31.5002, 74.3)).toBeLessThan(23);
  });
});

describe("valuation tolerance (OB-26) and committee quorum (OB-33)", () => {
  const rules = { toleranceBp: 1000n, gapDays: 60 };
  it("exactly 10 % above the lower passes; one paisa more needs a third valuation", () => {
    expect(valuationOutcome([{ valuer: "a", valuePaisa: 100n, valuedOn: "2026-10-01" }, { valuer: "b", valuePaisa: 110n, valuedOn: "2026-10-01" }], rules)).toEqual({ ok: true, problem: null, lowestPaisa: 100n });
    expect(valuationOutcome([{ valuer: "a", valuePaisa: 1000n, valuedOn: "2026-10-01" }, { valuer: "b", valuePaisa: 1101n, valuedOn: "2026-10-01" }], rules).ok).toBe(false);
    expect(valuationOutcome([{ valuer: "a", valuePaisa: 1000n, valuedOn: "2026-01-01" }, { valuer: "b", valuePaisa: 1000n, valuedOn: "2026-03-15" }], rules).problem).toMatch(/apart/);
    const three = valuationOutcome(
      [
        { valuer: "a", valuePaisa: 1000n, valuedOn: "2026-10-01" },
        { valuer: "b", valuePaisa: 1500n, valuedOn: "2026-10-01" },
        { valuer: "c", valuePaisa: 900n, valuedOn: "2026-10-01" },
      ],
      rules,
    );
    expect(three).toEqual({ ok: true, problem: null, lowestPaisa: 900n });
  });

  it("for any two values the rule is (hi - lo) * 10000 <= 1000 * lo, and the cap is the lower one", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 10n ** 15n }), fc.bigInt({ min: 1n, max: 10n ** 15n }), (x, y) => {
        const r = valuationOutcome([{ valuer: "a", valuePaisa: x, valuedOn: "2026-10-01" }, { valuer: "b", valuePaisa: y, valuedOn: "2026-10-01" }], rules);
        const lo = x < y ? x : y;
        const hi = x < y ? y : x;
        expect(r.ok).toBe((hi - lo) * 10_000n <= 1000n * lo);
        expect(r.lowestPaisa).toBe(lo);
      }),
    );
  });

  it("quorum needs three counted votes with an independent member; an independent against blocks", () => {
    const v = (independent: boolean, vote: Vote["vote"], conflict = false): Vote => ({ independent, conflict, vote: conflict ? null : vote });
    expect(icOutcome([v(false, "approve"), v(false, "approve"), v(true, "approve")], 3)).toEqual({ quorum: true, approved: true });
    expect(icOutcome([v(false, "approve"), v(false, "approve"), v(false, "approve")], 3)).toEqual({ quorum: false, approved: false });
    expect(icOutcome([v(false, "approve"), v(false, "approve"), v(true, "reject")], 3)).toEqual({ quorum: true, approved: false });
    expect(icOutcome([v(false, "approve"), v(true, "approve"), v(false, "approve", true)], 3)).toEqual({ quorum: false, approved: false });
    expect(icOutcome([v(false, "approve"), v(false, "abstain"), v(true, "abstain")], 3)).toEqual({ quorum: true, approved: false });
  });
});

describe("consistency checks (S-01 §7.3)", () => {
  const doc = "0f0e0d0c-0b0a-4908-8706-050403020100";
  const sha = `0x${"ab".repeat(32)}`;
  it("hash mismatch, unknown record and unanchored mandatory documents", () => {
    const off = [
      { documentId: doc, token: "0xAA", sha256: sha, current: true, mandatory: true },
      { documentId: "11111111-1111-4111-8111-111111111111", token: "0xaa", sha256: sha, current: true, mandatory: true },
      { documentId: "22222222-2222-4222-8222-222222222222", token: "0xaa", sha256: sha, current: false, mandatory: true },
    ];
    const on = [
      { token: "0xaa", recordId: 1n, sha256: `0x${"cd".repeat(32)}`, uri: `pt-doc://${doc}` },
      { token: "0xaa", recordId: 2n, sha256: sha, uri: "pt-doc://33333333-3333-4333-8333-333333333333" },
      { token: "0xbb", recordId: 3n, sha256: sha, uri: `pt-doc://${doc}` },
    ];
    const f = checkDocumentAnchors(off, on, new Set());
    expect(f.map((x) => `${x.check}:${x.severity}`)).toEqual([
      "documents.hash_mismatch:blocking",
      "documents.unanchored:warning",
      "documents.unknown_onchain:blocking",
      "documents.unknown_onchain:blocking",
    ]);
    expect(checkDocumentAnchors(off, on, new Set(["0xaa"])).find((x) => x.check === "documents.unanchored")?.severity).toBe("blocking");
    const good = { documentId: doc, token: "0xaa", sha256: sha, current: true, mandatory: true };
    expect(checkDocumentAnchors([good], [{ token: "0xAA", recordId: 1n, sha256: sha.toUpperCase().replace("0X", "0x"), uri: `pt-doc://${doc}` }], new Set())).toEqual([]);
  });

  it("a token whose property never reached Tokenization Ready is a blocking finding", () => {
    const props = new Map([
      ["p1", { state: "tokenization_ready", everTokenizationReady: true }],
      ["p2", { state: "legal_approved", everTokenizationReady: false }],
      ["p3", { state: "on_hold", everTokenizationReady: true }],
    ]);
    const f = checkTokenApprovals(
      [
        { token: "0x01", propertyId: "p1" },
        { token: "0x02", propertyId: "p2" },
        { token: "0x03", propertyId: null },
        { token: "0x04", propertyId: "p3" },
      ],
      props,
    );
    expect(f.map((x) => `${x.subject}:${x.actual ?? ""}`)).toEqual(["token 0x02:legal_approved", "token 0x03:no property"]);
  });
});

describe("sponsor secrets (PR-1)", () => {
  it("registration numbers hash the same with or without punctuation, differently per kind and pepper", () => {
    const a = new SponsorSecrets(Peppers.of([{ version: 2, key: randomBytes(32) }, { version: 1, key: randomBytes(32) }]), randomBytes(32));
    const [h2, h1] = a.hashAll("ntn", "1234567-8");
    expect(h2?.version).toBe(2);
    expect(h1?.version).toBe(1);
    expect(a.hashAll("ntn", " 12345678 ")[0]?.hash.equals(h2?.hash ?? Buffer.alloc(0))).toBe(true);
    expect(a.hashAll("cuin", "12345678")[0]?.hash.equals(h2?.hash ?? Buffer.alloc(0))).toBe(false);
    expect(() => normalizeRegistration("cuin", "12-3")).toThrow(/5 to 20/);
  });

  it("sealed values are bound to the sponsor and the field", () => {
    const s = new SponsorSecrets(Peppers.of([{ version: 1, key: randomBytes(32) }]), randomBytes(32));
    const sealed = s.seal("sponsor-1", "name", "Acme (Private) Limited");
    expect(s.unseal("sponsor-1", "name", sealed)).toBe("Acme (Private) Limited");
    expect(() => s.unseal("sponsor-2", "name", sealed)).toThrow();
    expect(() => s.unseal("sponsor-1", "address", sealed)).toThrow();
    expect(() => SponsorSecrets.fromEnv({ PROPERTY_PEPPER_V1: "00".repeat(32), PROPERTY_PEPPER_CURRENT: "2", PROPERTY_DATA_KEY: "00".repeat(32) })).toThrow(/CURRENT/);
  });
});

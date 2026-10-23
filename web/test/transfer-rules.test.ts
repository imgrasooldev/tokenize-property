import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { transferDict, tlabel } from "../src/lib/i18n-transfer";
import {
  acceptSchema,
  agreementSha256,
  CONSIDERATIONS,
  freeTextOk,
  gateError,
  normaliseCode,
  parseTransferList,
  requestIssue,
  requestSchema,
  rupeesToPaisa,
  shortHex,
  tokenChoices,
  TRANSFER_STATES,
  transferErrorKey,
  transferTone,
  withdrawSchema,
} from "../src/lib/transfer-rules";

const TOKEN = `0x${"ab".repeat(20)}`;
const SHA = "c".repeat(64);
const base = {
  token: TOKEN,
  units: "10",
  buyerCode: "TR-AB12-CD34",
  consideration: "sale",
  price: "1,000.50",
  noPriceReason: null,
  agreementSha256: SHA,
  priceExplanation: null,
  holdingReason: null,
};

describe("rupees to paisa (integer, no floating point)", () => {
  it.each([
    ["1000", 100_000n],
    ["1,000.5", 100_050n],
    ["0.01", 1n],
    ["  25.75 ", 2_575n],
    ["9999999999999.99", 999_999_999_999_999n],
  ])("%s -> %s", (s, p) => {
    expect(rupeesToPaisa(s)).toBe(p);
  });
  it.each(["", "0", "0.00", "-5", "1.234", "1e3", "abc", "12345678901234", "1.", ".5"])("refuses %j", (s) => {
    expect(rupeesToPaisa(s)).toBeNull();
  });
});

describe("free text (mirror of compliance.free_text_ok)", () => {
  it("accepts ordinary reasons and refuses CNIC, IBAN and phone numbers or the wrong length", () => {
    expect(freeTextOk("gift to my daughter on her wedding", 10, 500)).toBe(true);
    expect(freeTextOk("too short", 10, 500)).toBe(false);
    expect(freeTextOk("x".repeat(501), 10, 500)).toBe(false);
    expect(freeTextOk("cnic 3520212345671 of my son", 10, 500)).toBe(false);
    expect(freeTextOk("cnic 35202-1234567-1 of my son", 10, 500)).toBe(false);
    expect(freeTextOk("send to pk36 scbl please", 10, 500)).toBe(false);
    expect(freeTextOk("call me on 0300 1234567", 10, 500)).toBe(false);
    expect(freeTextOk("call me on +92 300 1234567", 10, 500)).toBe(false);
  });
});

describe("request form", () => {
  it("parses a sale into integer paisa and normalises the receive code", () => {
    const r = requestSchema.safeParse({ ...base, buyerCode: " tr-ab12-cd34 ", token: TOKEN.toUpperCase().replace("0X", "0x") });
    expect(r.success).toBe(true);
    expect(r.data).toEqual({
      token: TOKEN,
      units: 10n,
      buyerCode: "TR-AB12-CD34",
      consideration: "sale",
      pricePaisa: 100_050n,
      noPriceReason: null,
      agreementSha256: SHA,
      priceExplanation: null,
      holdingReason: null,
    });
  });

  it("a gift has no price and needs a reason; the price field is ignored", () => {
    const r = requestSchema.safeParse({ ...base, consideration: "gift", price: "5", noPriceReason: "  gift for my nephew's graduation " });
    expect(r.data).toMatchObject({ consideration: "gift", pricePaisa: null, noPriceReason: "gift for my nephew's graduation" });
    const missing = requestSchema.safeParse({ ...base, consideration: "family", noPriceReason: "short" });
    expect(missing.success).toBe(false);
    expect(requestIssue(missing.error?.issues ?? [])).toBe("reason");
  });

  it("names the field that failed", () => {
    const issue = (over: Record<string, unknown>) => requestIssue(requestSchema.safeParse({ ...base, ...over }).error?.issues ?? []);
    expect(issue({ price: "0" })).toBe("price");
    expect(issue({ price: "" })).toBe("price");
    expect(issue({ units: "2", price: "9999999999999" })).toBe("price");
    expect(issue({ units: "1.5" })).toBe("units");
    expect(issue({ units: "0" })).toBe("units");
    expect(issue({ buyerCode: "TR-AB12-CD3" })).toBe("code");
    expect(issue({ buyerCode: "TR-ABI2-CD34" })).toBe("code");
    expect(issue({ agreementSha256: "" })).toBe("agreement");
    expect(issue({ agreementSha256: `0x${SHA}` })).toBe("agreement");
    expect(issue({ priceExplanation: "call 03001234567 about it" })).toBe("explanation");
    expect(issue({ holdingReason: "short" })).toBe("explanation");
    expect(issue({ consideration: "court_order" })).toBe("input");
    expect(issue({ token: "0x1234" })).toBe("input");
  });

  it("keeps optional explanations trimmed or null", () => {
    const r = requestSchema.safeParse({ ...base, priceExplanation: "  agreed below the reference price  ", holdingReason: "   " });
    expect(r.data).toMatchObject({ priceExplanation: "agreed below the reference price", holdingReason: null });
  });

  it("accept and withdraw take a case uuid (and the 64-hex fingerprint)", () => {
    const id = "0b9c1a5e-8a4f-4c3e-9d2a-1f0e2d3c4b5a";
    expect(acceptSchema.safeParse({ caseId: id, agreementSha256: SHA.toUpperCase() }).data).toEqual({ caseId: id, agreementSha256: SHA });
    expect(acceptSchema.safeParse({ caseId: id, agreementSha256: "abc" }).success).toBe(false);
    expect(withdrawSchema.safeParse({ caseId: "1" }).success).toBe(false);
    expect(normaliseCode(" tr-ab12 -cd34")).toBe("TR-AB12-CD34");
  });
});

describe("agreement fingerprint", () => {
  it("is the SHA-256 of the file bytes as 64 lower-case hex digits (what the database decodes)", async () => {
    const bytes = new TextEncoder().encode("signed transfer agreement v1");
    expect(await agreementSha256(bytes)).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(await agreementSha256(bytes.buffer)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("backend refusals map to messages", () => {
  // The exact texts raised by the transfer functions and their website wrappers (migration 0028).
  const sql = readFileSync(join(import.meta.dirname, "..", "..", "backend", "packages", "db", "migrations", "0028_transfers.sql"), "utf8").replace(/''/g, "'");

  it.each([
    ["42501", "only a KYC-verified investor can receive units", "kyc"],
    ["42501", "only a KYC-verified investor can request a transfer", "kyc"],
    ["P0002", "the receive code is unknown, used or expired: ask the buyer for a new one", "code"],
    ["P0002", "both investors need a bound wallet", "wallet"],
    ["P0002", "transfer not found", "unknown"],
    ["23514", "three receive codes are already live: use one of them", "codesMax"],
    ["23514", "this is your own receive code", "ownCode"],
    ["23514", "seller and buyer are two different investors", "ownCode"],
    ["23514", "units are a whole number of at least 1 (TR-13)", "units"],
    ["23514", "a sale needs a price per unit in paisa (and no no-consideration reason)", "price"],
    ["23514", "the total price is above the payment limit", "priceLimit"],
    ["23514", "a transfer without consideration has no price and needs a reason of 10 to 500 characters (never a CNIC, IBAN or phone number)", "reason"],
    ["23514", "the SHA-256 of the signed transfer agreement (or court order) is required", "agreement"],
    ["23514", "the agreement fingerprint (SHA-256, 64 hex digits) is required", "agreement"],
    ["23514", "explanations are 10 to 1000 characters and never carry a CNIC, IBAN or phone number", "explanation"],
    ["23514", "no active transfer.propose signing policy: nothing could be executed", "closed"],
    ["23514", "the token is not the one the transfer signing policy names", "token"],
    ["23514", "this transfer is not waiting for your acceptance", "notAwaiting"],
    ["23514", "the agreement fingerprint differs from the seller's: check that you both signed the same document", "mismatch"],
    ["23514", "the transfer can no longer be withdrawn (payment booked or on chain): contact the transfer desk", "noWithdraw"],
    ["23514", "court-ordered transfers are opened by the transfer desk", "input"],
    ["23514", "something new", "generic"],
    ["XX000", "anything else", "generic"],
  ])("%s %s -> %s", (code, message, key) => {
    expect(transferErrorKey(code, message)).toBe(key);
    if (code !== "XX000" && message !== "something new") expect(sql).toContain(message);
  });

  it("maps the passkey gate", () => {
    expect(gateError({ error: "step_up" })).toBe("stepup");
    expect(gateError({ error: "enrol" })).toBe("enrolPasskey");
    expect(gateError({ error: "session" })).toBe("session");
    expect(gateError({ ok: true } as { error?: unknown })).toBeNull();
    expect(gateError(null)).toBeNull();
  });
});

describe("the investor's list", () => {
  const id = "0b9c1a5e-8a4f-4c3e-9d2a-1f0e2d3c4b5a";
  const raw = {
    verified: true,
    codes: [{ code: "TR-AB12-CD34", expiresAt: "2026-10-29T10:00:00.000000Z" }, { code: "bad", expiresAt: "x" }],
    holdings: [{ token: TOKEN.toUpperCase().replace("0X", "0x"), units: "250" }, { token: "0x12", units: "1" }],
    policyToken: TOKEN,
    cases: [
      {
        id,
        role: "buyer",
        status: "approved",
        awaitingAcceptance: false,
        canAccept: false,
        canWithdraw: true,
        token: TOKEN,
        units: "100",
        consideration: "sale",
        pricePaisa: "100000",
        totalPaisa: "10000000",
        agreementSha256: SHA,
        openedAt: "2026-10-22T10:00:00.000000Z",
        updatedAt: "2026-10-22T11:00:00.000000Z",
        payment: { code: "PT-AAAA-BBBB", amountPaisa: "10000000", payUntil: "2026-10-25T11:00:00.000000Z", paid: false },
        eta: null,
        executedAt: null,
        settlement: { grossPaisa: "1", feePaisa: "0", taxPaisa: "0", netPaisa: "1", reference: "x", at: null },
        refund: null,
        // Never displayed even if a future database version sent it.
        sellerSubject: "11111111-1111-4111-8111-111111111111",
        sellerWallet: `0x${"99".repeat(20)}`,
        sellerName: "Somebody Else",
      },
      { id: "not-a-uuid", role: "seller", status: "approved", units: "1", token: TOKEN, consideration: "sale" },
      { id, role: "seller", status: "secret_internal_state", units: "1", token: TOKEN, consideration: "sale" },
    ],
  };

  it("keeps only the known fields; payment for the buyer, settlement for the seller", () => {
    const list = parseTransferList(raw);
    expect(list?.verified).toBe(true);
    expect(list?.codes).toEqual([{ code: "TR-AB12-CD34", expiresAt: "2026-10-29T10:00:00.000000Z" }]);
    expect(list?.holdings).toEqual([{ token: TOKEN, units: "250" }]);
    expect(list?.cases).toHaveLength(1);
    const c = list?.cases[0];
    expect(c).toMatchObject({ id, role: "buyer", status: "approved", units: "100", pricePaisa: "100000", totalPaisa: "10000000", settlement: null });
    expect(c?.payment).toEqual({ code: "PT-AAAA-BBBB", amountPaisa: "10000000", payUntil: "2026-10-25T11:00:00.000000Z", paid: false });
    const text = JSON.stringify(list);
    expect(text).not.toContain("11111111-1111");
    expect(text).not.toContain("99".repeat(20));
    expect(text).not.toContain("Somebody");
    expect(parseTransferList(null)).toBeNull();
    expect(parseTransferList({})).toEqual({ verified: false, codes: [], holdings: [], policyToken: null, cases: [] });
  });

  it("offers held tokens and the policy token, transferable first", () => {
    const other = `0x${"cd".repeat(20)}`;
    expect(tokenChoices({ holdings: [{ token: other, units: "5" }], policyToken: TOKEN })).toEqual([
      { token: TOKEN, units: null, transferable: true },
      { token: other, units: "5", transferable: false },
    ]);
    expect(tokenChoices({ holdings: [{ token: TOKEN, units: "5" }], policyToken: TOKEN })).toEqual([{ token: TOKEN, units: "5", transferable: true }]);
    expect(tokenChoices({ holdings: [], policyToken: null })).toEqual([]);
  });

  it("tones and short forms", () => {
    expect(TRANSFER_STATES.map(transferTone)).toEqual(["warn", "bad", "warn", "cy", "ok", "ok", "warn", "warn", "gray"]);
    expect(shortHex(TOKEN)).toBe("0xabab…abab");
    expect(shortHex("0x12")).toBe("0x12");
  });
});

describe("English and Urdu texts", () => {
  const en = transferDict("en");
  const ur = transferDict("ur");
  const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

  it("have the same keys, none empty, and the same placeholders", () => {
    expect(Object.keys(ur).sort()).toEqual(Object.keys(en).sort());
    for (const [k, v] of Object.entries(en)) {
      const u = new Map(Object.entries(ur)).get(k) ?? "";
      expect(v.length, k).toBeGreaterThan(0);
      expect(u.length, k).toBeGreaterThan(0);
      expect(placeholders(u), k).toEqual(placeholders(v));
    }
  });

  it("label every state, role and type; chips stay one or two words (375 px)", () => {
    for (const d of [en, ur]) {
      for (const s of TRANSFER_STATES) {
        const t = tlabel(d, "st_", s, "");
        expect(t, s).not.toBe("");
        expect(t.split(/\s+/).length, t).toBeLessThanOrEqual(2);
      }
      for (const r of ["seller", "buyer"]) expect(tlabel(d, "role_", r, "").split(/\s+/).length).toBeLessThanOrEqual(2);
      for (const c of [...CONSIDERATIONS, "court_order"]) expect(tlabel(d, "con_", c, "")).not.toBe("");
    }
    expect(en.navTransfers).toBe("Transfers");
    expect(ur.navTransfers).toBe("منتقلیاں");
  });

  it("every error key has words", () => {
    const keys = ["input", "rate", "kyc", "code", "ownCode", "codesMax", "units", "price", "priceLimit", "reason", "agreement", "explanation", "closed", "token", "wallet", "unknown", "notAwaiting", "mismatch", "noWithdraw", "generic", "session"];
    for (const d of [en, ur]) for (const k of keys) expect(tlabel(d, "err_", k, ""), k).not.toBe("");
  });
});

import { describe, expect, it } from "vitest";
import { makeIban, parseIban } from "../src/iban.ts";
import { fileSha256, formatPayoutFile, parsePayoutFile, type PayoutFile } from "../src/payout-file.ts";
import { signWebhook, verifyWebhook, type WebhookKey } from "../src/webhook.ts";

const k1: WebhookKey = { id: "k1", secret: Buffer.alloc(32, 1) };
const k2: WebhookKey = { id: "k2", secret: Buffer.alloc(32, 2) };

describe("IBAN", () => {
  it("accepts valid Pakistani IBANs and rejects wrong check digits or shapes", () => {
    const iban = makeIban("MEZN", "0001234567890123");
    expect(parseIban(iban)).toEqual({ iban, bankCode: "MEZN", last4: "0123" });
    expect(parseIban(iban.toLowerCase().replace(/(.{4})/g, "$1 ")).iban).toBe(iban);
    const wrong = `${iban.slice(0, 2)}${iban[2] === "9" ? "0" : "9"}${iban.slice(3)}`;
    expect(() => parseIban(wrong)).toThrow(/check digits/);
    expect(() => parseIban("GB82WEST12345698765432")).toThrow(/Pakistani/);
    expect(() => parseIban(`${iban}0`)).toThrow();
  });
});

describe("webhook signatures (B-1)", () => {
  const body = '{"id":"evt_1","type":"credit.received"}';
  const now = 1_760_000_000_000;

  it("accepts a correct signature under either active key", () => {
    expect(verifyWebhook([k1, k2], signWebhook(k1, body, now), body, now)).toEqual({ ok: true, keyId: "k1" });
    expect(verifyWebhook([k1, k2], signWebhook(k2, body, now), body, now + 299_000)).toEqual({ ok: true, keyId: "k2" });
  });

  it.each([
    ["no header", () => verifyWebhook([k1], undefined, body, now), "missing"],
    ["garbage", () => verifyWebhook([k1], "sig=abc", body, now), "malformed"],
    ["retired key", () => verifyWebhook([k1], signWebhook(k2, body, now), body, now), "unknown_key"],
    ["edited body", () => verifyWebhook([k1], signWebhook(k1, body, now), body.replace("evt_1", "evt_2"), now), "bad_signature"],
    ["re-serialised body", () => verifyWebhook([k1], signWebhook(k1, body, now), JSON.stringify(JSON.parse(body), null, 1), now), "bad_signature"],
    ["wrong secret, same key id", () => verifyWebhook([{ id: "k1", secret: Buffer.alloc(32, 9) }], signWebhook(k1, body, now), body, now), "bad_signature"],
    ["replayed after 5 minutes", () => verifyWebhook([k1], signWebhook(k1, body, now), body, now + 300_001), "stale"],
    ["timestamp from the future", () => verifyWebhook([k1], signWebhook(k1, body, now + 600_000), body, now), "stale"],
    ["timestamp moved, signature kept", () => verifyWebhook([k1], signWebhook(k1, body, now).replace(String(now), String(now + 1)), body, now), "bad_signature"],
  ])("refuses %s", (_name, check, why) => {
    expect(check()).toEqual({ ok: false, why });
  });
});

describe("payout file", () => {
  const f: PayoutFile = {
    reference: "PTPAY-ABCDEF01-7-K3QZ",
    debitAccount: "TRUSTEE-ESCROW-01",
    totalPaisa: 150_000n,
    lines: [
      { lineNo: 1, iban: makeIban("MEZN", "0001234567890123"), bankCode: "MEZN", amountPaisa: 100_000n, beneficiaryRef: "3f2a9c1e" },
      { lineNo: 2, iban: makeIban("HABB", "0009876543210987"), bankCode: "HABB", amountPaisa: 50_000n, beneficiaryRef: "00ab12cd" },
    ],
  };

  it("is deterministic (same batch, same bytes, same hash) and round-trips", () => {
    expect(formatPayoutFile(f)).toBe(formatPayoutFile(structuredClone(f)));
    expect(fileSha256(formatPayoutFile(f))).toEqual(fileSha256(formatPayoutFile(f)));
    expect(parsePayoutFile(formatPayoutFile(f))).toEqual(f);
    expect(formatPayoutFile(f)).not.toMatch(/name|title/i);
  });

  it("the parser refuses a total that does not add up, renumbered lines or extra fields", () => {
    const text = formatPayoutFile(f);
    expect(() => parsePayoutFile(text.replace('"totalPaisa":"150000"', '"totalPaisa":"150001"'))).toThrow(/add up/);
    expect(parsePayoutFile(text.replace('"lineNo":2', '"lineNo":3')).lines.map((l) => l.lineNo)).toEqual([1, 3]); // a held line 2 is not sent
    expect(() => parsePayoutFile(text.replace('"lineNo":2', '"lineNo":1'))).toThrow(/numbered/);
    expect(() => parsePayoutFile(text.replace('"beneficiaryRef":"00ab12cd"', '"beneficiaryRef":"00ab12cd","name":"X"'))).toThrow();
  });
});

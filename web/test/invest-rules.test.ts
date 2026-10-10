import { describe, expect, it } from "vitest";
import { checkOrder, investSchema, MAX_HOLDING_TOKENS, MIN_TOKENS, paisaToRupees, quotePaisa, refIdFor } from "../src/lib/invest-rules";

const base = { tokens: 100n, holding: 0n, supply: 0n, cap: 1_000_000n, paused: false };
const form = { symbol: "GPF3", tokens: "100", requestId: "3f1c2b7e-9d4a-4c1e-8f2a-1b2c3d4e5f60", bankConfirm: "on" };

describe("quotePaisa", () => {
  it("prices exactly in paisa", () => {
    expect(quotePaisa({ navPkr: 500 }, 1n)).toBe(50_000n);
    expect(quotePaisa({ navPkr: 500 }, 100_000n)).toBe(5_000_000_000n);
  });
  it("refuses fractional or non-positive prices", () => {
    expect(() => quotePaisa({ navPkr: 499.5 }, 1n)).toThrow();
    expect(() => quotePaisa({ navPkr: 0 }, 1n)).toThrow();
  });
});

describe("checkOrder", () => {
  it("accepts an order inside every limit", () => {
    expect(checkOrder(base)).toBeNull();
  });
  it("refuses below the minimum", () => {
    expect(checkOrder({ ...base, tokens: MIN_TOKENS - 1n })).toBe("min");
    expect(checkOrder({ ...base, tokens: MIN_TOKENS })).toBeNull();
  });
  it("enforces the 10% holding limit at the exact boundary", () => {
    expect(checkOrder({ ...base, holding: MAX_HOLDING_TOKENS - 100n })).toBeNull();
    expect(checkOrder({ ...base, holding: MAX_HOLDING_TOKENS - 99n })).toBe("maxHolding");
  });
  it("enforces the trustee cap at the exact boundary", () => {
    expect(checkOrder({ ...base, supply: 999_900n })).toBeNull();
    expect(checkOrder({ ...base, supply: 999_901n })).toBe("cap");
  });
  it("refuses everything while paused", () => {
    expect(checkOrder({ ...base, paused: true })).toBe("paused");
  });
});

describe("refIdFor", () => {
  it("is deterministic, 32 bytes, non-zero and unique per subscription", () => {
    const a = refIdFor("3f1c2b7e-9d4a-4c1e-8f2a-1b2c3d4e5f60");
    expect(a).toMatch(/^0x[0-9a-f]{64}$/);
    expect(a).toBe(refIdFor("3f1c2b7e-9d4a-4c1e-8f2a-1b2c3d4e5f60"));
    expect(a).not.toBe(refIdFor("3f1c2b7e-9d4a-4c1e-8f2a-1b2c3d4e5f61"));
    expect(BigInt(a)).not.toBe(0n);
  });
});

describe("investSchema", () => {
  it("accepts a valid form and converts tokens to bigint", () => {
    const r = investSchema.parse({ ...form, tokens: " 250 " });
    expect(r.tokens).toBe(250n);
  });
  it.each(["0", "-5", "1.5", "1e3", "0x10", "", "12345678", "10 0", "١٠٠"])("rejects token amount %j", (tokens) => {
    expect(investSchema.safeParse({ ...form, tokens }).success).toBe(false);
  });
  it("rejects a missing payment confirmation", () => {
    expect(investSchema.safeParse({ ...form, bankConfirm: null }).success).toBe(false);
  });
  it("rejects a malformed request id or symbol", () => {
    expect(investSchema.safeParse({ ...form, requestId: "not-a-uuid" }).success).toBe(false);
    expect(investSchema.safeParse({ ...form, symbol: "../etc" }).success).toBe(false);
  });
});

describe("paisaToRupees", () => {
  it("formats without floating point", () => {
    expect(paisaToRupees(24_999_500n)).toBe("249,995.00");
    expect(paisaToRupees(1n)).toBe("0.01");
    expect(paisaToRupees(-150n)).toBe("-1.50");
  });
});

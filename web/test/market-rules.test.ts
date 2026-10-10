import { describe, expect, it } from "vitest";
import { candles, checkNewOrder, nextMatch, orderSchema, parseRupees, priceBand, type BookOrder } from "../src/lib/market-rules";

const base = {
  side: "buy" as const,
  tokens: 100n,
  pricePaisa: 50_000n,
  navPkr: 500,
  freeTokens: 0n,
  committedHolding: 0n,
  cashPaisa: 10_000_000n,
  ownOppositeBest: null,
};

const o = (investorId: string, pricePaisa: bigint, remaining: bigint, at: number): BookOrder => ({
  id: `${investorId}-${String(at)}`,
  investorId,
  pricePaisa,
  remaining,
  createdAt: new Date(at),
});

describe("parseRupees", () => {
  it.each([
    ["500", 50_000n],
    ["500.5", 50_050n],
    ["500.05", 50_005n],
    [" 499.99 ", 49_999n],
  ])("parses %j", (s, v) => {
    expect(parseRupees(s)).toBe(v);
  });
  it.each(["0", "0.5", "-1", "500.", "500.123", "5e2", "1,000", "١٠٠", "500.5.5", "", "12345678"])("rejects %j", (s) => {
    expect(parseRupees(s)).toBeNull();
  });
});

describe("priceBand", () => {
  it("is ±10% of NAV in exact paisa", () => {
    expect(priceBand(500)).toEqual({ min: 45_000n, max: 55_000n });
  });
});

describe("checkNewOrder", () => {
  it("accepts an order inside every limit", () => {
    expect(checkNewOrder(base)).toBeNull();
  });
  it("enforces the band at its exact edges", () => {
    expect(checkNewOrder({ ...base, pricePaisa: 45_000n })).toBeNull();
    expect(checkNewOrder({ ...base, pricePaisa: 44_999n })).toBe("band");
    expect(checkNewOrder({ ...base, pricePaisa: 55_000n })).toBeNull();
    expect(checkNewOrder({ ...base, pricePaisa: 55_001n })).toBe("band");
  });
  it("needs the full cost in cash for a buy", () => {
    expect(checkNewOrder({ ...base, cashPaisa: 5_000_000n })).toBeNull();
    expect(checkNewOrder({ ...base, cashPaisa: 4_999_999n })).toBe("noCash");
  });
  it("counts tokens still to arrive against the 10% limit", () => {
    expect(checkNewOrder({ ...base, committedHolding: 99_900n })).toBeNull();
    expect(checkNewOrder({ ...base, committedHolding: 99_901n })).toBe("maxHolding");
  });
  it("lets a seller offer only free tokens", () => {
    expect(checkNewOrder({ ...base, side: "sell", freeTokens: 100n })).toBeNull();
    expect(checkNewOrder({ ...base, side: "sell", freeTokens: 99n })).toBe("noTokens");
  });
  it("refuses orders that would cross the investor's own orders", () => {
    expect(checkNewOrder({ ...base, ownOppositeBest: 50_000n })).toBe("selfTrade");
    expect(checkNewOrder({ ...base, ownOppositeBest: 50_001n })).toBeNull();
    expect(checkNewOrder({ ...base, side: "sell", freeTokens: 100n, ownOppositeBest: 50_000n })).toBe("selfTrade");
    expect(checkNewOrder({ ...base, side: "sell", freeTokens: 100n, ownOppositeBest: 49_999n })).toBeNull();
  });
  it("refuses tiny and oversized orders", () => {
    expect(checkNewOrder({ ...base, tokens: 9n })).toBe("min");
    expect(checkNewOrder({ ...base, tokens: 100_001n, cashPaisa: 10n ** 12n })).toBe("maxOrder");
  });
});

describe("nextMatch", () => {
  it("trades at the earlier (maker) order's price", () => {
    expect(nextMatch(o("b", 51_000n, 50n, 2), o("s", 50_500n, 30n, 1))).toEqual({ pricePaisa: 50_500n, tokens: 30n });
    expect(nextMatch(o("b", 51_000n, 20n, 1), o("s", 50_500n, 30n, 2))).toEqual({ pricePaisa: 51_000n, tokens: 20n });
  });
  it("does not trade when prices do not cross, or with oneself", () => {
    expect(nextMatch(o("b", 49_900n, 10n, 1), o("s", 50_000n, 10n, 2))).toBeNull();
    expect(nextMatch(o("x", 50_000n, 10n, 1), o("x", 50_000n, 10n, 2))).toBeNull();
    expect(nextMatch(undefined, o("s", 50_000n, 10n, 2))).toBeNull();
  });
});

describe("candles", () => {
  it("builds one-minute OHLC with volume", () => {
    const t0 = Date.UTC(2026, 9, 10, 12, 0, 5);
    const k = candles([
      { at: new Date(t0), pricePaisa: 50_000n, tokens: 10n },
      { at: new Date(t0 + 10_000), pricePaisa: 50_500n, tokens: 5n },
      { at: new Date(t0 + 20_000), pricePaisa: 49_800n, tokens: 1n },
      { at: new Date(t0 + 70_000), pricePaisa: 50_100n, tokens: 2n },
    ]);
    expect(k).toEqual([
      { time: t0 / 1000 - 5, open: 500, high: 505, low: 498, close: 498, volume: 16 },
      { time: t0 / 1000 - 5 + 60, open: 501, high: 501, low: 501, close: 501, volume: 2 },
    ]);
  });
});

describe("orderSchema", () => {
  const form = { symbol: "GPF3", side: "buy", price: "500.25", tokens: "10", requestId: "3f1c2b7e-9d4a-4c1e-8f2a-1b2c3d4e5f60" };
  it("parses price into paisa and tokens into bigint", () => {
    expect(orderSchema.parse(form)).toMatchObject({ price: 50_025n, tokens: 10n });
  });
  it("rejects bad side, price or tokens", () => {
    expect(orderSchema.safeParse({ ...form, side: "short" }).success).toBe(false);
    expect(orderSchema.safeParse({ ...form, price: "abc" }).success).toBe(false);
    expect(orderSchema.safeParse({ ...form, tokens: "1000000" }).success).toBe(false);
  });
});

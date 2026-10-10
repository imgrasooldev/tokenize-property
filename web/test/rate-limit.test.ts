import { describe, expect, it } from "vitest";
import { keyFromForwarded, openStream, take } from "../src/lib/server/rate-limit";

describe("take (token bucket)", () => {
  it("allows the burst capacity, then refuses, then refills over time", () => {
    const key = `ip-${String(Math.random())}`;
    const t0 = 1_000_000;
    for (let i = 0; i < 10; i++) expect(take("login", key, t0)).toBe(true);
    expect(take("login", key, t0)).toBe(false);
    expect(take("login", key, t0 + 3_000)).toBe(false); // 0.5 token after 3 s at 10/min
    expect(take("login", key, t0 + 6_000)).toBe(true); // 1 token after 6 s
    expect(take("login", key, t0 + 6_000)).toBe(false);
  });

  it("keeps limits and keys separate", () => {
    const a = `a-${String(Math.random())}`;
    const b = `b-${String(Math.random())}`;
    const t0 = 2_000_000;
    for (let i = 0; i < 10; i++) expect(take("signup", a, t0)).toBe(true);
    expect(take("signup", a, t0)).toBe(false);
    expect(take("signup", b, t0)).toBe(true);
    expect(take("login", a, t0)).toBe(true);
  });
});

describe("openStream", () => {
  it("caps live connections per client and frees a slot exactly once", () => {
    const key = `c-${String(Math.random())}`;
    const slots = [1, 2, 3, 4, 5, 6, 7, 8].map(() => openStream(key));
    expect(slots.every((s) => s !== null)).toBe(true);
    expect(openStream(key)).toBeNull();
    slots[0]?.();
    slots[0]?.(); // a second release must not free another slot
    const again = openStream(key);
    expect(again).not.toBeNull();
    expect(openStream(key)).toBeNull();
  });
});

describe("keyFromForwarded", () => {
  it("ignores X-Forwarded-For unless a trusted proxy is configured", () => {
    const before = process.env.TRUST_PROXY;
    delete process.env.TRUST_PROXY;
    expect(keyFromForwarded("203.0.113.9")).toBe("local");
    process.env.TRUST_PROXY = "1";
    expect(keyFromForwarded("203.0.113.9, 10.0.0.1")).toBe("203.0.113.9");
    expect(keyFromForwarded("<script>")).toBe("local");
    if (before === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = before;
  });
});

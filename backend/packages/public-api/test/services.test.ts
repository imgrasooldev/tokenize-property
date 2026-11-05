import { describe, expect, it } from "vitest";
import type { CatalogueRepository, GrantRepository, InvestorRepository, OfferingRow } from "../src/repositories.ts";
import { AuthService, CatalogueService, decodeCursor, encodeCursor, InvestorService, OAuthError, sha256 } from "../src/services.ts";
import { responseSchema, validate } from "./contract.ts";

/** The service layer against in-memory repositories (ADR 0018 section 3): no database, no HTTP. */
function grants(outcome: Awaited<ReturnType<GrantRepository["exchange"]>> = "ok"): GrantRepository & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    authorize: (_h, code) => {
      calls.push(`authorize:${code}`);
      return Promise.resolve(600);
    },
    exchange: () => Promise.resolve(outcome),
    refresh: () => Promise.resolve("invalid_grant"),
    revoke: () => {
      calls.push("revoke");
      return Promise.resolve();
    },
  };
}

const row = (i: number): OfferingRow => ({
  id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, state: "live", token: null, building: `B${String(i)}`, province: null, district: null, property_use: null,
  price_paisa: "100000", hard_cap_units: "10", min_raise_units: "1", min_units: "1", max_units: "10", paid_units: "0", available_units: "10", opens_at: null, closes_at: null,
});

describe("AuthService", () => {
  it("issues an 8-letter user code without vowels and a 256-bit device code; only hashes reach the repository", async () => {
    const g = grants();
    const a = await new AuthService(g, "http://x/device").deviceAuthorization({ clientId: "pt-mobile" });
    expect(a.user_code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    expect(a.device_code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(g.calls).toEqual([`authorize:${a.user_code.replace("-", "")}`]);
  });

  it("maps every repository outcome to its RFC 8628 error", async () => {
    for (const o of ["authorization_pending", "slow_down", "access_denied", "expired_token", "invalid_grant"] as const) {
      const s = new AuthService(grants(o), "http://x/device");
      await expect(s.token({ grantType: "urn:ietf:params:oauth:grant-type:device_code", clientId: "pt-mobile", deviceCode: "x".repeat(43) })).rejects.toMatchObject({ error: o });
    }
    await expect(new AuthService(grants(), "u").token({ grantType: "client_credentials", clientId: "pt-mobile" })).rejects.toBeInstanceOf(OAuthError);
    await expect(new AuthService(grants(), "u").deviceAuthorization({ clientId: "pt-mobile", scope: "write" })).rejects.toMatchObject({ error: "invalid_scope" });
  });
});

describe("CatalogueService", () => {
  it("pages with an opaque cursor and maps money and units as strings", async () => {
    const repo: CatalogueRepository = { offerings: () => Promise.resolve([row(1), row(2), row(3)]), offering: () => Promise.resolve(null), status: () => Promise.reject(new Error("unused")) };
    const s = new CatalogueService(repo);
    const p1 = await s.offerings(null, 2);
    expect(p1.data.map((o) => o.building)).toEqual(["B1", "B2"]);
    expect(p1.data[0]?.price).toEqual({ amount: "100000", currency: "PKR" });
    const p2 = await s.offerings(p1.next_cursor, 2);
    expect(p2).toMatchObject({ next_cursor: null });
    expect(p2.data.map((o) => o.building)).toEqual(["B3"]);
    expect(() => decodeCursor("garbage")).toThrow(RangeError);
    expect(decodeCursor(encodeCursor(42n))).toBe(42n);
  });
});

describe("InvestorService", () => {
  it("authenticates by the token's hash only and never renders raw parameters", async () => {
    const seen: Buffer[] = [];
    const repo: InvestorRepository = {
      investorOf: (h) => {
        seen.push(h);
        return Promise.resolve("i-1");
      },
      me: () => Promise.resolve(null),
      holdings: () => Promise.resolve([]),
      subscriptions: () => Promise.resolve([]),
      certificates: () => Promise.resolve([]),
      distributions: () => Promise.resolve([]),
      statement: () => Promise.resolve(null),
      notifications: () => Promise.resolve([{ id: "9", kind: "unknown.kind", params: { cnic: "should-not-appear" }, created_at: new Date(0), read: false, subject: "x", body: "y" }]),
      requestReserve: () => Promise.resolve({ error: "token" as const }),
      requestChange: () => Promise.resolve({ error: "token" as const }),
      request: () => Promise.resolve(null),
      subscription: () => Promise.resolve(null),
    };
    const s = new InvestorService(repo);
    expect(await s.authenticate("t".repeat(43))).toEqual(sha256("t".repeat(43)));
    expect(seen[0]).toEqual(sha256("t".repeat(43)));
    const n = await s.notifications(Buffer.alloc(32), "en", null, 20);
    expect(n.data[0]).toEqual({ id: "9", event: "unknown.kind", title: "unknown.kind", body: "", created_at: "1970-01-01T00:00:00.000Z", read: false });
  });
});

describe("InvestorService phase 2a requests", () => {
  const base: InvestorRepository = {
    investorOf: () => Promise.resolve("i-1"),
    me: () => Promise.resolve(null),
    holdings: () => Promise.resolve([]),
    subscriptions: () => Promise.resolve([]),
    certificates: () => Promise.resolve([]),
    distributions: () => Promise.resolve([]),
    statement: () => Promise.resolve(null),
    notifications: () => Promise.resolve([]),
    requestReserve: () => Promise.resolve({ error: "token" as const }),
    requestChange: () => Promise.resolve({ error: "token" as const }),
    request: () => Promise.resolve(null),
    subscription: () => Promise.resolve(null),
  };
  const row = (code: string, replayed: boolean) => ({
    id: "00000000-0000-4000-8000-000000000001",
    kind: "reserve" as const,
    offering_id: "00000000-0000-4000-8000-000000000002",
    units: "10",
    amount_paisa: "1000000",
    status: "pending" as const,
    code,
    created_at: "2026-11-05T00:00:00Z",
    expires_at: "2026-11-05T00:15:00Z",
    subscription_id: null,
    replayed,
  });

  it("draws a new code when one collides, formats it, and links the website's confirmation page", async () => {
    const codes: string[] = [];
    const s = new InvestorService(
      {
        ...base,
        requestReserve: (_h, _o, _u, _k, code) => {
          codes.push(code);
          return Promise.resolve(codes.length === 1 ? { error: "code" as const } : row(code, false));
        },
      },
      "https://site.example/confirm",
    );
    const r = await s.requestReservation(Buffer.alloc(32), { offeringId: "x", units: 10n, idempotencyKey: "key-12345" });
    expect(codes).toHaveLength(2);
    expect(codes[1]).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{8}$/);
    expect(r.created).toBe(true);
    expect(r.body).toMatchObject({ amount: { amount: "1000000", currency: "PKR" }, status: "pending", confirmation_uri: "https://site.example/confirm" });
    expect(r.body.confirmation_code).toBe(`${(codes[1] ?? "").slice(0, 4)}-${(codes[1] ?? "").slice(4)}`);
    expect(r.body.confirmation_uri_complete).toBe(`https://site.example/confirm?code=${r.body.confirmation_code}`);
  });

  it("a replayed key is not created again; refusals become typed errors", async () => {
    const replay = new InvestorService({ ...base, requestReserve: () => Promise.resolve(row("BCDFGHJK", true)) });
    expect((await replay.requestReservation(Buffer.alloc(32), { offeringId: "x", units: 1n, idempotencyKey: "key-12345" })).created).toBe(false);
    for (const reason of ["offering", "conflict", "limit"] as const) {
      const s = new InvestorService({ ...base, requestReserve: () => Promise.resolve({ error: reason }) });
      await expect(s.requestReservation(Buffer.alloc(32), { offeringId: "x", units: 1n, idempotencyKey: "key-12345" })).rejects.toMatchObject({ reason });
    }
  });

  it("phase 2b: a cancel or withdraw request follows the contract; a collided code is drawn again; refusals become typed errors", async () => {
    const codes: string[] = [];
    const sub = "00000000-0000-4000-8000-000000000003";
    const s = new InvestorService({
      ...base,
      requestChange: (_h, target, action, _k, code) => {
        codes.push(code);
        return Promise.resolve(codes.length === 1 ? { error: "code" as const } : { ...row(code, false), kind: action, subscription_id: target });
      },
    });
    const r = await s.requestChange(Buffer.alloc(32), { subscriptionId: sub, action: "withdraw", idempotencyKey: "key-12345" });
    expect(r.created).toBe(true);
    expect(r.body).toMatchObject({ kind: "withdraw", subscription_id: sub, status: "pending" });
    const spec = responseSchema("/me/subscriptions/{subscriptionId}/change-requests", "POST", 201);
    expect(spec).not.toBeNull();
    expect(validate(spec?.schema ?? {}, r.body)).toEqual([]);
    for (const reason of ["unknown", "state", "conflict", "limit", "token"] as const) {
      const x = new InvestorService({ ...base, requestChange: () => Promise.resolve({ error: reason }) });
      await expect(x.requestChange(Buffer.alloc(32), { subscriptionId: sub, action: "cancel", idempotencyKey: "key-12345" })).rejects.toMatchObject({ reason });
    }
  });
});

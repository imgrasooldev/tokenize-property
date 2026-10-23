import { describe, expect, it } from "vitest";
import {
  canRequest,
  EXIT_STATES,
  EXIT_STEPS,
  exitIdempotencyKey,
  exitTimeline,
  gateErrorKey,
  PAYMENT_STATES,
  parseOverview,
  paymentTone,
  ppmPercent,
  redemptionErrorKey,
  redemptionRequestSchema,
  redemptionWithdrawSchema,
  REQUEST_STATES,
  requestTone,
  shortAddress,
  withdrawErrorKey,
  type ExitHolding,
  type RedemptionWindow,
} from "../src/lib/exit-rules";
import { EXIT_DICTS, exitDict, exitLabel } from "../src/lib/i18n-exit";

/** Presentation rules of the investor exit page (S-05 sections 14-15): input shape, overview parsing, timeline, refusals, texts. */

const TOKEN = "0x" + "ab".repeat(20);
const WALLET = "0x" + "cd".repeat(20);
const REQ = "0b8f2c4e-5d6a-4b7c-8d9e-0f1a2b3c4d5e";

describe("request input", () => {
  it("accepts whole positive units, a window id and a v4 request id", () => {
    const r = redemptionRequestSchema.safeParse({ windowId: "7", units: " 25 ", requestId: REQ });
    expect(r.success && r.data.units).toBe(25n);
    expect(r.success && r.data.windowId).toBe("7");
  });

  it("refuses fractions, zero, negatives, huge numbers and bad ids", () => {
    for (const units of ["0", "-1", "1.5", "1e3", "", "abc", "1".repeat(19)]) {
      expect(redemptionRequestSchema.safeParse({ windowId: "7", units, requestId: REQ }).success, units).toBe(false);
    }
    for (const windowId of ["0", "-1", "x", "1".repeat(19), ""]) {
      expect(redemptionRequestSchema.safeParse({ windowId, units: "1", requestId: REQ }).success, windowId).toBe(false);
    }
    expect(redemptionRequestSchema.safeParse({ windowId: "1", units: "1", requestId: "not-a-uuid" }).success).toBe(false);
    expect(redemptionWithdrawSchema.safeParse({ requestId: REQ }).success).toBe(true);
    expect(redemptionWithdrawSchema.safeParse({ requestId: "1; DROP TABLE x" }).success).toBe(false);
  });

  it("builds an idempotency key the database accepts", () => {
    const k = exitIdempotencyKey(REQ);
    expect(k).toMatch(/^[A-Za-z0-9][A-Za-z0-9:._-]{7,99}$/);
    expect(exitIdempotencyKey(REQ)).toBe(k);
  });
});

describe("formatting", () => {
  it("shows a ppm discount as a percentage without float noise", () => {
    expect(ppmPercent(0)).toBe("0");
    expect(ppmPercent(50_000)).toBe("5");
    expect(ppmPercent(125_000)).toBe("12.5");
    expect(ppmPercent(200_000)).toBe("20");
    expect(ppmPercent(1)).toBe("0.0001");
    expect(ppmPercent(-1)).toBe("—");
    expect(ppmPercent(1.5)).toBe("—");
  });

  it("shortens addresses", () => {
    expect(shortAddress(TOKEN)).toBe("0xabab…abab");
    expect(shortAddress("0x12")).toBe("0x12");
  });
});

describe("overview parsing", () => {
  const raw = {
    verified: true,
    wallet: WALLET,
    holdings: [
      {
        token: TOKEN.toUpperCase().replace("0X", "0x"),
        units: "1000",
        paused: true,
        exit: {
          case: 3,
          state: "redeeming",
          recordDate: "2026-10-22",
          voteOpenedAt: null,
          salePricePaisa: "500000000",
          updatedAt: "2026-10-22T10:00:00.000Z",
          final: { status: "booked", grossPaisa: "9007199254740993", whtPaisa: "100", netPaisa: "9007199254740893", units: "1000", distributionId: "1", payment: "held", burned: false },
        },
        windows: [{ id: 4, opensAt: "2026-10-22T00:00:00Z", closesAt: "2026-10-23T00:00:00Z", navPerUnitPaisa: "50000", discountPpm: 50000, pricePerUnitPaisa: "47500", open: true, full: false }],
      },
    ],
    requests: [
      { id: REQ, token: TOKEN, window: 4, units: "10", pricePerUnitPaisa: "47500", indicativePaisa: "475000", status: "submitted", withdrawable: true, createdAt: "2026-10-22T10:00:00Z" },
      { id: "1b8f2c4e-5d6a-4b7c-8d9e-0f1a2b3c4d5e", token: TOKEN, window: 4, units: "5", pricePerUnitPaisa: "47500", indicativePaisa: "237500", status: "declined", withdrawable: true, createdAt: null },
    ],
  };

  it("keeps money exact (bigint) and normalises addresses", () => {
    const o = parseOverview(raw);
    if (o === "session") throw new Error("unexpected");
    expect(o.verified).toBe(true);
    expect(o.wallet).toBe(WALLET);
    const h = o.holdings[0];
    expect(h?.token).toBe(TOKEN);
    expect(h?.units).toBe(1000n);
    expect(h?.exit?.state).toBe("redeeming");
    expect(h?.exit?.caseId).toBe("3");
    expect(h?.exit?.final?.grossPaisa).toBe(9_007_199_254_740_993n);
    expect(h?.exit?.final?.payment).toBe("held");
    expect(h?.windows[0]).toMatchObject({ id: "4", pricePerUnitPaisa: 47_500n, discountPpm: 50_000, open: true, full: false });
    expect(o.requests[0]).toMatchObject({ windowId: "4", units: 10n, indicativePaisa: 475_000n, status: "submitted", withdrawable: true });
  });

  it("never shows an unknown request state, and only a submitted request is withdrawable", () => {
    const o = parseOverview(raw);
    if (o === "session") throw new Error("unexpected");
    expect(o.requests[1]?.status).toBe("under_review");
    expect(o.requests[1]?.withdrawable).toBe(false);
  });

  it("reads the session error and refuses malformed answers", () => {
    expect(parseOverview({ error: "session" })).toBe("session");
    expect(() => parseOverview(null)).toThrow();
    expect(() => parseOverview({ verified: true, holdings: [{ token: "nope", units: "1" }] })).toThrow();
    expect(() => parseOverview({ verified: true, holdings: [{ token: TOKEN, units: "1.5" }] })).toThrow();
    const unverified = parseOverview({ verified: false, holdings: [], requests: [] });
    expect(unverified).toEqual({ verified: false, wallet: null, holdings: [], requests: [] });
  });

  it("drops an exit in a state the website does not know and a payment status it does not know", () => {
    const o = parseOverview({ verified: true, holdings: [{ token: TOKEN, units: "1", exit: { state: "mystery" }, windows: [] }], requests: [] });
    if (o === "session") throw new Error("unexpected");
    expect(o.holdings[0]?.exit).toBeNull();
    const p = parseOverview({
      verified: true,
      holdings: [{ token: TOKEN, units: "1", exit: { case: 1, state: "redeeming", final: { grossPaisa: "1", whtPaisa: "0", netPaisa: "1", units: "1", payment: "returned" } }, windows: [] }],
      requests: [],
    });
    if (p === "session") throw new Error("unexpected");
    expect(p.holdings[0]?.exit?.final?.payment).toBeNull();
  });
});

describe("exit timeline", () => {
  it("marks passed steps done and the current stage", () => {
    const t = exitTimeline("contracted");
    expect(t.outcome).toBeNull();
    expect(t.steps.map((s) => s.status)).toEqual(["done", "done", "done", "current", "todo", "todo", "todo", "todo", "todo", "todo"]);
  });

  it("shows the internal settlement as sale completed, and closed as all done", () => {
    expect(exitTimeline("waterfall").steps.find((s) => s.status === "current")?.step).toBe("completed_sale");
    expect(exitTimeline("closed").steps.every((s) => s.status === "done")).toBe(true);
    expect(exitTimeline("proposed").steps.every((s) => s.status === "todo")).toBe(true);
    expect(exitTimeline("vote_open").steps[0]?.status).toBe("current");
  });

  it("shows no progress for an exit that did not go ahead", () => {
    for (const s of ["rejected", "sale_collapsed"] as const) {
      const t = exitTimeline(s);
      expect(t.outcome).toBe(s);
      expect(t.steps.every((x) => x.status === "todo")).toBe(true);
    }
  });
});

describe("who may request", () => {
  const w: RedemptionWindow = { id: "4", opensAt: "", closesAt: "", navPerUnitPaisa: 1n, discountPpm: 0, pricePerUnitPaisa: 1n, open: true, full: false };
  const h: ExitHolding = { token: TOKEN, units: 10n, paused: false, exit: null, windows: [w] };
  it("only in an open, not-full window, verified, holding units, without a live request there", () => {
    expect(canRequest(w, h, true, [])).toBe(true);
    expect(canRequest(w, h, false, [])).toBe(false);
    expect(canRequest({ ...w, open: false }, h, true, [])).toBe(false);
    expect(canRequest({ ...w, full: true }, h, true, [])).toBe(false);
    expect(canRequest(w, { ...h, units: 0n }, true, [])).toBe(false);
    const live = { id: REQ, token: TOKEN, windowId: "4", units: 1n, pricePerUnitPaisa: 1n, indicativePaisa: 1n, status: "submitted" as const, withdrawable: true, createdAt: null };
    expect(canRequest(w, h, true, [live])).toBe(false);
    expect(canRequest(w, h, true, [{ ...live, status: "withdrawn" }])).toBe(true);
  });

  it("tones", () => {
    expect(requestTone("recorded")).toBe("ok");
    expect(requestTone("under_review")).toBe("warn");
    expect(requestTone("withdrawn")).toBe("gray");
    expect(paymentTone("paid")).toBe("ok");
    expect(paymentTone("held")).toBe("bad");
    expect(paymentTone(null)).toBe("warn");
  });
});

describe("refusals map to investor messages without backend text", () => {
  it("request", () => {
    expect(redemptionErrorKey("42501", "only a verified investor can request a redemption")).toBe("kyc");
    expect(redemptionErrorKey("P0002", "redemption window not found")).toBe("window");
    expect(redemptionErrorKey("23505", "you already have a request in this window: withdraw it first to change it")).toBe("already");
    expect(redemptionErrorKey("22023", "units must be a whole number of at least 1")).toBe("input");
    expect(redemptionErrorKey("23514", "the redemption window is not open")).toBe("closed");
    expect(redemptionErrorKey("23514", "an exit is under way for this property: requests are closed")).toBe("exitUnderway");
    expect(redemptionErrorKey("23514", "your holding cannot be redeemed at the moment: please contact support")).toBe("frozen");
    expect(redemptionErrorKey("23514", "you can request at most the units you hold (free of any hold)")).toBe("balance");
    expect(redemptionErrorKey("23514", "the window is full: it accepts no more units")).toBe("full");
    expect(redemptionErrorKey("23514", "something internal")).toBe("generic");
    expect(redemptionErrorKey("XX000", "boom")).toBe("generic");
    expect(redemptionErrorKey(undefined, "")).toBe("generic");
  });

  it("withdraw", () => {
    expect(withdrawErrorKey("P0002", "request not found")).toBe("unknown");
    expect(withdrawErrorKey("23514", "only a submitted request can be withdrawn")).toBe("state");
    expect(withdrawErrorKey("23514", "the window has closed: the request can no longer be withdrawn")).toBe("closed");
    expect(withdrawErrorKey("40001", "x")).toBe("generic");
  });

  it("passkey gate", () => {
    expect(gateErrorKey({ error: "step_up" })).toBe("stepup");
    expect(gateErrorKey({ error: "enrol" })).toBe("enrolPasskey");
    expect(gateErrorKey({ error: "session" })).toBe("session");
    expect(gateErrorKey({ id: REQ, status: "submitted" })).toBeNull();
    expect(gateErrorKey(undefined)).toBeNull();
  });
});

describe("English and Urdu texts", () => {
  const en = exitDict("en");
  const ur = exitDict("ur");
  const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

  it("have the same keys, none empty, and the same placeholders", () => {
    expect(Object.keys(EXIT_DICTS.ur).sort()).toEqual(Object.keys(EXIT_DICTS.en).sort());
    for (const [k, v] of Object.entries(en)) {
      const u = new Map(Object.entries(ur)).get(k) ?? "";
      expect(v.length, k).toBeGreaterThan(0);
      expect(u.length, k).toBeGreaterThan(0);
      expect(placeholders(u), k).toEqual(placeholders(v));
    }
  });

  it("label every state, step, payment status and refusal the page can show", () => {
    const req: string[] = ["input", "rate", "kyc", "window", "closed", "exitUnderway", "frozen", "balance", "already", "full", "session", "generic"];
    const wd: string[] = ["input", "rate", "unknown", "state", "closed", "session", "generic"];
    for (const d of [en, ur]) {
      for (const s of EXIT_STATES) expect(exitLabel(d, "st_", s, ""), s).not.toBe("");
      for (const s of EXIT_STATES.filter((x) => x !== "rejected" && x !== "sale_collapsed")) expect(exitLabel(d, "now_", s, ""), s).not.toBe("");
      for (const s of EXIT_STEPS) expect(exitLabel(d, "step_", s, ""), s).not.toBe("");
      for (const s of ["rejected", "sale_collapsed"]) expect(exitLabel(d, "out_", s, ""), s).not.toBe("");
      for (const s of [...PAYMENT_STATES, "pending"]) expect(exitLabel(d, "pay_", s, ""), s).not.toBe("");
      for (const s of REQUEST_STATES) expect(exitLabel(d, "rs_", s, ""), s).not.toBe("");
      for (const s of ["open", "soon", "full"]) expect(exitLabel(d, "w_", s, ""), s).not.toBe("");
      for (const s of req) expect(exitLabel(d, "err_", s, ""), s).not.toBe("");
      for (const s of wd) expect(exitLabel(d, "werr_", s, ""), s).not.toBe("");
    }
  });

  it("carry the required disclosures", () => {
    expect(en.discNotGuaranteed).toMatch(/not guaranteed/i);
    expect(en.discUnitsCancelled).toMatch(/cancelled/i);
    expect(en.discTax).toMatch(/LEGAL TO CONFIRM/);
    expect(ur.discTax).toMatch(/LEGAL TO CONFIRM/);
    expect(en.indicativeNote).toMatch(/indicative, not an offer/i);
    expect(en.indicativeNote).toMatch(/no money/i);
    expect(en.requestNote).toMatch(/never ask/i);
    // Declined is never shown as such (no tipping-off).
    for (const d of [en, ur]) expect(Object.keys(d).some((k) => k.includes("declined"))).toBe(false);
  });

  it("keeps state chips to one or two words (chips do not wrap)", () => {
    for (const d of [en, ur]) {
      for (const s of EXIT_STATES) expect(exitLabel(d, "st_", s).split(/\s+/).length, s).toBeLessThanOrEqual(2);
      for (const s of REQUEST_STATES) expect(exitLabel(d, "rs_", s).split(/\s+/).length, s).toBeLessThanOrEqual(2);
      for (const s of [...PAYMENT_STATES, "pending"]) expect(exitLabel(d, "pay_", s).split(/\s+/).length, s).toBeLessThanOrEqual(2);
      for (const s of ["open", "soon", "full"]) expect(exitLabel(d, "w_", s).split(/\s+/).length, s).toBeLessThanOrEqual(2);
    }
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { label, offeringDict } from "../src/lib/i18n-offering";
import {
  bpText,
  canCancel,
  canWithdraw,
  cancelErrorKey,
  countdown,
  countdownText,
  formatPaisa,
  formatPkt,
  idempotencyKey,
  progressBp,
  reserveErrorKey,
  reserveSchema,
  STEPS,
  SUB_STATES,
  timeline,
  totalPaisa,
} from "../src/lib/offering-rules";

/** Presentation rules of the investor offering screens (S-02): integer money, PKT, timeline, input shape, texts. */

const valid = {
  offeringId: "6f1d1c2e-1111-4a2b-8c3d-1234567890ab",
  units: "25",
  requestId: "0b8f2c4e-5d6a-4b7c-8d9e-0f1a2b3c4d5e",
  language: "en",
  docSha: "a".repeat(64),
  riskSha: "b".repeat(64),
  acceptDoc: "on",
  acceptRisk: "on",
};

/** Intl puts a no-break space after the currency symbol. */
const sp = (s: string): string => s.replaceAll(String.fromCharCode(160), " ");

describe("money in integer paisa", () => {
  it("multiplies and formats without floating point, also beyond 2^53", () => {
    expect(totalPaisa(25n, 100_000n)).toBe(2_500_000n);
    expect(sp(formatPaisa(2_500_000n, "en"))).toBe("Rs 25,000.00");
    expect(sp(formatPaisa(12_345n, "en"))).toBe("Rs 123.45");
    expect(sp(formatPaisa(5n, "en"))).toBe("Rs 0.05");
    expect(sp(formatPaisa(0n, "en"))).toBe("Rs 0.00");
    // 9,007,199,254,740,993 paisa: one more than a double can hold exactly.
    expect(sp(formatPaisa(9_007_199_254_740_993n, "en"))).toBe("Rs 90,071,992,547,409.93");
    expect(() => totalPaisa(-1n, 5n)).toThrow();
  });

  it("progress is basis points of the target, capped at 100 %", () => {
    expect(progressBp(0n, 1000n)).toBe(0);
    expect(progressBp(333n, 1000n)).toBe(3330);
    expect(progressBp(1n, 3n)).toBe(3333);
    expect(progressBp(2000n, 1000n)).toBe(10_000);
    expect(progressBp(5n, 0n)).toBe(0);
    expect(bpText(3333)).toBe("33.33");
    expect(bpText(5)).toBe("0.05");
    expect(bpText(10_000)).toBe("100.00");
  });
});

describe("times in Pakistan time (UTC+5, no daylight saving)", () => {
  it("formats in PKT whatever the server's zone", () => {
    expect(formatPkt("2026-10-13T12:05:00.000Z", "en")).toBe("13 Oct 2026, 17:05 PKT");
    expect(formatPkt("2026-12-31T19:30:00.000Z", "en")).toBe("1 Jan 2027, 00:30 PKT");
    expect(formatPkt(new Date("2026-06-30T00:00:00.000Z"), "ur")).toBe("30 جون 2026, 05:00 PKT");
    expect(formatPkt(null, "en")).toBe("—");
    expect(formatPkt("not a date", "en")).toBe("—");
  });

  it("counts down to the reservation expiry and stops at zero", () => {
    const end = "2026-10-13T12:00:00.000Z";
    const c = countdown(end, Date.parse("2026-10-12T10:58:55.500Z"));
    expect(c).toEqual({ done: false, h: 25, m: 1, s: 4 });
    expect(countdownText(c)).toBe("25:01:04");
    expect(countdown(end, Date.parse(end) + 1)).toEqual({ done: true, h: 0, m: 0, s: 0 });
  });
});

describe("reserve form input (shape only; limits are the database's)", () => {
  it("accepts whole units and both acceptances", () => {
    const r = reserveSchema.safeParse(valid);
    expect(r.success).toBe(true);
    expect(r.data?.units).toBe(25n);
  });

  it.each([
    ["decimal units", { units: "10.5" }],
    ["zero units", { units: "0" }],
    ["negative units", { units: "-5" }],
    ["exponent", { units: "1e3" }],
    ["too many digits", { units: "12345678901234" }],
    ["document not accepted", { acceptDoc: null }],
    ["risk not accepted", { acceptRisk: undefined }],
    ["bad document hash", { docSha: "A".repeat(64) }],
    ["bad offering id", { offeringId: "../../etc" }],
    ["request id not v4", { requestId: "6f1d1c2e-1111-1a2b-8c3d-1234567890ab" }],
    ["other language", { language: "fr" }],
  ])("refuses %s", (_label, patch) => {
    expect(reserveSchema.safeParse({ ...valid, ...patch }).success).toBe(false);
  });

  it("builds an idempotency key the backend accepts (OF-17)", () => {
    expect(idempotencyKey(valid.requestId)).toMatch(/^[A-Za-z0-9][A-Za-z0-9:._-]{7,99}$/);
  });
});

describe("subscription timeline", () => {
  const ev = (...states: string[]) => states.map((toState, i) => ({ toState, at: `2026-10-1${String(i)}T00:00:00.000Z` }));
  const statuses = (state: string, events: { toState: string; at: string }[]) => timeline(state, events).steps.map((s) => s.status);

  it("follows reserved -> paid -> allocated -> minted at completion", () => {
    expect(statuses("payment_pending", ev("payment_pending"))).toEqual(["done", "current", "todo", "todo"]);
    expect(statuses("payment_confirmed", ev("payment_pending", "payment_confirmed"))).toEqual(["done", "done", "current", "todo"]);
    expect(statuses("allocation_pending", ev("payment_pending", "payment_confirmed", "allocation_pending"))).toEqual(["done", "done", "done", "current"]);
    const minted = timeline("tokens_issued", ev("payment_pending", "payment_confirmed", "allocation_pending", "tokens_issued"));
    expect(minted.steps.map((s) => s.status)).toEqual(["done", "done", "done", "done"]);
    expect(minted.steps.map((s) => s.at)).toEqual(["2026-10-10T00:00:00.000Z", "2026-10-11T00:00:00.000Z", "2026-10-12T00:00:00.000Z", "2026-10-13T00:00:00.000Z"]);
    expect(minted.outcome).toBeNull();
  });

  it("stops at the right step for refunded, cancelled, expired, rejected and under review", () => {
    expect(timeline("refunded", ev("payment_pending", "payment_confirmed", "refund_pending", "refunded"))).toMatchObject({ outcome: "refunded" });
    expect(statuses("refunded", ev("payment_pending", "payment_confirmed", "refund_pending", "refunded"))).toEqual(["done", "done", "stopped", "todo"]);
    expect(statuses("refund_pending", ev("payment_pending", "payment_confirmed", "allocation_pending", "refund_pending"))).toEqual(["done", "done", "done", "stopped"]);
    expect(statuses("cancelled", ev("payment_pending", "cancelled"))).toEqual(["done", "stopped", "todo", "todo"]);
    expect(statuses("cancelled", ev("waitlisted", "cancelled"))).toEqual(["stopped", "todo", "todo", "todo"]);
    expect(statuses("expired", ev("payment_pending", "expired"))).toEqual(["done", "stopped", "todo", "todo"]);
    expect(statuses("rejected", ev("rejected"))).toEqual(["stopped", "todo", "todo", "todo"]);
    expect(statuses("under_review", ev("payment_pending", "payment_confirmed", "under_review"))).toEqual(["done", "done", "stopped", "todo"]);
    expect(timeline("waitlisted", ev("waitlisted"))).toMatchObject({ outcome: "waitlisted" });
    expect(statuses("waitlisted", ev("waitlisted"))).toEqual(["current", "todo", "todo", "todo"]);
    expect(timeline("issuance_review", ev("payment_pending", "payment_confirmed", "allocation_pending", "issuance_review"))).toMatchObject({ outcome: "issuance_review" });
  });

  it("allows cancelling only before payment (V11)", () => {
    expect(SUB_STATES.filter(canCancel)).toEqual(["kyc_pending", "waitlisted", "payment_pending"]);
  });
});

describe("backend refusals map to messages", () => {
  // The exact texts raised by offering.reserve / accept_document (0015) and web_reserve (0018).
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- two fixed migration files of this repository
  const sql = ["0015_offering.sql", "0018_web_offering.sql"].map((f) => readFileSync(join(import.meta.dirname, "..", "..", "backend", "packages", "db", "migrations", f), "utf8")).join("\n");

  it.each([
    ["42501", "only a KYC-verified investor can reserve units", "kyc"],
    ["23514", "the offering is not open for subscriptions", "notOpen"],
    ["23514", "documents are accepted for a ready or live offering", "notOpen"],
    ["23514", "accept the offering document and the risk disclosure first (OF-10)", "docs"],
    ["23514", "this is not the approved version of the document (OF-10)", "docs"],
    ["23514", "the property is under review again: subscriptions are paused", "paused"],
    ["23505", "the investor already has an open reservation in this offering (OF-17)", "already"],
    ["22023", "units must be between 10 and 50 (OF-4)", "units"],
    ["P0002", "unknown offering", "unknown"],
    ["XX000", "anything else", "generic"],
  ])("%s %s -> %s", (code, message, key) => {
    expect(reserveErrorKey(code, message)).toBe(key);
    if (code !== "XX000") expect(sql).toContain(message.replace(/between 10 and 50/, "between %s and %s"));
  });

  it("cancel refusals", () => {
    expect(cancelErrorKey("P0002")).toBe("unknown");
    expect(cancelErrorKey("23514")).toBe("state");
    expect(cancelErrorKey(undefined)).toBe("generic");
  });
});

describe("English and Urdu texts", () => {
  const en = offeringDict("en");
  const ur = offeringDict("ur");
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

  it("label every state, step and error the screens can show", () => {
    for (const d of [en, ur]) {
      for (const s of SUB_STATES) expect(label(d, "sub_", s, "")).not.toBe("");
      for (const s of STEPS) expect(label(d, "step_", s, "")).not.toBe("");
      for (const s of ["ready", "live", "suspended", "closing", "funded", "completing", "completed", "failed", "refunding", "cancelled"]) expect(label(d, "st_", s, "")).not.toBe("");
      for (const s of ["input", "rate", "kyc", "notOpen", "units", "docs", "already", "paused", "unknown", "generic"]) expect(label(d, "err_", s, "")).not.toBe("");
      for (const s of ["requested", "approved", "sent", "in_review"]) expect(label(d, "rs_", s, "")).not.toBe("");
      for (const s of ["offering_failed", "withdrawal", "eligibility_lost", "allocation_failed"]) expect(label(d, "rc_", s, "")).not.toBe("");
    }
  });

  it("never ask for card or bank credentials, and say so", () => {
    expect(en.reserveNote).toMatch(/never ask/i);
    expect(en.payWarnNever).toMatch(/never ask/i);
  });
});

describe("withdrawal window (S-02 OF-22/OF-23, migration 0036)", () => {
  it("only a paid subscription, only while the window is open", () => {
    const now = Date.parse("2026-10-29T12:00:00Z");
    expect(canWithdraw("payment_confirmed", "2026-10-30T00:00:00Z", now)).toBe(true);
    expect(canWithdraw("payment_confirmed", "2026-10-29T11:59:59Z", now)).toBe(false);
    expect(canWithdraw("payment_confirmed", null, now)).toBe(false);
    for (const s of ["payment_pending", "reserved", "allocated", "refund_pending", "issued"]) expect(canWithdraw(s, "2026-10-30T00:00:00Z", now)).toBe(false);
  });
});

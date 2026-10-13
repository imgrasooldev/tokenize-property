import { refIdForSubscription } from "@pt/recon";
import { describe, expect, it } from "vitest";
import { ACTIONS, isAction, mapError, OfferingError, refIdFor, termsSchema } from "../src/service.ts";

/** Boundary validation and error mapping, without a database. */

describe("terms and inputs", () => {
  it("accepts integer units and paisa only (never floats) and refuses unknown terms", () => {
    expect(termsSchema.safeParse({ pricePaisa: "100000", hardCapUnits: 1000n, earlyClose: true }).success).toBe(true);
    expect(termsSchema.safeParse({ pricePaisa: 1000.5 }).success).toBe(false);
    expect(termsSchema.safeParse({ hardCapUnits: "0" }).success).toBe(false);
    expect(termsSchema.safeParse({ hardCapUnits: "1e3" }).success).toBe(false);
    expect(termsSchema.safeParse({ reservationMinutes: 59 }).success).toBe(false); // OF-16: at least 1 h
    expect(termsSchema.safeParse({ reservationMinutes: 4321 }).success).toBe(false); // at most 72 h
    expect(termsSchema.safeParse({ docEnSha: "A".repeat(64) }).success).toBe(false);
    expect(termsSchema.safeParse({ feePaisa: "10" }).success).toBe(false);
    expect(termsSchema.safeParse({ useOfProceeds: [{ line: "purchase_price", paisa: "1.5" }] }).success).toBe(false);
  });

  it("derives one refId per subscription id, the same way reconciliation and the web prototype do", () => {
    const params = ACTIONS.reserve.params({
      offeringId: "00000000-0000-4000-8000-000000000001",
      subjectId: "00000000-0000-4000-8000-000000000002",
      units: "10",
      category: "retail",
      idempotencyKey: "idem-00000001",
      actor: "investor:x1",
    });
    const [, subscriptionId, refId] = params as [string, string, string];
    expect(refId).toBe(refIdForSubscription(subscriptionId));
    expect(refIdFor(subscriptionId)).toBe(refIdForSubscription(subscriptionId));
    expect(refId).toMatch(/^0x[0-9a-f]{64}$/);
    const again = ACTIONS.reserve.params({
      offeringId: "00000000-0000-4000-8000-000000000001",
      subjectId: "00000000-0000-4000-8000-000000000002",
      units: "10",
      category: "retail",
      idempotencyKey: "idem-00000001",
      actor: "investor:x1",
    }) as [string, string, string];
    expect(again[1]).not.toBe(subscriptionId); // fresh ids; the database returns the first for a repeated key
  });

  it("knows its actions", () => {
    expect(isAction("reserve")).toBe(true);
    expect(isAction("toString")).toBe(false);
    expect(isAction("__proto__")).toBe(false);
  });
});

describe("error mapping", () => {
  it("maps SQLSTATEs to typed errors and passes others through", () => {
    const m = (code: string): unknown => mapError(Object.assign(new Error("x"), { code }));
    expect(m("42501")).toMatchObject({ code: "FORBIDDEN" });
    expect(m("23514")).toMatchObject({ code: "GUARD" });
    expect(m("23505")).toMatchObject({ code: "DUPLICATE" });
    expect(m("P0002")).toMatchObject({ code: "NOT_FOUND" });
    expect(m("22023")).toMatchObject({ code: "INVALID_INPUT" });
    expect(m("22P02")).toBeInstanceOf(OfferingError);
    const other = Object.assign(new Error("connection lost"), { code: "08006" });
    expect(mapError(other)).toBe(other);
  });
});

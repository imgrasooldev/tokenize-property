import { describe, expect, it } from "vitest";
import { checkCompliancePartial, runChecks } from "../src/checks.ts";
import { makeWorld, type World } from "./world.ts";

/**
 * Migration 0054 PF-5: the partial-freeze rules come from recon.compliance_partial() in the
 * database; here, their mapping to findings and severities. The rules themselves run against a
 * real database in signer/test/compliance-partial-freeze.test.ts.
 */
const world = (): World => makeWorld({ subs: [{ outcome: "settled", tokens: 10, paisaPerToken: 1_000, wallet: 0, web: true }], rent: [] });

describe("checkCompliancePartial", () => {
  it("runs only where migration 0054 is applied", () => {
    expect(checkCompliancePartial(world().data)).toEqual([]);
  });

  it("maps each database rule to its finding and severity; an unknown rule is blocking", () => {
    const w = world();
    const row = (check: string) => ({ check, subject: "partial freeze action at block 1 log 1", expected: "e", actual: "a" });
    w.data.compliancePartial = { findings: [row("compliance.partial_unmatched"), row("compliance.partial_pending"), row("compliance.something_new")] };
    expect(checkCompliancePartial(w.data).map((x) => [x.check, x.severity])).toEqual([
      ["compliance.partial_unmatched", "blocking"],
      ["compliance.partial_pending", "warning"],
      ["compliance.partial_unmatched", "blocking"],
    ]);
    expect(runChecks(w.data).some((x) => x.check === "compliance.partial_unmatched")).toBe(true);
  });
});

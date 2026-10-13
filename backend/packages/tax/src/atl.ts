import { createHash } from "node:crypto";

/**
 * The FBR Active Taxpayers List (ATL) check behind a narrow interface (S-03 OP-41). The real
 * adapter (FBR's ATL service or a licensed intermediary) is task T-031; only the mock exists.
 * A provider receives the CNIC in memory for one call and never stores it; we keep the status,
 * the ATL edition (as-of date) and a SHA-256 of the provider's answer as evidence.
 */
export type FilerStatus = "filer" | "non_filer";

export interface AtlResult {
  status: FilerStatus;
  /** The ATL edition the answer comes from (YYYY-MM-DD). */
  asOf: string;
  /** The provider's reference for its answer (no personal data). */
  reference: string;
  evidence: Buffer;
}

export class AtlUnavailable extends Error {
  constructor(readonly reason: string) {
    super(`ATL provider unavailable: ${reason}`);
  }
}

export interface AtlProvider {
  readonly name: string;
  check(cnic: string): Promise<AtlResult>;
}

/**
 * Deterministic mock (LOCAL / TEST ONLY), by the last CNIC digit: 9 = provider unavailable,
 * 1, 3, 5, 7 = filer, every other digit = non-filer. (Mock NADRA already uses 0, 8 and 9.)
 */
export class MockAtl implements AtlProvider {
  readonly name = "mock-atl";
  calls = 0;

  constructor(private readonly asOf: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new Error("as-of date must be YYYY-MM-DD");
  }

  check(cnic: string): Promise<AtlResult> {
    this.calls++;
    const last = cnic.slice(-1);
    if (!/^\d{13}$/.test(cnic)) return Promise.reject(new Error("mock ATL expects 13 digits"));
    if (last === "9") return Promise.reject(new AtlUnavailable("mock: service down"));
    const status: FilerStatus = ["1", "3", "5", "7"].includes(last) ? "filer" : "non_filer";
    const reference = `MOCKATL-${createHash("sha256").update(`atl:${cnic}:${this.asOf}`).digest("hex").slice(0, 12).toUpperCase()}`;
    const evidence = createHash("sha256").update(JSON.stringify({ provider: this.name, reference, status, asOf: this.asOf })).digest();
    return Promise.resolve({ status, asOf: this.asOf, reference, evidence });
  }
}

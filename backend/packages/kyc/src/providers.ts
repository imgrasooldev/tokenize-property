import { createHash, randomUUID } from "node:crypto";
import { normalizeName } from "./crypto.ts";

/**
 * Identity providers behind narrow interfaces (ADR 0009). Production adapters for NADRA Verisys, a
 * liveness vendor and a sanctions list service implement the same interfaces; nothing else in the
 * platform talks to a provider.
 *
 * A provider result carries the raw response as `evidence`. The service stores only its SHA-256
 * (Y-1) and drops the response; the provider keeps its own record under `providerRef`.
 */

export type CheckKind = "nadra" | "liveness" | "sanctions";
export type CheckOutcome = "pass" | "fail" | "review" | "error";

export interface ProviderResult {
  kind: CheckKind;
  outcome: CheckOutcome;
  provider: string;
  providerRef: string;
  /** Short code, no personal data: match, not_found, low_score, possible_match, list_hit, ... */
  reason: string;
  /** Liveness: 0..100 (pass needs >= 80). Sanctions: best match score 0..100. */
  score?: number;
  /** Sanctions: version of the list screened against. */
  listVersion?: string;
  evidence: unknown;
}

export interface NadraVerisys {
  /** cnic: 13 digits; fullName as entered. Throws when the service is unavailable. */
  verify(request: { cnic: string; fullName: string }): Promise<ProviderResult>;
}

export interface LivenessProvider {
  /** sessionId: the vendor's capture session from the investor's device. */
  check(request: { sessionId: string }): Promise<ProviderResult>;
}

export interface SanctionsScreening {
  screen(request: { fullName: string }): Promise<ProviderResult>;
}

export interface KycProviders {
  nadra: NadraVerisys;
  liveness: LivenessProvider;
  sanctions: SanctionsScreening;
}

export class ProviderUnavailable extends Error {
  override name = "ProviderUnavailable";
}

/** SHA-256 of a canonical JSON form of the evidence (keys sorted). */
export function evidenceHash(evidence: unknown): Buffer {
  return createHash("sha256").update(canonicalJson(evidence), "utf8").digest();
}

function canonicalJson(v: unknown): string {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  // eslint-disable-next-line security/detect-object-injection -- keys come from the object itself
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
}

// ------------------------------------------------------------------ mocks (local development and tests)

/**
 * MOCK NADRA Verisys. Deterministic, keyed on the last CNIC digit (the web prototype uses the same
 * convention for 0):
 *   0 -> not_found (fail)   8 -> name_mismatch (fail)   9 -> service unavailable (throws)
 *   anything else -> match (pass)
 */
export class MockNadra implements NadraVerisys {
  calls = 0;
  constructor(private readonly opts: { latencyMs?: number } = {}) {}

  async verify(request: { cnic: string; fullName: string }): Promise<ProviderResult> {
    this.calls++;
    await delay(this.opts.latencyMs);
    const last = request.cnic.at(-1);
    if (last === "9") throw new ProviderUnavailable("mock NADRA Verisys: service unavailable");
    const providerRef = `VRS-${randomUUID()}`;
    const response = { transactionId: providerRef, status: last === "0" ? "NOT_FOUND" : last === "8" ? "NAME_MISMATCH" : "MATCH" };
    return {
      kind: "nadra",
      outcome: response.status === "MATCH" ? "pass" : "fail",
      provider: "mock-nadra-verisys",
      providerRef,
      reason: response.status.toLowerCase(),
      evidence: response,
    };
  }
}

/**
 * MOCK liveness. The session id decides the result: containing "spoof" -> score 12 (fail),
 * "lowlight" -> score 61 (fail, below the 80 threshold), anything else -> score 93 (pass).
 */
export class MockLiveness implements LivenessProvider {
  calls = 0;
  check(request: { sessionId: string }): Promise<ProviderResult> {
    this.calls++;
    const score = request.sessionId.includes("spoof") ? 12 : request.sessionId.includes("lowlight") ? 61 : 93;
    const providerRef = `LIV-${randomUUID()}`;
    return Promise.resolve({
      kind: "liveness",
      outcome: score >= 80 ? "pass" : "fail",
      provider: "mock-liveness",
      providerRef,
      reason: score >= 80 ? "live" : score < 30 ? "spoof_detected" : "low_score",
      score,
      evidence: { sessionId: request.sessionId, score, transactionId: providerRef },
    });
  }
}

/**
 * Fictional names only: the mock list must never contain a real person. Real screening uses the
 * UN Security Council consolidated list and Pakistan's proscribed persons lists (NACTA), through a
 * licensed provider.
 */
export const MOCK_SANCTIONS_LIST = {
  version: "mock-2026-10-01",
  entries: [
    { id: "MOCK-001", name: "ZARGHAM TESTKHAN" },
    { id: "MOCK-002", name: "QAMAR UD DIN SAMPLEWALA" },
    { id: "MOCK-003", name: "BILAL FICTITIOUS" },
  ],
} as const;

/** Token overlap score 0..100 (Dice coefficient on name tokens). */
export function nameScore(a: string, b: string): number {
  const ta = normalizeName(a).split(" ");
  const tb = normalizeName(b).split(" ");
  const setB = new Set(tb);
  const common = new Set(ta.filter((t) => setB.has(t))).size;
  return Math.round((200 * common) / (new Set(ta).size + setB.size));
}

/**
 * MOCK sanctions screening against MOCK_SANCTIONS_LIST: score 100 -> list_hit (fail, final),
 * score >= 60 -> possible_match (review by two officers), else clear (pass).
 */
export class MockSanctions implements SanctionsScreening {
  calls = 0;
  unavailable = false;
  screen(request: { fullName: string }): Promise<ProviderResult> {
    this.calls++;
    if (this.unavailable) return Promise.reject(new ProviderUnavailable("mock sanctions screening: service unavailable"));
    let best: { id: string; score: number } = { id: "", score: 0 };
    for (const e of MOCK_SANCTIONS_LIST.entries) {
      const score = nameScore(request.fullName, e.name);
      if (score > best.score) best = { id: e.id, score };
    }
    const outcome = best.score >= 100 ? "fail" : best.score >= 60 ? "review" : "pass";
    const providerRef = `SCR-${randomUUID()}`;
    return Promise.resolve({
      kind: "sanctions",
      outcome,
      provider: "mock-sanctions",
      providerRef,
      reason: outcome === "fail" ? "list_hit" : outcome === "review" ? "possible_match" : "clear",
      score: best.score,
      listVersion: MOCK_SANCTIONS_LIST.version,
      evidence: { transactionId: providerRef, listVersion: MOCK_SANCTIONS_LIST.version, bestEntry: best.id || null, score: best.score },
    });
  }
}

export function mockProviders(): KycProviders & { nadra: MockNadra; liveness: MockLiveness; sanctions: MockSanctions } {
  return { nadra: new MockNadra(), liveness: new MockLiveness(), sanctions: new MockSanctions() };
}

async function delay(ms: number | undefined): Promise<void> {
  if (ms) await new Promise((r) => setTimeout(r, ms));
}

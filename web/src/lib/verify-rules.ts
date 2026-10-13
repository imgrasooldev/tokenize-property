/**
 * Rules of the public verification page (S-07), as pure functions shared by the server and the
 * browser. No server code, no personal data.
 */

/** DocumentRegistry.DocType, in contract order (contract-spec section 6). */
export const DOC_TYPES = [
  "TitleDeed",
  "LandRecord",
  "Valuation",
  "Insurance",
  "TrustDeed",
  "AuditReport",
  "ShariahCertificate",
  "CourtOrder",
  "InvestorVote",
  "Other",
] as const;
export type DocTypeName = (typeof DOC_TYPES)[number] | "Unknown";

export function docTypeName(code: number): DocTypeName {
  return DOC_TYPES.at(code) ?? "Unknown";
}

/** The public view of one DocumentRegistry record (PV-10). */
export interface PublicDocument {
  id: string;
  docType: DocTypeName;
  sha256: string;
  uri: string;
  supersededBy: string | null;
  addedBlock: string;
  /** ISO time of the block that added it. */
  addedAt: string;
}

export type DocumentMatch = { kind: "current"; doc: PublicDocument } | { kind: "superseded"; doc: PublicDocument } | { kind: "none" };

/**
 * PV-11: what a locally computed SHA-256 matches. A current record wins over a superseded one with
 * the same hash (the same file may have been added again after a correction).
 */
export function matchDocument(sha256: string, docs: readonly PublicDocument[]): DocumentMatch {
  const h = sha256.toLowerCase();
  const hits = docs.filter((d) => d.sha256.toLowerCase() === h);
  const current = hits.find((d) => d.supersededBy === null);
  if (current) return { kind: "current", doc: current };
  const old = hits.at(0);
  return old ? { kind: "superseded", doc: old } : { kind: "none" };
}

/** SHA-256 of bytes with Web Crypto (browser and Node), as 0x-prefixed lower-case hex. */
export async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return `0x${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** Largest file the page hashes in the browser (Web Crypto needs the whole file in memory). */
export const MAX_HASH_BYTES = 256 * 1024 * 1024;

/** A trustee register attestation (PV-2): units outstanding as of a time. */
export interface RegisterAttestation {
  units: bigint;
  asOf: Date;
}

export type RegisterCheck =
  | { kind: "not-published" }
  | { kind: "match"; units: bigint }
  /** `supply.register_mismatch` (S-02): blocking reconciliation finding. */
  | { kind: "mismatch"; units: bigint; supply: bigint; difference: bigint };

/** PV-2: green only when the token supply equals the trustee's attested units. */
export function registerCheck(supply: bigint, attestation: RegisterAttestation | null): RegisterCheck {
  if (!attestation) return { kind: "not-published" };
  if (attestation.units === supply) return { kind: "match", units: supply };
  return { kind: "mismatch", units: attestation.units, supply, difference: supply - attestation.units };
}

/** PV-23: an anchor older than this is shown with a warning. */
export const ANCHOR_MAX_AGE_MS = 2 * 60 * 60 * 1000;

export function anchorFresh(latestConfirmedAt: Date | null, now: Date): { ageMs: number | null; fresh: boolean } {
  if (!latestConfirmedAt) return { ageMs: null, fresh: false };
  const ageMs = Math.max(0, now.getTime() - latestConfirmedAt.getTime());
  return { ageMs, fresh: ageMs <= ANCHOR_MAX_AGE_MS };
}

/** The read model's state as the page must present it (S-07 section 6, ADR 0006/0010). */
export type IndexGate = "unavailable" | "halted" | "stale" | "ok";

export function indexGate(status: { halted: string | null; stale: boolean } | null): IndexGate {
  if (!status) return "unavailable";
  if (status.halted !== null) return "halted";
  return status.stale ? "stale" : "ok";
}

/** Formats a duration for "age" labels: minutes below two hours, then hours. */
export function ageParts(ms: number): { unit: "min" | "h"; value: number } {
  const min = Math.floor(ms / 60_000);
  return min < 120 ? { unit: "min", value: min } : { unit: "h", value: Math.floor(min / 60) };
}

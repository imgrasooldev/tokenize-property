/**
 * Consistency checks of S-01 §7.3 and T-021 ("no property can reach token deployment without all
 * approvals"), as pure functions: no I/O, no clock, sorted output, same shape as @pt/recon findings.
 * TODO(T-021 follow-up): load the inputs (property.document_list, the indexer's DocumentRegistry
 * events, the token-to-property mapping from S-02) in @pt/recon and add these names to its CHECKS.
 */

export type PropertyCheckName =
  | "documents.hash_mismatch"
  | "documents.unanchored"
  | "documents.unknown_onchain"
  | "property.token_without_approval";

export interface PropertyFinding {
  check: PropertyCheckName;
  severity: "blocking" | "warning";
  subject: string;
  expected?: string;
  actual?: string;
}

/** A current or superseded off-chain document of a property whose token is deployed. */
export interface OffchainDocument {
  documentId: string;
  token: string;
  /** 0x + 64 hex. */
  sha256: string;
  current: boolean;
  mandatory: boolean;
}

/** A DocumentRegistry record from the indexer's read model. */
export interface OnchainDocument {
  token: string;
  recordId: bigint;
  sha256: string;
  /** `pt-doc://<documentId>` (OB-41). */
  uri: string;
}

const URI = /^pt-doc:\/\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/**
 * documents.hash_mismatch (blocking): an on-chain record whose hash differs from the document its uri names.
 * documents.unanchored (warning; blocking once the token's offering is live): a mandatory current document without a record.
 * documents.unknown_onchain (blocking): a record that names no off-chain document of that token (or no document at all).
 */
export function checkDocumentAnchors(offchain: OffchainDocument[], onchain: OnchainDocument[], liveTokens: ReadonlySet<string>): PropertyFinding[] {
  const out: PropertyFinding[] = [];
  const byId = new Map(offchain.map((d) => [d.documentId, d]));
  const anchored = new Set<string>();
  for (const r of onchain) {
    const id = URI.exec(r.uri)?.[1];
    const doc = id ? byId.get(id) : undefined;
    if (!doc || doc.token.toLowerCase() !== r.token.toLowerCase()) {
      out.push({ check: "documents.unknown_onchain", severity: "blocking", subject: `record ${r.recordId.toString()} of ${r.token.toLowerCase()}`, actual: r.uri });
      continue;
    }
    anchored.add(doc.documentId);
    if (doc.sha256.toLowerCase() !== r.sha256.toLowerCase()) {
      out.push({
        check: "documents.hash_mismatch",
        severity: "blocking",
        subject: `document ${doc.documentId}`,
        expected: doc.sha256.toLowerCase(),
        actual: r.sha256.toLowerCase(),
      });
    }
  }
  for (const d of offchain) {
    if (d.mandatory && d.current && !anchored.has(d.documentId)) {
      out.push({
        check: "documents.unanchored",
        severity: liveTokens.has(d.token.toLowerCase()) ? "blocking" : "warning",
        subject: `document ${d.documentId}`,
        actual: d.token.toLowerCase(),
      });
    }
  }
  return out.sort((a, b) => a.check.localeCompare(b.check) || a.subject.localeCompare(b.subject));
}

/** States from which a token may exist: Tokenization Ready (S-01) and the S-02/S-05 states after it. */
export const DEPLOYABLE_STATES: ReadonlySet<string> = new Set(["tokenization_ready", "offering_live", "funded", "operating", "exit_in_progress", "closed"]);

/**
 * property.token_without_approval (blocking): a deployed token mapped to no property, or to a property
 * that never reached Tokenization Ready (OB-38: TR is the only entry to S-02).
 */
export function checkTokenApprovals(
  tokens: { token: string; propertyId: string | null }[],
  properties: ReadonlyMap<string, { state: string; everTokenizationReady: boolean }>,
): PropertyFinding[] {
  const out: PropertyFinding[] = [];
  for (const t of tokens) {
    const p = t.propertyId ? properties.get(t.propertyId) : undefined;
    if (!p || !p.everTokenizationReady) {
      out.push({
        check: "property.token_without_approval",
        severity: "blocking",
        subject: `token ${t.token.toLowerCase()}`,
        expected: "a property that reached tokenization_ready",
        actual: p ? p.state : "no property",
      });
    }
  }
  return out.sort((a, b) => a.subject.localeCompare(b.subject));
}

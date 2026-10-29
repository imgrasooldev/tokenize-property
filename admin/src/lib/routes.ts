import type { Permission } from "./permissions";

/**
 * Every page and API route of the portal with its access rule. The authorisation test matrix
 * checks that this list matches the files under src/app exactly, and then exercises each entry
 * for every role, anonymous visitors and an investor website cookie.
 *
 * access:
 * - "public":    anyone (health check only, no data)
 * - "anonymous": sign-in ceremonies; usable without a session
 * - "officer":   any signed-in officer (their own account, sign-out, step-up)
 * - a Permission: officers whose roles grant it (database-enforced as well)
 * - "audit-source": the permission of the [source] segment (AUDIT_SOURCES), plus audit.export to export
 */
export type Access = "public" | "anonymous" | "officer" | "audit-source" | Permission;

export interface RouteRule {
  /** App-router path as written in src/app ([param] segments kept). */
  path: string;
  kind: "page" | "api";
  methods: readonly ("GET" | "POST")[];
  access: Access;
  /** Mutating routes need the same-origin check and (with a session) the CSRF token. */
  mutating: boolean;
}

export const ROUTES: readonly RouteRule[] = [
  { path: "/", kind: "page", methods: ["GET"], access: "ops.read", mutating: false },
  { path: "/login", kind: "page", methods: ["GET"], access: "anonymous", mutating: false },
  { path: "/enrol", kind: "page", methods: ["GET"], access: "anonymous", mutating: false },
  { path: "/account", kind: "page", methods: ["GET"], access: "officer", mutating: false },
  { path: "/audit", kind: "page", methods: ["GET"], access: "officer", mutating: false },
  { path: "/audit/[source]", kind: "page", methods: ["GET"], access: "audit-source", mutating: false },
  { path: "/officers", kind: "page", methods: ["GET"], access: "officers.read", mutating: false },
  { path: "/approvals", kind: "page", methods: ["GET"], access: "approvals.read", mutating: false },
  { path: "/approvals/signer/[id]", kind: "page", methods: ["GET"], access: "approvals.read", mutating: false },
  { path: "/approvals/payouts/[id]", kind: "page", methods: ["GET"], access: "approvals.read", mutating: false },
  { path: "/approvals/unfreeze/[id]", kind: "page", methods: ["GET"], access: "approvals.read", mutating: false },
  { path: "/approvals/property", kind: "page", methods: ["GET"], access: "property.read", mutating: false },
  { path: "/approvals/property/[id]", kind: "page", methods: ["GET"], access: "property.read", mutating: false },
  { path: "/compliance", kind: "page", methods: ["GET"], access: "compliance.read", mutating: false },
  { path: "/compliance/kyc", kind: "page", methods: ["GET"], access: "compliance.read", mutating: false },
  { path: "/compliance/kyc/[id]", kind: "page", methods: ["GET"], access: "compliance.read", mutating: false },
  { path: "/compliance/screening", kind: "page", methods: ["GET"], access: "compliance.read", mutating: false },
  { path: "/compliance/freezes", kind: "page", methods: ["GET"], access: "compliance.read", mutating: false },
  { path: "/compliance/freezes/[id]", kind: "page", methods: ["GET"], access: "compliance.read", mutating: false },
  { path: "/compliance/str", kind: "page", methods: ["GET"], access: "compliance.read", mutating: false },
  { path: "/compliance/str/[id]", kind: "page", methods: ["GET"], access: "compliance.read", mutating: false },
  // S-06 (migration 0020): recovery, succession and reversal cases.
  { path: "/recovery", kind: "page", methods: ["GET"], access: "recovery.read", mutating: false },
  { path: "/recovery/[id]", kind: "page", methods: ["GET"], access: "recovery.read", mutating: false },
  // S-03 operations and FBR withholding (migration 0021).
  { path: "/operations", kind: "page", methods: ["GET"], access: "operations.read", mutating: false },
  { path: "/operations/bank", kind: "page", methods: ["GET"], access: "operations.read", mutating: false },
  { path: "/operations/policies", kind: "page", methods: ["GET"], access: "operations.read", mutating: false },
  { path: "/operations/charges/[id]", kind: "page", methods: ["GET"], access: "operations.read", mutating: false },
  { path: "/operations/distributions/[id]", kind: "page", methods: ["GET"], access: "operations.read", mutating: false },
  { path: "/tax", kind: "page", methods: ["GET"], access: "tax.read", mutating: false },
  { path: "/tax/exports", kind: "page", methods: ["GET"], access: "tax.read", mutating: false },
  { path: "/tax/exports/[id]", kind: "page", methods: ["GET"], access: "tax.read", mutating: false },
  // Step 6d: trustee portal (migration 0023). Trustee officers decide (step-up checked by the database); auditors read.
  { path: "/trustee", kind: "page", methods: ["GET"], access: "trustee.read", mutating: false },
  { path: "/trustee/register", kind: "page", methods: ["GET"], access: "trustee.read", mutating: false },
  { path: "/trustee/register/adjustments/[id]", kind: "page", methods: ["GET"], access: "trustee.read", mutating: false },
  { path: "/trustee/cosign", kind: "page", methods: ["GET"], access: "trustee.read", mutating: false },
  { path: "/trustee/cosign/signer/[id]", kind: "page", methods: ["GET"], access: "trustee.read", mutating: false },
  { path: "/trustee/cosign/offering/[id]", kind: "page", methods: ["GET"], access: "trustee.read", mutating: false },
  { path: "/trustee/cosign/charge/[id]", kind: "page", methods: ["GET"], access: "trustee.read", mutating: false },
  { path: "/trustee/cosign/calculation/[id]", kind: "page", methods: ["GET"], access: "trustee.read", mutating: false },
  { path: "/trustee/distributions", kind: "page", methods: ["GET"], access: "trustee.read", mutating: false },
  { path: "/trustee/distributions/[registry]/[id]", kind: "page", methods: ["GET"], access: "trustee.read", mutating: false },
  { path: "/trustee/recon", kind: "page", methods: ["GET"], access: "trustee.read", mutating: false },
  { path: "/trustee/recon/[id]", kind: "page", methods: ["GET"], access: "trustee.read", mutating: false },
  { path: "/trustee/recoveries", kind: "page", methods: ["GET"], access: "trustee.read", mutating: false },
  // T-046 (migration 0026): committee votes, the trustee's P8 acceptance and platform votes on offering requests.
  { path: "/committees", kind: "page", methods: ["GET"], access: "property.read", mutating: false },
  { path: "/committees/[id]", kind: "page", methods: ["GET"], access: "property.read", mutating: false },
  { path: "/approvals/offering", kind: "page", methods: ["GET"], access: "offering.read", mutating: false },
  { path: "/approvals/offering/[id]", kind: "page", methods: ["GET"], access: "offering.read", mutating: false },
  { path: "/trustee/properties", kind: "page", methods: ["GET"], access: "trustee.read", mutating: false },
  { path: "/trustee/properties/[id]", kind: "page", methods: ["GET"], access: "trustee.read", mutating: false },
  // S-04 phase 0 (migration 0028): off-market transfers.
  { path: "/transfers", kind: "page", methods: ["GET"], access: "transfer.read", mutating: false },
  { path: "/transfers/audit", kind: "page", methods: ["GET"], access: "transfer.read", mutating: false },
  { path: "/transfers/[id]", kind: "page", methods: ["GET"], access: "transfer.read", mutating: false },
  // S-05 (migration 0027): exit cases, decisions by capacity and redemption windows.
  { path: "/exit", kind: "page", methods: ["GET"], access: "exit.read", mutating: false },
  { path: "/exit/[id]", kind: "page", methods: ["GET"], access: "exit.read", mutating: false },
  { path: "/exit/windows/[id]", kind: "page", methods: ["GET"], access: "exit.read", mutating: false },
  // T-049 (migration 0031): investor support lookups by reference.
  { path: "/support", kind: "page", methods: ["GET"], access: "support.read", mutating: false },
  { path: "/api/health", kind: "api", methods: ["GET"], access: "public", mutating: false },
  { path: "/api/auth/login/options", kind: "api", methods: ["POST"], access: "anonymous", mutating: true },
  { path: "/api/auth/login/verify", kind: "api", methods: ["POST"], access: "anonymous", mutating: true },
  { path: "/api/auth/enrol/options", kind: "api", methods: ["POST"], access: "anonymous", mutating: true },
  { path: "/api/auth/enrol/verify", kind: "api", methods: ["POST"], access: "anonymous", mutating: true },
  { path: "/api/auth/stepup/options", kind: "api", methods: ["POST"], access: "officer", mutating: true },
  { path: "/api/auth/stepup/verify", kind: "api", methods: ["POST"], access: "officer", mutating: true },
  { path: "/api/auth/logout", kind: "api", methods: ["POST"], access: "officer", mutating: true },
  { path: "/api/audit/[source]/export", kind: "api", methods: ["POST"], access: "audit-source", mutating: true },
  { path: "/api/officers/changes", kind: "api", methods: ["POST"], access: "officers.manage", mutating: true },
  { path: "/api/officers/changes/[id]/decide", kind: "api", methods: ["POST"], access: "officers.manage", mutating: true },
  { path: "/api/officers/scopes", kind: "api", methods: ["POST"], access: "officers.manage", mutating: true },
  { path: "/api/officers/scopes/[id]/decide", kind: "api", methods: ["POST"], access: "officers.manage", mutating: true },
  { path: "/api/approvals/signer/[id]/decide", kind: "api", methods: ["POST"], access: "approvals.decide", mutating: true },
  { path: "/api/approvals/payouts/[id]/decide", kind: "api", methods: ["POST"], access: "approvals.decide", mutating: true },
  { path: "/api/approvals/unfreeze", kind: "api", methods: ["POST"], access: "approvals.request", mutating: true },
  { path: "/api/approvals/unfreeze/[id]/decide", kind: "api", methods: ["POST"], access: "approvals.decide", mutating: true },
  { path: "/api/approvals/property/[id]/decide", kind: "api", methods: ["POST"], access: "property.decide", mutating: true },
  // T-049 (migration 0031): the platform owner's emergency payout hold; released by the maker-checker unfreeze above.
  { path: "/api/approvals/hold", kind: "api", methods: ["POST"], access: "payouts.hold", mutating: true },
  // Step 6c: compliance (migration 0019). Decisions need a step-up as well (checked by the database).
  { path: "/api/compliance/kyc", kind: "api", methods: ["POST"], access: "compliance.decide", mutating: true },
  { path: "/api/compliance/kyc/[id]/act", kind: "api", methods: ["POST"], access: "compliance.decide", mutating: true },
  { path: "/api/compliance/rescreen", kind: "api", methods: ["POST"], access: "compliance.decide", mutating: true },
  { path: "/api/compliance/freezes", kind: "api", methods: ["POST"], access: "compliance.decide", mutating: true },
  { path: "/api/compliance/freezes/[id]/decide", kind: "api", methods: ["POST"], access: "compliance.decide", mutating: true },
  { path: "/api/compliance/str", kind: "api", methods: ["POST"], access: "compliance.decide", mutating: true },
  { path: "/api/compliance/str/[id]/notes", kind: "api", methods: ["POST"], access: "compliance.decide", mutating: true },
  { path: "/api/compliance/str/[id]/act", kind: "api", methods: ["POST"], access: "compliance.decide", mutating: true },
  { path: "/api/compliance/str/[id]/export", kind: "api", methods: ["POST"], access: "compliance.export", mutating: true },
  // S-06: makers prepare (operations maker), deciders decide in their capacity; step-up checked by the database.
  { path: "/api/recovery/cases", kind: "api", methods: ["POST"], access: "recovery.request", mutating: true },
  { path: "/api/recovery/cases/[id]/evidence", kind: "api", methods: ["POST"], access: "recovery.request", mutating: true },
  { path: "/api/recovery/cases/[id]/wallet", kind: "api", methods: ["POST"], access: "recovery.request", mutating: true },
  { path: "/api/recovery/cases/[id]/act", kind: "api", methods: ["POST"], access: "recovery.decide", mutating: true },
  { path: "/api/recovery/sync", kind: "api", methods: ["POST"], access: "recovery.request", mutating: true },
  // S-03 (migration 0021): decisions and exports need a step-up as well (checked by the database).
  { path: "/api/operations/charges", kind: "api", methods: ["POST"], access: "operations.request", mutating: true },
  { path: "/api/operations/charges/[id]/decide", kind: "api", methods: ["POST"], access: "operations.decide", mutating: true },
  { path: "/api/operations/distributions/[id]/decide", kind: "api", methods: ["POST"], access: "operations.decide", mutating: true },
  { path: "/api/operations/distributions/[id]/rent", kind: "api", methods: ["POST"], access: "operations.request", mutating: true },
  { path: "/api/operations/bank", kind: "api", methods: ["POST"], access: "operations.request", mutating: true },
  { path: "/api/operations/bank/returns", kind: "api", methods: ["POST"], access: "operations.request", mutating: true },
  { path: "/api/operations/bank/returns/[id]/decide", kind: "api", methods: ["POST"], access: "operations.decide", mutating: true },
  { path: "/api/operations/bank/followup", kind: "api", methods: ["POST"], access: "operations.request", mutating: true },
  { path: "/api/operations/policies", kind: "api", methods: ["POST"], access: "operations.request", mutating: true },
  { path: "/api/operations/policies/[id]/decide", kind: "api", methods: ["POST"], access: "operations.read", mutating: true },
  { path: "/api/tax/rates", kind: "api", methods: ["POST"], access: "tax.decide", mutating: true },
  { path: "/api/tax/rates/[id]/decide", kind: "api", methods: ["POST"], access: "tax.decide", mutating: true },
  { path: "/api/tax/exports", kind: "api", methods: ["POST"], access: "tax.export", mutating: true },
  { path: "/api/tax/exports/[id]/decide", kind: "api", methods: ["POST"], access: "tax.export", mutating: true },
  { path: "/api/tax/exports/[id]/generate", kind: "api", methods: ["POST"], access: "tax.export", mutating: true },
  // Step 6d: trustee (migration 0023).
  { path: "/api/trustee/register/export", kind: "api", methods: ["POST"], access: "trustee.export", mutating: true },
  { path: "/api/trustee/register/adjustments", kind: "api", methods: ["POST"], access: "trustee.decide", mutating: true },
  { path: "/api/trustee/register/adjustments/[id]/decide", kind: "api", methods: ["POST"], access: "trustee.decide", mutating: true },
  { path: "/api/trustee/cosign/signer/[id]/decide", kind: "api", methods: ["POST"], access: "trustee.decide", mutating: true },
  { path: "/api/trustee/cosign/offering/[id]/decide", kind: "api", methods: ["POST"], access: "trustee.decide", mutating: true },
  { path: "/api/trustee/distributions/[registry]/[id]/decide", kind: "api", methods: ["POST"], access: "trustee.decide", mutating: true },
  { path: "/api/trustee/cosign/charge/[id]/decide", kind: "api", methods: ["POST"], access: "trustee.decide", mutating: true },
  { path: "/api/trustee/cosign/calculation/[id]/decide", kind: "api", methods: ["POST"], access: "trustee.decide", mutating: true },
  // T-046 (migration 0026): every vote needs a step-up and the digest of what was shown (checked by the database).
  { path: "/api/committees/open", kind: "api", methods: ["POST"], access: "committee.vote", mutating: true },
  { path: "/api/committees/[id]/vote", kind: "api", methods: ["POST"], access: "committee.vote", mutating: true },
  { path: "/api/committees/[id]/close", kind: "api", methods: ["POST"], access: "committee.vote", mutating: true },
  { path: "/api/approvals/offering/[id]/decide", kind: "api", methods: ["POST"], access: "offering.decide", mutating: true },
  { path: "/api/approvals/offering/[id]/return", kind: "api", methods: ["POST"], access: "offering.decide", mutating: true },
  { path: "/api/trustee/properties/[id]/decide", kind: "api", methods: ["POST"], access: "trustee.decide", mutating: true },
  // S-04 (migration 0028): the desk (operations maker) opens, completes and withdraws; compliance and trustee officers decide,
  // cancel and dispute; operations maker and checker run the cash leg; checkers record reference prices. Every write needs a
  // step-up and (on a case) the digest of what was shown, both checked by the database.
  { path: "/api/transfers/cases", kind: "api", methods: ["POST"], access: "transfer.request", mutating: true },
  { path: "/api/transfers/cases/[id]/desk", kind: "api", methods: ["POST"], access: "transfer.request", mutating: true },
  { path: "/api/transfers/cases/[id]/decide", kind: "api", methods: ["POST"], access: "transfer.decide", mutating: true },
  { path: "/api/transfers/cases/[id]/cash", kind: "api", methods: ["POST"], access: "transfer.cash", mutating: true },
  { path: "/api/transfers/sync", kind: "api", methods: ["POST"], access: "transfer.request", mutating: true },
  { path: "/api/transfers/prices", kind: "api", methods: ["POST"], access: "transfer.price", mutating: true },
  { path: "/api/transfers/conflicts", kind: "api", methods: ["POST"], access: "transfer.read", mutating: true },
  { path: "/api/transfers/links", kind: "api", methods: ["POST"], access: "transfer.decide", mutating: true },
  // S-05 (migration 0027): operations makers prepare, deciders decide in their capacity; every call needs a step-up (checked by the database).
  { path: "/api/exit/cases", kind: "api", methods: ["POST"], access: "exit.request", mutating: true },
  { path: "/api/exit/cases/[id]/request", kind: "api", methods: ["POST"], access: "exit.request", mutating: true },
  { path: "/api/exit/windows", kind: "api", methods: ["POST"], access: "exit.request", mutating: true },
  { path: "/api/exit/sync", kind: "api", methods: ["POST"], access: "exit.request", mutating: true },
  { path: "/api/exit/decide", kind: "api", methods: ["POST"], access: "exit.decide", mutating: true },
];

/** Audit sources and the permission each needs (the [source] segment). */
export const AUDIT_SOURCES = {
  signer: "audit.read.ops",
  recon: "audit.read.ops",
  ledger: "audit.read.ops",
  admin: "audit.read.admin",
  compliance: "compliance.read",
  recovery: "recovery.read",
  trustee: "trustee.read",
  exit: "exit.read",
} as const satisfies Record<string, Permission>;
export type AuditSource = keyof typeof AUDIT_SOURCES;

const SOURCE_MAP = new Map<string, Permission>(Object.entries(AUDIT_SOURCES));
export const SOURCE_LIST = [...SOURCE_MAP.keys()] as AuditSource[];

export function isAuditSource(x: unknown): x is AuditSource {
  return typeof x === "string" && SOURCE_MAP.has(x);
}

export function sourcePermission(s: AuditSource): Permission {
  return SOURCE_MAP.get(s) ?? "audit.read.admin";
}

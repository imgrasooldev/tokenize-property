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
  { path: "/trustee", kind: "page", methods: ["GET"], access: "trustee.read", mutating: false },
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
  { path: "/api/approvals/signer/[id]/decide", kind: "api", methods: ["POST"], access: "approvals.decide", mutating: true },
  { path: "/api/approvals/payouts/[id]/decide", kind: "api", methods: ["POST"], access: "approvals.decide", mutating: true },
  { path: "/api/approvals/unfreeze", kind: "api", methods: ["POST"], access: "approvals.request", mutating: true },
  { path: "/api/approvals/unfreeze/[id]/decide", kind: "api", methods: ["POST"], access: "approvals.decide", mutating: true },
  { path: "/api/approvals/property/[id]/decide", kind: "api", methods: ["POST"], access: "property.decide", mutating: true },
];

/** Audit sources and the permission each needs (the [source] segment). */
export const AUDIT_SOURCES = {
  signer: "audit.read.ops",
  recon: "audit.read.ops",
  ledger: "audit.read.ops",
  admin: "audit.read.admin",
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

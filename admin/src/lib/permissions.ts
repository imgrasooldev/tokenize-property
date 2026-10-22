/**
 * The portal's copy of the role matrix in the admin portal migrations (admin.role_permissions and
 * admin.role_conflicts: 0013, plus the Step 6b permissions of 0016, the Step 6c ones of 0019, the
 * S-06 role and permissions of 0020, the S-03 role and permissions of 0021, the Step 6d ones of
 * 0023 and the committee and offering votes of 0026). The database is the authority and checks every request itself; this copy only drives
 * menus and early, friendly checks.
 * test/db/rules.test.ts asserts both are identical.
 */
export const ROLES = ["ops_maker", "ops_checker", "compliance_officer", "legal_officer", "trustee_officer", "tax_officer", "auditor", "admin"] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  "ops.read",
  "audit.read.ops",
  "audit.read.admin",
  "audit.export",
  "officers.read",
  "officers.manage",
  "approvals.read",
  "approvals.request",
  "approvals.decide",
  "property.read",
  "property.decide",
  "committee.vote",
  "offering.read",
  "offering.decide",
  "compliance.read",
  "compliance.decide",
  "compliance.export",
  "recovery.read",
  "recovery.request",
  "recovery.decide",
  "trustee.read",
  "trustee.decide",
  "trustee.export",
  "operations.read",
  "operations.request",
  "operations.decide",
  "tax.read",
  "tax.decide",
  "tax.export",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  ops_maker: [
    "ops.read",
    "audit.read.ops",
    "approvals.read",
    "approvals.request",
    "property.read",
    "committee.vote",
    "offering.read",
    "recovery.read",
    "recovery.request",
    "operations.read",
    "operations.request",
  ],
  ops_checker: [
    "ops.read",
    "audit.read.ops",
    "approvals.read",
    "approvals.decide",
    "property.read",
    "property.decide",
    "committee.vote",
    "offering.read",
    "offering.decide",
    "recovery.read",
    "recovery.decide",
    "operations.read",
    "operations.decide",
  ],
  compliance_officer: [
    "ops.read",
    "audit.read.ops",
    "audit.read.admin",
    "audit.export",
    "property.read",
    "property.decide",
    "committee.vote",
    "offering.read",
    "offering.decide",
    "compliance.read",
    "compliance.decide",
    "compliance.export",
    "recovery.read",
    "recovery.decide",
  ],
  legal_officer: ["recovery.read", "recovery.decide"],
  trustee_officer: ["audit.export", "trustee.read", "trustee.decide", "trustee.export", "operations.read"],
  tax_officer: ["operations.read", "tax.read", "tax.decide", "tax.export"],
  auditor: [
    "ops.read",
    "audit.read.ops",
    "audit.read.admin",
    "audit.export",
    "officers.read",
    "approvals.read",
    "property.read",
    "offering.read",
    "compliance.read",
    "recovery.read",
    "trustee.read",
    "trustee.export",
    "operations.read",
    "tax.read",
  ],
  admin: ["audit.read.admin", "officers.read", "officers.manage"],
};

/** Incompatible pairs (segregation of duties), sorted alphabetically within each pair. */
export const ROLE_CONFLICTS: readonly (readonly [Role, Role])[] = [
  ["admin", "auditor"],
  ["admin", "compliance_officer"],
  ["admin", "legal_officer"],
  ["admin", "ops_checker"],
  ["admin", "ops_maker"],
  ["admin", "tax_officer"],
  ["admin", "trustee_officer"],
  ["auditor", "compliance_officer"],
  ["auditor", "legal_officer"],
  ["auditor", "ops_checker"],
  ["auditor", "ops_maker"],
  ["auditor", "tax_officer"],
  ["auditor", "trustee_officer"],
  ["compliance_officer", "legal_officer"],
  ["compliance_officer", "ops_maker"],
  ["compliance_officer", "tax_officer"],
  ["compliance_officer", "trustee_officer"],
  ["legal_officer", "ops_checker"],
  ["legal_officer", "ops_maker"],
  ["legal_officer", "tax_officer"],
  ["legal_officer", "trustee_officer"],
  ["ops_checker", "ops_maker"],
  ["ops_checker", "trustee_officer"],
  ["ops_maker", "tax_officer"],
  ["ops_maker", "trustee_officer"],
  ["tax_officer", "trustee_officer"],
];

const LABELS: Readonly<Record<Role, string>> = {
  ops_maker: "Operations maker",
  ops_checker: "Operations checker",
  compliance_officer: "Compliance officer",
  legal_officer: "Legal officer",
  trustee_officer: "Trustee officer",
  tax_officer: "Tax officer",
  auditor: "Auditor",
  admin: "Administrator",
};

const LABEL_MAP = new Map<Role, string>(Object.entries(LABELS) as [Role, string][]);
const PERMISSION_MAP = new Map<Role, readonly Permission[]>(Object.entries(ROLE_PERMISSIONS) as [Role, readonly Permission[]][]);

export function roleLabel(r: Role): string {
  return LABEL_MAP.get(r) ?? r;
}

export function isRole(x: unknown): x is Role {
  return typeof x === "string" && (ROLES as readonly string[]).includes(x);
}

export function permissionsOf(roles: readonly Role[]): Set<Permission> {
  return new Set(roles.flatMap((r) => PERMISSION_MAP.get(r) ?? []));
}

export function conflicts(a: Role, b: Role): boolean {
  const [x, y] = a < b ? [a, b] : [b, a];
  return ROLE_CONFLICTS.some(([p, q]) => p === x && q === y);
}

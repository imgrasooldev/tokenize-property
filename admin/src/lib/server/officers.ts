import { isRole, type Role } from "../permissions";
import { db } from "./db";

export interface OfficerRow {
  id: string;
  handle: string;
  name: string;
  status: "invited" | "active" | "disabled";
  roles: Role[];
  credentials: number;
  enrolledAt: Date | null;
  lastLogin: Date | null;
  bootstrap: boolean;
}

export async function listOfficers(sessionHash: Buffer): Promise<OfficerRow[]> {
  const { rows } = await db().query<{
    id: string;
    handle: string;
    display_name: string;
    status: OfficerRow["status"];
    roles: string[];
    credentials: string;
    enrolled_at: Date | null;
    last_login: Date | null;
    bootstrap: boolean;
  }>("SELECT * FROM admin.officers_list($1)", [sessionHash]);
  return rows.map((r) => ({
    id: r.id,
    handle: r.handle,
    name: r.display_name,
    status: r.status,
    roles: r.roles.filter(isRole),
    credentials: Number(r.credentials),
    enrolledAt: r.enrolled_at,
    lastLogin: r.last_login,
    bootstrap: r.bootstrap,
  }));
}

export interface ChangeRow {
  id: string;
  kind: "invite" | "grant" | "revoke" | "disable";
  officerHandle: string | null;
  role: string | null;
  newHandle: string | null;
  newName: string | null;
  reason: string;
  requestedBy: string;
  requestedAt: Date;
  expiresAt: Date;
  status: "open" | "approved" | "rejected" | "expired";
  decidedBy: string | null;
  decisionReason: string | null;
  decidedAt: Date | null;
}

export async function listChanges(sessionHash: Buffer, limit = 50): Promise<ChangeRow[]> {
  const { rows } = await db().query<{
    id: string;
    kind: ChangeRow["kind"];
    officer_handle: string | null;
    role: string | null;
    new_handle: string | null;
    new_name: string | null;
    reason: string;
    requested_by: string;
    requested_at: Date;
    expires_at: Date;
    status: ChangeRow["status"];
    decided_by: string | null;
    decision_reason: string | null;
    decided_at: Date | null;
  }>("SELECT * FROM admin.changes_list($1, $2)", [sessionHash, limit]);
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    officerHandle: r.officer_handle,
    role: r.role,
    newHandle: r.new_handle,
    newName: r.new_name,
    reason: r.reason,
    requestedBy: r.requested_by,
    requestedAt: r.requested_at,
    expiresAt: r.expires_at,
    status: r.status,
    decidedBy: r.decided_by,
    decisionReason: r.decision_reason,
    decidedAt: r.decided_at,
  }));
}

export interface CredentialRow {
  id: string;
  aaguid: string;
  fmt: string;
  transports: string[];
  createdAt: Date;
  lastUsedAt: Date | null;
  disabledAt: Date | null;
}

export async function myCredentials(sessionHash: Buffer): Promise<CredentialRow[]> {
  const { rows } = await db().query<{
    credential: string;
    aaguid: string;
    fmt: string;
    transports: string[];
    created_at: Date;
    last_used_at: Date | null;
    disabled_at: Date | null;
  }>("SELECT * FROM admin.my_account($1)", [sessionHash]);
  return rows.map((r) => ({
    id: r.credential,
    aaguid: r.aaguid,
    fmt: r.fmt,
    transports: r.transports,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    disabledAt: r.disabled_at,
  }));
}

export interface ScopeProperty {
  id: string;
  state: string;
  district: string | null;
  building: string | null;
  propertyKey: string | null;
}

/** Property managers, the properties assigned to them and the open assignment changes (admin.manager_scopes, migration 0034). */
export interface ManagerScopes {
  managers: { id: string; handle: string; status: string; properties: ScopeProperty[] }[];
  open: { id: number; officer: string; property: ScopeProperty; action: "grant" | "revoke"; reason: string; requestedBy: string; requestedAt: string }[];
  properties: ScopeProperty[];
}

export async function managerScopes(sessionHash: Buffer): Promise<ManagerScopes> {
  const { rows } = await db().query<{ v: ManagerScopes }>("SELECT admin.manager_scopes($1) AS v", [sessionHash]);
  return rows[0]?.v ?? { managers: [], open: [], properties: [] };
}

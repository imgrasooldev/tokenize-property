import type { AuditRow } from "../export";
import type { AuditSource } from "../routes";
import { db } from "./db";

export interface AuditFilters {
  from: string | null; // YYYY-MM-DD (UTC, inclusive)
  to: string | null; // YYYY-MM-DD (UTC, inclusive)
  actor: string | null;
  action: string | null;
  before: string | null; // keyset paging: rows with id < before
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ACTION = /^[a-z][a-z0-9_.]{0,63}$/;

function clean(v: unknown, re: RegExp | null, max = 100): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().slice(0, max);
  if (!s) return null;
  return re === null || re.test(s) ? s : null;
}

/** Filters from a query string or a form; anything malformed is simply dropped. */
export function parseFilters(get: (k: string) => unknown): AuditFilters {
  return {
    from: clean(get("from"), DATE),
    to: clean(get("to"), DATE),
    actor: clean(get("actor"), /^[\p{L}\p{N} ._:@-]{1,100}$/u),
    action: clean(get("action"), ACTION),
    before: clean(get("before"), /^[1-9]\d{0,17}$/),
  };
}

interface Raw {
  id: string;
  at: Date;
  actor: string;
  action: string;
  ref: string | null;
  detail: unknown;
  prev_hash: string;
  hash: string;
}

export async function auditRows(sessionHash: Buffer, source: AuditSource, f: AuditFilters, limit: number): Promise<AuditRow[]> {
  const toExclusive = f.to ? new Date(Date.parse(`${f.to}T00:00:00Z`) + 86_400_000).toISOString() : null;
  const { rows } = await db().query<Raw>("SELECT * FROM admin.audit_rows($1, $2, $3, $4, $5, $6, $7, $8)", [
    sessionHash,
    source,
    f.from ? `${f.from}T00:00:00Z` : null,
    toExclusive,
    f.actor,
    f.action,
    f.before,
    limit,
  ]);
  return rows.map((r) => ({
    id: r.id,
    at: r.at.toISOString(),
    actor: r.actor,
    action: r.action,
    ref: r.ref,
    detail: r.detail,
    prevHash: r.prev_hash,
    hash: r.hash,
  }));
}

export interface ChainCheck {
  source: string;
  entries: number;
  problems: number;
  firstProblem: string | null;
  verifiedAt: Date;
}

export async function verifyChains(sessionHash: Buffer, source: AuditSource | null): Promise<ChainCheck[]> {
  const { rows } = await db().query<{
    source: string;
    entries: string;
    problems: string;
    first_problem: string | null;
    verified_at: Date;
  }>("SELECT * FROM admin.verify_chains($1, $2)", [sessionHash, source]);
  return rows.map((r) => ({
    source: r.source,
    entries: Number(r.entries),
    problems: Number(r.problems),
    firstProblem: r.first_problem,
    verifiedAt: r.verified_at,
  }));
}

export async function recordExport(
  sessionHash: Buffer,
  source: AuditSource,
  filters: AuditFilters,
  rows: number,
  format: "csv" | "json",
  sha256: string,
): Promise<{ id: string; hash: string; at: Date }> {
  const { rows: r } = await db().query<{ audit_id: string; audit_hash: string; at: Date }>(
    "SELECT * FROM admin.record_export($1, $2, $3, $4, $5, $6)",
    [sessionHash, source, JSON.stringify(filters), rows, format, sha256],
  );
  const x = r[0];
  if (!x) throw new Error("export not recorded");
  return { id: x.audit_id, hash: x.audit_hash, at: x.at };
}

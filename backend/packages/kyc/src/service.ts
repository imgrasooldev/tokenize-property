import { randomUUID } from "node:crypto";
import type pg from "pg";
import { normalizeCnic, normalizeName, type Peppers, seal, unseal } from "./crypto.ts";
import { evidenceHash, type CheckKind, type KycProviders, type ProviderResult } from "./providers.ts";

/**
 * KYC onboarding (ADR 0009). The database decides the status (kyc.evaluate, Y-3); this service only
 * talks to the providers and records what they said. Personal data stays in memory: the database
 * gets keyed hashes, the last four CNIC digits, the sealed name and evidence hashes (Y-1).
 */

/** "suspended": verified (or expired) but held by an approved compliance freeze (migration 0019 C-3). */
export type KycStatus = "unknown" | "pending" | "verified" | "review" | "rejected" | "revoked" | "expired" | "suspended";

export type KycErrorCode = "DUPLICATE_CNIC" | "INVALID_INPUT" | "UNKNOWN_SUBJECT";

export class KycError extends Error {
  constructor(
    readonly code: KycErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "KycError";
  }
}

export interface OnboardInput {
  cnic: string;
  fullName: string;
  livenessSessionId: string;
  wallet?: string;
}

export interface OnboardResult {
  subjectId: string;
  status: KycStatus;
  reason: string;
  checks: { kind: CheckKind; outcome: ProviderResult["outcome"]; reason: string }[];
}

type Db = pg.Pool | pg.ClientBase;

const nameAad = (cnicHash: Buffer): string => `pt-name-v1:${cnicHash.toString("hex")}`;

export class KycService {
  private readonly actor: string;

  constructor(
    private readonly db: pg.Pool,
    private readonly providers: KycProviders,
    private readonly peppers: Peppers,
    private readonly dataKey: Buffer,
    actor = "kyc-service",
  ) {
    this.actor = actor;
  }

  /**
   * Registers a person and runs NADRA, liveness and sanctions screening, stopping at the first
   * failure. A CNIC that is already registered is refused, except to retry a subject whose earlier
   * attempt failed for a non-sanctions reason (same CNIC and name).
   */
  async onboard(input: OnboardInput): Promise<OnboardResult> {
    let cnic: string;
    let name: string;
    try {
      cnic = normalizeCnic(input.cnic);
      name = normalizeName(input.fullName);
    } catch (e) {
      throw new KycError("INVALID_INPUT", (e as Error).message);
    }
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(input.livenessSessionId)) throw new KycError("INVALID_INPUT", "invalid liveness session id");
    if (input.wallet !== undefined && !/^0x[0-9a-fA-F]{40}$/.test(input.wallet)) throw new KycError("INVALID_INPUT", "invalid wallet address");

    const hashes = this.peppers.hashAll("cnic", cnic);
    const current = hashes[0];
    if (!current) throw new Error("no pepper");
    const existing = await findSubject(this.db, hashes.map((h) => h.hash));
    let subjectId: string;
    if (existing) {
      const st = await statusOf(this.db, existing);
      const retryable = st?.status === "pending" || (st?.status === "rejected" && !st.reason.startsWith("sanctions"));
      if (!retryable || (await this.sealedName(existing)) !== name) throw new KycError("DUPLICATE_CNIC", "this CNIC is already registered");
      subjectId = existing;
    } else {
      try {
        const { rows } = await this.db.query<{ id: string }>(
          "SELECT kyc.register_subject($1::bytea[], $2::smallint[], $3, $4, $5, $6) AS id",
          [
            hashes.map((h) => h.hash),
            hashes.map((h) => h.version),
            this.peppers.hash(current.version, "name", name),
            seal(this.dataKey, nameAad(current.hash), name),
            cnic.slice(-4),
            this.actor,
          ],
        );
        subjectId = rows[0]?.id ?? "";
      } catch (e) {
        if ((e as { code?: string }).code === "23505") throw new KycError("DUPLICATE_CNIC", "this CNIC is already registered");
        throw e;
      }
    }

    const checks = await this.runChecks(subjectId, cnic, name, input.livenessSessionId);
    const status = await evaluate(this.db, subjectId, this.actor);
    if (input.wallet && status === "verified") await bindWallet(this.db, subjectId, input.wallet, this.actor);
    const st = await statusOf(this.db, subjectId);
    return { subjectId, status, reason: st?.reason ?? "", checks };
  }

  /**
   * Re-verification of a person who is already a subject (S-06 RC-2, RF-8: wallet recovery). The
   * CNIC finds the subject by its keyed hash, so it is the same person; the name must equal the
   * sealed one. NADRA, liveness and sanctions run again and are recorded, and the status is derived
   * again. Nothing is bound and no wallet changes here (that is the recovery case's job).
   */
  async reverify(input: Omit<OnboardInput, "wallet">): Promise<OnboardResult> {
    let cnic: string;
    let name: string;
    try {
      cnic = normalizeCnic(input.cnic);
      name = normalizeName(input.fullName);
    } catch (e) {
      throw new KycError("INVALID_INPUT", (e as Error).message);
    }
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(input.livenessSessionId)) throw new KycError("INVALID_INPUT", "invalid liveness session id");
    const subjectId = await findSubject(this.db, this.peppers.hashAll("cnic", cnic).map((h) => h.hash));
    // The same answer for an unknown CNIC and a wrong name: nothing is learned about who is registered.
    if (!subjectId || (await this.sealedName(subjectId)) !== name) throw new KycError("UNKNOWN_SUBJECT", "no matching registered investor");
    const checks = await this.runChecks(subjectId, cnic, name, input.livenessSessionId);
    const status = await evaluate(this.db, subjectId, this.actor);
    const st = await statusOf(this.db, subjectId);
    return { subjectId, status, reason: st?.reason ?? "", checks };
  }

  /** NADRA, then liveness, then sanctions, stopping at the first failure; every result is recorded. */
  private async runChecks(subjectId: string, cnic: string, name: string, livenessSessionId: string): Promise<OnboardResult["checks"]> {
    const checks: OnboardResult["checks"] = [];
    const run = async (kind: CheckKind, call: () => Promise<ProviderResult>): Promise<boolean> => {
      const r = await this.call(kind, call);
      await recordCheck(this.db, subjectId, r, this.actor);
      checks.push({ kind, outcome: r.outcome, reason: r.reason });
      return r.outcome === "pass" || r.outcome === "review";
    };
    if (await run("nadra", () => this.providers.nadra.verify({ cnic, fullName: name }))) {
      if (await run("liveness", () => this.providers.liveness.check({ sessionId: livenessSessionId }))) {
        await run("sanctions", () => this.providers.sanctions.screen({ fullName: name }));
      }
    }
    return checks;
  }

  /** Periodic re-screening against the current sanctions list (e.g. after a list update). */
  async rescreen(subjectId: string): Promise<KycStatus> {
    const name = await this.sealedName(subjectId);
    const r = await this.call("sanctions", () => this.providers.sanctions.screen({ fullName: name }));
    await recordCheck(this.db, subjectId, r, this.actor);
    return evaluate(this.db, subjectId, this.actor);
  }

  private async sealedName(subjectId: string): Promise<string> {
    const { rows } = await this.db.query<{ name_enc: Buffer; cnic_hash: Buffer }>("SELECT * FROM kyc.sealed_name($1)", [subjectId]);
    const r = rows[0];
    if (!r) throw new KycError("UNKNOWN_SUBJECT", "unknown subject");
    return unseal(this.dataKey, nameAad(r.cnic_hash), r.name_enc);
  }

  /** A provider failure becomes an `error` result: recorded, never a pass (fail-closed). */
  private async call(kind: CheckKind, fn: () => Promise<ProviderResult>): Promise<ProviderResult> {
    try {
      const r = await fn();
      if (r.kind !== kind) throw new Error(`provider returned a ${r.kind} result for a ${kind} check`);
      return r;
    } catch (e) {
      const providerRef = `ERR-${randomUUID()}`;
      return { kind, outcome: "error", provider: `local-${kind}`, providerRef, reason: "unavailable", evidence: { error: (e as Error).name, providerRef } };
    }
  }
}

// ------------------------------------------------------------------ database API

export async function findSubject(db: Db, hashes: Buffer[]): Promise<string | null> {
  const { rows } = await db.query<{ id: string | null }>("SELECT kyc.find_subject($1::bytea[]) AS id", [hashes]);
  return rows[0]?.id ?? null;
}

export async function recordCheck(db: Db, subjectId: string, r: ProviderResult, actor: string): Promise<bigint> {
  const { rows } = await db.query<{ id: string }>(
    "SELECT kyc.record_check($1, $2, $3, $4, $5, $6, $7::smallint, $8, $9, $10) AS id",
    [subjectId, r.kind, r.outcome, r.provider, r.providerRef, r.reason, r.score ?? null, r.listVersion ?? null, evidenceHash(r.evidence), actor],
  );
  return BigInt(rows[0]?.id ?? "0");
}

export async function evaluate(db: Db, subjectId: string, actor: string): Promise<KycStatus> {
  const { rows } = await db.query<{ s: KycStatus }>("SELECT kyc.evaluate($1, $2) AS s", [subjectId, actor]);
  return rows[0]?.s ?? "unknown";
}

export async function bindWallet(db: Db, subjectId: string, wallet: string, actor: string): Promise<boolean> {
  const { rows } = await db.query<{ ok: boolean }>("SELECT kyc.bind_wallet($1, $2, $3) AS ok", [subjectId, wallet, actor]);
  return rows[0]?.ok ?? false;
}

export async function subjectStatus(db: Db, subjectId: string): Promise<KycStatus> {
  const { rows } = await db.query<{ s: KycStatus }>("SELECT kyc.subject_status($1) AS s", [subjectId]);
  return rows[0]?.s ?? "unknown";
}

export async function isVerified(db: Db, wallet: string): Promise<boolean> {
  const { rows } = await db.query<{ ok: boolean }>("SELECT kyc.is_verified($1) AS ok", [wallet]);
  return rows[0]?.ok ?? false;
}

export interface SubjectView {
  subjectId: string;
  cnicLast4: string;
  wallet: string | null;
  status: KycStatus;
  reason: string;
  validUntil: Date | null;
}

export async function statusOf(db: Db, subjectId: string): Promise<SubjectView | null> {
  const { rows } = await db.query<{ subject_id: string; cnic_last4: string; wallet: string | null; status: KycStatus; reason: string | null; valid_until: Date | null }>(
    "SELECT subject_id, cnic_last4, wallet, status, reason, valid_until FROM kyc.status WHERE subject_id = $1",
    [subjectId],
  );
  const r = rows[0];
  return r ? { subjectId: r.subject_id, cnicLast4: r.cnic_last4, wallet: r.wallet, status: r.status, reason: r.reason ?? "", validUntil: r.valid_until } : null;
}

/** Y-4 maker: an officer proposes how to settle a possible sanctions match (accept_edd: a PEP match accepted after enhanced due diligence, 0019). */
export async function requestClearance(db: Db, checkId: bigint, officer: string, proposal: "false_positive" | "true_match" | "accept_edd", reason: string): Promise<bigint> {
  const { rows } = await db.query<{ id: string }>("SELECT kyc.request_clearance($1, $2, $3, $4) AS id", [checkId.toString(), officer, proposal, reason]);
  return BigInt(rows[0]?.id ?? "0");
}

/** Y-4 checker: a different officer approves or rejects. */
export async function decideClearance(db: Db, requestId: bigint, officer: string, decision: "approve" | "reject", reason: string): Promise<string> {
  const { rows } = await db.query<{ s: string }>("SELECT kyc.decide_clearance($1, $2, $3, $4) AS s", [requestId.toString(), officer, decision, reason]);
  return rows[0]?.s ?? "";
}

export async function revoke(db: Db, subjectId: string, officer: string, reason: string): Promise<boolean> {
  const { rows } = await db.query<{ ok: boolean }>("SELECT kyc.revoke($1, $2, $3) AS ok", [subjectId, officer, reason]);
  return rows[0]?.ok ?? false;
}

export async function verifyAudit(db: Db): Promise<{ auditId: string | null; problem: string }[]> {
  const { rows } = await db.query<{ audit_id: string | null; problem: string }>("SELECT audit_id::text, problem FROM kyc.verify_audit()");
  return rows.map((r) => ({ auditId: r.audit_id, problem: r.problem }));
}

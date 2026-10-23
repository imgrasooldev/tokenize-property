import { verifyDocuments, type Documents, type ScheduleLine } from "@pt/tax";
import type pg from "pg";
import { redemptionRefId } from "./refid.ts";
import { buildFinalDocuments, type FinalHeader } from "./statement.ts";

/**
 * The exit service (spec S-05, migration 0027). Every rule lives in the database; this class only
 * does what SQL cannot: keccak (statement hashes, redemption refIds) and the Merkle tree. Actors are
 * operator names on the command line (officers act in PT Control; the database refuses an officer's
 * handle anywhere else).
 */
export class ExitError extends Error {
  constructor(
    readonly code: "refused" | "not_found" | "invalid",
    message: string,
  ) {
    super(message);
  }
}

type Db = pg.Pool | pg.ClientBase;

interface FinalRow {
  id: string;
  case_id: string;
  token: string;
  record_date: string;
  record_block: string;
  income_type: string;
  proceeds: string;
  inflows: string;
  outflows: string;
  distributable_gross: string;
  sum_wht: string;
  sum_net: string;
  total_units: string;
  status: string;
}

export class ExitService {
  constructor(private readonly db: Db) {}

  private async final(id: string): Promise<FinalHeader & { status: string }> {
    const { rows } = await this.db.query<FinalRow>(
      `SELECT id::text, case_id::text, token, record_date::text, record_block::text, income_type, proceeds::text, inflows::text, outflows::text,
              distributable_gross::text, sum_wht::text, sum_net::text, total_units::text, status
       FROM exit.finals WHERE id = $1`,
      [id],
    );
    const r = rows[0];
    if (!r) throw new ExitError("not_found", `unknown final distribution ${id}`);
    return {
      id: r.id,
      caseId: r.case_id,
      token: r.token,
      recordDate: r.record_date,
      recordBlock: r.record_block,
      incomeType: r.income_type,
      proceeds: BigInt(r.proceeds),
      inflows: BigInt(r.inflows),
      outflows: BigInt(r.outflows),
      distributableGross: BigInt(r.distributable_gross),
      wht: BigInt(r.sum_wht),
      net: BigInt(r.sum_net),
      units: r.total_units,
      status: r.status,
    };
  }

  async lines(id: string): Promise<ScheduleLine[]> {
    const { rows } = await this.db.query<{
      wallet: string; subject_id: string | null; units: string; gross: string; filer_status: string; filer_check_id: string | null;
      filer_as_of: string | null; flagged: boolean; rate_id: string; rate_ppm: number; wht: string; net: string;
    }>(
      `SELECT wallet, subject_id::text, units, gross::text, filer_status, filer_check_id::text, filer_as_of::text, flagged, rate_id::text, rate_ppm,
              wht::text, net::text FROM exit.final_lines_of($1)`,
      [id],
    );
    return rows.map((r) => ({
      wallet: r.wallet,
      subject: r.subject_id,
      units: r.units,
      gross: BigInt(r.gross),
      status: r.filer_status,
      filerCheck: r.filer_check_id,
      filerAsOf: r.filer_as_of,
      flagged: r.flagged,
      rateId: r.rate_id,
      ratePpm: r.rate_ppm,
      wht: BigInt(r.wht),
      net: BigInt(r.net),
    }));
  }

  /** The maker's calculation at the record block (exit.calculate_final). Returns the final's id. */
  async calculate(caseId: string, recordBlock: bigint, actor: string): Promise<string> {
    const { rows } = await this.db.query<{ id: string }>("SELECT exit.calculate_final($1, $2, $3)::text AS id", [caseId, recordBlock.toString(), actor]);
    return rows[0]?.id ?? "";
  }

  /** The statement, tax schedule and Merkle tree of a final distribution, rebuilt from its lines. */
  async documents(id: string): Promise<Documents> {
    return buildFinalDocuments(await this.final(id), await this.lines(id));
  }

  /** Builds and attaches the statement and the tax schedule (the database checks them line by line). */
  async attach(id: string, actor: string): Promise<Documents> {
    const docs = await this.documents(id);
    await this.db.query("SELECT exit.attach_final($1, $2, $3, $4, $5, $6, $7)", [id, docs.root, docs.statement, docs.statementHash, docs.schedule, docs.scheduleHash, actor]);
    return docs;
  }

  /**
   * Independent recomputation (the trustee's pre-check and reconciliation do the same): the stored
   * documents hash correctly, are consistent, and equal what the lines produce today.
   */
  async verify(id: string): Promise<string[]> {
    const { rows } = await this.db.query<{ statement: string | null; statement_hash: string | null; tax_schedule: string | null; tax_schedule_hash: string | null; merkle_root: string | null }>(
      "SELECT statement, statement_hash, tax_schedule, tax_schedule_hash, merkle_root FROM exit.finals WHERE id = $1",
      [id],
    );
    const r = rows[0];
    if (!r) throw new ExitError("not_found", `unknown final distribution ${id}`);
    if (!r.statement || !r.statement_hash || !r.tax_schedule || !r.tax_schedule_hash || !r.merkle_root) return ["no statement attached"];
    const problems = verifyDocuments({ statement: r.statement, statementHash: r.statement_hash, schedule: r.tax_schedule, scheduleHash: r.tax_schedule_hash, root: r.merkle_root });
    const again = await this.documents(id);
    if (again.statementHash !== r.statement_hash || again.scheduleHash !== r.tax_schedule_hash || again.root !== r.merkle_root) {
      problems.push("the stored documents differ from what the calculation lines produce");
    }
    return problems;
  }

  /**
   * The redemption batch: every holder at the final record block with its balance there and its
   * refId (keccak256 of token, on-chain distribution id and wallet). The database checks the items
   * against its own computation; returns the batch id.
   */
  async createRedemption(caseId: string, actor: string, burnRule: "after_payment" | "after_finalization" | null = null): Promise<string> {
    const { rows } = await this.db.query<{ token: string; distribution_id: string; wallet: string; units: string }>(
      "SELECT token, distribution_id::text, wallet, units FROM exit.redemption_holders($1)",
      [caseId],
    );
    if (rows.length === 0) throw new ExitError("refused", "the case has no approved final distribution seen on chain");
    const items = rows.map((r) => ({ wallet: r.wallet, units: r.units, refId: redemptionRefId(r.token, r.distribution_id, r.wallet) }));
    const out = await this.db.query<{ id: string }>("SELECT exit.create_redemption($1, $2::jsonb, $3, $4)::text AS id", [caseId, JSON.stringify(items), burnRule, actor]);
    return out.rows[0]?.id ?? "";
  }

  /** One pass of exit.tick (read model, bank and outbox -> cases); returns the number of changes. */
  async tick(actor: string): Promise<number> {
    const { rows } = await this.db.query<{ n: number }>("SELECT exit.tick($1) AS n", [actor]);
    return rows[0]?.n ?? 0;
  }

  /** Problems of the exit audit chain (empty = intact). */
  async verifyAudit(): Promise<{ auditId: string | null; problem: string }[]> {
    const { rows } = await this.db.query<{ audit_id: string | null; problem: string }>("SELECT audit_id::text, problem FROM exit.verify_audit()");
    return rows.map((r) => ({ auditId: r.audit_id, problem: r.problem }));
  }
}

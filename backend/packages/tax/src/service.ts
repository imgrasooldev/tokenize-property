import { createHash } from "node:crypto";
import { normalizeCnic, type Peppers } from "@pt/kyc";
import type pg from "pg";
import { percent, rupees } from "./arithmetic.ts";
import { AtlUnavailable, type AtlProvider } from "./atl.ts";
import { formatCnic, type CnicKeys } from "./crypto.ts";
import { buildDocuments, verifyDocuments, type CalculationHeader, type Documents, type ScheduleLine } from "./statement.ts";

/**
 * Operations and tax services (spec S-03, migration 0021, ADR 0014). Every rule lives in the
 * database; these classes only do what SQL cannot: hashing with keccak, building the Merkle tree,
 * and opening sealed CNICs with the tax key (which never reaches the database).
 * Nothing here logs or returns a full CNIC, except the FBR filing file itself.
 */

type Db = pg.Pool;

export class TaxError extends Error {
  constructor(
    readonly code: "refused" | "not_found" | "invalid",
    message: string,
  ) {
    super(message);
  }
}

// ------------------------------------------------------------------ operations: statement and tax schedule

interface HeaderRow {
  id: string;
  token: string;
  period: string;
  record_date: string;
  record_block: string;
  income_type: string;
  collected: string;
  expenses: string;
  fees: string;
  reserve_contribution: string;
  reserve_release: string;
  distributable_gross: string;
  sum_wht: string;
  sum_net: string;
  status: string;
}

export class OpsService {
  constructor(private readonly db: Db) {}

  private async header(id: string): Promise<CalculationHeader & { status: string }> {
    const { rows } = await this.db.query<HeaderRow>(
      `SELECT id::text, token, period, record_date::text, record_block::text, income_type, collected::text, expenses::text, fees::text,
              reserve_contribution::text, reserve_release::text, distributable_gross::text, sum_wht::text, sum_net::text, status
       FROM ops.distributions WHERE id = $1`,
      [id],
    );
    const r = rows[0];
    if (!r) throw new TaxError("not_found", `unknown distribution calculation ${id}`);
    return {
      id: r.id,
      token: r.token,
      period: r.period,
      recordDate: r.record_date,
      recordBlock: r.record_block,
      incomeType: r.income_type,
      collected: BigInt(r.collected),
      expenses: BigInt(r.expenses),
      fees: BigInt(r.fees),
      reserveContribution: BigInt(r.reserve_contribution),
      reserveRelease: BigInt(r.reserve_release),
      distributableGross: BigInt(r.distributable_gross),
      wht: BigInt(r.sum_wht),
      net: BigInt(r.sum_net),
      status: r.status,
    };
  }

  async lines(id: string): Promise<ScheduleLine[]> {
    const { rows } = await this.db.query<{
      wallet: string; subject_id: string | null; units: string; gross: string; filer_status: string; filer_check_id: string | null;
      filer_as_of: string | null; flagged: boolean; rate_id: string; rate_ppm: number; wht: string; net: string;
    }>(
      `SELECT wallet, subject_id::text, units, gross::text, filer_status, filer_check_id::text, filer_as_of::text, flagged, rate_id::text, rate_ppm,
              wht::text, net::text FROM ops.distribution_lines_of($1)`,
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

  /** The statement, tax schedule and Merkle tree of a calculation, rebuilt from its lines. */
  async documents(id: string): Promise<Documents> {
    return buildDocuments(await this.header(id), await this.lines(id));
  }

  /** Builds and attaches the statement and tax schedule (the database checks them line by line). */
  async attach(id: string, actor: string): Promise<Documents> {
    const docs = await this.documents(id);
    await this.db.query("SELECT ops.attach_statement($1, $2, $3, $4, $5, $6, $7)", [id, docs.root, docs.statement, docs.statementHash, docs.schedule, docs.scheduleHash, actor]);
    return docs;
  }

  /**
   * Independent recomputation of a stored calculation (OP-SOD-2 style): the stored documents must
   * hash correctly, be internally consistent and equal what the lines produce today.
   */
  async verify(id: string): Promise<string[]> {
    const { rows } = await this.db.query<{ statement: string | null; statement_hash: string | null; tax_schedule: string | null; tax_schedule_hash: string | null; merkle_root: string | null }>(
      "SELECT statement, statement_hash, tax_schedule, tax_schedule_hash, merkle_root FROM ops.distributions WHERE id = $1",
      [id],
    );
    const r = rows[0];
    if (!r) return ["unknown calculation"];
    if (!r.statement || !r.statement_hash || !r.tax_schedule || !r.tax_schedule_hash || !r.merkle_root) return ["no statement attached"];
    const problems = verifyDocuments({ statement: r.statement, statementHash: r.statement_hash, schedule: r.tax_schedule, scheduleHash: r.tax_schedule_hash, root: r.merkle_root });
    const docs = await this.documents(id);
    if (docs.statementHash !== r.statement_hash) problems.push("the stored statement differs from the calculation's lines");
    if (docs.scheduleHash !== r.tax_schedule_hash) problems.push("the stored tax schedule differs from the calculation's lines");
    if (docs.root !== r.merkle_root) problems.push("the stored root differs from the calculation's lines");
    return problems;
  }

  /**
   * The statement file the investor website reads (chain/rent.py format, chain/data/rent/), with the
   * NET amount per wallet and its proof, for a published distribution id.
   */
  async statementFile(id: string, onchainId: number): Promise<{ id: number; root: string; statementHash: string; statement: string; entitlements: { wallet: string; amountPaisa: number; tokens: number; proof: string[] }[] }> {
    const docs = await this.documents(id);
    const num = (b: bigint | string): number => {
      const n = Number(b);
      if (!Number.isSafeInteger(n)) throw new TaxError("invalid", "amount beyond the website's statement file range");
      return n;
    };
    return {
      id: onchainId,
      root: docs.root,
      statementHash: docs.statementHash,
      statement: docs.statement,
      entitlements: docs.entitlements.map((e) => ({ wallet: e.wallet, amountPaisa: num(e.net), tokens: num(e.units), proof: e.proof })),
    };
  }
}

// ------------------------------------------------------------------ tax: sealed CNIC, ATL, filing export

export interface ExportFile {
  fileName: string;
  csv: Buffer;
  sha256: string;
  rows: number;
  record: { audit: number; auditHash: string; at: string; officer: string };
}

export const EXPORT_COLUMNS = [
  "withholdee_cnic",
  "income_type",
  "tax_status",
  "atl_as_of",
  "token",
  "period",
  "distribution_id",
  "record_date",
  "gross_pkr",
  "rate_percent",
  "wht_pkr",
  "net_pkr",
  "cpr_numbers",
  "wallet",
] as const;

const csvCell = (v: string): string => (/[",\n\r]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);

export class TaxService {
  constructor(
    private readonly db: Db,
    private readonly keys: CnicKeys,
    private readonly opts: { peppers?: Peppers; atl?: AtlProvider; actor?: string } = {},
  ) {}

  private get actor(): string {
    return this.opts.actor ?? "tax-service";
  }

  /**
   * Seals a CNIC for tax use (ADR 0014). The CNIC is accepted only if its peppered hash is the
   * subject's verified CNIC hash; it is held in memory for this call only and never logged.
   * Returns the sealed record id, or throws "refused" (audited) for a different CNIC.
   */
  async enrolCnic(subjectId: string, cnicInput: string): Promise<string> {
    const peppers = this.opts.peppers;
    if (!peppers) throw new Error("enrolling a CNIC needs the KYC peppers");
    const cnic = normalizeCnic(cnicInput);
    const candidates = peppers.hashAll("cnic", cnic).map((h) => ({
      version: h.version,
      hash: h.hash.toString("hex"),
      sealed: this.keys.seal(subjectId, h.hash, h.version, cnic).toString("hex"),
    }));
    const { rows } = await this.db.query<{ id: string | null }>("SELECT tax.enrol_cnic($1, $2, $3, $4)::text AS id", [subjectId, this.keys.current, JSON.stringify(candidates), this.actor]);
    const id = rows[0]?.id;
    if (!id) throw new TaxError("refused", "the CNIC is not the verified CNIC of this investor");
    return id;
  }

  /**
   * ATL checks for every investor with a sealed CNIC and no result for this ATL edition (OP-41).
   * An unavailable provider is recorded as such (the record date then falls back per OP-41).
   */
  async runAtlChecks(asOf: string, limit = 100): Promise<{ checked: number; filer: number; nonFiler: number; unavailable: number }> {
    const atl = this.opts.atl;
    if (!atl) throw new Error("no ATL provider configured");
    const { rows } = await this.db.query<{ subject_id: string; key_version: number; sealed: Buffer; cnic_hash: Buffer; pepper_version: number }>(
      "SELECT subject_id::text, key_version, sealed, cnic_hash, pepper_version FROM tax.atl_due($1, $2, $3)",
      [asOf, limit, this.actor],
    );
    const out = { checked: 0, filer: 0, nonFiler: 0, unavailable: 0 };
    for (const r of rows) {
      const cnic = this.keys.open(r.key_version, r.subject_id, r.cnic_hash, r.pepper_version, r.sealed);
      try {
        const res = await atl.check(cnic);
        await this.db.query("SELECT tax.record_filer_check($1, $2, $3, $4, $5, $6)", [r.subject_id, res.status, res.asOf, atl.name, res.evidence, this.actor]);
        if (res.status === "filer") out.filer++;
        else out.nonFiler++;
      } catch (e) {
        if (!(e instanceof AtlUnavailable)) throw e;
        const evidence = createHash("sha256").update(`${atl.name}:unavailable:${e.reason}`).digest();
        await this.db.query("SELECT tax.record_filer_check($1, 'unavailable', NULL, $2, $3, $4)", [r.subject_id, atl.name, evidence, this.actor]);
        out.unavailable++;
      }
      out.checked++;
    }
    return out;
  }

  /**
   * FBR filing export (ADR 0014 step 2 and 3): redeems the one-time ticket the portal obtained for an
   * approved two-officer export, opens the sealed CNICs in memory, builds the CSV and records its
   * SHA-256 in the same transaction BEFORE anything is released. No partial export.
   */
  async generateExport(exportId: string, ticketHash: Buffer): Promise<ExportFile> {
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<{
        subject_id: string; key_version: number; sealed: Buffer; cnic_hash: Buffer; pepper_version: number; wallet: string; token: string; period: string;
        onchain_id: string; income_type: string; filer_status: string; filer_as_of: string | null; gross: string; rate_ppm: number; wht: string; net: string;
        record_date: string; cprs: string;
      }>(
        `SELECT subject_id::text, key_version, sealed, cnic_hash, pepper_version, wallet, token, period, onchain_id, income_type, filer_status,
                filer_as_of::text, gross::text, rate_ppm, wht::text, net::text, record_date::text, cprs
         FROM tax.redeem_export_ticket($1, $2)`,
        [ticketHash, exportId],
      );
      const lines = [EXPORT_COLUMNS.join(",")];
      for (const r of rows) {
        const cnic = this.keys.open(r.key_version, r.subject_id, r.cnic_hash, r.pepper_version, r.sealed);
        lines.push(
          [
            formatCnic(cnic),
            r.income_type,
            r.filer_status,
            r.filer_as_of ?? "",
            r.token,
            r.period,
            r.onchain_id,
            r.record_date,
            rupees(BigInt(r.gross)),
            percent(r.rate_ppm),
            rupees(BigInt(r.wht)),
            rupees(BigInt(r.net)),
            r.cprs,
            r.wallet,
          ]
            .map(csvCell)
            .join(","),
        );
      }
      const csv = Buffer.from(`${lines.join("\n")}\n`, "utf8");
      const sha = createHash("sha256").update(csv).digest();
      const rec = await client.query<{ r: { audit: number; auditHash: string; at: string; officer: string } }>("SELECT tax.complete_export($1, $2, $3, $4) AS r", [
        ticketHash,
        exportId,
        sha,
        rows.length,
      ]);
      await client.query("COMMIT");
      const record = rec.rows[0]?.r;
      if (!record) throw new Error("export not recorded");
      return { fileName: `fbr-withholding-export-${exportId}.csv`, csv, sha256: sha.toString("hex"), rows: rows.length, record };
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }
}

/** Database errors the officer may read (raised on purpose, no internals); anything else stays generic. */
export function officerMessage(e: unknown): string | null {
  const code = e instanceof Error && "code" in e ? (e as { code?: unknown }).code : undefined;
  if (typeof code === "string" && ["23514", "42501", "P0002", "23505"].includes(code) && e instanceof Error) return e.message.slice(0, 300);
  return null;
}

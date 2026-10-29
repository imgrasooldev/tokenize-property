import { db } from "./db";

/**
 * Annual withholding tax certificates (S-03 OP-51, migration 0035). Every call goes through a
 * session-bound tax.web_* function: the database derives the investor from the session and returns
 * only that investor's certificates. The content is returned as the exact text that was hashed when
 * the certificate was issued, so a downloaded file matches its SHA-256 byte for byte.
 */
export interface CertificateRow {
  id: string;
  fiscalYear: number;
  issuedAt: Date;
  sha256: string;
  supersededBy: string | null;
}

export interface CertificateLine {
  token: string;
  period: string;
  recordDate: string;
  distributionId: string | null;
  incomeType: string;
  units: string;
  grossPaisa: string;
  status: string;
  ratePpm: number;
  whtPaisa: string;
  netPaisa: string;
  cprs: string[];
}

export interface Certificate {
  id: number;
  fiscalYear: number;
  issuedAt: string;
  sha256: string;
  superseded: boolean;
  content: { from: string; to: string; lines: CertificateLine[]; totals: { grossPaisa: string; whtPaisa: string; netPaisa: string } };
  contentText: string;
}

export async function certificates(session: Buffer): Promise<CertificateRow[]> {
  const { rows } = await (await db()).query<{ id: string; fiscal_year: number; issued_at: Date; sha256: string; superseded_by: string | null }>(
    "SELECT * FROM tax.web_certificates($1)",
    [session],
  );
  return rows.map((r) => ({ id: r.id, fiscalYear: r.fiscal_year, issuedAt: r.issued_at, sha256: r.sha256, supersededBy: r.superseded_by }));
}

export async function certificate(session: Buffer, id: string): Promise<Certificate | null> {
  if (!/^[1-9]\d{0,17}$/.test(id)) return null;
  const { rows } = await (await db()).query<{ c: Certificate | null }>("SELECT tax.web_certificate($1, $2) AS c", [session, id]);
  return rows[0]?.c ?? null;
}

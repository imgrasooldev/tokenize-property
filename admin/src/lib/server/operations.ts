import { db } from "./db";

/**
 * S-03 reads (migration 0021): property operations and withholding tax. Every function is one call
 * of an admin.* database function that checks the session and the permission itself. Shapes mirror
 * the jsonb those functions build. Amounts are integer paisa as strings; no CNIC, name or IBAN is
 * ever returned (investors appear as an 8-character subject reference and a wallet address).
 */

export interface PeriodRow {
  token: string;
  period: string;
  collected: string;
  distributable: string;
  pending: number;
  distribution: { id: number; status: string } | null;
}

export async function periods(sessionHash: Buffer): Promise<PeriodRow[]> {
  const { rows } = await db().query<{ v: PeriodRow[] }>("SELECT admin.operations_periods($1) AS v", [sessionHash]);
  return rows[0]?.v ?? [];
}

export interface Statement {
  token: string;
  period: string;
  locked: boolean;
  totals: {
    collected: string;
    expenses: string;
    fees: { propertyManager: string; trustee: string; platform: string; total: string };
    reserveContribution: string;
    reserveRelease: string;
    netOperatingCash: string;
    distributableGross: string;
    shortfall: string;
    pending: number;
  };
  collections: { id: number; reference: string; valueDate: string; amount: string; source: string; status: string; proposedBy: string; decidedBy: string | null; journal: number | null }[];
  charges: {
    id: number;
    kind: string;
    feeType: string | null;
    payee: string | null;
    description: string;
    amount: string;
    evidence: string;
    status: string;
    proposedBy: string;
    decidedBy: string | null;
    journal: number | null;
  }[];
  distributions: {
    id: number;
    status: string;
    recordDate: string;
    recordBlock: number;
    incomeType: string;
    gross: string;
    wht: string;
    net: string;
    holders: number;
    flagged: number;
    placeholder: number;
    onchainId: string | null;
  }[];
}

export async function statement(sessionHash: Buffer, token: string, period: string): Promise<Statement | null> {
  const { rows } = await db().query<{ v: Statement | null }>("SELECT admin.operations_statement($1, $2, $3) AS v", [sessionHash, token, period]);
  return rows[0]?.v ?? null;
}

export interface Charge {
  id: number;
  token: string;
  period: string;
  kind: string;
  feeType: string | null;
  payee: string | null;
  description: string;
  amount: string;
  evidence: string;
  status: string;
  proposedBy: string;
  proposedAt: string;
  decidedBy: string | null;
  decisionReason: string | null;
  decidedAt: string | null;
  journal: number | null;
  digest: string;
  aboveLimit: boolean;
  limit: string;
  blockers: { approve: string[]; reject: string[] };
}

export async function charge(sessionHash: Buffer, id: string): Promise<Charge | null> {
  const { rows } = await db().query<{ v: Charge | null }>("SELECT admin.operations_charge($1, $2) AS v", [sessionHash, id]);
  return rows[0]?.v ?? null;
}

export interface DistributionLine {
  wallet: string;
  subject: string | null;
  units: string;
  gross: string;
  status: string;
  asOf: string | null;
  flag: string | null;
  ratePpm: number;
  placeholder: boolean;
  wht: string;
  net: string;
}

export interface Distribution {
  id: number;
  token: string;
  period: string;
  recordDate: string;
  recordBlock: number;
  incomeType: string;
  collected: string;
  expenses: string;
  fees: string;
  reserveContribution: string;
  reserveRelease: string;
  gross: string;
  wht: string;
  net: string;
  holders: number;
  units: string;
  flagged: number;
  placeholder: number;
  status: string;
  root: string | null;
  statementHash: string | null;
  taxScheduleHash: string | null;
  calculatedBy: string;
  calculatedAt: string;
  attachedBy: string | null;
  decidedBy: string | null;
  decisionReason: string | null;
  decidedAt: string | null;
  onchainId: string | null;
  bookedAt: string | null;
  digest: string;
  blockers: { approve: string[]; reject: string[] };
  lines: DistributionLine[];
}

export async function distribution(sessionHash: Buffer, id: string): Promise<Distribution | null> {
  const { rows } = await db().query<{ v: Distribution | null }>("SELECT admin.operations_distribution($1, $2) AS v", [sessionHash, id]);
  return rows[0]?.v ?? null;
}

export interface RentCommand {
  id: number;
  status: string;
  lastError: string | null;
  txHash: string | null;
  by: string;
  at: string;
}

/** Where an approved calculation stands on chain (admin.rent_onchain, migration 0033); a blocker of null = the step is allowed now. */
export interface RentOnchain {
  status: string;
  onchain: { registry: string; id: string; status: string; closesAt: string | null } | null;
  publishCommand: RentCommand | null;
  finalizeCommand: RentCommand | null;
  blockers: { publish: string | null; finalize: string | null; book: string | null };
}

export async function rentOnchain(sessionHash: Buffer, id: string): Promise<RentOnchain | null> {
  const { rows } = await db().query<{ v: RentOnchain | null }>("SELECT admin.rent_onchain($1, $2) AS v", [sessionHash, id]);
  return rows[0]?.v ?? null;
}

export interface Rate {
  id: number;
  incomeType: string;
  status: string;
  ratePpm: number;
  effectiveFrom: string;
  version: number;
  basis: string;
  placeholder: boolean;
  state: string;
  proposedBy: string;
  proposedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  inForce: boolean;
  digest: string;
  blockers: string[];
}

export interface TaxOverview {
  at: string;
  today: string;
  allowPlaceholder: boolean;
  incomeTypes: { code: string; label: string; note: string }[];
  rates: Rate[];
  filer: { sealedCnics: number; checks: Record<string, number>; lastCheck: string | null };
  positions: { token: string; period: string; withheld: string; remitted: string; pending: string; outstanding: string }[];
}

export async function taxOverview(sessionHash: Buffer): Promise<TaxOverview> {
  const { rows } = await db().query<{ v: TaxOverview }>("SELECT admin.tax_overview($1) AS v", [sessionHash]);
  const v = rows[0]?.v;
  if (!v) throw new Error("no tax overview");
  return v;
}

export interface ExportRow {
  id: number;
  token: string | null;
  from: string;
  to: string;
  status: string;
  requestedBy: string;
  requestedAt: string;
  decidedBy: string | null;
  generatedBy: string | null;
  generatedAt: string | null;
  rows: number | null;
}

export async function taxExports(sessionHash: Buffer): Promise<ExportRow[]> {
  const { rows } = await db().query<{ v: ExportRow[] }>("SELECT admin.tax_exports($1) AS v", [sessionHash]);
  return rows[0]?.v ?? [];
}

export interface ExportDetail extends ExportRow {
  reason: string;
  decisionReason: string | null;
  decidedAt: string | null;
  fileSha256: string | null;
  linesInScope: number;
  missingCnic: number;
  digest: string;
  blockers: { approve: string[]; reject: string[]; generate: string[] };
}

export async function taxExport(sessionHash: Buffer, id: string): Promise<ExportDetail | null> {
  const { rows } = await db().query<{ v: ExportDetail | null }>("SELECT admin.tax_export($1, $2) AS v", [sessionHash, id]);
  return rows[0]?.v ?? null;
}

/** Paisa (integer string) as rupees, without floating point: "175230000" -> "Rs 1,752,300.00". */
export function rupees(paisa: string | null | undefined): string {
  if (paisa === null || paisa === undefined || !/^-?\d+$/.test(paisa)) return "–";
  const neg = paisa.startsWith("-");
  const digits = (neg ? paisa.slice(1) : paisa).padStart(3, "0");
  const whole = BigInt(digits.slice(0, -2)).toString();
  const groups: string[] = [];
  for (let end = whole.length; end > 0; end -= 3) groups.unshift(whole.slice(Math.max(0, end - 3), end));
  return `${neg ? "-" : ""}Rs ${groups.join(",")}.${digits.slice(-2)}`;
}

/** Parts per million as a percentage: 150000 -> "15 %", 125000 -> "12.5 %". */
export function ratePercent(ppm: number): string {
  const whole = Math.trunc(ppm / 10_000);
  const frac = String(ppm % 10_000).padStart(4, "0").replace(/0+$/, "");
  return `${String(whole)}${frac ? `.${frac}` : ""} %`;
}

export const INCOME_STATUSES = ["filer", "non_filer", "exempt"] as const;
export const CHARGE_KINDS = ["expense", "fee", "reserve_contribution", "reserve_release"] as const;
export const FEE_TYPES = ["property_manager", "trustee", "platform"] as const;

/** Registered bank accounts and the latest imported statements (admin.bank_statements, migration 0037). */
export interface BankStatements {
  accounts: string[];
  statements: { id: number; account: string; date: string; opening: string; closing: string; by: string; at: string }[];
}

export async function bankStatements(sessionHash: Buffer): Promise<BankStatements> {
  const { rows } = await db().query<{ v: BankStatements }>("SELECT admin.bank_statements($1) AS v", [sessionHash]);
  return rows[0]?.v ?? { accounts: [], statements: [] };
}

/** Credits in suspense, open return requests and batches with held lines (admin.bank_desk, migration 0038). */
export interface BankDesk {
  suspense: { ref: string; amount: string; valueDate: string; payerLast4: string }[];
  returns: { id: number; ref: string; reason: string; requestedBy: string; requestedAt: string }[];
  held: { batch: number; reference: string; token: string; distribution: string; heldLines: number; payableNow: number }[];
}

export async function bankDesk(sessionHash: Buffer): Promise<BankDesk> {
  const { rows } = await db().query<{ v: BankDesk }>("SELECT admin.bank_desk($1) AS v", [sessionHash]);
  return rows[0]?.v ?? { suspense: [], returns: [], held: [] };
}

/** Signing policies per kind: the active version and open proposals (admin.signer_policies, migration 0039). */
export interface SignerPolicyKind {
  kind: string;
  active: { id: number; version: number; rule: Record<string, unknown>; proposedBy: string; approvedBy: string | null; approvedAt: string | null } | null;
  proposals: { id: number; version: number; rule: Record<string, unknown>; proposedBy: string; proposedAt: string }[];
}

export async function signerPolicies(sessionHash: Buffer): Promise<SignerPolicyKind[]> {
  const { rows } = await db().query<{ v: SignerPolicyKind[] }>("SELECT admin.signer_policies($1) AS v", [sessionHash]);
  return rows[0]?.v ?? [];
}

/** Rent invoices with the bank lines that could have paid them (admin.rent_invoices, migration 0044). */
export interface RentInvoice {
  id: number;
  token: string;
  period: string;
  tenant: string;
  amount: string;
  due: string;
  code: string;
  status: "open" | "proposed" | "paid" | "cancelled";
  collection: number | null;
  collectionStatus: string | null;
  collectionBy: string | null;
  overdue: boolean;
  by: string;
  at: string;
  candidates: { statement: number; line: number; date: string; reference: string; counterparty: string }[] | null;
}

export async function rentInvoices(sessionHash: Buffer): Promise<{ invoices: RentInvoice[]; tokens: string[] }> {
  const { rows } = await db().query<{ v: { invoices: RentInvoice[]; tokens: string[] } }>("SELECT admin.rent_invoices($1) AS v", [sessionHash]);
  return rows[0]?.v ?? { invoices: [], tokens: [] };
}


import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { findSubject, KycService, keyFromEnv, mockProviders, normalizeCnic, Peppers, statusOf } from "@pt/kyc";
import {
  PropertyService,
  reviewStatus,
  runAction as runProperty,
  SponsorSecrets,
  sponsorState,
  type ActionInput as PropertyInput,
  type ActionName as PropertyAction,
  type ActionResult as PropertyResult,
  type Identifiers,
} from "@pt/property";
import type pg from "pg";
import { OfferingError, runAction as runOffering, type ActionInput as OfferingInput, type ActionName as OfferingAction, type ActionResult as OfferingResult, type Terms } from "./service.ts";

/**
 * DEMO CATALOG (local / demo databases only): onboards two fictional properties through the real
 * S-01 and S-02 workflows, so the website lists only records the platform itself produced.
 *
 *   - Every step is a property.* / offering.* / kyc function (the same runAction the CLI and the
 *     portal use). Nothing is inserted or updated directly, no trigger is touched, no chain row is
 *     written. Maker-checker, duties and segregation of duties are enforced by the database.
 *   - The officers it acts under must already be ACTIVE officers of the admin portal (PT Control)
 *     with a matching role (migration 0016 A-7). The seed never bootstraps an administrator, never
 *     enrols or invites an officer and never creates a credential. Missing officers: it prints what an
 *     administrator must enrol, writes nothing and reports "skipped".
 *   - Duties (property.staff_duties, offering.duties) are requested and approved through
 *     request_duty / decide_duty by two operator names (maker-checker); these functions take any
 *     operator name as `by` (no portal session is needed).
 *   - Idempotent: identifiers are deterministic (sponsor CUIN, building + deed number, valuer
 *     licences, document bytes); a second run finds everything and writes nothing.
 *   - It NEVER casts a vote or decision under an officer's handle (lead decision 2026-10-22, ADR 0011
 *     open item 13): the K4 KYB decision, the investment committee votes and its close, the trustee's
 *     P8 acceptance and the L3 offering votes are the officers' own, in PT Control with a session and
 *     a security-key step-up (screens of migrations 0016, 0023 and 0026; the database refuses these
 *     votes under an officer's handle anywhere else). The seed prepares everything up to the first
 *     such vote (it opens the committee meeting for the chair, records the structure for the legal
 *     head, creates and submits the offering for the offering maker), then stops and reports which
 *     votes are due and on which PT Control page ("waiting"); run it again after the officers
 *     decided. A run that finds the same votes still due writes nothing. A committee that did not
 *     approve, or a structure the trustee declined, stops the seed ("blocked"): that is a decision.
 *   - With every vote cast, it ends at offering state `approved` (L3). `ready` needs a deployed, paused
 *     token with the trustee cap and the documents anchored (offering.mark_ready): only attempted
 *     with an explicit token.
 *   - Documents are the files in ../demo/: their SHA-256 (of the exact bytes) is what gets recorded.
 */

export const DEMO_DIR = fileURLToPath(new URL("../demo/", import.meta.url));

/** Databases the seed may write to: the local/demo database, the shared test database, scratch databases. */
export const ALLOWED_DATABASE = /^(property_token|property_token_test|pt_scratch_[a-z0-9_]+)$/;

type Schema = "property" | "offering";

interface RoleDef {
  handle: string;
  schema: Schema;
  duty: string;
  /** The portal role to enrol the officer with (any role of admin.duty_roles(duty) is accepted). */
  suggest: string;
  what: string;
}

/** The demo officers, one per role the backend test worlds use; override with DEMO_CATALOG_OFFICERS. */
export const DEMO_ROLES = {
  onboardingMaker: { handle: "demo.onb-1", schema: "property", duty: "onboarding", suggest: "ops_maker", what: "enters the sponsor and property files for the sponsor (S-01 maker)" },
  onboardingChecker: { handle: "demo.onb-2", schema: "property", duty: "onboarding", suggest: "ops_maker", what: "screens the KYB file and starts the review (S-01 second officer)" },
  complianceMaker: { handle: "demo.comp-1", schema: "property", duty: "compliance", suggest: "compliance_officer", what: "screening, risk rating and the K4 request" },
  complianceChecker: { handle: "demo.comp-2", schema: "property", duty: "compliance", suggest: "compliance_officer", what: "approves K4 (KYB) as the second compliance officer" },
  legalReviewer: { handle: "demo.legal-1", schema: "property", duty: "legal", suggest: "ops_checker", what: "title, encumbrance and legal-opinion reviews" },
  legalHead: { handle: "demo.legal-head", schema: "property", duty: "legal_head", suggest: "ops_checker", what: "decides the legal structure (P8 maker)" },
  valuationReviewer: { handle: "demo.val-1", schema: "property", duty: "valuation", suggest: "ops_checker", what: "records the two valuations and reviews them" },
  technicalReviewer: { handle: "demo.tech-1", schema: "property", duty: "technical", suggest: "ops_checker", what: "technical review" },
  icChair: { handle: "demo.ic-1", schema: "property", duty: "ic_member", suggest: "ops_checker", what: "chairs the investment committee and votes" },
  icMember: { handle: "demo.ic-2", schema: "property", duty: "ic_member", suggest: "ops_checker", what: "votes in the investment committee" },
  icIndependent: { handle: "demo.ic-indep", schema: "property", duty: "ic_independent", suggest: "ops_checker", what: "independent committee member" },
  trustee: { handle: "demo.trustee-1", schema: "property", duty: "trustee", suggest: "trustee_officer", what: "accepts the property for the trust (P8)" },
  offeringMaker: { handle: "demo.off-maker", schema: "offering", duty: "offering", suggest: "ops_maker", what: "creates and submits the offering (L1 maker)" },
  offeringChecker: { handle: "demo.off-checker", schema: "offering", duty: "offering", suggest: "ops_checker", what: "approves the offering terms (L3 checker)" },
  offeringLegalHead: { handle: "demo.legal-head", schema: "offering", duty: "legal_head", suggest: "ops_checker", what: "approves the offering documents (L3)" },
  offeringCompliance: { handle: "demo.comp-2", schema: "offering", duty: "compliance", suggest: "compliance_officer", what: "approves eligibility and disclosures (L3)" },
  offeringTrustee: { handle: "demo.trustee-1", schema: "offering", duty: "trustee", suggest: "trustee_officer", what: "trustee approval of the offering (L3)" },
} as const satisfies Record<string, RoleDef>;

export type RoleKey = keyof typeof DEMO_ROLES;

/** Operator names (not portal officers) that request and approve the duties and the valuer panel (maker-checker). */
export const DEMO_GRANTORS = { grantorA: "operator:demo-catalog-a", grantorB: "operator:demo-catalog-b" } as const;
type GrantorKey = keyof typeof DEMO_GRANTORS;

type Handles = Readonly<Record<RoleKey | GrantorKey, string>>;
const ROLE_DEFS = new Map<string, RoleDef>(Object.entries(DEMO_ROLES));

function def(k: RoleKey): RoleDef {
  const d = ROLE_DEFS.get(k);
  if (!d) throw new Error(`unknown role ${k}`);
  return d;
}

function handle(h: Handles, k: RoleKey | GrantorKey): string {
  return new Map<string, string>(Object.entries(h)).get(k) ?? "";
}

const ROLE_KEYS = Object.keys(DEMO_ROLES) as RoleKey[];
const S01_KEYS = ROLE_KEYS.filter((k) => def(k).schema === "property");
const HANDLE = /^[a-z][a-z0-9._-]{2,39}$/;
const ACTOR = /^[A-Za-z0-9][A-Za-z0-9@._:+-]{1,99}$/;

// ------------------------------------------------------------------ the catalog (fictional)
export const SPONSOR = {
  legalName: "Demo Realty Holdings (Private) Limited",
  address: "Demo Office 1, Fictional Plaza, Clifton, Karachi",
  cuin: "0999001",
  ntn: "9999001-1",
  representative: { cnic: "42201-9990001-2", name: "Sana Demorep", session: "sess-demo-catalog-rep" },
  owner: { cnic: "42201-9990002-3", name: "Tariq Demoowner", session: "sess-demo-catalog-owner" },
  docs: [
    ["certificate_of_incorporation", "sponsor-certificate-of-incorporation.pdf"],
    ["memorandum_articles", "sponsor-memorandum-articles.pdf"],
    ["annual_return", "sponsor-annual-return.pdf"],
    ["directors_list", "sponsor-directors-list.pdf"],
    ["ntn_certificate", "sponsor-ntn-certificate.pdf"],
    ["board_resolution", "sponsor-board-resolution.pdf"],
  ] as [string, string][],
};

export const VALUER_LICENCES = ["PBA/DEMO/001", "PBA/DEMO/002"] as const;

export interface DemoProperty {
  slug: string;
  name: string;
  identifiers: Identifiers & { building: string; deed_no: string };
  /** Documents the sponsor's side files with the draft (doc type, file). */
  draftDocs: [string, string][];
  plannedUnits: bigint;
  valuations: [bigint, bigint];
  price: bigint;
  cap: bigint;
  minUnits: bigint;
  maxUnits: bigint;
  useOfProceeds: { line: string; paisa: bigint }[];
}

const draftDocs = (slug: string, leases: number): [string, string][] => [
  ["title_deed", `${slug}-title-deed.pdf`],
  ["land_record_extract", `${slug}-land-record-extract.pdf`],
  ["property_tax_receipt", `${slug}-property-tax-receipt.pdf`],
  ["authority_to_sell", `${slug}-authority-to-sell.pdf`],
  ["approved_building_plan", `${slug}-approved-building-plan.pdf`],
  ["completion_certificate", `${slug}-completion-certificate.pdf`],
  ["utility_bill", `${slug}-utility-bill.pdf`],
  ["insurance_policy", `${slug}-insurance-policy.pdf`],
  ...(leases === 1
    ? [["lease_agreement", `${slug}-lease-agreement.pdf`] as [string, string]]
    : Array.from({ length: leases }, (_, i): [string, string] => ["lease_agreement", `${slug}-lease-agreement-${String(i + 1)}.pdf`])),
  ["rent_roll", `${slug}-rent-roll.pdf`],
];

export const DEMO_PROPERTIES: DemoProperty[] = [
  {
    slug: "dha-phase6-retail",
    name: "DHA Phase 6 Retail Unit",
    identifiers: {
      province: "sindh",
      district: "Karachi South",
      tehsil: "Clifton",
      society: "DHA Phase 6 (demo)",
      plot_no: "DEMO-6-R-14",
      building: "DHA Phase 6 Retail Unit",
      sub_registrar: "Sub-Registrar Clifton (demo)",
      deed_no: "DEMO-KHI-0001",
      deed_volume: "7",
      deed_page: "112",
      deed_date: "2015-03-01",
      land_record_ref: "DEMO-LR-KHI-0001",
      authority_file_no: "DHA-DEMO-0001",
      excise_no: "EX-DEMO-KHI-01",
      address: "Demo Retail Unit, Phase 6, DHA, Karachi (fictional)",
      land_area: "4500",
      land_area_unit: "sq_ft",
      covered_area_sqft: "9200",
      gps_lat: "24.800800",
      gps_lon: "67.064500",
      use: "commercial",
      built: true,
      occupancy: "tenanted",
      lease_count: 1,
      monthly_rent_paisa: "6500000",
      declared_charges: false,
    },
    draftDocs: draftDocs("dha-phase6-retail", 1),
    plannedUnits: 20_000n,
    valuations: [1_080_000_000n, 1_120_000_000n],
    price: 50_000n,
    cap: 20_000n,
    minUnits: 10n,
    maxUnits: 1_000n,
    useOfProceeds: [
      { line: "purchase_price", paisa: 950_000_000n },
      { line: "stamp_duty_registration", paisa: 30_000_000n },
      { line: "legal_valuation_platform_costs", paisa: 20_000_000n },
    ],
  },
  {
    slug: "blue-area-office-f2",
    name: "Blue Area Office, Floor 2",
    identifiers: {
      province: "ict",
      district: "Islamabad",
      tehsil: "Islamabad",
      society: "Blue Area (demo)",
      plot_no: "DEMO-BA-27",
      building: "Blue Area Office, Floor 2",
      floor: "2",
      sub_registrar: "Sub-Registrar Islamabad (demo)",
      deed_no: "DEMO-ISB-0002",
      deed_volume: "3",
      deed_page: "41",
      deed_date: "2017-09-12",
      land_record_ref: "DEMO-LR-ISB-0002",
      authority_file_no: "CDA-DEMO-0002",
      excise_no: "EX-DEMO-ISB-02",
      address: "Demo Office, Floor 2, Blue Area, Islamabad (fictional)",
      land_area: "6000",
      land_area_unit: "sq_ft",
      covered_area_sqft: "14000",
      gps_lat: "33.710400",
      gps_lon: "73.062100",
      use: "commercial",
      built: true,
      occupancy: "partly_tenanted",
      lease_count: 2,
      monthly_rent_paisa: "8900000",
      declared_charges: false,
    },
    draftDocs: draftDocs("blue-area-office-f2", 2),
    plannedUnits: 30_000n,
    valuations: [1_560_000_000n, 1_610_000_000n],
    price: 50_000n,
    cap: 30_000n,
    minUnits: 10n,
    maxUnits: 1_500n,
    useOfProceeds: [
      { line: "purchase_price", paisa: 1_425_000_000n },
      { line: "stamp_duty_registration", paisa: 45_000_000n },
      { line: "legal_valuation_platform_costs", paisa: 30_000_000n },
    ],
  },
];

/** Every demo file of a property: draft documents, due-diligence documents and the three offering documents. */
export function propertyFiles(p: DemoProperty): { docType: string; file: string }[] {
  return [
    ...p.draftDocs.map(([docType, file]) => ({ docType, file })),
    ...ddFiles(p).map(([docType, file]) => ({ docType, file })),
  ];
}

const ddFiles = (p: DemoProperty): [string, string][] => [
  ["encumbrance_search", `${p.slug}-encumbrance-search.pdf`],
  ["legal_opinion", `${p.slug}-legal-opinion.pdf`],
  ["technical_report", `${p.slug}-technical-report.pdf`],
  ["valuation_report", `${p.slug}-valuation-report-1.pdf`],
  ["valuation_report", `${p.slug}-valuation-report-2.pdf`],
  ["trust_deed", `${p.slug}-trust-deed.pdf`],
];

export const offeringFiles = (p: DemoProperty): { en: string; ur: string; risk: string } => ({
  en: `${p.slug}-offering-en.txt`,
  ur: `${p.slug}-offering-ur.txt`,
  risk: `${p.slug}-risk.txt`,
});

// ------------------------------------------------------------------ options and result
export interface SeedSecrets {
  sponsor: SponsorSecrets;
  kycPeppers: Peppers;
  kycDataKey: Buffer;
}

export interface SeedOptions {
  /** NODE_ENV, DEMO_CATALOG_OFFICERS and the PROPERTY_* / KYC_* secrets (backend/.env.local + process env). */
  env?: Record<string, string | undefined>;
  /** Handle overrides (role key or grantorA/grantorB -> name); otherwise DEMO_CATALOG_OFFICERS, then the defaults. */
  officers?: Partial<Handles>;
  /** Secrets; otherwise read from env. */
  secrets?: SeedSecrets;
  /** Optional: a deployed token address; the seed then tries L4 (mark_ready) and one clock tick. */
  token?: string;
  /** Directory of the demo documents (default ../demo/). */
  demoDir?: string;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface PropertyOutcome {
  slug: string;
  name: string;
  outcome: "created" | "resumed" | "already" | "waiting" | "blocked" | "failed";
  /** For "waiting": the votes officers must cast in PT Control before the seed can continue. */
  votes: string[];
  propertyId: string | null;
  offeringId: string | null;
  propertyState: string | null;
  offeringState: string | null;
  writes: number;
  line: string;
}

export type SeedResult =
  | { status: "refused"; reason: string }
  | { status: "skipped"; problems: string[]; plan: string[] }
  | { status: "done"; dutiesGranted: number; properties: PropertyOutcome[] };

// ------------------------------------------------------------------ helpers
const sha = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");
/** Hash of a short, labelled statement standing in for an evidence file of the demo (no such file exists). */
const evidence = (slug: string, what: string): string => sha(`DEMO EVIDENCE - ${what} - ${slug} (fictional)`);

/** The seed reached a vote that only an officer may cast (in PT Control): it stops here. */
class Waiting extends Error {
  constructor(readonly votes: string[]) {
    super(`waiting for officers: ${votes.join("; ")}`);
  }
}

/** The seed reached an officer's decision that ends this path (committee not approved, structure declined). */
class Blocked extends Error {}

const STEP_UP = "with a security-key step-up";

/** The committee minutes of the demo (their SHA-256 is what the chair enters when closing). */
export const minutesFile = (p: DemoProperty): string => `${p.slug}-ic-minutes.txt`;

interface DemoFile {
  bytes: Buffer;
  sha256: string;
}

class Ctx {
  writes = 0;
  private readonly files = new Map<string, DemoFile>();
  constructor(
    readonly pool: pg.Pool,
    readonly h: Handles,
    readonly svc: PropertyService,
    readonly kyc: KycService,
    readonly peppers: Peppers,
    readonly demoDir: string,
    readonly now: () => Date,
    readonly token: string | undefined,
    readonly log: (line: string) => void,
  ) {}

  async p<K extends PropertyAction>(name: K, input: PropertyInput<K>): Promise<PropertyResult<K>> {
    const r = await runProperty(this.pool, name, input);
    this.writes++;
    return r;
  }

  async o<K extends OfferingAction>(name: K, input: OfferingInput<K>): Promise<OfferingResult<K>> {
    const r = await runOffering(this.pool, name, input);
    this.writes++;
    return r;
  }

  file(name: string): DemoFile {
    let f = this.files.get(name);
    if (!f) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed file names of the demo catalog inside the package
      const bytes = readFileSync(`${this.demoDir}${name}`);
      f = { bytes, sha256: sha(bytes) };
      this.files.set(name, f);
    }
    return f;
  }

  async one<T extends pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    const { rows } = await this.pool.query<T>(sql, params);
    return rows[0];
  }
}

function demoEnv(env: Record<string, string | undefined>, officers: SeedOptions["officers"]): { handles: Handles; problems: string[] } {
  const problems: string[] = [];
  const handles = new Map<string, string>([...ROLE_KEYS.map((k): [string, string] => [k, def(k).handle]), ...Object.entries(DEMO_GRANTORS)]);
  let fromEnv: Record<string, unknown> = {};
  if (env.DEMO_CATALOG_OFFICERS) {
    try {
      const parsed: unknown = JSON.parse(env.DEMO_CATALOG_OFFICERS);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
      fromEnv = parsed as Record<string, unknown>;
    } catch (e) {
      problems.push(`DEMO_CATALOG_OFFICERS is not a JSON object of role -> handle (${(e as Error).message})`);
    }
  }
  for (const [k, v] of [...Object.entries(fromEnv), ...Object.entries(officers ?? {})]) {
    if (!handles.has(k)) {
      problems.push(`unknown role "${k}" in the officer map (known: ${[...handles.keys()].join(", ")})`);
      continue;
    }
    const grantor = k === "grantorA" || k === "grantorB";
    if (typeof v !== "string" || !(grantor ? ACTOR : HANDLE).test(v)) {
      problems.push(`role ${k}: "${String(v)}" is not a valid ${grantor ? "operator name" : "officer handle"}`);
      continue;
    }
    handles.set(k, v);
  }
  return { handles: Object.fromEntries(handles) as Handles, problems };
}


/** Segregation of duties the database would refuse later, checked up front so the seed never stops half way. */
function separationProblems(h: Handles): string[] {
  const out: string[] = [];
  const s01 = S01_KEYS.map((k) => handle(h, k));
  if (new Set(s01).size !== s01.length) out.push(`the S-01 roles need ${String(s01.length)} different officers (maker-checker, OB-SOD): ${S01_KEYS.map((k) => `${k}=${handle(h, k)}`).join(", ")}`);
  const approvers: RoleKey[] = ["offeringChecker", "offeringLegalHead", "offeringCompliance", "offeringTrustee"];
  const l3 = [h.offeringMaker, ...approvers.map((k) => handle(h, k))];
  if (new Set(l3).size !== l3.length) out.push("the offering maker and the four L3 approvers must be five different officers");
  const parties: RoleKey[] = ["onboardingMaker", "onboardingChecker", "legalReviewer", "valuationReviewer", "technicalReviewer"];
  for (const a of approvers) {
    if (parties.some((p) => handle(h, p) === handle(h, a))) out.push(`${a} (${handle(h, a)}) is a party to the S-01 file and cannot approve the offering (OF-SOD-1)`);
  }
  for (const k of ROLE_KEYS) {
    if (def(k).duty === "trustee" && ROLE_KEYS.some((x) => def(x).duty !== "trustee" && def(x).schema === def(k).schema && handle(h, x) === handle(h, k))) {
      out.push(`${k} (${handle(h, k)}) is a trustee officer and cannot hold a platform duty`);
    }
  }
  if (h.grantorA === h.grantorB) out.push("grantorA and grantorB must differ (duties are granted maker-checker)");
  for (const g of ["grantorA", "grantorB"] as const) {
    if (ROLE_KEYS.some((k) => handle(h, k) === handle(h, g))) out.push(`${g} (${handle(h, g)}) must not be one of the officers (nobody grants a duty to themselves)`);
  }
  return out;
}

function loadSecrets(env: Record<string, string | undefined>): { secrets?: SeedSecrets; problem?: string } {
  try {
    return { secrets: { sponsor: SponsorSecrets.fromEnv(env), kycPeppers: Peppers.fromEnv(env), kycDataKey: keyFromEnv(env, "KYC_DATA_KEY") } };
  } catch (e) {
    return { problem: `secrets: ${(e as Error).message}` };
  }
}

const NEEDED_FUNCTIONS = [
  "admin.officer_holds",
  "admin.duty_roles",
  "property.request_duty",
  "property.create_property",
  "offering.request_duty",
  "offering.create_offering",
  "kyc.register_subject",
];

/** Read-only: the portal roles accepted for a role key. */
async function acceptedRoles(pool: pg.Pool, k: RoleKey): Promise<string[]> {
  const d: RoleDef = def(k);
  if (d.schema === "offering" && d.duty === "offering") return ["ops_maker", "ops_checker"];
  const { rows } = await pool.query<{ r: string[] }>("SELECT admin.duty_roles($1) AS r", [d.duty]);
  return rows[0]?.r ?? [];
}

/** Read-only check of every officer and duty the seed needs; returns problems and the enrolment plan. */
async function precheck(pool: pg.Pool, h: Handles): Promise<{ problems: string[]; plan: string[] }> {
  const problems: string[] = [];
  const plan: string[] = [];
  const { rows: fns } = await pool.query<{ f: string }>(
    "SELECT DISTINCT n.nspname || '.' || p.proname AS f FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname || '.' || p.proname = ANY ($1)",
    [NEEDED_FUNCTIONS],
  );
  const missing = NEEDED_FUNCTIONS.filter((f) => !fns.some((r) => r.f === f));
  if (missing.length) return { problems: [`the database lacks ${missing.join(", ")} (migrate first: npm run migrate)`], plan };

  // Officers: per handle, every role key it serves must accept one of its active roles.
  const byHandle = new Map<string, RoleKey[]>();
  for (const k of ROLE_KEYS) byHandle.set(handle(h, k), [...(byHandle.get(handle(h, k)) ?? []), k]);
  for (const [hd, keys] of byHandle) {
    const o = await pool
      .query<{ status: string; roles: string[] }>(
        `SELECT o.status, coalesce(array_agg(g.role ORDER BY g.role) FILTER (WHERE g.role IS NOT NULL), '{}') AS roles
         FROM admin.officers o LEFT JOIN admin.role_grants g ON g.officer_id = o.id AND g.revoked_at IS NULL
         WHERE o.handle = $1 GROUP BY o.status`,
        [hd],
      )
      .then((r) => r.rows[0]);
    const needs: string[] = [];
    for (const k of keys) {
      const roles = await acceptedRoles(pool, k);
      const { rows } = await pool.query<{ ok: boolean }>("SELECT admin.officer_holds($1, $2::text[], true) AS ok", [hd, roles]);
      if (!rows[0]?.ok) needs.push(`${k} needs one of ${roles.join(" | ")}`);
    }
    if (needs.length === 0) continue;
    const what = keys.map((k) => def(k).what).join("; ");
    const suggest = def(keys[0] ?? "onboardingMaker").suggest;
    if (!o) {
      problems.push(`officer ${hd} does not exist`);
      plan.push(`enrol ${hd} with role ${suggest} (${what})`);
    } else if (o.status !== "active") {
      problems.push(`officer ${hd} is ${o.status}, not active (${needs.join("; ")})`);
      plan.push(o.status === "invited" ? `finish the enrolment of ${hd} (security key) - role ${suggest}` : `re-enable ${hd} or name another officer in DEMO_CATALOG_OFFICERS`);
    } else {
      problems.push(`officer ${hd} holds [${o.roles.join(", ")}]: ${needs.join("; ")}`);
      plan.push(`grant ${hd} the role ${suggest}, or name another officer in DEMO_CATALOG_OFFICERS (${what})`);
    }
  }

  // Grantors are operator names, never portal officers (officer names belong to portal sessions).
  for (const g of ["grantorA", "grantorB"] as const) {
    const { rows } = await pool.query<{ x: boolean }>("SELECT EXISTS (SELECT 1 FROM admin.officers WHERE handle = $1) AS x", [handle(h, g)]);
    if (rows[0]?.x) problems.push(`${g} (${handle(h, g)}) is a portal officer: duties are granted under an operator name, not an officer's`);
  }

  // Duties that already exist in a conflicting combination (the database would refuse a new one).
  for (const k of ROLE_KEYS) {
    const d: RoleDef = def(k);
    const table = d.schema === "property" ? "property.staff_duties" : "offering.duties";
    const { rows } = await pool.query<{ duty: string }>(`SELECT duty FROM ${table} WHERE actor = $1 AND status IN ('pending', 'active') AND duty <> $2`, [handle(h, k), d.duty]);
    for (const r of rows) {
      const clash = (r.duty === "trustee") !== (d.duty === "trustee") || (d.schema === "property" && ["ic_member", "ic_independent"].includes(r.duty) && ["ic_member", "ic_independent"].includes(d.duty));
      if (clash) problems.push(`${handle(h, k)} already holds the ${d.schema} duty ${r.duty}, which conflicts with ${d.duty} (${k})`);
    }
  }
  return { problems, plan };
}

// ------------------------------------------------------------------ duties and the valuer panel
async function ensureDuty(c: Ctx, k: RoleKey): Promise<boolean> {
  const d: RoleDef = def(k);
  const table = d.schema === "property" ? "property.staff_duties" : "offering.duties";
  const row = await c.one<{ id: string; status: string; requested_by: string }>(
    `SELECT id::text, status, requested_by FROM ${table} WHERE actor = $1 AND duty = $2 AND status IN ('pending', 'active')`,
    [handle(c.h, k), d.duty],
  );
  if (row?.status === "active") return false;
  const reason = `demo catalog: ${d.what}`.slice(0, 500);
  const actor = handle(c.h, k);
  const maker = row?.requested_by ?? c.h.grantorA;
  const checker = maker === c.h.grantorB ? c.h.grantorA : c.h.grantorB;
  const approval = { by: checker, approve: true, reason: "demo catalog: officer is enrolled in PT Control with a matching role" };
  if (d.schema === "property") {
    const dutyId = row?.id ?? String(await runProperty(c.pool, "requestDuty", { actor, duty: d.duty as PropertyInput<"requestDuty">["duty"], by: maker, reason }));
    await runProperty(c.pool, "decideDuty", { dutyId, ...approval });
  } else {
    const dutyId = row?.id ?? String(await runOffering(c.pool, "requestDuty", { actor, duty: d.duty as OfferingInput<"requestDuty">["duty"], by: maker, reason }));
    await runOffering(c.pool, "decideDuty", { dutyId, ...approval });
  }
  return true;
}

async function ensureValuers(c: Ctx): Promise<[string, string]> {
  const ids: string[] = [];
  for (const licence of VALUER_LICENCES) {
    let v = await c.one<{ id: string; added_by: string; approved_by: string | null }>(
      "SELECT id::text, added_by, approved_by FROM property.valuers WHERE licence_no = property.norm($1)",
      [licence],
    );
    if (!v) {
      const id = await c.p("addValuer", { licence, panel: "pba", actor: c.h.grantorA });
      v = { id: id.toString(), added_by: c.h.grantorA, approved_by: null };
    }
    if (!v.approved_by) await c.p("approveValuer", { valuerId: v.id, actor: v.added_by === c.h.grantorB ? c.h.grantorA : c.h.grantorB });
    ids.push(v.id);
  }
  return [ids[0] ?? "", ids[1] ?? ""];
}

// ------------------------------------------------------------------ sponsor (KYB)
async function ensurePerson(c: Ctx, person: { cnic: string; name: string; session: string }): Promise<string> {
  const hashes = c.peppers.hashAll("cnic", normalizeCnic(person.cnic)).map((x) => x.hash);
  const existing = await findSubject(c.pool, hashes);
  if (existing && (await statusOf(c.pool, existing))?.status === "verified") return existing;
  const r = await c.kyc.onboard({ cnic: person.cnic, fullName: person.name, livenessSessionId: person.session });
  c.writes++;
  if (r.status !== "verified") throw new Error(`KYC of the sponsor's person ended ${r.status} (${r.reason})`);
  return r.subjectId;
}

interface SponsorRef {
  sponsorId: string;
  repId: string;
}

async function ensureSponsor(c: Ctx): Promise<SponsorRef> {
  const s = SPONSOR;
  let sponsorId = await c.svc.findSponsor("cuin", s.cuin);
  if (!sponsorId) {
    sponsorId = await c.svc.createSponsor({ kind: "company", legalName: s.legalName, address: s.address, cuin: s.cuin, ntn: s.ntn, actor: c.h.onboardingMaker });
    c.writes++;
  }
  const persons = async (): Promise<{ id: string; subject_id: string; role: string }[]> =>
    (await c.pool.query<{ id: string; subject_id: string; role: string }>("SELECT id::text, subject_id, role FROM property.sponsor_persons WHERE sponsor_id = $1 AND ended_at IS NULL", [sponsorId])).rows;
  let state = await sponsorState(c.pool, sponsorId);
  let people = await persons();
  if (state === "kyb_draft") {
    const rep = await ensurePerson(c, s.representative);
    const owner = await ensurePerson(c, s.owner);
    const has = (subject: string, role: string): boolean => people.some((p) => p.subject_id === subject && p.role === role);
    if (!has(rep, "representative")) await c.p("addPerson", { sponsorId, subjectId: rep, role: "representative", powers: ["submit", "upload", "respond", "withdraw"], actor: c.h.onboardingMaker });
    if (!has(rep, "director")) await c.p("addPerson", { sponsorId, subjectId: rep, role: "director", actor: c.h.onboardingMaker });
    if (!has(owner, "beneficial_owner")) {
      await c.p("addPerson", { sponsorId, subjectId: owner, role: "beneficial_owner", ownershipBp: 10_000, control: "shares", chainDepth: 1, actor: c.h.onboardingMaker });
    }
    people = await persons();
  }
  const repId = people.find((p) => p.role === "representative")?.id;
  if (!repId) throw new Error("the demo sponsor has no representative");
  if (state === "kyb_draft") {
    for (const [docType, file] of s.docs) await addDoc(c, { sponsorId, propertyId: null, docType, file, actor: c.h.onboardingMaker, actingFor: repId });
    await c.p("submitKyb", { sponsorId, actor: c.h.onboardingMaker, actingFor: repId });
    state = await sponsorState(c.pool, sponsorId);
  }
  if (state === "kyb_submitted") {
    await c.p("screenKyb", { sponsorId, actor: c.h.onboardingChecker, accept: true });
    state = await sponsorState(c.pool, sponsorId);
  }
  if (state === "kyb_review") {
    const exists = async (table: string): Promise<boolean> => Boolean(await c.one(`SELECT 1 FROM property.${table} WHERE sponsor_id = $1 LIMIT 1`, [sponsorId]));
    if (!(await exists("registration_checks"))) {
      await c.p("recordRegistrationCheck", { sponsorId, method: "secp_eservices", outcome: "verified", evidence: evidence("sponsor", "SECP eServices registration check"), actor: c.h.onboardingChecker });
    }
    if (!(await exists("sponsor_screenings"))) {
      await c.p("recordScreening", { sponsorId, provider: "mock-screen", listVersion: "demo-2026-10", outcome: "clear", evidence: evidence("sponsor", "company sanctions screening"), actor: c.h.complianceMaker });
    }
    if (!(await exists("risk_ratings"))) {
      await c.p("recordRisk", { sponsorId, rating: "low", reasons: "demo sponsor: simple ownership, one beneficial owner, clear screening", actor: c.h.complianceMaker });
    }
    const open = await c.one<{ id: string; requested_by: string }>(
      "SELECT id::text, requested_by FROM property.requests WHERE entity = 'sponsor' AND entity_id = $1 AND code = 'K4' AND status = 'open' AND expires_at > now() ORDER BY id DESC LIMIT 1",
      [sponsorId],
    );
    const requestId = open?.id ?? String(await c.p("requestTransition", { entity: "sponsor", id: sponsorId, code: "K4", officer: c.h.complianceMaker, reason: "demo catalog: all KYB checks complete and clear" }));
    const checker = open?.requested_by === c.h.complianceChecker ? c.h.complianceMaker : c.h.complianceChecker;
    throw new Waiting([
      `K4 KYB approval of the demo sponsor (request #${requestId}): ${checker} decides it in PT Control, Approvals > Property & KYB (/approvals/property/${requestId}), with a security-key step-up`,
    ]);
  }
  if (state !== "kyb_approved") throw new Error(`the demo sponsor is ${state ?? "unknown"}, not kyb_approved`);
  return { sponsorId, repId };
}

async function addDoc(c: Ctx, d: { sponsorId: string; propertyId: string | null; docType: string; file: string; actor: string; actingFor?: string }): Promise<string> {
  const f = c.file(d.file);
  // Same bytes are recorded once (OB-12): the database returns the existing document.
  const known = await c.one<{ id: string }>(
    "SELECT id FROM property.documents WHERE sponsor_id = $1 AND property_id IS NOT DISTINCT FROM $2 AND sha256 = decode($3, 'hex')",
    [d.sponsorId, d.propertyId, f.sha256],
  );
  if (known) return known.id;
  return c.p("addDocument", {
    sponsorId: d.sponsorId,
    propertyId: d.propertyId,
    docType: d.docType,
    sha256: f.sha256,
    sizeBytes: f.bytes.length,
    mediaType: "application/pdf",
    storeRef: `demo://catalog/${d.file}`,
    actor: d.actor,
    actingFor: d.actingFor ?? null,
  });
}

// ------------------------------------------------------------------ property (S-01)
async function propertyRow(c: Ctx, p: DemoProperty): Promise<{ id: string; state: string; sponsor_id: string } | undefined> {
  return c.one<{ id: string; state: string; sponsor_id: string }>(
    "SELECT id, state, sponsor_id FROM property.properties WHERE building = $1 AND deed_no = $2 ORDER BY created_at DESC LIMIT 1",
    [p.identifiers.building, p.identifiers.deed_no],
  );
}

async function dueDiligence(c: Ctx, p: DemoProperty, propertyId: string, sponsorId: string): Promise<void> {
  const doc = (docType: string, file: string, actor: string): Promise<string> => addDoc(c, { sponsorId, propertyId, docType, file, actor });
  const title = await doc("title_deed", `${p.slug}-title-deed.pdf`, c.h.legalReviewer);
  const fard = await doc("land_record_extract", `${p.slug}-land-record-extract.pdf`, c.h.legalReviewer);
  const office = p.identifiers.sub_registrar ?? "Sub-Registrar (demo)";
  for (const d of [title, fard]) {
    if (!(await c.one("SELECT 1 FROM property.document_verifications WHERE document_id = $1 AND outcome = 'verified'", [d]))) {
      await c.p("verifyDocument", { documentId: d, actor: c.h.legalReviewer, method: "in_person", office, verifiedOn: c.now().toISOString().slice(0, 10), outcome: "verified", evidence: evidence(p.slug, `registry verification ${d}`) });
    }
  }
  const links: [number, "allotment" | "sale_deed", string, string, string][] = [
    [1, "allotment", `ALLOT-${p.identifiers.plot_no ?? "DEMO"}`, "1995-01-01", fard],
    [2, "sale_deed", p.identifiers.deed_no, p.identifiers.deed_date ?? "2015-01-01", title],
  ];
  for (const [position, kind, instrumentRef, registeredOn, documentId] of links) {
    if (!(await c.one("SELECT 1 FROM property.title_links WHERE property_id = $1 AND position = $2", [propertyId, position]))) {
      await c.p("addTitleLink", { propertyId, actor: c.h.legalReviewer, position, kind, instrumentRef, registeredOn, documentId });
    }
  }
  const search = await doc("encumbrance_search", `${p.slug}-encumbrance-search.pdf`, c.h.legalReviewer);
  const opinion = await doc("legal_opinion", `${p.slug}-legal-opinion.pdf`, c.h.legalReviewer);
  const technical = await doc("technical_report", `${p.slug}-technical-report.pdf`, c.h.technicalReviewer);
  const reports = [
    await doc("valuation_report", `${p.slug}-valuation-report-1.pdf`, c.h.valuationReviewer),
    await doc("valuation_report", `${p.slug}-valuation-report-2.pdf`, c.h.valuationReviewer),
  ];
  const valuers = await ensureValuers(c);
  for (const [i, valuerId] of valuers.entries()) {
    const reportId = reports.at(i) ?? "";
    if (!(await c.one("SELECT 1 FROM property.valuations WHERE property_id = $1 AND valuer_id = $2 AND report_document_id = $3", [propertyId, valuerId, reportId]))) {
      await c.p("recordValuation", {
        propertyId,
        actor: c.h.valuationReviewer,
        valuerId,
        valuePaisa: p.valuations.at(i) ?? 0n,
        valuedOn: c.now().toISOString().slice(0, 10),
        reportId,
        independence: evidence(p.slug, `independence declaration of valuer ${String(i + 1)}`),
      });
    }
  }
  const status = await reviewStatus(c.pool, propertyId);
  const review = async (discipline: "title" | "encumbrance" | "valuation" | "legal_opinion" | "technical", reviewer: string, documents: string[]): Promise<void> => {
    const s = status.find((x) => x.discipline === discipline);
    if (s?.fresh && s.decision === "pass") return;
    await c.p("recordReview", {
      propertyId,
      reviewer,
      discipline,
      scope: `demo catalog: full ${discipline} review`,
      method: "documents of the demo file and source checks",
      findings: "no issues found in the (fictional) documents",
      decision: "pass",
      documents,
    });
  };
  await review("title", c.h.legalReviewer, [title, fard]);
  await review("encumbrance", c.h.legalReviewer, [search]);
  await review("legal_opinion", c.h.legalReviewer, [opinion]);
  await review("technical", c.h.technicalReviewer, [technical]);
  await review("valuation", c.h.valuationReviewer, reports);
}

async function committee(c: Ctx, p: DemoProperty, propertyId: string): Promise<void> {
  const latest = await c.one<{ id: string; status: string; chair: string }>(
    "SELECT id::text, status, chair FROM property.ic_meetings WHERE property_id = $1 ORDER BY id DESC LIMIT 1",
    [propertyId],
  );
  if (latest?.status === "not_approved") {
    throw new Blocked(`the investment committee did not approve ${p.name} (meeting #${latest.id}); a new meeting is the committee's decision, not the seed's`);
  }
  // Opening the meeting is not a vote: the seed opens it for the chair (PT Control can open one as well).
  const meetingId = latest?.status === "open" ? latest.id : String(await c.p("openIc", { propertyId, chair: c.h.icChair }));
  const chair = latest?.status === "open" ? latest.chair : c.h.icChair;
  const page = `PT Control, Operations > Investment committee (/committees/${meetingId})`;
  const due: string[] = [];
  for (const member of [c.h.icChair, c.h.icMember, c.h.icIndependent]) {
    if (!(await c.one("SELECT 1 FROM property.ic_votes WHERE meeting_id = $1 AND member = $2", [meetingId, member]))) {
      due.push(`investment committee vote of ${member} on ${p.name} (meeting #${meetingId}): in ${page}, approve with a reason, ${STEP_UP}`);
    }
  }
  const minutes = minutesFile(p);
  due.push(
    `closing of meeting #${meetingId} by the chair ${chair}${due.length ? " after the votes" : ""}: in ${page}, with the minutes' SHA-256 ${c.file(minutes).sha256} (demo file ${minutes}), ${STEP_UP}`,
  );
  throw new Waiting(due);
}

async function structureAndTrustee(c: Ctx, p: DemoProperty, propertyId: string, sponsorId: string): Promise<void> {
  const deed = await addDoc(c, { sponsorId, propertyId, docType: "trust_deed", file: `${p.slug}-trust-deed.pdf`, actor: c.h.legalHead });
  const latest = await c.one<{ id: string; planned: string; deed: string; declined: boolean }>(
    `SELECT s.id::text, s.planned_units::text AS planned, s.trust_deed_document_id AS deed,
            EXISTS (SELECT 1 FROM property.trustee_decisions d WHERE d.structure_id = s.id) AS declined
     FROM property.structures s WHERE s.property_id = $1 ORDER BY s.id DESC LIMIT 1`,
    [propertyId],
  );
  if (latest?.declined) {
    throw new Blocked(`the trustee declined structure #${latest.id} of ${p.name}; a new structure is the legal head's decision, not the seed's`);
  }
  const structureId =
    latest && latest.planned === p.plannedUnits.toString() && latest.deed === deed
      ? latest.id
      : String(
          await c.p("recordStructure", {
            propertyId,
            actor: c.h.legalHead,
            kind: "spv",
            shariah: false,
            unitRights: { income: "pro rata net rent", exit: "pro rata sale proceeds", voting: "a sale needs 75 % of units", information: "quarterly reports" },
            plannedUnits: p.plannedUnits,
            trustDeedId: deed,
          }),
        );
  throw new Waiting([
    `trustee acceptance (P8) of ${p.name} (structure #${structureId}) by ${c.h.trustee}: in PT Control, Trustee > Property acceptance (/trustee/properties/${propertyId}), accept with a reason, ${STEP_UP}`,
  ]);
}

async function seedProperty(c: Ctx, p: DemoProperty): Promise<{ propertyId: string | null; state: string; blocked?: string }> {
  let row = await propertyRow(c, p);
  let sponsor: SponsorRef | undefined;
  const needSponsor = async (): Promise<SponsorRef> => (sponsor ??= await ensureSponsor(c));
  for (let guard = 0; guard < 10; guard++) {
    if (!row) {
      const s = await needSponsor();
      await c.p("createProperty", { sponsorId: s.sponsorId, actor: c.h.onboardingMaker, actingFor: s.repId, previousId: null, identifiers: p.identifiers });
    } else if (row.state === "draft") {
      const s = await needSponsor();
      if (s.sponsorId !== row.sponsor_id) return { propertyId: row.id, state: row.state, blocked: "the draft belongs to another sponsor" };
      for (const [docType, file] of p.draftDocs) await addDoc(c, { sponsorId: s.sponsorId, propertyId: row.id, docType, file, actor: c.h.onboardingMaker, actingFor: s.repId });
      const r = await c.p("submitProperty", { propertyId: row.id, actor: c.h.onboardingMaker, actingFor: s.repId });
      if (!r.submitted) return { propertyId: row.id, state: "draft", blocked: `submission ${r.outcome} (duplicate check ${String(r.checkId)})` };
    } else if (row.state === "submitted") {
      await c.p("startReview", { propertyId: row.id, officer: c.h.onboardingChecker, legal: c.h.legalReviewer, valuation: c.h.valuationReviewer, technical: c.h.technicalReviewer });
    } else if (row.state === "under_review") {
      await dueDiligence(c, p, row.id, row.sponsor_id);
      await committee(c, p, row.id);
    } else if (row.state === "legal_approved") {
      await structureAndTrustee(c, p, row.id, row.sponsor_id);
    } else if (row.state === "tokenization_ready") {
      return { propertyId: row.id, state: row.state };
    } else {
      return { propertyId: row.id, state: row.state, blocked: `the property file is ${row.state}` };
    }
    const next = await propertyRow(c, p);
    if (next && row && next.state === row.state) return { propertyId: next.id, state: next.state, blocked: `no progress from ${next.state}` };
    row = next;
  }
  return { propertyId: row?.id ?? null, state: row?.state ?? "unknown", blocked: "too many steps" };
}

// ------------------------------------------------------------------ offering (S-02)
function termsOf(c: Ctx, p: DemoProperty): Terms {
  const f = offeringFiles(p);
  const opens = new Date(Math.ceil(c.now().getTime() / 3_600_000) * 3_600_000 + 3 * 86_400_000);
  const closes = new Date(opens.getTime() + 30 * 86_400_000);
  return {
    pricePaisa: p.price,
    minRaiseUnits: p.cap,
    targetUnits: p.cap,
    hardCapUnits: p.cap,
    minUnits: p.minUnits,
    maxUnits: p.maxUnits,
    opensAt: opens.toISOString(),
    closesAt: closes.toISOString(),
    useOfProceeds: p.useOfProceeds,
    docEnSha: c.file(f.en).sha256,
    docUrSha: c.file(f.ur).sha256,
    riskSha: c.file(f.risk).sha256,
  };
}

async function offeringRow(c: Ctx, propertyId: string): Promise<{ id: string; state: string } | undefined> {
  return c.one<{ id: string; state: string }>("SELECT id, state FROM offering.offerings WHERE property_id = $1 AND state <> 'cancelled' ORDER BY created_at DESC LIMIT 1", [propertyId]);
}

async function seedOffering(c: Ctx, p: DemoProperty, propertyId: string): Promise<{ offeringId: string | null; state: string; note?: string }> {
  let row = await offeringRow(c, propertyId);
  let fresh = false;
  for (let guard = 0; guard < 8; guard++) {
    if (!row) {
      await c.o("createOffering", { propertyId, actor: c.h.offeringMaker, terms: termsOf(c, p) });
      fresh = true;
    } else if (row.state === "draft") {
      // A draft from an earlier run: refresh the dates (the close time must be in the future).
      if (!fresh) await c.o("updateTerms", { offeringId: row.id, actor: c.h.offeringMaker, terms: termsOf(c, p) });
      await c.o("submit", { offeringId: row.id, actor: c.h.offeringMaker, reason: "demo catalog: terms complete, documents attached" });
    } else if (row.state === "pending_approval") {
      const q = await c.one<{ id: string; requested_by: string; expired: boolean }>(
        "SELECT id::text, requested_by, expires_at < clock_timestamp() AS expired FROM offering.requests WHERE offering_id = $1 AND code = 'L3' AND status = 'open' ORDER BY id DESC LIMIT 1",
        [row.id],
      );
      if (!q || q.expired) {
        const last = q ?? (await c.one<{ id: string }>("SELECT id::text FROM offering.requests WHERE offering_id = $1 AND code = 'L3' ORDER BY id DESC LIMIT 1", [row.id]));
        throw new Waiting([
          `the L3 approval request of ${p.name} ${q ? `(#${q.id}) expired` : "is no longer open"}: an offering checker (not ${c.h.offeringMaker}) returns the offering to draft in PT Control, Operations > Offering approvals${last ? ` (/approvals/offering/${last.id}, "Return to draft")` : ""}, ${STEP_UP}; the next run submits it again`,
        ]);
      }
      const due: string[] = [];
      for (const k of ["offeringChecker", "offeringLegalHead", "offeringCompliance", "offeringTrustee"] as const) {
        if (!(await c.one("SELECT 1 FROM offering.request_votes WHERE request_id = $1 AND officer = $2", [q.id, handle(c.h, k)]))) {
          due.push(
            k === "offeringTrustee"
              ? `L3 vote of the trustee ${handle(c.h, k)} on request #${q.id} (${p.name}): in PT Control, Trustee > Co-signing (/trustee/cosign/offering/${q.id}), ${STEP_UP}`
              : `L3 vote of ${handle(c.h, k)} (${def(k).what}) on request #${q.id} (${p.name}): in PT Control, Operations > Offering approvals (/approvals/offering/${q.id}), ${STEP_UP}`,
          );
        }
      }
      if (due.length) throw new Waiting(due);
    } else if (row.state === "approved" && c.token) {
      try {
        await runOffering(c.pool, "markReady", { offeringId: row.id, token: c.token, actor: c.h.offeringMaker });
        c.writes++;
      } catch (e) {
        if (e instanceof OfferingError) return { offeringId: row.id, state: row.state, note: `mark_ready refused: ${e.message}` };
        throw e;
      }
      const t = await c.o("tick", { offeringId: row.id, actor: "system:offering-clock" });
      const now = await offeringRow(c, propertyId);
      return { offeringId: row.id, state: now?.state ?? String(t.state), note: "token recorded (L4)" };
    } else {
      return { offeringId: row.id, state: row.state };
    }
    const next = await offeringRow(c, propertyId);
    if (next && row && next.state === row.state && row.state !== "pending_approval") return { offeringId: next.id, state: next.state, note: `no progress from ${next.state}` };
    row = next;
  }
  return { offeringId: row?.id ?? null, state: row?.state ?? "unknown", note: "too many steps" };
}

// ------------------------------------------------------------------ entry point
export async function seedCatalog(pool: pg.Pool, options: SeedOptions = {}): Promise<SeedResult> {
  const env = options.env ?? {};
  const log = options.log ?? ((): void => undefined);
  if (env.NODE_ENV === "production") return { status: "refused", reason: "the demo catalog is refused when NODE_ENV=production" };
  const { rows: db } = await pool.query<{ name: string }>("SELECT current_database() AS name");
  const name = db[0]?.name ?? "";
  if (!ALLOWED_DATABASE.test(name)) return { status: "refused", reason: `database ${name} is not a local/demo database (property_token, property_token_test or pt_scratch_*)` };

  const { handles, problems } = demoEnv(env, options.officers);
  problems.push(...separationProblems(handles));
  let secrets = options.secrets;
  if (!secrets) {
    const s = loadSecrets(env);
    if (s.problem) problems.push(s.problem);
    secrets = s.secrets;
  }
  const check = await precheck(pool, handles);
  problems.push(...check.problems);
  if (problems.length || !secrets) return { status: "skipped", problems, plan: check.plan };

  // One seed at a time (session-level advisory lock on a dedicated connection; nothing is written by it).
  const lock = await pool.connect();
  try {
    const { rows } = await lock.query<{ ok: boolean }>("SELECT pg_try_advisory_lock(586586700) AS ok");
    if (!rows[0]?.ok) return { status: "skipped", problems: ["another seed:catalog run is in progress"], plan: [] };
    const c = new Ctx(
      pool,
      handles,
      new PropertyService(pool, secrets.sponsor),
      new KycService(pool, mockProviders(), secrets.kycPeppers, secrets.kycDataKey, "kyc-service"),
      secrets.kycPeppers,
      options.demoDir ?? DEMO_DIR,
      options.now ?? ((): Date => new Date()),
      options.token,
      log,
    );
    let dutiesGranted = 0;
    for (const k of ROLE_KEYS) if (await ensureDuty(c, k)) dutiesGranted++;
    if (dutiesGranted) log(`duties: ${String(dutiesGranted)} granted (maker ${handles.grantorA}, checker ${handles.grantorB})`);

    const properties: PropertyOutcome[] = [];
    for (const p of DEMO_PROPERTIES) {
      c.writes = 0;
      const existed = Boolean(await propertyRow(c, p));
      let out: PropertyOutcome;
      try {
        const pr = await seedProperty(c, p);
        let off: { offeringId: string | null; state: string; note?: string } = { offeringId: null, state: "none" };
        if (!pr.blocked && pr.propertyId) off = await seedOffering(c, p, pr.propertyId);
        const finalState = off.offeringId ? off.state : pr.state;
        const kind: PropertyOutcome["outcome"] = pr.blocked ? "blocked" : !existed ? "created" : c.writes ? "resumed" : "already";
        const text =
          kind === "blocked" ? `blocked: ${pr.blocked ?? ""}` : kind === "created" ? `created (property ${pr.state}, offering ${off.state})` : kind === "resumed" ? `resumed to ${finalState}` : `already ${finalState}`;
        out = {
          slug: p.slug,
          name: p.name,
          outcome: kind,
          votes: [],
          propertyId: pr.propertyId,
          offeringId: off.offeringId,
          propertyState: pr.state,
          offeringState: off.offeringId ? off.state : null,
          writes: c.writes,
          line: `${p.name}: ${text}${off.note ? ` - ${off.note}` : ""}`,
        };
      } catch (e) {
        const row = await propertyRow(c, p);
        if (e instanceof Waiting) {
          const off = row ? await offeringRow(c, row.id) : undefined;
          out = {
            slug: p.slug,
            name: p.name,
            outcome: "waiting",
            votes: e.votes,
            propertyId: row?.id ?? null,
            offeringId: off?.id ?? null,
            propertyState: row?.state ?? null,
            offeringState: off?.state ?? null,
            writes: c.writes,
            line: `${p.name}: waiting at ${off ? `offering ${off.state}` : (row?.state ?? "the sponsor's KYB")} for ${String(e.votes.length)} officer vote(s) in PT Control`,
          };
          log(out.line);
          for (const v of e.votes) log(`  - ${v}`);
          properties.push(out);
          continue;
        }
        if (e instanceof Blocked) {
          const off = row ? await offeringRow(c, row.id) : undefined;
          out = {
            slug: p.slug,
            name: p.name,
            outcome: "blocked",
            votes: [],
            propertyId: row?.id ?? null,
            offeringId: off?.id ?? null,
            propertyState: row?.state ?? null,
            offeringState: off?.state ?? null,
            writes: c.writes,
            line: `${p.name}: blocked: ${e.message}`,
          };
          log(out.line);
          properties.push(out);
          continue;
        }
        out = {
          slug: p.slug,
          name: p.name,
          outcome: "failed",
          votes: [],
          propertyId: row?.id ?? null,
          offeringId: null,
          propertyState: row?.state ?? null,
          offeringState: null,
          writes: c.writes,
          line: `${p.name}: failed at ${row?.state ?? "start"}: ${(e as Error).message}`,
        };
      }
      log(out.line);
      properties.push(out);
    }
    return { status: "done", dutiesGranted, properties };
  } finally {
    await lock.query("SELECT pg_advisory_unlock(586586700)").catch(() => undefined);
    lock.release();
  }
}

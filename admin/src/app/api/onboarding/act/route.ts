import type { NextRequest } from "next/server";
import { complianceRoute, ID, UUID, type Form } from "@/lib/server/compliance-route";
import { ID_FIELDS } from "@/lib/server/onboarding";

/**
 * Onboarding desk (migration 0049 PO-1): one S-01 maker action per post, as the officer's bound
 * handle (admin.property_act). The fields of each action are checked for shape here; the S-01
 * duty, state and maker-checker rules are applied by the database, which explains a refusal.
 */
type Kind = "uuid" | "id" | "text" | "hex" | "bool" | "date" | "int" | "digits" | "rupees" | "list" | "lines" | "ids" | "rights";

const SPONSOR = { sponsor: "uuid" } as const;
const PROPERTY = { property: "uuid" } as const;
const SPEC: Readonly<Record<string, Readonly<Record<string, Kind>>>> = {
  add_person: { ...SPONSOR, subject: "uuid", role: "text", ownershipBp: "int", control: "text", chainDepth: "int", powers: "list" },
  end_person: { ...SPONSOR, person: "id", reason: "text" },
  registration_check: { ...SPONSOR, method: "text", outcome: "text", evidence: "hex" },
  screening: { ...SPONSOR, provider: "text", listVersion: "text", outcome: "text", evidence: "hex" },
  risk: { ...SPONSOR, rating: "text", reasons: "text", edd: "hex" },
  fmu: { ...SPONSOR, outcome: "text", evidence: "hex" },
  submit_kyb: { ...SPONSOR, actingFor: "id" },
  screen_kyb: { ...SPONSOR, accept: "bool", reason: "text" },
  query_kyb: { ...SPONSOR, reason: "text" },
  suspend_sponsor: { ...SPONSOR, reason: "text" },
  create_property: { ...SPONSOR, actingFor: "id", ids: "ids" },
  update_property: { ...PROPERTY, actingFor: "id", ids: "ids" },
  submit_property: { ...PROPERTY, actingFor: "id" },
  withdraw_property: { ...PROPERTY, actingFor: "id", reason: "text" },
  return_property: { ...PROPERTY, reason: "text" },
  decide_duplicate: { candidate: "id", capacity: "text", decision: "text", reason: "text" },
  start_review: { ...PROPERTY, legal: "text", valuation: "text", technical: "text" },
  reassign_reviewer: { ...PROPERTY, group: "text", reviewer: "text" },
  query_property: { ...PROPERTY, reason: "text" },
  hold_property: { ...PROPERTY, reason: "text" },
  reopen: { ...PROPERTY, disciplines: "list", reason: "text" },
  add_document: { ...SPONSOR, property: "uuid", type: "text", sha256: "hex", actingFor: "id", supersedes: "uuid" },
  verify_document: { document: "uuid", method: "text", office: "text", on: "date", outcome: "text", evidence: "hex" },
  add_title_link: { ...PROPERTY, position: "int", kind: "text", ref: "text", on: "date", document: "uuid" },
  record_encumbrance: { ...PROPERTY, kind: "text", description: "text", evidence: "hex" },
  resolve_encumbrance: { encumbrance: "id", resolution: "text", note: "text", evidence: "hex" },
  record_valuation: { ...PROPERTY, valuer: "id", valuePaisa: "rupees", on: "date", report: "uuid", independence: "hex" },
  record_review: { ...PROPERTY, discipline: "text", scope: "text", method: "text", findings: "text", conditions: "lines", decision: "text", documents: "list" },
  record_structure: { ...PROPERTY, kind: "text", shariah: "bool", rights: "rights", plannedUnits: "digits", trustDeed: "uuid" },
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const HEX64 = /^[0-9a-f]{64}$/;

function field(form: Form, key: string): string | null {
  const v = form?.get(key);
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t.slice(0, 2000);
}

/** The value of one field, or an error message; undefined leaves the argument out. */
function value(form: Form, key: string, kind: Kind): unknown {
  if (kind === "ids") {
    const ids = new Map<string, string | boolean>();
    for (const k of ID_FIELDS) {
      const v = field(form, `id.${k}`);
      if (v) ids.set(k, v);
    }
    const built = field(form, "id.built");
    if (built === "yes" || built === "no") ids.set("built", built === "yes");
    return Object.fromEntries(ids);
  }
  if (kind === "rights") {
    const r = { income: field(form, "rights.income"), exit: field(form, "rights.exit"), voting: field(form, "rights.voting"), information: field(form, "rights.information") };
    return Object.values(r).every((x) => x) ? r : new Error("Describe all four unit rights.");
  }
  // A list may come from several checkboxes of the same name or from one text field.
  const v = kind === "list" ? form?.getAll(key).filter((x): x is string => typeof x === "string").join(",").trim() || null : field(form, key);
  if (v === null) return undefined;
  switch (kind) {
    case "uuid":
      return UUID.test(v) ? v : new Error(`${key}: not a valid id.`);
    case "id":
      return ID.test(v) ? v : new Error(`${key}: not a valid number.`);
    case "hex": {
      const h = v.toLowerCase().replace(/^0x/, "");
      return HEX64.test(h) ? h : new Error(`${key}: a SHA-256 of 64 hex characters is required.`);
    }
    case "bool":
      return v === "yes" ? true : v === "no" ? false : new Error(`${key}: choose yes or no.`);
    case "date":
      return DATE.test(v) ? v : new Error(`${key}: a date is required.`);
    case "int":
      return /^\d{1,6}$/.test(v) ? Number(v) : new Error(`${key}: a whole number is required.`);
    case "digits":
      return /^\d{1,30}$/.test(v) ? v : new Error(`${key}: a whole number is required.`);
    case "rupees":
      return /^\d{1,13}$/.test(v.replace(/,/g, "")) ? `${v.replace(/,/g, "")}00` : new Error("Value: whole rupees, at most 13 digits.");
    case "list":
      return v
        .split(/[\s,]+/)
        .map((x) => x.trim())
        .filter(Boolean)
        .slice(0, 200);
    case "lines":
      return v
        .split(/\r?\n/)
        .map((x) => x.trim())
        .filter(Boolean)
        .slice(0, 50);
    default:
      return v;
  }
}

/** Only back to the onboarding pages. */
function backPath(form: Form): string {
  const b = field(form, "back");
  return b && /^\/onboarding\/(sponsor|property)\/[0-9a-f-]{36}$/.test(b) ? b : "/onboarding";
}

export async function POST(request: NextRequest) {
  let back = "/onboarding";
  return complianceRoute(request, {
    permission: "property.read",
    back: (form) => (back = backPath(form)),
    build: (o, form) => {
      const action = field(form, "action");
      const spec = action ? new Map(Object.entries(SPEC)).get(action) : undefined;
      if (!action || !spec) return "Choose an onboarding action.";
      const args = new Map<string, unknown>();
      for (const [key, kind] of Object.entries(spec)) {
        const v = value(form, key, kind);
        if (v instanceof Error) return v.message;
        if (v !== undefined) args.set(key, v);
      }
      return { sql: "SELECT admin.property_act($1, $2, $3::jsonb) AS r", params: [o.sessionHash, action, JSON.stringify(Object.fromEntries(args))] };
    },
    okPath: (r) => (back === "/onboarding" && typeof r.result === "string" && UUID.test(r.result) ? `/onboarding/property/${r.result}` : back),
    okMessage: (r) => `Done${typeof r.result === "string" || typeof r.result === "number" || typeof r.result === "boolean" ? `: ${String(r.result)}` : ""}.`,
  });
}

import type { NextRequest } from "next/server";
import { complianceRoute, text, UUID } from "@/lib/server/compliance-route";

/**
 * Maker: ask for an S-01 maker-checker decision (admin.request_property_transition, migration 0045):
 * KYB approval or rejection, reinstatement, a property rejection or the outcome of a hold. The
 * database applies the duty rules; a different officer decides.
 */
const CODES = new Set(["K4", "K5", "K10", "K11", "P6", "P13", "P14"]);
const HEX64 = /^[0-9a-f]{64}$/;

export async function POST(request: NextRequest) {
  return complianceRoute(request, {
    permission: "property.read",
    back: "/approvals/property",
    build: (o, form) => {
      const target = form?.get("target");
      const code = form?.get("code");
      const reason = text(form, "reason", 500);
      if (typeof target !== "string" || !/^(sponsor|property):/.test(target)) return "Choose a file.";
      const [entity = "", id = ""] = target.split(":");
      if (!UUID.test(id)) return "Choose a file.";
      if (typeof code !== "string" || !CODES.has(code)) return "Choose a decision to ask for.";
      if (!reason || reason.length < 10) return "Give a reason of at least 10 characters.";
      const detail: Record<string, string | boolean> = {};
      const discipline = text(form, "discipline", 40);
      const evidence = form?.get("evidence");
      if (discipline) detail.discipline = discipline;
      if (typeof evidence === "string" && HEX64.test(evidence)) detail.evidence = evidence;
      if (code === "P6" || code === "P14") detail.curable = form?.get("curable") === "yes";
      return { sql: "SELECT admin.request_property_transition($1, $2, $3, $4, $5, $6::jsonb) AS r", params: [o.sessionHash, entity, id, code, reason, JSON.stringify(detail)] };
    },
    okMessage: (r) => `Request #${String(r.id ?? "")} is open: a different officer with the required duty decides it.`,
  });
}

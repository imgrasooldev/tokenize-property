import type { NextRequest } from "next/server";
import { complianceRoute } from "@/lib/server/compliance-route";

/**
 * Maker: propose new values for an existing signing policy (admin.propose_signer_policy, migration
 * 0039): same fields as the active version only; a different checker activates it.
 */
export async function POST(request: NextRequest) {
  return complianceRoute(request, {
    permission: "operations.request",
    back: "/operations/policies",
    build: (o, form) => {
      const kind = form?.get("kind");
      const raw = form?.get("rule");
      // The database checks the kind exactly (an existing kind with an active policy).
      if (typeof kind !== "string" || kind.length > 64 || !/^[a-z][a-z0-9_.]*$/.test(kind)) return "Choose a kind.";
      if (typeof raw !== "string" || raw.length > 8192) return "The rule must be a JSON object of at most 8 KB.";
      let rule: unknown;
      try {
        rule = JSON.parse(raw);
      } catch {
        return "The rule is not valid JSON.";
      }
      if (rule === null || typeof rule !== "object" || Array.isArray(rule)) return "The rule must be a JSON object.";
      return { sql: "SELECT admin.propose_signer_policy($1, $2, $3::jsonb) AS r", params: [o.sessionHash, kind, JSON.stringify(rule)] };
    },
    okMessage: (r) => `Policy proposal #${String(r.id ?? "")} recorded: a different operations checker activates it.`,
  });
}

import type { NextRequest } from "next/server";
import { complianceRoute, text } from "@/lib/server/compliance-route";

/**
 * Monitoring thresholds (migration 0051 TM-1): a compliance officer replaces a rule's placeholder
 * thresholds or switches the rule (step-up, audited in both chains). The database checks every
 * parameter's range again.
 */
export async function POST(request: NextRequest) {
  return complianceRoute(request, {
    permission: "compliance.decide",
    back: "/compliance/monitoring",
    build: (o, form) => {
      const rule = text(form, "rule", 40);
      const reason = text(form, "reason", 500);
      if (!rule || !/^[a-z_]{3,40}$/.test(rule)) return "Choose a rule.";
      if (!reason || reason.length < 10) return "Give a reason of at least 10 characters.";
      const params = new Map<string, number>();
      for (const [key, value] of form?.entries() ?? []) {
        if (!key.startsWith("p.") || typeof value !== "string") continue;
        const name = key.slice(2);
        if (!/^[a-zA-Z]{2,30}$/.test(name) || !/^\d{1,15}$/.test(value.trim())) return "Every threshold is a whole number.";
        params.set(name, Number(value.trim()));
      }
      if (params.size === 0) return "Give the thresholds.";
      const enabled = form?.get("enabled") === "yes";
      return { sql: "SELECT admin.tm_rule_set($1, $2, $3::jsonb, $4, $5) AS r", params: [o.sessionHash, rule, JSON.stringify(Object.fromEntries(params)), enabled, reason] };
    },
    okMessage: () => "Rule saved. Check every investor now to apply it to past payments.",
  });
}

import type { NextRequest } from "next/server";
import { complianceRoute, text } from "@/lib/server/compliance-route";

/**
 * goAML values (migration 0050 GA-4): a compliance officer replaces a placeholder setting or an STR
 * indicator code with the value the FMU confirmed (step-up, audited in both chains).
 */
export async function POST(request: NextRequest) {
  return complianceRoute(request, {
    permission: "compliance.decide",
    back: "/compliance/str",
    build: (o, form) => {
      const target = text(form, "target", 60);
      const value = text(form, "value", 200);
      const reason = text(form, "reason", 500);
      if (!target || !/^(setting|indicator):[a-z_]{2,40}$/.test(target)) return "Choose a value to change.";
      if (!value) return "Give the new value.";
      if (!reason || reason.length < 10) return "Give a reason of at least 10 characters.";
      const [kind = "", key = ""] = target.split(":");
      return { sql: "SELECT admin.goaml_set($1, $2, $3, $4, $5) AS r", params: [o.sessionHash, kind, key, value, reason] };
    },
    okMessage: () => "goAML value saved.",
  });
}

import type { NextRequest } from "next/server";
import { complianceRoute, HEX32, ID, text, UUID } from "@/lib/server/compliance-route";

/**
 * The trustee's P8 decision on a Legal Approved property (admin.decide_property_trustee ->
 * property.trustee_decide under the officer's handle): accept or decline the latest structure with a
 * reason and optional conditions, bound to the digest of what was shown; a structure is decided once.
 */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const valid = UUID.test(id);
  return complianceRoute(request, {
    permission: "trustee.decide",
    back: valid ? `/trustee/properties/${id}` : "/trustee/properties",
    build: (o, form) => {
      if (!valid) return "Unknown property.";
      const choice = form?.get("decision");
      const reason = text(form, "reason", 500);
      const conditions = text(form, "conditions", 1000);
      const digest = form?.get("digest");
      const structure = form?.get("structure");
      if (choice !== "accept" && choice !== "decline") return "Choose accept or decline.";
      if (!reason || reason.length < 10) return "Give a reason of at least 10 characters.";
      if (conditions !== null && conditions.length < 10) return "Conditions are at least 10 characters (or leave them empty).";
      if (typeof structure !== "string" || !ID.test(structure)) return "There is no structure to decide on.";
      if (typeof digest !== "string" || !HEX32.test(digest)) return "What you reviewed is missing: reload the page.";
      return {
        sql: "SELECT admin.decide_property_trustee($1, $2, $3, $4, $5, $6, $7) AS r",
        params: [o.sessionHash, id, structure, choice, conditions, reason, Buffer.from(digest, "hex")],
      };
    },
    okMessage: (r) => (r.status === "tokenization_ready" ? "Accepted: the property is Tokenization Ready." : "Declined: the legal head records a new structure decision if the file continues."),
  });
}

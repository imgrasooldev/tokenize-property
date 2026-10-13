import type { NextRequest } from "next/server";
import { complianceRoute, ID, text } from "@/lib/server/compliance-route";

/** Adds an append-only note to an STR case (admin.add_str_note). */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const valid = ID.test(id);
  return complianceRoute(request, {
    permission: "compliance.decide",
    back: valid ? `/compliance/str/${id}` : "/compliance/str",
    build: (o, form) => {
      if (!valid) return "Unknown case.";
      const body = text(form, "body", 2000);
      if (!body || body.length < 2) return "Write the note first.";
      return { sql: "SELECT admin.add_str_note($1, $2, $3) AS r", params: [o.sessionHash, id, body] };
    },
    okMessage: () => "Note added (notes are never edited or deleted).",
  });
}

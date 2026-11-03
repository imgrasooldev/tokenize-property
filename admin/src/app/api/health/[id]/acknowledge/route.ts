import type { NextRequest } from "next/server";
import { complianceRoute, ID, text } from "@/lib/server/compliance-route";

/** Acknowledges one open alert with a note (migration 0052, ops.acknowledge; audited). */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const valid = ID.test(id);
  return complianceRoute(request, {
    permission: "ops.acknowledge",
    back: "/health",
    build: (o, form) => {
      if (!valid) return "Unknown alert.";
      const note = text(form, "note", 300);
      if (!note || note.length < 5) return "Give a note of at least 5 characters.";
      return { sql: "SELECT admin.health_acknowledge($1, $2, $3) AS r", params: [o.sessionHash, id, note] };
    },
    okMessage: () => "Alert acknowledged.",
  });
}

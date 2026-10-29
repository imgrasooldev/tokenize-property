import type { NextRequest } from "next/server";
import { complianceRoute, ID } from "@/lib/server/compliance-route";

/** Maker: record a rent invoice as paid by one bank line (proposes the collection) or cancel it (migration 0044). */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return complianceRoute(request, {
    permission: "operations.request",
    back: "/operations/invoices",
    build: (o, form) => {
      if (!ID.test(id)) return "Unknown invoice.";
      const action = form?.get("action");
      if (action === "cancel") return { sql: "SELECT admin.cancel_rent_invoice($1, $2) AS r", params: [o.sessionHash, id] };
      const line = form?.get("line");
      if (action !== "record" || typeof line !== "string" || !/^[1-9]\d{0,17}:[1-9]\d{0,8}$/.test(line)) return "Choose the bank line that paid it.";
      const [statement, no] = line.split(":");
      return { sql: "SELECT admin.record_invoice_payment($1, $2, $3, $4) AS r", params: [o.sessionHash, id, statement, no] };
    },
    okMessage: (r) => (r.status === "cancelled" ? "Invoice cancelled." : `Collection #${String(r.id ?? "")} proposed: an operations checker decides it.`),
  });
}

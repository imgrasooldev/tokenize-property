import type { NextRequest } from "next/server";
import { complianceRoute } from "@/lib/server/compliance-route";
import { parseBankStatement } from "@/lib/server/bank-statement";

/**
 * Maker: import one bank statement file (mock format pt-mock-bank-v1) from the portal
 * (admin.import_bank_statement, migration 0037). The file is read here only to pass its header and
 * lines on; the database checks every rule again (format, running balances, closing, unique
 * references, one statement per account and day).
 */
export async function POST(request: NextRequest) {
  return complianceRoute(request, {
    permission: "operations.request",
    back: "/operations/bank",
    build: async (o, form) => {
      const file = form?.get("statement");
      if (!(file instanceof File) || file.size === 0) return "Choose a statement file.";
      if (file.size > 20 * 1024 * 1024) return "The statement is larger than 20 MB.";
      const st = parseBankStatement(await file.text());
      if (typeof st === "string") return st;
      return {
        sql: "SELECT admin.import_bank_statement($1, $2, $3::date, $4, $5, $6::jsonb) AS r",
        params: [o.sessionHash, st.account, st.date, st.openingPaisa, st.closingPaisa, JSON.stringify(st.lines)],
      };
    },
    okMessage: (r) => `Statement #${String(r.id ?? "")} imported: reconciliation uses it on its next run.`,
  });
}

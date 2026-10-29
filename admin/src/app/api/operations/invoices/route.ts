import type { NextRequest } from "next/server";
import { complianceRoute, text } from "@/lib/server/compliance-route";

/**
 * Maker: issue a rent invoice for a tenant (admin.create_rent_invoice, migration 0044). The payment
 * link secret comes back once and is shown once on the page it redirects to; only its hash is stored.
 */
export async function POST(request: NextRequest) {
  return complianceRoute(request, {
    permission: "operations.request",
    back: "/operations/invoices",
    build: (o, form) => {
      const token = form?.get("token");
      const period = form?.get("period");
      const tenant = text(form, "tenant", 80);
      const rupees = form?.get("rupees");
      const due = form?.get("due");
      if (typeof token !== "string" || !/^0x[0-9a-f]{40}$/.test(token)) return "Choose a token.";
      if (typeof period !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) return "The period is YYYY-MM.";
      if (!tenant || tenant.length < 2) return "Name the tenant or unit (no ID numbers).";
      const [whole = "", frac = "", extra] = typeof rupees === "string" ? rupees.split(".") : [];
      if (extra !== undefined || !/^[1-9][0-9]{0,11}$/.test(whole) || !/^[0-9]{0,2}$/.test(frac)) return "The amount is in rupees, up to two decimals.";
      if (typeof due !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(due)) return "Choose a due date.";
      const paisa = BigInt(whole) * 100n + BigInt(frac.padEnd(2, "0"));
      return { sql: "SELECT admin.create_rent_invoice($1, $2, $3, $4, $5, $6::date) AS r", params: [o.sessionHash, token, period, tenant, paisa.toString(), due] };
    },
    // The link secret is shown once on the page this redirects to (the portal is reached through the SSH tunnel only).
    okPath: (r) => `/operations/invoices?created=${String(r.id ?? "")}&link=${encodeURIComponent(r.link ?? "")}`,
    okMessage: (r) => `Invoice ${r.code ?? ""} issued.`,
  });
}

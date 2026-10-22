import type { NextRequest } from "next/server";
import { complianceRoute, HEX32, ID, text, UUID } from "@/lib/server/compliance-route";

const CODE = /^[a-z][a-z_]{2,39}$/;

/**
 * Maker (operations): opens a wallet-recovery, succession or reversal case (admin.recovery_open:
 * step-up; the protective freeze and the investor's notification are enqueued by the database).
 */
export async function POST(request: NextRequest) {
  return complianceRoute(request, {
    permission: "recovery.request",
    back: "/recovery",
    build: (o, form) => {
      const kind = form?.get("kind");
      const summary = text(form, "summary", 1000);
      if (kind !== "wallet_recovery" && kind !== "succession" && kind !== "reversal") return "Choose the kind of case.";
      if (!summary || summary.length < 10) return "Give a summary of at least 10 characters.";
      if (kind === "reversal") {
        const journal = text(form, "journal", 18);
        const code = text(form, "reasonCode", 40);
        const evidence = text(form, "evidence", 64)?.toLowerCase() ?? null;
        if (!journal || !ID.test(journal)) return "Give the number of the journal booked in error.";
        if (!code || !CODE.test(code)) return "Choose the platform-error reason.";
        if (!evidence || !HEX32.test(evidence)) return "Give the SHA-256 of the incident evidence (64 hex digits).";
        return { sql: "SELECT admin.recovery_open($1, 'reversal', NULL, $2, $3, $4, $5) AS r", params: [o.sessionHash, journal, code, evidence, summary] };
      }
      const subject = text(form, "subject", 36)?.toLowerCase() ?? null;
      if (!subject || !UUID.test(subject)) return "Give the investor's reference (KYC subject id).";
      return { sql: "SELECT admin.recovery_open($1, $2, $3, NULL, NULL, NULL, $4) AS r", params: [o.sessionHash, kind, subject, summary] };
    },
    okPath: (r) => `/recovery/${String(r.id)}`,
    okMessage: () => "Case opened.",
  });
}

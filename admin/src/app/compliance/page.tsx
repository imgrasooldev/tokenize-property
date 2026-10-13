import type { Metadata } from "next";
import { Placeholder } from "@/components/Placeholder";
import { Shell } from "@/components/Shell";
import { requirePage } from "@/lib/server/session";

export const metadata: Metadata = { title: "Compliance" };

export default async function CompliancePage() {
  const officer = await requirePage("compliance.read", "/compliance");
  return (
    <Shell officer={officer} current="/compliance" title="Compliance">
      <Placeholder
        step="6c"
        title="KYC, sanctions and FMU reporting"
        items={[
          "KYC review queue: possible sanctions matches settled by two different compliance officers (rule Y-4)",
          "Freeze requests and the offboarding order (freeze, move or redeem, then delete identity through the timelock; findings F-01, F-02)",
          "Case files and suspicious transaction reports to the Financial Monitoring Unit (AML Act 2010)",
          "Assisted payout-account changes by two officers (ADR 0009)",
        ]}
        note="Status-only views; no CNIC, name or IBAN is ever readable here (rule Y-1)."
      />
    </Shell>
  );
}

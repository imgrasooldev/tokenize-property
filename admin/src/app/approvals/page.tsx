import type { Metadata } from "next";
import { Placeholder } from "@/components/Placeholder";
import { Shell } from "@/components/Shell";
import { requirePage } from "@/lib/server/session";

export const metadata: Metadata = { title: "Approvals" };

export default async function ApprovalsPage() {
  const officer = await requirePage("approvals.read", "/approvals");
  return (
    <Shell officer={officer} current="/approvals" title="Approvals">
      <Placeholder
        step="6b"
        title="Signing approvals (maker-checker)"
        items={[
          "Signer requests waiting for approval: kind, amount, recipient, policy version and the decoded transaction",
          "Approve or reject as a checker who is not the maker, after a fresh security-key step-up (already enforced by admin.require_step_up)",
          "Reconciliation unfreeze requests and payout batches, with the payout gate shown next to each",
          "Outbox commands in review, decided from the chain with a recorded reason",
        ]}
        note="Today these approvals run through the backend command line (npm run signer:decide, recon:unfreeze). The overview shows the pending count."
      />
    </Shell>
  );
}

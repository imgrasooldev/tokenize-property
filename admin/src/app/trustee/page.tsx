import type { Metadata } from "next";
import { Placeholder } from "@/components/Placeholder";
import { Shell } from "@/components/Shell";
import { requirePage } from "@/lib/server/session";

export const metadata: Metadata = { title: "Trustee" };

export default async function TrusteePage() {
  const officer = await requirePage("trustee.read", "/trustee");
  return (
    <Shell officer={officer} current="/trustee" title="Trustee">
      <Placeholder
        step="6d"
        title="Trustee register and oversight"
        items={[
          "Trustee register next to the on-chain holders (read model pinned to a block) and the supply cap",
          "Co-signing issuance and reviewing or rejecting rent distributions within the 48-hour window",
          "Recovery requests and daily reconciliation reports",
        ]}
        note="Trustee officers belong to the independent trustee (e.g. CDC) and cannot hold any platform role (enforced in the database)."
      />
    </Shell>
  );
}

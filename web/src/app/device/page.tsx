import { redirect } from "next/navigation";
import { DeviceForm } from "@/components/account/DeviceForm";
import { PortalShell } from "@/components/Shell";
import { deviceDict } from "@/lib/i18n-device";
import { getDict } from "@/lib/server/lang";
import { currentSession } from "@/lib/server/session";

export const dynamic = "force-dynamic";

/** Linking the mobile app (ADR 0018): the investor approves the code the app shows (RFC 8628 verification URI). */
export default async function DevicePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await currentSession();
  if (!session) redirect("/login");
  const q = await searchParams;
  const code = typeof q.code === "string" && /^[A-Za-z]{4}-?[A-Za-z]{4}$/.test(q.code) ? q.code.toUpperCase() : "";
  const { lang } = await getDict();
  const l = deviceDict(lang);
  return (
    <PortalShell active="account" title={l.title}>
      <section className="panel" style={{ maxInlineSize: 560 }}>
        <p className="note">{l.intro}</p>
        <DeviceForm l={l} initialCode={code} />
      </section>
    </PortalShell>
  );
}

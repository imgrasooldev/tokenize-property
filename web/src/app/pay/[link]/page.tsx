import type { Metadata } from "next";
import { PublicPage } from "@/components/Shell";
import { formatPaisa } from "@/lib/offering-rules";
import { payDict, statusLabel } from "@/lib/i18n-pay";
import { getDict } from "@/lib/server/lang";
import { invoiceByLink } from "@/lib/server/pay";
import { clientKey, take } from "@/lib/server/rate-limit";

export const dynamic = "force-dynamic";
// The link is the tenant's secret: never sent onward in a Referer, never indexed.
export const metadata: Metadata = { title: "Rent payment", referrer: "no-referrer", robots: { index: false, follow: false } };

/**
 * A tenant's rent payment page (migration 0044 RI-2), reached by the link the property manager
 * hands out; no sign-in. Shows the amount, due date, payment reference and the account text only.
 */
export default async function PayPage({ params }: { params: Promise<{ link: string }> }) {
  const { link } = await params;
  const { lang } = await getDict();
  const l = payDict(lang);
  const inv = take("publicVerify", await clientKey()) ? await invoiceByLink(link) : null;
  return (
    <PublicPage active="none" minimal>
      <main className="wrap" style={{ maxInlineSize: 640, marginInline: "auto", padding: 16 }}>
        <section className="panel" data-testid="pay">
          <h1>{l.title}</h1>
          {!inv ? (
            <p className="note">{l.notFound}</p>
          ) : (
            <>
              <p className="note">{l.intro}</p>
              <dl className="kv">
                <dt>{l.tenant}</dt>
                <dd>{inv.tenant}</dd>
                <dt>{l.period}</dt>
                <dd dir="ltr">{inv.period}</dd>
                <dt>{l.amount}</dt>
                <dd data-testid="pay-amount">{formatPaisa(BigInt(inv.amountPaisa), lang)}</dd>
                <dt>{l.due}</dt>
                <dd dir="ltr">{inv.due}</dd>
                <dt>{l.reference}</dt>
                <dd className="mono" dir="ltr" data-testid="pay-code">
                  {inv.code}
                </dd>
                <dt>{l.account}</dt>
                <dd>{inv.account}</dd>
                <dt>{l.status}</dt>
                <dd>{statusLabel(l, inv.status)}</dd>
              </dl>
              <p className="fine">{l.note}</p>
            </>
          )}
        </section>
      </main>
    </PublicPage>
  );
}

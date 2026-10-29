import { notFound, redirect } from "next/navigation";
import { PortalShell } from "@/components/Shell";
import { PrintButton } from "@/components/account/PrintButton";
import { pktTime } from "@/lib/i18n-catalog";
import { fill } from "@/lib/i18n-verify";
import { getDict } from "@/lib/server/lang";
import { currentSession } from "@/lib/server/session";
import { certificate } from "@/lib/server/tax-certificates";

export const dynamic = "force-dynamic";

const rupees = (paisa: string): string => {
  const p = BigInt(paisa);
  const r = p / 100n;
  return `PKR ${r.toLocaleString("en-PK")}.${(p % 100n).toString().padStart(2, "0")}`;
};

/**
 * One annual withholding tax certificate (S-03 OP-51, migration 0035), printable: every booked
 * distribution of the fiscal year with gross, rate, withholding, net and the CPR numbers of the
 * remittances, the totals and the SHA-256 of the issued content. Another investor's id is not found.
 */
export default async function TaxCertificatePage({ params }: { params: Promise<{ id: string }> }) {
  const session = await currentSession();
  if (!session) redirect("/login");
  const { id } = await params;
  const c = await certificate(session.hash, id);
  if (!c) notFound();
  const { t } = await getDict();
  return (
    <PortalShell active="account" title={t.taxCertTitle}>
      <section className="panel" data-testid="tax-certificate">
        <h1>
          {t.taxCertTitle} · {fill(t.taxCertYear, { y: String(c.fiscalYear - 1), z: String(c.fiscalYear) })}
        </h1>
        {c.superseded ? <p className="alert">{t.taxCertSuperseded}</p> : null}
        <p className="fine">
          {c.content.from} – {c.content.to} · {t.taxCertIssued} <span dir="ltr">{pktTime(c.issuedAt)}</span>
        </p>
        <div className="tbl-wrap">
          <table className="t">
            <thead>
              <tr>
                <th scope="col">{t.taxCertPeriod}</th>
                <th scope="col">{t.taxCertToken}</th>
                <th scope="col">{t.taxCertGross}</th>
                <th scope="col">{t.taxCertRate}</th>
                <th scope="col">{t.taxCertWht}</th>
                <th scope="col">{t.taxCertNet}</th>
                <th scope="col">CPR</th>
              </tr>
            </thead>
            <tbody>
              {c.content.lines.map((l) => (
                <tr key={`${l.token}-${l.period}-${l.distributionId ?? ""}`}>
                  <td dir="ltr">{l.period}</td>
                  <td className="mono" dir="ltr">
                    {l.token.slice(0, 10)}…
                  </td>
                  <td dir="ltr">{rupees(l.grossPaisa)}</td>
                  <td dir="ltr">{(l.ratePpm / 10_000).toFixed(2)}%</td>
                  <td dir="ltr">{rupees(l.whtPaisa)}</td>
                  <td dir="ltr">{rupees(l.netPaisa)}</td>
                  <td className="mono" dir="ltr">
                    {l.cprs.join(", ") || "—"}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row" colSpan={2}>
                  {t.taxCertTotal}
                </th>
                <td dir="ltr" data-testid="tax-gross">
                  {rupees(c.content.totals.grossPaisa)}
                </td>
                <td />
                <td dir="ltr" data-testid="tax-wht">
                  {rupees(c.content.totals.whtPaisa)}
                </td>
                <td dir="ltr">{rupees(c.content.totals.netPaisa)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
        <p className="fine">
          SHA-256{" "}
          <span className="mono" dir="ltr" data-testid="tax-sha">
            {c.sha256}
          </span>
        </p>
        <p className="row">
          <PrintButton label={t.taxCertPrint} />
          <a href={`/api/tax-certificates/${String(c.id)}`} download>
            {t.taxCertDownload}
          </a>
        </p>
        <p className="fine">{t.taxCertNote}</p>
      </section>
    </PortalShell>
  );
}

import { redirect } from "next/navigation";
import { PortalShell, Sample } from "@/components/Shell";
import { tokenAbi } from "@/lib/abis";
import { formatNumber } from "@/lib/i18n";
import { latestDeployment } from "@/lib/server/chain";
import { investorById } from "@/lib/server/db";
import { publicClient } from "@/lib/server/demo-signer";
import { getDict } from "@/lib/server/lang";
import { isVerifiedOnChain } from "@/lib/server/onboarding";
import { currentInvestorId } from "@/lib/server/session";

export const dynamic = "force-dynamic";

export default async function AccountPage() {
  const id = await currentInvestorId();
  const investor = id ? await investorById(id) : null;
  if (!investor) redirect("/login");
  const { lang, t } = await getDict();

  const token = latestDeployment()?.get("token");
  const [verified, balance] = await Promise.all([
    isVerifiedOnChain(investor.wallet_address),
    token
      ? publicClient
          .readContract({ address: token, abi: tokenAbi, functionName: "balanceOf", args: [investor.wallet_address] })
          .catch(() => null)
      : Promise.resolve(null),
  ]);
  const status = investor.kyc_status === "verified" ? t.verified : investor.kyc_status === "rejected" ? t.rejected : t.pending;
  const steps = investor.persona
    ? [t.stepIdentity, t.stepClaims, t.stepRegistered]
    : [t.stepNadra, t.stepLiveness, t.stepIdentity, t.stepClaims, t.stepRegistered];

  return (
    <PortalShell active="account" title={t.accountTitle}>
      <div className="kpi-strip">
        <div>
          <small>{t.kycStatus}</small>
          <b className={investor.kyc_status === "verified" ? "up" : "am"}>{status}</b>
        </div>
        <div>
          <small>{t.chainIdentity}</small>
          <b className={verified ? "up" : "dn"}>{verified ? "✓" : "✗"}</b>
        </div>
        <div>
          <small>{t.holdings}</small>
          <b>{balance === null ? "—" : formatNumber(balance, lang)}</b>
        </div>
        <div>
          <small>{t.custody}</small>
          <b className="small-b">{t.custodial}</b>
        </div>
      </div>

      <div className="detail">
        <section className="panel">
          <h2>{investor.display_name}</h2>
          <dl className="kv" style={{ marginBlockStart: 12 }}>
            <dt>{t.kycStatus}</dt>
            <dd>
              <span className={`chip ${investor.kyc_status === "verified" ? "green" : "amber"}`}>{status}</span>
            </dd>
            <dt>{t.onChainVerified}</dt>
            <dd>
              <span className={`chip ${verified ? "green" : "red"}`}>{verified ? t.yes : t.no}</span>
            </dd>
            {investor.cnic_last4 && (
              <>
                <dt>{t.cnicOnFile}</dt>
                <dd dir="ltr">•••••-•••{investor.cnic_last4.slice(0, 3)}-{investor.cnic_last4.slice(3)}</dd>
              </>
            )}
            <dt>{t.holdings}</dt>
            <dd>{balance === null ? "—" : formatNumber(balance, lang)}</dd>
            <dt>{t.wallet}</dt>
            <dd className="mono">{investor.wallet_address}</dd>
            <dt>{t.identity}</dt>
            <dd className="mono">{investor.identity_address ?? "—"}</dd>
          </dl>
          <p className="note" style={{ marginBlockStart: 14 }}>
            {t.custodyNote}
          </p>
        </section>
        <div className="stack">
          <section className="panel">
            <h2>{t.howVerified}</h2>
            <div className="timeline">
              {steps.map((s) => (
                <div className="ti two" key={s}>
                  <span className="chip green">✓</span>
                  <span>{s}</span>
                </div>
              ))}
            </div>
          </section>
          <section className="panel">
            <div className="row-between">
              <h2>{t.bankSecurity}</h2>
              <Sample t={t} soon />
            </div>
            <div className="checks">
              <div className="check">
                <i className="wait">…</i>
                {t.passkeyFact1}
              </div>
              <div className="check">
                <i className="wait">…</i>
                {t.bankLink}
              </div>
              <div className="check">
                <i className="wait">…</i>
                {t.passkeyFact2}
              </div>
            </div>
          </section>
        </div>
      </div>
    </PortalShell>
  );
}

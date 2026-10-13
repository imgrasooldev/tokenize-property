import { redirect } from "next/navigation";
import { PortalShell, Sample } from "@/components/Shell";
import { AutoRefresh } from "@/components/AutoRefresh";
import { formatNumber } from "@/lib/i18n";
import { investorById } from "@/lib/server/db";
import { getDict } from "@/lib/server/lang";
import { onboardingProgress } from "@/lib/server/onboarding";
import { holdingOf, indexStatus, registeredOnChain } from "@/lib/server/readmodel";
import { currentInvestorId } from "@/lib/server/session";

export const dynamic = "force-dynamic";

export default async function AccountPage() {
  const id = await currentInvestorId();
  const investor = id ? await investorById(id) : null;
  if (!investor) redirect("/login");
  const { lang, t } = await getDict();

  // Read model (ADR 0010): as of the indexer cursor, never a chain call per page.
  const onboarding = investor.onboard_step === "identity" || investor.onboard_step === "claims" || investor.onboard_step === "register";
  const [verified, balance, index, progress] = await Promise.all([
    registeredOnChain(investor.wallet_address),
    holdingOf(investor.wallet_address),
    indexStatus(),
    onboarding ? onboardingProgress(investor.id) : Promise.resolve(null),
  ]);
  const status = investor.kyc_status === "verified" ? t.verified : investor.kyc_status === "rejected" ? t.rejected : t.pending;
  const chainSteps = [t.stepIdentity, t.stepClaims, t.stepRegistered];
  const steps = investor.persona ? chainSteps : [t.stepNadra, t.stepLiveness, ...chainSteps];
  // How many of the steps are done: KYC steps are done once the account exists (the KYC service
  // verified the person); chain steps follow the outbox commands until registration is indexed.
  const failed = investor.onboard_step === "failed";
  const chainDone = progress ? progress.done : failed ? 0 : chainSteps.length;
  const doneCount = steps.length - chainSteps.length + chainDone;

  return (
    <PortalShell active="account" title={t.accountTitle}>
      {onboarding && (
        <div className="alert" role="status" style={{ marginBlockEnd: 16 }}>
          {progress?.waiting ? t.onboardApproval : t.onboardPending.replace("{n}", String(progress?.done ?? 0)).replace("{t}", String(progress?.total ?? 3))}
          <AutoRefresh seconds={2} />
        </div>
      )}
      {failed && (
        <div className="alert" role="status" style={{ marginBlockEnd: 16 }}>
          {t.onboardFailed}
        </div>
      )}
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
              {steps.map((s, i) => (
                <div className="ti two" key={s}>
                  <span className={`chip ${i < doneCount ? "green" : failed ? "red" : "amber"}`}>{i < doneCount ? "✓" : failed ? "✗" : "…"}</span>
                  <span>{s}</span>
                </div>
              ))}
            </div>
            <p className="fine">{index ? t.asOfBlock.replace("{b}", index.block.toString()) : t.readModelDown}</p>
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

import { redirect } from "next/navigation";
import { PortalShell } from "@/components/Shell";
import { AutoRefresh } from "@/components/AutoRefresh";
import { PayoutForm } from "@/components/account/PayoutForm";
import { Countdown } from "@/components/offering/Countdown";
import { formatNumber } from "@/lib/i18n";
import { catalogDict, pktTime } from "@/lib/i18n-catalog";
import { fill } from "@/lib/i18n-verify";
import { investorById } from "@/lib/server/db";
import { getDict } from "@/lib/server/lang";
import { onboardingProgress } from "@/lib/server/onboarding";
import { maskedIban, payeeState, payoutAccounts } from "@/lib/server/payees";
import { holdingOf, indexStatus, registeredOnChain } from "@/lib/server/readmodel";
import { passkeyAvailability } from "@/lib/server/passkey-config";
import { listPasskeys } from "@/lib/server/passkeys";
import { currentSession, sessionExpiresAt } from "@/lib/server/session";
import { PasskeyPanel } from "@/components/passkey/PasskeyPanel";
import { passkeyDict } from "@/lib/i18n-passkey";

export const dynamic = "force-dynamic";

export default async function AccountPage() {
  const session = await currentSession();
  const investor = session ? await investorById(session.investorId) : null;
  if (!session || !investor) redirect("/login");
  const { lang, t } = await getDict();
  const [passkeys, availability] = await Promise.all([listPasskeys(session.hash, lang), passkeyAvailability()]);

  // Read model (ADR 0010): as of the indexer cursor, never a chain call per page.
  const onboarding = investor.onboard_step === "identity" || investor.onboard_step === "claims" || investor.onboard_step === "register";
  const l = catalogDict(lang);
  const [verified, balance, index, progress, payees, expires] = await Promise.all([
    registeredOnChain(investor.wallet_address),
    holdingOf(investor.wallet_address),
    indexStatus(),
    onboarding ? onboardingProgress(investor.id) : Promise.resolve(null),
    payoutAccounts(investor.kyc_subject),
    sessionExpiresAt(),
  ]);
  const now = Date.now();
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
          <PasskeyPanel l={passkeyDict(lang)} availability={availability} passkeys={passkeys} />
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
          <section className="panel" aria-labelledby="payout-h">
            <h2 id="payout-h">{t.bankSecurity}</h2>
            <h3 className="small">{l.payoutTitle}</h3>
            <p className="fine">{l.payoutIntro}</p>
            {payees === null ? (
              <p className="note">{l.err_unavailable}</p>
            ) : payees.length === 0 ? (
              <p className="note">{investor.kyc_subject ? l.payoutNone : l.noKycRecord}</p>
            ) : (
              <ul className="payees" aria-label={l.payoutTitle}>
                {payees.map((p) => {
                  const state = payeeState(p, now);
                  return (
                    <li className="payee" key={p.payeeId}>
                      <span className={`chip ${state === "active" ? "green" : state === "cooling" ? "amber" : "gray"}`}>
                        {state === "active" ? l.accActive : state === "cooling" ? l.accCooling : l.accReplaced}
                      </span>
                      <span>
                        {l.accBank} <b className="mono">{p.bankCode}</b>
                      </span>
                      <span className="mono" dir="ltr" aria-label={`${l.accNumber} …${p.last4}`}>
                        {maskedIban(p.last4)}
                      </span>
                      <span className="fine">
                        {l.accRegistered} <span dir="ltr">{pktTime(p.registeredAt)}</span>
                      </span>
                      {state === "cooling" && (
                        <span className="fine">
                          {l.accUsableIn} <Countdown expiresAt={p.activeFrom} serverNow={now} upText={l.accReady} /> ({l.accUsableFrom}{" "}
                          <span dir="ltr">{pktTime(p.activeFrom)}</span> {l.pktSuffix})
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            {investor.kyc_subject && investor.kyc_status === "verified" && <PayoutForm l={l} hasAccount={(payees ?? []).some((p) => p.supersededAt === null)} />}
            <h3 className="small" style={{ marginBlockStart: 18 }}>
              {l.sessionTitle}
            </h3>
            <p className="note">{expires ? fill(l.sessionBody, { t: pktTime(expires) }) : "—"}</p>
            <p className="fine">{l.sessionsSoon}</p>
          </section>
        </div>
      </div>
    </PortalShell>
  );
}

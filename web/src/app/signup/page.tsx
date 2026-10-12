import { PublicPage } from "@/components/Shell";
import { SignUpForm } from "@/components/SignUpForm";
import { getDict } from "@/lib/server/lang";

export const dynamic = "force-dynamic";

export default async function SignUpPage() {
  const { t } = await getDict();
  const steps = [t.suStep1, t.suStep2, t.suStep3, t.suStep4];
  return (
    <PublicPage active="none" minimal>
      <main id="main" className="wrap page">
        <ol className="steps-bar" aria-label={t.signupTitle}>
          {steps.map((s, i) => (
            <li key={s} className={`stp ${i === 0 ? "now" : ""}`}>
              <b>{i + 1}</b>
              {s}
            </li>
          ))}
        </ol>
        <div className="signup-grid">
          <div className="glass pad-lg">
            <h1 className="page-title">{t.signupTitle}</h1>
            <p className="mu lead-sm">{t.signupBody}</p>
            <SignUpForm t={t} />
          </div>
          <div className="stack">
            <section className="panel">
              <h2>{t.whatHappensChain}</h2>
              <div className="timeline">
                {[
                  [t.chainStep1, "wallet"],
                  [t.chainStep2, "ONCHAINID"],
                  [t.chainStep3, "topic 1, 2"],
                  [t.chainStep4, "RegistrarGuard"],
                ].map(([text, tag], i) => (
                  <div className="ti" key={tag}>
                    <span className="chip cy num">{i + 1}</span>
                    <span>{text}</span>
                    <span className="mono di small" dir="ltr">
                      {tag}
                    </span>
                  </div>
                ))}
              </div>
            </section>
            <div className="ai-box">
              <div className="hd">
                <span className="orb" aria-hidden="true" />
                {t.whyCnic}
              </div>
              <p className="ai-text">
                {t.whyCnicBody1} <span className="cite">SECP</span> {t.whyCnicBody2} <span className="cite">ERC-3643</span>
              </p>
            </div>
            <section className="panel">
              <h2>{t.yourData}</h2>
              <div className="checks">
                <div className="check">
                  <i>✓</i>
                  {t.dataFact1}
                </div>
                <div className="check">
                  <i>✓</i>
                  {t.dataFact2}
                </div>
                <div className="check">
                  <i>✓</i>
                  {t.dataFact3}
                </div>
              </div>
            </section>
          </div>
        </div>
      </main>
    </PublicPage>
  );
}

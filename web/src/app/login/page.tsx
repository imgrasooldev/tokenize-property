import Link from "next/link";
import { loginAsPersona } from "@/app/actions/auth";
import { PublicPage, Sample } from "@/components/Shell";
import { getDict } from "@/lib/server/lang";

export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ e?: string }> }) {
  const { t } = await getDict();
  const { e } = await searchParams;
  return (
    <PublicPage active="none" minimal>
      <main id="main" className="wrap center-page">
        <div className="glass auth-card">
          <h1 className="page-title">{t.loginTitle}</h1>
          <p className="mu">{t.loginBody}</p>
          <div className="pk" aria-hidden="true">
            <svg width="54" height="54" viewBox="0 0 24 24" fill="none" stroke="#22E3F0" strokeWidth="1.6">
              <circle cx="8" cy="9" r="4" />
              <path d="M2 21c0-3.5 2.7-6 6-6 1.6 0 3 .5 4 1.4M15 13a3 3 0 1 1 3 3v5l-1.5-1.5L18 18" />
            </svg>
          </div>
          {e === "rate" && (
            <div className="alert" role="alert" style={{ marginBlockEnd: 16 }}>
              {t.errRate}
            </div>
          )}
          <div className="persona-grid">
            {(["ALICE", "BOB"] as const).map((p) => (
              <form key={p} action={loginAsPersona} className="persona">
                <input type="hidden" name="persona" value={p} />
                <div className="av" aria-hidden="true">
                  {p.slice(0, 1)}
                </div>
                <div className="persona-text">
                  <b>{p === "ALICE" ? "Alice" : "Bob"}</b>
                  <div className="meta">{t.personaNote}</div>
                </div>
                <button type="submit" className="btn">
                  {t.continueAs} {p === "ALICE" ? "Alice" : "Bob"}
                </button>
              </form>
            ))}
          </div>
          <div className="or">
            <span />
            {t.or}
            <span />
          </div>
          <span className="btn secondary block" aria-disabled="true">
            {t.passkeySignIn} <Sample t={t} soon />
          </span>
          <div className="checks start">
            <div className="check">
              <i className="wait">…</i>
              {t.passkeyFact1}
            </div>
            <div className="check">
              <i className="wait">…</i>
              {t.passkeyFact2}
            </div>
          </div>
          <p style={{ marginBlockStart: 18 }}>
            <Link href="/signup" className="btn secondary">
              {t.newInvestor}
            </Link>
          </p>
        </div>
      </main>
    </PublicPage>
  );
}

import Link from "next/link";
import { loginAsPersona } from "@/app/actions/auth";
import { getDict } from "@/lib/server/lang";

export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ e?: string }> }) {
  const { t } = await getDict();
  const { e } = await searchParams;
  return (
    <main className="container narrow">
      <h1>{t.loginTitle}</h1>
      <p className="lead">{t.loginBody}</p>
      {e === "rate" && (
        <div className="alert" role="alert" style={{ marginBlockEnd: 16 }}>
          {t.errRate}
        </div>
      )}
      <div className="persona-grid">
        {(["ALICE", "BOB"] as const).map((p) => (
          <form key={p} action={loginAsPersona} className="panel persona">
            <input type="hidden" name="persona" value={p} />
            <div className="avatar" aria-hidden="true">{p.slice(0, 1)}</div>
            <div>
              <b>{p === "ALICE" ? "Alice" : "Bob"}</b>
              <div className="meta">{t.personaNote}</div>
            </div>
            <button type="submit" className="btn">
              {t.continueAs} {p === "ALICE" ? "Alice" : "Bob"}
            </button>
          </form>
        ))}
      </div>
      <p>
        <Link href="/signup" className="btn secondary">
          {t.newInvestor}
        </Link>
      </p>
    </main>
  );
}

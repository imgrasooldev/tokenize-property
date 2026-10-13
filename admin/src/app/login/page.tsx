import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { LoginClient } from "@/components/LoginClient";
import { safeNext } from "@/lib/server/http";
import { currentOfficer, landingFor } from "@/lib/server/session";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const q = await searchParams;
  const next = safeNext(q.next);
  const officer = await currentOfficer();
  if (officer) redirect(next ?? landingFor(officer.permissions));
  return (
    <main className="auth">
      <section className="auth-card" aria-labelledby="t">
        <div className="key-art" aria-hidden="true">
          ⚿
        </div>
        <div>
          <h1 id="t">PT Control</h1>
          <p className="mu">Internal portal for operations, compliance, trustee and audit officers.</p>
        </div>
        {q.expired ? (
          <p className="alert info" role="status">
            Your session ended (15 minutes without activity, 8 hours in total, or a sign-in elsewhere). Sign in again.
          </p>
        ) : null}
        {q.bye ? (
          <p className="alert ok" role="status">
            You are signed out.
          </p>
        ) : null}
        <LoginClient next={next} />
        <ul className="small mu" style={{ margin: 0, paddingInlineStart: 18, display: "grid", gap: 4 }}>
          <li>Only an enrolled hardware security key (FIDO2 with PIN or biometric) signs you in. No passwords.</li>
          <li>Synced passkeys and investor accounts cannot sign in here.</li>
          <li>New officers enrol with a one-time link after two administrators approve them.</li>
        </ul>
      </section>
    </main>
  );
}

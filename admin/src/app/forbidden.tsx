/** HTTP 403 (forbidden() from a page guard). The denial is already in the audit log. */
export default function Forbidden() {
  return (
    <main className="auth">
      <section className="auth-card" aria-labelledby="t">
        <h1 id="t" data-testid="forbidden">
          Not permitted for your role
        </h1>
        <p className="mu">This page needs a role you do not hold. The attempt was recorded in the audit log.</p>
        <a className="btn block" href="/account">
          Back to my account
        </a>
      </section>
    </main>
  );
}

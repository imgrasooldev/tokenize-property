"use client";

/** Generic error page: only the digest, never internals (details stay in the server log). */
export default function ErrorPage({ error }: { error: Error & { digest?: string } }) {
  return (
    <main className="auth">
      <section className="auth-card" aria-labelledby="t">
        <h1 id="t">Something went wrong</h1>
        <p className="mu">The request could not be completed. If it repeats, give the reference below to the platform team.</p>
        <p className="mono small">ref {error.digest ?? "–"}</p>
        <a className="btn block" href="/account">
          Back to my account
        </a>
      </section>
    </main>
  );
}

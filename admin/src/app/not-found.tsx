export default function NotFound() {
  return (
    <main className="auth">
      <section className="auth-card" aria-labelledby="t">
        <h1 id="t">Not found</h1>
        <p className="mu">There is no such page in PT Control.</p>
        <a className="btn block" href="/account">
          Back to my account
        </a>
      </section>
    </main>
  );
}

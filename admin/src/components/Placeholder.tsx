/** A clearly marked "not built yet" page: no fake data, only what the step will deliver. */
export function Placeholder({ step, title, items, note }: { step: string; title: string; items: string[]; note: string }) {
  return (
    <section className="placeholder" aria-labelledby="ph" data-testid="placeholder">
      <div className="row">
        <span className="chip warn">Planned · Step {step}</span>
        <span className="chip">No data shown yet</span>
      </div>
      <h2 id="ph">{title}</h2>
      <ul>
        {items.map((i) => (
          <li key={i}>{i}</li>
        ))}
      </ul>
      <p className="small di">{note}</p>
    </section>
  );
}

import type { Metadata } from "next";
import { Flash } from "@/components/Decision";
import { Shell } from "@/components/Shell";
import { pkt } from "@/lib/format";
import { health, levelChip, type HealthAlert } from "@/lib/server/health";
import { requirePage } from "@/lib/server/session";

export const metadata: Metadata = { title: "Health and alerts" };

function Alerts({ rows, testId }: { rows: HealthAlert[]; testId: string }) {
  return (
    <div className="tbl-wrap">
      <table className="t" data-testid={testId}>
        <thead>
          <tr>
            <th scope="col">Level</th>
            <th scope="col">Check</th>
            <th scope="col">Detail</th>
            <th scope="col">Opened</th>
            <th scope="col">Acknowledged</th>
            <th scope="col">Resolved</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((a) => (
            <tr key={a.id}>
              <td>
                <span className={levelChip(a.level)}>{a.level}</span>
              </td>
              <td className="mono small">{a.check}</td>
              <td className="small">{a.detail}</td>
              <td className="small nowrap">{pkt(a.openedAt)}</td>
              <td className="small">{a.acknowledgedBy ? `${a.acknowledgedBy} · ${a.ackNote ?? ""}` : "–"}</td>
              <td className="small nowrap">{a.resolvedAt ? pkt(a.resolvedAt) : "–"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Health and alerts (migration 0052): the database checks live, the servers' latest pt-health
 * reports, one alert per failing check (opened, raised, resolved by the checks themselves) and the
 * acknowledgements. Operations makers and checkers and the platform owner acknowledge.
 */
export default async function HealthPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const officer = await requirePage("ops.read", "/health");
  const q = await searchParams;
  const h = await health(officer.sessionHash);
  const worst = h.checks.some((c) => c.level === "CRIT") ? "CRIT" : h.checks.some((c) => c.level === "WARN") ? "WARN" : "OK";

  return (
    <Shell officer={officer} current="/health" title="Health and alerts">
      <Flash q={q} />
      <section className="card" aria-labelledby="now" style={{ marginBlockEnd: 12 }}>
        <h2 id="now">
          Now <span className="sp" />
          <span className={levelChip(worst)} data-testid="health-overall">
            {worst}
          </span>
        </h2>
        <p className="small mu">
          Checked {pkt(h.at)}. Server reports:{" "}
          {h.reports.length === 0 ? "none yet (install the pt-health timer with --record)" : h.reports.map((r) => `${r.host} ${pkt(r.at)}`).join(", ")}.
        </p>
        <form method="post" action="/api/health/refresh" className="row" style={{ marginBlockEnd: 8 }}>
          <input type="hidden" name="csrf" value={officer.csrf} />
          <button className="btn" type="submit">
            Check now
          </button>
          <span className="small mu">Alerts open and close with every server report; this runs the same evaluation now.</span>
        </form>
        <div className="tbl-wrap">
          <table className="t" data-testid="health-checks">
            <thead>
              <tr>
                <th scope="col">Level</th>
                <th scope="col">Source</th>
                <th scope="col">Check</th>
                <th scope="col">Detail</th>
                <th scope="col">Failing since</th>
              </tr>
            </thead>
            <tbody>
              {h.checks.map((c) => (
                <tr key={`${c.source}-${c.check}`}>
                  <td>
                    <span className={levelChip(c.level)}>{c.level}</span>
                  </td>
                  <td className="small">{c.source}</td>
                  <td className="mono small">{c.check}</td>
                  <td className="small">{c.detail}</td>
                  <td className="small nowrap">{c.since ? pkt(c.since) : "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card" aria-labelledby="open" style={{ marginBlockEnd: 12 }}>
        <h2 id="open">Open alerts</h2>
        {h.open.length === 0 ? <p className="empty">No open alert.</p> : <Alerts rows={h.open} testId="health-open" />}
        {h.canAcknowledge
          ? h.open
              .filter((a) => !a.acknowledgedBy)
              .map((a) => (
                <form key={a.id} method="post" action={`/api/health/${String(a.id)}/acknowledge`} className="row" style={{ marginBlockStart: 8 }}>
                  <input type="hidden" name="csrf" value={officer.csrf} />
                  <span className="mono small">{a.check}</span>
                  <input name="note" required minLength={5} maxLength={300} placeholder="What you are doing about it (5+ characters)" aria-label={`Note for ${a.check}`} />
                  <button className="btn" type="submit">
                    Acknowledge
                  </button>
                </form>
              ))
          : null}
      </section>

      <div className="g2">
        <section className="card" aria-labelledby="closed">
          <h2 id="closed">Resolved alerts</h2>
          {h.closed.length === 0 ? <p className="empty">None yet.</p> : <Alerts rows={h.closed} testId="health-closed" />}
        </section>
        <section className="card" aria-labelledby="settings">
          <h2 id="settings">Thresholds</h2>
          <ul className="small">
            {h.settings.map((s) => (
              <li key={s.key}>
                <span className="mono">{s.key}</span> = {s.value} · {s.description}
              </li>
            ))}
          </ul>
          <p className="small mu">Server thresholds live in /etc/pt-ops/ops.env (docs/OPERATIONS.md section 4).</p>
        </section>
      </div>
    </Shell>
  );
}

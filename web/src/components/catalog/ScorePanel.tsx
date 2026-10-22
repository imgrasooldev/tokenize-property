import { formatNumber, type Lang } from "@/lib/i18n";
import { fill } from "@/lib/i18n-verify";
import { clabel, type CatalogDict } from "@/lib/i18n-catalog";
import type { PropertyScore } from "@/lib/score";

/** The rule-based property score with every factor, weight and rule ("How this is calculated"). */
export function ScorePanel({ score, lang, l, compact = false }: { score: PropertyScore; lang: Lang; l: CatalogDict; compact?: boolean }) {
  return (
    <section className="panel score-panel" aria-labelledby="score-h">
      <div className="row-between">
        <h2 id="score-h">
          {l.scoreTitle}
          {score.score !== null && <> · {fill(l.scoreOf, { n: formatNumber(score.score, lang) })}</>}
        </h2>
        <span className="chip cy">{l.scoreRuleBased}</span>
      </div>
      {score.score === null ? (
        <p className="note">{fill(l.scoreNone, { c: formatNumber(score.coverage, lang) })}</p>
      ) : (
        <div
          className="bar"
          role="meter"
          aria-label={l.scoreTitle}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={score.score}
          style={{ marginBlock: 8 }}
        >
          <i style={{ inlineSize: `${String(score.score)}%` }} />
        </div>
      )}
      <p className="fine">{fill(l.scoreCoverage, { c: formatNumber(score.coverage, lang) })}</p>
      {!compact && (
        <div className="factors">
          {score.factors.map((f) => (
            <div className="factor" key={f.key}>
              <span>{clabel(l, "f_", f.key)}</span>
              <div className="t" aria-hidden="true">
                <i style={{ inlineSize: `${String(f.points ?? 0)}%` }} />
              </div>
              <span>{f.points === null ? "—" : formatNumber(f.points, lang)}</span>
            </div>
          ))}
        </div>
      )}
      <details className="score-how">
        <summary>{l.scoreHow}</summary>
        <p className="fine">{l.scoreHowBody}</p>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">{l.factor}</th>
                <th scope="col" className="n">
                  {l.weight}
                </th>
                <th scope="col" className="n">
                  {l.points}
                </th>
              </tr>
            </thead>
            <tbody>
              {score.factors.map((f) => (
                <tr key={f.key}>
                  <td>
                    <b>{clabel(l, "f_", f.key)}</b>
                    <div className="fine">{clabel(l, "fi_", f.key)}</div>
                  </td>
                  <td className="n">{formatNumber(f.weight, lang)}</td>
                  <td className="n">{f.points === null ? l.notPublished : formatNumber(f.points, lang)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
      <p className="fine">{l.scoreNotAdvice}</p>
    </section>
  );
}

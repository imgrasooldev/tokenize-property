import type { ReactNode } from "react";
import { aLabel, analystDict, fillA } from "@/lib/i18n-analyst";
import type { Answer } from "@/lib/server/analyst/types";

/**
 * Renders an analyst answer (server or client): paragraphs with numbered citations linked to the
 * sources list, data-as-of time in PKT, provider badge and the disclaimer. No hooks, so both the
 * search page (server) and AnalystBox (client) use it.
 */

const PKT_MS = 5 * 3_600_000;

function pkt(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const d = new Date(t + PKT_MS).toISOString();
  return `${d.slice(0, 10)} ${d.slice(11, 16)} PKT`;
}

/** Splits "text [1] more [2]" into text and citation links. Hashes and figures stay left-to-right. */
function withCitations(p: string, idPrefix: string, known: Set<number>, citeLabel: string): ReactNode[] {
  return p.split(/(\[\d{1,3}\])/).map((part, i) => {
    const m = /^\[(\d{1,3})\]$/.exec(part);
    const n = m ? Number(m[1]) : NaN;
    if (m && known.has(n)) {
      return (
        <a key={i} href={`#${idPrefix}-src-${String(n)}`} className="an-cite" aria-label={fillA(citeLabel, { n })}>
          [{n}]
        </a>
      );
    }
    return <bdi key={i}>{part}</bdi>;
  });
}

export function AnswerView({ answer, idPrefix, question }: { answer: Answer; idPrefix: string; question?: string }) {
  const d = analystDict(answer.lang);
  const known = new Set(answer.facts.map((f) => f.n));
  const asOf = answer.dataAsOf.block ? fillA(d.dataAsOfBlock, { t: pkt(answer.dataAsOf.at), b: answer.dataAsOf.block }) : fillA(d.dataAsOf, { t: pkt(answer.dataAsOf.at) });
  return (
    <article className={`an-answer${answer.refused ? " an-refused" : ""}`} lang={answer.lang === "ur" ? "ur" : "en"} dir={answer.lang === "ur" ? "rtl" : "ltr"} aria-label={d.answerTitle}>
      <div className="an-meta">
        <span className={`chip an-badge ${answer.provider}`}>{answer.provider === "claude" ? d.providerClaude : d.providerGrounded}</span>
        {answer.refused !== "rate" && <span className="an-asof">{asOf}</span>}
      </div>
      {question && <p className="an-q">{question}</p>}
      <div className="an-text">
        {answer.text.map((p, i) => (
          <p key={i}>{withCitations(p, idPrefix, known, d.citeLabel)}</p>
        ))}
      </div>
      {answer.facts.length > 0 && (
        <section className="an-sources" aria-labelledby={`${idPrefix}-src-title`}>
          <h4 id={`${idPrefix}-src-title`}>{d.sourcesTitle}</h4>
          <ol>
            {answer.facts.map((f) => (
              <li key={f.n} id={`${idPrefix}-src-${String(f.n)}`}>
                <span className="an-n">[{f.n}]</span>{" "}
                <span>
                  {f.text}
                  {f.value !== "" && (
                    <>
                      : <bdi className="an-v">{f.value}</bdi>
                    </>
                  )}
                </span>
                <span className="an-src">
                  {aLabel(d, `kind_${f.source.kind}`, f.source.kind)}{" "}
                  <code className="mono" dir="ltr">
                    {f.source.ref}
                  </code>
                  {f.source.asOf && <> · {fillA(d.asOfShort, { t: pkt(f.source.asOf) })}</>}
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}
      <p className="an-disclaimer">{d.disclaimer}</p>
    </article>
  );
}

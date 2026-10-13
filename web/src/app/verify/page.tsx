import type { Metadata } from "next";
import { PublicPage } from "@/components/Shell";
import { AnchorList, AnchorSelfCheck, FileHashCheck, ProofCheck, StatementCheck } from "@/components/verify/VerifyTools";
import { formatNumber, formatPkr, type Lang } from "@/lib/i18n";
import { docTypeLabel, fill, verifyDict, type VerifyDict } from "@/lib/i18n-verify";
import { LOCAL_ANCHOR_CHAIN_ID, type AnchorSection } from "@/lib/server/anchors";
import { getDict } from "@/lib/server/lang";
import { verificationView, type PublicDistribution, type PublicToken, type ReconStatus, type VerifyView } from "@/lib/server/verify";
import { ageParts, anchorFresh } from "@/lib/verify-rules";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Verify · Property Token" };

const short = (h: string) => `${h.slice(0, 10)}…${h.slice(-8)}`;
/** Times on this page are UTC and say so: a public page must not depend on the viewer's zone. */
const utc = (iso: string | null) => (iso ? `${iso.slice(0, 16).replace("T", " ")} UTC` : "—");
const rupees = (paisa: string) => Number(BigInt(paisa)) / 100;

/**
 * Public verification page (S-07): no sign-in, read-only, public data only. Server-rendered from the
 * indexer read model (one shared value every 2 s); the checks themselves run in the browser.
 */
export default async function VerifyPage() {
  const { lang } = await getDict();
  const l = verifyDict(lang);
  const v = await verificationView();
  const current = v.index.gate === "ok" || v.index.gate === "stale";

  return (
    <PublicPage active="verify">
      <main id="main" className="wrap page verify-page">
        <div className="kicker">
          {"// "}
          {l.kicker}
        </div>
        <h1 className="page-title">
          {l.title1} <span className="grad">{l.title2}</span>
        </h1>
        <p className="lead-sm meta">{l.intro}</p>

        <IndexBanner v={v} l={l} />
        <Disclosures l={l} />

        <section className="panel vsec" aria-labelledby="sec-supply">
          <h2 id="sec-supply">{l.supplyTitle}</h2>
          {current && v.token ? <Supply token={v.token} v={v} l={l} lang={lang} /> : <p className="note">{current ? l.noToken : l.notAvailable}</p>}
          {v.untokenized.length > 0 && <p className="fine">{fill(l.untokenized, { t: v.untokenized.join(", ") })}</p>}
        </section>

        <section className="panel vsec" aria-labelledby="sec-docs">
          <h2 id="sec-docs">{l.docsTitle}</h2>
          <p className="note">{l.docsNote}</p>
          {!current || v.documents === null ? (
            <p className="note">{l.notAvailable}</p>
          ) : (
            <>
              {v.documents.length === 0 ? (
                <p className="note" data-testid="docs-none">
                  {l.docsNone}
                </p>
              ) : (
                <div className="glass table-wrap">
                  <table className="table" data-testid="documents">
                    <thead>
                      <tr>
                        <th>{l.docId}</th>
                        <th>{l.docType}</th>
                        <th>{l.docAdded}</th>
                        <th>{l.docHash}</th>
                        <th>{l.docRef}</th>
                        <th>{l.docState}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {v.documents.map((d) => (
                        <tr key={d.id} data-doc={d.id}>
                          <td className="mono">#{d.id}</td>
                          <td>{docTypeLabel(lang, d.docType)}</td>
                          <td className="mono small">
                            #{d.addedBlock}
                            <div className="di">{utc(d.addedAt || null)}</div>
                          </td>
                          <td className="mono small cy" title={d.sha256}>
                            {short(d.sha256)}
                          </td>
                          <td className="mono small">{d.uri}</td>
                          <td>
                            {d.supersededBy === null ? (
                              <span className="chip green">{l.docCurrent}</span>
                            ) : (
                              <span className="chip amber">{fill(l.docSupersededBy, { n: d.supersededBy })}</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <FileHashCheck docs={v.documents} l={l} lang={lang} />
            </>
          )}
          <p className="fine">{l.docPublic}</p>
        </section>

        <section className="panel vsec" aria-labelledby="sec-anchor">
          <h2 id="sec-anchor">{l.anchorTitle}</h2>
          <p className="note">{l.anchorNote}</p>
          <Anchors a={v.anchors} l={l} now={v.at} />
          <p className="alert demo honesty">{l.anchorHonesty}</p>
          <dl className="kv vkv">
            <dt>{l.anchorVerifyRun}</dt>
            <dd>{l.anchorVerifyNotRecorded}</dd>
          </dl>
          <AnchorSelfCheck l={l} />
        </section>

        <section className="panel vsec" aria-labelledby="sec-dist">
          <h2 id="sec-dist">{l.distTitle}</h2>
          <p className="note">{l.distNote}</p>
          {!current || v.distributions === null ? (
            <p className="note">{l.notAvailable}</p>
          ) : v.distributions.length === 0 ? (
            <p className="note">{l.distNone}</p>
          ) : (
            <>
              <Distributions rows={v.distributions} l={l} lang={lang} />
              <ProofCheck distributions={v.distributions} l={l} />
              <StatementCheck distributions={v.distributions} l={l} />
            </>
          )}
        </section>

        <section className="panel vsec" aria-labelledby="sec-recon">
          <h2 id="sec-recon">{l.reconTitle}</h2>
          <p className="note">{l.reconNote}</p>
          <Recon r={v.recon} l={l} />
        </section>

        <p className="fine">{l.privacy}</p>
      </main>
    </PublicPage>
  );
}

function IndexBanner({ v, l }: { v: VerifyView; l: VerifyDict }) {
  const n = v.index.block ?? "—";
  const t = utc(v.index.blockTime);
  switch (v.index.gate) {
    case "halted":
      return (
        <p className="alert" data-gate="halted">
          {fill(l.gateHalted, { n, t })}
        </p>
      );
    case "unavailable":
      return (
        <p className="alert" data-gate="unavailable">
          {l.gateUnavailable}
        </p>
      );
    case "stale":
      return (
        <p className="alert demo" data-gate="stale">
          {fill(l.gateStale, { n })}
        </p>
      );
    case "ok":
      return (
        <p className="chip asof" data-gate="ok">
          <span className="dot" aria-hidden="true" />
          {fill(l.asOf, { n })} · {fill(l.asOfTime, { t })}
        </p>
      );
  }
}

function Disclosures({ l }: { l: VerifyDict }) {
  return (
    <details className="panel vsec disclosures" open>
      <summary>
        <h2>{l.discTitle}</h2>
      </summary>
      <ul className="steps-list numbered">
        <li>{l.disc1}</li>
        <li>{l.disc2}</li>
        <li>{l.disc3}</li>
        <li>{l.disc4}</li>
        <li>{l.disc5}</li>
      </ul>
    </details>
  );
}

function Supply({ token, v, l, lang }: { token: PublicToken; v: VerifyView; l: VerifyDict; lang: Lang }) {
  const r = token.register;
  return (
    <>
      <div className="kpi-strip" data-testid="supply">
        <div>
          <small>{l.totalSupply}</small>
          <b data-testid="total-supply">{formatNumber(BigInt(token.supply), lang)}</b>
        </div>
        <div>
          <small>{l.trusteeCap}</small>
          <b>{formatNumber(BigInt(token.cap), lang)}</b>
        </div>
        <div>
          <small>{l.holders}</small>
          <b>{token.holders === null ? "—" : formatNumber(token.holders, lang)}</b>
        </div>
        <div>
          <small>{l.trading}</small>
          <b className="small-b">{token.paused ? l.paused : l.live}</b>
          {token.pauseReason && <small className="mono">{fill(l.pauseReason, { t: token.pauseReason })}</small>}
        </div>
      </div>
      <p className="fine">{l.holdersNote}</p>
      <div className="register" data-register={r.kind}>
        <h3>{l.registerTitle}</h3>
        {r.kind === "not-published" && (
          <p>
            <span className="chip gray">{l.notAvailable}</span> {l.registerNotPublished}
          </p>
        )}
        {r.kind === "match" && (
          <p>
            <span className="chip green">✓</span> {fill(l.registerMatch, { n: r.units })}
          </p>
        )}
        {r.kind === "mismatch" && (
          <p className="alert">
            ✗ {fill(l.registerMismatch, { n: r.units, c: r.supply })}
          </p>
        )}
      </div>
      <dl className="kv vkv">
        <dt>
          {token.symbol} · {l.tokenContract}
        </dt>
        <dd className="mono">{token.address}</dd>
        <dt>{l.chain}</dt>
        <dd className="mono">{v.chainId}</dd>
      </dl>
    </>
  );
}

function Anchors({ a, l, now }: { a: AnchorSection; l: VerifyDict; now: string }) {
  if (a.state === "not-configured")
    return (
      <p className="alert demo" data-anchor-state="not-configured">
        {l.anchorNotConfigured}
      </p>
    );
  const head = (
    <dl className="kv vkv">
      <dt>{l.anchorContract}</dt>
      <dd className="mono">
        {a.contract} · chain {a.chainId}
      </dd>
    </dl>
  );
  if (a.state === "no-access")
    return (
      <>
        {head}
        <p className="alert demo" data-anchor-state="no-access">
          {l.anchorNoAccess}
        </p>
      </>
    );
  if (a.state === "unavailable")
    return (
      <>
        {head}
        <p className="alert" data-anchor-state="unavailable">
          {l.anchorUnavailable}
        </p>
      </>
    );
  const latest = a.anchors.find((x) => x.status === "confirmed");
  const fresh = anchorFresh(latest?.confirmedAt ? new Date(latest.confirmedAt) : null, new Date(now));
  const age = fresh.ageMs === null ? null : ageParts(fresh.ageMs);
  return (
    <>
      {head}
      {a.chainId === LOCAL_ANCHOR_CHAIN_ID && <p className="chip warn">{fill(l.anchorStandIn, { n: String(a.chainId) })}</p>}
      {!a.publicReachable && <p className="alert">{l.anchorUnreachable}</p>}
      <dl className="kv vkv">
        <dt>{l.anchorLast}</dt>
        <dd className="mono">{a.lastAnchoredBlock ?? "—"}</dd>
        <dt>{l.anchorAge}</dt>
        <dd>
          {age === null ? "—" : `${String(age.value)} ${age.unit}`} {fresh.ageMs !== null && !fresh.fresh && <span className="chip warn">{l.anchorOld}</span>}
        </dd>
      </dl>
      {a.anchors.length === 0 ? <p className="note">{l.anchorNone}</p> : <AnchorList anchors={a.anchors} l={l} />}
      <p className="fine">{fill(l.anchorServerRead, { h: a.contract })}</p>
    </>
  );
}

function Distributions({ rows, l, lang }: { rows: PublicDistribution[]; l: VerifyDict; lang: Lang }) {
  const label = { published: l.dist_published, rejected: l.dist_rejected, finalized: l.dist_finalized, paid: l.dist_paid } as const;
  const chip = { published: "amber", rejected: "red", finalized: "green", paid: "green" } as const;
  return (
    <div className="glass table-wrap">
      <table className="table" data-testid="distributions">
        <thead>
          <tr>
            <th>{l.distId}</th>
            <th>{l.distStatus}</th>
            <th>{l.distRecord}</th>
            <th className="n">{l.distTotal}</th>
            <th>{l.distRoot}</th>
            <th>{l.distStatement}</th>
            <th>{l.distPublished}</th>
            <th>{l.distUpdated}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => (
            <tr key={d.id} data-distribution={d.id}>
              <td className="mono">#{d.id}</td>
              <td>
                <span className={`chip ${chip[d.status]}`}>{label[d.status]}</span>
                {d.rejectReason && <div className="di small">{fill(l.distReason, { t: d.rejectReason })}</div>}
              </td>
              <td className="mono">#{d.recordBlock}</td>
              <td className="n">{formatPkr(rupees(d.totalPaisa), lang)}</td>
              <td className="mono small cy" title={d.root}>
                {short(d.root)}
              </td>
              <td className="mono small" title={d.statementHash}>
                {short(d.statementHash)}
              </td>
              <td className="mono small">{utc(d.publishedAt)}</td>
              <td className="mono small">
                {utc(d.updatedAt)}
                {d.payoutBatchHash && (
                  <div className="di" title={d.payoutBatchHash}>
                    {l.distPayout}: {short(d.payoutBatchHash)}
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Recon({ r, l }: { r: ReconStatus; l: VerifyDict }) {
  switch (r.state) {
    case "no-access":
      return (
        <p className="note" data-recon="no-access">
          <span className="chip gray">{l.notAvailable}</span> {l.reconNoAccess}
        </p>
      );
    case "unavailable":
      return <p className="note">{l.reconUnavailable}</p>;
    case "none":
      return <p className="note">{l.reconNone}</p>;
    case "ok":
      return (
        <p data-recon={r.status}>
          <span className={`chip ${r.status === "passed" ? "green" : "red"}`}>{r.status === "passed" ? l.reconPassed : l.reconFailed}</span>{" "}
          {fill(l.reconAt, { t: utc(r.finishedAt) })}
        </p>
      );
  }
}

import { randomUUID } from "node:crypto";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { RedemptionForm } from "@/components/exit/RedemptionForm";
import { WithdrawForm } from "@/components/exit/WithdrawForm";
import { PortalShell } from "@/components/Shell";
import {
  canRequest,
  exitTimeline,
  paymentTone,
  ppmPercent,
  requestTone,
  shortAddress,
  type ExitCase,
  type ExitHolding,
  type ExitOverview,
  type RedemptionRequest,
} from "@/lib/exit-rules";
import { formatNumber, loc, type Lang } from "@/lib/i18n";
import { exitDict, exitLabel, type ExitDict } from "@/lib/i18n-exit";
import { fill } from "@/lib/i18n-verify";
import { formatPaisa, formatPkt, isUuid } from "@/lib/offering-rules";
import { PROPERTIES } from "@/lib/properties";
import { exitOverview } from "@/lib/server/exit";
import { getDict } from "@/lib/server/lang";
import { logError } from "@/lib/server/log";
import { liveToken } from "@/lib/server/readmodel";
import { currentSession } from "@/lib/server/session";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Exit and redemption · Property Token" };

/**
 * The signed-in investor's exit page (S-05 sections 14-15): per held token the exit status as a
 * plain-language timeline, the final entitlement (gross, WHT, net, payment, units cancelled), open
 * redemption windows with their indicative price, a non-binding request form, and the investor's
 * requests with withdraw. Everything comes from webauth.web_exit_overview (migration 0027).
 */
export default async function ExitPage({ searchParams }: { searchParams: Promise<{ req?: string }> }) {
  const session = await currentSession();
  if (!session) redirect("/login");
  const { lang } = await getDict();
  const l = exitDict(lang);
  const { req } = await searchParams;
  const highlight = req && isUuid(req) ? req : null;

  let overview: ExitOverview | "session" | null;
  try {
    overview = await exitOverview(session.hash);
  } catch (e) {
    logError("exit-overview", e);
    overview = null;
  }
  if (overview === "session") redirect("/login");

  // The prototype's live property: its token address gives the holding a name.
  const names = new Map<string, string>();
  for (const p of PROPERTIES) {
    const t = await liveToken(p.symbol).catch(() => null);
    if (t) names.set(t.address.toLowerCase(), loc(p.name, lang));
  }
  const tokenName = (token: string): string => names.get(token) ?? `${l.token} ${shortAddress(token)}`;

  return (
    <PortalShell active="exit" title={l.title}>
      <p className="meta">{l.intro}</p>
      <section className="panel exit-disc" aria-labelledby="exit-disc">
        <h2 id="exit-disc">{l.discTitle}</h2>
        <ul className="disc-list small">
          <li>{l.discNotGuaranteed}</li>
          <li>{l.discUnitsCancelled}</li>
          <li>{l.discTax}</li>
          <li>{l.discPhase0}</li>
        </ul>
      </section>

      {overview === null ? (
        <p className="note" role="status">
          {l.loadError}
        </p>
      ) : !overview.verified && overview.holdings.length === 0 ? (
        <p className="note" data-testid="exit-not-verified">
          {l.notVerified}
        </p>
      ) : (
        <>
          {/* No longer verified but still holding or owed: status and entitlement stay visible, requests do not. */}
          {!overview.verified && (
            <p className="note" data-testid="exit-not-verified">
              {l.notVerifiedShort}
            </p>
          )}
          {highlight && overview.requests.some((r) => r.id === highlight) && (
            <p className="alert ok" role="status" data-testid="exit-requested">
              {l.justRequested}
            </p>
          )}
          {overview.holdings.length === 0 ? (
            <div className="panel">
              <p className="note">{l.noHoldings}</p>
            </div>
          ) : (
            <ul className="exit-list" data-testid="exit-holdings">
              {overview.holdings.map((h) => (
                <HoldingCard key={h.token} h={h} o={overview} l={l} lang={lang} name={tokenName(h.token)} />
              ))}
            </ul>
          )}
          <RequestsPanel requests={overview.requests} l={l} lang={lang} tokenName={tokenName} highlight={highlight} />
        </>
      )}
      <p className="hint">{l.allTimesPkt}</p>
    </PortalShell>
  );
}

function HoldingCard({ h, o, l, lang, name }: { h: ExitHolding; o: ExitOverview; l: ExitDict; lang: Lang; name: string }) {
  const id = `h-${h.token}`;
  return (
    <li className="panel exit-card" data-token={h.token} aria-labelledby={id}>
      <div className="row-between">
        <h2 id={id} className="offer-title">
          {name}
        </h2>
        {h.paused && (
          <span className="chip gray" title={l.pausedNote}>
            {l.pausedChip}
          </span>
        )}
      </div>
      <dl className="kv">
        <dt>{l.token}</dt>
        <dd className="mono" dir="ltr">
          {shortAddress(h.token)}
        </dd>
        <dt>{l.unitsHeld}</dt>
        <dd data-testid="units-held">{formatNumber(h.units, lang)}</dd>
      </dl>
      <ExitStatus c={h.exit} l={l} lang={lang} />
      <section aria-label={l.windowsTitle} className="exit-sec">
        <h3>{l.windowsTitle}</h3>
        {h.windows.length === 0 ? (
          <p className="note">{l.noWindows}</p>
        ) : (
          <ul className="win-list">
            {h.windows.map((w) => (
              <li key={w.id} className="win" data-window={w.id}>
                <div className="row-between">
                  <b>{fill(l.windowN, { n: w.id })}</b>
                  <span className={`chip ${w.full ? "gray" : w.open ? "ok" : "warn"}`} data-testid="window-state">
                    {exitLabel(l, "w_", w.full ? "full" : w.open ? "open" : "soon")}
                  </span>
                </div>
                <p className="small mu">{fill(l.windowDates, { a: formatPkt(w.opensAt, lang), b: formatPkt(w.closesAt, lang) })}</p>
                <dl className="kv">
                  <dt>{l.nav}</dt>
                  <dd>{formatPaisa(w.navPerUnitPaisa, lang)}</dd>
                  <dt>{l.discount}</dt>
                  <dd>{fill(l.discountN, { p: ppmPercent(w.discountPpm) })}</dd>
                  <dt>{l.indicativePrice}</dt>
                  <dd>
                    <strong data-testid="indicative-price">{formatPaisa(w.pricePerUnitPaisa, lang)}</strong>
                  </dd>
                </dl>
                <p className="hint">{l.indicativeNote}</p>
                {canRequest(w, h, o.verified, o.requests) ? (
                  <RedemptionForm
                    l={l}
                    lang={lang}
                    windowId={w.id}
                    requestId={randomUUID()}
                    pricePerUnitPaisa={w.pricePerUnitPaisa.toString()}
                    freeUnits={h.units.toString()}
                    freeUnitsText={formatNumber(h.units, lang)}
                  />
                ) : (
                  o.requests.some((r) => r.windowId === w.id && r.status === "submitted") && <p className="note">{l.haveRequest}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </li>
  );
}

function ExitStatus({ c, l, lang }: { c: ExitCase | null; l: ExitDict; lang: Lang }) {
  if (!c) {
    return (
      <section aria-label={l.exitStatus} className="exit-sec">
        <h3>{l.exitStatus}</h3>
        <p className="note" data-testid="no-exit">
          {l.noExit}
        </p>
      </section>
    );
  }
  const tl = exitTimeline(c.state);
  const f = c.final;
  return (
    <section aria-label={l.exitStatus} className="exit-sec" data-testid="exit-status" data-state={c.state}>
      <div className="row-between">
        <h3>{l.exitStatus}</h3>
        <span className={`chip ${tl.outcome ? "gray" : c.state === "closed" ? "ok" : "warn"}`}>{exitLabel(l, "st_", c.state)}</span>
      </div>
      {tl.outcome ? (
        <p className="note">{exitLabel(l, "out_", tl.outcome)}</p>
      ) : (
        <>
          <ol className="otl long" aria-label={l.exitStatus}>
            {tl.steps.map((x) => (
              <li key={x.step} className={x.status} aria-current={x.status === "current" ? "step" : undefined}>
                <span className="otl-dot" aria-hidden="true">
                  {x.status === "done" ? "✓" : x.status === "current" ? "•" : ""}
                </span>
                <span>{exitLabel(l, "step_", x.step)}</span>
              </li>
            ))}
          </ol>
          <p className="note">{exitLabel(l, "now_", c.state, "")}</p>
        </>
      )}
      <dl className="kv">
        {c.voteOpenedAt && (
          <>
            <dt>{l.voteOpened}</dt>
            <dd>{formatPkt(c.voteOpenedAt, lang)}</dd>
          </>
        )}
        {c.salePricePaisa !== null && (
          <>
            <dt>{l.salePrice}</dt>
            <dd>{formatPaisa(c.salePricePaisa, lang)}</dd>
          </>
        )}
        {c.recordDate && (
          <>
            <dt>{l.recordDate}</dt>
            <dd dir="ltr">{c.recordDate}</dd>
          </>
        )}
        {c.updatedAt && (
          <>
            <dt>{l.updated}</dt>
            <dd>{formatPkt(c.updatedAt, lang)}</dd>
          </>
        )}
      </dl>
      {f && (
        <section className="exit-final" aria-labelledby={`final-${c.caseId}`} data-testid="exit-final">
          <h3 id={`final-${c.caseId}`}>{l.finalTitle}</h3>
          <div className="kv3">
            <div>
              <small>{l.gross}</small>
              <b>{formatPaisa(f.grossPaisa, lang)}</b>
            </div>
            <div>
              <small>{l.wht}</small>
              <b>{formatPaisa(f.whtPaisa, lang)}</b>
            </div>
            <div>
              <small>{l.net}</small>
              <b className="up">{formatPaisa(f.netPaisa, lang)}</b>
            </div>
          </div>
          <dl className="kv">
            <dt>{l.finalUnits}</dt>
            <dd>{formatNumber(f.units, lang)}</dd>
            <dt>{l.payment}</dt>
            <dd>
              <span className={`chip ${paymentTone(f.payment)}`} data-testid="final-payment">
                {exitLabel(l, "pay_", f.payment ?? "pending")}
              </span>
            </dd>
            <dt>{l.unitsCancelled}</dt>
            <dd data-testid="final-burned">{f.burned ? l.yes : l.no}</dd>
            {f.distributionId && (
              <>
                <dt>{l.distribution}</dt>
                <dd className="mono" dir="ltr">
                  #{f.distributionId}
                </dd>
              </>
            )}
          </dl>
          {f.payment === "held" && (
            <p className="note">
              {l.heldNote}{" "}
              <Link href="/account" className="linklike">
                {l.accountLink}
              </Link>
            </p>
          )}
        </section>
      )}
    </section>
  );
}

function RequestsPanel({
  requests,
  l,
  lang,
  tokenName,
  highlight,
}: {
  requests: RedemptionRequest[];
  l: ExitDict;
  lang: Lang;
  tokenName: (t: string) => string;
  highlight: string | null;
}) {
  return (
    <section className="panel exit-reqs" aria-labelledby="exit-reqs">
      <h2 id="exit-reqs">{l.requestsTitle}</h2>
      {requests.length === 0 ? (
        <p className="note">{l.noRequests}</p>
      ) : (
        <ul className="win-list" data-testid="exit-requests">
          {requests.map((r) => (
            <li key={r.id} className={`win ${r.id === highlight ? "hl" : ""}`} data-request={r.id} data-status={r.status}>
              <div className="row-between">
                <b>
                  {tokenName(r.token)} · {fill(l.windowN, { n: r.windowId })}
                </b>
                <span className={`chip ${requestTone(r.status)}`} data-testid="request-status">
                  {exitLabel(l, "rs_", r.status)}
                </span>
              </div>
              <div className="kv3">
                <div>
                  <small>{l.units}</small>
                  <b>{formatNumber(r.units, lang)}</b>
                </div>
                <div>
                  <small>{l.indicativeValue}</small>
                  <b>{formatPaisa(r.indicativePaisa, lang)}</b>
                </div>
                <div>
                  <small>{l.requested}</small>
                  <b className="small">{formatPkt(r.createdAt, lang)}</b>
                </div>
              </div>
              {r.status === "recorded" && <p className="note">{l.recordedNote}</p>}
              {r.status === "under_review" && <p className="note">{l.reviewNote}</p>}
              {r.withdrawable && <WithdrawForm l={l} requestId={r.id} />}
            </li>
          ))}
        </ul>
      )}
      <p className="hint">{l.indicativeNote}</p>
    </section>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AutoRefresh } from "@/components/AutoRefresh";
import { CancelForm } from "@/components/offering/CancelForm";
import { WithdrawForm } from "@/components/offering/WithdrawForm";
import { Countdown } from "@/components/offering/Countdown";
import { PortalShell } from "@/components/Shell";
import type { Lang } from "@/lib/i18n";
import { formatNumber } from "@/lib/i18n";
import { fill } from "@/lib/i18n-verify";
import { label, offeringDict, type OfferingDict } from "@/lib/i18n-offering";
import { canCancel, canWithdraw, formatPaisa, formatPkt, isUuid, stateTone, timeline } from "@/lib/offering-rules";
import { investorById } from "@/lib/server/db";
import { getDict } from "@/lib/server/lang";
import { logError } from "@/lib/server/log";
import { mySubscriptions, offeringById, type MySubscription } from "@/lib/server/offerings";
import { currentInvestorId } from "@/lib/server/session";
import { offeringTitle } from "@/components/offering/OfferingParts";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "My subscriptions · Property Token" };

/**
 * The signed-in investor's offering subscriptions (S-02): status timeline (reserved -> paid ->
 * allocated -> minted at completion, or refunded / cancelled / expired), payment instructions with
 * the backend's payment code while a reservation awaits payment, refund status, cancel before paying.
 */
export default async function SubscriptionsPage({ searchParams }: { searchParams: Promise<{ sub?: string }> }) {
  const id = await currentInvestorId();
  const investor = id ? await investorById(id) : null;
  if (!investor) redirect("/login");
  const { lang } = await getDict();
  const l = offeringDict(lang);
  const { sub } = await searchParams;
  const highlight = sub && isUuid(sub) ? sub : null;
  let subs: MySubscription[] | null;
  try {
    subs = await mySubscriptions(investor);
  } catch (e) {
    logError("subscriptions", e);
    subs = null;
  }
  const titles = new Map<string, string>();
  for (const s of subs ?? []) {
    if (!titles.has(s.offeringId)) {
      const o = await offeringById(s.offeringId).catch(() => null);
      titles.set(s.offeringId, o ? offeringTitle(o, l) : l.unknownPlace);
    }
  }
  // Server time for the countdowns (no Date.now() during client rendering).
  const now = Date.now();
  const waiting = (subs ?? []).some((s) => s.state === "payment_pending" || s.state === "initiated");

  return (
    <PortalShell active="subscriptions" title={l.myTitle}>
      <p className="meta">{l.myIntro}</p>
      {waiting && <AutoRefresh seconds={10} />}
      {!investor.kyc_subject ? (
        <p className="note">{l.noKycRecord}</p>
      ) : subs === null ? (
        <p className="note">{l.err_generic}</p>
      ) : subs.length === 0 ? (
        <div className="panel">
          <p className="note">{l.myNone}</p>
          <Link href="/offerings" className="btn secondary">
            {l.browse}
          </Link>
        </div>
      ) : (
        <ul className="sub-list" data-testid="subscriptions">
          {subs.map((s) => (
            <SubscriptionCard key={s.subscriptionId} s={s} l={l} lang={lang} title={titles.get(s.offeringId) ?? ""} now={now} highlight={s.subscriptionId === highlight} />
          ))}
        </ul>
      )}
    </PortalShell>
  );
}

function SubscriptionCard({ s, l, lang, title, now, highlight }: { s: MySubscription; l: OfferingDict; lang: Lang; title: string; now: number; highlight: boolean }) {
  const tl = timeline(s.state, s.events);
  const current = tl.steps.find((x) => x.status === "current")?.step;
  return (
    <li className={`panel sub-card ${highlight ? "hl" : ""}`} data-sub={s.subscriptionId} data-state={s.state} aria-labelledby={`sub-${s.subscriptionId}`}>
      {highlight && (
        <p className="alert ok" role="status">
          {l.justReserved}
        </p>
      )}
      <div className="row-between">
        <h2 id={`sub-${s.subscriptionId}`} className="offer-title">
          <Link href={`/offerings/${s.offeringId}`}>{title}</Link>
        </h2>
        <span className={`chip ${stateTone(s.state)}`} data-testid="sub-state">
          {label(l, "sub_", s.state)}
        </span>
      </div>
      <div className="kv3">
        <div>
          <small>{l.units}</small>
          <b>{formatNumber(s.units, lang)}</b>
        </div>
        <div>
          <small>{l.amount}</small>
          <b>{formatPaisa(s.amountPaisa, lang)}</b>
        </div>
        <div>
          <small>{l.created}</small>
          <b className="small">{formatPkt(s.createdAt, lang)}</b>
        </div>
      </div>

      <ol className="otl" aria-label={l.status}>
        {tl.steps.map((x) => (
          <li key={x.step} className={x.status} aria-current={x.status === "current" ? "step" : undefined}>
            <span className="otl-dot" aria-hidden="true">
              {x.status === "done" ? "✓" : x.status === "stopped" ? "✕" : x.status === "current" ? "•" : ""}
            </span>
            <span>
              <b>{label(l, "step_", x.step)}</b>
              {x.at && <span className="small mu"> · {formatPkt(x.at, lang)}</span>}
            </span>
          </li>
        ))}
      </ol>
      {tl.outcome ? (
        <p className="note" data-testid="sub-outcome">
          {label(l, "out_", tl.outcome)}
          {s.publicReason && (tl.outcome === "rejected" || tl.outcome === "kyc_pending") ? ` (${s.publicReason})` : ""}
        </p>
      ) : (
        current && current !== "reserved" && <p className="note">{label(l, "next_", current, "")}</p>
      )}

      {s.state === "payment_pending" && s.paymentCode && <PaymentPanel s={s} l={l} lang={lang} now={now} />}

      {s.refundStatus && (
        <p className="small" data-testid="refund">
          <b>{l.refund}:</b> {fill(l.refundLine, { s: label(l, "rs_", s.refundStatus), c: label(l, "rc_", s.refundCause ?? "", "") })}
          {s.refundSentAt ? ` · ${fill(l.sentAt, { t: formatPkt(s.refundSentAt, lang) })}` : ""}
        </p>
      )}
      {s.mintTx && (
        <p className="small">
          {l.mintTx}:{" "}
          <span className="mono" dir="ltr">
            {s.mintTx.slice(0, 18)}…
          </span>
        </p>
      )}
      {canCancel(s.state) && <CancelForm l={l} subscriptionId={s.subscriptionId} queued={s.state !== "payment_pending"} />}
      {s.withdrawalUntil && canWithdraw(s.state, s.withdrawalUntil, now) && (
        <WithdrawForm l={l} subscriptionId={s.subscriptionId} until={fill(l.withdrawUntil, { t: formatPkt(s.withdrawalUntil, lang) })} />
      )}
    </li>
  );
}

/** Payment instructions produced by the backend (code, exact amount, expiry, escrow account). No bank details are collected here. */
function PaymentPanel({ s, l, lang, now }: { s: MySubscription; l: OfferingDict; lang: Lang; now: number }) {
  return (
    <section className="raast" aria-labelledby={`pay-${s.subscriptionId}`} data-testid="pay">
      <div className="raast-head" id={`pay-${s.subscriptionId}`}>
        {l.payTitle}
      </div>
      <p className="small">{fill(l.payIntro, { a: formatPaisa(s.amountPaisa, lang) })}</p>
      <dl className="kv">
        <dt>{l.payTo}</dt>
        <dd className="mono" dir="ltr" data-testid="pay-to">
          {s.payToAccount ?? <span className="am">{l.payToMissing}</span>}
        </dd>
        <dt>{l.payCode}</dt>
        <dd className="mono big-code" dir="ltr" data-testid="pay-code">
          {s.paymentCode}
        </dd>
        <dt>{l.payAmount}</dt>
        <dd data-testid="pay-amount">{formatPaisa(s.amountPaisa, lang)}</dd>
        <dt>{l.payBy}</dt>
        <dd>{formatPkt(s.expiresAt, lang)}</dd>
        {s.expiresAt && (
          <>
            <dt>{l.timeLeft}</dt>
            <dd>
              <Countdown expiresAt={s.expiresAt} serverNow={now} upText={l.timeUp} />
            </dd>
          </>
        )}
      </dl>
      <ul className="steps-list small">
        <li>{l.payWarnExact}</li>
        <li>{l.payWarnOwn}</li>
        <li>{l.payWarnNever}</li>
      </ul>
    </section>
  );
}

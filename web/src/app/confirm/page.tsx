import { randomUUID } from "node:crypto";
import Link from "next/link";
import { redirect } from "next/navigation";
import { cancelAppOrderAction } from "@/app/actions/market";
import { declineAppRequestAction } from "@/app/actions/offering";
import { offeringTitle } from "@/components/offering/OfferingParts";
import { AppOrderForm } from "@/components/AppOrderForm";
import { CancelForm } from "@/components/offering/CancelForm";
import { ReserveForm } from "@/components/offering/ReserveForm";
import { WithdrawForm } from "@/components/offering/WithdrawForm";
import { PortalShell } from "@/components/Shell";
import { confirmDict } from "@/lib/i18n-confirm";
import { offeringDict } from "@/lib/i18n-offering";
import { fill } from "@/lib/i18n-verify";
import { priceBand } from "@/lib/market-rules";
import { canCancel, canWithdraw, formatPaisa, formatPkt } from "@/lib/offering-rules";
import { findProperty } from "@/lib/properties";
import { APP_CODE, isOrderRequest, lookupAppRequest } from "@/lib/server/app-requests";
import { getDict } from "@/lib/server/lang";
import { investorById } from "@/lib/server/db";
import { mySubscriptions, offeringById } from "@/lib/server/offerings";
import { currentSession } from "@/lib/server/session";

export const dynamic = "force-dynamic";

/**
 * Confirming a reservation the mobile app asked for (ADR 0018 amendment 1, migration 0060). The
 * investor sees the request, accepts the documents and reserves through the website's own path
 * (passkey step-up 'offering.reserve' where they have a passkey); the subscription is then bound to
 * the app's request. Or they decline it. Nothing is reserved by the app alone.
 *
 * Amendment 2 (migration 0061): a cancel or withdraw the app asked for runs through the website's
 * own cancel / withdraw (passkey step-up 'offering.cancel' / 'offering.withdraw'); the database then
 * marks the request confirmed only when the subscription really changed.
 *
 * Amendment 4 (migration 0063): cancelling an open market order the app asked for runs the website's
 * own order cancellation; the request is confirmed only when the order really is cancelled.
 */
export default async function ConfirmPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await currentSession();
  if (!session) redirect("/login");
  const q = await searchParams;
  const { lang, t } = await getDict();
  const l = confirmDict(lang);
  const lo = offeringDict(lang);
  const raw = typeof q.code === "string" ? q.code.trim().toUpperCase() : "";
  const code = APP_CODE.test(raw) ? raw.replace("-", "") : "";
  const request = code ? await lookupAppRequest(session.hash, code) : null;
  const offering = request && !isOrderRequest(request) ? await offeringById(request.offering_id) : null;
  // Reserve, cancel and withdraw requests (migrations 0060, 0061); orders are shown above them.
  const subRequest = request && !isOrderRequest(request) ? request : null;
  const sub = typeof q.sub === "string" && /^[0-9a-f-]{36}$/.test(q.sub) ? q.sub : null;
  // A cancel / withdraw request acts on one of the investor's own subscriptions.
  const target =
    request && (request.kind === "cancel" || request.kind === "withdraw") && request.subscription_id
      ? ((await mySubscriptions((await investorById(session.investorId)) ?? { kyc_subject: null })).find((x) => x.subscriptionId === request.subscription_id) ?? null)
      : null;
  const now = Date.now();

  // A market order request (migration 0062): the price band of the token, for the error text.
  const nav = request?.kind === "order" ? findProperty(request.symbol)?.navPkr : undefined;
  const band = nav === undefined ? null : priceBand(nav);

  const status = q.done
    ? l.done
    : q.unbound
      ? l.bindFailed
      : q.declined
        ? l.declined
        : q.changed
          ? l.changed
          : q.unlinked
            ? l.unlinked
            : q.ordered
              ? l.ordered
              : q.orderunlinked
                ? l.orderUnlinked
                : q.ordercancelled
                  ? l.orderCancelled
                  : q.ordercancelfailed
                    ? l.orderCancelFailed
                    : null;
  const failed = Boolean(q.unbound ?? q.unlinked ?? q.orderunlinked ?? q.ordercancelfailed);
  return (
    <PortalShell active="subscriptions" title={l.title}>
      <section className="panel" style={{ maxInlineSize: 640 }}>
        {status ? (
          <p className={failed ? "alert" : "up"} role="status" data-testid="confirm-status">
            {status} {sub ? <Link href={`/subscriptions?sub=${sub}`}>→</Link> : null}
          </p>
        ) : null}
        <p className="note">
          {request?.kind === "cancel"
            ? l.introCancel
            : request?.kind === "withdraw"
              ? l.introWithdraw
              : request?.kind === "order"
                ? l.introOrder
                : request?.kind === "order_cancel"
                  ? l.introOrderCancel
                  : l.intro}
        </p>
        <p className="fine">{l.warning}</p>
        {!request ? (
          <form method="get" action="/confirm" className="form" style={{ marginBlockStart: 12 }}>
            {code ? (
              <div className="alert" role="alert">
                {l.notFound}
              </div>
            ) : null}
            <label>
              {l.code}
              <input name="code" defaultValue={raw} dir="ltr" maxLength={9} autoComplete="off" required placeholder="BCDF-GHJK" />
            </label>
            <button type="submit" className="btn secondary">
              {l.find}
            </button>
          </form>
        ) : isOrderRequest(request) ? (
          <>
            <dl className="kv" data-testid="confirm-request">
              <dt>{l.symbol}</dt>
              <dd dir="ltr">{request.symbol}</dd>
              <dt>{l.side}</dt>
              <dd>{request.side === "buy" ? l.buy : l.sell}</dd>
              <dt>{l.price}</dt>
              <dd>{formatPaisa(BigInt(request.price_paisa), lang)}</dd>
              <dt>{l.tokens}</dt>
              <dd dir="ltr">{request.tokens}</dd>
              <dt>{l.total}</dt>
              <dd>{formatPaisa(BigInt(request.total_paisa), lang)}</dd>
              <dt>{l.expires}</dt>
              <dd>{formatPkt(request.expires_at, lang)}</dd>
            </dl>
            {request.kind === "order_cancel" ? (
              <form action={cancelAppOrderAction} style={{ marginBlockStart: 12 }}>
                <input type="hidden" name="appCode" value={code} />
                <button type="submit" className="btn" data-testid="cancel-app-order">
                  {l.cancelOrder}
                </button>
              </form>
            ) : (
              <AppOrderForm t={t} lang={lang} appCode={code} band={band ? { min: Number(band.min) / 100, max: Number(band.max) / 100 } : null} label={l.placeOrder} />
            )}
            <form action={declineAppRequestAction} style={{ marginBlockStart: 10 }}>
              <input type="hidden" name="appCode" value={code} />
              <button type="submit" className="btn secondary small">
                {l.decline}
              </button>
            </form>
          </>
        ) : subRequest ? (
          <>
            <dl className="kv" data-testid="confirm-request">
              {subRequest.kind !== "reserve" ? (
                <>
                  <dt>{l.subscription}</dt>
                  <dd dir="ltr">{(subRequest.subscription_id ?? "").slice(0, 8)}</dd>
                </>
              ) : null}
              <dt>{l.offering}</dt>
              <dd>{offering ? offeringTitle(offering, lo) : subRequest.offering_id.slice(0, 8)}</dd>
              <dt>{l.units}</dt>
              <dd dir="ltr">{subRequest.units}</dd>
              <dt>{l.amount}</dt>
              <dd>{subRequest.amount_paisa ? formatPaisa(BigInt(subRequest.amount_paisa), lang) : "—"}</dd>
              <dt>{l.expires}</dt>
              <dd>{formatPkt(subRequest.expires_at, lang)}</dd>
            </dl>
            {subRequest.kind === "cancel" ? (
              target && canCancel(target.state) ? (
                <CancelForm l={lo} subscriptionId={target.subscriptionId} queued={target.state !== "payment_pending"} appCode={code} />
              ) : (
                <p className="alert">{l.notFound}</p>
              )
            ) : subRequest.kind === "withdraw" ? (
              target?.withdrawalUntil && canWithdraw(target.state, target.withdrawalUntil, now) ? (
                <WithdrawForm l={lo} subscriptionId={target.subscriptionId} until={fill(lo.withdrawUntil, { t: formatPkt(target.withdrawalUntil, lang) })} appCode={code} />
              ) : (
                <p className="alert">{l.notFound}</p>
              )
            ) : offering?.docEnSha && offering.docUrSha && offering.riskSha ? (
              <ReserveForm
                l={lo}
                lang={lang}
                offeringId={offering.offeringId}
                requestId={randomUUID()}
                pricePaisa={offering.pricePaisa.toString()}
                minUnits={offering.minUnits.toString()}
                maxUnits={offering.maxUnits.toString()}
                docEnSha={offering.docEnSha}
                docUrSha={offering.docUrSha}
                riskSha={offering.riskSha}
                appCode={code}
                fixedUnits={subRequest.units}
              />
            ) : (
              <p className="alert">{l.notFound}</p>
            )}
            <form action={declineAppRequestAction} style={{ marginBlockStart: 10 }}>
              <input type="hidden" name="appCode" value={code} />
              <button type="submit" className="btn secondary small">
                {l.decline}
              </button>
            </form>
          </>
        ) : null}
      </section>
    </PortalShell>
  );
}

import { randomUUID } from "node:crypto";
import Link from "next/link";
import { redirect } from "next/navigation";
import { declineAppRequestAction } from "@/app/actions/offering";
import { offeringTitle } from "@/components/offering/OfferingParts";
import { CancelForm } from "@/components/offering/CancelForm";
import { ReserveForm } from "@/components/offering/ReserveForm";
import { WithdrawForm } from "@/components/offering/WithdrawForm";
import { PortalShell } from "@/components/Shell";
import { confirmDict } from "@/lib/i18n-confirm";
import { offeringDict } from "@/lib/i18n-offering";
import { fill } from "@/lib/i18n-verify";
import { canCancel, canWithdraw, formatPaisa, formatPkt } from "@/lib/offering-rules";
import { APP_CODE, lookupAppRequest } from "@/lib/server/app-requests";
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
 */
export default async function ConfirmPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await currentSession();
  if (!session) redirect("/login");
  const q = await searchParams;
  const { lang } = await getDict();
  const l = confirmDict(lang);
  const lo = offeringDict(lang);
  const raw = typeof q.code === "string" ? q.code.trim().toUpperCase() : "";
  const code = APP_CODE.test(raw) ? raw.replace("-", "") : "";
  const request = code ? await lookupAppRequest(session.hash, code) : null;
  const offering = request ? await offeringById(request.offering_id) : null;
  const sub = typeof q.sub === "string" && /^[0-9a-f-]{36}$/.test(q.sub) ? q.sub : null;
  // A cancel / withdraw request acts on one of the investor's own subscriptions.
  const target =
    request && request.kind !== "reserve" && request.subscription_id
      ? ((await mySubscriptions((await investorById(session.investorId)) ?? { kyc_subject: null })).find((x) => x.subscriptionId === request.subscription_id) ?? null)
      : null;
  const now = Date.now();

  const status = q.done ? l.done : q.unbound ? l.bindFailed : q.declined ? l.declined : q.changed ? l.changed : q.unlinked ? l.unlinked : null;
  const failed = Boolean(q.unbound ?? q.unlinked);
  return (
    <PortalShell active="subscriptions" title={l.title}>
      <section className="panel" style={{ maxInlineSize: 640 }}>
        {status ? (
          <p className={failed ? "alert" : "up"} role="status" data-testid="confirm-status">
            {status} {sub ? <Link href={`/subscriptions?sub=${sub}`}>→</Link> : null}
          </p>
        ) : null}
        <p className="note">{request?.kind === "cancel" ? l.introCancel : request?.kind === "withdraw" ? l.introWithdraw : l.intro}</p>
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
        ) : (
          <>
            <dl className="kv" data-testid="confirm-request">
              {request.kind !== "reserve" ? (
                <>
                  <dt>{l.subscription}</dt>
                  <dd dir="ltr">{(request.subscription_id ?? "").slice(0, 8)}</dd>
                </>
              ) : null}
              <dt>{l.offering}</dt>
              <dd>{offering ? offeringTitle(offering, lo) : request.offering_id.slice(0, 8)}</dd>
              <dt>{l.units}</dt>
              <dd dir="ltr">{request.units}</dd>
              <dt>{l.amount}</dt>
              <dd>{request.amount_paisa ? formatPaisa(BigInt(request.amount_paisa), lang) : "—"}</dd>
              <dt>{l.expires}</dt>
              <dd>{formatPkt(request.expires_at, lang)}</dd>
            </dl>
            {request.kind === "cancel" ? (
              target && canCancel(target.state) ? (
                <CancelForm l={lo} subscriptionId={target.subscriptionId} queued={target.state !== "payment_pending"} appCode={code} />
              ) : (
                <p className="alert">{l.notFound}</p>
              )
            ) : request.kind === "withdraw" ? (
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
                fixedUnits={request.units}
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
        )}
      </section>
    </PortalShell>
  );
}

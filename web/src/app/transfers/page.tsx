import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AutoRefresh } from "@/components/AutoRefresh";
import { Countdown } from "@/components/offering/Countdown";
import { PortalShell } from "@/components/Shell";
import { AcceptForm } from "@/components/transfer/AcceptForm";
import { CodeForm } from "@/components/transfer/CodeForm";
import { CopyButton } from "@/components/transfer/CopyButton";
import { RequestForm } from "@/components/transfer/RequestForm";
import { WithdrawForm } from "@/components/transfer/WithdrawForm";
import { formatNumber, type Lang } from "@/lib/i18n";
import { fill } from "@/lib/i18n-verify";
import { tlabel, transferDict, type TransferDict } from "@/lib/i18n-transfer";
import { formatPaisa, formatPkt, isUuid } from "@/lib/offering-rules";
import { investorById } from "@/lib/server/db";
import { getDict } from "@/lib/server/lang";
import { logError } from "@/lib/server/log";
import { currentSession } from "@/lib/server/session";
import { myTransfers } from "@/lib/server/transfers";
import { shortHex, tokenChoices, transferTone, type TransferCase, type TransferList } from "@/lib/transfer-rules";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Transfers · Property Token" };

/**
 * Off-market transfers between verified investors (S-04 phase 0, spec 16.9): my transfers as sender
 * or receiver with investor-facing states only, the buyer's payment instructions, the 48-hour
 * on-chain window, settlement or refund; receive codes; request, accept and withdraw. Everything
 * comes from webauth.web_transfers (session-bound): never the other investor's identity.
 */
export default async function TransfersPage({ searchParams }: { searchParams: Promise<{ case?: string }> }) {
  const session = await currentSession();
  const investor = session ? await investorById(session.investorId) : null;
  if (!session || !investor) redirect("/login");
  const { lang } = await getDict();
  const l = transferDict(lang);
  const { case: caseParam } = await searchParams;
  const highlight = caseParam && isUuid(caseParam) ? caseParam : null;
  let list: TransferList | null;
  try {
    list = await myTransfers(session.hash);
  } catch (e) {
    logError("transfers", e);
    list = null;
  }
  // Server time for the countdowns (no Date.now() during client rendering).
  const now = Date.now();
  const moving = (list?.cases ?? []).some((c) => (c.status === "approved" && c.payment !== null) || c.status === "on_chain");
  const verified = list?.verified === true;
  const choices = list ? tokenChoices(list) : [];

  return (
    <PortalShell active="transfers" title={l.title}>
      <p className="meta">{l.intro}</p>
      <p className="fine">{l.allTimesPkt}</p>
      {moving && <AutoRefresh seconds={15} />}
      <Disclosures l={l} />

      {!investor.kyc_subject ? (
        <p className="note">{l.noKycRecord}</p>
      ) : list === null ? (
        <p className="note">{l.loadError}</p>
      ) : (
        <>
          {!verified && <p className="alert">{l.notVerified}</p>}
          <section aria-labelledby="xfer-mine" className="xfer-section">
            <h2 id="xfer-mine" className="xfer-h">
              {l.myTitle}
            </h2>
            {list.cases.length === 0 ? (
              <p className="note">{l.myNone}</p>
            ) : (
              <ul className="sub-list" data-testid="transfers">
                {list.cases.map((c) => (
                  <CaseCard key={c.id} c={c} l={l} lang={lang} now={now} highlight={c.id === highlight} />
                ))}
              </ul>
            )}
          </section>

          <div className="xfer-grid">
            <section className="panel xfer-panel" aria-labelledby="xfer-receive">
              <h2 id="xfer-receive" className="xfer-h">
                {l.codeTitle}
              </h2>
              <p className="small mu">{l.codeIntro}</p>
              {list.codes.length > 0 && (
                <>
                  <h3 className="xfer-sub">{l.codesLive}</h3>
                  <ul className="xfer-codes" data-testid="codes">
                    {list.codes.map((c) => (
                      <li key={c.code}>
                        <span className="mono" dir="ltr">
                          {c.code}
                        </span>
                        <span className="small mu">{fill(l.expires, { t: formatPkt(c.expiresAt, lang) })}</span>
                        <CopyButton value={c.code} label={l.copy} done={l.copied} />
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <CodeForm l={l} lang={lang} disabled={!verified || list.codes.length >= 3} />
            </section>

            <section className="panel xfer-panel" aria-labelledby="xfer-send">
              <h2 id="xfer-send" className="xfer-h">
                {l.reqTitle}
              </h2>
              <p className="small mu">{l.reqIntro}</p>
              {choices.length === 0 ? <p className="note">{l.reqNoToken}</p> : <RequestForm l={l} lang={lang} choices={choices} disabled={!verified} />}
            </section>
          </div>
        </>
      )}
    </PortalShell>
  );
}

/** Spec section 11: what an investor must know before transferring in phase 0. */
function Disclosures({ l }: { l: TransferDict }) {
  return (
    <section className="panel xfer-disc" aria-labelledby="xfer-disc" data-testid="disclosures">
      <h2 id="xfer-disc" className="xfer-h">
        {l.discTitle}
      </h2>
      <ul className="steps-list small">
        <li>{l.disc1}</li>
        <li>{l.disc2}</li>
        <li>{l.disc3}</li>
        <li>{l.disc4}</li>
        <li>{l.disc5}</li>
        <li>{l.disc6}</li>
        <li>{l.disc7}</li>
      </ul>
    </section>
  );
}

function CaseCard({ c, l, lang, now, highlight }: { c: TransferCase; l: TransferDict; lang: Lang; now: number; highlight: boolean }) {
  const seller = c.role === "seller";
  const paisa = (s: string | null) => (s === null ? "—" : formatPaisa(BigInt(s), lang));
  return (
    <li className={`panel sub-card ${highlight ? "hl" : ""}`} data-case={c.id} data-state={c.status} data-role={c.role} aria-labelledby={`case-${c.id}`}>
      {highlight && seller && (
        <p className="alert ok" role="status">
          {l.justRequested}
        </p>
      )}
      <div className="row-between">
        <h3 id={`case-${c.id}`} className="offer-title">
          {tlabel(l, "con_", c.consideration)} ·{" "}
          <span className="mono small" dir="ltr" title={c.token}>
            {shortHex(c.token)}
          </span>
        </h3>
        <span className="xfer-chips">
          <span className="chip gray">{tlabel(l, "role_", c.role)}</span>
          <span className={`chip ${transferTone(c.status)}`} data-testid="transfer-state">
            {tlabel(l, "st_", c.status)}
          </span>
        </span>
      </div>
      <div className="kv3">
        <div>
          <small>{l.units}</small>
          <b>{formatNumber(BigInt(c.units), lang)}</b>
        </div>
        <div>
          <small>{l.pricePerUnit}</small>
          <b>{c.pricePaisa === null ? l.noPrice : paisa(c.pricePaisa)}</b>
        </div>
        <div>
          <small>{l.total}</small>
          <b>{c.totalPaisa === null ? "—" : paisa(c.totalPaisa)}</b>
        </div>
      </div>
      <dl className="kv">
        <dt>{l.opened}</dt>
        <dd>{formatPkt(c.openedAt, lang)}</dd>
        <dt>{l.updated}</dt>
        <dd>{formatPkt(c.updatedAt, lang)}</dd>
        <dt>{l.agreement}</dt>
        <dd className="mono" dir="ltr" title={c.agreementSha256}>
          {shortHex(c.agreementSha256, 12, 10)}
        </dd>
      </dl>

      {c.awaitingAcceptance && <p className="note">{c.canAccept ? l.waitYou : l.waitBuyer}</p>}
      {c.status === "under_review" && !c.awaitingAcceptance && <p className="note">{l.reviewNote}</p>}
      {c.status === "approved" && seller && <p className="note">{l.sellerPayWait}</p>}
      {c.payment && <PaymentPanel c={c} payment={c.payment} l={l} lang={lang} now={now} />}
      {c.status === "on_chain" && c.eta && (
        <section className="raast" aria-label={l.chainTitle} data-testid="chain-window">
          <div className="raast-head">{l.chainTitle}</div>
          <p className="small">{fill(l.chainNote, { t: formatPkt(c.eta, lang) })}</p>
          <dl className="kv">
            <dt>{l.chainLeft}</dt>
            <dd>
              <Countdown expiresAt={c.eta} serverNow={now} upText={l.timeUp} />
            </dd>
          </dl>
        </section>
      )}
      {c.executedAt && <p className="small">{fill(l.executedAt, { t: formatPkt(c.executedAt, lang) })}</p>}
      {seller && c.status === "transferred" && !c.settlement && c.totalPaisa !== null && <p className="note">{l.settlePending}</p>}
      {c.settlement && (
        <section aria-label={l.settleTitle} data-testid="settlement">
          <h4 className="xfer-sub">{l.settleTitle}</h4>
          <dl className="kv">
            <dt>{l.gross}</dt>
            <dd>{paisa(c.settlement.grossPaisa)}</dd>
            <dt>{l.fee}</dt>
            <dd>{paisa(c.settlement.feePaisa)}</dd>
            <dt>{l.tax}</dt>
            <dd>{paisa(c.settlement.taxPaisa)}</dd>
            <dt>{l.net}</dt>
            <dd>
              <strong>{paisa(c.settlement.netPaisa)}</strong>
            </dd>
            {c.settlement.reference && (
              <>
                <dt>{l.reference}</dt>
                <dd className="mono" dir="ltr">
                  {c.settlement.reference}
                </dd>
              </>
            )}
          </dl>
          {c.settlement.at && <p className="small mu">{fill(l.settledAt, { t: formatPkt(c.settlement.at, lang) })}</p>}
        </section>
      )}
      {!seller && c.status === "refund_pending" && !c.refund && <p className="note">{l.refundPending}</p>}
      {c.refund && (
        <p className="small" data-testid="refund">
          <b>{l.refundTitle}:</b> {fill(l.refundLine, { a: paisa(c.refund.amountPaisa), t: formatPkt(c.refund.at, lang) })}
        </p>
      )}
      {c.canAccept && <AcceptForm l={l} caseId={c.id} expected={c.agreementSha256} />}
      {c.canWithdraw && <WithdrawForm l={l} caseId={c.id} decline={!seller && c.awaitingAcceptance} />}
    </li>
  );
}

/** The buyer's payment instructions from the database (code, exact amount, deadline). No bank details are collected here. */
function PaymentPanel({ c, payment, l, lang, now }: { c: TransferCase; payment: NonNullable<TransferCase["payment"]>; l: TransferDict; lang: Lang; now: number }) {
  const amount = formatPaisa(BigInt(payment.amountPaisa), lang);
  if (payment.paid) return <p className="note">{l.payReceived}</p>;
  return (
    <section className="raast" aria-labelledby={`pay-${c.id}`} data-testid="pay">
      <div className="raast-head" id={`pay-${c.id}`}>
        {l.payTitle}
      </div>
      <p className="small">{fill(l.payIntro, { a: amount })}</p>
      <dl className="kv">
        <dt>{l.payTo}</dt>
        <dd>{l.payToEscrow}</dd>
        <dt>{l.payCode}</dt>
        <dd className="mono big-code" dir="ltr" data-testid="pay-code">
          {payment.code}
        </dd>
        <dt>{l.payAmount}</dt>
        <dd data-testid="pay-amount">{amount}</dd>
        <dt>{l.payBy}</dt>
        <dd>{formatPkt(payment.payUntil, lang)}</dd>
        <dt>{l.timeLeft}</dt>
        <dd>
          <Countdown expiresAt={payment.payUntil} serverNow={now} upText={l.timeUp} />
        </dd>
      </dl>
      <ul className="steps-list small">
        <li>{l.payWarnOwn}</li>
        <li>{l.payWarnExact}</li>
        <li>{l.payWarnNever}</li>
      </ul>
    </section>
  );
}

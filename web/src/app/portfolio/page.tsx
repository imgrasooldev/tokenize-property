import Link from "next/link";
import { redirect } from "next/navigation";
import { PortalShell, Sample } from "@/components/Shell";
import { VerifyRent } from "@/components/VerifyRent";
import { tokenAbi } from "@/lib/abis";
import { formatNumber, formatPkr, formatPrice, loc, type Dict } from "@/lib/i18n";
import { MAX_HOLDING_TOKENS } from "@/lib/invest-rules";
import { PROPERTIES } from "@/lib/properties";
import { liveToken } from "@/lib/server/chain";
import { db, investorById } from "@/lib/server/db";
import { publicClient } from "@/lib/server/demo-signer";
import { investorAccount, reconcileThrottled, refUsedOnChain, subscriptionsOf, type SubscriptionStatus } from "@/lib/server/invest";
import { getDict } from "@/lib/server/lang";
import { balanceOf, chainProblemsCached } from "@/lib/server/ledger";
import { cashOf, escrowMatches, escrowOf, ordersOf, tradesOf } from "@/lib/server/market";
import { distributionsFor } from "@/lib/server/rent";
import { currentInvestorId } from "@/lib/server/session";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function statusChip(s: SubscriptionStatus, t: Dict) {
  switch (s) {
    case "done":
      return <span className="chip green">{t.subDone}</span>;
    case "refunded":
      return <span className="chip gray">{t.subRefunded}</span>;
    case "review":
      return <span className="chip red">{t.subReview}</span>;
    case "minting":
      return <span className="chip amber">{t.subMinting}</span>;
    case "paid":
      return <span className="chip amber">{t.subPaid}</span>;
  }
}

const short = (h: string) => `${h.slice(0, 10)}…${h.slice(-6)}`;
const rupees = (paisa: bigint) => Number(paisa) / 100;
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

export default async function PortfolioPage({ searchParams }: { searchParams: Promise<{ sub?: string }> }) {
  const id = await currentInvestorId();
  const investor = id ? await investorById(id) : null;
  if (!investor) redirect("/login");
  const { lang, t } = await getDict();
  const { sub } = await searchParams;
  const highlight = sub && UUID.test(sub) ? sub : null;

  await reconcileThrottled(investor).catch(() => undefined);
  const subs = await subscriptionsOf(investor.id);

  const holdings = await Promise.all(
    PROPERTIES.filter((p) => p.status === "live").map(async (p) => {
      const live = await liveToken(p.symbol);
      const tokens = live
        ? await publicClient
            .readContract({ address: live.address, abi: tokenAbi, functionName: "balanceOf", args: [investor.wallet_address] })
            .catch(() => null)
        : null;
      return { p, live, tokens };
    }),
  );
  const pool = await db();
  const [ledgerBalance, problems, onChain, distributions, cash, escrow, escrowOk, orders, trades] = await Promise.all([
    balanceOf(pool, investorAccount(investor.id)).catch(() => null),
    chainProblemsCached(pool).catch(() => null),
    Promise.all(subs.map((s) => (s.status === "done" || s.status === "refunded" ? refUsedOnChain(s.ref_id) : Promise.resolve(null)))),
    distributionsFor(investor.wallet_address),
    cashOf(investor.id).catch(() => null),
    escrowOf(investor.id).catch(() => null),
    escrowMatches(investor.id).catch(() => false),
    ordersOf(investor.id).catch(() => []),
    tradesOf(investor.id).catch(() => []),
  ]);
  const openOrders = orders.filter((o) => o.status === "open").length;

  // Money the ledger holds for this investor awaiting tokens must equal the open subscriptions.
  const open = subs.filter((s) => s.status === "paid" || s.status === "minting" || s.status === "review");
  const expectedOwed = open.reduce((a, s) => a + BigInt(s.amount_paisa), 0n);
  const ledgerMatches = ledgerBalance !== null && -ledgerBalance === expectedOwed;
  const chainMatches = subs.every((s, i) => {
    const used = onChain.at(i);
    return s.status === "done" ? used === true : s.status === "refunded" ? used === false : true;
  });
  const checks = [ledgerMatches, chainMatches, problems === 0, escrowOk];
  const passed = checks.filter(Boolean).length;
  const totalTokens = holdings.reduce((a, h) => a + (h.tokens ?? 0n), 0n);
  const totalValue = holdings.reduce((a, h) => a + Number(h.tokens ?? 0n) * h.p.navPkr, 0);
  const invested = subs.filter((s) => s.status === "done").reduce((a, s) => a + BigInt(s.amount_paisa), 0n);
  const justPlaced = highlight ? subs.find((s) => s.id === highlight) : undefined;
  const rentReceived = (distributions ?? []).reduce((a, d) => a + (d.mine && d.status !== "rejected" ? d.mine.amountPaisa : 0n), 0n);
  const main = holdings.at(0);
  const sharePct =
    main?.tokens !== null && main?.tokens !== undefined && main.live && main.live.cap > 0n ? Number((main.tokens * 10_000n) / main.live.cap) / 100 : null;
  const capPct = main?.tokens !== null && main?.tokens !== undefined ? Number((main.tokens * 10_000n) / MAX_HOLDING_TOKENS) / 100 : null;

  // Activity: real records only (issuances, trades, rent), newest first.
  type Ev = { at: Date; kind: "mint" | "trade" | "rent"; text: string; ref: string };
  const events: Ev[] = [
    ...subs
      .filter((s) => s.status === "done")
      .map((s) => ({
        at: s.updated_at,
        kind: "mint" as const,
        text: t.actMint.replace("{n}", formatNumber(BigInt(s.tokens), lang)).replace("{s}", s.symbol).replace("{r}", s.bank_ref),
        ref: s.mint_tx ? short(s.mint_tx) : s.bank_ref,
      })),
    ...trades
      .filter((tr) => tr.status === "settled")
      .map((tr) => ({
        at: tr.updated_at,
        kind: "trade" as const,
        text: (tr.buyer_id === investor.id ? t.actBought : t.actSold)
          .replace("{n}", formatNumber(BigInt(tr.tokens), lang))
          .replace("{s}", tr.symbol)
          .replace("{p}", formatPrice(Number(tr.price_paisa) / 100, lang)),
        ref: tr.transfer_tx ? short(tr.transfer_tx) : "—",
      })),
    ...(distributions ?? [])
      .filter((d) => d.mine)
      .map((d) => ({
        at: d.publishedAt,
        kind: "rent" as const,
        text: t.actRent.replace("{id}", d.id.toString()).replace("{a}", formatPkr(rupees(d.mine?.amountPaisa ?? 0n), lang)),
        ref: short(d.root),
      })),
  ]
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .slice(0, 8);

  // Rent calendar for the current year from the distributions on chain.
  const year = new Date().getUTCFullYear();
  const byMonth = new Map<number, bigint>();
  for (const d of distributions ?? []) {
    if (d.publishedAt.getUTCFullYear() !== year || d.status === "rejected" || !d.mine) continue;
    const m = d.publishedAt.getUTCMonth();
    byMonth.set(m, (byMonth.get(m) ?? 0n) + d.mine.amountPaisa);
  }
  const thisMonth = new Date().getUTCMonth();

  return (
    <PortalShell active="portfolio" title={t.portfolioTitle} titleExtra={<span className="mu small hide-sm">{investor.display_name}</span>}>
      {justPlaced && (
        <div className={`alert ${justPlaced.status === "done" ? "ok" : ""}`} role="status" style={{ marginBlockEnd: 16 }}>
          {justPlaced.status === "done"
            ? t.receiptDone.replace("{n}", formatNumber(BigInt(justPlaced.tokens), lang)).replace("{s}", justPlaced.symbol)
            : justPlaced.status === "refunded"
              ? t.receiptRefunded
              : t.receiptReview}
        </div>
      )}

      <div className="kpi-strip six">
        <div>
          <small>{t.tokensHeld}</small>
          <b>{formatNumber(totalTokens, lang)}</b>
        </div>
        <div>
          <small>{t.valueAtNav}</small>
          <b>{formatPkr(totalValue, lang)}</b>
        </div>
        <div>
          <small>{t.investedHere}</small>
          <b>{formatPkr(rupees(invested), lang)}</b>
        </div>
        <div>
          <small>{t.rentReceived}</small>
          <b className="up">{distributions === null ? "—" : formatPkr(rupees(rentReceived), lang)}</b>
        </div>
        <div>
          <small>{t.cashTitle}</small>
          <b>{cash === null ? "—" : formatPkr(rupees(cash), lang)}</b>
        </div>
        <div>
          <small>{t.openOrders}</small>
          <b>
            <Link href="/market">
              {formatNumber(openOrders, lang)}
              {escrow !== null && escrow > 0n ? ` · ${formatPkr(rupees(escrow), lang)} ${t.reserved}` : ""}
            </Link>
          </b>
        </div>
      </div>

      <div className="dash">
        <div className="stack">
          <section className="panel">
            <div className="row-between">
              <h2>{t.holdingsTitle}</h2>
              <span className="chip ok">
                <span className="dot" aria-hidden="true" /> balanceOf
              </span>
            </div>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t.property}</th>
                    <th className="n">{t.tokens}</th>
                    <th className="n">{t.valueAtNav}</th>
                    <th>{t.shareOfRegister}</th>
                  </tr>
                </thead>
                <tbody>
                  {holdings.map(({ p, live, tokens }) => (
                    <tr key={p.symbol}>
                      <td>
                        <Link href={`/properties/${p.symbol}`}>
                          <b>{loc(p.name, lang)}</b>
                        </Link>
                        <div className="di mono small">{p.symbol}</div>
                      </td>
                      <td className="n">{tokens === null ? "—" : formatNumber(tokens, lang)}</td>
                      <td className="n">{tokens === null ? "—" : formatPkr(Number(tokens) * p.navPkr, lang)}</td>
                      <td>
                        {tokens === null || !live || live.cap === 0n
                          ? "—"
                          : `${formatNumber(Number((tokens * 10_000n + live.cap / 2n) / live.cap) / 100, lang)}%`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="note">{t.holdingsNote}</p>
          </section>

          <div className="ai-box">
            <div className="hd">
              <span className="orb" aria-hidden="true" />
              {t.yourSummary}
              <span className="sp" />
              <span className="chip ai">{t.fromRecords}</span>
              <Sample t={t} soon />
            </div>
            <p className="ai-text">
              {t.sumTokens.replace("{n}", formatNumber(totalTokens, lang)).replace("{v}", formatPkr(totalValue, lang))}{" "}
              {sharePct !== null && capPct !== null && (
                <>
                  {t.sumShare.replace("{s}", formatNumber(sharePct, lang)).replace("{c}", formatNumber(capPct, lang))} <span className="cite">MaxBalance</span>{" "}
                </>
              )}
              {passed === checks.length ? t.sumChecksOk : t.sumChecksBad}
            </p>
            <p className="fine">{t.summaryNote}</p>
          </div>

          <section className="panel">
            <h2>{t.historyTitle}</h2>
            {subs.length === 0 ? (
              <p className="note">{t.noSubscriptions}</p>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>{t.date}</th>
                      <th>{t.tokens}</th>
                      <th>{t.amount}</th>
                      <th>{t.status}</th>
                      <th>{t.mintTx}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {subs.map((s, i) => (
                      <tr key={s.id} className={s.id === highlight ? "hl" : undefined}>
                        <td dir="ltr" className="mono">
                          {s.created_at.toISOString().slice(0, 16).replace("T", " ")}
                        </td>
                        <td>
                          {formatNumber(BigInt(s.tokens), lang)} {s.symbol}
                        </td>
                        <td>{formatPkr(rupees(BigInt(s.amount_paisa)), lang)}</td>
                        <td>
                          {statusChip(s.status, t)}
                          {onChain.at(i) === true && (
                            <span className="chip green" title={t.refUsedTip}>
                              ⛓ ✓
                            </span>
                          )}
                        </td>
                        <td className="mono" title={s.note ?? s.bank_ref}>
                          {s.mint_tx ? short(s.mint_tx) : <span className="meta">{s.bank_ref}</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>

        <aside className="stack">
          <section className="panel">
            <div className="row-between">
              <h2>{t.reconTitle}</h2>
              <span className={`chip ${passed === checks.length ? "ok" : "bad"}`}>
                {passed} / {checks.length}
              </span>
            </div>
            <ul className="steps-list">
              <li>
                <span className={`chip ${ledgerMatches ? "green" : "red"}`}>{ledgerMatches ? "✓" : "✗"}</span> {t.reconLedger}
              </li>
              <li>
                <span className={`chip ${chainMatches ? "green" : "red"}`}>{chainMatches ? "✓" : "✗"}</span> {t.reconChain}
              </li>
              <li>
                <span className={`chip ${problems === 0 ? "green" : "red"}`}>{problems === 0 ? "✓" : "✗"}</span> {t.reconHash}
              </li>
              <li>
                <span className={`chip ${escrowOk ? "green" : "red"}`}>{escrowOk ? "✓" : "✗"}</span> {t.reconEscrow}
              </li>
            </ul>
            <p className="note">{t.reconNote}</p>
          </section>

          <section className="panel">
            <h2>{t.activity}</h2>
            {events.length === 0 ? (
              <p className="note">{t.noActivity}</p>
            ) : (
              <div className="timeline">
                {events.map((e, i) => (
                  <div className="ti" key={`${e.kind}${String(i)}`}>
                    <span className={`chip num ${e.kind === "mint" ? "ok" : e.kind === "rent" ? "warn" : "cy"}`} aria-hidden="true">
                      {e.kind === "mint" ? "⬡" : e.kind === "rent" ? "₨" : "⇄"}
                    </span>
                    <span>{e.text}</span>
                    <span className="mono di small" dir="ltr">
                      {e.ref}
                      <br />
                      {e.at.toISOString().slice(0, 10)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </aside>
      </div>

      <section className="panel" id="rent" style={{ marginBlockStart: 16 }}>
        <div className="row-between">
          <h2>
            {t.rentTitle} · {t.rentAndProofs}
          </h2>
          <span className="chip sample soon">
            {t.taxCert} · {t.comingSoonTag}
          </span>
        </div>
        <div className="cal" aria-label={t.rentCalendar.replace("{y}", String(year))}>
          {MONTHS.map((m, i) => {
            const amt = byMonth.get(i);
            return (
              <div key={m} className={amt !== undefined ? "p" : i === thisMonth ? "n" : ""}>
                <small>{m}</small>
                <b dir="ltr">{amt !== undefined ? `✓ ${formatNumber(Math.round(rupees(amt)), lang)}` : "—"}</b>
              </div>
            );
          })}
        </div>
        <p className="fine">{t.rentCalendar.replace("{y}", String(year))}</p>

        {distributions === null ? (
          <p className="note">{t.chainUnavailable}</p>
        ) : distributions.length === 0 ? (
          <p className="note">{t.noRent}</p>
        ) : (
          <div className="rent-grid">
            {distributions.map((d) => (
              <div key={d.id.toString()} className="rent-item">
                <div className="rent-head">
                  <strong>
                    #{d.id.toString()} · {d.publishedAt.toISOString().slice(0, 10)}
                  </strong>
                  <span className={`chip ${d.status === "rejected" ? "red" : d.status === "published" ? "amber" : "green"}`}>{t[`dist_${d.status}`]}</span>
                </div>
                <dl className="kv">
                  <dt>{t.rentTotal}</dt>
                  <dd>{formatPkr(rupees(d.totalPaisa), lang)}</dd>
                  <dt>{t.rentYours}</dt>
                  <dd>
                    {d.mine ? (
                      <strong className="up">{formatPkr(rupees(d.mine.amountPaisa), lang)}</strong>
                    ) : d.statementAvailable ? (
                      t.notEntitled
                    ) : (
                      <span className="meta">{t.noStatement}</span>
                    )}
                  </dd>
                  <dt>{t.recordBlock}</dt>
                  <dd className="mono">#{d.recordBlock.toString()}</dd>
                  <dt>{t.merkleRoot}</dt>
                  <dd className="mono cy">{short(d.root)}</dd>
                  <dt>{t.statementHash}</dt>
                  <dd className="mono cy">{short(d.statementHash)}</dd>
                </dl>
                {d.mine && (
                  <svg viewBox="0 0 300 92" width="100%" height="92" className="mini-tree" role="img" aria-label={t.merkleRoot}>
                    <g stroke="#22E3F0" strokeOpacity=".45" fill="none">
                      <path d="M150 24 L80 58 M150 24 L220 58" />
                    </g>
                    <g fontFamily="var(--font-mono), monospace" fontSize="10" textAnchor="middle">
                      <rect x="95" y="6" width="110" height="24" rx="8" fill="#1B1347" stroke="#8B5CF6" />
                      <text x="150" y="22" fill="#E8EEF9">
                        root {d.root.slice(0, 6)}…
                      </text>
                      <rect x="20" y="56" width="120" height="30" rx="8" fill="rgba(46,242,181,.12)" stroke="#2EF2B5" />
                      <text x="80" y="75" fill="#2EF2B5">
                        {t.youLeaf} · {formatNumber(Math.round(rupees(d.mine.amountPaisa)), lang)}
                      </text>
                      <rect x="160" y="56" width="120" height="30" rx="8" fill="#0D1838" stroke="#22E3F0" strokeOpacity=".4" />
                      <text x="220" y="75" fill="#8B97AD">
                        {t.proofLen.replace("{n}", String(d.mine.proof.length))}
                      </text>
                    </g>
                  </svg>
                )}
                {d.mine && <VerifyRent t={t} distributionId={d.id.toString()} />}
              </div>
            ))}
          </div>
        )}
        <div className="ai-box" style={{ marginBlockStart: 14 }}>
          <div className="hd">
            <span className="orb" aria-hidden="true" />
            {t.whatProves}
          </div>
          <p className="ai-text">{t.rentNote}</p>
        </div>
      </section>
    </PortalShell>
  );
}

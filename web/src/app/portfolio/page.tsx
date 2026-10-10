import Link from "next/link";
import { redirect } from "next/navigation";
import { VerifyRent } from "@/components/VerifyRent";
import { tokenAbi } from "@/lib/abis";
import { formatNumber, formatPkr, loc, type Dict } from "@/lib/i18n";
import { PROPERTIES } from "@/lib/properties";
import { liveToken } from "@/lib/server/chain";
import { db, investorById } from "@/lib/server/db";
import { publicClient } from "@/lib/server/demo-signer";
import { investorAccount, reconcileThrottled, refUsedOnChain, subscriptionsOf, type SubscriptionStatus } from "@/lib/server/invest";
import { getDict } from "@/lib/server/lang";
import { balanceOf, chainProblemsCached } from "@/lib/server/ledger";
import { cashOf, escrowMatches, escrowOf, ordersOf } from "@/lib/server/market";
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
  const [ledgerBalance, problems, onChain, distributions, cash, escrow, escrowOk, orders] = await Promise.all([
    balanceOf(pool, investorAccount(investor.id)).catch(() => null),
    chainProblemsCached(pool).catch(() => null),
    Promise.all(subs.map((s) => (s.status === "done" || s.status === "refunded" ? refUsedOnChain(s.ref_id) : Promise.resolve(null)))),
    distributionsFor(investor.wallet_address),
    cashOf(investor.id).catch(() => null),
    escrowOf(investor.id).catch(() => null),
    escrowMatches(investor.id).catch(() => false),
    ordersOf(investor.id).catch(() => []),
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
  const totalTokens = holdings.reduce((a, h) => a + (h.tokens ?? 0n), 0n);
  const totalValue = holdings.reduce((a, h) => a + Number(h.tokens ?? 0n) * h.p.navPkr, 0);
  const invested = subs.filter((s) => s.status === "done").reduce((a, s) => a + BigInt(s.amount_paisa), 0n);
  const justPlaced = highlight ? subs.find((s) => s.id === highlight) : undefined;

  return (
    <main className="container">
      <h1 style={{ marginBlock: "24px 6px" }}>{t.portfolioTitle}</h1>
      <p className="meta">{investor.display_name}</p>

      {justPlaced && (
        <div className={`alert ${justPlaced.status === "done" ? "ok" : ""}`} role="status" style={{ marginBlockStart: 16 }}>
          {justPlaced.status === "done"
            ? t.receiptDone.replace("{n}", formatNumber(BigInt(justPlaced.tokens), lang)).replace("{s}", justPlaced.symbol)
            : justPlaced.status === "refunded"
              ? t.receiptRefunded
              : t.receiptReview}
        </div>
      )}

      <div className="stats" style={{ marginBlock: 20 }}>
        <div className="stat">
          <div className="label">{t.tokensHeld}</div>
          <div className="value">{formatNumber(totalTokens, lang)}</div>
        </div>
        <div className="stat">
          <div className="label">{t.valueAtNav}</div>
          <div className="value">{formatPkr(totalValue, lang)}</div>
        </div>
        <div className="stat">
          <div className="label">{t.investedHere}</div>
          <div className="value">{formatPkr(rupees(invested), lang)}</div>
        </div>
        <div className="stat">
          <div className="label">{t.cashTitle}</div>
          <div className="value">{cash === null ? "—" : formatPkr(rupees(cash), lang)}</div>
        </div>
        <div className="stat">
          <div className="label">{t.openOrders}</div>
          <div className="value">
            <Link href="/market">
              {formatNumber(openOrders, lang)}
              {escrow !== null && escrow > 0n ? ` · ${formatPkr(rupees(escrow), lang)} ${t.reserved}` : ""}
            </Link>
          </div>
        </div>
      </div>

      <div className="detail" style={{ paddingBlockStart: 0 }}>
        <div style={{ display: "grid", gap: 20, alignContent: "start", minWidth: 0 }}>
          <section className="panel">
            <h2>{t.holdingsTitle}</h2>
            <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t.property}</th>
                  <th>{t.tokens}</th>
                  <th>{t.valueAtNav}</th>
                  <th>{t.shareOfRegister}</th>
                </tr>
              </thead>
              <tbody>
                {holdings.map(({ p, live, tokens }) => (
                  <tr key={p.symbol}>
                    <td>
                      <Link href={`/properties/${p.symbol}`}>{loc(p.name, lang)}</Link>
                    </td>
                    <td>{tokens === null ? "—" : formatNumber(tokens, lang)}</td>
                    <td>{tokens === null ? "—" : formatPkr(Number(tokens) * p.navPkr, lang)}</td>
                    <td>{tokens === null || !live || live.cap === 0n ? "—" : `${formatNumber(Number((tokens * 10_000n + live.cap / 2n) / live.cap) / 100, lang)}%`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
            <p className="note">{t.holdingsNote}</p>
          </section>

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
                        <td dir="ltr">{s.created_at.toISOString().slice(0, 16).replace("T", " ")}</td>
                        <td>
                          {formatNumber(BigInt(s.tokens), lang)} {s.symbol}
                        </td>
                        <td>{formatPkr(rupees(BigInt(s.amount_paisa)), lang)}</td>
                        <td>
                          {statusChip(s.status, t)}
                          {onChain.at(i) === true && <span className="chip green" title={t.refUsedTip}>⛓ ✓</span>}
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

        <aside style={{ display: "grid", gap: 20, alignContent: "start", minWidth: 0 }}>
          <section className="panel">
            <h2>{t.reconTitle}</h2>
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
            <h2>{t.rentTitle}</h2>
            {distributions === null ? (
              <p className="note">{t.chainUnavailable}</p>
            ) : distributions.length === 0 ? (
              <p className="note">{t.noRent}</p>
            ) : (
              <div style={{ display: "grid", gap: 14 }}>
                {distributions.map((d) => (
                  <div key={d.id.toString()} className="rent-item">
                    <div className="rent-head">
                      <strong>
                        #{d.id.toString()} · {d.publishedAt.toISOString().slice(0, 10)}
                      </strong>
                      <span className={`chip ${d.status === "rejected" ? "red" : d.status === "published" ? "amber" : "green"}`}>
                        {t[`dist_${d.status}`]}
                      </span>
                    </div>
                    <dl className="kv">
                      <dt>{t.rentTotal}</dt>
                      <dd>{formatPkr(rupees(d.totalPaisa), lang)}</dd>
                      <dt>{t.rentYours}</dt>
                      <dd>
                        {d.mine ? (
                          <strong>{formatPkr(rupees(d.mine.amountPaisa), lang)}</strong>
                        ) : d.statementAvailable ? (
                          t.notEntitled
                        ) : (
                          <span className="meta">{t.noStatement}</span>
                        )}
                      </dd>
                      <dt>{t.merkleRoot}</dt>
                      <dd className="mono">{short(d.root)}</dd>
                    </dl>
                    {d.mine && <VerifyRent t={t} distributionId={d.id.toString()} />}
                  </div>
                ))}
              </div>
            )}
            <p className="note">{t.rentNote}</p>
          </section>
        </aside>
      </div>
    </main>
  );
}

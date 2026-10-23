import type { Metadata } from "next";
import { Flash } from "@/components/Decision";
import { Shell } from "@/components/Shell";
import { StepUpForm } from "@/components/StepUp";
import { pkt, short } from "@/lib/format";
import { rupees } from "@/lib/server/operations";
import { considerationLabel, RELATIONS, STATES, transferChip, transferList } from "@/lib/server/transfers";
import { requirePage } from "@/lib/server/session";

export const metadata: Metadata = { title: "Transfers" };

/**
 * S-04 phase 0 off-market transfers (migration 0028, spec section 16): the queue, reference prices,
 * open exit or incident blocks, and the desk's forms. The transfer desk (operations makers) opens,
 * completes and withdraws; one compliance and one trustee officer decide; operations makers and
 * checkers run the cash leg. Everything is enforced by the database; this page lists and explains.
 */
export default async function TransfersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const officer = await requirePage("transfer.read", "/transfers");
  const q = await searchParams;
  const status = typeof q.status === "string" && (STATES as readonly string[]).includes(q.status) ? q.status : null;
  const l = await transferList(officer.sessionHash, status);
  const canOpen = officer.permissions.has("transfer.request");
  const canPrice = officer.permissions.has("transfer.price");
  const canLink = officer.permissions.has("transfer.decide") && officer.roles.includes("compliance_officer");
  const missing = Object.entries(l.policies)
    .filter(([, v]) => !v)
    .map(([k]) => `transfer.${k}`);
  const counts = new Map(Object.entries(l.counts));
  const total = [...counts.values()].reduce((a, b) => a + b, 0);

  return (
    <Shell officer={officer} current="/transfers" title="Transfers">
      <Flash q={q} />
      <nav className="tabs" aria-label="Filter">
        <a href="/transfers" aria-current={!status ? "page" : undefined}>
          All ({total})
        </a>
        {STATES.filter((s) => (counts.get(s) ?? 0) > 0 || s === status).map((s) => (
          <a key={s} href={`/transfers?status=${s}`} aria-current={status === s ? "page" : undefined}>
            {s} ({counts.get(s) ?? 0})
          </a>
        ))}
        <a href="/transfers/audit">Audit trail</a>
      </nav>
      <div className="g2">
        <section className="card" aria-labelledby="cases">
          <h2 id="cases">Cases{status ? ` (${status})` : ""}</h2>
          {l.cases.length === 0 ? (
            <p className="empty">No case.</p>
          ) : (
            <div className="tbl-wrap">
              <table className="t" data-testid="transfer-cases">
                <thead>
                  <tr>
                    <th scope="col">#</th>
                    <th scope="col">State</th>
                    <th scope="col">Kind</th>
                    <th scope="col">Units</th>
                    <th scope="col">Total</th>
                    <th scope="col">Seller → buyer</th>
                    <th scope="col">Decisions</th>
                    <th scope="col">Opened</th>
                  </tr>
                </thead>
                <tbody>
                  {l.cases.map((c) => (
                    <tr key={c.id}>
                      <td className="mono">
                        <a href={`/transfers/${String(c.id)}`}>#{c.id}</a>
                      </td>
                      <td>
                        <span className={transferChip(c.status)}>{c.status}</span>
                        {c.status === "requested" && !c.accepted ? <span className="di small"> · buyer to accept</span> : null}
                      </td>
                      <td>
                        {considerationLabel(c.consideration)}
                        <span className="di small"> · {c.origin}</span>
                      </td>
                      <td className="mono">{c.units}</td>
                      <td className="mono small">{c.totalPaisa ? rupees(c.totalPaisa) : "–"}</td>
                      <td className="mono small">
                        {c.seller} → {c.buyer}
                      </td>
                      <td>{c.approvals}/2</td>
                      <td className="mono small">
                        {c.openedBy} · {pkt(c.openedAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <h2 style={{ marginBlockStart: 12 }}>Open blocks ({l.openBlocks.length})</h2>
          {l.openBlocks.length === 0 ? (
            <p className="empty">No exit or incident block: approvals, payments and executions are not held.</p>
          ) : (
            <ul className="checks" data-testid="open-blocks">
              {l.openBlocks.map((b) => (
                <li key={b.id}>
                  <i className="no" aria-hidden="true">
                    ✕
                  </i>
                  <span className="small">
                    <b>{b.source}</b> {b.ref} · <span className="mono">{short(b.token, 6)}</span> · {b.reason} · since {pkt(b.openedAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card" aria-labelledby="prices">
          <h2 id="prices">Reference price</h2>
          <dl className="kv">
            <dt>Token (signing policy)</dt>
            <dd className="mono small">{l.token ?? "– (no active transfer.propose policy)"}</dd>
            <dt>Reference per unit</dt>
            <dd data-testid="reference-price">{l.referencePrice ? `${rupees(l.referencePrice.pricePaisa)} (${l.referencePrice.source})` : "none"}</dd>
            <dt>Signing policies</dt>
            <dd>{missing.length === 0 ? <span className="chip ok">transfer.propose, execute, cancel active</span> : <span className="chip bad">missing {missing.join(", ")}</span>}</dd>
          </dl>
          {l.prices.length > 0 ? (
            <div className="tbl-wrap">
              <table className="t" data-testid="reference-prices">
                <thead>
                  <tr>
                    <th scope="col">#</th>
                    <th scope="col">Per unit</th>
                    <th scope="col">Valuation SHA-256</th>
                    <th scope="col">Recorded</th>
                  </tr>
                </thead>
                <tbody>
                  {l.prices.map((p) => (
                    <tr key={p.id}>
                      <td className="mono">{p.id}</td>
                      <td className="mono small">{rupees(p.pricePaisa)}</td>
                      <td className="mono small" title={p.reason}>
                        {short(p.evidence, 8)}
                      </td>
                      <td className="mono small">
                        {p.by} · {pkt(p.at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {canPrice ? (
            <StepUpForm csrf={officer.csrf} action="/api/transfers/prices">
              <input name="token" required pattern="0x[0-9a-fA-F]{40}" defaultValue={l.token ?? ""} placeholder="Token address" aria-label="Token" />
              <input name="price" required inputMode="numeric" pattern="[1-9][0-9]*" placeholder="Price per unit in paisa" aria-label="Price per unit (paisa)" />
              <input name="evidence" required pattern="[0-9a-fA-F]{64}" placeholder="SHA-256 of the valuation report" aria-label="Valuation SHA-256" />
              <textarea name="reason" required minLength={10} maxLength={500} placeholder="Reason (valuer, date; no personal data)" aria-label="Reason" />
              <div className="row">
                <button className="btn" type="submit" name="decision" value="record">
                  Record with security key
                </button>
              </div>
            </StepUpForm>
          ) : (
            <p className="small mu">Operations checkers record reference prices (valuation SHA-256 required).</p>
          )}
        </section>
      </div>

      <div className="g2" style={{ marginBlockStart: 12 }}>
        <section className="card" aria-labelledby="open">
          <h2 id="open">Open a case (transfer desk)</h2>
          <p className="di small">
            Parties by their KYC subject id. A desk case needs no buyer acceptance; complete it on the case page once the signed agreement is checked. Nothing moves before a
            compliance and a trustee officer approve, the buyer&apos;s money is in escrow (sale) and the 48-hour delay on chain has passed.
          </p>
          {canOpen ? (
            <div className="stack">
              <StepUpForm csrf={officer.csrf} action="/api/transfers/cases">
                <input name="seller" required pattern="[0-9a-fA-F-]{36}" placeholder="Seller (KYC subject id)" aria-label="Seller" />
                <input name="buyer" required pattern="[0-9a-fA-F-]{36}" placeholder="Buyer (KYC subject id)" aria-label="Buyer" />
                <input name="token" required pattern="0x[0-9a-fA-F]{40}" defaultValue={l.token ?? ""} placeholder="Token address" aria-label="Token" />
                <div className="row">
                  <input name="units" required inputMode="numeric" pattern="[1-9][0-9]*" placeholder="Units" aria-label="Units" />
                  <select name="consideration" aria-label="Consideration" defaultValue="sale">
                    <option value="sale">Sale</option>
                    <option value="gift">Gift</option>
                    <option value="family">Family transfer</option>
                    <option value="court_order">Court order</option>
                  </select>
                </div>
                <input name="price" inputMode="numeric" pattern="[1-9][0-9]*" placeholder="Price per unit in paisa (sale only)" aria-label="Price per unit (paisa)" />
                <textarea name="noPriceReason" maxLength={500} placeholder="Why there is no price (gift, family, court order; at least 10 characters)" aria-label="No-price reason" />
                <input name="agreement" required pattern="[0-9a-fA-F]{64}" placeholder="SHA-256 of the signed agreement or court order" aria-label="Agreement SHA-256" />
                <textarea name="explanation" maxLength={1000} placeholder="Price explanation if outside the band (optional)" aria-label="Price explanation" />
                <textarea name="holdingReason" maxLength={500} placeholder="Reason if the seller keeps less than the minimum (optional)" aria-label="Minimum-holding reason" />
                <div className="row">
                  <button className="btn" type="submit" name="decision" value="open">
                    Open with security key
                  </button>
                </div>
              </StepUpForm>
              <form method="post" action="/api/transfers/sync" className="row" style={{ marginBlockStart: 10 }}>
                <input type="hidden" name="csrf" value={officer.csrf} />
                <button className="btn" type="submit" name="decision" value="sync">
                  Refresh from chain
                </button>
                <span className="di small">Books payments, links on-chain requests, queues executions after the delay (also run by transfer:tick).</span>
              </form>
            </div>
          ) : (
            <p className="small mu">The transfer desk (operations makers) opens and completes cases; your role reads them{officer.permissions.has("transfer.decide") ? " and decides them" : ""}.</p>
          )}
        </section>

        <section className="card" aria-labelledby="sod">
          <h2 id="sod">Conflicts and links</h2>
          <p className="di small">
            Declare a conflict with an investor (relative, related company, own account): you will then not decide that investor&apos;s transfers (TR-SOD-2).
          </p>
          <StepUpForm csrf={officer.csrf} action="/api/transfers/conflicts">
            <input name="subject" required pattern="[0-9a-fA-F-]{36}" placeholder="Investor (KYC subject id)" aria-label="Investor" />
            <textarea name="reason" required minLength={10} maxLength={500} placeholder="Nature of the conflict (no personal data)" aria-label="Conflict reason" />
            <div className="row">
              <button className="btn" type="submit" name="decision" value="declare">
                Declare with security key
              </button>
            </div>
          </StepUpForm>
          <h2 style={{ marginBlockStart: 12 }}>Link two investors</h2>
          {canLink ? (
            <StepUpForm csrf={officer.csrf} action="/api/transfers/links">
              <input name="a" required pattern="[0-9a-fA-F-]{36}" placeholder="First investor (KYC subject id)" aria-label="First investor" />
              <input name="b" required pattern="[0-9a-fA-F-]{36}" placeholder="Second investor (KYC subject id)" aria-label="Second investor" />
              <select name="relation" aria-label="Relation" required defaultValue="">
                <option value="" disabled>
                  Relation…
                </option>
                {RELATIONS.map(([code, label]) => (
                  <option key={code} value={code}>
                    {label}
                  </option>
                ))}
              </select>
              <textarea name="reason" required minLength={10} maxLength={500} placeholder="Source of the link (no personal data)" aria-label="Link reason" />
              <div className="row">
                <button className="btn" type="submit" name="decision" value="link">
                  Record with security key
                </button>
              </div>
            </StepUpForm>
          ) : (
            <p className="small mu">Compliance officers record links between investors; a sale between linked investors raises a surveillance alert.</p>
          )}
        </section>
      </div>
    </Shell>
  );
}

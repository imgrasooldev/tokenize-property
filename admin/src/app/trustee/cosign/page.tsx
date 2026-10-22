import type { Metadata } from "next";
import { Flash } from "@/components/Decision";
import { Shell } from "@/components/Shell";
import { TrusteeTabs } from "@/components/TrusteeTabs";
import { pkt, short } from "@/lib/format";
import { kindLabel, rupees } from "@/lib/server/approvals";
import { requirePage } from "@/lib/server/session";
import { codeLabel, cosignQueue } from "@/lib/server/trustee";

export const metadata: Metadata = { title: "Co-signing" };

/**
 * Work that needs the trustee (Step 6d): signing requests of the kinds the specs assign to the
 * trustee (mints above the threshold, in addition to the platform approvals) and S-02 requests that
 * need the trustee duty (funding, issuance batch, completion and the completion payment batch,
 * register entries).
 */
export default async function CosignPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const officer = await requirePage("trustee.read", "/trustee/cosign");
  const q = await searchParams;
  const c = await cosignQueue(officer.sessionHash);

  return (
    <Shell officer={officer} current="/trustee/cosign" title="Co-signing">
      <TrusteeTabs current="/trustee/cosign" />
      <Flash q={q} />
      <section className="card" aria-labelledby="signer">
        <h2 id="signer">Signing requests waiting for the trustee</h2>
        {c.signer.length === 0 ? (
          <p className="empty">No signing request needs the trustee.</p>
        ) : (
          <div className="tbl-wrap">
            <table className="t" data-testid="cosign-signer">
              <thead>
                <tr>
                  <th scope="col">Request</th>
                  <th scope="col">What</th>
                  <th scope="col">To</th>
                  <th scope="col">Platform</th>
                  <th scope="col">Trustee</th>
                  <th scope="col">Window ends</th>
                </tr>
              </thead>
              <tbody>
                {c.signer.map((r) => (
                  <tr key={r.id}>
                    <td className="mono small">
                      <a href={`/trustee/cosign/signer/${r.id}`}>{short(r.id, 4)}</a>
                    </td>
                    <td>{kindLabel(r.kind, r.amount)}</td>
                    <td className="mono small">{short(r.to)}</td>
                    <td>
                      <span className={r.platformApprovals >= r.approvalsNeeded ? "chip ok" : "chip warn"}>
                        {r.platformApprovals} of {r.approvalsNeeded}
                      </span>
                    </td>
                    <td>{r.trusteeApprovals > 0 ? <span className="chip ok">co-signed</span> : <span className="chip warn">waiting</span>}</td>
                    <td className="small">
                      {pkt(r.expiresAt)} {r.expired ? <span className="chip bad">expired</span> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="card" aria-labelledby="offering">
        <h2 id="offering">Offering requests needing the trustee (S-02)</h2>
        {c.offering.length === 0 ? (
          <p className="empty">No offering request needs the trustee.</p>
        ) : (
          <div className="tbl-wrap">
            <table className="t" data-testid="cosign-offering">
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">Request</th>
                  <th scope="col">Offering</th>
                  <th scope="col">Requested</th>
                  <th scope="col">Expires</th>
                </tr>
              </thead>
              <tbody>
                {c.offering.map((r) => (
                  <tr key={r.id}>
                    <td className="mono">
                      <a href={`/trustee/cosign/offering/${String(r.id)}`}>#{r.id}</a>
                    </td>
                    <td>
                      <b>{codeLabel(r.code)}</b> <span className="mono small mu">{r.code}</span>
                    </td>
                    <td className="mono small">
                      {short(r.offering, 4)} Â· {r.offeringState} {r.token ? `Â· ${short(r.token)}` : ""}
                    </td>
                    <td className="small">
                      <span className="mono">{r.requestedBy}</span> Â· {pkt(r.requestedAt)}
                    </td>
                    <td className="small">{pkt(r.expiresAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <div className="g2">
        <section className="card" aria-labelledby="charges">
          <h2 id="charges">Charges above the operations limit (S-03 OP-21)</h2>
          {c.charges.length === 0 ? (
            <p className="empty">No charge waits for the trustee.</p>
          ) : (
            <ul className="checks" data-testid="cosign-charges">
              {c.charges.map((x) => (
                <li key={x.id}>
                  <i aria-hidden="true">â‚¨</i>
                  <span className="small">
                    <a href={`/trustee/cosign/charge/${String(x.id)}`}>#{x.id}</a> {x.kind} {x.payee ?? ""} Â· {rupees(x.amount)} Â· {x.period} Â·{" "}
                    <span className="mono">{short(x.token)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="card" aria-labelledby="calcs">
          <h2 id="calcs">Distribution calculations to pre-check (S-03 D4)</h2>
          {c.calculations.length === 0 ? (
            <p className="empty">No calculation waits for the trustee&apos;s pre-check.</p>
          ) : (
            <ul className="checks" data-testid="cosign-calculations">
              {c.calculations.map((x) => (
                <li key={x.id}>
                  <i aria-hidden="true">â§—</i>
                  <span className="small">
                    <a href={`/trustee/cosign/calculation/${String(x.id)}`}>#{x.id}</a> {x.period} Â· net {rupees(x.net)} Â· {x.holders} holders Â·{" "}
                    <span className="mono">{short(x.token)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
      <section className="card" aria-labelledby="recent">
        <h2 id="recent">Recent trustee decisions</h2>
        {c.recent.length === 0 ? (
          <p className="empty">None yet.</p>
        ) : (
          <ul className="checks">
            {c.recent.map((x) => (
              <li key={x.id}>
                <i aria-hidden="true">{x.decision === "reject" ? "âœ•" : "âœ“"}</i>
                <span className="small">
                  <span className="mono">{x.actor}</span> {x.decision} {x.action === "cosign.signer" ? "signing request" : x.action === "cosign.offering" ? "offering request" : x.action === "charge.decided" ? "charge" : "calculation"}{" "}
                  <span className="mono">{short(x.ref, 4)}</span> â†’ {x.result} Â· {pkt(x.at)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </Shell>
  );
}

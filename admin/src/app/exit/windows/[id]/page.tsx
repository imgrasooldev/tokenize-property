import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ActionPanel } from "@/components/ActionPanel";
import { Flash } from "@/components/Decision";
import { Shell } from "@/components/Shell";
import { StepUpForm } from "@/components/StepUp";
import { pkt, short } from "@/lib/format";
import { exitChip } from "@/lib/exit";
import { exitWindow } from "@/lib/server/exit";
import { ratePercent, rupees } from "@/lib/server/operations";
import { requirePage } from "@/lib/server/session";

export const metadata: Metadata = { title: "Redemption window" };

/**
 * One redemption window (S-05 section 15, phase 0: a request queue only): its terms, the requests
 * (investor shown as the first 8 hex digits of the KYC reference), the operations checker's
 * decision on the window, the maker's outcome proposal after it closes and the checker's decision
 * on the outcome.
 */
export default async function ExitWindowPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const valid = /^[1-9]\d{0,17}$/.test(id);
  const officer = await requirePage("exit.read", `/exit/windows/${valid ? id : "invalid"}`);
  if (!valid) notFound();
  const q = await searchParams;
  const w = await exitWindow(officer.sessionHash, id);
  if (!w) notFound();
  const decider = officer.permissions.has("exit.decide");
  const maker = officer.permissions.has("exit.request");
  const checker = officer.roles.includes("ops_checker");
  const notChecker = checker ? [] : ["Only an operations checker decides this."];
  const hidden = { kind: "window", ref: String(w.id), digest: w.digest };

  return (
    <Shell officer={officer} current="/exit" title={`Redemption window #${String(w.id)}`}>
      <Flash q={q} />
      <div className="g2">
        <section className="card" aria-labelledby="window">
          <h2 id="window">
            Window <span className="sp" />
            <span className={exitChip(w.status)} data-testid="window-status">
              {w.status}
            </span>{" "}
            {w.open ? <span className="chip ok">open now</span> : w.closed ? <span className="chip">closed</span> : null}
          </h2>
          <dl className="kv">
            <dt>Token</dt>
            <dd className="mono small">{w.token}</dd>
            <dt>Opens – closes</dt>
            <dd className="mono small">
              {pkt(w.opensAt)} – {pkt(w.closesAt)}
            </dd>
            <dt>NAV per unit</dt>
            <dd className="mono small">
              {rupees(w.navPerUnitPaisa)} · evidence {short(w.navSha, 8)}
            </dd>
            <dt>Discount</dt>
            <dd className="mono">{ratePercent(w.discountPpm)}</dd>
            <dt>Indicative price per unit</dt>
            <dd className="mono">{rupees(w.pricePerUnitPaisa)} (indicative, not an offer)</dd>
            <dt>Cap</dt>
            <dd className="mono">{w.capUnits ? `${w.capUnits} units` : "– (set at approval)"}</dd>
            <dt>Note</dt>
            <dd>{w.note}</dd>
            <dt>Proposed by (maker)</dt>
            <dd className="mono">
              {w.proposedBy} · {pkt(w.proposedAt)}
            </dd>
            <dt>Decided</dt>
            <dd className="small">{w.decidedBy ? `${w.decidedBy} · ${w.decisionReason ?? ""}` : "–"}</dd>
            <dt>Outcome</dt>
            <dd className="small">
              <span className={exitChip(w.outcome.status)}>{w.outcome.status}</span>
              {w.outcome.by ? ` · proposed by ${w.outcome.by}` : ""}
              {w.outcome.decidedBy ? ` · decided by ${w.outcome.decidedBy} (${w.outcome.reason ?? ""})` : ""}
            </dd>
          </dl>
        </section>

        <section className="card" aria-labelledby="actions">
          <h2 id="actions">Actions</h2>
          {decider && w.status === "proposed" ? (
            <ActionPanel
              csrf={officer.csrf}
              action="/api/exit/decide"
              hidden={hidden}
              reasonId="reason-window"
              note="Operations checker; not the maker. Approval fixes the cap."
              actions={[
                { action: "approve", label: "Approve the window", blockers: notChecker, tone: "ok" },
                { action: "reject", label: "Reject", blockers: notChecker, tone: "no" },
              ]}
            />
          ) : null}
          {maker && w.status === "approved" && w.outcome.status === "none" ? (
            w.closed ? (
              <StepUpForm csrf={officer.csrf} action="/api/exit/windows">
                <input type="hidden" name="action" value="outcome" />
                <input type="hidden" name="windowId" value={String(w.id)} />
                <div className="row">
                  <button className="btn" type="submit" name="decision" value="outcome">
                    Propose the outcome with security key
                  </button>
                  <span className="di small">Submitted requests become recorded (or declined for investors no longer verified) once a checker approves.</span>
                </div>
              </StepUpForm>
            ) : (
              <p className="small mu">The outcome is proposed after the window closes.</p>
            )
          ) : null}
          {decider && w.outcome.status === "proposed" ? (
            <ActionPanel
              csrf={officer.csrf}
              action="/api/exit/decide"
              hidden={{ ...hidden, kind: "outcome" }}
              reasonId="reason-outcome"
              note="Operations checker; not the maker of the outcome."
              actions={[
                { action: "approve", label: "Approve the outcome", blockers: notChecker, tone: "ok" },
                { action: "reject", label: "Back to the maker", blockers: notChecker, tone: "no" },
              ]}
            />
          ) : null}
          {!decider && !maker ? <p className="small mu">Your role reads redemption windows.</p> : null}
        </section>
      </div>

      <section className="card" aria-labelledby="requests" style={{ marginBlockStart: 12 }}>
        <h2 id="requests">Requests ({w.requests.length})</h2>
        {w.requests.length === 0 ? (
          <p className="empty">No request.</p>
        ) : (
          <div className="tbl-wrap">
            <table className="t" data-testid="window-requests">
              <thead>
                <tr>
                  <th scope="col">Investor</th>
                  <th scope="col">Wallet</th>
                  <th scope="col">Units</th>
                  <th scope="col">Indicative value</th>
                  <th scope="col">Status</th>
                  <th scope="col">Lodged</th>
                </tr>
              </thead>
              <tbody>
                {w.requests.map((r) => (
                  <tr key={r.id}>
                    <td className="mono">{r.subject}…</td>
                    <td className="mono small">{short(r.wallet, 6)}</td>
                    <td className="mono">{r.units}</td>
                    <td className="mono">{rupees(r.indicativePaisa)}</td>
                    <td>
                      <span className={exitChip(r.status)}>{r.status}</span>
                    </td>
                    <td className="mono small">{pkt(r.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </Shell>
  );
}

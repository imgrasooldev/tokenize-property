import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ActionPanel, type PanelAction } from "@/components/ActionPanel";
import { ComplianceTabs } from "@/components/ComplianceTabs";
import { Flash } from "@/components/Decision";
import { Shell } from "@/components/Shell";
import { pkt, short } from "@/lib/format";
import { actionLabel, CASE_ACTIONS, caseKindLabel, kycCase, stateChip } from "@/lib/server/compliance";
import { requirePage } from "@/lib/server/session";

export const metadata: Metadata = { title: "KYC case" };

const TONE: Record<string, PanelAction["tone"]> = { approve: "ok", confirm: "ok", reject: "no", decline: "no" };
const TONES = new Map(Object.entries(TONE));

/**
 * One KYC review case: the investor (short reference, masked CNIC, status, wallet), the provider
 * checks as recorded (outcome, reason code, score, list version; evidence only as a hash, never
 * shown), the two-officer proposal, the case history and every action with the database's reason
 * when it is unavailable to this officer.
 */
export default async function KycCasePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const valid = /^[1-9]\d{0,17}$/.test(id);
  const officer = await requirePage("compliance.read", `/compliance/kyc/${valid ? id : "invalid"}`);
  if (!valid) notFound();
  const q = await searchParams;
  const k = await kycCase(officer.sessionHash, id);
  if (!k) notFound();
  const actions: PanelAction[] = CASE_ACTIONS.map((a) => ({ action: a, label: actionLabel(a), blockers: new Map(Object.entries(k.blockers)).get(a) ?? [], tone: TONES.get(a) ?? "plain" }));
  const live = ["open", "info_requested", "pending_second"].includes(k.status);
  const canDecide = officer.permissions.has("compliance.decide");

  return (
    <Shell officer={officer} current="/compliance/kyc" title={`KYC case #${String(k.id)}`}>
      <ComplianceTabs current="/compliance/kyc" />
      <Flash q={q} />
      <div className="g2">
        <section className="card" aria-labelledby="case">
          <h2 id="case">
            {caseKindLabel(k.kind)} <span className="sp" />
            <span className={k.risk === "high" ? "chip bad" : "chip"}>{k.risk} risk</span>{" "}
            <span className={stateChip(k.status)} data-testid="case-status">
              {k.status.replace("_", " ")}
            </span>
          </h2>
          <p style={{ marginBlockEnd: 8 }}>{k.summary}</p>
          <dl className="kv">
            <dt>Flags</dt>
            <dd>{k.flags.length ? k.flags.map((f) => <span key={f} className="chip warn">{f.replace(/_/g, " ")}</span>) : "–"}</dd>
            <dt>Decision rule</dt>
            <dd>{k.twoOfficers ? "two different compliance officers (maker-checker, enforced in the database)" : "one compliance officer"}</dd>
            <dt>Opened</dt>
            <dd>
              <span className="mono">{k.openedBy}</span> · {pkt(k.openedAt)}
            </dd>
            <dt>Proposal</dt>
            <dd data-testid="proposal">
              {k.proposal ? (
                <>
                  <b>{k.proposal}</b> by <span className="mono">{k.proposedBy}</span> · {pkt(k.proposedAt)} · {k.proposalReason}
                </>
              ) : (
                "–"
              )}
            </dd>
            {k.clearance ? (
              <>
                <dt>KYC clearance (Y-4)</dt>
                <dd className="mono small">
                  #{k.clearance.id} {k.clearance.proposal} · {k.clearance.status} · expires {pkt(k.clearance.expiresAt)}
                </dd>
              </>
            ) : null}
            <dt>Decided</dt>
            <dd>{k.decidedBy ? `${k.decidedBy} · ${pkt(k.decidedAt)} · ${k.decisionReason ?? ""}` : "–"}</dd>
          </dl>
        </section>

        <section className="card" aria-labelledby="inv">
          <h2 id="inv">Investor</h2>
          <dl className="kv" data-testid="subject">
            <dt>Reference</dt>
            <dd className="mono">{k.subject.ref}</dd>
            <dt>CNIC</dt>
            <dd className="mono">{k.subject.cnic}</dd>
            <dt>KYC status</dt>
            <dd>
              <span className={stateChip(k.subject.status)}>{k.subject.status}</span>{" "}
              {k.subject.status !== k.subject.underlyingStatus ? <span className="mu small">(own status {k.subject.underlyingStatus})</span> : null}
            </dd>
            <dt>Reason</dt>
            <dd className="small">{k.subject.decisionReason ?? "–"}</dd>
            <dt>Valid until</dt>
            <dd>{pkt(k.subject.validUntil)}</dd>
            <dt>Wallet</dt>
            <dd className="mono small">{k.subject.wallet ? short(k.subject.wallet, 6) : "none bound"}</dd>
            <dt>Compliance hold</dt>
            <dd>{k.subject.hold ? <a href={`/compliance/freezes/${String(k.subject.hold.freezeRequest)}`}>held since {pkt(k.subject.hold.placedAt)}</a> : "none"}</dd>
            <dt>Other cases</dt>
            <dd>
              {k.otherCases.length === 0
                ? "–"
                : k.otherCases.map((o) => (
                    <a key={o.id} className="mono small" href={`/compliance/kyc/${String(o.id)}`} style={{ marginInlineEnd: 6 }}>
                      #{o.id} {o.status}
                    </a>
                  ))}
            </dd>
          </dl>
          <p className="di small" style={{ marginBlockStart: 8 }}>
            Name and full CNIC are never shown here (rule Y-1): they exist only sealed in the KYC service.
          </p>
        </section>
      </div>

      <section className="card" aria-labelledby="checks">
        <h2 id="checks">Provider checks (latest first)</h2>
        <div className="tbl-wrap">
          <table className="t" data-testid="checks">
            <thead>
              <tr>
                <th scope="col">Check</th>
                <th scope="col">Kind</th>
                <th scope="col">Outcome</th>
                <th scope="col">Reason code</th>
                <th scope="col" className="n">
                  Score
                </th>
                <th scope="col">List</th>
                <th scope="col">Provider</th>
                <th scope="col">At</th>
              </tr>
            </thead>
            <tbody>
              {k.checks.map((c) => (
                <tr key={c.id} className={c.id === k.checkId ? "hl" : undefined}>
                  <td className="mono">#{c.id}</td>
                  <td>{c.kind}</td>
                  <td>
                    <span className={c.outcome === "pass" ? "chip ok" : c.outcome === "review" ? "chip warn" : "chip bad"}>{c.outcome}</span>
                  </td>
                  <td className="mono small">{c.reason}</td>
                  <td className="n">{c.score ?? "–"}</td>
                  <td className="mono small">{c.listVersion ?? "–"}</td>
                  <td className="mono small">{c.provider}</td>
                  <td className="small">{pkt(c.at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="g2">
        <section className="card" aria-labelledby="act">
          <h2 id="act">Your decision</h2>
          <ActionPanel
            csrf={officer.csrf}
            action={`/api/compliance/kyc/${String(k.id)}/act`}
            hidden={{ digest: k.digest }}
            actions={actions}
            note="Recorded in the compliance, KYC and admin audit chains."
          />
          {canDecide && live ? (
            <p className="di small" style={{ marginBlockStart: 8 }}>
              Rejecting a manual case revokes the investor&apos;s verification (final; the wallet is then frozen by the offboarding service). Need a freeze now?{" "}
              <a href="/compliance/freezes">Propose a freeze</a>.
            </p>
          ) : null}
        </section>

        <section className="card" aria-labelledby="hist">
          <h2 id="hist">History</h2>
          <ul className="checks" data-testid="events">
            {k.events.map((e, i) => (
              <li key={`${e.at}-${String(i)}`}>
                <i className="wait" aria-hidden="true">
                  •
                </i>
                <span>
                  <b>{actionLabel(e.action)}</b> {e.from ? `${e.from} → ` : ""}
                  {e.to} · <span className="mono small">{e.actor}</span> · {pkt(e.at)}
                  <br />
                  <span className="mu small">{e.reason}</span>
                </span>
              </li>
            ))}
          </ul>
          {canDecide ? (
            <form method="post" action="/api/compliance/rescreen" className="stack" style={{ marginBlockStart: 10 }}>
              <input type="hidden" name="csrf" value={officer.csrf} />
              <input type="hidden" name="subject" value={k.subject.id} />
              <label className="small mu" htmlFor="rescreen-reason">
                Re-screen this investor against the current lists (the KYC service runs it)
              </label>
              <input id="rescreen-reason" name="reason" required minLength={10} maxLength={500} placeholder="Why (at least 10 characters)" />
              <button className="btn" type="submit">
                Queue a re-screening
              </button>
            </form>
          ) : null}
          {canDecide ? (
            <form method="post" action="/api/compliance/kyc" className="stack" style={{ marginBlockStart: 10 }}>
              <input type="hidden" name="csrf" value={officer.csrf} />
              <input type="hidden" name="subject" value={k.subject.id} />
              <label className="small mu" htmlFor="new-case-summary">
                Open another review case for this investor
              </label>
              <select name="risk" aria-label="Risk" defaultValue="standard">
                <option value="standard">standard risk (one officer decides)</option>
                <option value="high">high risk (two officers decide)</option>
              </select>
              <input id="new-case-summary" name="summary" required minLength={10} maxLength={500} placeholder="Why (no CNIC, IBAN or phone number)" />
              <button className="btn" type="submit">
                Open a manual case
              </button>
            </form>
          ) : null}
        </section>
      </div>
    </Shell>
  );
}

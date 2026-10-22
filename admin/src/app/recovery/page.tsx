import type { Metadata } from "next";
import { Flash } from "@/components/Decision";
import { Shell } from "@/components/Shell";
import { StepUpForm } from "@/components/StepUp";
import { pkt, short } from "@/lib/format";
import { caseChip, caseKindLabel, caseList } from "@/lib/server/recovery";
import { requirePage } from "@/lib/server/session";

export const metadata: Metadata = { title: "Recovery & succession" };

const KINDS = ["wallet_recovery", "succession", "reversal"] as const;
const STATES = ["opened", "approved", "executed", "rejected", "cancelled", "closed"] as const;

/**
 * S-06 cases (migration 0020): lost or compromised wallets, successions and reversals of platform
 * errors. Operations makers open and prepare cases; operations checkers, compliance and legal
 * officers decide in their capacity; compliance officers release freezes. Everything is enforced by
 * the database; this page lists and explains.
 */
export default async function RecoveryPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const officer = await requirePage("recovery.read", "/recovery");
  const q = await searchParams;
  const kind = typeof q.kind === "string" && (KINDS as readonly string[]).includes(q.kind) ? q.kind : null;
  const status = typeof q.status === "string" && (STATES as readonly string[]).includes(q.status) ? q.status : null;
  const l = await caseList(officer.sessionHash, kind, status);
  const canOpen = officer.permissions.has("recovery.request");
  const missing = Object.entries(l.policies).filter(([, v]) => !v).map(([k]) => `recovery.${k}`);

  return (
    <Shell officer={officer} current="/recovery" title="Recovery & succession">
      <Flash q={q} />
      <nav className="tabs" aria-label="Filter">
        <a href="/recovery" aria-current={!kind && !status ? "page" : undefined}>
          All
        </a>
        {KINDS.map((k) => (
          <a key={k} href={`/recovery?kind=${k}`} aria-current={kind === k ? "page" : undefined}>
            {caseKindLabel(k)}
          </a>
        ))}
        <a href="/audit/recovery">Audit trail</a>
      </nav>
      <div className="g2">
        <section className="card" aria-labelledby="cases">
          <h2 id="cases">Cases{status ? ` (${status})` : ""}</h2>
          {l.cases.length === 0 ? (
            <p className="empty">No case.</p>
          ) : (
            <div className="tbl-wrap">
              <table className="t" data-testid="recovery-cases">
                <thead>
                  <tr>
                    <th scope="col">#</th>
                    <th scope="col">Kind</th>
                    <th scope="col">State</th>
                    <th scope="col">Investor / journal</th>
                    <th scope="col">Wallet</th>
                    <th scope="col">Decisions</th>
                    <th scope="col">Opened</th>
                  </tr>
                </thead>
                <tbody>
                  {l.cases.map((c) => (
                    <tr key={c.id}>
                      <td className="mono">
                        <a href={`/recovery/${String(c.id)}`}>#{c.id}</a>
                      </td>
                      <td>{caseKindLabel(c.kind)}</td>
                      <td>
                        <span className={caseChip(c.status)}>{c.status}</span>
                      </td>
                      <td className="mono small">{c.subject ?? (c.journal ? `journal ${String(c.journal)}` : "–")}</td>
                      <td className="mono small">{c.wallet ? short(c.wallet, 6) : "–"}</td>
                      <td>
                        {c.approvals}/{c.needed}
                      </td>
                      <td className="mono small">
                        {c.openedBy} · {pkt(c.openedAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="di small" style={{ marginBlockStart: 8 }}>
            States:{" "}
            {STATES.map((s) => (
              <a key={s} href={`/recovery?status=${s}`} style={{ marginInlineEnd: 8 }}>
                {s}
              </a>
            ))}
          </p>
        </section>

        <section className="card" aria-labelledby="open">
          <h2 id="open">Open a case</h2>
          <p className="di small">
            Signing policies: {missing.length === 0 ? "all six recovery kinds active" : `missing ${missing.join(", ")}`}. Opening a wallet recovery or succession freezes the wallet
            (protective) and, for a recovery, tells the investor&apos;s contacts of record; nothing moves before two officers approve and the 48-hour delay on chain.
          </p>
          {canOpen ? (
            <div className="stack">
              <b className="small">Lost wallet or succession</b>
              <StepUpForm csrf={officer.csrf} action="/api/recovery/cases">
                <select name="kind" aria-label="Kind" defaultValue="wallet_recovery">
                  <option value="wallet_recovery">Lost / compromised wallet (investor re-verified)</option>
                  <option value="succession">Succession (deceased investor)</option>
                </select>
                <input name="subject" required pattern="[0-9a-fA-F-]{36}" placeholder="Investor reference (KYC subject id)" aria-label="Investor" />
                <textarea name="summary" required minLength={10} maxLength={1000} placeholder="Summary (no CNIC, IBAN or phone number)" aria-label="Summary" />
                <div className="row">
                  <button className="btn" type="submit" name="decision" value="open">
                    Open with security key
                  </button>
                </div>
              </StepUpForm>
              <b className="small" style={{ marginBlockStart: 10 }}>
                Reversal of a platform error
              </b>
              <StepUpForm csrf={officer.csrf} action="/api/recovery/cases">
                <input type="hidden" name="kind" value="reversal" />
                <input name="journal" required inputMode="numeric" pattern="[1-9][0-9]*" placeholder="Ledger journal # booked in error" aria-label="Journal" />
                <select name="reasonCode" aria-label="Reason" required defaultValue="">
                  <option value="" disabled>
                    Platform error…
                  </option>
                  {l.reasons.map((r) => (
                    <option key={r.code} value={r.code}>
                      {r.label}
                    </option>
                  ))}
                </select>
                <input name="evidence" required pattern="[0-9a-fA-F]{64}" placeholder="SHA-256 of the incident evidence" aria-label="Evidence SHA-256" />
                <textarea name="summary" required minLength={10} maxLength={1000} placeholder="What went wrong (no personal data)" aria-label="Summary" />
                <p className="di small">Only journals of these kinds: {l.reversibleKinds.map((k) => k.kind).join(", ")}. Never a trade, a payment with a token movement or anything on chain.</p>
                <div className="row">
                  <button className="btn" type="submit" name="decision" value="open">
                    Open with security key
                  </button>
                </div>
              </StepUpForm>
              <form method="post" action="/api/recovery/sync" className="row" style={{ marginBlockStart: 10 }}>
                <input type="hidden" name="csrf" value={officer.csrf} />
                <button className="btn" type="submit" name="decision" value="sync">
                  Refresh from chain
                </button>
                <span className="di small">Links on-chain requests, queues executions after the delay (also run by recovery:tick).</span>
              </form>
            </div>
          ) : (
            <p className="small mu">Operations makers open and prepare cases; your role reads and decides them.</p>
          )}
        </section>
      </div>
    </Shell>
  );
}

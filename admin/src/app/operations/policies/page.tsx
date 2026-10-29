import type { Metadata } from "next";
import { Flash } from "@/components/Decision";
import { Shell } from "@/components/Shell";
import { StepUpForm } from "@/components/StepUp";
import { pkt } from "@/lib/format";
import { signerPolicies } from "@/lib/server/operations";
import { requirePage } from "@/lib/server/session";

export const metadata: Metadata = { title: "Signing policies" };

/**
 * Signing policies (migration 0039): per kind the active version and the proposals. An operations
 * maker proposes new values with the same fields as the active version; a different checker
 * activates it; the signing service validates the rule again and loads it on its next start.
 */
export default async function SignerPoliciesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const officer = await requirePage("operations.read", "/operations/policies");
  const q = await searchParams;
  const kinds = await signerPolicies(officer.sessionHash);
  const maker = officer.permissions.has("operations.request");
  const checker = officer.permissions.has("operations.decide");
  return (
    <Shell officer={officer} current="/operations" title="Signing policies">
      <Flash q={q} />
      <p className="alert warn" role="note">
        A policy sets what the signing service may sign (limits, approvals, contracts). New fields or kinds are a code change; here only the values of an active policy change.
        After activation, restart pt-signer so it loads the new version.
      </p>
      {kinds.length === 0 ? <p className="empty">No signing policy exists yet.</p> : null}
      <div className="stack" data-testid="signer-policies">
        {kinds.map((k) => (
          <section key={k.kind} className="card" aria-labelledby={`k-${k.kind}`}>
            <h2 id={`k-${k.kind}`} className="mono">
              {k.kind}
              {k.active ? <span className="small mu"> · v{k.active.version}</span> : null}
            </h2>
            {k.active ? (
              <>
                <pre className="mono small" style={{ whiteSpace: "pre-wrap" }}>
                  {JSON.stringify(k.active.rule, null, 2)}
                </pre>
                <p className="small mu">
                  Proposed by {k.active.proposedBy}, approved by {k.active.approvedBy ?? "–"} · {pkt(k.active.approvedAt)}
                </p>
              </>
            ) : (
              <p className="empty">No active version.</p>
            )}
            {k.proposals.map((p) => (
              <article key={p.id} className="card" style={{ background: "rgba(255,255,255,.02)" }} data-testid={`proposal-${String(p.id)}`}>
                <b>
                  Proposal #{p.id} (v{p.version}) by <span className="mono">{p.proposedBy}</span> · {pkt(p.proposedAt)}
                </b>
                <pre className="mono small" style={{ whiteSpace: "pre-wrap" }}>
                  {JSON.stringify(p.rule, null, 2)}
                </pre>
                {checker || p.proposedBy === officer.handle ? (
                  <StepUpForm csrf={officer.csrf} action={`/api/operations/policies/${String(p.id)}/decide`}>
                    <div className="row">
                      {checker && p.proposedBy !== officer.handle ? (
                        <button className="btn ok" type="submit" name="decision" value="approve">
                          Activate with security key
                        </button>
                      ) : null}
                      <button className="btn no" type="submit" name="decision" value="withdraw">
                        Withdraw
                      </button>
                    </div>
                  </StepUpForm>
                ) : null}
              </article>
            ))}
            {maker && k.active && k.proposals.length === 0 ? (
              <StepUpForm csrf={officer.csrf} action="/api/operations/policies">
                <input type="hidden" name="kind" value={k.kind} />
                <label htmlFor={`rule-${k.kind}`}>New values (same fields)</label>
                <textarea id={`rule-${k.kind}`} name="rule" rows={8} className="mono small" defaultValue={JSON.stringify(k.active.rule, null, 2)} required maxLength={8192} />
                <div className="row">
                  <button className="btn" type="submit">
                    Propose (a checker activates)
                  </button>
                </div>
              </StepUpForm>
            ) : null}
          </section>
        ))}
      </div>
    </Shell>
  );
}

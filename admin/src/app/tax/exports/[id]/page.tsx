import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DecisionPanel, Flash } from "@/components/Decision";
import { Shell } from "@/components/Shell";
import { StepUpForm } from "@/components/StepUp";
import { pkt } from "@/lib/format";
import { stateChip } from "@/lib/server/compliance";
import { taxExport } from "@/lib/server/operations";
import { requirePage } from "@/lib/server/session";
import { taxServiceConfigured } from "@/lib/server/tax-service";

export const metadata: Metadata = { title: "FBR filing export" };

/**
 * One FBR filing export (ADR 0014): scope and purpose, the two officers, how many lines are in
 * scope (and whether any lacks a sealed CNIC: then nothing is generated), the decision, and the
 * one-time generation with its recorded SHA-256. The page itself never shows a CNIC.
 */
export default async function ExportPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const valid = /^[1-9]\d{0,17}$/.test(id);
  const officer = await requirePage("tax.read", `/tax/exports/${valid ? id : "invalid"}`);
  if (!valid) notFound();
  const q = await searchParams;
  const e = await taxExport(officer.sessionHash, id);
  if (!e) notFound();
  const generateBlockers = [...e.blockers.generate, ...(taxServiceConfigured() ? [] : ["The tax service client is not configured on this portal."])];

  return (
    <Shell officer={officer} current="/tax/exports" title={`FBR filing export #${String(e.id)}`}>
      <Flash q={q} />
      <div className="g2">
        <section className="card" aria-labelledby="exp">
          <h2 id="exp">
            {e.from} – {e.to} <span className="sp" />
            <span className={stateChip(e.status)} data-testid="export-status">
              {e.status}
            </span>
          </h2>
          <dl className="kv">
            <dt>Token</dt>
            <dd className="mono small">{e.token ?? "every token"}</dd>
            <dt>Purpose</dt>
            <dd>{e.reason}</dd>
            <dt>Lines in scope</dt>
            <dd data-testid="lines-in-scope">
              {e.linesInScope}
              {e.missingCnic > 0 ? <span className="dn"> · {e.missingCnic} without a sealed CNIC</span> : null}
            </dd>
            <dt>Requested by (officer 1)</dt>
            <dd className="mono">
              {e.requestedBy} · {pkt(e.requestedAt)}
            </dd>
            <dt>Decided by (officer 2)</dt>
            <dd>{e.decidedBy ? `${e.decidedBy} · ${pkt(e.decidedAt)} · ${e.decisionReason ?? ""}` : "–"}</dd>
            <dt>Generated</dt>
            <dd className="mono small">{e.generatedBy ? `${e.generatedBy} · ${pkt(e.generatedAt)} · ${String(e.rows ?? 0)} rows · SHA-256 ${e.fileSha256 ?? ""}` : "–"}</dd>
          </dl>
        </section>
        <section className="card" aria-labelledby="dec">
          <h2 id="dec">Approval (second tax officer)</h2>
          <DecisionPanel
            csrf={officer.csrf}
            action={`/api/tax/exports/${String(e.id)}/decide`}
            hidden={{ digest: e.digest }}
            blockers={e.blockers.approve}
            note="Two officers: whoever requested an export cannot approve it."
          />
          <h2 style={{ marginBlockStart: 12 }}>Generate the file</h2>
          {generateBlockers.length > 0 ? (
            <ul className="checks" data-testid="generate-unavailable">
              {generateBlockers.map((b) => (
                <li key={b}>
                  <i className="no" aria-hidden="true">
                    ✕
                  </i>
                  <span>{b}</span>
                </li>
              ))}
            </ul>
          ) : (
            <StepUpForm csrf={officer.csrf} action={`/api/tax/exports/${String(e.id)}/generate`}>
              <p className="small mu">Once only. The file holds full CNICs: store it encrypted and file it with FBR; never e-mail it.</p>
              <button className="btn ok" type="submit" name="decision" value="generate">
                Generate with security key
              </button>
            </StepUpForm>
          )}
        </section>
      </div>
    </Shell>
  );
}

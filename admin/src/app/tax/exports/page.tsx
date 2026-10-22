import type { Metadata } from "next";
import { Flash } from "@/components/Decision";
import { Shell } from "@/components/Shell";
import { StepUpForm } from "@/components/StepUp";
import { pkt, short } from "@/lib/format";
import { stateChip } from "@/lib/server/compliance";
import { taxExports } from "@/lib/server/operations";
import { requirePage } from "@/lib/server/session";

export const metadata: Metadata = { title: "FBR filing exports" };

/**
 * FBR filing exports (ADR 0014): the only place a full CNIC leaves the sealed store. One tax officer
 * requests (step-up, purpose), a different one approves (step-up), then one of the two generates
 * the file once through the tax service, which records its SHA-256 before releasing it.
 */
export default async function ExportsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const officer = await requirePage("tax.read", "/tax/exports");
  const q = await searchParams;
  const list = await taxExports(officer.sessionHash);
  const canExport = officer.permissions.has("tax.export");

  return (
    <Shell officer={officer} current="/tax/exports" title="FBR filing exports">
      <Flash q={q} />
      <p className="alert bad" role="note">
        An export contains full CNICs for the withholding statement. Two different tax officers, a security key each time, one file, recorded before release.
      </p>
      <div className="g2">
        <section className="card" aria-labelledby="list">
          <h2 id="list">Exports</h2>
          {list.length === 0 ? (
            <p className="empty">No export yet.</p>
          ) : (
            <div className="tbl-wrap">
              <table className="t" data-testid="exports">
                <thead>
                  <tr>
                    <th scope="col">#</th>
                    <th scope="col">Scope</th>
                    <th scope="col">State</th>
                    <th scope="col">Requested</th>
                    <th scope="col">Approved</th>
                    <th scope="col">Generated</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((e) => (
                    <tr key={e.id}>
                      <td className="mono">
                        <a href={`/tax/exports/${String(e.id)}`}>#{e.id}</a>
                      </td>
                      <td className="small">
                        {e.from} – {e.to} · <span className="mono">{e.token ? short(e.token) : "all tokens"}</span>
                      </td>
                      <td>
                        <span className={stateChip(e.status)}>{e.status}</span>
                      </td>
                      <td className="small">
                        <span className="mono">{e.requestedBy}</span> · {pkt(e.requestedAt)}
                      </td>
                      <td className="mono small">{e.decidedBy ?? "–"}</td>
                      <td className="small">{e.generatedBy ? `${e.generatedBy} · ${pkt(e.generatedAt)} · ${String(e.rows ?? 0)} rows` : "–"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
        {canExport ? (
          <section className="card" aria-labelledby="req">
            <h2 id="req">Request an export</h2>
            <StepUpForm csrf={officer.csrf} action="/api/tax/exports">
              <input name="token" pattern="0x[0-9a-f]{40}" placeholder="Token address (empty: every token)" aria-label="Token" />
              <input name="from" required pattern="\d{4}-\d{2}" placeholder="From period YYYY-MM" aria-label="From period" />
              <input name="to" required pattern="\d{4}-\d{2}" placeholder="To period YYYY-MM" aria-label="To period" />
              <textarea name="reason" required minLength={10} maxLength={500} placeholder="Purpose (e.g. monthly withholding statement under s.165)" aria-label="Purpose" />
              <button className="btn" type="submit" name="decision" value="request">
                Request with security key
              </button>
            </StepUpForm>
          </section>
        ) : null}
      </div>
    </Shell>
  );
}

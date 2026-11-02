import type { Metadata } from "next";
import Link from "next/link";
import { Flash } from "@/components/Decision";
import { Shell } from "@/components/Shell";
import { pkt } from "@/lib/format";
import { stateChip } from "@/lib/server/compliance";
import { desk, fileName } from "@/lib/server/onboarding";
import { requirePage } from "@/lib/server/session";

export const metadata: Metadata = { title: "Onboarding desk" };

const KIND: Readonly<Record<string, string>> = { request: "Decision asked", possible_duplicate: "Possible duplicate", blocked_submission: "Blocked submission" };

/**
 * The onboarding desk (S-01 maker screens, migration 0049): the work waiting for officers, every
 * sponsor KYB file and property file, the S-01 duties and the valuer panel. The actions live on
 * each file's page; the database applies the S-01 duty, state and maker-checker rules.
 */
export default async function OnboardingPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const officer = await requirePage("property.read", "/onboarding");
  const q = await searchParams;
  const d = await desk(officer.sessionHash);
  const link = (entity: string, id: string): string => `/onboarding/${entity}/${id}`;

  return (
    <Shell officer={officer} current="/onboarding" title="Onboarding desk">
      <Flash q={q} />
      <p className="alert warn" role="note">
        Your S-01 duties: <b>{d.me.duties.length ? d.me.duties.join(", ") : "none"}</b>. What you may do on a file depends on these duties and the file&apos;s state; the
        database explains every refusal. New sponsors are created with <span className="mono">npm run property:run -- createSponsor</span> (it seals the name and
        address with keys the portal does not hold).
      </p>

      <section className="card" aria-labelledby="queue" style={{ marginBlockEnd: 12 }}>
        <h2 id="queue">
          Work queue <span className="sp" />
          <span className="mu small" style={{ fontWeight: 400 }}>
            open decisions, possible duplicates, blocked submissions
          </span>
        </h2>
        {d.queue.length === 0 ? (
          <p className="empty">Nothing waiting.</p>
        ) : (
          <div className="tbl-wrap">
            <table className="t" data-testid="onboarding-queue">
              <thead>
                <tr>
                  <th scope="col">Since</th>
                  <th scope="col">Kind</th>
                  <th scope="col">What</th>
                  <th scope="col">File</th>
                </tr>
              </thead>
              <tbody>
                {d.queue.map((x) => (
                  <tr key={`${x.kind}-${String(x.id)}`}>
                    <td className="nowrap">{pkt(x.since)}</td>
                    <td>{KIND[x.kind] ?? x.kind}</td>
                    <td>{x.what}</td>
                    <td>
                      {x.kind === "request" ? (
                        <Link href={`/approvals/property/${String(x.id)}`}>request #{x.id}</Link>
                      ) : (
                        <Link href={link(x.entity, x.entityId)}>{x.entity}</Link>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="g2">
        <section className="card" aria-labelledby="props">
          <h2 id="props">Property files</h2>
          {d.properties.length === 0 ? <p className="empty">No property yet.</p> : null}
          <div className="tbl-wrap">
            <table className="t" data-testid="onboarding-properties">
              <thead>
                <tr>
                  <th scope="col">Property</th>
                  <th scope="col">Location</th>
                  <th scope="col">State</th>
                  <th scope="col">Since</th>
                </tr>
              </thead>
              <tbody>
                {d.properties.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <Link href={link("property", p.id)}>{fileName(p)}</Link>
                    </td>
                    <td>{[p.district, p.province].filter(Boolean).join(", ") || "–"}</td>
                    <td>
                      <span className={stateChip(p.state)}>{p.state}</span>
                    </td>
                    <td className="nowrap small">{pkt(p.stateSince)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="card" aria-labelledby="sponsors">
          <h2 id="sponsors">Sponsor KYB files</h2>
          {d.sponsors.length === 0 ? <p className="empty">No sponsor file (or none you may see).</p> : null}
          <div className="tbl-wrap">
            <table className="t" data-testid="onboarding-sponsors">
              <thead>
                <tr>
                  <th scope="col">Sponsor</th>
                  <th scope="col">KYB</th>
                  <th scope="col">Valid until</th>
                  <th scope="col">Properties</th>
                </tr>
              </thead>
              <tbody>
                {d.sponsors.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <Link href={link("sponsor", s.id)}>{s.kind === "company" ? `Company · CUIN …${s.cuinLast4 ?? ""}` : `Individual · NTN …${s.ntnLast4 ?? "–"}`}</Link>
                    </td>
                    <td>
                      <span className={stateChip(s.state)}>{s.state}</span>
                    </td>
                    <td className="small">{s.kybValidUntil ? pkt(s.kybValidUntil) : "–"}</td>
                    <td>{s.properties}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <div className="g2" style={{ marginBlockStart: 12 }}>
        <section className="card" aria-labelledby="duties">
          <h2 id="duties">
            S-01 duties <span className="sp" />
            <span className="mu small" style={{ fontWeight: 400 }}>
              administrators manage them on Officers
            </span>
          </h2>
          {d.duties.length === 0 ? <p className="empty">No duty.</p> : null}
          <ul className="small" data-testid="onboarding-duties">
            {d.duties.map((x) => (
              <li key={x.id}>
                <span className="mono">{x.officer}</span> · {x.duty} · <span className={x.status === "active" ? "chip ok" : "chip warn"}>{x.status}</span>
              </li>
            ))}
          </ul>
        </section>
        <section className="card" aria-labelledby="valuers">
          <h2 id="valuers">Valuer panel</h2>
          {d.valuers.length === 0 ? <p className="empty">No valuer.</p> : null}
          <ul className="small">
            {d.valuers.map((v) => (
              <li key={v.id}>
                #{v.id} <span className="mono">{v.licence}</span> · {v.panel} · {v.approvedBy ? <span className="chip ok">approved</span> : <span className="chip warn">awaiting approval</span>}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </Shell>
  );
}

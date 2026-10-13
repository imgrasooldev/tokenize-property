import type { Metadata } from "next";
import { Shell } from "@/components/Shell";
import { StepUpButton } from "@/components/StepUp";
import { pkt, short } from "@/lib/format";
import { roleLabel } from "@/lib/permissions";
import { myCredentials } from "@/lib/server/officers";
import { requirePage } from "@/lib/server/session";

export const metadata: Metadata = { title: "My account" };

export default async function AccountPage() {
  const officer = await requirePage("officer", "/account");
  const creds = await myCredentials(officer.sessionHash);
  const stepUntil = officer.stepUpAt ? new Date(officer.stepUpAt.getTime() + 5 * 60_000) : null;
  const fresh = stepUntil && stepUntil.getTime() > Date.now() ? stepUntil.toISOString() : null;
  return (
    <Shell officer={officer} current="/account" title="My account">
      <div className="g2">
        <section className="card" aria-labelledby="me">
          <h2 id="me">Officer</h2>
          <dl className="kv">
            <dt>Name</dt>
            <dd>{officer.name}</dd>
            <dt>Handle</dt>
            <dd className="mono" data-testid="me-handle">
              {officer.handle}
            </dd>
            <dt>Roles</dt>
            <dd>{officer.roles.map((r) => roleLabel(r)).join(", ") || "none"}</dd>
            <dt>Permissions</dt>
            <dd className="mono small">{[...officer.permissions].sort().join(" · ") || "none"}</dd>
          </dl>
        </section>
        <section className="card" aria-labelledby="ses">
          <h2 id="ses">Session</h2>
          <dl className="kv">
            <dt>Started</dt>
            <dd>{pkt(officer.createdAt)}</dd>
            <dt>Ends at the latest</dt>
            <dd>{pkt(officer.expiresAt)} (8 h)</dd>
            <dt>Ends if idle after</dt>
            <dd>{pkt(officer.idleUntil)} (15 min)</dd>
            <dt>Last step-up</dt>
            <dd>{pkt(officer.stepUpAt)}</dd>
          </dl>
          <div style={{ marginBlockStart: 10 }}>
            <p className="small mu" style={{ marginBlockEnd: 8 }}>
              Approvals need a fresh confirmation with your security key (less than 5 minutes old), checked again by the database.
            </p>
            <StepUpButton csrf={officer.csrf} freshUntil={fresh} />
          </div>
        </section>
      </div>
      <section className="card" aria-labelledby="keys">
        <h2 id="keys">My security keys</h2>
        <div className="tbl-wrap">
          <table className="t">
            <thead>
              <tr>
                <th scope="col">Credential</th>
                <th scope="col">Model (AAGUID)</th>
                <th scope="col">Attestation</th>
                <th scope="col">Transports</th>
                <th scope="col">Enrolled</th>
                <th scope="col">Last used</th>
              </tr>
            </thead>
            <tbody>
              {creds.map((c) => (
                <tr key={c.id}>
                  <td className="mono">{short(c.id, 8)}</td>
                  <td className="mono small">{c.aaguid}</td>
                  <td>{c.fmt}</td>
                  <td>{c.transports.join(", ") || "–"}</td>
                  <td className="mono small">{pkt(c.createdAt)}</td>
                  <td className="mono small">{pkt(c.lastUsedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="small di" style={{ marginBlockStart: 6 }}>
          Device-bound keys only. A lost key is replaced by disabling the officer and re-inviting (maker-checker); adding a backup key is planned
          for Step 6b.
        </p>
      </section>
    </Shell>
  );
}

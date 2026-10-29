import type { Metadata } from "next";
import { Shell } from "@/components/Shell";
import { StepUpForm } from "@/components/StepUp";
import { pkt } from "@/lib/format";
import { ROLE_CONFLICTS, roleLabel, ROLES, conflicts } from "@/lib/permissions";
import { listChanges, listOfficers, managerScopes, type ScopeProperty } from "@/lib/server/officers";
import { requirePage } from "@/lib/server/session";

export const metadata: Metadata = { title: "Officers and roles" };

function place(p: ScopeProperty): string {
  return [p.building, p.district, p.propertyKey].filter(Boolean).join(" · ") || p.id.slice(0, 8);
}

function describe(c: { kind: string; officerHandle: string | null; role: string | null; newHandle: string | null; newName: string | null }): string {
  if (c.kind === "invite") return `Invite ${c.newName ?? ""} (${c.newHandle ?? ""}) as ${c.role ?? ""}`;
  if (c.kind === "grant") return `Grant ${c.role ?? ""} to ${c.officerHandle ?? ""}`;
  if (c.kind === "revoke") return `Revoke ${c.role ?? ""} from ${c.officerHandle ?? ""}`;
  return `Disable ${c.officerHandle ?? ""}`;
}

export default async function OfficersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const officer = await requirePage("officers.read", "/officers");
  const q = await searchParams;
  const [officers, changes, scopes] = await Promise.all([listOfficers(officer.sessionHash), listChanges(officer.sessionHash), managerScopes(officer.sessionHash)]);
  const manage = officer.permissions.has("officers.manage");
  const ok = typeof q.ok === "string" ? q.ok.slice(0, 300) : null;
  const error = typeof q.error === "string" ? q.error.slice(0, 300) : null;
  const open = changes.filter((c) => c.status === "open");
  const others = officers.filter((o) => o.id !== officer.id && o.status !== "disabled");

  return (
    <Shell officer={officer} current="/officers" title="Officers and roles">
      {ok ? (
        <p className="alert ok" role="status" data-testid="officers-ok">
          {ok}
        </p>
      ) : null}
      {error ? (
        <p className="alert bad" role="alert" data-testid="officers-error">
          {error}
        </p>
      ) : null}

      <section className="card" aria-labelledby="list">
        <h2 id="list">
          Officers <span className="sp" />
          <span className="mu small" style={{ fontWeight: 400 }}>
            Hardware keys only · roles held now · segregation of duties enforced by the database
          </span>
        </h2>
        <div className="tbl-wrap">
          <table className="t" data-testid="officers-table">
            <thead>
              <tr>
                <th scope="col">Officer</th>
                <th scope="col">Handle</th>
                <th scope="col">Status</th>
                <th scope="col">Roles</th>
                <th scope="col" className="n">
                  Keys
                </th>
                <th scope="col">Enrolled</th>
                <th scope="col">Last sign-in</th>
              </tr>
            </thead>
            <tbody>
              {officers.map((o) => (
                <tr key={o.id}>
                  <td>
                    {o.name} {o.bootstrap ? <span className="chip warn">bootstrap</span> : null}
                  </td>
                  <td className="mono">{o.handle}</td>
                  <td>
                    <span className={o.status === "active" ? "chip ok" : o.status === "disabled" ? "chip bad" : "chip warn"}>{o.status}</span>
                  </td>
                  <td>
                    <div className="row">
                      {o.roles.map((r) => (
                        <span key={r} className="chip cy">
                          {roleLabel(r)}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="n">{o.credentials}</td>
                  <td className="mono small">{o.enrolledAt ? pkt(o.enrolledAt) : "waiting for enrolment link"}</td>
                  <td className="mono small">{pkt(o.lastLogin)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="small di" style={{ marginBlockStart: 8 }}>
          An approved invitation creates the officer as <b>invited</b>. An operator with server access then issues the one-time enrolment link:{" "}
          <span className="mono">npm run officer -- enrol-link &lt;handle&gt;</span> (30 minutes, shown once, stored hashed).
        </p>
      </section>

      <div className="g2">
        <section className="card" aria-labelledby="pend">
          <h2 id="pend">
            Pending changes <span className="sp" />
            <span className="chip warn">maker-checker · step-up</span>
          </h2>
          {open.length === 0 ? <p className="empty">No open requests.</p> : null}
          <div className="stack">
            {open.map((c) => {
              const mine = c.requestedBy === officer.handle;
              const aboutMe = c.officerHandle === officer.handle;
              return (
                <article key={c.id} className="card" style={{ background: "rgba(255,255,255,.02)" }} data-testid={`change-${c.id}`}>
                  <div className="row">
                    <b>
                      #{c.id} {describe(c)}
                    </b>
                    <span className="sp" />
                    <span className="mono di small">expires {pkt(c.expiresAt)}</span>
                  </div>
                  <p className="small mu">
                    Requested by <span className="mono">{c.requestedBy}</span> at {pkt(c.requestedAt)}: {c.reason}
                  </p>
                  {manage && !mine && !aboutMe ? (
                    <StepUpForm csrf={officer.csrf} action={`/api/officers/changes/${c.id}/decide`}>
                      <label className="sr-only" htmlFor={`r-${c.id}`}>
                        Reason for the decision
                      </label>
                      <textarea id={`r-${c.id}`} name="reason" required minLength={10} maxLength={500} placeholder="Reason (at least 10 characters)" />
                      <div className="row">
                        <button className="btn ok" type="submit" name="decision" value="approve">
                          Approve with security key
                        </button>
                        <button className="btn no" type="submit" name="decision" value="reject">
                          Reject
                        </button>
                      </div>
                    </StepUpForm>
                  ) : (
                    <p className="small di">
                      {mine ? "Your request: another administrator must decide it." : aboutMe ? "About your own account: another administrator decides." : "Read-only."}
                    </p>
                  )}
                </article>
              );
            })}
          </div>
        </section>

        {manage ? (
          <section className="card" aria-labelledby="req">
            <h2 id="req">Request a change</h2>
            <form method="post" action="/api/officers/changes" className="stack" data-testid="request-form">
              <input type="hidden" name="csrf" value={officer.csrf} />
              <div className="field">
                <label htmlFor="kind">Change</label>
                <select id="kind" name="kind" defaultValue="invite">
                  <option value="invite">Invite a new officer</option>
                  <option value="grant">Grant a role</option>
                  <option value="revoke">Revoke a role</option>
                  <option value="disable">Disable an officer</option>
                </select>
              </div>
              <div className="g2" style={{ gridTemplateColumns: "1fr 1fr" }}>
                <div className="field">
                  <label htmlFor="newName">New officer&apos;s name (invite)</label>
                  <input id="newName" name="newName" maxLength={80} autoComplete="off" />
                </div>
                <div className="field">
                  <label htmlFor="newHandle">Handle (invite)</label>
                  <input id="newHandle" name="newHandle" maxLength={40} autoComplete="off" pattern="[a-z][a-z0-9._\-]{2,39}" />
                </div>
              </div>
              <div className="g2" style={{ gridTemplateColumns: "1fr 1fr" }}>
                <div className="field">
                  <label htmlFor="officer">Officer (grant, revoke, disable)</label>
                  <select id="officer" name="officer" defaultValue="">
                    <option value="">–</option>
                    {others.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.handle} ({o.roles.join(", ") || "no role"})
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="role">Role</label>
                  <select id="role" name="role" defaultValue="">
                    <option value="">–</option>
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {roleLabel(r)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="field">
                <label htmlFor="reason">Reason (audited)</label>
                <textarea id="reason" name="reason" required minLength={10} maxLength={500} />
              </div>
              <button className="btn prime" type="submit">
                Request (needs a second administrator)
              </button>
            </form>
          </section>
        ) : null}
      </div>

      <section className="card" aria-labelledby="pm" style={{ marginBlockEnd: 16 }} data-testid="manager-scopes">
        <h2 id="pm">
          Property managers&apos; properties <span className="sp" />
          <span className="chip warn">maker-checker · step-up</span>
        </h2>
        <p className="small mu">A property manager sees only the properties assigned here (and nothing until one is). One administrator asks, another decides.</p>
        {scopes.managers.length === 0 ? <p className="empty">No officer holds the property manager role.</p> : null}
        <ul className="small">
          {scopes.managers.map((m) => (
            <li key={m.id}>
              <span className="mono">{m.handle}</span>: {m.properties.length ? m.properties.map(place).join("; ") : "no property (sees nothing)"}
            </li>
          ))}
        </ul>
        {scopes.open.map((c) => {
          const mine = c.requestedBy === officer.handle;
          return (
            <article key={c.id} className="card" style={{ background: "rgba(255,255,255,.02)" }} data-testid={`scope-change-${String(c.id)}`}>
              <b>
                #{c.id} {c.action === "grant" ? "Assign" : "Remove"} {place(c.property)} {c.action === "grant" ? "to" : "from"} {c.officer}
              </b>
              <p className="small mu">
                Requested by <span className="mono">{c.requestedBy}</span> at {pkt(c.requestedAt)}: {c.reason}
              </p>
              {manage && !mine ? (
                <StepUpForm csrf={officer.csrf} action={`/api/officers/scopes/${String(c.id)}/decide`}>
                  <label className="sr-only" htmlFor={`sr-${String(c.id)}`}>
                    Reason for the decision
                  </label>
                  <textarea id={`sr-${String(c.id)}`} name="reason" required minLength={10} maxLength={500} placeholder="Reason (at least 10 characters)" />
                  <div className="row">
                    <button className="btn ok" type="submit" name="decision" value="approve">
                      Approve with security key
                    </button>
                    <button className="btn no" type="submit" name="decision" value="reject">
                      Reject
                    </button>
                  </div>
                </StepUpForm>
              ) : (
                <p className="small di">{mine ? "Your request: another administrator must decide it." : "Read-only."}</p>
              )}
            </article>
          );
        })}
        {manage && scopes.managers.length > 0 ? (
          <StepUpForm csrf={officer.csrf} action="/api/officers/scopes">
            <div className="row">
              <label className="sr-only" htmlFor="scope-officer">
                Property manager
              </label>
              <select id="scope-officer" name="officer" required>
                {scopes.managers.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.handle}
                  </option>
                ))}
              </select>
              <label className="sr-only" htmlFor="scope-property">
                Property
              </label>
              <select id="scope-property" name="property" required>
                {scopes.properties.map((p) => (
                  <option key={p.id} value={p.id}>
                    {place(p)} ({p.state})
                  </option>
                ))}
              </select>
              <label className="sr-only" htmlFor="scope-action">
                Assign or remove
              </label>
              <select id="scope-action" name="action">
                <option value="grant">Assign</option>
                <option value="revoke">Remove</option>
              </select>
            </div>
            <label className="sr-only" htmlFor="scope-reason">
              Reason
            </label>
            <textarea id="scope-reason" name="reason" required minLength={10} maxLength={500} placeholder="Why (at least 10 characters), e.g. the management contract" />
            <div className="row">
              <button className="btn" type="submit">
                Request (another administrator decides)
              </button>
            </div>
          </StepUpForm>
        ) : null}
      </section>

      <div className="g2">
        <section className="card" aria-labelledby="sod">
          <h2 id="sod">Segregation of duties</h2>
          <div className="tbl-wrap">
            <table className="t">
              <caption>✕ = one person can never hold both roles (database trigger on every grant)</caption>
              <thead>
                <tr>
                  <th scope="col">Role</th>
                  {ROLES.map((r) => (
                    <th key={r} scope="col" title={roleLabel(r)}>
                      {r.replace("_officer", "").replace("ops_", "")}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ROLES.map((a) => (
                  <tr key={a}>
                    <th scope="row" className="mono" style={{ textTransform: "none" }}>
                      {a}
                    </th>
                    {ROLES.map((b) => (
                      <td key={b} className={a === b ? "di" : conflicts(a, b) ? "dn" : "up"} style={{ textAlign: "center" }}>
                        {a === b ? "·" : conflicts(a, b) ? "✕" : "ok"}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="small di" style={{ marginBlockStart: 6 }}>
            {ROLE_CONFLICTS.length} incompatible pairs. The only combination allowed is compliance officer + operations checker.
          </p>
        </section>
        <section className="card" aria-labelledby="hist">
          <h2 id="hist">Decided changes</h2>
          <div className="tbl-wrap">
            <table className="t">
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">Change</th>
                  <th scope="col">Maker → checker</th>
                  <th scope="col">Result</th>
                </tr>
              </thead>
              <tbody>
                {changes.filter((c) => c.status !== "open").length === 0 ? (
                  <tr>
                    <td colSpan={4} className="empty">
                      None yet.
                    </td>
                  </tr>
                ) : (
                  changes
                    .filter((c) => c.status !== "open")
                    .slice(0, 12)
                    .map((c) => (
                      <tr key={c.id}>
                        <td className="mono">{c.id}</td>
                        <td>{describe(c)}</td>
                        <td className="mono small">
                          {c.requestedBy} → {c.decidedBy ?? "–"}
                        </td>
                        <td>
                          <span className={c.status === "approved" ? "chip ok" : c.status === "rejected" ? "chip bad" : "chip"}>{c.status}</span>
                        </td>
                      </tr>
                    ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </Shell>
  );
}

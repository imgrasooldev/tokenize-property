import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Shell } from "@/components/Shell";
import { int, short, utc } from "@/lib/format";
import { isAuditSource, SOURCE_LIST, sourcePermission, type AuditSource } from "@/lib/routes";
import { auditRows, parseFilters, verifyChains, type AuditFilters } from "@/lib/server/audit";
import { requirePage } from "@/lib/server/session";

export const metadata: Metadata = { title: "Audit trail" };

const PAGE = 50;
const LABEL = new Map<AuditSource, string>([
  ["signer", "Signer"],
  ["recon", "Reconciliation"],
  ["ledger", "Ledger"],
  ["admin", "Admin portal"],
]);
const ABOUT = new Map<AuditSource, string>(Object.entries({
  signer: "Every signing request, policy evaluation, approval and signature (signer.audit, UTC digest v2).",
  recon: "Every reconciliation run, finding set, bank statement import and payout-gate change (recon.audit).",
  ledger: "Every journal of the double-entry ledger, hash-chained over its postings (ledger.journal).",
  admin: "Every sign-in, step-up, page view of sensitive data, denial, officer change and export in this portal (admin.audit).",
}) as [AuditSource, string][]);

function query(f: AuditFilters, before: string | null): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...f, before })) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : "";
}

export default async function AuditSourcePage({
  params,
  searchParams,
}: {
  params: Promise<{ source: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { source } = await params;
  if (!isAuditSource(source)) notFound();
  const officer = await requirePage(sourcePermission(source), `/audit/${source}`);
  const q = await searchParams;
  const qmap = new Map(Object.entries(q));
  const filters = parseFilters((k) => qmap.get(k));
  const t0 = performance.now();
  const [rows, checks] = await Promise.all([auditRows(officer.sessionHash, source, filters, PAGE), verifyChains(officer.sessionHash, source)]);
  const readMs = Math.round(performance.now() - t0);
  const check = checks[0];
  const tabs = SOURCE_LIST.filter((s) => officer.permissions.has(sourcePermission(s)));
  const label = LABEL.get(source) ?? source;
  const last = rows.at(-1);
  const canExport = officer.permissions.has("audit.export");

  return (
    <Shell
      officer={officer}
      current="/audit"
      title="Audit trail"
      actions={
        <nav className="tabs" aria-label="Audit sources">
          {tabs.map((s) => (
            <a key={s} href={`/audit/${s}`} aria-current={s === source ? "page" : undefined}>
              {LABEL.get(s)}
            </a>
          ))}
        </nav>
      }
    >
      <section className="kpis" aria-label="Chain verification" style={{ gridTemplateColumns: "repeat(4, minmax(0, 1fr))" }}>
        <div className="kpi">
          <div className="label">{label} chain</div>
          <div className={`val ${check && check.problems === 0 ? "up" : "dn"}`} data-testid="chain-state">
            {check ? (check.problems === 0 ? "Intact ✓" : "BROKEN") : "–"}
          </div>
          <div className="sub">{check ? `${int(check.entries)} entries · verified ${utc(check.verifiedAt)}` : "not verified"}</div>
        </div>
        <div className="kpi">
          <div className="label">Problems found</div>
          <div className={`val ${check && check.problems > 0 ? "dn" : ""}`}>{int(check?.problems)}</div>
          <div className="sub">{check?.firstProblem ?? "re-computed from the rows just now"}</div>
        </div>
        <div className="kpi">
          <div className="label">Edits possible</div>
          <div className="val">None</div>
          <div className="sub">append-only triggers · no UPDATE grant</div>
        </div>
        <div className="kpi">
          <div className="label">Read</div>
          <div className="val">{readMs} ms</div>
          <div className="sub">rows + full chain verification</div>
        </div>
      </section>

      <section className="card" aria-labelledby="flt">
        <h2 id="flt">
          {label} audit <span className="sp" />
          <span className="mu small" style={{ fontWeight: 400 }}>
            {ABOUT.get(source)}
          </span>
        </h2>
        <div className="row" style={{ alignItems: "end" }}>
          <form className="filters" method="get" action={`/audit/${source}`} aria-label="Filters">
            <div className="field">
              <label htmlFor="from">From (UTC)</label>
              <input id="from" name="from" type="date" defaultValue={filters.from ?? ""} />
            </div>
            <div className="field">
              <label htmlFor="to">To (UTC)</label>
              <input id="to" name="to" type="date" defaultValue={filters.to ?? ""} />
            </div>
            <div className="field">
              <label htmlFor="actor">Actor contains</label>
              <input id="actor" name="actor" maxLength={100} defaultValue={filters.actor ?? ""} />
            </div>
            <div className="field">
              <label htmlFor="action">Action starts with</label>
              <input id="action" name="action" maxLength={64} placeholder="e.g. login" defaultValue={filters.action ?? ""} />
            </div>
            <button className="btn" type="submit">
              Filter
            </button>
            <a className="btn" href={`/audit/${source}`}>
              Clear
            </a>
          </form>
          <span className="sp" />
          {canExport ? (
            <form method="post" action={`/api/audit/${source}/export`} className="filters" aria-label="Export">
              <input type="hidden" name="csrf" value={officer.csrf} />
              {(
                [
                  ["from", filters.from],
                  ["to", filters.to],
                  ["actor", filters.actor],
                  ["action", filters.action],
                ] as const
              ).map(([k, v]) => (v ? <input key={k} type="hidden" name={k} value={v} /> : null))}
              <div className="field">
                <label htmlFor="format">Evidence pack</label>
                <select id="format" name="format" defaultValue="csv">
                  <option value="csv">CSV + manifest</option>
                  <option value="json">JSON + manifest</option>
                </select>
              </div>
              <button className="btn prime" type="submit">
                Export (audited)
              </button>
            </form>
          ) : null}
        </div>

        <div className="tbl-wrap" style={{ marginBlockStart: 10 }}>
          <table className="t" data-testid="audit-table">
            <caption>
              Newest first, {PAGE} per page. Each entry&apos;s hash covers the previous entry&apos;s hash (timestamps in UTC).
            </caption>
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Time (UTC)</th>
                <th scope="col">Actor</th>
                <th scope="col">Action</th>
                <th scope="col">Detail</th>
                <th scope="col">Chain</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="empty">
                    No entries for these filters.
                  </td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.id}>
                    <td className="mono">{r.id}</td>
                    <td className="mono nowrap">{utc(r.at)}</td>
                    <td className="mono">{short(r.actor, 8)}</td>
                    <td>
                      <span className="chip cy">{r.action}</span>
                      {r.ref ? <div className="hash">ref {short(r.ref, 8)}</div> : null}
                    </td>
                    <td>
                      <div className="detail">{JSON.stringify(r.detail).slice(0, 400)}</div>
                    </td>
                    <td className="hash">
                      prev {short(r.prevHash)}
                      <br />
                      hash <span className="cy">{short(r.hash)}</span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <div className="row" style={{ marginBlockStart: 8 }}>
          {filters.before ? (
            <a className="btn" href={`/audit/${source}${query(filters, null)}`}>
              ← Newest
            </a>
          ) : null}
          <span className="sp" />
          {rows.length === PAGE && last ? (
            <a className="btn" href={`/audit/${source}${query(filters, last.id)}`}>
              Older →
            </a>
          ) : null}
        </div>
      </section>
    </Shell>
  );
}

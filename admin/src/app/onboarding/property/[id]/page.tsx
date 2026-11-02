import type { Metadata } from "next";
import { Fragment } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Flash } from "@/components/Decision";
import { Act, Checks, Field, Identifiers, Pick, REASON, SHA_HINT, Text, VaultPick } from "@/components/Onboarding";
import { Shell } from "@/components/Shell";
import { pkt, short } from "@/lib/format";
import { stateChip } from "@/lib/server/compliance";
import { UUID } from "@/lib/server/compliance-route";
import { DISCIPLINES, fileName, propertyFile, rupeesOfPaisa } from "@/lib/server/onboarding";
import { requirePage } from "@/lib/server/session";

export const metadata: Metadata = { title: "Property file" };

const PROPERTY_DOCS = [
  "title_deed",
  "land_record_extract",
  "approved_building_plan",
  "completion_certificate",
  "property_tax_receipt",
  "utility_bill",
  "lease_agreement",
  "rent_roll",
  "mortgage_letter",
  "insurance_policy",
  "authority_to_sell",
  "valuation_report",
  "legal_opinion",
  "technical_report",
  "site_visit_photos",
  "encumbrance_search",
  "court_order",
  "trust_deed",
  "spv_documents",
  "shariah_certificate",
  "audited_financials",
  "property_other",
];
const TITLE_KINDS = ["grant", "allotment", "sale_deed", "gift_deed", "mutation", "inheritance", "lease", "transfer_letter", "decree"];
const ENCUMBRANCES = ["mortgage", "charge", "lien", "attachment", "stay_order", "litigation", "acquisition_notice", "unpaid_tax", "other"];

/**
 * One property file (migration 0049): identifiers, state, reviews and reviewers, valuations,
 * duplicate candidates, documents, title chain, encumbrances, structure and history, with every
 * S-01 maker action. A property manager sees only assigned properties.
 */
export default async function PropertyFilePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { id } = await params;
  const valid = UUID.test(id);
  const officer = await requirePage("property.read", `/onboarding/property/${valid ? id : "invalid"}`);
  if (!valid) notFound();
  const q = await searchParams;
  const p = await propertyFile(officer.sessionHash, id);
  if (!p) notFound();
  const back = `/onboarding/property/${p.id}`;
  const c = { csrf: officer.csrf, back, hidden: { property: p.id } };
  const reps = p.sponsorPeople.map((x): [string, string] => [String(x.id), `#${String(x.id)} ${x.role} (${x.powers.join(", ")})`]);
  const docs = p.documents.map((d): [string, string] => [d.id, `${d.type} · ${short(d.sha256, 8)}`]);
  const openCandidates = p.candidates.filter((x) => x.status === "open");

  return (
    <Shell officer={officer} current="/onboarding" title={fileName(p)}>
      <p className="small">
        <Link href="/onboarding">← Onboarding desk</Link>
        {p.sponsorPeople.length > 0 || p.sponsorState ? (
          <>
            {" "}
            · <Link href={`/onboarding/sponsor/${p.sponsorId}`}>Sponsor file</Link>
          </>
        ) : null}
      </p>
      <Flash q={q} />
      <div className="g2">
        <div className="stack">
          <section className="card" aria-labelledby="file">
            <h2 id="file">
              Property <span className="sp" />
              <span className={stateChip(p.state)} data-testid="property-state">
                {p.state}
              </span>
            </h2>
            <dl className="kv">
              <dt>Property</dt>
              <dd className="mono small">{p.id}</dd>
              <dt>Location</dt>
              <dd>{[p.district, p.province].filter(Boolean).join(", ") || "–"}</dd>
              <dt>Use / occupancy</dt>
              <dd>
                {p.use ?? "–"} / {p.occupancy ?? "–"}
              </dd>
              <dt>Built</dt>
              <dd>{p.built === null ? "–" : p.built ? "yes" : "no"}</dd>
              <dt>Property key</dt>
              <dd className="mono small">{p.propertyKey ?? "–"}</dd>
              <dt>Sponsor KYB</dt>
              <dd>{p.sponsorState ?? "–"}</dd>
              <dt>Submitted</dt>
              <dd>{p.submittedAt ? pkt(p.submittedAt) : "–"}</dd>
              {p.previousId ? (
                <>
                  <dt>Cures</dt>
                  <dd>
                    <Link href={`/onboarding/property/${p.previousId}`}>{p.previousId.slice(0, 8)}</Link>
                  </dd>
                </>
              ) : null}
            </dl>
          </section>

          <section className="card" aria-labelledby="dd">
            <h2 id="dd">Due diligence</h2>
            <div className="tbl-wrap">
              <table className="t" data-testid="property-reviews">
                <thead>
                  <tr>
                    <th scope="col">Discipline</th>
                    <th scope="col">Reviewer</th>
                    <th scope="col">Decision</th>
                  </tr>
                </thead>
                <tbody>
                  {p.reviews.map((r) => (
                    <tr key={r.discipline}>
                      <td>{r.discipline}</td>
                      <td className="mono small">{r.reviewer ?? "–"}</td>
                      <td>{r.decision ? <span className={r.decision === "fail" ? "chip bad" : r.fresh ? "chip ok" : "chip warn"}>{`${r.decision}${r.fresh ? "" : " (stale)"}`}</span> : "–"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="small mu" style={{ marginBlockStart: 6 }}>
              Assigned: {p.assignments.map((a) => `${a.group} → ${a.reviewer}`).join(" · ") || "nobody yet"}
            </p>
            <dl className="kv" style={{ marginBlockStart: 6 }}>
              <dt>Valuation</dt>
              <dd>
                {p.valuation?.ok ? `ok · lowest ${rupeesOfPaisa(p.valuation.lowestPaisa)}` : (p.valuation?.problem ?? "–")} ({p.valuation?.valuations ?? 0} valuation(s))
              </dd>
            </dl>
            <ul className="small">
              {p.valuations.map((v) => (
                <li key={v.id}>
                  {rupeesOfPaisa(v.valuePaisa)} · {v.valuer} · {v.on} · {v.by}
                </li>
              ))}
            </ul>
          </section>

          {p.candidates.length ? (
            <section className="card" aria-labelledby="dup">
              <h2 id="dup">Duplicate check</h2>
              <ul className="small">
                {p.candidates.map((x) => (
                  <li key={x.id}>
                    #{x.id} {x.kind} · {x.reasons.join(", ")} · vs <Link href={`/onboarding/property/${x.candidate}`}>{x.candidate.slice(0, 8)}</Link> · {x.status}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section className="card" aria-labelledby="docs">
            <h2 id="docs">Documents</h2>
            {p.documents.length === 0 ? <p className="empty">No document.</p> : null}
            <ul className="small" data-testid="property-documents">
              {p.documents.map((d) => (
                <li key={d.id}>
                  {d.type} · <span className="mono">{short(d.sha256, 10)}</span> · {pkt(d.uploadedAt)} {d.verifications ? <span className="chip ok">verified at source</span> : null}
                </li>
              ))}
            </ul>
          </section>

          <section className="card" aria-labelledby="title">
            <h2 id="title">Title chain and encumbrances</h2>
            <ol className="small">
              {p.titleLinks.map((t) => (
                <li key={`${String(t.position)}-${t.ref}`}>
                  {t.kind} {t.ref} · {t.on} · {t.by}
                </li>
              ))}
            </ol>
            {p.titleLinks.length === 0 ? <p className="empty">No title link.</p> : null}
            <ul className="small">
              {p.encumbrances.map((e) => (
                <li key={e.id}>
                  #{e.id} <b>{e.kind}</b> · {e.description} · {e.resolution ? <span className="chip ok">{e.resolution}</span> : <span className="chip bad">open</span>}
                </li>
              ))}
            </ul>
          </section>

          {p.structure ? (
            <section className="card" aria-labelledby="struct">
              <h2 id="struct">Structure</h2>
              <dl className="kv">
                <dt>Kind</dt>
                <dd>
                  {p.structure.kind}
                  {p.structure.shariah ? " · Shariah" : ""}
                </dd>
                <dt>Planned units</dt>
                <dd>{p.structure.plannedUnits}</dd>
                <dt>Max per holder</dt>
                <dd>{p.structure.maxHoldingUnits}</dd>
                {Object.entries(p.structure.rights).map(([k, v]) => (
                  <Fragment key={k}>
                    <dt>{k}</dt>
                    <dd>{v}</dd>
                  </Fragment>
                ))}
              </dl>
            </section>
          ) : null}

          <section className="card" aria-labelledby="hist">
            <h2 id="hist">History</h2>
            <ul className="small" data-testid="property-events">
              {p.events.map((e) => (
                <li key={`${e.code}-${e.at}`}>
                  {pkt(e.at)} · <b>{e.code}</b> {e.from} → {e.to} · {e.actor}
                  {e.checker ? ` (checked by ${e.checker})` : ""}
                  {e.reason ? <span className="mu"> · {e.reason}</span> : null}
                </li>
              ))}
            </ul>
          </section>
        </div>

        <div className="stack" aria-label="Actions">
          <h2>Actions</h2>
          <h3 className="small mu">The file</h3>
          <Act {...c} action="update_property" title="Edit identifiers" hint="drafts only">
            <Pick label="Acting for" name="actingFor" options={reps} required={false} empty="– officer's own" />
            <Identifiers values={{ district: p.district, building: p.building }} />
          </Act>
          <Act {...c} action="submit_property" title="Submit for review" hint="runs the duplicate check">
            <Pick label="Acting for" name="actingFor" options={reps} />
          </Act>
          <Act {...c} action="withdraw_property" title="Withdraw for the sponsor" tone="no">
            <Pick label="Acting for" name="actingFor" options={reps} />
            <Text label={REASON} name="reason" />
          </Act>
          <Act {...c} action="return_property" title="Return to the sponsor" tone="no" hint="incomplete submission">
            <Text label={REASON} name="reason" />
          </Act>
          {openCandidates.length ? (
            <Act {...c} action="decide_duplicate" title="Decide a possible duplicate">
              <Pick label="Candidate" name="candidate" options={openCandidates.map((x): [string, string] => [String(x.id), `#${String(x.id)} vs ${x.candidate.slice(0, 8)} (${x.reasons.join(", ")})`])} />
              <Pick label="Your capacity" name="capacity" options={["onboarding", "compliance"]} />
              <Pick
                label="Decision"
                name="decision"
                options={[
                  ["clear", "Not a duplicate"],
                  ["confirm", "Confirm duplicate"],
                ]}
              />
              <Text label={REASON} name="reason" />
            </Act>
          ) : null}

          <h3 className="small mu">Review</h3>
          <Act {...c} action="start_review" title="Start the review" hint="assign three reviewers">
            <Field label="Legal reviewer (handle)" name="legal" required />
            <Field label="Valuation reviewer (handle)" name="valuation" required />
            <Field label="Technical reviewer (handle)" name="technical" required />
          </Act>
          <Act {...c} action="reassign_reviewer" title="Reassign a reviewer">
            <Pick label="Group" name="group" options={["legal", "valuation", "technical"]} />
            <Field label="New reviewer (handle)" name="reviewer" required />
          </Act>
          <Act {...c} action="record_review" title="Record your review" hint="assigned reviewer">
            <Pick label="Discipline" name="discipline" options={DISCIPLINES} />
            <Text label="Scope" name="scope" />
            <Text label="Method" name="method" />
            <Text label="Findings" name="findings" max={2000} rows={4} />
            <Text label="Conditions (one per line; needed for pass with conditions)" name="conditions" required={false} max={4000} />
            <Pick
              label="Decision"
              name="decision"
              options={[
                ["pass", "Pass"],
                ["pass_with_conditions", "Pass with conditions"],
                ["fail", "Fail"],
              ]}
            />
            <Checks label="Documents relied on" name="documents" options={docs} />
          </Act>
          <Act {...c} action="query_property" title="Ask the sponsor a question" hint="reviewer">
            <Text label={REASON} name="reason" />
          </Act>
          <Act {...c} action="hold_property" title="Put on hold" tone="no">
            <Text label={REASON} name="reason" />
          </Act>
          <Act {...c} action="reopen" title="Reopen disciplines">
            <Checks label="Disciplines" name="disciplines" options={DISCIPLINES} />
            <Text label={REASON} name="reason" />
          </Act>

          <h3 className="small mu">Documents and title</h3>
          <Act {...c} action="add_document" title="Add a document from the vault" hint="store the file on Documents first" hidden={{ property: p.id, sponsor: p.sponsorId }}>
            <Pick label="Type" name="type" options={PROPERTY_DOCS} />
            <VaultPick files={p.vault} />
            <Pick label="Replaces" name="supersedes" options={docs} required={false} empty="– a new document" />
            <Pick label="Acting for (if the sponsor sent it)" name="actingFor" options={reps} required={false} empty="– officer's own" />
          </Act>
          <Act {...c} action="verify_document" title="Record a verification at source">
            <Pick label="Document" name="document" options={docs} />
            <Pick label="Method" name="method" options={["in_person", "online_portal", "official_letter", "provider"]} />
            <Field label="Office" name="office" required />
            <Field label="Verified on" name="on" type="date" required />
            <Pick label="Outcome" name="outcome" options={["verified", "failed"]} />
            <Field label={SHA_HINT} name="evidence" required maxLength={66} />
          </Act>
          <Act {...c} action="add_title_link" title="Add a title-chain link">
            <Field label="Position (1 = oldest)" name="position" required maxLength={3} />
            <Pick label="Kind" name="kind" options={TITLE_KINDS} />
            <Field label="Instrument reference" name="ref" required maxLength={80} />
            <Field label="Registered on" name="on" type="date" required />
            <Pick label="Document" name="document" options={docs} />
          </Act>
          <Act {...c} action="record_encumbrance" title="Record an encumbrance" tone="no">
            <Pick label="Kind" name="kind" options={ENCUMBRANCES} />
            <Text label="Description" name="description" />
            <Field label={SHA_HINT} name="evidence" required maxLength={66} />
          </Act>
          {p.encumbrances.some((e) => !e.resolution) ? (
            <Act {...c} action="resolve_encumbrance" title="Resolve an encumbrance" tone="ok">
              <Pick label="Encumbrance" name="encumbrance" options={p.encumbrances.filter((e) => !e.resolution).map((e): [string, string] => [String(e.id), `#${String(e.id)} ${e.kind}`])} />
              <Pick label="Resolution" name="resolution" options={["discharged", "condition_precedent"]} />
              <Text label="Note" name="note" />
              <Field label={SHA_HINT} name="evidence" required maxLength={66} />
            </Act>
          ) : null}

          <h3 className="small mu">Valuation and structure</h3>
          <Act {...c} action="record_valuation" title="Record a valuation" hint="valuation reviewer">
            <Pick label="Valuer (approved panel)" name="valuer" options={p.valuers.map((v): [string, string] => [String(v.id), `${v.licence} · ${v.panel}`])} />
            <Field label="Market value (whole rupees)" name="valuePaisa" required maxLength={16} />
            <Field label="Valued on" name="on" type="date" required />
            <Pick label="Valuation report" name="report" options={docs} />
            <Field label="Independence declaration SHA-256" name="independence" required maxLength={66} />
          </Act>
          <Act {...c} action="record_structure" title="Record the structure" hint="after the committee">
            <Pick label="Kind" name="kind" options={["reit", "spv"]} />
            <Pick
              label="Shariah"
              name="shariah"
              options={[
                ["yes", "yes"],
                ["no", "no"],
              ]}
            />
            <Field label="Unit rights: income" name="rights.income" required maxLength={300} />
            <Field label="Unit rights: exit" name="rights.exit" required maxLength={300} />
            <Field label="Unit rights: voting" name="rights.voting" required maxLength={300} />
            <Field label="Unit rights: information" name="rights.information" required maxLength={300} />
            <Field label="Planned units" name="plannedUnits" required maxLength={30} />
            <Pick label="Trust deed" name="trustDeed" options={docs} />
          </Act>
          <p className="small mu">
            Committee votes are on <Link href="/committees">Committees</Link>; KYB and property decisions are asked and decided on <Link href="/approvals/property">Property & KYB</Link>; the trustee
            accepts on the trustee portal.
          </p>
        </div>
      </div>
    </Shell>
  );
}

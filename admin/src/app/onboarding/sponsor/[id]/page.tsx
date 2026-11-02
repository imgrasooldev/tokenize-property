import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Flash } from "@/components/Decision";
import { Act, Checks, Field, Identifiers, Pick, REASON, SHA_HINT, Text, VaultPick } from "@/components/Onboarding";
import { Shell } from "@/components/Shell";
import { pkt, short } from "@/lib/format";
import { stateChip } from "@/lib/server/compliance";
import { UUID } from "@/lib/server/compliance-route";
import { fileName, sponsorFile } from "@/lib/server/onboarding";
import { requirePage } from "@/lib/server/session";

export const metadata: Metadata = { title: "Sponsor KYB file" };

const KYB_DOCS = ["certificate_of_incorporation", "memorandum_articles", "annual_return", "directors_list", "ntn_certificate", "strn_certificate", "board_resolution", "secp_verification", "source_of_wealth", "sponsor_other"];

/**
 * One sponsor's KYB file (migration 0049): state, people, the KYB evidence (registration check,
 * screening, risk rating, FMU assessment), documents, properties and history, with the S-01 maker
 * actions. Sealed name and address stay out of the portal. Sponsor files are never shown to a
 * property manager.
 */
export default async function SponsorFilePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { id } = await params;
  const valid = UUID.test(id);
  const officer = await requirePage("property.read", `/onboarding/sponsor/${valid ? id : "invalid"}`);
  if (!valid) notFound();
  const q = await searchParams;
  const s = await sponsorFile(officer.sessionHash, id);
  if (!s) notFound();
  const back = `/onboarding/sponsor/${s.id}`;
  const reps = s.people.filter((p) => p.powers && p.powers.length > 0).map((p): [string, string] => [String(p.id), `#${String(p.id)} ${p.role} (${(p.powers ?? []).join(", ")})`]);
  const c = { csrf: officer.csrf, back, hidden: { sponsor: s.id } };

  return (
    <Shell officer={officer} current="/onboarding" title={s.kind === "company" ? `Company · CUIN …${s.cuinLast4 ?? ""}` : "Individual owner"}>
      <p className="small">
        <Link href="/onboarding">← Onboarding desk</Link>
      </p>
      <Flash q={q} />
      <div className="g2">
        <div className="stack">
          <section className="card" aria-labelledby="file">
            <h2 id="file">
              KYB file <span className="sp" />
              <span className={stateChip(s.state)} data-testid="sponsor-state">
                {s.state}
              </span>
            </h2>
            <dl className="kv">
              <dt>Sponsor</dt>
              <dd className="mono small">{s.id}</dd>
              <dt>Kind</dt>
              <dd>{s.kind}</dd>
              <dt>CUIN / NTN</dt>
              <dd>
                …{s.cuinLast4 ?? "–"} / …{s.ntnLast4 ?? "–"}
              </dd>
              <dt>KYB valid until</dt>
              <dd>{s.kybValidUntil ? pkt(s.kybValidUntil) : "–"}</dd>
              <dt>Created</dt>
              <dd>{pkt(s.createdAt)}</dd>
            </dl>
          </section>

          <section className="card" aria-labelledby="people">
            <h2 id="people">People</h2>
            {s.people.length === 0 ? <p className="empty">Nobody recorded.</p> : null}
            <div className="tbl-wrap">
              <table className="t">
                <thead>
                  <tr>
                    <th scope="col">#</th>
                    <th scope="col">Role</th>
                    <th scope="col">KYC subject</th>
                    <th scope="col">Ownership / control</th>
                    <th scope="col">Powers</th>
                  </tr>
                </thead>
                <tbody>
                  {s.people.map((p) => (
                    <tr key={p.id}>
                      <td className="mono">{p.id}</td>
                      <td>{p.role}</td>
                      <td className="mono">{p.subject}…</td>
                      <td className="small">{p.ownershipBp !== null ? `${(p.ownershipBp / 100).toFixed(2)} %` : ""} {p.control ?? ""}</td>
                      <td className="small">{(p.powers ?? []).join(", ") || "–"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="card" aria-labelledby="evidence">
            <h2 id="evidence">KYB evidence</h2>
            <dl className="kv">
              <dt>Registration check</dt>
              <dd>{s.registrationChecks[0] ? `${s.registrationChecks[0].outcome} (${s.registrationChecks[0].method}, ${s.registrationChecks[0].by}, ${pkt(s.registrationChecks[0].at)})` : "–"}</dd>
              <dt>Screening</dt>
              <dd>{s.screenings[0] ? `${s.screenings[0].outcome} (${s.screenings[0].provider} ${s.screenings[0].listVersion}, ${s.screenings[0].by})` : "–"}</dd>
              <dt>Risk</dt>
              <dd>{s.risk[0] ? `${s.risk[0].rating}${s.risk[0].edd ? " + EDD" : ""} (${s.risk[0].by})` : "–"}</dd>
              <dt>FMU assessment</dt>
              <dd>{s.fmu[0] ? `${s.fmu[0].outcome} (${s.fmu[0].by})` : "–"}</dd>
            </dl>
          </section>

          <section className="card" aria-labelledby="docs">
            <h2 id="docs">KYB documents</h2>
            {s.documents.length === 0 ? <p className="empty">No document.</p> : null}
            <ul className="small">
              {s.documents.map((d) => (
                <li key={d.id}>
                  {d.type} · <span className="mono">{short(d.sha256, 10)}</span> · {pkt(d.uploadedAt)}
                </li>
              ))}
            </ul>
          </section>

          <section className="card" aria-labelledby="props">
            <h2 id="props">Properties</h2>
            {s.properties.length === 0 ? <p className="empty">No property.</p> : null}
            <ul className="small">
              {s.properties.map((p) => (
                <li key={p.id}>
                  <Link href={`/onboarding/property/${p.id}`}>{fileName(p)}</Link> <span className={stateChip(p.state)}>{p.state}</span>
                </li>
              ))}
            </ul>
          </section>

          <section className="card" aria-labelledby="hist">
            <h2 id="hist">History</h2>
            <ul className="small" data-testid="sponsor-events">
              {s.events.map((e) => (
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
          <Act {...c} action="submit_kyb" title="Submit the KYB file" hint="for the representative">
            <Pick label="Acting for" name="actingFor" options={reps} />
          </Act>
          <Act {...c} action="screen_kyb" title="Screen the submission" hint="complete → review, or back to the sponsor">
            <Pick
              label="Outcome"
              name="accept"
              options={[
                ["yes", "Complete: move to review"],
                ["no", "Incomplete: return to the sponsor"],
              ]}
            />
            <Text label="Reason (needed when returning)" name="reason" required={false} />
          </Act>
          <Act {...c} action="query_kyb" title="Ask the sponsor a question">
            <Text label={REASON} name="reason" />
          </Act>
          <Act {...c} action="registration_check" title="Record the registration check">
            <Pick label="Method" name="method" options={["secp_eservices", "provider", "manual"]} />
            <Pick label="Outcome" name="outcome" options={["verified", "mismatch", "not_found"]} />
            <Field label={SHA_HINT} name="evidence" required maxLength={66} />
          </Act>
          <Act {...c} action="screening" title="Record sanctions / PEP screening" hint="compliance duty">
            <Field label="Provider" name="provider" required placeholder="mock-screen" />
            <Field label="List version" name="listVersion" required placeholder="un-2026-10" />
            <Pick label="Outcome" name="outcome" options={["clear", "possible_match", "hit"]} />
            <Field label={SHA_HINT} name="evidence" required maxLength={66} />
          </Act>
          <Act {...c} action="risk" title="Rate the risk" hint="compliance duty">
            <Pick label="Rating" name="rating" options={["low", "medium", "high"]} />
            <Text label="Reasons" name="reasons" />
            <Field label="Enhanced due diligence file SHA-256 (required for high)" name="edd" maxLength={66} />
          </Act>
          <Act {...c} action="fmu" title="Record the FMU assessment" hint="compliance duty">
            <Pick label="Outcome" name="outcome" options={["no_grounds", "str_filed", "str_not_required"]} />
            <Field label={SHA_HINT} name="evidence" required maxLength={66} />
          </Act>
          <Act {...c} action="add_person" title="Add a person">
            <Field label="KYC subject id (from compliance)" name="subject" required maxLength={36} />
            <Pick label="Role" name="role" options={["representative", "director", "beneficial_owner"]} />
            <Checks label="Powers (representatives)" name="powers" options={["submit", "upload", "respond", "withdraw"]} />
            <Field label="Ownership in basis points (beneficial owners; 6000 = 60 %)" name="ownershipBp" maxLength={5} />
            <Pick label="Control (beneficial owners)" name="control" options={["shares", "votes", "other_control"]} required={false} empty="–" />
            <Field label="Ownership chain depth (1-10)" name="chainDepth" maxLength={2} />
          </Act>
          <Act {...c} action="end_person" title="End a person's role" tone="no">
            <Pick label="Person" name="person" options={s.people.map((p): [string, string] => [String(p.id), `#${String(p.id)} ${p.role}`])} />
            <Text label={REASON} name="reason" />
          </Act>
          <Act {...c} action="add_document" title="Add a KYB document from the vault" hint="store the file on Documents first">
            <Pick label="Type" name="type" options={KYB_DOCS} />
            <VaultPick files={s.vault} />
            <Pick label="Acting for (if the sponsor sent it)" name="actingFor" options={reps} required={false} empty="– officer's own" />
          </Act>
          <Act {...c} action="create_property" title="Add a property" hint="a draft for the sponsor">
            <Pick label="Acting for" name="actingFor" options={reps} />
            <Identifiers />
          </Act>
          <Act {...c} action="suspend_sponsor" title="Suspend the sponsor" tone="no" hint="holds every property">
            <Text label={REASON} name="reason" />
          </Act>
        </div>
      </div>
    </Shell>
  );
}

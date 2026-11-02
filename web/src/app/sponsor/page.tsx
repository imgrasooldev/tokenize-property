import { redirect } from "next/navigation";
import { PortalShell } from "@/components/Shell";
import { sponsorAction, sponsorUploadAction } from "@/app/actions/sponsor";
import { pktDate } from "@/lib/i18n-catalog";
import { fill } from "@/lib/i18n-verify";
import { PROPERTY_DOCS, SPONSOR_DOCS, sl, sponsorDict, type SponsorDict } from "@/lib/i18n-sponsor";
import { getDict } from "@/lib/server/lang";
import { currentSession } from "@/lib/server/session";
import { sponsorOverview, type SponsorDoc, type SponsorNote, type SponsorProperty } from "@/lib/server/sponsor";

export const dynamic = "force-dynamic";

/**
 * The property sponsor portal (migration 0048): for each sponsor the signed-in person represents,
 * the KYB file and the properties with their state, what is still missing, the team's last message
 * and the documents; the person submits, adds and edits properties and uploads documents within
 * their powers. Reviews, committees and the trustee stay with staff.
 */
export default async function SponsorPage({ searchParams }: { searchParams: Promise<{ e?: string; ok?: string }> }) {
  const session = await currentSession();
  if (!session) redirect("/login");
  const { lang } = await getDict();
  const l = sponsorDict(lang);
  const q = await searchParams;
  const files = await sponsorOverview(session.hash);
  return (
    <PortalShell active="sponsor" title={l.title}>
      {q.ok && (
        <p className="up" role="status">
          {l.ok}
        </p>
      )}
      {q.e && (
        <p className="alert" role="alert">
          {sl(l, "err_", q.e)}
        </p>
      )}
      <p className="note">{l.intro}</p>
      {files.length === 0 ? <p className="note">{l.none}</p> : null}
      {files.map((s) => (
        <section key={s.id} className="panel" aria-labelledby={`sp-${s.id}`} data-testid="sponsor-file">
          <h2 id={`sp-${s.id}`}>
            {s.kind === "company" ? fill(l.company, { c: s.cuinLast ?? "" }) : l.individual} · {l.kyb}: <span className="chip">{sl(l, "st_", s.state)}</span>
          </h2>
          <p className="fine">{fill(l.powers, { p: s.powers.join(", ") })}</p>
          <Note l={l} note={s.note} />
          <Docs l={l} docs={s.documents} />
          {s.powers.includes("upload") && <Upload l={l} sponsor={s.id} property={null} types={SPONSOR_DOCS} />}
          {s.state === "kyb_draft" && s.powers.includes("submit") && (
            <form action={sponsorAction} className="btn-row">
              <input type="hidden" name="action" value="submit_kyb" />
              <input type="hidden" name="sponsor" value={s.id} />
              <button type="submit" className="btn">
                {l.submitKyb}
              </button>
            </form>
          )}
          <h3>{l.properties}</h3>
          {s.properties.map((p) => (
            <PropertyCard key={p.id} l={l} sponsor={s.id} p={p} powers={s.powers} />
          ))}
          {s.powers.includes("submit") && (
            <details>
              <summary>{l.newProperty}</summary>
              <form action={sponsorAction} className="stack">
                <input type="hidden" name="action" value="create_property" />
                <input type="hidden" name="sponsor" value={s.id} />
                <Identifiers l={l} p={null} />
                <button type="submit" className="btn">
                  {l.create}
                </button>
              </form>
            </details>
          )}
        </section>
      ))}
    </PortalShell>
  );
}

function Note({ l, note }: { l: SponsorDict; note: SponsorNote | null }) {
  if (!note) return null;
  return <p className="note">{fill(l.note, { d: pktDate(note.at), r: note.reason })}</p>;
}

function Docs({ l, docs }: { l: SponsorDict; docs: SponsorDoc[] }) {
  return (
    <>
      <h3 className="small">{l.documents}</h3>
      {docs.length === 0 ? (
        <p className="fine">{l.noDocs}</p>
      ) : (
        <ul className="plain small">
          {docs.map((d) => (
            <li key={d.sha256}>
              {d.type} · {pktDate(d.at)}{" "}
              <span className="mono di" dir="ltr">
                {d.sha256.slice(0, 12)}…
              </span>{" "}
              {d.verified && <span className="chip green">{l.verified}</span>}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function Upload({ l, sponsor, property, types }: { l: SponsorDict; sponsor: string; property: string | null; types: readonly string[] }) {
  return (
    <form action={sponsorUploadAction} className="btn-row">
      <input type="hidden" name="sponsor" value={sponsor} />
      {property && <input type="hidden" name="property" value={property} />}
      <label className="sr-only" htmlFor={`t-${property ?? sponsor}`}>
        {l.docType}
      </label>
      <select id={`t-${property ?? sponsor}`} name="type">
        {types.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>
      <label className="sr-only" htmlFor={`f-${property ?? sponsor}`}>
        {l.file}
      </label>
      <input id={`f-${property ?? sponsor}`} name="file" type="file" accept="application/pdf,image/jpeg,image/png,image/tiff" required />
      <button type="submit" className="btn secondary small">
        {l.upload}
      </button>
    </form>
  );
}

function PropertyCard({ l, sponsor, p, powers }: { l: SponsorDict; sponsor: string; p: SponsorProperty; powers: string[] }) {
  const draft = p.state === "draft";
  return (
    <article className="panel" data-testid="sponsor-property">
      <h4>
        {p.building ?? p.district ?? p.id.slice(0, 8)} <span className="chip">{sl(l, "st_", p.state)}</span>
      </h4>
      {p.missing && <p className="fine">{fill(l.missing, { m: p.missing })}</p>}
      <Note l={l} note={p.note} />
      <Docs l={l} docs={p.documents} />
      {powers.includes("upload") && <Upload l={l} sponsor={sponsor} property={p.id} types={PROPERTY_DOCS} />}
      {draft && powers.includes("respond") && (
        <details>
          <summary>{l.save}</summary>
          <form action={sponsorAction} className="stack">
            <input type="hidden" name="action" value="update_property" />
            <input type="hidden" name="property" value={p.id} />
            <Identifiers l={l} p={p} />
            <button type="submit" className="btn secondary">
              {l.save}
            </button>
          </form>
        </details>
      )}
      <div className="btn-row">
        {draft && powers.includes("submit") && (
          <form action={sponsorAction}>
            <input type="hidden" name="action" value="submit_property" />
            <input type="hidden" name="property" value={p.id} />
            <button type="submit" className="btn">
              {l.submitProperty}
            </button>
          </form>
        )}
        {powers.includes("withdraw") && ["draft", "submitted", "under_review", "legal_approved"].includes(p.state) && (
          <form action={sponsorAction} className="btn-row">
            <input type="hidden" name="action" value="withdraw_property" />
            <input type="hidden" name="property" value={p.id} />
            <label className="sr-only" htmlFor={`w-${p.id}`}>
              {l.withdrawReason}
            </label>
            <input id={`w-${p.id}`} name="reason" minLength={10} maxLength={500} placeholder={l.withdrawReason} required />
            <button type="submit" className="btn secondary small">
              {l.withdraw}
            </button>
          </form>
        )}
      </div>
    </article>
  );
}

/** The main OB-10 identifiers (the database checks every value again). */
function Identifiers({ l, p }: { l: SponsorDict; p: SponsorProperty | null }) {
  const key = p?.id ?? "new";
  const field = (name: string, label: string, value?: string | null) => (
    <label key={name} htmlFor={`${name}-${key}`}>
      {label}
      <input id={`${name}-${key}`} name={name} defaultValue={value ?? ""} />
    </label>
  );
  return (
    <div className="grid2">
      <label htmlFor={`province-${key}`}>
        {l.province}
        <select id={`province-${key}`} name="province" defaultValue={p?.province ?? ""}>
          <option value="" />
          {["punjab", "sindh", "kp", "balochistan", "ict", "gb", "ajk"].map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      </label>
      {field("district", l.district, p?.district)}
      {field("building", l.building, p?.building)}
      {field("society", l.society)}
      {field("plot_no", l.plot)}
      {field("mauza", l.mauza)}
      {field("khasra", l.khasra)}
      {field("sub_registrar", l.subRegistrar)}
      {field("deed_no", l.deedNo)}
      <label htmlFor={`deed_date-${key}`}>
        {l.deedDate}
        <input id={`deed_date-${key}`} name="deed_date" type="date" />
      </label>
      {field("land_record_ref", l.landRecord)}
      {field("excise_no", l.excise)}
      {field("land_area", l.landArea)}
      <label htmlFor={`land_area_unit-${key}`}>
        {l.unit}
        <select id={`land_area_unit-${key}`} name="land_area_unit" defaultValue="">
          <option value="" />
          {["sq_ft", "sq_m", "marla", "kanal", "acre"].map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      </label>
      {field("gps_lat", l.lat)}
      {field("gps_lon", l.lon)}
      <label htmlFor={`use-${key}`}>
        {l.use}
        <select id={`use-${key}`} name="use" defaultValue="">
          <option value="" />
          {["commercial", "residential", "mixed"].map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      </label>
      <label htmlFor={`occupancy-${key}`}>
        {l.occupancy}
        <select id={`occupancy-${key}`} name="occupancy" defaultValue="">
          <option value="" />
          {["vacant", "owner_occupied", "tenanted", "partly_tenanted"].map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      </label>
      <label htmlFor={`built-${key}`}>
        {l.built}
        <select id={`built-${key}`} name="built" defaultValue="">
          <option value="" />
          <option value="yes">yes</option>
          <option value="no">no</option>
        </select>
      </label>
    </div>
  );
}

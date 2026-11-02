import type { ReactNode } from "react";
import { StepUpForm } from "./StepUp";

/**
 * Building blocks of the onboarding desk (migration 0049): one collapsible form per S-01 action,
 * posted to /api/onboarding/act after a security-key step-up. The database decides; its reason
 * comes back on the page.
 */
export function Act({
  csrf,
  action,
  back,
  title,
  hint,
  hidden = {},
  children,
  button,
  tone = "prime",
  endpoint = "/api/onboarding/act",
}: {
  csrf: string;
  action: string;
  back: string;
  title: string;
  hint?: string;
  hidden?: Record<string, string>;
  children?: ReactNode;
  button?: string;
  tone?: "prime" | "ok" | "no";
  endpoint?: string;
}) {
  return (
    <details className="card act" data-testid={`act-${action}`}>
      <summary>
        <b>{title}</b>
        {hint ? <span className="mu small"> · {hint}</span> : null}
      </summary>
      <StepUpForm csrf={csrf} action={endpoint}>
        <input type="hidden" name="action" value={action} />
        <input type="hidden" name="back" value={back} />
        {Object.entries(hidden).map(([k, v]) => (
          <input key={k} type="hidden" name={k} value={v} />
        ))}
        <div className="stack" style={{ gap: 8, marginBlockStart: 8 }}>
          {children}
          <div className="row">
            <button className={`btn ${tone}`} type="submit">
              {button ?? title} with security key
            </button>
          </div>
        </div>
      </StepUpForm>
    </details>
  );
}

let seq = 0;
const uid = (name: string): string => `f-${name.replace(/[^a-z0-9]/gi, "")}-${String(++seq)}`;

export function Field({ label, name, required, placeholder, type = "text", defaultValue, maxLength = 200 }: { label: string; name: string; required?: boolean; placeholder?: string; type?: string; defaultValue?: string; maxLength?: number }) {
  const id = uid(name);
  return (
    <div className="stack" style={{ gap: 3 }}>
      <label htmlFor={id} className="small mu">
        {label}
      </label>
      <input id={id} name={name} type={type} required={required} placeholder={placeholder} defaultValue={defaultValue} maxLength={maxLength} />
    </div>
  );
}

export function Text({ label, name, required = true, min = 10, max = 500, placeholder, rows = 2 }: { label: string; name: string; required?: boolean; min?: number; max?: number; placeholder?: string; rows?: number }) {
  const id = uid(name);
  return (
    <div className="stack" style={{ gap: 3 }}>
      <label htmlFor={id} className="small mu">
        {label}
      </label>
      <textarea id={id} name={name} required={required} minLength={required ? min : undefined} maxLength={max} placeholder={placeholder} rows={rows} />
    </div>
  );
}

export function Pick({ label, name, options, required = true, empty }: { label: string; name: string; options: readonly (string | [string, string])[]; required?: boolean; empty?: string }) {
  const id = uid(name);
  return (
    <div className="stack" style={{ gap: 3 }}>
      <label htmlFor={id} className="small mu">
        {label}
      </label>
      <select id={id} name={name} required={required} defaultValue="">
        <option value="" disabled={required}>
          {empty ?? "Choose…"}
        </option>
        {options.map((o) => {
          const [v, l] = typeof o === "string" ? [o, o] : o;
          return (
            <option key={v} value={v}>
              {l}
            </option>
          );
        })}
      </select>
    </div>
  );
}

export function Checks({ label, name, options, checked = [] }: { label: string; name: string; options: readonly (string | [string, string])[]; checked?: readonly string[] }) {
  return (
    <fieldset className="stack" style={{ gap: 3, border: 0, padding: 0, margin: 0 }}>
      <legend className="small mu">{label}</legend>
      <div className="row">
        {options.map((o) => {
          const [v, l] = typeof o === "string" ? [o, o] : o;
          const id = uid(`${name}-${v}`);
          return (
            <label key={v} htmlFor={id} className="small row" style={{ gap: 4 }}>
              <input id={id} type="checkbox" name={name} value={v} defaultChecked={checked.includes(v)} /> {l}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

export const SHA_HINT = "SHA-256 of the evidence file (64 hex characters)";
export const REASON = "Reason (at least 10 characters; never a CNIC, IBAN or phone number)";

/** The OB-10 identifiers of a property (only filled fields are sent; the database checks each). */
export function Identifiers({ values = {} }: { values?: Readonly<Record<string, string | null>> }) {
  const known = new Map(Object.entries(values));
  const f = (name: string, label: string, type = "text") => <Field key={name} label={label} name={`id.${name}`} type={type} defaultValue={known.get(name) ?? undefined} />;
  return (
    <div className="stack" style={{ gap: 6 }}>
      <Pick label="Province" name="id.province" options={["punjab", "sindh", "kp", "balochistan", "ict", "gb", "ajk"]} required={false} empty="–" />
      {f("district", "District")}
      {f("building", "Building name")}
      {f("society", "Housing society")}
      {f("plot_no", "Plot no.")}
      {f("mauza", "Mauza")}
      {f("khasra", "Khasra")}
      {f("sub_registrar", "Sub-registrar office")}
      {f("deed_no", "Deed no.")}
      {f("deed_date", "Deed date", "date")}
      {f("land_record_ref", "Land-record reference")}
      {f("excise_no", "Property-tax (excise) no.")}
      {f("land_area", "Land area")}
      <Pick label="Area unit" name="id.land_area_unit" options={["sq_ft", "sq_m", "marla", "kanal", "acre"]} required={false} empty="–" />
      {f("gps_lat", "GPS latitude")}
      {f("gps_lon", "GPS longitude")}
      <Pick label="Use" name="id.use" options={["commercial", "residential", "mixed"]} required={false} empty="–" />
      <Pick label="Occupancy" name="id.occupancy" options={["vacant", "owner_occupied", "tenanted", "partly_tenanted"]} required={false} empty="–" />
      <Pick
        label="Built"
        name="id.built"
        options={[
          ["yes", "yes"],
          ["no", "no"],
        ]}
        required={false}
        empty="–"
      />
    </div>
  );
}

/** A file already in the vault (stored on /documents or uploaded by the sponsor) and not yet recorded. */
export function VaultPick({ files }: { files: readonly { sha256: string; sizeBytes: number; mediaType: string; by: string; at: string }[] }) {
  return (
    <Pick
      label="File in the vault"
      name="sha256"
      options={files.map((v): [string, string] => [v.sha256, `${v.sha256.slice(0, 12)}… · ${v.mediaType} · ${Math.ceil(v.sizeBytes / 1024)} kB · ${v.by}`])}
      empty={files.length ? "Choose…" : "No unrecorded file in the vault"}
    />
  );
}

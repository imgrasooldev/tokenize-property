/**
 * goAML STR draft (migration 0050): the XML report the MLRO completes and files with the Financial
 * Monitoring Unit. Built from admin.str_goaml_data: the case, the reporting entity's settings, the
 * indicator and the investor's money movements. The person's name and CNIC are never in the portal:
 * the file marks where the MLRO adds them from the KYC record. Placeholder values are listed in a
 * comment at the top so nobody files a draft by mistake.
 */
export interface GoamlData {
  case: number;
  category: string;
  categoryLabel: string | null;
  summary: string;
  openedAtUtc: string;
  indicator: { code: string; placeholder: boolean } | null;
  settings: Record<string, { value: string; placeholder: boolean }>;
  subject: { subjectId: string; cnicMasked: string | null; wallet: string | null } | null;
  actions: string[];
  transactions: { direction: "in" | "out"; ref: string; internalRef: string | null; date: string; amountPaisa: string; counterpartyLast4: string; purpose: string }[];
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function rupees(paisa: string): string {
  const n = BigInt(paisa);
  const r = n % 100n;
  return `${(n / 100n).toString()}.${r.toString().padStart(2, "0")}`;
}

const MLRO = "<!-- MLRO: complete from the KYC record -->";

export function goamlXml(d: GoamlData, submittedAtUtc: string): string {
  const set = new Map(Object.entries(d.settings));
  const v = (k: string): string => esc(set.get(k)?.value ?? "");
  const placeholders = [...set.entries()].filter(([, x]) => x.placeholder).map(([k]) => k);
  if (d.indicator?.placeholder) placeholders.push(`indicator for ${d.category}`);
  const person = `
        <t_person>
          <first_name>${MLRO}</first_name>
          <last_name>${MLRO}</last_name>
          <ssn>${MLRO}</ssn>
          <id_number>${esc(d.subject?.cnicMasked ?? "")}</id_number>
          <nationality1>PK</nationality1>
        </t_person>`;
  const account = (last4: string) => `
        <account>
          <institution_name>${MLRO}</institution_name>
          <account>****${esc(last4)}</account>
          <currency_code>PKR</currency_code>
        </account>`;
  const entity = `
        <entity>
          <name>${MLRO}</name>
          <incorporation_number>${v("rentity_id")}</incorporation_number>
        </entity>`;
  const tx = d.transactions
    .map(
      (t) => `
    <transaction>
      <transactionnumber>${esc(t.ref)}</transactionnumber>
      <internal_ref_number>${esc(t.internalRef ?? "")}</internal_ref_number>
      <transaction_location>Online (Raast)</transaction_location>
      <transaction_description>${esc(t.purpose)}</transaction_description>
      <date_transaction>${esc(t.date)}T00:00:00</date_transaction>
      <transmode_code>${v("transmode_code")}</transmode_code>
      <amount_local>${rupees(t.amountPaisa)}</amount_local>${
        t.direction === "in"
          ? `
      <t_from_my_client>
        <from_funds_code>${v("funds_code_in")}</from_funds_code>
        <from_account>${account(t.counterpartyLast4)}${person}
        </from_account>
        <from_country>PK</from_country>
      </t_from_my_client>
      <t_to>
        <to_funds_code>${v("funds_code_in")}</to_funds_code>
        <to_entity>${entity}
        </to_entity>
        <to_country>PK</to_country>
      </t_to>`
          : `
      <t_from>
        <from_funds_code>${v("funds_code_out")}</from_funds_code>
        <from_entity>${entity}
        </from_entity>
        <from_country>PK</from_country>
      </t_from>
      <t_to_my_client>
        <to_funds_code>${v("funds_code_out")}</to_funds_code>
        <to_account>${account(t.counterpartyLast4)}${person}
        </to_account>
        <to_country>PK</to_country>
      </t_to_my_client>`
      }
    </transaction>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!--
  DRAFT goAML STR (schema ${esc(set.get("schema_version")?.value ?? "?")} subset), Property Token STR case ${String(d.case)}.
  Confidential: never disclose to the investor (tipping-off, AML Act 2010 s.34).
  The MLRO completes the marked person fields from the KYC record before filing.
  Placeholder values still to confirm with the FMU: ${placeholders.length ? esc(placeholders.join(", ")) : "none"}.
-->
<report>
  <rentity_id>${v("rentity_id")}</rentity_id>
  <rentity_branch>${v("rentity_branch")}</rentity_branch>
  <submission_code>E</submission_code>
  <report_code>STR</report_code>
  <entity_reference>PT-STR-${String(d.case)}</entity_reference>
  <submission_date>${esc(submittedAtUtc.replace(/Z$/, ""))}</submission_date>
  <currency_code_local>PKR</currency_code_local>
  <reporting_person>
    <first_name>${MLRO}</first_name>
    <last_name>${MLRO}</last_name>
    <occupation>Money Laundering Reporting Officer</occupation>
  </reporting_person>
  <location>
    <address_type>B</address_type>
    <address>${v("entity_address")}</address>
    <city>${v("entity_city")}</city>
    <country_code>${v("entity_country")}</country_code>
  </location>
  <reason>${esc(`${d.categoryLabel ?? d.category}: ${d.summary}`)}</reason>
  <action>${esc(d.actions.length ? d.actions.join("; ") : "No freeze or hold requested.")}</action>
  <transactions>${tx}
  </transactions>
  <report_indicators>
    <indicator>${esc(d.indicator?.code ?? "")}</indicator>
  </report_indicators>
</report>
`;
}

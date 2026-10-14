-- Website: payout accounts, the public property catalogue, published document hashes and the
-- reconciliation status (task T-045). The website's role (pt_web, migration 0012 W-5) gets four
-- thin read functions and nothing else of the bank, property and recon schemas. Same pattern as
-- migration 0018 (offering.web_*).
--
-- Numbered 0022: 0020 and 0021 are reserved for parallel branches (the runner refuses gaps, so merge
-- those first; tests use contiguousMigrations()).
--
-- Safety properties enforced by the database itself (rule IDs WA-n):
--   WA-1  Least privilege: pt_web may EXECUTE bank.web_payees, property.web_catalog,
--         property.web_documents and recon.web_status, and nothing else in schemas bank, property
--         and recon (no table, no view, no other function). Registering a payout account stays with
--         the bank service (bank.register_payee needs the keyed IBAN hash, the sealed IBAN and the
--         keyed hash of the title the bank returned: the website holds none of those keys).
--   WA-2  Payout accounts are read for ONE KYC subject (the website passes the signed-in investor's
--         subject): last four digits, bank code, registration time, the end of the 72-hour cooling-off
--         (active_from) and when it was replaced. Never the IBAN hash or the sealed IBAN.
--   WA-3  The public catalogue covers only properties whose offering investors may already see
--         (offering.web_offerings, WO-5: ready and later). It returns coarse public facts: building
--         name (no floor, unit, plot, khasra, deed, address or GPS), province, district, use, covered
--         area, occupancy, number of leases, declared monthly rent, the trust structure (kind, Shariah,
--         planned units, holding limit), the trustee's acceptance time (not the officer), whether the
--         sponsor's KYB is approved (not who the sponsor is), and the independent valuations (count,
--         lowest, highest, latest date; not the valuers).
--   WA-4  Published document hashes: the current (not superseded) documents of a catalogue property of
--         an allow-listed set of types, as SHA-256 with upload time and whether a source check verified
--         them. KYB documents, leases, rent rolls, tax receipts, utility bills, photos, court orders and
--         committee minutes are never listed. Files are never served.
--   WA-5  Reconciliation status: the latest finished run (passed or failed), its time, pinned block and
--         the number of blocking findings and warnings, plus whether payouts are allowed now. Never
--         the findings themselves (they may name investors, S-07 section 5).

-- ------------------------------------------------------------------ WA-2 payout accounts
CREATE FUNCTION bank.web_payees(p_subject uuid)
RETURNS TABLE (payee_id bigint, last4 text, bank_code text, registered_at timestamptz, active_from timestamptz, superseded_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, bank AS $$
  SELECT p.id, p.iban_last4, p.bank_code, p.registered_at, p.active_from, p.superseded_at
  FROM bank.payees p
  WHERE p_subject IS NOT NULL AND p.subject_id = p_subject
  ORDER BY p.registered_at DESC, p.id DESC
  LIMIT 20
$$;

-- ------------------------------------------------------------------ WA-3 public catalogue
CREATE FUNCTION property.web_catalog()
RETURNS TABLE (
  offering_id uuid, offering_state text, token text, building text, province text, district text, property_use text,
  covered_area_sqft numeric, built boolean, occupancy text, lease_count integer, monthly_rent_paisa bigint,
  structure_kind text, shariah boolean, planned_units numeric, max_holding_units numeric, trustee_accepted_at timestamptz,
  sponsor_kyb_approved boolean, valuations integer, valuation_low_paisa bigint, valuation_high_paisa bigint, valued_on date
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, property, offering AS $$
  SELECT o.id, o.state, o.token, p.building, p.province, p.district, p.use,
         p.covered_area_sqft, p.built, p.occupancy, p.lease_count, p.monthly_rent_paisa,
         s.kind, s.shariah, s.planned_units, s.max_holding_units, td.at,
         property.sponsor_state(p.sponsor_id) = 'kyb_approved',
         coalesce(v.n, 0), v.low, v.high, v.latest
  FROM offering.offerings o
  JOIN property.properties p ON p.id = o.property_id
  LEFT JOIN LATERAL (
    SELECT d.structure_id, d.at FROM property.trustee_decisions d
    WHERE d.property_id = p.id AND d.decision = 'accept' ORDER BY d.id DESC LIMIT 1
  ) td ON true
  LEFT JOIN property.structures s ON s.id = coalesce(o.structure_id, td.structure_id)
  LEFT JOIN LATERAL (
    SELECT count(*)::int AS n, min(x.value_paisa) AS low, max(x.value_paisa) AS high, max(x.valued_on) AS latest
    FROM property.valuations x WHERE x.property_id = p.id
  ) v ON true
  WHERE o.state IN ('ready', 'live', 'suspended', 'closing', 'funded', 'completing', 'completed', 'failed', 'refunding', 'cancelled')
  ORDER BY CASE o.state WHEN 'live' THEN 0 WHEN 'ready' THEN 1 WHEN 'closing' THEN 2 WHEN 'suspended' THEN 3 ELSE 4 END,
           o.opens_at DESC NULLS LAST, o.id
$$;

-- ------------------------------------------------------------------ WA-4 published document hashes
CREATE FUNCTION property.web_public_doc_type(p text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT p IN ('title_deed', 'land_record_extract', 'approved_building_plan', 'completion_certificate', 'insurance_policy',
               'valuation_report', 'legal_opinion', 'technical_report', 'trust_deed', 'spv_documents', 'shariah_certificate',
               'audited_financials')
$$;

CREATE FUNCTION property.web_documents(p_offering uuid)
RETURNS TABLE (doc_type text, chain_doc_type text, sha256 text, uploaded_at timestamptz, verified boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, property, offering AS $$
  SELECT d.doc_type, t.chain_doc_type, encode(d.sha256, 'hex'), d.uploaded_at,
         EXISTS (SELECT 1 FROM property.document_verifications x WHERE x.document_id = d.id AND x.outcome = 'verified')
  FROM offering.offerings o
  JOIN property.documents d ON d.property_id = o.property_id
  JOIN property.doc_types t ON t.code = d.doc_type
  WHERE p_offering IS NOT NULL AND o.id = p_offering
    AND o.state IN ('ready', 'live', 'suspended', 'closing', 'funded', 'completing', 'completed', 'failed', 'refunding', 'cancelled')
    AND property.web_public_doc_type(d.doc_type)
    AND property.is_current(d.id)
  ORDER BY d.doc_type, d.uploaded_at DESC
  LIMIT 100
$$;

-- ------------------------------------------------------------------ WA-5 reconciliation status
CREATE FUNCTION recon.web_status()
RETURNS TABLE (status text, finished_at timestamptz, pinned_block bigint, blocking integer, warnings integer, payouts_allowed boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, recon AS $$
  SELECT r.status, r.finished_at, r.pinned_block, r.blocking, r.warnings, (SELECT g.allowed FROM recon.payout_gate() g)
  FROM recon.runs r
  WHERE r.status IN ('passed', 'failed')
  ORDER BY r.id DESC
  LIMIT 1
$$;

-- ------------------------------------------------------------------ privileges (WA-1)
REVOKE ALL ON FUNCTION
  bank.web_payees(uuid),
  property.web_catalog(),
  property.web_public_doc_type(text),
  property.web_documents(uuid),
  recon.web_status()
FROM PUBLIC;

GRANT USAGE ON SCHEMA bank, property, recon TO pt_web;
GRANT EXECUTE ON FUNCTION
  bank.web_payees(uuid),
  property.web_catalog(),
  property.web_documents(uuid),
  recon.web_status()
TO pt_web;

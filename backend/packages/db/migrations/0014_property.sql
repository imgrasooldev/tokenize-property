-- Sponsor onboarding (KYB), property submission and due diligence (spec S-01, task T-021).
--
-- Safety properties enforced by the database itself (rule IDs PR-n; S-01 rule IDs in brackets):
--   PR-1  No readable personal data [S-01 §5, acceptance 8]. People are KYC subject ids only
--         (kyc.subjects, ADR 0009 Y-1). Sponsor registration numbers (CUIN, NTN, STRN; an
--         individual's NTN is their CNIC) are stored as keyed hashes (HMAC-SHA256, pepper held by the
--         service) plus the last four characters; the legal name and the registered address are sealed
--         by the service (AES-256-GCM, key outside the database). One sponsor per registration number
--         and per individual owner. Files are not stored here: a document is its SHA-256, size, media
--         type and an opaque store reference [OB-12].
--   PR-2  Every state lives in an append-only event table. A transition is accepted only if it is in
--         property.transitions (the S-01 state machines K1..K11 and P1..P14, nothing else) and starts
--         from the current state; a trigger re-checks this on every insert, whoever writes the row. The
--         guards of S-01 §3 are checked in the transition functions (KYB approval needs SECP
--         verification, a clear screening, a risk rating and every director, representative and
--         beneficial owner KYC-verified; submission needs an approved sponsor, complete identifiers,
--         the mandatory documents and a duplicate check without exact match; and so on).
--   PR-3  KYB status is derived here [OB-7, K7]: an approved sponsor reads as expired after the
--         validity period or as soon as one of its people is no longer KYC-verified.
--   PR-4  Maker-checker [README §4, OB-SOD-2]: K4, K5, K10, K11, P6, P13, P14 and the clearance of a
--         possible screening match are requests decided by a DIFFERENT officer holding the required
--         duty; one rejection is final; requests expire (72 h) or go stale when the state changes.
--         Duplicates (P3 and clearing a possible match) need an onboarding AND a compliance officer.
--         P7 needs an investment-committee quorum; P8 needs the legal head's structure decision AND a
--         trustee officer's acceptance.
--   PR-5  Separation of duties [OB-SOD-1..5]: duties (onboarding, compliance, legal, valuation,
--         technical, investment committee, trustee) are granted maker-checker in property.staff_duties;
--         a trustee officer holds no other duty; whoever entered or submitted a file never decides it;
--         the three reviewers (legal, valuation, technical) are different people and not the officer
--         who assigned them; committee members who took part in the file cannot vote.
--   PR-6  Duplicate detection [OB-11, OB-14..OB-17] runs in the database at submission, against every
--         property that was ever submitted (any state, every sponsor), under one lock, so two
--         concurrent submissions of the same property cannot both pass. Identifiers are normalised by
--         property.norm (NFKC, Urdu and Arabic-Indic digits, Arabic letter variants, case, spacing,
--         punctuation; separators between digits kept as '/').
--   PR-7  A review relies on the hashes of current documents only; superseding a document, a new
--         encumbrance or a material change reopens the affected reviews (and moves a Legal Approved or
--         Tokenization Ready property back to Under Review) [OB-31, OB-39].
--   PR-8  Append-only records and a hash-chained audit log with UTC timestamps (finding F-04).
--         property.verify_audit() re-checks the chain, the content of transitions, documents, reviews,
--         valuations and votes, replays every state and finds rows written around the API.
--   PR-9  Roles: pt_property_writer (intake on the sponsor's behalf), pt_property_reviewer (officers'
--         decisions), pt_property_admin (duties and the valuer panel), pt_property_reader (overviews
--         without sealed values or compliance detail). No role writes a table directly.
--
-- LEGAL TO CONFIRM items are kept configurable in property.settings, property.mandatory_documents and
-- property.doc_types (see the notes there). Amounts in paisa (bigint), units numeric(78,0).

CREATE SCHEMA IF NOT EXISTS property;
REVOKE ALL ON SCHEMA property FROM PUBLIC;

DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['pt_property_writer', 'pt_property_reviewer', 'pt_property_admin', 'pt_property_reader'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN', r);
    END IF;
  END LOOP;
END $$;

-- ================================================================== helpers
CREATE FUNCTION property.forbid_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'property records are append-only: % on %.% is not allowed', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE FUNCTION property.utc(p timestamptz) RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT to_char(p AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
$$;

/** Raises with an SQLSTATE the service maps to an error code (22023 input, 42501 duty/SoD, 23514 guard, 23505 duplicate, P0002 unknown). */
CREATE FUNCTION property.fail(p_code text, p_message text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '%', p_message USING ERRCODE = p_code;
END $$;

CREATE FUNCTION property.check_actor(p text) RETURNS void
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF p IS NULL OR p !~ '^[A-Za-z0-9][A-Za-z0-9@._:+-]{1,99}$' THEN
    PERFORM property.fail('22023', 'an actor id of 2-100 characters (letters, digits, @._:+-) is required');
  END IF;
END $$;

CREATE FUNCTION property.check_reason(p text, p_what text DEFAULT 'reason') RETURNS void
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF p IS NULL OR length(btrim(p)) NOT BETWEEN 10 AND 500 THEN
    PERFORM property.fail('22023', format('a %s of 10-500 characters is required', p_what));
  END IF;
END $$;

CREATE FUNCTION property.check_sha(p bytea, p_what text) RETURNS void
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF p IS NULL OR length(p) <> 32 THEN
    PERFORM property.fail('22023', format('%s must be a SHA-256 (32 bytes)', p_what));
  END IF;
END $$;

-- ------------------------------------------------------------------ settings (LEGAL TO CONFIRM values)
-- Values change only through a new migration (no role can write this table).
CREATE TABLE property.settings (
  key              text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]{2,40}$'),
  value            numeric NOT NULL CHECK (value >= 0),
  legal_to_confirm boolean NOT NULL,
  note             text NOT NULL
);
INSERT INTO property.settings (key, value, legal_to_confirm, note) VALUES
  ('bo_threshold_bp', 2500, true, 'OB-4: beneficial-owner threshold in basis points (25 %); SECP/AML rules may require 10 % for higher risk'),
  ('kyb_validity_days', 365, false, 'OB-7 / K7: KYB validity after approval'),
  ('title_years', 30, true, 'OB-20: title search period when the chain does not reach the original grant or allotment'),
  ('valuation_tolerance_bp', 1000, true, 'OB-26 / Q-4: two valuations within 10 % of the lower one, otherwise a third'),
  ('valuation_gap_days', 60, true, 'OB-25: the two valuations are made within 60 days of each other'),
  ('valuation_validity_days', 183, true, 'OB-26: a valuation is valid for 6 months'),
  ('gps_radius_m', 30, false, 'OB-14/15: GPS points within this distance are a possible duplicate'),
  ('request_expiry_hours', 72, false, 'maker-checker requests expire (as ADR 0009 Y-4)'),
  ('ic_quorum', 3, false, 'OB-33: investment-committee quorum'),
  ('max_balance_bp', 1000, false, 'OB-36 / contract-spec 4.3: MaxBalanceModule limit as a share of the planned register');

CREATE FUNCTION property.setting(p_key text) RETURNS numeric
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, property AS $$
DECLARE
  v numeric;
BEGIN
  SELECT value INTO v FROM property.settings WHERE key = p_key;
  IF NOT FOUND THEN PERFORM property.fail('P0002', format('setting %s is missing', p_key)); END IF;
  RETURN v;
END $$;

-- ------------------------------------------------------------------ identifier normalisation (OB-11)
/**
 * Normalises one identifier for comparison: NFKC (full-width forms, Arabic presentation forms),
 * Urdu (U+06F0..9) and Arabic-Indic (U+0660..9) digits to 0-9, Arabic yeh/alef maksura/kaf/heh to
 * their Urdu forms, a-z upper-cased, a run of separators (- / dashes, with spaces) BETWEEN TWO DIGITS
 * kept as one '/', every other character that is not A-Z, 0-9 or an Arabic-script letter removed,
 * and leading zeros of every digit run dropped. Mirrored by normIdentifier() in @pt/property.
 * Keeping '/' between digits is a deliberate refinement of OB-11 ("punctuation removed"): khasra
 * 123/4 and 1234 are different parcels. LEGAL TO CONFIRM with the land-record conventions per province.
 */
CREATE FUNCTION property.norm(p text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog AS $$
  SELECT regexp_replace(
           replace(
             regexp_replace(
               regexp_replace(
                 translate(normalize(coalesce(p, ''), NFKC),
                           'abcdefghijklmnopqrstuvwxyz۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩يىكه',
                           'ABCDEFGHIJKLMNOPQRSTUVWXYZ01234567890123456789ییکہ'),
                 '([0-9])[ \t\n\r\f\v]*[-/‐-―−]+[ \t\n\r\f\v]*(?=[0-9])', '\1' || chr(57344), 'g'),
               '[^A-Z0-9ء-غف-يٱ-ۓە]', '', 'g'),
             chr(57344), '/'),
           '(^|[^0-9])0+(?=[0-9])', '\1', 'g')
$$;

/**
 * OB-11 property key: province | district | locality | parcel | building:floor:unit. A society plot
 * uses S:<society>|P:<plot>; revenue land uses M:<mauza>|K:<khewat>-<khasra>. NULL while incomplete.
 * The components are joined with separators that norm() never produces, so "AB"+"C" <> "A"+"BC".
 */
CREATE FUNCTION property.make_key(p_province text, p_district text, p_mauza text, p_society text, p_khewat text,
                                  p_khasra text, p_plot text, p_building text, p_floor text, p_unit text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog, property AS $$
  SELECT CASE
    WHEN p_province IS NULL OR property.norm(p_district) = '' THEN NULL
    WHEN property.norm(p_plot) <> '' AND property.norm(p_society) <> '' THEN
      p_province || '|' || property.norm(p_district) || '|S:' || property.norm(p_society) || '|P:' || property.norm(p_plot)
      || '|' || property.norm(p_building) || ':' || property.norm(p_floor) || ':' || property.norm(p_unit)
    WHEN property.norm(p_khasra) <> '' AND property.norm(p_mauza) <> '' THEN
      p_province || '|' || property.norm(p_district) || '|M:' || property.norm(p_mauza) || '|K:' || property.norm(p_khewat)
      || '-' || property.norm(p_khasra) || '|' || property.norm(p_building) || ':' || property.norm(p_floor) || ':' || property.norm(p_unit)
    ELSE NULL
  END
$$;

/** Great-circle distance in metres (haversine, mean Earth radius). */
CREATE FUNCTION property.distance_m(lat1 numeric, lon1 numeric, lat2 numeric, lon2 numeric) RETURNS double precision
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog AS $$
  SELECT 2 * 6371008.8 * asin(sqrt(
    power(sin(radians((lat2 - lat1)::double precision) / 2), 2)
    + cos(radians(lat1::double precision)) * cos(radians(lat2::double precision)) * power(sin(radians((lon2 - lon1)::double precision) / 2), 2)))
$$;

-- ================================================================== audit (PR-8)
CREATE TABLE property.audit (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at        timestamptz NOT NULL,
  actor     text NOT NULL CHECK (length(actor) BETWEEN 1 AND 100),
  action    text NOT NULL CHECK (action ~ '^[a-z][a-z_.]{2,63}$'),
  detail    jsonb NOT NULL CHECK (jsonb_typeof(detail) = 'object' AND octet_length(detail::text) <= 8192),
  prev_hash bytea NOT NULL CHECK (length(prev_hash) = 32),
  hash      bytea NOT NULL UNIQUE CHECK (length(hash) = 32)
);
CREATE INDEX audit_ref_idx ON property.audit ((detail->>'ref'));

CREATE FUNCTION property.audit_digest(p_prev bytea, p_id bigint, p_at timestamptz, p_actor text, p_action text, p_detail jsonb)
RETURNS bytea LANGUAGE sql STABLE SET search_path = pg_catalog, property AS $$
  SELECT sha256(p_prev || convert_to('pt-property-audit-v1' || jsonb_build_array(p_id, property.utc(p_at), p_actor, p_action, p_detail)::text, 'UTF8'))
$$;

CREATE FUNCTION property.audit_append(p_actor text, p_action text, p_detail jsonb)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, property AS $$
DECLARE
  v_prev bytea;
  v_id bigint;
  v_at timestamptz := date_trunc('microseconds', clock_timestamp());
  v_detail jsonb := coalesce(p_detail, '{}'::jsonb);
BEGIN
  PERFORM pg_advisory_xact_lock(586586140);
  SELECT hash INTO v_prev FROM property.audit ORDER BY id DESC LIMIT 1;
  v_prev := coalesce(v_prev, decode(repeat('00', 32), 'hex'));
  v_id := nextval(pg_get_serial_sequence('property.audit', 'id'));
  INSERT INTO property.audit (id, at, actor, action, detail, prev_hash, hash)
  OVERRIDING SYSTEM VALUE
  VALUES (v_id, v_at, p_actor, p_action, v_detail, v_prev, property.audit_digest(v_prev, v_id, v_at, p_actor, p_action, v_detail));
  RETURN v_id;
END $$;

-- Orders reviews and reopenings (a review is stale if its discipline was reopened after it).
CREATE SEQUENCE property.seq;

-- ================================================================== duties (PR-5)
CREATE TABLE property.staff_duties (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor         text NOT NULL CHECK (actor ~ '^[A-Za-z0-9][A-Za-z0-9@._:+-]{1,99}$'),
  duty          text NOT NULL CHECK (duty IN ('onboarding', 'compliance', 'compliance_senior', 'legal', 'legal_head', 'valuation',
                                              'technical', 'ic_member', 'ic_independent', 'trustee')),
  requested_by  text NOT NULL CHECK (length(requested_by) BETWEEN 2 AND 100),
  reason        text NOT NULL CHECK (length(reason) BETWEEN 10 AND 500),
  requested_at  timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'rejected', 'revoked')),
  decided_by    text CHECK (length(decided_by) BETWEEN 2 AND 100),
  decided_at    timestamptz,
  revoked_by    text CHECK (length(revoked_by) BETWEEN 2 AND 100),
  revoke_reason text CHECK (length(revoke_reason) BETWEEN 10 AND 500),
  revoked_at    timestamptz,
  CHECK (requested_by <> actor),
  CHECK (decided_by IS DISTINCT FROM requested_by AND decided_by IS DISTINCT FROM actor),
  CHECK ((status = 'pending') = (decided_by IS NULL)),
  CHECK ((status = 'revoked') = (revoked_by IS NOT NULL AND revoke_reason IS NOT NULL AND revoked_at IS NOT NULL))
);
CREATE UNIQUE INDEX staff_duties_live ON property.staff_duties (actor, duty) WHERE status IN ('pending', 'active');

CREATE FUNCTION property.guard_staff_duty() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'duties are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (NEW.id, NEW.actor, NEW.duty, NEW.requested_by, NEW.reason, NEW.requested_at)
     IS DISTINCT FROM (OLD.id, OLD.actor, OLD.duty, OLD.requested_by, OLD.reason, OLD.requested_at)
     OR NOT ((OLD.status = 'pending' AND NEW.status IN ('active', 'rejected') AND NEW.revoked_by IS NULL)
             OR (OLD.status = 'active' AND NEW.status = 'revoked' AND (NEW.decided_by, NEW.decided_at) IS NOT DISTINCT FROM (OLD.decided_by, OLD.decided_at))) THEN
    RAISE EXCEPTION 'duty % can only be decided once and revoked once', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER staff_duties_guard BEFORE UPDATE OR DELETE ON property.staff_duties FOR EACH ROW EXECUTE FUNCTION property.guard_staff_duty();

/** OB-SOD-5: a trustee officer holds no platform duty; an IC member is either independent or not. */
CREATE FUNCTION property.guard_duty_conflict() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM property.staff_duties d
             WHERE d.actor = NEW.actor AND d.status IN ('pending', 'active') AND d.id <> NEW.id
               AND ((d.duty = 'trustee') <> (NEW.duty = 'trustee')
                    OR (d.duty IN ('ic_member', 'ic_independent') AND NEW.duty IN ('ic_member', 'ic_independent') AND d.duty <> NEW.duty))) THEN
    RAISE EXCEPTION 'duty % conflicts with a duty % already holds (trustee officers hold no platform duty)', NEW.duty, NEW.actor
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER staff_duties_conflict BEFORE INSERT ON property.staff_duties FOR EACH ROW EXECUTE FUNCTION property.guard_duty_conflict();

CREATE FUNCTION property.has_duty(p_actor text, p_duties text[]) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, property AS $$
  SELECT EXISTS (SELECT 1 FROM property.staff_duties WHERE actor = p_actor AND status = 'active' AND duty = ANY (p_duties))
$$;

CREATE FUNCTION property.need_duty(p_actor text, p_duties text[], p_what text) RETURNS void
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, property AS $$
BEGIN
  PERFORM property.check_actor(p_actor);
  IF NOT property.has_duty(p_actor, p_duties) THEN
    PERFORM property.fail('42501', format('%s needs an active %s duty to %s', p_actor, array_to_string(p_duties, ' or '), p_what));
  END IF;
END $$;

CREATE FUNCTION property.request_duty(p_actor text, p_duty text, p_by text, p_reason text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, property AS $$
DECLARE
  v_id bigint;
BEGIN
  PERFORM property.check_actor(p_actor);
  PERFORM property.check_actor(p_by);
  PERFORM property.check_reason(p_reason);
  IF p_actor = p_by THEN PERFORM property.fail('42501', 'nobody requests a duty for themselves'); END IF;
  BEGIN
    INSERT INTO property.staff_duties (actor, duty, requested_by, reason) VALUES (p_actor, p_duty, p_by, p_reason) RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    PERFORM property.fail('23505', format('%s already holds or awaits the %s duty', p_actor, p_duty));
  WHEN check_violation THEN
    PERFORM property.fail('22023', format('unknown duty %s', p_duty));
  END;
  PERFORM property.audit_append(p_by, 'duty.requested', jsonb_build_object('ref', 'staff_duties:' || v_id, 'actor', p_actor, 'duty', p_duty, 'reason', p_reason));
  RETURN v_id;
END $$;

CREATE FUNCTION property.decide_duty(p_id bigint, p_by text, p_approve boolean, p_reason text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, property AS $$
DECLARE
  d property.staff_duties;
BEGIN
  PERFORM property.check_actor(p_by);
  PERFORM property.check_reason(p_reason);
  SELECT * INTO d FROM property.staff_duties WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN PERFORM property.fail('P0002', 'unknown duty request'); END IF;
  IF d.status <> 'pending' THEN PERFORM property.fail('23514', 'this duty request was already decided'); END IF;
  IF p_by IN (d.requested_by, d.actor) THEN PERFORM property.fail('42501', 'the requester or the officer concerned cannot decide this duty request'); END IF;
  UPDATE property.staff_duties SET status = CASE WHEN p_approve THEN 'active' ELSE 'rejected' END,
         decided_by = p_by, decided_at = date_trunc('microseconds', clock_timestamp()) WHERE id = p_id;
  PERFORM property.audit_append(p_by, 'duty.decided', jsonb_build_object('ref', 'staff_duties:' || p_id || ':decision', 'actor', d.actor, 'duty', d.duty,
                                                                       'approved', p_approve, 'reason', p_reason));
  RETURN CASE WHEN p_approve THEN 'active' ELSE 'rejected' END;
END $$;

/** Revoking is protective: one administrator is enough. */
CREATE FUNCTION property.revoke_duty(p_id bigint, p_by text, p_reason text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, property AS $$
DECLARE
  d property.staff_duties;
BEGIN
  PERFORM property.check_actor(p_by);
  PERFORM property.check_reason(p_reason);
  SELECT * INTO d FROM property.staff_duties WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN PERFORM property.fail('P0002', 'unknown duty'); END IF;
  IF d.status <> 'active' THEN PERFORM property.fail('23514', 'only an active duty can be revoked'); END IF;
  UPDATE property.staff_duties SET status = 'revoked', revoked_by = p_by, revoke_reason = p_reason,
         revoked_at = date_trunc('microseconds', clock_timestamp()) WHERE id = p_id;
  PERFORM property.audit_append(p_by, 'duty.revoked', jsonb_build_object('ref', 'staff_duties:' || p_id || ':revoked', 'actor', d.actor, 'duty', d.duty, 'reason', p_reason));
  RETURN true;
END $$;

-- ================================================================== catalogues (LEGAL TO CONFIRM)
-- Document types and their DocumentRegistry DocType (S-01 §7.2; Q-5: Other + typed off-chain catalogue).
CREATE TABLE property.doc_types (
  code           text PRIMARY KEY CHECK (code ~ '^[a-z][a-z_]{2,40}$'),
  owner_kind     text NOT NULL CHECK (owner_kind IN ('sponsor', 'property')),
  chain_doc_type text NOT NULL CHECK (chain_doc_type IN ('TitleDeed', 'LandRecord', 'Valuation', 'Insurance', 'TrustDeed', 'AuditReport',
                                                         'ShariahCertificate', 'CourtOrder', 'InvestorVote', 'Other')),
  title_class    boolean NOT NULL DEFAULT false
);
INSERT INTO property.doc_types (code, owner_kind, chain_doc_type, title_class) VALUES
  ('certificate_of_incorporation', 'sponsor', 'Other', false),
  ('memorandum_articles', 'sponsor', 'Other', false),
  ('annual_return', 'sponsor', 'Other', false),
  ('directors_list', 'sponsor', 'Other', false),
  ('ntn_certificate', 'sponsor', 'Other', false),
  ('strn_certificate', 'sponsor', 'Other', false),
  ('board_resolution', 'sponsor', 'Other', false),
  ('secp_verification', 'sponsor', 'Other', false),
  ('source_of_wealth', 'sponsor', 'Other', false),
  ('sponsor_other', 'sponsor', 'Other', false),
  ('title_deed', 'property', 'TitleDeed', true),
  ('land_record_extract', 'property', 'LandRecord', true),
  ('approved_building_plan', 'property', 'Other', false),
  ('completion_certificate', 'property', 'Other', false),
  ('property_tax_receipt', 'property', 'Other', false),
  ('utility_bill', 'property', 'Other', false),
  ('lease_agreement', 'property', 'Other', false),
  ('rent_roll', 'property', 'Other', false),
  ('mortgage_letter', 'property', 'Other', false),
  ('insurance_policy', 'property', 'Insurance', false),
  ('authority_to_sell', 'property', 'Other', false),
  ('valuation_report', 'property', 'Valuation', false),
  ('legal_opinion', 'property', 'Other', false),
  ('technical_report', 'property', 'Other', false),
  ('site_visit_photos', 'property', 'Other', false),
  ('encumbrance_search', 'property', 'Other', false),
  ('court_order', 'property', 'CourtOrder', false),
  ('trust_deed', 'property', 'TrustDeed', false),
  ('spv_documents', 'property', 'TrustDeed', false),
  ('shariah_certificate', 'property', 'ShariahCertificate', false),
  ('audited_financials', 'property', 'AuditReport', false),
  ('ic_minutes', 'property', 'Other', false),
  ('property_other', 'property', 'Other', false);

-- OB-1 (KYB) and OB-13 (property) mandatory documents. LEGAL TO CONFIRM the lists, per province.
CREATE TABLE property.mandatory_documents (
  applies_to text NOT NULL CHECK (applies_to IN ('company', 'individual', 'property')),
  doc_type   text NOT NULL REFERENCES property.doc_types (code),
  condition  text NOT NULL CHECK (condition IN ('always', 'built', 'tenanted', 'charged')),
  PRIMARY KEY (applies_to, doc_type)
);
INSERT INTO property.mandatory_documents (applies_to, doc_type, condition) VALUES
  ('company', 'certificate_of_incorporation', 'always'),
  ('company', 'memorandum_articles', 'always'),
  ('company', 'annual_return', 'always'),
  ('company', 'directors_list', 'always'),
  ('company', 'ntn_certificate', 'always'),
  ('company', 'board_resolution', 'always'),
  ('property', 'title_deed', 'always'),
  ('property', 'land_record_extract', 'always'),
  ('property', 'property_tax_receipt', 'always'),
  ('property', 'authority_to_sell', 'always'),
  ('property', 'approved_building_plan', 'built'),
  ('property', 'completion_certificate', 'built'),
  ('property', 'utility_bill', 'built'),
  ('property', 'insurance_policy', 'built'),
  ('property', 'lease_agreement', 'tenanted'),
  ('property', 'rent_roll', 'tenanted'),
  ('property', 'mortgage_letter', 'charged');

-- PR-2: the only transitions that exist (S-01 §3.1 and §3.2), with their audit event names.
CREATE TABLE property.transitions (
  entity     text NOT NULL CHECK (entity IN ('sponsor', 'property')),
  code       text NOT NULL CHECK (code ~ '^[KP][0-9]{1,2}$'),
  from_state text NOT NULL,
  to_state   text NOT NULL,
  action     text NOT NULL,
  PRIMARY KEY (entity, code, from_state)
);
INSERT INTO property.transitions (entity, code, from_state, to_state, action) VALUES
  ('sponsor', 'K1', 'kyb_draft', 'kyb_submitted', 'sponsor.submitted'),
  ('sponsor', 'K2', 'kyb_submitted', 'kyb_review', 'sponsor.accepted_for_review'),
  ('sponsor', 'K3', 'kyb_submitted', 'kyb_draft', 'sponsor.returned'),
  ('sponsor', 'K4', 'kyb_review', 'kyb_approved', 'sponsor.kyb_approved'),
  ('sponsor', 'K5', 'kyb_review', 'kyb_rejected', 'sponsor.kyb_rejected'),
  ('sponsor', 'K6', 'kyb_review', 'kyb_draft', 'sponsor.query_raised'),
  ('sponsor', 'K7', 'kyb_approved', 'kyb_expired', 'sponsor.kyb_expired'),
  ('sponsor', 'K8', 'kyb_approved', 'kyb_suspended', 'sponsor.suspended'),
  ('sponsor', 'K9', 'kyb_expired', 'kyb_review', 'sponsor.refresh_submitted'),
  ('sponsor', 'K10', 'kyb_suspended', 'kyb_review', 'sponsor.reinstated'),
  ('sponsor', 'K11', 'kyb_suspended', 'kyb_rejected', 'sponsor.kyb_rejected'),
  ('property', 'P1', 'draft', 'submitted', 'property.submitted'),
  ('property', 'P2', 'submitted', 'draft', 'property.returned'),
  ('property', 'P3', 'submitted', 'rejected', 'property.rejected_duplicate'),
  ('property', 'P4', 'submitted', 'under_review', 'property.review_started'),
  ('property', 'P5', 'under_review', 'draft', 'property.query_raised'),
  ('property', 'P6', 'under_review', 'rejected', 'property.rejected'),
  ('property', 'P7', 'under_review', 'legal_approved', 'property.legal_approved'),
  ('property', 'P8', 'legal_approved', 'tokenization_ready', 'property.tokenization_ready'),
  ('property', 'P9', 'legal_approved', 'under_review', 'property.reopened'),
  ('property', 'P10', 'tokenization_ready', 'under_review', 'property.reopened'),
  ('property', 'P11', 'draft', 'withdrawn', 'property.withdrawn'),
  ('property', 'P11', 'submitted', 'withdrawn', 'property.withdrawn'),
  ('property', 'P11', 'under_review', 'withdrawn', 'property.withdrawn'),
  ('property', 'P11', 'legal_approved', 'withdrawn', 'property.withdrawn'),
  ('property', 'P12', 'under_review', 'on_hold', 'property.on_hold'),
  ('property', 'P12', 'legal_approved', 'on_hold', 'property.on_hold'),
  ('property', 'P12', 'tokenization_ready', 'on_hold', 'property.on_hold'),
  ('property', 'P13', 'on_hold', 'under_review', 'property.resumed'),
  ('property', 'P14', 'on_hold', 'rejected', 'property.rejected');

-- ================================================================== sponsors (PR-1, PR-3)
CREATE TABLE property.sponsors (
  id             uuid PRIMARY KEY,
  kind           text NOT NULL CHECK (kind IN ('company', 'individual')),
  -- Individual owner: their KYC subject (no name here).
  owner_subject  uuid UNIQUE REFERENCES kyc.subjects (id),
  -- AES-256-GCM, sealed by the service, bound to the sponsor id.
  legal_name_enc bytea CHECK (length(legal_name_enc) BETWEEN 30 AND 1200),
  address_enc    bytea NOT NULL CHECK (length(address_enc) BETWEEN 30 AND 2000),
  pepper_version smallint NOT NULL CHECK (pepper_version BETWEEN 1 AND 999),
  cuin_last4     text CHECK (cuin_last4 ~ '^[0-9A-Z]{4}$'),
  ntn_last4      text CHECK (ntn_last4 ~ '^[0-9A-Z]{4}$'),
  state          text NOT NULL DEFAULT 'kyb_draft'
                 CHECK (state IN ('kyb_draft', 'kyb_submitted', 'kyb_review', 'kyb_approved', 'kyb_rejected', 'kyb_expired', 'kyb_suspended')),
  created_by     text NOT NULL CHECK (length(created_by) BETWEEN 2 AND 100),
  created_at     timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  CHECK ((kind = 'individual') = (owner_subject IS NOT NULL)),
  CHECK ((kind = 'company') = (legal_name_enc IS NOT NULL AND cuin_last4 IS NOT NULL))
);

-- Keyed hashes of registration numbers, one row per pepper version (as kyc.cnic_hashes).
CREATE TABLE property.sponsor_identifiers (
  id_hash        bytea PRIMARY KEY CHECK (length(id_hash) = 32),
  kind           text NOT NULL CHECK (kind IN ('cuin', 'ntn', 'strn')),
  pepper_version smallint NOT NULL CHECK (pepper_version BETWEEN 1 AND 999),
  sponsor_id     uuid NOT NULL REFERENCES property.sponsors (id),
  UNIQUE (sponsor_id, kind, pepper_version)
);

CREATE TABLE property.sponsor_persons (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sponsor_id    uuid NOT NULL REFERENCES property.sponsors (id),
  subject_id    uuid NOT NULL REFERENCES kyc.subjects (id),
  role          text NOT NULL CHECK (role IN ('owner', 'director', 'representative', 'beneficial_owner')),
  ownership_bp  integer CHECK (ownership_bp BETWEEN 0 AND 10000),
  control_basis text CHECK (control_basis IN ('shares', 'votes', 'other_control')),
  chain_depth   smallint CHECK (chain_depth BETWEEN 1 AND 10),
  -- OB-8: what a representative may do (from the board resolution).
  powers        text[] CHECK (powers <@ ARRAY['submit', 'upload', 'respond', 'withdraw']::text[]),
  added_by      text NOT NULL CHECK (length(added_by) BETWEEN 2 AND 100),
  added_at      timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  ended_by      text CHECK (length(ended_by) BETWEEN 2 AND 100),
  end_reason    text CHECK (length(end_reason) BETWEEN 10 AND 500),
  ended_at      timestamptz,
  CHECK ((role IN ('representative', 'owner')) = (powers IS NOT NULL AND cardinality(powers) >= 1)),
  CHECK (role <> 'beneficial_owner' OR control_basis IS NOT NULL),
  CHECK (role <> 'beneficial_owner' OR control_basis = 'other_control' OR ownership_bp IS NOT NULL),
  CHECK ((ended_at IS NULL) = (ended_by IS NULL) AND (ended_at IS NULL) = (end_reason IS NULL))
);
CREATE UNIQUE INDEX sponsor_persons_live ON property.sponsor_persons (sponsor_id, subject_id, role) WHERE ended_at IS NULL;

CREATE FUNCTION property.guard_person() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'sponsor persons are never deleted' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF OLD.ended_at IS NOT NULL OR (NEW.id, NEW.sponsor_id, NEW.subject_id, NEW.role, NEW.ownership_bp, NEW.control_basis, NEW.chain_depth, NEW.powers, NEW.added_by, NEW.added_at)
     IS DISTINCT FROM (OLD.id, OLD.sponsor_id, OLD.subject_id, OLD.role, OLD.ownership_bp, OLD.control_basis, OLD.chain_depth, OLD.powers, OLD.added_by, OLD.added_at) THEN
    RAISE EXCEPTION 'a sponsor person can only be ended, once' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sponsor_persons_guard BEFORE UPDATE OR DELETE ON property.sponsor_persons FOR EACH ROW EXECUTE FUNCTION property.guard_person();

-- OB-2: SECP registration verification (who, when, how, evidence).
CREATE TABLE property.registration_checks (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sponsor_id      uuid NOT NULL REFERENCES property.sponsors (id),
  method          text NOT NULL CHECK (method IN ('secp_eservices', 'provider', 'manual')),
  outcome         text NOT NULL CHECK (outcome IN ('verified', 'mismatch', 'not_found')),
  evidence_sha256 bytea NOT NULL CHECK (length(evidence_sha256) = 32),
  checked_by      text NOT NULL,
  at              timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp())
);

-- OB-5: screening of the company itself (people are screened in @pt/kyc).
CREATE TABLE property.sponsor_screenings (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sponsor_id      uuid NOT NULL REFERENCES property.sponsors (id),
  provider        text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9-]{2,39}$'),
  list_version    text NOT NULL CHECK (list_version ~ '^[A-Za-z0-9._-]{1,40}$'),
  outcome         text NOT NULL CHECK (outcome IN ('clear', 'possible_match', 'hit')),
  basis           text NOT NULL DEFAULT 'screened' CHECK (basis IN ('screened', 'cleared_false_positive')),
  evidence_sha256 bytea NOT NULL CHECK (length(evidence_sha256) = 32),
  recorded_by     text NOT NULL,
  at              timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp())
);

-- OB-6: risk rating; high risk needs enhanced due diligence evidence.
CREATE TABLE property.risk_ratings (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sponsor_id uuid NOT NULL REFERENCES property.sponsors (id),
  rating     text NOT NULL CHECK (rating IN ('low', 'medium', 'high')),
  reasons    text NOT NULL CHECK (length(reasons) BETWEEN 10 AND 500),
  edd_sha256 bytea CHECK (length(edd_sha256) = 32),
  rated_by   text NOT NULL,
  at         timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  CHECK (rating <> 'high' OR edd_sha256 IS NOT NULL)
);

-- OB-9: FMU (STR) assessment. Compliance only; never shown to the sponsor (tipping-off).
CREATE TABLE property.fmu_assessments (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sponsor_id      uuid NOT NULL REFERENCES property.sponsors (id),
  outcome         text NOT NULL CHECK (outcome IN ('no_grounds', 'str_filed', 'str_not_required')),
  evidence_sha256 bytea NOT NULL CHECK (length(evidence_sha256) = 32),
  assessed_by     text NOT NULL,
  at              timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp())
);

CREATE TABLE property.sponsor_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sponsor_id  uuid NOT NULL REFERENCES property.sponsors (id),
  code        text NOT NULL,
  from_state  text NOT NULL,
  to_state    text NOT NULL,
  actor       text NOT NULL CHECK (length(actor) BETWEEN 2 AND 100),
  acting_for  bigint REFERENCES property.sponsor_persons (id),
  reason      text CHECK (length(reason) BETWEEN 10 AND 500),
  checker     text CHECK (length(checker) BETWEEN 2 AND 100),
  request_id  bigint,
  valid_until timestamptz,
  at          timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  CHECK ((code = 'K4') = (valid_until IS NOT NULL)),
  CHECK (checker IS DISTINCT FROM actor)
);
CREATE INDEX sponsor_events_idx ON property.sponsor_events (sponsor_id, id DESC);

-- ================================================================== properties
CREATE TABLE property.properties (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sponsor_id         uuid NOT NULL REFERENCES property.sponsors (id),
  -- OB-16: a resubmission links to the rejected file it replaces.
  previous_id        uuid UNIQUE REFERENCES property.properties (id),
  state              text NOT NULL DEFAULT 'draft'
                     CHECK (state IN ('draft', 'submitted', 'under_review', 'legal_approved', 'tokenization_ready', 'rejected', 'withdrawn', 'on_hold')),
  -- OB-10 identifiers (all that apply). Not personal data: land-record and registry references.
  province           text CHECK (province IN ('punjab', 'sindh', 'kp', 'balochistan', 'ict', 'gb', 'ajk')),
  district           text CHECK (length(district) BETWEEN 2 AND 60),
  tehsil             text CHECK (length(tehsil) BETWEEN 2 AND 60),
  mauza              text CHECK (length(mauza) BETWEEN 1 AND 80),
  society            text CHECK (length(society) BETWEEN 1 AND 120),
  khewat             text CHECK (length(khewat) BETWEEN 1 AND 60),
  khatooni           text CHECK (length(khatooni) BETWEEN 1 AND 60),
  khasra             text CHECK (length(khasra) BETWEEN 1 AND 200),
  plot_no            text CHECK (length(plot_no) BETWEEN 1 AND 40),
  building           text CHECK (length(building) BETWEEN 1 AND 80),
  floor              text CHECK (length(floor) BETWEEN 1 AND 20),
  unit_no            text CHECK (length(unit_no) BETWEEN 1 AND 40),
  sub_registrar      text CHECK (length(sub_registrar) BETWEEN 2 AND 120),
  deed_no            text CHECK (length(deed_no) BETWEEN 1 AND 40),
  deed_volume        text CHECK (length(deed_volume) BETWEEN 1 AND 20),
  deed_page          text CHECK (length(deed_page) BETWEEN 1 AND 20),
  deed_date          date CHECK (deed_date > DATE '1850-01-01'),
  land_record_ref    text CHECK (length(land_record_ref) BETWEEN 1 AND 80),
  authority_file_no  text CHECK (length(authority_file_no) BETWEEN 1 AND 80),
  excise_no          text CHECK (length(excise_no) BETWEEN 1 AND 80),
  -- A building address (no names): used for the "address similarity" signal only.
  address            text CHECK (length(address) BETWEEN 5 AND 300),
  land_area          numeric(14, 4) CHECK (land_area > 0),
  land_area_unit     text CHECK (land_area_unit IN ('sq_ft', 'sq_m', 'marla', 'kanal', 'acre')),
  covered_area_sqft  numeric(14, 2) CHECK (covered_area_sqft > 0),
  -- GPS of the main entrance; inside Pakistan's bounding box.
  gps_lat            numeric(9, 6) CHECK (gps_lat BETWEEN 23 AND 37.5),
  gps_lon            numeric(9, 6) CHECK (gps_lon BETWEEN 60 AND 78),
  use                text CHECK (use IN ('commercial', 'residential', 'mixed')),
  built              boolean,
  occupancy          text CHECK (occupancy IN ('vacant', 'owner_occupied', 'tenanted', 'partly_tenanted')),
  lease_count        integer CHECK (lease_count BETWEEN 0 AND 100000),
  monthly_rent_paisa bigint CHECK (monthly_rent_paisa >= 0),
  declared_charges   boolean,
  property_key       text GENERATED ALWAYS AS (property.make_key(province, district, mauza, society, khewat, khasra, plot_no, building, floor, unit_no)) STORED,
  deed_key           text GENERATED ALWAYS AS (CASE WHEN property.norm(sub_registrar) <> '' AND property.norm(deed_no) <> ''
                                                    THEN property.norm(sub_registrar) || '|' || property.norm(deed_no) END) STORED,
  created_by         text NOT NULL CHECK (length(created_by) BETWEEN 2 AND 100),
  created_at         timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  CHECK ((land_area IS NULL) = (land_area_unit IS NULL)),
  CHECK ((gps_lat IS NULL) = (gps_lon IS NULL)),
  CHECK (occupancy NOT IN ('tenanted', 'partly_tenanted') OR lease_count IS NULL OR lease_count > 0)
);
CREATE INDEX properties_key_idx ON property.properties (property_key);
CREATE INDEX properties_deed_idx ON property.properties (deed_key);
CREATE INDEX properties_sponsor_idx ON property.properties (sponsor_id);

-- Columns a sponsor may change, only while the file is a Draft.
CREATE FUNCTION property.identifier_columns() RETURNS text[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['province', 'district', 'tehsil', 'mauza', 'society', 'khewat', 'khatooni', 'khasra', 'plot_no', 'building', 'floor',
               'unit_no', 'sub_registrar', 'deed_no', 'deed_volume', 'deed_page', 'deed_date', 'land_record_ref', 'authority_file_no',
               'excise_no', 'address', 'land_area', 'land_area_unit', 'covered_area_sqft', 'gps_lat', 'gps_lon', 'use', 'built',
               'occupancy', 'lease_count', 'monthly_rent_paisa', 'declared_charges']
$$;

CREATE TABLE property.property_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id uuid NOT NULL REFERENCES property.properties (id),
  code        text NOT NULL,
  from_state  text NOT NULL,
  to_state    text NOT NULL,
  actor       text NOT NULL CHECK (length(actor) BETWEEN 2 AND 100),
  acting_for  bigint REFERENCES property.sponsor_persons (id),
  reason      text CHECK (length(reason) BETWEEN 10 AND 500),
  checker     text CHECK (length(checker) BETWEEN 2 AND 100),
  request_id  bigint,
  -- OB-16: whether a rejection may be cured by a new linked file.
  curable     boolean,
  at          timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  CHECK ((to_state = 'rejected') = (curable IS NOT NULL)),
  CHECK (checker IS DISTINCT FROM actor)
);
CREATE INDEX property_events_idx ON property.property_events (property_id, id DESC);

/** PR-2: an event must be an allowed transition from the entity's current state; it then moves the state. */
CREATE FUNCTION property.apply_event() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_current text;
BEGIN
  IF TG_TABLE_NAME = 'sponsor_events' THEN
    SELECT state INTO v_current FROM property.sponsors WHERE id = NEW.sponsor_id FOR UPDATE;
  ELSE
    SELECT state INTO v_current FROM property.properties WHERE id = NEW.property_id FOR UPDATE;
  END IF;
  IF v_current IS DISTINCT FROM NEW.from_state OR NOT EXISTS (
       SELECT 1 FROM property.transitions t
       WHERE t.entity = CASE WHEN TG_TABLE_NAME = 'sponsor_events' THEN 'sponsor' ELSE 'property' END
         AND t.code = NEW.code AND t.from_state = NEW.from_state AND t.to_state = NEW.to_state) THEN
    RAISE EXCEPTION 'transition % from % to % is not allowed (current state %)', NEW.code, NEW.from_state, NEW.to_state, v_current
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sponsor_events_apply BEFORE INSERT ON property.sponsor_events FOR EACH ROW EXECUTE FUNCTION property.apply_event();
CREATE TRIGGER property_events_apply BEFORE INSERT ON property.property_events FOR EACH ROW EXECUTE FUNCTION property.apply_event();

/** The state column follows the event log only; identifiers change only in a Draft. */
CREATE FUNCTION property.guard_entity() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_last text;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION '% rows are never deleted', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege'; END IF;
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    IF TG_TABLE_NAME = 'sponsors' THEN
      SELECT to_state INTO v_last FROM property.sponsor_events WHERE sponsor_id = NEW.id ORDER BY id DESC LIMIT 1;
    ELSE
      SELECT to_state INTO v_last FROM property.property_events WHERE property_id = NEW.id ORDER BY id DESC LIMIT 1;
    END IF;
    IF v_last IS DISTINCT FROM NEW.state THEN
      RAISE EXCEPTION 'the state of % % changes only through its event log', TG_TABLE_NAME, NEW.id USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_TABLE_NAME = 'sponsors' THEN
    IF (to_jsonb(NEW) - 'state') IS DISTINCT FROM (to_jsonb(OLD) - 'state') THEN
      RAISE EXCEPTION 'sponsor records are append-only (only the state moves)' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF (to_jsonb(NEW) - 'state' - property.identifier_columns() - 'property_key' - 'deed_key')
       IS DISTINCT FROM (to_jsonb(OLD) - 'state' - property.identifier_columns() - 'property_key' - 'deed_key') THEN
      RAISE EXCEPTION 'id, sponsor, link and creation of a property never change' USING ERRCODE = 'check_violation';
    END IF;
    -- Generated columns are not yet computed in a BEFORE trigger: compare the base columns only.
    IF (to_jsonb(NEW) - 'state' - 'property_key' - 'deed_key') IS DISTINCT FROM (to_jsonb(OLD) - 'state' - 'property_key' - 'deed_key')
       AND OLD.state <> 'draft' THEN
      RAISE EXCEPTION 'identifiers change only while the property is a draft' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sponsors_guard BEFORE UPDATE OR DELETE ON property.sponsors FOR EACH ROW EXECUTE FUNCTION property.guard_entity();
CREATE TRIGGER properties_guard BEFORE UPDATE OR DELETE ON property.properties FOR EACH ROW EXECUTE FUNCTION property.guard_entity();

-- ================================================================== documents (OB-12, OB-21)
CREATE TABLE property.documents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sponsor_id  uuid NOT NULL REFERENCES property.sponsors (id),
  property_id uuid REFERENCES property.properties (id),
  doc_type    text NOT NULL REFERENCES property.doc_types (code),
  sha256      bytea NOT NULL CHECK (length(sha256) = 32),
  size_bytes  bigint NOT NULL CHECK (size_bytes BETWEEN 1 AND 1073741824),
  media_type  text NOT NULL CHECK (media_type IN ('application/pdf', 'image/jpeg', 'image/png', 'image/tiff')),
  -- Opaque reference into the encrypted document store; no personal data, no spaces.
  store_ref   text NOT NULL UNIQUE CHECK (store_ref ~ '^[a-z][a-z0-9+.-]{1,19}://[A-Za-z0-9._~/-]{1,200}$'),
  supersedes  uuid UNIQUE REFERENCES property.documents (id),
  uploaded_by text NOT NULL CHECK (length(uploaded_by) BETWEEN 2 AND 100),
  acting_for  bigint REFERENCES property.sponsor_persons (id),
  uploaded_at timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  CHECK (supersedes IS DISTINCT FROM id)
);
-- The same bytes are recorded once per file (re-uploading changes nothing).
CREATE UNIQUE INDEX documents_once ON property.documents (sponsor_id, coalesce(property_id, '00000000-0000-0000-0000-000000000000'::uuid), sha256);
CREATE INDEX documents_sha_idx ON property.documents (sha256);
CREATE INDEX documents_property_idx ON property.documents (property_id);

CREATE TABLE property.document_verifications (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id     uuid NOT NULL REFERENCES property.documents (id),
  method          text NOT NULL CHECK (method IN ('in_person', 'online_portal', 'official_letter', 'provider')),
  source_office   text NOT NULL CHECK (length(source_office) BETWEEN 2 AND 120),
  verified_on     date NOT NULL,
  outcome         text NOT NULL CHECK (outcome IN ('verified', 'failed')),
  evidence_sha256 bytea NOT NULL CHECK (length(evidence_sha256) = 32),
  recorded_by     text NOT NULL,
  at              timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp())
);

/** A document is current while nothing supersedes it. */
CREATE FUNCTION property.is_current(p_document uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, property AS $$
  SELECT NOT EXISTS (SELECT 1 FROM property.documents WHERE supersedes = p_document)
$$;

-- ================================================================== duplicate checks (OB-14..OB-17)
CREATE TABLE property.duplicate_checks (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id uuid NOT NULL REFERENCES property.properties (id),
  run_by      text NOT NULL,
  outcome     text NOT NULL CHECK (outcome IN ('clear', 'possible', 'blocked')),
  fraud       boolean NOT NULL,
  at          timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp())
);

CREATE TABLE property.duplicate_candidates (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  check_id     bigint NOT NULL REFERENCES property.duplicate_checks (id),
  candidate_id uuid NOT NULL REFERENCES property.properties (id),
  kind         text NOT NULL CHECK (kind IN ('exact', 'possible', 'linked')),
  reasons      text[] NOT NULL CHECK (cardinality(reasons) >= 1),
  fraud        boolean NOT NULL,
  UNIQUE (check_id, candidate_id)
);

CREATE TABLE property.duplicate_decisions (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  candidate_id bigint NOT NULL REFERENCES property.duplicate_candidates (id),
  officer      text NOT NULL,
  capacity     text NOT NULL CHECK (capacity IN ('onboarding', 'compliance')),
  decision     text NOT NULL CHECK (decision IN ('clear', 'confirm')),
  reason       text NOT NULL CHECK (length(reason) BETWEEN 10 AND 500),
  at           timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  UNIQUE (candidate_id, officer)
);

-- ================================================================== maker-checker requests (PR-4)
CREATE TABLE property.requests (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity          text NOT NULL CHECK (entity IN ('sponsor', 'property')),
  entity_id       uuid NOT NULL,
  code            text NOT NULL CHECK (code IN ('K4', 'K5', 'K10', 'K11', 'SC', 'P6', 'P13', 'P14')),
  from_state      text NOT NULL,
  requested_by    text NOT NULL CHECK (length(requested_by) BETWEEN 2 AND 100),
  reason          text NOT NULL CHECK (length(reason) BETWEEN 10 AND 500),
  detail          jsonb NOT NULL CHECK (jsonb_typeof(detail) = 'object' AND octet_length(detail::text) <= 2048),
  requested_at    timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  expires_at      timestamptz NOT NULL,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'approved', 'rejected', 'expired')),
  decided_by      text CHECK (length(decided_by) BETWEEN 2 AND 100),
  decision_reason text CHECK (length(decision_reason) BETWEEN 10 AND 500),
  decided_at      timestamptz,
  CHECK (decided_by IS DISTINCT FROM requested_by),
  CHECK ((status = 'open') = (decided_at IS NULL)),
  CHECK ((status IN ('approved', 'rejected')) = (decided_by IS NOT NULL AND decision_reason IS NOT NULL)),
  CHECK ((entity = 'sponsor') = (code IN ('K4', 'K5', 'K10', 'K11', 'SC')))
);
CREATE UNIQUE INDEX requests_one_open ON property.requests (entity_id) WHERE status = 'open';

CREATE FUNCTION property.guard_request() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'requests are never deleted' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF OLD.status <> 'open' OR (NEW.id, NEW.entity, NEW.entity_id, NEW.code, NEW.from_state, NEW.requested_by, NEW.reason, NEW.detail, NEW.requested_at, NEW.expires_at)
     IS DISTINCT FROM (OLD.id, OLD.entity, OLD.entity_id, OLD.code, OLD.from_state, OLD.requested_by, OLD.reason, OLD.detail, OLD.requested_at, OLD.expires_at) THEN
    RAISE EXCEPTION 'request % can only be decided once', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER requests_guard BEFORE UPDATE OR DELETE ON property.requests FOR EACH ROW EXECUTE FUNCTION property.guard_request();

-- ================================================================== reviews (OB-20..OB-31)
CREATE FUNCTION property.discipline_group(p_discipline text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_discipline WHEN 'title' THEN 'legal' WHEN 'encumbrance' THEN 'legal' WHEN 'legal_opinion' THEN 'legal'
                           WHEN 'valuation' THEN 'valuation' WHEN 'technical' THEN 'technical' END
$$;

-- P4 / OB-SOD-3: the legal, valuation and technical reviewer of a file (the latest row per group counts).
CREATE TABLE property.assignments (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id uuid NOT NULL REFERENCES property.properties (id),
  grp         text NOT NULL CHECK (grp IN ('legal', 'valuation', 'technical')),
  reviewer    text NOT NULL,
  assigned_by text NOT NULL,
  at          timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  CHECK (reviewer <> assigned_by)
);
CREATE INDEX assignments_idx ON property.assignments (property_id, grp, id DESC);

CREATE TABLE property.reviews (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  seq         bigint NOT NULL DEFAULT nextval('property.seq'),
  property_id uuid NOT NULL REFERENCES property.properties (id),
  discipline  text NOT NULL CHECK (discipline IN ('title', 'encumbrance', 'valuation', 'legal_opinion', 'technical')),
  reviewer    text NOT NULL,
  scope       text NOT NULL CHECK (length(scope) BETWEEN 10 AND 500),
  method      text NOT NULL CHECK (length(method) BETWEEN 10 AND 500),
  findings    text NOT NULL CHECK (length(findings) BETWEEN 10 AND 2000),
  -- Conditions; for the legal opinion these are its qualifications (OB-28), accepted by the IC at P7.
  conditions  jsonb NOT NULL CHECK (jsonb_typeof(conditions) = 'array' AND jsonb_array_length(conditions) <= 50 AND octet_length(conditions::text) <= 4096),
  decision    text NOT NULL CHECK (decision IN ('pass', 'pass_with_conditions', 'fail')),
  at          timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  CHECK ((decision = 'pass_with_conditions') = (jsonb_array_length(conditions) > 0))
);
CREATE INDEX reviews_idx ON property.reviews (property_id, discipline, seq DESC);

-- OB-31: the exact hashes a review relied on.
CREATE TABLE property.review_documents (
  review_id   bigint NOT NULL REFERENCES property.reviews (id),
  document_id uuid NOT NULL REFERENCES property.documents (id),
  sha256      bytea NOT NULL CHECK (length(sha256) = 32),
  PRIMARY KEY (review_id, document_id)
);
CREATE INDEX review_documents_doc_idx ON property.review_documents (document_id);

-- PR-7 / OB-39: a reopening makes every earlier review of that discipline stale.
CREATE TABLE property.reopenings (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  seq         bigint NOT NULL DEFAULT nextval('property.seq'),
  property_id uuid NOT NULL REFERENCES property.properties (id),
  discipline  text NOT NULL CHECK (discipline IN ('title', 'encumbrance', 'valuation', 'legal_opinion', 'technical')),
  reason      text NOT NULL CHECK (length(reason) BETWEEN 10 AND 500),
  actor       text NOT NULL,
  at          timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp())
);

-- OB-20: chain of title, earliest link first (the latest row per position counts).
CREATE TABLE property.title_links (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id    uuid NOT NULL REFERENCES property.properties (id),
  position       smallint NOT NULL CHECK (position BETWEEN 1 AND 200),
  kind           text NOT NULL CHECK (kind IN ('grant', 'allotment', 'sale_deed', 'gift_deed', 'mutation', 'inheritance', 'lease', 'transfer_letter', 'decree')),
  instrument_ref text NOT NULL CHECK (length(instrument_ref) BETWEEN 1 AND 80),
  registered_on  date NOT NULL CHECK (registered_on > DATE '1850-01-01'),
  document_id    uuid NOT NULL REFERENCES property.documents (id),
  recorded_by    text NOT NULL,
  at             timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp())
);

-- OB-22: encumbrances; each is discharged or becomes a condition precedent for S-02 (OF-41).
CREATE TABLE property.encumbrances (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id     uuid NOT NULL REFERENCES property.properties (id),
  kind            text NOT NULL CHECK (kind IN ('mortgage', 'charge', 'lien', 'attachment', 'stay_order', 'litigation', 'acquisition_notice', 'unpaid_tax', 'other')),
  description     text NOT NULL CHECK (length(description) BETWEEN 10 AND 500),
  evidence_sha256 bytea NOT NULL CHECK (length(evidence_sha256) = 32),
  found_by        text NOT NULL,
  at              timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp())
);

CREATE TABLE property.encumbrance_resolutions (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  encumbrance_id  bigint NOT NULL UNIQUE REFERENCES property.encumbrances (id),
  resolution      text NOT NULL CHECK (resolution IN ('discharged', 'condition_precedent')),
  note            text NOT NULL CHECK (length(note) BETWEEN 10 AND 500),
  evidence_sha256 bytea NOT NULL CHECK (length(evidence_sha256) = 32),
  resolved_by     text NOT NULL,
  at              timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp())
);

-- OB-25 / threat T-3: the approved valuer panel (maker-checker); a natural-person valuer is a KYC subject.
CREATE TABLE property.valuers (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  licence_no  text NOT NULL UNIQUE CHECK (licence_no ~ '^[A-Z0-9/]{2,40}$'),
  panel       text NOT NULL CHECK (panel ~ '^[a-z][a-z0-9_]{1,30}$'),
  subject_id  uuid UNIQUE REFERENCES kyc.subjects (id),
  added_by    text NOT NULL,
  approved_by text,
  at          timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  CHECK (approved_by IS DISTINCT FROM added_by)
);

CREATE FUNCTION property.guard_valuer() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'valuers are never deleted' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF OLD.approved_by IS NOT NULL OR (to_jsonb(NEW) - 'approved_by') IS DISTINCT FROM (to_jsonb(OLD) - 'approved_by') THEN
    RAISE EXCEPTION 'a valuer is approved once and never changed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER valuers_guard BEFORE UPDATE OR DELETE ON property.valuers FOR EACH ROW EXECUTE FUNCTION property.guard_valuer();

CREATE TABLE property.valuations (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id        uuid NOT NULL REFERENCES property.properties (id),
  valuer_id          bigint NOT NULL REFERENCES property.valuers (id),
  basis              text NOT NULL CHECK (basis IN ('market_value')),
  value_paisa        bigint NOT NULL CHECK (value_paisa > 0),
  valued_on          date NOT NULL,
  report_document_id uuid NOT NULL REFERENCES property.documents (id),
  independence_sha256 bytea NOT NULL CHECK (length(independence_sha256) = 32),
  recorded_by        text NOT NULL,
  at                 timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp())
);

-- ================================================================== committee, structure, trustee (OB-33..OB-37)
CREATE TABLE property.ic_meetings (
  id                      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id             uuid NOT NULL REFERENCES property.properties (id),
  chair                   text NOT NULL,
  opened_at               timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  status                  text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'approved', 'not_approved')),
  minutes_sha256          bytea CHECK (length(minutes_sha256) = 32),
  accepted_qualifications jsonb,
  closed_at               timestamptz,
  CHECK ((status = 'open') = (closed_at IS NULL) AND (status = 'open') = (minutes_sha256 IS NULL))
);
CREATE UNIQUE INDEX ic_meetings_one_open ON property.ic_meetings (property_id) WHERE status = 'open';

CREATE FUNCTION property.guard_meeting() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'meetings are never deleted' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF OLD.status <> 'open' OR (NEW.id, NEW.property_id, NEW.chair, NEW.opened_at) IS DISTINCT FROM (OLD.id, OLD.property_id, OLD.chair, OLD.opened_at) THEN
    RAISE EXCEPTION 'meeting % is closed once', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ic_meetings_guard BEFORE UPDATE OR DELETE ON property.ic_meetings FOR EACH ROW EXECUTE FUNCTION property.guard_meeting();

CREATE TABLE property.ic_votes (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  meeting_id    bigint NOT NULL REFERENCES property.ic_meetings (id),
  member        text NOT NULL,
  independent   boolean NOT NULL,
  -- OB-SOD-4: a conflicted member records the conflict and does not vote.
  conflict      boolean NOT NULL,
  conflict_note text CHECK (length(conflict_note) BETWEEN 10 AND 500),
  vote          text CHECK (vote IN ('approve', 'reject', 'abstain')),
  at            timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  UNIQUE (meeting_id, member),
  CHECK (conflict = (vote IS NULL)),
  CHECK (conflict = (conflict_note IS NOT NULL))
);

CREATE TABLE property.structures (
  id                     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id            uuid NOT NULL REFERENCES property.properties (id),
  kind                   text NOT NULL CHECK (kind IN ('reit', 'spv')),
  shariah                boolean NOT NULL,
  -- OB-35: rights attached to one unit; S-02 and S-05 read them from here.
  unit_rights            jsonb NOT NULL CHECK (jsonb_typeof(unit_rights) = 'object' AND unit_rights ?& ARRAY['income', 'exit', 'voting', 'information']
                                               AND octet_length(unit_rights::text) <= 2048),
  -- OB-36: planned register size, and the MaxBalanceModule limit derived from it.
  planned_units          numeric(78, 0) NOT NULL CHECK (planned_units > 0 AND planned_units < 1e30),
  max_balance_bp         integer NOT NULL CHECK (max_balance_bp BETWEEN 1 AND 10000),
  max_holding_units      numeric(78, 0) NOT NULL,
  trust_deed_document_id uuid NOT NULL REFERENCES property.documents (id),
  decided_by             text NOT NULL,
  at                     timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  CHECK (max_holding_units = floor(planned_units * max_balance_bp / 10000))
);

CREATE TABLE property.trustee_decisions (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id  uuid NOT NULL REFERENCES property.properties (id),
  structure_id bigint NOT NULL REFERENCES property.structures (id),
  trustee      text NOT NULL,
  decision     text NOT NULL CHECK (decision IN ('accept', 'decline')),
  conditions   text CHECK (length(conditions) BETWEEN 10 AND 1000),
  reason       text NOT NULL CHECK (length(reason) BETWEEN 10 AND 500),
  at           timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp())
);

-- ================================================================== append-only (PR-8)
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['audit', 'sponsor_identifiers', 'registration_checks', 'sponsor_screenings', 'risk_ratings', 'fmu_assessments',
                           'sponsor_events', 'property_events', 'documents', 'document_verifications', 'duplicate_checks',
                           'duplicate_candidates', 'duplicate_decisions', 'assignments', 'reviews', 'review_documents', 'reopenings',
                           'title_links', 'encumbrances', 'encumbrance_resolutions', 'valuations', 'ic_votes', 'structures',
                           'trustee_decisions', 'transitions', 'doc_types', 'mandatory_documents'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON property.%I FOR EACH ROW EXECUTE FUNCTION property.forbid_change()', t || '_append_only', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['audit', 'staff_duties', 'sponsors', 'sponsor_identifiers', 'sponsor_persons', 'registration_checks', 'sponsor_screenings',
                           'risk_ratings', 'fmu_assessments', 'sponsor_events', 'properties', 'property_events', 'documents',
                           'document_verifications', 'duplicate_checks', 'duplicate_candidates', 'duplicate_decisions', 'requests',
                           'assignments', 'reviews', 'review_documents', 'reopenings', 'title_links', 'encumbrances',
                           'encumbrance_resolutions', 'valuers', 'valuations', 'ic_meetings', 'ic_votes', 'structures',
                           'trustee_decisions', 'transitions', 'doc_types', 'mandatory_documents', 'settings'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON property.%I FOR EACH STATEMENT EXECUTE FUNCTION property.forbid_change()', t || '_no_truncate', t);
  END LOOP;
END $$;

-- ================================================================== derived state and guards
/** PR-3: the KYB state a gate may rely on. */
CREATE FUNCTION property.sponsor_state(p_sponsor uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, property AS $$
  SELECT CASE
    WHEN s.state = 'kyb_approved' AND (
           coalesce((SELECT e.valid_until FROM property.sponsor_events e WHERE e.sponsor_id = s.id AND e.code = 'K4' ORDER BY e.id DESC LIMIT 1), '-infinity') <= now()
           OR EXISTS (SELECT 1 FROM property.sponsor_persons p WHERE p.sponsor_id = s.id AND p.ended_at IS NULL
                                                             AND kyc.subject_status(p.subject_id) <> 'verified'))
      THEN 'kyb_expired'
    ELSE s.state
  END
  FROM property.sponsors s WHERE s.id = p_sponsor
$$;

CREATE FUNCTION property.kyb_valid_until(p_sponsor uuid) RETURNS timestamptz
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, property AS $$
  SELECT CASE WHEN s.state = 'kyb_approved'
              THEN (SELECT e.valid_until FROM property.sponsor_events e WHERE e.sponsor_id = s.id AND e.code = 'K4' ORDER BY e.id DESC LIMIT 1) END
  FROM property.sponsors s WHERE s.id = p_sponsor
$$;

/** Mandatory documents still missing (current documents only). */
CREATE FUNCTION property.missing_documents(p_sponsor uuid, p_property uuid) RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, property AS $$
  SELECT coalesce(array_agg(m.doc_type ORDER BY m.doc_type), '{}')
  FROM property.mandatory_documents m
  WHERE m.applies_to = CASE WHEN p_property IS NOT NULL THEN 'property' ELSE (SELECT kind FROM property.sponsors WHERE id = p_sponsor) END
    AND (m.condition = 'always'
         OR (m.condition = 'built' AND (SELECT built FROM property.properties WHERE id = p_property))
         OR (m.condition = 'tenanted' AND (SELECT occupancy IN ('tenanted', 'partly_tenanted') FROM property.properties WHERE id = p_property))
         OR (m.condition = 'charged' AND (SELECT declared_charges FROM property.properties WHERE id = p_property)))
    AND NOT EXISTS (SELECT 1 FROM property.documents d
                    WHERE d.sponsor_id = p_sponsor AND d.property_id IS NOT DISTINCT FROM p_property
                      AND d.doc_type = m.doc_type AND property.is_current(d.id))
$$;

CREATE FUNCTION property.kyb_problem(p_sponsor uuid, p_code text) RETURNS text
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, property AS $$
DECLARE
  s property.sponsors;
  v_missing text[];
  v_bad bigint;
BEGIN
  SELECT * INTO s FROM property.sponsors WHERE id = p_sponsor;
  IF s.kind = 'company' THEN
    IF NOT EXISTS (SELECT 1 FROM property.sponsor_persons WHERE sponsor_id = s.id AND ended_at IS NULL AND role = 'representative') THEN
      RETURN 'no authorised representative recorded';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM property.sponsor_persons WHERE sponsor_id = s.id AND ended_at IS NULL AND role = 'director') THEN
      RETURN 'no director recorded';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM property.sponsor_persons WHERE sponsor_id = s.id AND ended_at IS NULL AND role = 'beneficial_owner') THEN
      RETURN 'no beneficial owner recorded (OB-4)';
    END IF;
    IF (SELECT coalesce(sum(ownership_bp), 0) FROM property.sponsor_persons WHERE sponsor_id = s.id AND ended_at IS NULL AND role = 'beneficial_owner') > 10000 THEN
      RETURN 'beneficial ownership adds up to more than 100 %';
    END IF;
  END IF;
  v_missing := property.missing_documents(s.id, NULL);
  IF cardinality(v_missing) > 0 THEN RETURN 'missing KYB documents: ' || array_to_string(v_missing, ', '); END IF;
  IF p_code IN ('K4') THEN
    IF s.kind = 'company' AND coalesce((SELECT outcome FROM property.registration_checks WHERE sponsor_id = s.id ORDER BY id DESC LIMIT 1), '') <> 'verified' THEN
      RETURN 'SECP registration not verified (OB-2)';
    END IF;
    IF s.kind = 'company' AND coalesce((SELECT outcome FROM property.sponsor_screenings WHERE sponsor_id = s.id ORDER BY id DESC LIMIT 1), '') <> 'clear' THEN
      RETURN 'the company screening is not clear (OB-5)';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM property.risk_ratings WHERE sponsor_id = s.id) THEN RETURN 'no risk rating (OB-6)'; END IF;
    SELECT count(*) INTO v_bad FROM property.sponsor_persons p
    WHERE p.sponsor_id = s.id AND p.ended_at IS NULL AND kyc.subject_status(p.subject_id) <> 'verified';
    IF v_bad > 0 THEN RETURN format('%s director(s), representative(s) or beneficial owner(s) not KYC-verified (OB-3)', v_bad); END IF;
  END IF;
  RETURN NULL;
END $$;

CREATE FUNCTION property.assignee(p_property uuid, p_group text) RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog, property AS $$
  SELECT reviewer FROM property.assignments WHERE property_id = p_property AND grp = p_group ORDER BY id DESC LIMIT 1
$$;

/** OB-SOD-1: everyone who entered or submitted the file, or assigned or reviewed it. */
CREATE FUNCTION property.parties(p_property uuid) RETURNS text[]
LANGUAGE sql STABLE SET search_path = pg_catalog, property AS $$
  SELECT array_agg(DISTINCT a) FROM (
    SELECT created_by AS a FROM property.properties WHERE id = p_property
    UNION ALL SELECT actor FROM property.property_events WHERE property_id = p_property AND code IN ('P1', 'P4')
    UNION ALL SELECT reviewer FROM property.assignments WHERE property_id = p_property
  ) x
$$;

CREATE FUNCTION property.submitters(p_property uuid) RETURNS text[]
LANGUAGE sql STABLE SET search_path = pg_catalog, property AS $$
  SELECT array_agg(DISTINCT a) FROM (
    SELECT created_by AS a FROM property.properties WHERE id = p_property
    UNION ALL SELECT actor FROM property.property_events WHERE property_id = p_property AND code = 'P1'
  ) x
$$;

/** The latest review of every discipline, whether it still counts (PR-7) and its decision. */
CREATE FUNCTION property.review_status(p_property uuid)
RETURNS TABLE (discipline text, review_id bigint, reviewer text, decision text, fresh boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, property AS $$
  SELECT d.discipline, r.id, r.reviewer, r.decision,
         r.id IS NOT NULL
         AND r.reviewer = property.assignee(p_property, property.discipline_group(d.discipline))
         AND NOT EXISTS (SELECT 1 FROM property.reopenings o WHERE o.property_id = p_property AND o.discipline = d.discipline AND o.seq > r.seq)
         AND NOT EXISTS (SELECT 1 FROM property.review_documents rd WHERE rd.review_id = r.id AND NOT property.is_current(rd.document_id))
  FROM unnest(ARRAY['title', 'encumbrance', 'valuation', 'legal_opinion', 'technical']) AS d (discipline)
  LEFT JOIN LATERAL (SELECT x.* FROM property.reviews x WHERE x.property_id = p_property AND x.discipline = d.discipline ORDER BY x.seq DESC LIMIT 1) r ON true
$$;

/** OB-20/OB-21: the chain of title and the verification of its documents at source. */
CREATE FUNCTION property.title_problem(p_property uuid) RETURNS text
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, property AS $$
DECLARE
  l record;
  v_prev date;
  v_first boolean := true;
BEGIN
  FOR l IN SELECT DISTINCT ON (t.position) t.* FROM property.title_links t WHERE t.property_id = p_property ORDER BY t.position, t.id DESC LOOP
    IF v_first THEN
      IF l.kind NOT IN ('grant', 'allotment') AND l.registered_on > (current_date - make_interval(years => property.setting('title_years')::int)) THEN
        RETURN 'the title chain neither reaches the original grant or allotment nor covers the search period (OB-20)';
      END IF;
      v_first := false;
    ELSIF l.registered_on < v_prev THEN
      RETURN format('title link %s is dated before the link it follows', l.position);
    END IF;
    IF coalesce((SELECT v.outcome FROM property.document_verifications v WHERE v.document_id = l.document_id ORDER BY v.id DESC LIMIT 1), '') <> 'verified' THEN
      RETURN format('the document of title link %s is not verified at its source (OB-21)', l.position);
    END IF;
    v_prev := l.registered_on;
  END LOOP;
  IF v_first THEN RETURN 'no chain of title recorded (OB-20)'; END IF;
  RETURN NULL;
END $$;

/** OB-25/OB-26: the latest valuation per valuer that is still valid and has a current report. */
CREATE FUNCTION property.valuation_status(p_property uuid)
RETURNS TABLE (ok boolean, problem text, valuations integer, lowest_paisa bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, property AS $$
DECLARE
  v_vals bigint[];
  v_dates date[];
  v_lo bigint;
  v_hi bigint;
BEGIN
  SELECT array_agg(x.value_paisa ORDER BY x.id), array_agg(x.valued_on ORDER BY x.id) INTO v_vals, v_dates
  FROM (SELECT DISTINCT ON (v.valuer_id) v.* FROM property.valuations v
        WHERE v.property_id = p_property ORDER BY v.valuer_id, v.id DESC) x
  WHERE property.is_current(x.report_document_id)
    AND x.valued_on >= current_date - property.setting('valuation_validity_days')::int;
  valuations := coalesce(cardinality(v_vals), 0);
  IF valuations > 0 THEN
    SELECT min(u), max(u) INTO v_lo, v_hi FROM unnest(v_vals) u;
  END IF;
  lowest_paisa := v_lo;
  IF valuations < 2 THEN
    ok := false; problem := 'two independent, valid valuations are required (OB-25)';
  ELSIF valuations = 2 AND (v_hi - v_lo) * 10000 > property.setting('valuation_tolerance_bp') * v_lo THEN
    ok := false; problem := 'the two valuations differ by more than the tolerance: a third valuation is required (OB-26)';
  ELSIF valuations = 2 AND abs(v_dates[1] - v_dates[2]) > property.setting('valuation_gap_days') THEN
    ok := false; problem := 'the two valuations are too far apart in time (OB-25)';
  ELSE
    ok := true; problem := NULL;
  END IF;
  RETURN NEXT;
END $$;

/** Everything P7 needs except the committee vote; NULL when nothing is missing. */
CREATE FUNCTION property.p7_problem(p_property uuid) RETURNS text
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, property AS $$
DECLARE
  r record;
  v_problem text;
  v_val record;
BEGIN
  FOR r IN SELECT * FROM property.review_status(p_property) LOOP
    IF r.review_id IS NULL THEN RETURN format('no %s review', r.discipline); END IF;
    IF NOT r.fresh THEN RETURN format('the %s review was reopened or relies on a superseded document', r.discipline); END IF;
    IF r.decision = 'fail' THEN RETURN format('the %s review failed', r.discipline); END IF;
  END LOOP;
  v_problem := property.title_problem(p_property);
  IF v_problem IS NOT NULL THEN RETURN v_problem; END IF;
  IF EXISTS (SELECT 1 FROM property.encumbrances e WHERE e.property_id = p_property
             AND NOT EXISTS (SELECT 1 FROM property.encumbrance_resolutions x WHERE x.encumbrance_id = e.id)) THEN
    RETURN 'an encumbrance is neither discharged nor a condition precedent (OB-22)';
  END IF;
  SELECT * INTO v_val FROM property.valuation_status(p_property);
  IF NOT v_val.ok THEN RETURN v_val.problem; END IF;
  IF property.sponsor_state((SELECT sponsor_id FROM property.properties WHERE id = p_property)) <> 'kyb_approved' THEN
    RETURN 'the sponsor is not KYB-approved';
  END IF;
  IF EXISTS (SELECT 1 FROM property.requests WHERE entity_id = p_property AND status = 'open' AND expires_at > now()) THEN
    RETURN 'a maker-checker request is open on this property';
  END IF;
  RETURN NULL;
END $$;

-- ================================================================== transitions
CREATE FUNCTION property.sponsor_move(p_sponsor uuid, p_code text, p_actor text, p_reason text, p_acting_for bigint,
                                      p_request bigint, p_checker text) RETURNS bigint
LANGUAGE plpgsql SET search_path = pg_catalog, property AS $$
DECLARE
  s property.sponsors;
  v_from text;
  t property.transitions;
  v_id bigint;
  v_valid timestamptz;
BEGIN
  SELECT * INTO s FROM property.sponsors WHERE id = p_sponsor FOR UPDATE;
  IF NOT FOUND THEN PERFORM property.fail('P0002', 'unknown sponsor'); END IF;
  v_from := property.sponsor_state(p_sponsor);
  -- K7 is derived (PR-3); record it before any transition out of the expired state.
  IF s.state = 'kyb_approved' AND v_from = 'kyb_expired' AND p_code <> 'K7' THEN
    PERFORM property.sponsor_move(p_sponsor, 'K7', 'system:kyb-expiry', NULL, NULL, NULL, NULL);
  END IF;
  IF p_code = 'K7' THEN v_from := s.state; END IF;
  SELECT * INTO t FROM property.transitions WHERE entity = 'sponsor' AND code = p_code AND from_state = v_from;
  IF NOT FOUND THEN PERFORM property.fail('23514', format('KYB transition %s is not allowed from %s', p_code, v_from)); END IF;
  IF p_code = 'K4' THEN
    v_valid := date_trunc('microseconds', clock_timestamp()) + make_interval(days => property.setting('kyb_validity_days')::int);
  END IF;
  INSERT INTO property.sponsor_events (sponsor_id, code, from_state, to_state, actor, acting_for, reason, checker, request_id, valid_until)
  VALUES (p_sponsor, p_code, t.from_state, t.to_state, p_actor, p_acting_for, p_reason, p_checker, p_request, v_valid) RETURNING id INTO v_id;
  UPDATE property.sponsors SET state = t.to_state WHERE id = p_sponsor;
  PERFORM property.audit_append(p_actor, t.action, jsonb_build_object(
    'ref', 'sponsor_events:' || v_id, 'sponsor', p_sponsor, 'code', p_code, 'from', t.from_state, 'to', t.to_state,
    'reason', p_reason, 'checker', p_checker, 'request', p_request, 'actingFor', p_acting_for, 'validUntil', property.utc(v_valid)));
  RETURN v_id;
END $$;

CREATE FUNCTION property.property_move(p_property uuid, p_code text, p_actor text, p_reason text, p_acting_for bigint,
                                       p_request bigint, p_checker text, p_curable boolean) RETURNS bigint
LANGUAGE plpgsql SET search_path = pg_catalog, property AS $$
DECLARE
  v_state text;
  t property.transitions;
  v_id bigint;
BEGIN
  SELECT state INTO v_state FROM property.properties WHERE id = p_property FOR UPDATE;
  IF NOT FOUND THEN PERFORM property.fail('P0002', 'unknown property'); END IF;
  SELECT * INTO t FROM property.transitions WHERE entity = 'property' AND code = p_code AND from_state = v_state;
  IF NOT FOUND THEN PERFORM property.fail('23514', format('property transition %s is not allowed from %s', p_code, v_state)); END IF;
  INSERT INTO property.property_events (property_id, code, from_state, to_state, actor, acting_for, reason, checker, request_id, curable)
  VALUES (p_property, p_code, t.from_state, t.to_state, p_actor, p_acting_for, p_reason, p_checker, p_request,
          CASE WHEN t.to_state = 'rejected' THEN coalesce(p_curable, false) END) RETURNING id INTO v_id;
  UPDATE property.properties SET state = t.to_state WHERE id = p_property;
  PERFORM property.audit_append(p_actor, t.action, jsonb_build_object(
    'ref', 'property_events:' || v_id, 'property', p_property, 'code', p_code, 'from', t.from_state, 'to', t.to_state,
    'reason', p_reason, 'checker', p_checker, 'request', p_request, 'actingFor', p_acting_for,
    'curable', CASE WHEN t.to_state = 'rejected' THEN coalesce(p_curable, false) END));
  RETURN v_id;
END $$;

/** OB-8: the representative acting for the sponsor, with the power the action needs. */
CREATE FUNCTION property.check_representative(p_sponsor uuid, p_person bigint, p_power text) RETURNS void
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, property AS $$
DECLARE
  p property.sponsor_persons;
BEGIN
  IF p_person IS NULL THEN PERFORM property.fail('22023', 'the representative acting for the sponsor is required (OB-8)'); END IF;
  SELECT * INTO p FROM property.sponsor_persons WHERE id = p_person;
  IF NOT FOUND OR p.sponsor_id <> p_sponsor OR p.ended_at IS NOT NULL OR p.role NOT IN ('representative', 'owner') THEN
    PERFORM property.fail('42501', 'not a current representative of this sponsor');
  END IF;
  IF NOT (p_power = ANY (p.powers)) THEN
    PERFORM property.fail('42501', format('the representative has no %s power (OB-8)', p_power));
  END IF;
  IF kyc.subject_status(p.subject_id) <> 'verified' AND p_power IN ('submit', 'withdraw') THEN
    PERFORM property.fail('42501', 'the representative is not KYC-verified; another representative must act');
  END IF;
END $$;

/** Opens a reopening of a discipline (PR-7) and, for an approved file, moves it back to Under Review (P9/P10). */
CREATE FUNCTION property.reopen_internal(p_property uuid, p_disciplines text[], p_actor text, p_reason text) RETURNS integer
LANGUAGE plpgsql SET search_path = pg_catalog, property AS $$
DECLARE
  v_state text;
  d text;
  v_id bigint;
BEGIN
  SELECT state INTO v_state FROM property.properties WHERE id = p_property FOR UPDATE;
  FOREACH d IN ARRAY coalesce(p_disciplines, '{}') LOOP
    INSERT INTO property.reopenings (property_id, discipline, reason, actor) VALUES (p_property, d, p_reason, p_actor) RETURNING id INTO v_id;
    PERFORM property.audit_append(p_actor, 'review.reopened', jsonb_build_object('ref', 'reopenings:' || v_id, 'property', p_property,
                                                                                 'discipline', d, 'reason', p_reason));
  END LOOP;
  IF v_state = 'legal_approved' THEN
    PERFORM property.property_move(p_property, 'P9', p_actor, p_reason, NULL, NULL, NULL, NULL);
  ELSIF v_state = 'tokenization_ready' THEN
    PERFORM property.property_move(p_property, 'P10', p_actor, p_reason, NULL, NULL, NULL, NULL);
  END IF;
  RETURN coalesce(cardinality(p_disciplines), 0);
END $$;

-- ================================================================== API: sponsors and KYB
CREATE FUNCTION property.create_sponsor(p_id uuid, p_kind text, p_owner_subject uuid, p_name_enc bytea, p_address_enc bytea,
                                        p_id_hashes bytea[], p_id_kinds text[], p_id_versions smallint[],
                                        p_cuin_last4 text, p_ntn_last4 text, p_actor text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, property AS $$
DECLARE
  i integer;
BEGIN
  -- S-01 Q-1 (adopted): operations enter the sponsor's file for the pilot.
  PERFORM property.need_duty(p_actor, ARRAY['onboarding'], 'create a sponsor');
  IF p_id IS NULL OR p_kind IS NULL OR p_address_enc IS NULL
     OR coalesce(cardinality(p_id_hashes), 0) <> coalesce(cardinality(p_id_kinds), 0)
     OR coalesce(cardinality(p_id_hashes), 0) <> coalesce(cardinality(p_id_versions), 0)
     OR array_position(p_id_hashes, NULL) IS NOT NULL OR array_position(p_id_versions, NULL) IS NOT NULL THEN
    PERFORM property.fail('22023', 'sponsor id, kind, sealed address and identifier hashes with kinds and pepper versions are required');
  END IF;
  IF p_kind = 'company' AND NOT ('cuin' = ANY (coalesce(p_id_kinds, '{}'))) THEN
    PERFORM property.fail('22023', 'a company needs its CUIN (OB-1)');
  END IF;
  IF p_kind = 'individual' AND p_owner_subject IS NULL THEN
    PERFORM property.fail('22023', 'an individual owner is a KYC subject (OB-3)');
  END IF;
  PERFORM pg_advisory_xact_lock(586586141);
  IF EXISTS (SELECT 1 FROM property.sponsor_identifiers WHERE id_hash = ANY (p_id_hashes)) THEN
    PERFORM property.fail('23505', 'a sponsor with this registration number already exists');
  END IF;
  IF p_owner_subject IS NOT NULL AND EXISTS (SELECT 1 FROM property.sponsors WHERE owner_subject = p_owner_subject) THEN
    PERFORM property.fail('23505', 'this person is already a sponsor');
  END IF;
  INSERT INTO property.sponsors (id, kind, owner_subject, legal_name_enc, address_enc, pepper_version, cuin_last4, ntn_last4, created_by)
  VALUES (p_id, p_kind, p_owner_subject, p_name_enc, p_address_enc, coalesce(p_id_versions[1], 1), p_cuin_last4, p_ntn_last4, p_actor);
  FOR i IN 1 .. coalesce(cardinality(p_id_hashes), 0) LOOP
    INSERT INTO property.sponsor_identifiers (id_hash, kind, pepper_version, sponsor_id) VALUES (p_id_hashes[i], p_id_kinds[i], p_id_versions[i], p_id);
  END LOOP;
  PERFORM property.audit_append(p_actor, 'sponsor.created', jsonb_build_object('ref', 'sponsors:' || p_id, 'kind', p_kind, 'cuinLast4', p_cuin_last4));
  IF p_kind = 'individual' THEN
    PERFORM property.add_sponsor_person(p_id, p_owner_subject, 'owner', NULL, NULL, NULL, ARRAY['submit', 'upload', 'respond', 'withdraw'], p_actor);
  END IF;
  RETURN p_id;
END $$;

CREATE FUNCTION property.find_sponsor(p_hashes bytea[]) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, property AS $$
  SELECT sponsor_id FROM property.sponsor_identifiers WHERE id_hash = ANY (p_hashes) ORDER BY pepper_version DESC LIMIT 1
$$;

/** The sealed name and address, for the service to open (writer and reviewer roles only). */
CREATE FUNCTION property.sealed_sponsor(p_sponsor uuid) RETURNS TABLE (kind text, legal_name_enc bytea, address_enc bytea)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, property AS $$
  SELECT kind, legal_name_enc, address_enc FROM property.sponsors WHERE id = p_sponsor
$$;

CREATE FUNCTION property.add_sponsor_person(p_sponsor uuid, p_subject uuid, p_role text, p_ownership_bp integer, p_control text,
                                            p_chain_depth smallint, p_powers text[], p_actor text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, property AS $$
DECLARE
  v_id bigint;
  v_state text;
BEGIN
  PERFORM property.need_duty(p_actor, ARRAY['onboarding'], 'record sponsor persons');
  SELECT state INTO v_state FROM property.sponsors WHERE id = p_sponsor FOR UPDATE;
  IF NOT FOUND THEN PERFORM property.fail('P0002', 'unknown sponsor'); END IF;
  IF v_state <> 'kyb_draft' THEN PERFORM property.fail('23514', 'people are added while the KYB file is a draft'); END IF;
  IF p_subject IS NULL OR NOT EXISTS (SELECT 1 FROM kyc.subjects WHERE id = p_subject) THEN
    PERFORM property.fail('22023', 'every person is a KYC subject (OB-3)');
  END IF;
  IF p_role = 'beneficial_owner' AND coalesce(p_control, '') <> 'other_control' AND coalesce(p_ownership_bp, 0) < property.setting('bo_threshold_bp') THEN
    PERFORM property.fail('22023', 'a beneficial owner holds at least the threshold or controls otherwise (OB-4)');
  END IF;
  BEGIN
    INSERT INTO property.sponsor_persons (sponsor_id, subject_id, role, ownership_bp, control_basis, chain_depth, powers, added_by)
    VALUES (p_sponsor, p_subject, p_role, p_ownership_bp, p_control, p_chain_depth, p_powers, p_actor) RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    PERFORM property.fail('23505', 'this person already has this role');
  WHEN check_violation THEN
    PERFORM property.fail('22023', 'invalid person record (role, ownership, control or powers)');
  END;
  PERFORM property.audit_append(p_actor, 'sponsor.person_added', jsonb_build_object('ref', 'sponsor_persons:' || v_id, 'sponsor', p_sponsor,
                                'subject', p_subject, 'role', p_role, 'ownershipBp', p_ownership_bp, 'powers', to_jsonb(p_powers)));
  RETURN v_id;
END $$;

/** Ending a person is protective and allowed in any state (e.g. a representative whose authority ended). */
CREATE FUNCTION property.end_sponsor_person(p_person bigint, p_actor text, p_reason text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, property AS $$
DECLARE
  p property.sponsor_persons;
BEGIN
  PERFORM property.need_duty(p_actor, ARRAY['onboarding', 'compliance', 'compliance_senior'], 'end a sponsor person');
  PERFORM property.check_reason(p_reason);
  SELECT * INTO p FROM property.sponsor_persons WHERE id = p_person FOR UPDATE;
  IF NOT FOUND THEN PERFORM property.fail('P0002', 'unknown sponsor person'); END IF;
  IF p.ended_at IS NOT NULL THEN RETURN false; END IF;
  IF p.role = 'owner' THEN PERFORM property.fail('23514', 'the individual owner cannot be removed from their own file'); END IF;
  UPDATE property.sponsor_persons SET ended_by = p_actor, end_reason = p_reason, ended_at = date_trunc('microseconds', clock_timestamp()) WHERE id = p_person;
  PERFORM property.audit_append(p_actor, 'sponsor.person_ended', jsonb_build_object('ref', 'sponsor_persons:' || p_person || ':end', 'sponsor', p.sponsor_id, 'reason', p_reason));
  RETURN true;
END $$;

CREATE FUNCTION property.record_registration_check(p_sponsor uuid, p_method text, p_outcome text, p_evidence bytea, p_actor text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, property AS $$
DECLARE
  v_id bigint;
BEGIN
  PERFORM property.need_duty(p_actor, ARRAY['onboarding', 'compliance', 'compliance_senior'], 'record the SECP verification');
  PERFORM property.check_sha(p_evidence, 'evidence');
  IF NOT EXISTS (SELECT 1 FROM property.sponsors WHERE id = p_sponsor AND kind = 'company') THEN
    PERFORM property.fail('P0002', 'unknown company sponsor');
  END IF;
  INSERT INTO property.registration_checks (sponsor_id, method, outcome, evidence_sha256, checked_by)
  VALUES (p_sponsor, p_method, p_outcome, p_evidence, p_actor) RETURNING id INTO v_id;
  PERFORM property.audit_append(p_actor, 'sponsor.registration_checked', jsonb_build_object('ref', 'registration_checks:' || v_id, 'sponsor', p_sponsor,
                                'method', p_method, 'outcome', p_outcome, 'evidence', encode(p_evidence, 'hex')));
  RETURN v_id;
END $$;

/** OB-5. A hit on an approved sponsor suspends it at once (K8, protective). */
CREATE FUNCTION property.record_screening(p_sponsor uuid, p_provider text, p_list_version text, p_outcome text, p_evidence bytea, p_actor text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, property AS $$
DECLARE
  v_id bigint;
BEGIN
  PERFORM property.need_duty(p_actor, ARRAY['compliance', 'compliance_senior'], 'record a screening');
  PERFORM property.check_sha(p_evidence, 'evidence');
  IF NOT EXISTS (SELECT 1 FROM property.sponsors WHERE id = p_sponsor FOR UPDATE) THEN PERFORM property.fail('P0002', 'unknown sponsor'); END IF;
  INSERT INTO property.sponsor_screenings (sponsor_id, provider, list_version, outcome, evidence_sha256, recorded_by)
  VALUES (p_sponsor, p_provider, p_list_version, p_outcome, p_evidence, p_actor) RETURNING id INTO v_id;
  PERFORM property.audit_append(p_actor, 'sponsor.screened', jsonb_build_object('ref', 'sponsor_screenings:' || v_id, 'sponsor', p_sponsor,
                                'listVersion', p_list_version, 'outcome', p_outcome));
  IF p_outcome = 'hit' AND property.sponsor_state(p_sponsor) = 'kyb_approved' THEN
    PERFORM property.suspend_sponsor(p_sponsor, p_actor, 'sanctions or PEP list hit on the company (OB-5)');
  END IF;
  RETURN v_id;
END $$;

CREATE FUNCTION property.record_risk(p_sponsor uuid, p_rating text, p_reasons text, p_edd bytea, p_actor text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, property AS $$
DECLARE
  v_id bigint;
BEGIN
  PERFORM property.need_duty(p_actor, ARRAY['compliance', 'compliance_senior'], 'rate the sponsor risk');
  PERFORM property.check_reason(p_reasons, 'reasons text');
  IF p_rating = 'high' THEN PERFORM property.check_sha(p_edd, 'the enhanced due diligence evidence (OB-6)'); END IF;
  IF NOT EXISTS (SELECT 1 FROM property.sponsors WHERE id = p_sponsor) THEN PERFORM property.fail('P0002', 'unknown sponsor'); END IF;
  INSERT INTO property.risk_ratings (sponsor_id, rating, reasons, edd_sha256, rated_by) VALUES (p_sponsor, p_rating, p_reasons, p_edd, p_actor) RETURNING id INTO v_id;
  PERFORM property.audit_append(p_actor, 'sponsor.risk_rated', jsonb_build_object('ref', 'risk_ratings:' || v_id, 'sponsor', p_sponsor, 'rating', p_rating));
  RETURN v_id;
END $$;

CREATE FUNCTION property.record_fmu(p_sponsor uuid, p_outcome text, p_evidence bytea, p_actor text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, property AS $$
DECLARE
  v_id bigint;
BEGIN
  PERFORM property.need_duty(p_actor, ARRAY['compliance', 'compliance_senior'], 'record an FMU assessment');
  PERFORM property.check_sha(p_evidence, 'evidence');
  IF NOT EXISTS (SELECT 1 FROM property.sponsors WHERE id = p_sponsor) THEN PERFORM property.fail('P0002', 'unknown sponsor'); END IF;
  INSERT INTO property.fmu_assessments (sponsor_id, outcome, evidence_sha256, assessed_by) VALUES (p_sponsor, p_outcome, p_evidence, p_actor) RETURNING id INTO v_id;
  -- The outcome is not written to the audit detail: the audit log is readable more widely (tipping-off, OB-9).
  PERFORM property.audit_append(p_actor, 'sponsor.fmu_assessed', jsonb_build_object('ref', 'fmu_assessments:' || v_id, 'sponsor', p_sponsor));
  RETURN v_id;
END $$;

/** K1 (from a draft) or K9 (refresh of an expired KYB). */
CREATE FUNCTION property.submit_kyb(p_sponsor uuid, p_actor text, p_acting_for bigint) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, property AS $$
DECLARE
  v_state text;
  v_problem text;
BEGIN
  PERFORM property.need_duty(p_actor, ARRAY['onboarding'], 'submit a KYB file on the sponsor''s behalf');
  PERFORM 1 FROM property.sponsors WHERE id = p_sponsor FOR UPDATE;
  v_state := property.sponsor_state(p_sponsor);
  IF v_state IS NULL THEN PERFORM property.fail('P0002', 'unknown sponsor'); END IF;
  PERFORM property.check_representative(p_sponsor, p_acting_for, 'submit');
  v_problem := property.kyb_problem(p_sponsor, 'K1');
  IF v_problem IS NOT NULL THEN PERFORM property.fail('23514', v_problem); END IF;
  PERFORM property.sponsor_move(p_sponsor, CASE WHEN v_state = 'kyb_expired' THEN 'K9' ELSE 'K1' END, p_actor, NULL, p_acting_for, NULL, NULL);
  RETURN property.sponsor_state(p_sponsor);
END $$;

/** K2 (accept for review) or K3 (return as incomplete, with a reason). */
CREATE FUNCTION property.screen_kyb(p_sponsor uuid, p_actor text, p_accept boolean, p_reason text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, property AS $$
BEGIN
  PERFORM property.need_duty(p_actor, ARRAY['onboarding'], 'check a KYB file for completeness');
  IF EXISTS (SELECT 1 FROM property.sponsor_events WHERE sponsor_id = p_sponsor AND code IN ('K1', 'K9') AND actor = p_actor) THEN
    PERFORM property.fail('42501', 'whoever submitted a file never decides it (OB-SOD-1)');
  END IF;
  IF p_accept THEN
    PERFORM property.sponsor_move(p_sponsor, 'K2', p_actor, NULL, NULL, NULL, NULL);
  ELSE
    PERFORM property.check_reason(p_reason);
    PERFORM property.sponsor_move(p_sponsor, 'K3', p_actor, p_reason, NULL, NULL, NULL);
  END IF;
  RETURN property.sponsor_state(p_sponsor);
END $$;

CREATE FUNCTION property.query_kyb(p_sponsor uuid, p_actor text, p_query text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, property AS $$
BEGIN
  PERFORM property.need_duty(p_actor, ARRAY['compliance', 'compliance_senior'], 'raise a KYB query');
  PERFORM property.check_reason(p_query, 'query text');
  PERFORM property.sponsor_move(p_sponsor, 'K6', p_actor, p_query, NULL, NULL, NULL);
  RETURN property.sponsor_state(p_sponsor);
END $$;

/** K8 (protective, one officer). The sponsor's files under review or approved go On Hold (P12). */
CREATE FUNCTION property.suspend_sponsor(p_sponsor uuid, p_actor text, p_reason text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, property AS $$
DECLARE
  p record;
  n integer := 0;
BEGIN
  PERFORM property.need_duty(p_actor, ARRAY['compliance', 'compliance_senior'], 'suspend a sponsor');
  PERFORM property.check_reason(p_reason);
  PERFORM property.sponsor_move(p_sponsor, 'K8', p_actor, p_reason, NULL, NULL, NULL);
  FOR p IN SELECT id FROM property.properties WHERE sponsor_id = p_sponsor AND state IN ('under_review', 'legal_approved', 'tokenization_ready') ORDER BY id LOOP
    PERFORM property.property_move(p.id, 'P12', p_actor, 'sponsor suspended: ' || left(p_reason, 470), NULL, NULL, NULL, NULL);
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;

/** K7 for every approved sponsor whose KYB lapsed (scheduled; the state already reads as expired). */
CREATE FUNCTION property.expire_sponsors(p_actor text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, property AS $$
DECLARE
  s record;
  n integer := 0;
BEGIN
  PERFORM property.check_actor(p_actor);
  FOR s IN SELECT id FROM property.sponsors WHERE state = 'kyb_approved' ORDER BY id LOOP
    IF property.sponsor_state(s.id) = 'kyb_expired' THEN
      PERFORM property.sponsor_move(s.id, 'K7', p_actor, NULL, NULL, NULL, NULL);
      n := n + 1;
    END IF;
  END LOOP;
  RETURN n;
END $$;

-- ================================================================== API: properties
CREATE FUNCTION property.set_identifiers(p_property uuid, p_ids jsonb) RETURNS text[]
LANGUAGE plpgsql SET search_path = pg_catalog, property AS $$
DECLARE
  v_bad text[];
  r property.properties;
  v_changed text[];
BEGIN
  IF p_ids IS NULL OR jsonb_typeof(p_ids) <> 'object' THEN PERFORM property.fail('22023', 'identifiers must be a JSON object'); END IF;
  SELECT array_agg(k ORDER BY k) INTO v_bad FROM jsonb_object_keys(p_ids) k WHERE NOT (k = ANY (property.identifier_columns()));
  IF v_bad IS NOT NULL THEN PERFORM property.fail('22023', 'unknown or protected fields: ' || array_to_string(v_bad, ', ')); END IF;
  SELECT * INTO r FROM property.properties WHERE id = p_property;
  r := jsonb_populate_record(r, p_ids);
  SELECT array_agg(k ORDER BY k) INTO v_changed FROM jsonb_object_keys(p_ids) k;
  BEGIN
    UPDATE property.properties SET
      province = r.province, district = r.district, tehsil = r.tehsil, mauza = r.mauza, society = r.society, khewat = r.khewat,
      khatooni = r.khatooni, khasra = r.khasra, plot_no = r.plot_no, building = r.building, floor = r.floor, unit_no = r.unit_no,
      sub_registrar = r.sub_registrar, deed_no = r.deed_no, deed_volume = r.deed_volume, deed_page = r.deed_page, deed_date = r.deed_date,
      land_record_ref = r.land_record_ref, authority_file_no = r.authority_file_no, excise_no = r.excise_no, address = r.address,
      land_area = r.land_area, land_area_unit = r.land_area_unit, covered_area_sqft = r.covered_area_sqft, gps_lat = r.gps_lat,
      gps_lon = r.gps_lon, use = r.use, built = r.built, occupancy = r.occupancy, lease_count = r.lease_count,
      monthly_rent_paisa = r.monthly_rent_paisa, declared_charges = r.declared_charges
    WHERE id = p_property;
  EXCEPTION WHEN check_violation THEN
    PERFORM property.fail('22023', 'an identifier is out of range: ' || SQLERRM);
  END;
  RETURN coalesce(v_changed, '{}');
END $$;

CREATE FUNCTION property.create_property(p_sponsor uuid, p_actor text, p_acting_for bigint, p_previous uuid, p_ids jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, property AS $$
DECLARE
  v_id uuid;
  v_fields text[];
  prev property.properties;
BEGIN
  PERFORM property.need_duty(p_actor, ARRAY['onboarding'], 'enter a property on the sponsor''s behalf');
  IF NOT EXISTS (SELECT 1 FROM property.sponsors WHERE id = p_sponsor) THEN PERFORM property.fail('P0002', 'unknown sponsor'); END IF;
  IF property.sponsor_state(p_sponsor) = 'kyb_rejected' THEN PERFORM property.fail('23514', 'the sponsor was rejected'); END IF;
  PERFORM property.check_representative(p_sponsor, p_acting_for, 'submit');
  IF p_previous IS NOT NULL THEN
    -- OB-16: same sponsor, rejected for a curable reason, linked once.
    SELECT * INTO prev FROM property.properties WHERE id = p_previous FOR UPDATE;
    IF NOT FOUND OR prev.sponsor_id <> p_sponsor OR prev.state <> 'rejected'
       OR NOT coalesce((SELECT curable FROM property.property_events WHERE property_id = p_previous ORDER BY id DESC LIMIT 1), false) THEN
      PERFORM property.fail('23514', 'only the same sponsor may resubmit, and only a file rejected for a curable reason (OB-16)');
    END IF;
    IF EXISTS (SELECT 1 FROM property.properties WHERE previous_id = p_previous) THEN
      PERFORM property.fail('23505', 'a new file already links to this rejected file');
    END IF;
  END IF;
  INSERT INTO property.properties (sponsor_id, previous_id, created_by) VALUES (p_sponsor, p_previous, p_actor) RETURNING id INTO v_id;
  v_fields := property.set_identifiers(v_id, coalesce(p_ids, '{}'::jsonb));
  PERFORM property.audit_append(p_actor, 'property.created', jsonb_build_object('ref', 'properties:' || v_id, 'sponsor', p_sponsor,
                                'previous', p_previous, 'actingFor', p_acting_for, 'fields', to_jsonb(v_fields)));
  RETURN v_id;
END $$;

CREATE FUNCTION property.update_property(p_property uuid, p_actor text, p_acting_for bigint, p_ids jsonb) RETURNS text[]
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, property AS $$
DECLARE
  p property.properties;
  v_fields text[];
BEGIN
  PERFORM property.need_duty(p_actor, ARRAY['onboarding'], 'change a property on the sponsor''s behalf');
  SELECT * INTO p FROM property.properties WHERE id = p_property FOR UPDATE;
  IF NOT FOUND THEN PERFORM property.fail('P0002', 'unknown property'); END IF;
  IF p.state <> 'draft' THEN PERFORM property.fail('23514', 'identifiers change only while the property is a draft'); END IF;
  PERFORM property.check_representative(p.sponsor_id, p_acting_for, 'respond');
  v_fields := property.set_identifiers(p_property, p_ids);
  PERFORM property.audit_append(p_actor, 'property.updated', jsonb_build_object('ref', 'properties:' || p_property || ':update:' || txid_current(),
                                'property', p_property, 'actingFor', p_acting_for, 'fields', to_jsonb(v_fields)));
  RETURN v_fields;
END $$;

/** OB-10: identifiers that must be present before submission (LEGAL TO CONFIRM per province). */
CREATE FUNCTION property.identifier_problem(p_property uuid) RETURNS text
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, property AS $$
DECLARE
  p property.properties;
  v_missing text[] := '{}';
BEGIN
  SELECT * INTO p FROM property.properties WHERE id = p_property;
  IF p.property_key IS NULL THEN v_missing := v_missing || 'province, district and (society + plot) or (mauza + khasra)'::text; END IF;
  IF p.sub_registrar IS NULL OR p.deed_no IS NULL OR p.deed_date IS NULL THEN v_missing := v_missing || 'registered deed (office, number, date)'::text; END IF;
  IF p.land_record_ref IS NULL AND p.authority_file_no IS NULL THEN v_missing := v_missing || 'land-record reference or authority file number'::text; END IF;
  IF p.excise_no IS NULL THEN v_missing := v_missing || 'property-tax number'::text; END IF;
  IF p.land_area IS NULL THEN v_missing := v_missing || 'land area'::text; END IF;
  IF p.gps_lat IS NULL THEN v_missing := v_missing || 'GPS'::text; END IF;
  IF p.use IS NULL OR p.built IS NULL OR p.occupancy IS NULL OR p.declared_charges IS NULL THEN
    v_missing := v_missing || 'use, built, occupancy and declared charges'::text;
  END IF;
  IF p.built AND p.covered_area_sqft IS NULL THEN v_missing := v_missing || 'covered area'::text; END IF;
  IF p.occupancy IN ('tenanted', 'partly_tenanted') AND (p.lease_count IS NULL OR p.monthly_rent_paisa IS NULL) THEN
    v_missing := v_missing || 'leases summary'::text;
  END IF;
  IF cardinality(v_missing) > 0 THEN RETURN 'identifiers incomplete (OB-10): ' || array_to_string(v_missing, '; '); END IF;
  RETURN NULL;
END $$;

/** PR-6: candidates among every property that was ever submitted (OB-14, OB-15, OB-16, OB-17). */
CREATE FUNCTION property.find_duplicates(p_property uuid)
RETURNS TABLE (candidate uuid, kind text, reasons text[], fraud boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, property AS $$
DECLARE
  p property.properties;
  v_linked uuid[];
  v_radius double precision := property.setting('gps_radius_m')::double precision;
BEGIN
  SELECT * INTO p FROM property.properties WHERE id = p_property;
  IF NOT FOUND THEN PERFORM property.fail('P0002', 'unknown property'); END IF;
  WITH RECURSIVE chainp (id) AS (
    SELECT x.previous_id FROM property.properties x WHERE x.id = p_property AND x.previous_id IS NOT NULL
    UNION
    SELECT x.previous_id FROM property.properties x JOIN chainp c ON x.id = c.id WHERE x.previous_id IS NOT NULL
  ) SELECT coalesce(array_agg(c.id), '{}') INTO v_linked FROM chainp c;
  RETURN QUERY
  WITH cand AS (
    SELECT o.* FROM property.properties o
    WHERE o.id <> p.id AND EXISTS (SELECT 1 FROM property.property_events e WHERE e.property_id = o.id AND e.code = 'P1')
  ), r AS (
    SELECT o.id, o.state,
      array_remove(ARRAY[
        CASE WHEN p.property_key IS NOT NULL AND o.property_key = p.property_key THEN 'same_property_key' END,
        CASE WHEN p.deed_key IS NOT NULL AND o.deed_key = p.deed_key
                  AND extract(year FROM o.deed_date) IS NOT DISTINCT FROM extract(year FROM p.deed_date) THEN 'same_registered_deed' END,
        CASE WHEN EXISTS (SELECT 1 FROM property.documents d JOIN property.doc_types t ON t.code = d.doc_type AND t.title_class
                          JOIN property.documents od ON od.sha256 = d.sha256 AND od.property_id = o.id
                          WHERE d.property_id = p.id) THEN 'same_title_document' END
      ]::text[], NULL) AS exact,
      array_remove(ARRAY[
        CASE WHEN p.gps_lat IS NOT NULL AND o.gps_lat IS NOT NULL AND abs(o.gps_lat - p.gps_lat) < 0.01 AND abs(o.gps_lon - p.gps_lon) < 0.01
                  AND property.distance_m(p.gps_lat, p.gps_lon, o.gps_lat, o.gps_lon) <= v_radius THEN 'gps_within_radius' END,
        CASE WHEN p.property_key IS NOT NULL AND o.property_key IS DISTINCT FROM p.property_key
                  AND split_part(o.property_key, '|', 1) || '|' || split_part(o.property_key, '|', 2) || '|' || split_part(o.property_key, '|', 3) || '|' || split_part(o.property_key, '|', 4)
                    = split_part(p.property_key, '|', 1) || '|' || split_part(p.property_key, '|', 2) || '|' || split_part(p.property_key, '|', 3) || '|' || split_part(p.property_key, '|', 4)
             THEN 'same_parcel_other_unit' END,
        CASE WHEN p.property_key IS NOT NULL AND o.property_key IS NOT NULL AND o.property_key IS DISTINCT FROM p.property_key
                  AND split_part(o.property_key, '|', 2) = split_part(p.property_key, '|', 2)
                  AND split_part(o.property_key, '|', 3) = split_part(p.property_key, '|', 3)
                  AND regexp_replace(split_part(o.property_key, '|', 4), '[^0-9/]', '', 'g') <> ''
                  AND regexp_replace(split_part(o.property_key, '|', 4), '[^0-9/]', '', 'g') = regexp_replace(split_part(p.property_key, '|', 4), '[^0-9/]', '', 'g')
                  AND split_part(o.property_key, '|', 4) <> split_part(p.property_key, '|', 4)
             THEN 'same_parcel_number' END,
        CASE WHEN p.deed_key IS NOT NULL AND o.deed_key = p.deed_key
                  AND extract(year FROM o.deed_date) IS DISTINCT FROM extract(year FROM p.deed_date) THEN 'same_deed_number_other_year' END,
        CASE WHEN property.norm(p.land_record_ref) <> '' AND property.norm(o.land_record_ref) = property.norm(p.land_record_ref)
                  AND property.norm(o.district) = property.norm(p.district) THEN 'same_land_record_ref' END,
        CASE WHEN property.norm(p.authority_file_no) <> '' AND property.norm(o.authority_file_no) = property.norm(p.authority_file_no)
                  AND property.norm(o.district) = property.norm(p.district) THEN 'same_authority_file' END,
        CASE WHEN property.norm(p.excise_no) <> '' AND property.norm(o.excise_no) = property.norm(p.excise_no)
                  AND property.norm(o.district) = property.norm(p.district) THEN 'same_property_tax_number' END,
        CASE WHEN property.norm(p.address) <> '' AND property.norm(o.address) = property.norm(p.address)
                  AND property.norm(o.district) = property.norm(p.district) THEN 'same_address' END,
        CASE WHEN EXISTS (SELECT 1 FROM property.documents d JOIN property.doc_types t ON t.code = d.doc_type AND NOT t.title_class
                          JOIN property.documents od ON od.sha256 = d.sha256 AND od.property_id = o.id
                          WHERE d.property_id = p.id) THEN 'same_document' END
      ]::text[], NULL) AS possible
    FROM cand o
  )
  SELECT r.id,
         CASE WHEN r.id = ANY (v_linked) THEN 'linked' WHEN cardinality(r.exact) > 0 THEN 'exact' ELSE 'possible' END,
         r.exact || r.possible,
         cardinality(r.exact) > 0 AND r.state = 'tokenization_ready' AND NOT (r.id = ANY (v_linked))
  FROM r
  WHERE cardinality(r.exact) + cardinality(r.possible) > 0
  ORDER BY r.id;
END $$;

/**
 * P1. Returns {submitted, checkId, outcome, possible, fraud}. An exact duplicate does not raise: the
 * check and its case are recorded and committed, the property stays a draft (OB-15 "blocks submission
 * and opens a case"; OB-17 marks a match on a tokenized property as a fraud indicator).
 */
CREATE FUNCTION property.submit_property(p_property uuid, p_actor text, p_acting_for bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, property AS $$
DECLARE
  p property.properties;
  v_problem text;
  v_missing text[];
  v_check bigint;
  v_exact integer;
  v_possible integer;
  v_fraud boolean;
  v_outcome text;
  c record;
BEGIN
  PERFORM property.need_duty(p_actor, ARRAY['onboarding'], 'submit a property on the sponsor''s behalf');
  -- One submission at a time, so two concurrent submissions of the same property cannot both pass.
  PERFORM pg_advisory_xact_lock(586586142);
  SELECT * INTO p FROM property.properties WHERE id = p_property FOR UPDATE;
  IF NOT FOUND THEN PERFORM property.fail('P0002', 'unknown property'); END IF;
  IF p.state <> 'draft' THEN PERFORM property.fail('23514', format('property transition P1 is not allowed from %s', p.state)); END IF;
  IF property.sponsor_state(p.sponsor_id) <> 'kyb_approved' THEN PERFORM property.fail('23514', 'the sponsor is not KYB-approved'); END IF;
  PERFORM property.check_representative(p.sponsor_id, p_acting_for, 'submit');
  v_problem := property.identifier_problem(p_property);
  IF v_problem IS NOT NULL THEN PERFORM property.fail('23514', v_problem); END IF;
  v_missing := property.missing_documents(p.sponsor_id, p_property);
  IF cardinality(v_missing) > 0 THEN PERFORM property.fail('23514', 'missing mandatory documents (OB-13): ' || array_to_string(v_missing, ', ')); END IF;

  SELECT count(*) FILTER (WHERE d.kind = 'exact'), count(*) FILTER (WHERE d.kind = 'possible'), coalesce(bool_or(d.fraud), false)
  INTO v_exact, v_possible, v_fraud FROM property.find_duplicates(p_property) d;
  v_outcome := CASE WHEN v_exact > 0 THEN 'blocked' WHEN v_possible > 0 THEN 'possible' ELSE 'clear' END;
  INSERT INTO property.duplicate_checks (property_id, run_by, outcome, fraud) VALUES (p_property, p_actor, v_outcome, v_fraud) RETURNING id INTO v_check;
  FOR c IN SELECT * FROM property.find_duplicates(p_property) LOOP
    INSERT INTO property.duplicate_candidates (check_id, candidate_id, kind, reasons, fraud) VALUES (v_check, c.candidate, c.kind, c.reasons, c.fraud);
  END LOOP;
  PERFORM property.audit_append(p_actor, 'duplicate.checked', jsonb_build_object('ref', 'duplicate_checks:' || v_check, 'property', p_property,
                                'outcome', v_outcome, 'exact', v_exact, 'possible', v_possible, 'fraud', v_fraud));
  IF v_outcome = 'blocked' THEN
    RETURN jsonb_build_object('submitted', false, 'checkId', v_check, 'outcome', v_outcome, 'possible', v_possible, 'fraud', v_fraud);
  END IF;
  PERFORM property.property_move(p_property, 'P1', p_actor, NULL, p_acting_for, NULL, NULL, NULL);
  RETURN jsonb_build_object('submitted', true, 'checkId', v_check, 'outcome', v_outcome, 'possible', v_possible, 'fraud', false);
END $$;

/** The status of a candidate: cleared or confirmed by an onboarding AND a compliance officer, else open. */
CREATE FUNCTION property.candidate_status(p_candidate bigint) RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog, property AS $$
  SELECT CASE
    WHEN (SELECT kind FROM property.duplicate_candidates WHERE id = p_candidate) = 'linked' THEN 'linked'
    WHEN EXISTS (SELECT 1 FROM property.duplicate_decisions a JOIN property.duplicate_decisions b ON b.candidate_id = a.candidate_id
                 WHERE a.candidate_id = p_candidate AND a.capacity = 'onboarding' AND b.capacity = 'compliance'
                   AND a.decision = 'confirm' AND b.decision = 'confirm' AND a.officer <> b.officer) THEN 'confirmed'
    WHEN EXISTS (SELECT 1 FROM property.duplicate_decisions a JOIN property.duplicate_decisions b ON b.candidate_id = a.candidate_id
                 WHERE a.candidate_id = p_candidate AND a.capacity = 'onboarding' AND b.capacity = 'compliance'
                   AND a.decision = 'clear' AND b.decision = 'clear' AND a.officer <> b.officer) THEN 'cleared'
    ELSE 'open'
  END
$$;

/** OB-15: one decision per officer and candidate; two confirmations reject the file as a duplicate (P3). */
CREATE FUNCTION property.decide_duplicate(p_candidate bigint, p_officer text, p_capacity text, p_decision text, p_reason text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, property AS $$
DECLARE
  c property.duplicate_candidates;
  v_property uuid;
  v_latest bigint;
  v_id bigint;
  v_status text;
  v_first text;
BEGIN
  PERFORM property.need_duty(p_officer, CASE WHEN p_capacity = 'compliance' THEN ARRAY['compliance', 'compliance_senior'] ELSE ARRAY['onboarding'] END,
                             'decide a possible duplicate');
  PERFORM property.check_reason(p_reason);
  IF p_capacity NOT IN ('onboarding', 'compliance') OR p_decision NOT IN ('clear', 'confirm') THEN
    PERFORM property.fail('22023', 'capacity is onboarding or compliance; decision is clear or confirm');
  END IF;
  SELECT * INTO c FROM property.duplicate_candidates WHERE id = p_candidate;
  IF NOT FOUND THEN PERFORM property.fail('P0002', 'unknown duplicate candidate'); END IF;
  SELECT property_id INTO v_property FROM property.duplicate_checks WHERE id = c.check_id;
  PERFORM 1 FROM property.properties WHERE id = v_property AND state = 'submitted' FOR UPDATE;
  IF NOT FOUND THEN PERFORM property.fail('23514', 'possible duplicates are decided while the property is submitted'); END IF;
  SELECT max(id) INTO v_latest FROM property.duplicate_checks WHERE property_id = v_property;
  IF c.check_id <> v_latest OR c.kind <> 'possible' THEN PERFORM property.fail('23514', 'only a possible match of the latest check is decided'); END IF;
  IF p_officer = ANY (property.submitters(v_property)) THEN PERFORM property.fail('42501', 'whoever entered or submitted a file never decides it (OB-SOD-1)'); END IF;
  IF property.candidate_status(p_candidate) <> 'open' THEN PERFORM property.fail('23514', 'this candidate is already decided'); END IF;
  BEGIN
    INSERT INTO property.duplicate_decisions (candidate_id, officer, capacity, decision, reason)
    VALUES (p_candidate, p_officer, p_capacity, p_decision, p_reason) RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    PERFORM property.fail('42501', 'an officer decides a candidate once');
  END;
  PERFORM property.audit_append(p_officer, 'duplicate.decided', jsonb_build_object('ref', 'duplicate_decisions:' || v_id, 'candidate', p_candidate,
                                'property', v_property, 'capacity', p_capacity, 'decision', p_decision, 'reason', p_reason));
  v_status := property.candidate_status(p_candidate);
  IF v_status = 'confirmed' THEN
    SELECT officer INTO v_first FROM property.duplicate_decisions
    WHERE candidate_id = p_candidate AND decision = 'confirm' AND officer <> p_officer ORDER BY id LIMIT 1;
    PERFORM property.property_move(v_property, 'P3', p_officer, p_reason, NULL, NULL, v_first, false);
  END IF;
  RETURN v_status;
END $$;

/** P2. */
CREATE FUNCTION property.return_property(p_property uuid, p_officer text, p_reason text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, property AS $$
BEGIN
  PERFORM property.need_duty(p_officer, ARRAY['onboarding'], 'return a property as incomplete');
  PERFORM property.check_reason(p_reason);
  IF p_officer = ANY (property.submitters(p_property)) THEN PERFORM property.fail('42501', 'whoever entered or submitted a file never decides it (OB-SOD-1)'); END IF;
  PERFORM property.property_move(p_property, 'P2', p_officer, p_reason, NULL, NULL, NULL, NULL);
  RETURN 'draft';
END $$;

CREATE FUNCTION property.check_reviewers(p_property uuid, p_officer text, p_legal text, p_valuation text, p_technical text) RETURNS void
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, property AS $$
BEGIN
  PERFORM property.need_duty(p_legal, ARRAY['legal', 'legal_head'], 'review title, encumbrances and the legal opinion');
  PERFORM property.need_duty(p_valuation, ARRAY['valuation'], 'review valuations');
  PERFORM property.need_duty(p_technical, ARRAY['technical'], 'review the building');
  IF p_legal IN (p_valuation, p_technical) OR p_valuation = p_technical THEN
    PERFORM property.fail('42501', 'the legal, valuation and technical reviewers are three different people (OB-SOD-3)');
  END IF;
  IF p_officer IN (p_legal, p_valuation, p_technical) THEN
    PERFORM property.fail('42501', 'the officer who assigns reviewers is not one of them (OB-SOD-1)');
  END IF;
  IF p_legal = ANY (property.submitters(p_property)) OR p_valuation = ANY (property.submitters(p_property))
     OR p_technical = ANY (property.submitters(p_property)) THEN
    PERFORM property.fail('42501', 'whoever entered or submitted a file never reviews it (OB-SOD-1)');
  END IF;
END $$;

/** P4: possible duplicates cleared; three different reviewers assigned. */
CREATE FUNCTION property.start_review(p_property uuid, p_officer text, p_legal text, p_valuation text, p_technical text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, property AS $$
DECLARE
  v_open integer;
  v_check bigint;
  v_id bigint;
  g text;
BEGIN
  PERFORM property.need_duty(p_officer, ARRAY['onboarding'], 'start a review');
  PERFORM 1 FROM property.properties WHERE id = p_property FOR UPDATE;
  IF p_officer = ANY (property.submitters(p_property)) THEN PERFORM property.fail('42501', 'whoever entered or submitted a file never decides it (OB-SOD-1)'); END IF;
  PERFORM property.check_reviewers(p_property, p_officer, p_legal, p_valuation, p_technical);
  SELECT max(id) INTO v_check FROM property.duplicate_checks WHERE property_id = p_property;
  SELECT count(*) INTO v_open FROM property.duplicate_candidates c WHERE c.check_id = v_check AND property.candidate_status(c.id) NOT IN ('cleared', 'linked');
  IF v_open > 0 THEN PERFORM property.fail('23514', format('%s possible duplicate(s) not cleared by onboarding and compliance (OB-15)', v_open)); END IF;
  PERFORM property.property_move(p_property, 'P4', p_officer, NULL, NULL, NULL, NULL, NULL);
  FOREACH g IN ARRAY ARRAY['legal', 'valuation', 'technical'] LOOP
    INSERT INTO property.assignments (property_id, grp, reviewer, assigned_by)
    VALUES (p_property, g, CASE g WHEN 'legal' THEN p_legal WHEN 'valuation' THEN p_valuation ELSE p_technical END, p_officer) RETURNING id INTO v_id;
    PERFORM property.audit_append(p_officer, 'review.assigned', jsonb_build_object('ref', 'assignments:' || v_id, 'property', p_property, 'group', g,
                                  'reviewer', CASE g WHEN 'legal' THEN p_legal WHEN 'valuation' THEN p_valuation ELSE p_technical END));
  END LOOP;
  RETURN 'under_review';
END $$;

/** Replaces one reviewer during the review; earlier reviews of that group stop counting. */
CREATE FUNCTION property.reassign_reviewer(p_property uuid, p_officer text, p_group text, p_reviewer text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, property AS $$
DECLARE
  v_id bigint;
  v_legal text;
  v_valuation text;
  v_technical text;
BEGIN
  PERFORM property.need_duty(p_officer, ARRAY['onboarding'], 'reassign a reviewer');
  PERFORM 1 FROM property.properties WHERE id = p_property AND state IN ('under_review', 'on_hold') FOR UPDATE;
  IF NOT FOUND THEN PERFORM property.fail('23514', 'reviewers are reassigned during the review'); END IF;
  IF p_group NOT IN ('legal', 'valuation', 'technical') THEN PERFORM property.fail('22023', 'group is legal, valuation or technical'); END IF;
  v_legal := CASE WHEN p_group = 'legal' THEN p_reviewer ELSE property.assignee(p_property, 'legal') END;
  v_valuation := CASE WHEN p_group = 'valuation' THEN p_reviewer ELSE property.assignee(p_property, 'valuation') END;
  v_technical := CASE WHEN p_group = 'technical' THEN p_reviewer ELSE property.assignee(p_property, 'technical') END;
  PERFORM property.check_reviewers(p_property, p_officer, v_legal, v_valuation, v_technical);
  INSERT INTO property.assignments (property_id, grp, reviewer, assigned_by) VALUES (p_property, p_group, p_reviewer, p_officer) RETURNING id INTO v_id;
  PERFORM property.audit_append(p_officer, 'review.assigned', jsonb_build_object('ref', 'assignments:' || v_id, 'property', p_property, 'group', p_group, 'reviewer', p_reviewer));
  RETURN v_id;
END $$;

/** P5: any current reviewer sends a query to the sponsor; the file goes back to Draft. */
CREATE FUNCTION property.query_property(p_property uuid, p_reviewer text, p_query text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, property AS $$
BEGIN
  PERFORM property.check_actor(p_reviewer);
  PERFORM property.check_reason(p_query, 'query text');
  IF p_reviewer NOT IN (coalesce(property.assignee(p_property, 'legal'), ''), coalesce(property.assignee(p_property, 'valuation'), ''),
                        coalesce(property.assignee(p_property, 'technical'), '')) THEN
    PERFORM property.fail('42501', 'only a reviewer assigned to this property raises a query');
  END IF;
  PERFORM property.property_move(p_property, 'P5', p_reviewer, p_query, NULL, NULL, NULL, NULL);
  RETURN 'draft';
END $$;

/** P11: the sponsor withdraws (through a representative with the withdraw power). */
CREATE FUNCTION property.withdraw_property(p_property uuid, p_actor text, p_acting_for bigint, p_reason text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, property AS $$
DECLARE
  v_sponsor uuid;
BEGIN
  PERFORM property.need_duty(p_actor, ARRAY['onboarding'], 'record a withdrawal on the sponsor''s behalf');
  PERFORM property.check_reason(p_reason);
  SELECT sponsor_id INTO v_sponsor FROM property.properties WHERE id = p_property FOR UPDATE;
  IF NOT FOUND THEN PERFORM property.fail('P0002', 'unknown property'); END IF;
  PERFORM property.check_representative(v_sponsor, p_acting_for, 'withdraw');
  PERFORM property.property_move(p_property, 'P11', p_actor, p_reason, p_acting_for, NULL, NULL, NULL);
  RETURN 'withdrawn';
END $$;

/** P12 (protective, one officer): stay order, lis pendens, fraud indicator. */
CREATE FUNCTION property.hold_property(p_property uuid, p_actor text, p_reason text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, property AS $$
BEGIN
  PERFORM property.need_duty(p_actor, ARRAY['legal', 'legal_head', 'compliance', 'compliance_senior'], 'put a property on hold');
  PERFORM property.check_reason(p_reason);
  PERFORM property.property_move(p_property, 'P12', p_actor, p_reason, NULL, NULL, NULL, NULL);
  RETURN 'on_hold';
END $$;

/** P9/P10 and reopening during the review (OB-39). */
CREATE FUNCTION property.reopen(p_property uuid, p_actor text, p_disciplines text[], p_reason text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, property AS $$
DECLARE
  v_state text;
BEGIN
  PERFORM property.need_duty(p_actor, ARRAY['legal', 'legal_head', 'valuation', 'technical', 'compliance', 'compliance_senior', 'onboarding'],
                             'reopen a review');
  PERFORM property.check_reason(p_reason);
  IF p_disciplines IS NULL OR cardinality(p_disciplines) = 0
     OR NOT (p_disciplines <@ ARRAY['title', 'encumbrance', 'valuation', 'legal_opinion', 'technical']) THEN
    PERFORM property.fail('22023', 'name the disciplines to reopen');
  END IF;
  SELECT state INTO v_state FROM property.properties WHERE id = p_property FOR UPDATE;
  IF NOT FOUND THEN PERFORM property.fail('P0002', 'unknown property'); END IF;
  IF v_state NOT IN ('under_review', 'legal_approved', 'tokenization_ready', 'on_hold') THEN
    PERFORM property.fail('23514', format('nothing to reopen in state %s', v_state));
  END IF;
  PERFORM property.reopen_internal(p_property, p_disciplines, p_actor, p_reason);
  RETURN (SELECT state FROM property.properties WHERE id = p_property);
END $$;

-- ------------------------------------------------------------------ documents
CREATE FUNCTION property.add_document(p_sponsor uuid, p_property uuid, p_type text, p_sha256 bytea, p_size bigint, p_media text,
                                      p_store_ref text, p_actor text, p_acting_for bigint, p_supersedes uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, property AS $$
DECLARE
  t property.doc_types;
  v_state text;
  v_existing property.documents;
  old property.documents;
  v_id uuid;
  v_disc text[];
BEGIN
  PERFORM property.check_actor(p_actor);
  PERFORM property.check_sha(p_sha256, 'sha256');
  SELECT * INTO t FROM property.doc_types WHERE code = p_type;
  IF NOT FOUND THEN PERFORM property.fail('22023', format('unknown document type %s', p_type)); END IF;
  IF (t.owner_kind = 'property') <> (p_property IS NOT NULL) THEN
    PERFORM property.fail('22023', format('a %s document belongs to a %s', p_type, t.owner_kind));
  END IF;
  IF p_property IS NOT NULL THEN
    SELECT state INTO v_state FROM property.properties WHERE id = p_property AND sponsor_id = p_sponsor FOR UPDATE;
    IF NOT FOUND THEN PERFORM property.fail('P0002', 'unknown property of this sponsor'); END IF;
    IF v_state IN ('rejected', 'withdrawn') THEN PERFORM property.fail('23514', 'the file is closed'); END IF;
  ELSE
    PERFORM 1 FROM property.sponsors WHERE id = p_sponsor FOR UPDATE;
    IF NOT FOUND THEN PERFORM property.fail('P0002', 'unknown sponsor'); END IF;
    v_state := property.sponsor_state(p_sponsor);
    IF v_state = 'kyb_rejected' THEN PERFORM property.fail('23514', 'the sponsor was rejected'); END IF;
  END IF;
  IF p_acting_for IS NOT NULL THEN
    -- The sponsor's side: through an onboarding officer, only into a draft file.
    PERFORM property.need_duty(p_actor, ARRAY['onboarding'], 'upload on the sponsor''s behalf');
    PERFORM property.check_representative(p_sponsor, p_acting_for, 'upload');
    IF v_state NOT IN ('draft', 'kyb_draft', 'kyb_expired') THEN
      PERFORM property.fail('23514', 'the sponsor adds documents while the file is a draft');
    END IF;
  ELSIF NOT property.has_duty(p_actor, ARRAY['onboarding', 'compliance', 'compliance_senior', 'legal', 'legal_head', 'valuation', 'technical',
                                            'ic_member', 'ic_independent', 'trustee']) THEN
    PERFORM property.fail('42501', 'only an officer with a duty, or a representative, adds documents');
  END IF;
  -- OB-12: re-uploading the same bytes changes nothing.
  SELECT * INTO v_existing FROM property.documents
  WHERE sponsor_id = p_sponsor AND property_id IS NOT DISTINCT FROM p_property AND sha256 = p_sha256;
  IF FOUND THEN
    IF v_existing.doc_type <> p_type THEN PERFORM property.fail('23505', 'these bytes are already recorded as another document type'); END IF;
    RETURN v_existing.id;
  END IF;
  IF p_supersedes IS NOT NULL THEN
    SELECT * INTO old FROM property.documents WHERE id = p_supersedes FOR UPDATE;
    IF NOT FOUND OR old.sponsor_id <> p_sponsor OR old.property_id IS DISTINCT FROM p_property OR old.doc_type <> p_type THEN
      PERFORM property.fail('22023', 'a document supersedes a document of the same file and type');
    END IF;
    IF NOT property.is_current(p_supersedes) THEN PERFORM property.fail('23505', 'that document is already superseded'); END IF;
  END IF;
  BEGIN
    INSERT INTO property.documents (sponsor_id, property_id, doc_type, sha256, size_bytes, media_type, store_ref, supersedes, uploaded_by, acting_for)
    VALUES (p_sponsor, p_property, p_type, p_sha256, p_size, p_media, p_store_ref, p_supersedes, p_actor, p_acting_for) RETURNING id INTO v_id;
  EXCEPTION WHEN check_violation THEN
    PERFORM property.fail('22023', 'invalid document metadata (size 1 B - 1 GiB, media type pdf/jpeg/png/tiff, opaque store reference)');
  WHEN unique_violation THEN
    PERFORM property.fail('23505', 'this store reference is already used');
  END;
  PERFORM property.audit_append(p_actor, 'document.added', jsonb_build_object('ref', 'documents:' || v_id, 'sponsor', p_sponsor, 'property', p_property,
                                'type', p_type, 'sha256', encode(p_sha256, 'hex'), 'size', p_size, 'supersedes', p_supersedes, 'actingFor', p_acting_for));
  IF p_supersedes IS NOT NULL AND p_property IS NOT NULL THEN
    -- PR-7 / OB-31: every review that relied on the old document is reopened; an approved file goes back to review.
    SELECT array_agg(DISTINCT r.discipline) INTO v_disc FROM property.reviews r JOIN property.review_documents rd ON rd.review_id = r.id
    WHERE rd.document_id = p_supersedes;
    IF v_disc IS NOT NULL OR v_state IN ('legal_approved', 'tokenization_ready') THEN
      PERFORM property.reopen_internal(p_property, coalesce(v_disc, '{}'), p_actor, format('document %s superseded', p_supersedes));
    END IF;
  END IF;
  RETURN v_id;
END $$;

/** OB-21: verification of a document at its issuing office. */
CREATE FUNCTION property.verify_document(p_document uuid, p_actor text, p_method text, p_office text, p_on date, p_outcome text, p_evidence bytea) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, property AS $$
DECLARE
  d property.documents;
  v_id bigint;
BEGIN
  SELECT * INTO d FROM property.documents WHERE id = p_document;
  IF NOT FOUND THEN PERFORM property.fail('P0002', 'unknown document'); END IF;
  IF d.property_id IS NULL THEN
    PERFORM property.need_duty(p_actor, ARRAY['onboarding', 'compliance', 'compliance_senior'], 'verify a KYB document');
  ELSIF p_actor IS DISTINCT FROM property.assignee(d.property_id, 'legal') THEN
    PERFORM property.need_duty(p_actor, ARRAY['legal_head'], 'verify a document at source (or be the assigned legal reviewer)');
  END IF;
  PERFORM property.check_sha(p_evidence, 'evidence');
  IF p_on IS NULL OR p_on > current_date THEN PERFORM property.fail('22023', 'the verification date is required and not in the future'); END IF;
  BEGIN
    INSERT INTO property.document_verifications (document_id, method, source_office, verified_on, outcome, evidence_sha256, recorded_by)
    VALUES (p_document, p_method, p_office, p_on, p_outcome, p_evidence, p_actor) RETURNING id INTO v_id;
  EXCEPTION WHEN check_violation OR not_null_violation THEN
    PERFORM property.fail('22023', 'invalid verification (method, office, outcome)');
  END;
  PERFORM property.audit_append(p_actor, 'document.verified', jsonb_build_object('ref', 'document_verifications:' || v_id, 'document', p_document,
                                'method', p_method, 'outcome', p_outcome, 'evidence', encode(p_evidence, 'hex')));
  RETURN v_id;
END $$;

-- ------------------------------------------------------------------ due diligence records
CREATE FUNCTION property.check_legal_actor(p_property uuid, p_actor text) RETURNS void
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, property AS $$
BEGIN
  PERFORM property.check_actor(p_actor);
  IF p_actor IS DISTINCT FROM property.assignee(p_property, 'legal') THEN
    PERFORM property.need_duty(p_actor, ARRAY['legal_head'], 'record legal due diligence (or be the assigned legal reviewer)');
  END IF;
END $$;

CREATE FUNCTION property.add_title_link(p_property uuid, p_actor text, p_position smallint, p_kind text, p_ref text, p_on date, p_document uuid) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, property AS $$
DECLARE
  v_id bigint;
BEGIN
  PERFORM property.check_legal_actor(p_property, p_actor);
  PERFORM 1 FROM property.properties WHERE id = p_property AND state = 'under_review' FOR UPDATE;
  IF NOT FOUND THEN PERFORM property.fail('23514', 'the chain of title is recorded during the review'); END IF;
  IF NOT EXISTS (SELECT 1 FROM property.documents WHERE id = p_document AND property_id = p_property AND property.is_current(id)) THEN
    PERFORM property.fail('22023', 'a title link is supported by a current document of this property');
  END IF;
  BEGIN
    INSERT INTO property.title_links (property_id, position, kind, instrument_ref, registered_on, document_id, recorded_by)
    VALUES (p_property, p_position, p_kind, p_ref, p_on, p_document, p_actor) RETURNING id INTO v_id;
  EXCEPTION WHEN check_violation OR not_null_violation THEN
    PERFORM property.fail('22023', 'invalid title link (position, kind, reference, date)');
  END;
  PERFORM property.audit_append(p_actor, 'title.link_recorded', jsonb_build_object('ref', 'title_links:' || v_id, 'property', p_property,
                                'position', p_position, 'kind', p_kind, 'document', p_document));
  RETURN v_id;
END $$;

/** OB-22. A new encumbrance is a material change (OB-39): it reopens the encumbrance review. */
CREATE FUNCTION property.record_encumbrance(p_property uuid, p_actor text, p_kind text, p_description text, p_evidence bytea) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, property AS $$
DECLARE
  v_id bigint;
  v_state text;
BEGIN
  PERFORM property.check_legal_actor(p_property, p_actor);
  PERFORM property.check_reason(p_description, 'description');
  PERFORM property.check_sha(p_evidence, 'evidence');
  SELECT state INTO v_state FROM property.properties WHERE id = p_property FOR UPDATE;
  IF v_state IS NULL OR v_state NOT IN ('under_review', 'legal_approved', 'tokenization_ready', 'on_hold') THEN
    PERFORM property.fail('23514', 'encumbrances are recorded during or after the review');
  END IF;
  BEGIN
    INSERT INTO property.encumbrances (property_id, kind, description, evidence_sha256, found_by) VALUES (p_property, p_kind, p_description, p_evidence, p_actor) RETURNING id INTO v_id;
  EXCEPTION WHEN check_violation THEN
    PERFORM property.fail('22023', 'unknown encumbrance kind');
  END;
  PERFORM property.audit_append(p_actor, 'encumbrance.recorded', jsonb_build_object('ref', 'encumbrances:' || v_id, 'property', p_property, 'kind', p_kind));
  PERFORM property.reopen_internal(p_property, ARRAY['encumbrance'], p_actor, 'new encumbrance recorded: ' || p_kind);
  RETURN v_id;
END $$;

CREATE FUNCTION property.resolve_encumbrance(p_encumbrance bigint, p_actor text, p_resolution text, p_note text, p_evidence bytea) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, property AS $$
DECLARE
  e property.encumbrances;
  v_id bigint;
BEGIN
  SELECT * INTO e FROM property.encumbrances WHERE id = p_encumbrance;
  IF NOT FOUND THEN PERFORM property.fail('P0002', 'unknown encumbrance'); END IF;
  PERFORM property.check_legal_actor(e.property_id, p_actor);
  PERFORM property.check_reason(p_note, 'note');
  PERFORM property.check_sha(p_evidence, 'evidence');
  BEGIN
    INSERT INTO property.encumbrance_resolutions (encumbrance_id, resolution, note, evidence_sha256, resolved_by)
    VALUES (p_encumbrance, p_resolution, p_note, p_evidence, p_actor) RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    PERFORM property.fail('23505', 'this encumbrance is already resolved');
  WHEN check_violation THEN
    PERFORM property.fail('22023', 'resolution is discharged or condition_precedent');
  END;
  PERFORM property.audit_append(p_actor, 'encumbrance.resolved', jsonb_build_object('ref', 'encumbrance_resolutions:' || v_id, 'encumbrance', p_encumbrance,
                                'property', e.property_id, 'resolution', p_resolution));
  RETURN v_id;
END $$;

CREATE FUNCTION property.add_valuer(p_licence text, p_panel text, p_subject uuid, p_actor text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, property AS $$
DECLARE
  v_id bigint;
BEGIN
  PERFORM property.check_actor(p_actor);
  BEGIN
    INSERT INTO property.valuers (licence_no, panel, subject_id, added_by) VALUES (property.norm(p_licence), p_panel, p_subject, p_actor) RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    PERFORM property.fail('23505', 'this valuer is already on the panel');
  WHEN check_violation OR foreign_key_violation THEN
    PERFORM property.fail('22023', 'invalid valuer (licence, panel or KYC subject)');
  END;
  PERFORM property.audit_append(p_actor, 'valuer.added', jsonb_build_object('ref', 'valuers:' || v_id, 'licence', property.norm(p_licence), 'panel', p_panel));
  RETURN v_id;
END $$;

CREATE FUNCTION property.approve_valuer(p_valuer bigint, p_actor text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, property AS $$
DECLARE
  v property.valuers;
BEGIN
  PERFORM property.check_actor(p_actor);
  SELECT * INTO v FROM property.valuers WHERE id = p_valuer FOR UPDATE;
  IF NOT FOUND THEN PERFORM property.fail('P0002', 'unknown valuer'); END IF;
  IF v.approved_by IS NOT NULL THEN RETURN false; END IF;
  IF v.added_by = p_actor THEN PERFORM property.fail('42501', 'a different administrator approves a valuer (maker-checker)'); END IF;
  UPDATE property.valuers SET approved_by = p_actor WHERE id = p_valuer;
  PERFORM property.audit_append(p_actor, 'valuer.approved', jsonb_build_object('ref', 'valuers:' || p_valuer || ':approval'));
  RETURN true;
END $$;

CREATE FUNCTION property.record_valuation(p_property uuid, p_actor text, p_valuer bigint, p_value bigint, p_on date, p_report uuid, p_independence bytea) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, property AS $$
DECLARE
  v property.valuers;
  v_sponsor uuid;
  v_id bigint;
BEGIN
  PERFORM property.check_actor(p_actor);
  SELECT sponsor_id INTO v_sponsor FROM property.properties WHERE id = p_property AND state = 'under_review' FOR UPDATE;
  IF NOT FOUND THEN PERFORM property.fail('23514', 'valuations are recorded during the review'); END IF;
  IF p_actor IS DISTINCT FROM property.assignee(p_property, 'valuation') THEN
    PERFORM property.fail('42501', 'only the assigned valuation reviewer records valuations');
  END IF;
  SELECT * INTO v FROM property.valuers WHERE id = p_valuer;
  IF NOT FOUND OR v.approved_by IS NULL THEN PERFORM property.fail('42501', 'the valuer is not on the approved panel (threat T-3)'); END IF;
  IF v.subject_id IS NOT NULL AND EXISTS (SELECT 1 FROM property.sponsor_persons WHERE sponsor_id = v_sponsor AND subject_id = v.subject_id) THEN
    PERFORM property.fail('42501', 'the valuer is a person of the sponsor (OB-SOD-3)');
  END IF;
  PERFORM property.check_sha(p_independence, 'the independence declaration');
  IF p_value IS NULL OR p_value <= 0 OR p_on IS NULL OR p_on > current_date THEN
    PERFORM property.fail('22023', 'a positive value in paisa and a valuation date not in the future are required');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM property.documents WHERE id = p_report AND property_id = p_property AND doc_type = 'valuation_report' AND property.is_current(id)) THEN
    PERFORM property.fail('22023', 'the report is a current valuation report of this property');
  END IF;
  INSERT INTO property.valuations (property_id, valuer_id, basis, value_paisa, valued_on, report_document_id, independence_sha256, recorded_by)
  VALUES (p_property, p_valuer, 'market_value', p_value, p_on, p_report, p_independence, p_actor) RETURNING id INTO v_id;
  PERFORM property.audit_append(p_actor, 'valuation.recorded', jsonb_build_object('ref', 'valuations:' || v_id, 'property', p_property, 'valuer', p_valuer,
                                'valuePaisa', p_value::text, 'valuedOn', p_on, 'report', p_report));
  RETURN v_id;
END $$;

/** Records a review by the assigned reviewer; a pass is refused unless its discipline's rules hold. */
CREATE FUNCTION property.record_review(p_property uuid, p_reviewer text, p_discipline text, p_scope text, p_method text, p_findings text,
                                       p_conditions jsonb, p_decision text, p_documents uuid[]) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, property AS $$
DECLARE
  v_sponsor uuid;
  v_id bigint;
  v_problem text;
  v_val record;
  v_types text[];
  v_docs jsonb;
BEGIN
  PERFORM property.check_actor(p_reviewer);
  SELECT sponsor_id INTO v_sponsor FROM property.properties WHERE id = p_property AND state = 'under_review' FOR UPDATE;
  IF NOT FOUND THEN PERFORM property.fail('23514', 'reviews are recorded while the property is under review'); END IF;
  IF property.discipline_group(p_discipline) IS NULL THEN PERFORM property.fail('22023', 'unknown discipline'); END IF;
  IF p_reviewer IS DISTINCT FROM property.assignee(p_property, property.discipline_group(p_discipline)) THEN
    PERFORM property.fail('42501', format('only the assigned %s reviewer records a %s review', property.discipline_group(p_discipline), p_discipline));
  END IF;
  IF p_documents IS NULL OR cardinality(p_documents) = 0 OR array_position(p_documents, NULL) IS NOT NULL THEN
    PERFORM property.fail('22023', 'a review lists the documents it relied on (OB-31)');
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(p_documents) x (id)
             WHERE NOT EXISTS (SELECT 1 FROM property.documents d WHERE d.id = x.id AND d.sponsor_id = v_sponsor
                                                                    AND (d.property_id = p_property OR d.property_id IS NULL) AND property.is_current(d.id))) THEN
    PERFORM property.fail('22023', 'a review relies only on current documents of this file (OB-31)');
  END IF;
  SELECT array_agg(d.doc_type) INTO v_types FROM property.documents d WHERE d.id = ANY (p_documents);
  IF p_decision IN ('pass', 'pass_with_conditions') THEN
    IF p_discipline = 'title' THEN
      IF NOT ('title_deed' = ANY (v_types)) THEN PERFORM property.fail('23514', 'a title review relies on the title deed'); END IF;
      IF EXISTS (SELECT 1 FROM property.documents d JOIN property.doc_types t ON t.code = d.doc_type AND t.title_class
                 WHERE d.id = ANY (p_documents)
                   AND coalesce((SELECT v.outcome FROM property.document_verifications v WHERE v.document_id = d.id ORDER BY v.id DESC LIMIT 1), '') <> 'verified') THEN
        PERFORM property.fail('23514', 'every title document relied on is verified at its source (OB-21)');
      END IF;
      v_problem := property.title_problem(p_property);
    ELSIF p_discipline = 'encumbrance' THEN
      IF EXISTS (SELECT 1 FROM property.encumbrances e WHERE e.property_id = p_property
                 AND NOT EXISTS (SELECT 1 FROM property.encumbrance_resolutions x WHERE x.encumbrance_id = e.id)) THEN
        v_problem := 'an encumbrance is neither discharged nor a condition precedent (OB-22)';
      END IF;
    ELSIF p_discipline = 'valuation' THEN
      SELECT * INTO v_val FROM property.valuation_status(p_property);
      IF NOT v_val.ok THEN v_problem := v_val.problem;
      ELSIF EXISTS (SELECT 1 FROM (SELECT DISTINCT ON (x.valuer_id) x.report_document_id FROM property.valuations x
                                   WHERE x.property_id = p_property ORDER BY x.valuer_id, x.id DESC) l
                    WHERE property.is_current(l.report_document_id) AND NOT (l.report_document_id = ANY (p_documents))) THEN
        v_problem := 'a valuation review relies on every current valuation report';
      END IF;
    ELSIF p_discipline = 'legal_opinion' AND NOT ('legal_opinion' = ANY (v_types)) THEN
      v_problem := 'the legal opinion review relies on the legal opinion (OB-28)';
    ELSIF p_discipline = 'technical' AND NOT ('technical_report' = ANY (v_types)) THEN
      v_problem := 'the technical review relies on the technical report (OB-30)';
    END IF;
    IF v_problem IS NOT NULL THEN PERFORM property.fail('23514', v_problem); END IF;
  END IF;
  BEGIN
    INSERT INTO property.reviews (property_id, discipline, reviewer, scope, method, findings, conditions, decision)
    VALUES (p_property, p_discipline, p_reviewer, p_scope, p_method, p_findings, coalesce(p_conditions, '[]'::jsonb), p_decision) RETURNING id INTO v_id;
  EXCEPTION WHEN check_violation OR not_null_violation THEN
    PERFORM property.fail('22023', 'invalid review (scope, method, findings 10+ characters; conditions only with pass_with_conditions)');
  END;
  INSERT INTO property.review_documents (review_id, document_id, sha256)
  SELECT v_id, d.id, d.sha256 FROM property.documents d WHERE d.id = ANY (p_documents);
  SELECT jsonb_agg(jsonb_build_array(rd.document_id, encode(rd.sha256, 'hex')) ORDER BY rd.document_id) INTO v_docs
  FROM property.review_documents rd WHERE rd.review_id = v_id;
  PERFORM property.audit_append(p_reviewer, 'review.recorded', jsonb_build_object('ref', 'reviews:' || v_id, 'property', p_property,
                                'discipline', p_discipline, 'decision', p_decision, 'docs', v_docs));
  RETURN v_id;
END $$;

-- ------------------------------------------------------------------ maker-checker requests
CREATE FUNCTION property.request_transition(p_entity text, p_id uuid, p_code text, p_officer text, p_reason text, p_detail jsonb) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, property AS $$
DECLARE
  v_state text;
  v_detail jsonb := coalesce(p_detail, '{}'::jsonb);
  v_problem text;
  v_id bigint;
  v_group text;
  v_since timestamptz;
  r record;
BEGIN
  PERFORM property.check_actor(p_officer);
  PERFORM property.check_reason(p_reason);
  IF jsonb_typeof(v_detail) <> 'object' THEN PERFORM property.fail('22023', 'detail must be a JSON object'); END IF;
  UPDATE property.requests SET status = 'expired', decided_at = date_trunc('microseconds', clock_timestamp()) WHERE status = 'open' AND expires_at < now();
  IF p_entity = 'sponsor' AND p_code IN ('K4', 'K5', 'K10', 'K11', 'SC') THEN
    PERFORM 1 FROM property.sponsors WHERE id = p_id FOR UPDATE;
    IF NOT FOUND THEN PERFORM property.fail('P0002', 'unknown sponsor'); END IF;
    v_state := property.sponsor_state(p_id);
    PERFORM property.need_duty(p_officer, ARRAY['compliance', 'compliance_senior'], 'request a KYB decision');
    IF EXISTS (SELECT 1 FROM property.sponsor_events WHERE sponsor_id = p_id AND code IN ('K1', 'K9') AND actor = p_officer) THEN
      PERFORM property.fail('42501', 'whoever submitted a file never decides it (OB-SOD-1)');
    END IF;
    IF p_code = 'SC' THEN
      SELECT * INTO r FROM property.sponsor_screenings WHERE sponsor_id = p_id ORDER BY id DESC LIMIT 1;
      IF NOT FOUND OR r.outcome <> 'possible_match' OR (v_detail->>'screening') IS DISTINCT FROM r.id::text THEN
        PERFORM property.fail('23514', 'only the latest screening, when it is a possible match, can be cleared');
      END IF;
      IF (v_detail->>'evidence') IS NULL OR (v_detail->>'evidence') !~ '^[0-9a-f]{64}$' THEN
        PERFORM property.fail('22023', 'a clearance carries the evidence hash (64 hex characters)');
      END IF;
    ELSIF NOT EXISTS (SELECT 1 FROM property.transitions WHERE entity = 'sponsor' AND code = p_code AND from_state = v_state) THEN
      PERFORM property.fail('23514', format('KYB transition %s is not allowed from %s', p_code, v_state));
    END IF;
    IF p_code = 'K4' THEN
      v_problem := property.kyb_problem(p_id, 'K4');
      IF v_problem IS NOT NULL THEN PERFORM property.fail('23514', v_problem); END IF;
    ELSIF p_code IN ('K5', 'K11') THEN
      -- OB-9: an FMU assessment recorded since the file was (re)submitted or suspended.
      SELECT max(at) INTO v_since FROM property.sponsor_events WHERE sponsor_id = p_id AND code IN ('K1', 'K8', 'K9');
      IF NOT EXISTS (SELECT 1 FROM property.fmu_assessments WHERE sponsor_id = p_id AND at >= coalesce(v_since, '-infinity')) THEN
        PERFORM property.fail('23514', 'an FMU assessment must be recorded before a rejection (OB-9)');
      END IF;
    END IF;
  ELSIF p_entity = 'property' AND p_code IN ('P6', 'P13', 'P14') THEN
    SELECT state INTO v_state FROM property.properties WHERE id = p_id FOR UPDATE;
    IF NOT FOUND THEN PERFORM property.fail('P0002', 'unknown property'); END IF;
    IF NOT EXISTS (SELECT 1 FROM property.transitions WHERE entity = 'property' AND code = p_code AND from_state = v_state) THEN
      PERFORM property.fail('23514', format('property transition %s is not allowed from %s', p_code, v_state));
    END IF;
    IF p_code = 'P6' THEN
      v_group := property.discipline_group(v_detail->>'discipline');
      IF v_group IS NULL THEN PERFORM property.fail('22023', 'P6 names the failed discipline'); END IF;
      IF p_officer IS DISTINCT FROM property.assignee(p_id, v_group) THEN
        PERFORM property.fail('42501', 'only the assigned reviewer of that discipline requests a rejection');
      END IF;
      SELECT * INTO r FROM property.review_status(p_id) s WHERE s.discipline = v_detail->>'discipline';
      IF r.review_id IS NULL OR NOT r.fresh OR r.decision <> 'fail' THEN
        PERFORM property.fail('23514', 'a rejection rests on a recorded failed review of that discipline');
      END IF;
    ELSE
      PERFORM property.need_duty(p_officer, ARRAY['legal', 'legal_head'], 'request the outcome of a hold');
    END IF;
    IF p_code IN ('P6', 'P14') AND jsonb_typeof(v_detail->'curable') IS DISTINCT FROM 'boolean' THEN
      PERFORM property.fail('22023', 'a rejection says whether its reason is curable (OB-16)');
    END IF;
    IF p_code = 'P13' AND ((v_detail->>'evidence') IS NULL OR (v_detail->>'evidence') !~ '^[0-9a-f]{64}$') THEN
      PERFORM property.fail('22023', 'resuming carries the evidence hash that the cause was removed');
    END IF;
  ELSE
    PERFORM property.fail('22023', format('%s is not a maker-checker transition of a %s', p_code, p_entity));
  END IF;
  BEGIN
    INSERT INTO property.requests (entity, entity_id, code, from_state, requested_by, reason, detail, expires_at)
    VALUES (p_entity, p_id, p_code, v_state, p_officer, p_reason, v_detail,
            clock_timestamp() + make_interval(hours => property.setting('request_expiry_hours')::int)) RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    PERFORM property.fail('23505', 'another request is open for this file');
  END;
  PERFORM property.audit_append(p_officer, 'request.created', jsonb_build_object('ref', 'requests:' || v_id, 'entity', p_entity, 'id', p_id,
                                'code', p_code, 'from', v_state, 'reason', p_reason));
  RETURN v_id;
END $$;

CREATE FUNCTION property.decide_request(p_request bigint, p_officer text, p_approve boolean, p_reason text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, property AS $$
DECLARE
  q property.requests;
  v_state text;
  v_status text;
  v_problem text;
  v_group text;
  v_id bigint;
BEGIN
  PERFORM property.check_actor(p_officer);
  PERFORM property.check_reason(p_reason);
  SELECT * INTO q FROM property.requests WHERE id = p_request FOR UPDATE;
  IF NOT FOUND THEN PERFORM property.fail('P0002', 'unknown request'); END IF;
  IF q.status <> 'open' THEN PERFORM property.fail('23514', format('request %s is already %s', q.id, q.status)); END IF;
  IF q.requested_by = p_officer THEN PERFORM property.fail('42501', 'the requester never approves their own request (maker-checker)'); END IF;
  IF q.entity = 'sponsor' THEN
    PERFORM 1 FROM property.sponsors WHERE id = q.entity_id FOR UPDATE;
    v_state := property.sponsor_state(q.entity_id);
  ELSE
    SELECT state INTO v_state FROM property.properties WHERE id = q.entity_id FOR UPDATE;
  END IF;
  IF q.expires_at < now() OR v_state IS DISTINCT FROM q.from_state THEN
    UPDATE property.requests SET status = 'expired', decided_at = date_trunc('microseconds', clock_timestamp()) WHERE id = q.id;
    PERFORM property.audit_append(p_officer, 'request.expired', jsonb_build_object('ref', 'requests:' || q.id || ':expired'));
    RETURN 'expired';
  END IF;
  -- Checker duty per transition.
  IF q.entity = 'sponsor' THEN
    IF q.code = 'K4' AND (SELECT rating FROM property.risk_ratings WHERE sponsor_id = q.entity_id ORDER BY id DESC LIMIT 1) = 'high' THEN
      PERFORM property.need_duty(p_officer, ARRAY['compliance_senior'], 'approve a high-risk sponsor (OB-6)');
    ELSE
      PERFORM property.need_duty(p_officer, ARRAY['compliance', 'compliance_senior'], 'decide a KYB request');
    END IF;
    IF EXISTS (SELECT 1 FROM property.sponsor_events WHERE sponsor_id = q.entity_id AND code IN ('K1', 'K9') AND actor = p_officer) THEN
      PERFORM property.fail('42501', 'whoever submitted a file never decides it (OB-SOD-1)');
    END IF;
  ELSE
    IF q.code = 'P6' THEN
      v_group := property.discipline_group(q.detail->>'discipline');
      PERFORM property.need_duty(p_officer, CASE v_group WHEN 'legal' THEN ARRAY['legal', 'legal_head'] ELSE ARRAY[v_group, 'legal_head'] END,
                                 'confirm a reviewer''s rejection (same discipline or legal head)');
    ELSE
      PERFORM property.need_duty(p_officer, ARRAY['legal_head'], 'decide the outcome of a hold');
    END IF;
    IF p_officer = ANY (property.submitters(q.entity_id)) THEN
      PERFORM property.fail('42501', 'whoever entered or submitted a file never decides it (OB-SOD-1)');
    END IF;
  END IF;
  v_status := CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END;
  UPDATE property.requests SET status = v_status, decided_by = p_officer, decision_reason = p_reason,
         decided_at = date_trunc('microseconds', clock_timestamp()) WHERE id = q.id;
  PERFORM property.audit_append(p_officer, 'request.' || v_status, jsonb_build_object('ref', 'requests:' || q.id || ':decision', 'code', q.code,
                                'requestedBy', q.requested_by, 'reason', p_reason));
  IF NOT p_approve THEN RETURN 'rejected'; END IF;
  IF q.code = 'K4' THEN
    v_problem := property.kyb_problem(q.entity_id, 'K4');
    IF v_problem IS NOT NULL THEN PERFORM property.fail('23514', v_problem); END IF;
    PERFORM property.sponsor_move(q.entity_id, 'K4', p_officer, q.reason, NULL, q.id, q.requested_by);
  ELSIF q.code IN ('K5', 'K10', 'K11') THEN
    PERFORM property.sponsor_move(q.entity_id, q.code, p_officer, q.reason, NULL, q.id, q.requested_by);
  ELSIF q.code = 'SC' THEN
    INSERT INTO property.sponsor_screenings (sponsor_id, provider, list_version, outcome, basis, evidence_sha256, recorded_by)
    SELECT s.sponsor_id, s.provider, s.list_version, 'clear', 'cleared_false_positive', decode(q.detail->>'evidence', 'hex'), p_officer
    FROM property.sponsor_screenings s WHERE s.id = (q.detail->>'screening')::bigint RETURNING id INTO v_id;
    PERFORM property.audit_append(p_officer, 'sponsor.screened', jsonb_build_object('ref', 'sponsor_screenings:' || v_id, 'sponsor', q.entity_id,
                                  'outcome', 'clear', 'basis', 'cleared_false_positive', 'request', q.id));
  ELSIF q.code IN ('P6', 'P14') THEN
    PERFORM property.property_move(q.entity_id, q.code, p_officer, q.reason, NULL, q.id, q.requested_by, (q.detail->>'curable')::boolean);
  ELSIF q.code = 'P13' THEN
    PERFORM property.property_move(q.entity_id, 'P13', p_officer, q.reason, NULL, q.id, q.requested_by, NULL);
  END IF;
  RETURN 'approved';
END $$;

-- ------------------------------------------------------------------ investment committee (P7, OB-33)
CREATE FUNCTION property.open_ic(p_property uuid, p_chair text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, property AS $$
DECLARE
  v_id bigint;
  v_problem text;
BEGIN
  PERFORM property.need_duty(p_chair, ARRAY['ic_member', 'ic_independent'], 'chair the investment committee');
  PERFORM 1 FROM property.properties WHERE id = p_property AND state = 'under_review' FOR UPDATE;
  IF NOT FOUND THEN PERFORM property.fail('23514', 'the committee considers a property under review'); END IF;
  IF p_chair = ANY (property.parties(p_property)) THEN PERFORM property.fail('42501', 'a party to the file cannot chair its committee (OB-SOD-1)'); END IF;
  v_problem := property.p7_problem(p_property);
  IF v_problem IS NOT NULL THEN PERFORM property.fail('23514', 'not ready for the committee: ' || v_problem); END IF;
  BEGIN
    INSERT INTO property.ic_meetings (property_id, chair) VALUES (p_property, p_chair) RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    PERFORM property.fail('23505', 'a committee meeting is already open for this property');
  END;
  PERFORM property.audit_append(p_chair, 'ic.opened', jsonb_build_object('ref', 'ic_meetings:' || v_id, 'property', p_property));
  RETURN v_id;
END $$;

CREATE FUNCTION property.cast_vote(p_meeting bigint, p_member text, p_vote text, p_conflict_note text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, property AS $$
DECLARE
  m property.ic_meetings;
  v_id bigint;
  v_conflict boolean := p_conflict_note IS NOT NULL;
BEGIN
  PERFORM property.need_duty(p_member, ARRAY['ic_member', 'ic_independent'], 'vote in the investment committee');
  SELECT * INTO m FROM property.ic_meetings WHERE id = p_meeting FOR UPDATE;
  IF NOT FOUND OR m.status <> 'open' THEN PERFORM property.fail('23514', 'no open meeting'); END IF;
  IF p_member = ANY (property.parties(m.property_id)) THEN
    PERFORM property.fail('42501', 'a party to the file cannot vote on it (OB-SOD-1); record the conflict instead');
  END IF;
  IF v_conflict THEN PERFORM property.check_reason(p_conflict_note, 'conflict note');
  ELSIF p_vote NOT IN ('approve', 'reject', 'abstain') OR p_vote IS NULL THEN PERFORM property.fail('22023', 'vote approve, reject or abstain');
  END IF;
  BEGIN
    INSERT INTO property.ic_votes (meeting_id, member, independent, conflict, conflict_note, vote)
    VALUES (p_meeting, p_member, property.has_duty(p_member, ARRAY['ic_independent']), v_conflict, p_conflict_note,
            CASE WHEN v_conflict THEN NULL ELSE p_vote END) RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    PERFORM property.fail('23505', 'a member votes once per meeting');
  END;
  PERFORM property.audit_append(p_member, 'ic.voted', jsonb_build_object('ref', 'ic_votes:' || v_id, 'meeting', p_meeting, 'property', m.property_id,
                                'vote', CASE WHEN v_conflict THEN NULL ELSE p_vote END, 'conflict', v_conflict));
  RETURN v_id;
END $$;

/** OB-33 quorum: at least ic_quorum non-conflicted votes including an independent member; majority approve; no independent against. */
CREATE FUNCTION property.ic_outcome(p_meeting bigint) RETURNS TABLE (quorum boolean, approved boolean, voters integer, approvals integer)
LANGUAGE sql STABLE SET search_path = pg_catalog, property AS $$
  SELECT count(*) >= property.setting('ic_quorum') AND bool_or(independent),
         count(*) >= property.setting('ic_quorum') AND coalesce(bool_or(independent), false)
           AND count(*) FILTER (WHERE vote = 'approve') * 2 > count(*)
           AND NOT coalesce(bool_or(independent AND vote = 'reject'), false),
         count(*)::int, count(*) FILTER (WHERE vote = 'approve')::int
  FROM property.ic_votes WHERE meeting_id = p_meeting AND NOT conflict
$$;

CREATE FUNCTION property.close_ic(p_meeting bigint, p_chair text, p_minutes bytea) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, property AS $$
DECLARE
  m property.ic_meetings;
  o record;
  v_problem text;
  v_quals jsonb;
BEGIN
  PERFORM property.check_actor(p_chair);
  PERFORM property.check_sha(p_minutes, 'the minutes');
  SELECT * INTO m FROM property.ic_meetings WHERE id = p_meeting FOR UPDATE;
  IF NOT FOUND OR m.status <> 'open' THEN PERFORM property.fail('23514', 'no open meeting'); END IF;
  IF m.chair <> p_chair THEN PERFORM property.fail('42501', 'only the chair closes the meeting'); END IF;
  PERFORM 1 FROM property.properties WHERE id = m.property_id FOR UPDATE;
  SELECT * INTO o FROM property.ic_outcome(p_meeting);
  IF NOT coalesce(o.quorum, false) THEN
    PERFORM property.fail('23514', format('no quorum: %s non-conflicted vote(s), an independent member must vote (OB-33)', coalesce(o.voters, 0)));
  END IF;
  IF o.approved THEN
    v_problem := property.p7_problem(m.property_id);
    IF v_problem IS NOT NULL THEN PERFORM property.fail('23514', 'cannot approve: ' || v_problem); END IF;
    -- OB-28: the IC accepts the legal opinion's qualifications explicitly by approving.
    SELECT r.conditions INTO v_quals FROM property.reviews r WHERE r.property_id = m.property_id AND r.discipline = 'legal_opinion' ORDER BY r.seq DESC LIMIT 1;
  END IF;
  UPDATE property.ic_meetings SET status = CASE WHEN o.approved THEN 'approved' ELSE 'not_approved' END, minutes_sha256 = p_minutes,
         accepted_qualifications = v_quals, closed_at = date_trunc('microseconds', clock_timestamp()) WHERE id = p_meeting;
  PERFORM property.audit_append(p_chair, 'ic.closed', jsonb_build_object('ref', 'ic_meetings:' || p_meeting || ':close', 'property', m.property_id,
                                'approved', o.approved, 'voters', o.voters, 'approvals', o.approvals, 'minutes', encode(p_minutes, 'hex')));
  IF o.approved THEN
    PERFORM property.property_move(m.property_id, 'P7', p_chair, NULL, NULL, NULL, 'ic:' || p_meeting, NULL);
    RETURN 'legal_approved';
  END IF;
  RETURN 'not_approved';
END $$;

-- ------------------------------------------------------------------ structure and trustee (P8, OB-35..OB-37)
CREATE FUNCTION property.record_structure(p_property uuid, p_actor text, p_kind text, p_shariah boolean, p_rights jsonb,
                                          p_planned_units numeric, p_trust_deed uuid) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, property AS $$
DECLARE
  v_id bigint;
  v_bp integer := property.setting('max_balance_bp')::int;
BEGIN
  PERFORM property.need_duty(p_actor, ARRAY['legal_head'], 'decide the legal structure');
  PERFORM 1 FROM property.properties WHERE id = p_property AND state = 'legal_approved' FOR UPDATE;
  IF NOT FOUND THEN PERFORM property.fail('23514', 'the structure is decided for a Legal Approved property'); END IF;
  IF NOT EXISTS (SELECT 1 FROM property.documents WHERE id = p_trust_deed AND property_id = p_property
                 AND doc_type IN ('trust_deed', 'spv_documents') AND property.is_current(id)) THEN
    PERFORM property.fail('22023', 'the trust deed or SPV documents are a current document of this property');
  END IF;
  IF p_planned_units IS NULL OR p_planned_units <> trunc(p_planned_units) OR p_planned_units <= 0 THEN
    PERFORM property.fail('22023', 'the planned register size is a positive whole number of units (OB-36)');
  END IF;
  BEGIN
    INSERT INTO property.structures (property_id, kind, shariah, unit_rights, planned_units, max_balance_bp, max_holding_units, trust_deed_document_id, decided_by)
    VALUES (p_property, p_kind, p_shariah, p_rights, p_planned_units, v_bp, floor(p_planned_units * v_bp / 10000), p_trust_deed, p_actor) RETURNING id INTO v_id;
  EXCEPTION WHEN check_violation OR not_null_violation THEN
    PERFORM property.fail('22023', 'invalid structure (kind reit or spv; unit rights income, exit, voting, information)');
  END;
  PERFORM property.audit_append(p_actor, 'structure.recorded', jsonb_build_object('ref', 'structures:' || v_id, 'property', p_property, 'kind', p_kind,
                                'shariah', p_shariah, 'plannedUnits', p_planned_units::text, 'trustDeed', p_trust_deed));
  RETURN v_id;
END $$;

CREATE FUNCTION property.trustee_decide(p_property uuid, p_trustee text, p_structure bigint, p_accept boolean, p_conditions text, p_reason text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, property AS $$
DECLARE
  s property.structures;
  v_id bigint;
  v_problem text;
BEGIN
  -- OB-37 / OB-SOD-5: recorded under the trustee officer's own identity.
  PERFORM property.need_duty(p_trustee, ARRAY['trustee'], 'accept a property for the trust');
  PERFORM property.check_reason(p_reason);
  PERFORM 1 FROM property.properties WHERE id = p_property AND state = 'legal_approved' FOR UPDATE;
  IF NOT FOUND THEN PERFORM property.fail('23514', 'the trustee decides on a Legal Approved property'); END IF;
  SELECT * INTO s FROM property.structures WHERE property_id = p_property ORDER BY id DESC LIMIT 1;
  IF NOT FOUND OR s.id <> p_structure THEN PERFORM property.fail('23514', 'the trustee decides on the latest structure decision (OB-35)'); END IF;
  IF p_accept THEN
    IF NOT property.is_current(s.trust_deed_document_id) THEN PERFORM property.fail('23514', 'the trust deed was superseded after the structure decision'); END IF;
    IF s.shariah AND NOT EXISTS (SELECT 1 FROM property.documents WHERE property_id = p_property AND doc_type = 'shariah_certificate' AND property.is_current(id)) THEN
      PERFORM property.fail('23514', 'a Shariah-compliant structure needs the Shariah certificate (OB-35)');
    END IF;
    v_problem := property.p7_problem(p_property);
    IF v_problem IS NOT NULL THEN PERFORM property.fail('23514', 'the file changed since approval: ' || v_problem); END IF;
  END IF;
  INSERT INTO property.trustee_decisions (property_id, structure_id, trustee, decision, conditions, reason)
  VALUES (p_property, s.id, p_trustee, CASE WHEN p_accept THEN 'accept' ELSE 'decline' END, p_conditions, p_reason) RETURNING id INTO v_id;
  PERFORM property.audit_append(p_trustee, 'trustee.decided', jsonb_build_object('ref', 'trustee_decisions:' || v_id, 'property', p_property,
                                'structure', s.id, 'accept', p_accept));
  IF p_accept THEN
    PERFORM property.property_move(p_property, 'P8', p_trustee, p_reason, NULL, NULL, s.decided_by, NULL);
    RETURN 'tokenization_ready';
  END IF;
  RETURN 'legal_approved';
END $$;

-- ================================================================== reads
/** Sponsors for dashboards: no hashes, no sealed values, no compliance detail. */
CREATE VIEW property.sponsor_overview AS
SELECT s.id AS sponsor_id, s.kind, property.sponsor_state(s.id) AS state, s.cuin_last4, s.ntn_last4,
       property.kyb_valid_until(s.id) AS kyb_valid_until, s.created_at
FROM property.sponsors s;

CREATE VIEW property.property_overview AS
SELECT p.id AS property_id, p.sponsor_id, p.previous_id, p.state, p.province, p.district, p.property_key, p.use, p.occupancy, p.built,
       (SELECT max(e.at) FROM property.property_events e WHERE e.property_id = p.id AND e.code = 'P1') AS submitted_at,
       (SELECT e.at FROM property.property_events e WHERE e.property_id = p.id ORDER BY e.id DESC LIMIT 1) AS state_since,
       p.created_at
FROM property.properties p;

CREATE VIEW property.document_list AS
SELECT d.id AS document_id, d.sponsor_id, d.property_id, d.doc_type, t.chain_doc_type, encode(d.sha256, 'hex') AS sha256, d.size_bytes,
       d.media_type, d.supersedes, (SELECT n.id FROM property.documents n WHERE n.supersedes = d.id) AS superseded_by,
       property.is_current(d.id) AS current, d.uploaded_at
FROM property.documents d JOIN property.doc_types t ON t.code = d.doc_type;

/** The lowest accepted valuation: the offering value may not exceed it (S-02 OF-3). */
CREATE FUNCTION property.offering_value_cap(p_property uuid) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, property AS $$
  SELECT CASE WHEN v.ok THEN v.lowest_paisa END FROM property.valuation_status(p_property) v
$$;

-- ================================================================== audit verification (PR-8)
CREATE FUNCTION property.verify_audit() RETURNS TABLE (audit_id bigint, problem text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, property AS $$
DECLARE
  a property.audit;
  v_prev bytea := decode(repeat('00', 32), 'hex');
  r record;
  t text;
BEGIN
  FOR a IN SELECT * FROM property.audit ORDER BY id LOOP
    IF a.prev_hash <> v_prev THEN audit_id := a.id; problem := 'prev_hash does not match'; RETURN NEXT; END IF;
    IF a.hash <> property.audit_digest(a.prev_hash, a.id, a.at, a.actor, a.action, a.detail) THEN
      audit_id := a.id; problem := 'content does not match its hash'; RETURN NEXT;
    END IF;
    v_prev := a.hash;
  END LOOP;
  -- Content of the records the audit entries describe.
  FOR r IN
    SELECT y.id AS aid, format('sponsor event %s changed after it was written', x.id) AS p
      FROM property.audit y JOIN property.sponsor_events x ON y.detail->>'ref' = 'sponsor_events:' || x.id
      WHERE (y.actor, y.detail->>'code', y.detail->>'from', y.detail->>'to', y.detail->>'sponsor', y.detail->>'validUntil')
            IS DISTINCT FROM (x.actor, x.code, x.from_state, x.to_state, x.sponsor_id::text, property.utc(x.valid_until))
    UNION ALL
    SELECT y.id, format('property event %s changed after it was written', x.id)
      FROM property.audit y JOIN property.property_events x ON y.detail->>'ref' = 'property_events:' || x.id
      WHERE (y.actor, y.detail->>'code', y.detail->>'from', y.detail->>'to', y.detail->>'property', (y.detail->>'curable')::boolean)
            IS DISTINCT FROM (x.actor, x.code, x.from_state, x.to_state, x.property_id::text, x.curable)
    UNION ALL
    SELECT y.id, format('document %s changed after it was recorded', x.id)
      FROM property.audit y JOIN property.documents x ON y.detail->>'ref' = 'documents:' || x.id
      WHERE (y.detail->>'sha256', y.detail->>'type', y.detail->>'property', (y.detail->>'size')::bigint, y.detail->>'supersedes')
            IS DISTINCT FROM (encode(x.sha256, 'hex'), x.doc_type, x.property_id::text, x.size_bytes, x.supersedes::text)
    UNION ALL
    SELECT y.id, format('review %s or the hashes it relied on changed', x.id)
      FROM property.audit y JOIN property.reviews x ON y.detail->>'ref' = 'reviews:' || x.id
      WHERE (y.detail->>'decision', y.detail->>'discipline', y.detail->'docs')
            IS DISTINCT FROM (x.decision, x.discipline, (SELECT jsonb_agg(jsonb_build_array(rd.document_id, encode(rd.sha256, 'hex')) ORDER BY rd.document_id)
                                                        FROM property.review_documents rd WHERE rd.review_id = x.id))
    UNION ALL
    SELECT y.id, format('valuation %s changed after it was recorded', x.id)
      FROM property.audit y JOIN property.valuations x ON y.detail->>'ref' = 'valuations:' || x.id
      WHERE (y.detail->>'valuePaisa', (y.detail->>'valuer')::bigint, y.detail->>'report') IS DISTINCT FROM (x.value_paisa::text, x.valuer_id, x.report_document_id::text)
    UNION ALL
    SELECT y.id, format('vote %s changed after it was cast', x.id)
      FROM property.audit y JOIN property.ic_votes x ON y.detail->>'ref' = 'ic_votes:' || x.id
      WHERE (y.actor, y.detail->>'vote', (y.detail->>'conflict')::boolean) IS DISTINCT FROM (x.member, x.vote, x.conflict)
  LOOP
    audit_id := r.aid; problem := r.p; RETURN NEXT;
  END LOOP;
  -- States must equal the replay of their event logs.
  FOR r IN
    SELECT 'sponsor ' || s.id AS what FROM property.sponsors s
      WHERE s.state IS DISTINCT FROM coalesce((SELECT e.to_state FROM property.sponsor_events e WHERE e.sponsor_id = s.id ORDER BY e.id DESC LIMIT 1), 'kyb_draft')
         OR EXISTS (SELECT 1 FROM (SELECT e.from_state, lag(e.to_state) OVER (ORDER BY e.id) AS prev FROM property.sponsor_events e WHERE e.sponsor_id = s.id) z
                    WHERE z.from_state IS DISTINCT FROM coalesce(z.prev, 'kyb_draft'))
    UNION ALL
    SELECT 'property ' || p.id FROM property.properties p
      WHERE p.state IS DISTINCT FROM coalesce((SELECT e.to_state FROM property.property_events e WHERE e.property_id = p.id ORDER BY e.id DESC LIMIT 1), 'draft')
         OR EXISTS (SELECT 1 FROM (SELECT e.from_state, lag(e.to_state) OVER (ORDER BY e.id) AS prev FROM property.property_events e WHERE e.property_id = p.id) z
                    WHERE z.from_state IS DISTINCT FROM coalesce(z.prev, 'draft'))
  LOOP
    audit_id := NULL; problem := format('%s: state does not match its event log', r.what); RETURN NEXT;
  END LOOP;
  -- Rows without the audit entry their API function always writes: written around the API.
  FOREACH t IN ARRAY ARRAY['sponsors', 'sponsor_persons', 'registration_checks', 'sponsor_screenings', 'risk_ratings', 'fmu_assessments',
                           'sponsor_events', 'properties', 'property_events', 'documents', 'document_verifications', 'duplicate_checks',
                           'duplicate_decisions', 'requests', 'assignments', 'reviews', 'reopenings', 'title_links', 'encumbrances',
                           'encumbrance_resolutions', 'valuers', 'valuations', 'ic_meetings', 'ic_votes', 'structures', 'trustee_decisions',
                           'staff_duties'] LOOP
    FOR r IN EXECUTE format('SELECT x.id::text AS id FROM property.%I x WHERE NOT EXISTS (SELECT 1 FROM property.audit y WHERE y.detail->>''ref'' = %L || x.id::text)', t, t || ':') LOOP
      audit_id := NULL; problem := format('%s %s has no audit entry', t, r.id); RETURN NEXT;
    END LOOP;
  END LOOP;
  FOR r IN
    SELECT 'request ' || x.id AS what FROM property.requests x WHERE x.status IN ('approved', 'rejected')
      AND NOT EXISTS (SELECT 1 FROM property.audit y WHERE y.detail->>'ref' = 'requests:' || x.id || ':decision' AND y.action = 'request.' || x.status)
    UNION ALL
    SELECT 'duty ' || x.id FROM property.staff_duties x WHERE x.status <> 'pending'
      AND NOT EXISTS (SELECT 1 FROM property.audit y WHERE y.detail->>'ref' = 'staff_duties:' || x.id || ':decision')
    UNION ALL
    SELECT 'duty revocation ' || x.id FROM property.staff_duties x WHERE x.status = 'revoked'
      AND NOT EXISTS (SELECT 1 FROM property.audit y WHERE y.detail->>'ref' = 'staff_duties:' || x.id || ':revoked')
    UNION ALL
    SELECT 'meeting close ' || x.id FROM property.ic_meetings x WHERE x.status <> 'open'
      AND NOT EXISTS (SELECT 1 FROM property.audit y WHERE y.detail->>'ref' = 'ic_meetings:' || x.id || ':close')
    UNION ALL
    SELECT 'person end ' || x.id FROM property.sponsor_persons x WHERE x.ended_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM property.audit y WHERE y.detail->>'ref' = 'sponsor_persons:' || x.id || ':end')
    UNION ALL
    SELECT 'valuer approval ' || x.id FROM property.valuers x WHERE x.approved_by IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM property.audit y WHERE y.detail->>'ref' = 'valuers:' || x.id || ':approval')
  LOOP
    audit_id := NULL; problem := format('%s has no audit entry', r.what); RETURN NEXT;
  END LOOP;
END $$;

-- ================================================================== grants (PR-9)
REVOKE ALL ON ALL TABLES IN SCHEMA property FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA property FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA property FROM PUBLIC;

GRANT USAGE ON SCHEMA property TO pt_property_writer, pt_property_reviewer, pt_property_admin, pt_property_reader;

-- Intake on the sponsor's behalf (S-01 Q-1: operations enter the pilot files).
GRANT EXECUTE ON FUNCTION
  property.create_sponsor(uuid, text, uuid, bytea, bytea, bytea[], text[], smallint[], text, text, text),
  property.find_sponsor(bytea[]),
  property.add_sponsor_person(uuid, uuid, text, integer, text, smallint, text[], text),
  property.submit_kyb(uuid, text, bigint),
  property.create_property(uuid, text, bigint, uuid, jsonb),
  property.update_property(uuid, text, bigint, jsonb),
  property.submit_property(uuid, text, bigint),
  property.withdraw_property(uuid, text, bigint, text)
  TO pt_property_writer;

-- Officers' decisions and due diligence.
GRANT EXECUTE ON FUNCTION
  property.end_sponsor_person(bigint, text, text),
  property.record_registration_check(uuid, text, text, bytea, text),
  property.record_screening(uuid, text, text, text, bytea, text),
  property.record_risk(uuid, text, text, bytea, text),
  property.record_fmu(uuid, text, bytea, text),
  property.screen_kyb(uuid, text, boolean, text),
  property.query_kyb(uuid, text, text),
  property.suspend_sponsor(uuid, text, text),
  property.decide_duplicate(bigint, text, text, text, text),
  property.return_property(uuid, text, text),
  property.start_review(uuid, text, text, text, text),
  property.reassign_reviewer(uuid, text, text, text),
  property.query_property(uuid, text, text),
  property.hold_property(uuid, text, text),
  property.reopen(uuid, text, text[], text),
  property.verify_document(uuid, text, text, text, date, text, bytea),
  property.add_title_link(uuid, text, smallint, text, text, date, uuid),
  property.record_encumbrance(uuid, text, text, text, bytea),
  property.resolve_encumbrance(bigint, text, text, text, bytea),
  property.record_valuation(uuid, text, bigint, bigint, date, uuid, bytea),
  property.record_review(uuid, text, text, text, text, text, jsonb, text, uuid[]),
  property.request_transition(text, uuid, text, text, text, jsonb),
  property.decide_request(bigint, text, boolean, text),
  property.open_ic(uuid, text),
  property.cast_vote(bigint, text, text, text),
  property.close_ic(bigint, text, bytea),
  property.record_structure(uuid, text, text, boolean, jsonb, numeric, uuid),
  property.trustee_decide(uuid, text, bigint, boolean, text, text)
  TO pt_property_reviewer;

GRANT EXECUTE ON FUNCTION property.add_document(uuid, uuid, text, bytea, bigint, text, text, text, bigint, uuid),
                          property.sealed_sponsor(uuid), property.find_duplicates(uuid), property.expire_sponsors(text),
                          property.missing_documents(uuid, uuid)
  TO pt_property_writer, pt_property_reviewer;
GRANT EXECUTE ON FUNCTION property.candidate_status(bigint), property.p7_problem(uuid) TO pt_property_reviewer;

GRANT EXECUTE ON FUNCTION
  property.request_duty(text, text, text, text),
  property.decide_duty(bigint, text, boolean, text),
  property.revoke_duty(bigint, text, text),
  property.add_valuer(text, text, uuid, text),
  property.approve_valuer(bigint, text)
  TO pt_property_admin;

GRANT EXECUTE ON FUNCTION property.sponsor_state(uuid), property.kyb_valid_until(uuid), property.review_status(uuid),
                          property.valuation_status(uuid), property.offering_value_cap(uuid), property.verify_audit(),
                          property.norm(text), property.has_duty(text, text[]), property.is_current(uuid)
  TO pt_property_writer, pt_property_reviewer, pt_property_admin, pt_property_reader;

GRANT SELECT ON property.sponsor_overview, property.property_overview, property.document_list, property.settings, property.doc_types,
                property.mandatory_documents, property.transitions
  TO pt_property_writer, pt_property_reviewer, pt_property_admin, pt_property_reader;
-- Officers see the working records; the reader and the writer never see reviews, screenings or FMU assessments.
GRANT SELECT ON ALL TABLES IN SCHEMA property TO pt_property_reviewer;
-- Sealed values and keyed hashes stay behind property.sealed_sponsor / property.find_sponsor.
REVOKE SELECT ON property.sponsors, property.sponsor_identifiers FROM pt_property_reviewer;
GRANT SELECT ON property.staff_duties, property.valuers TO pt_property_admin;
-- KYC status for the derived KYB state is read through SECURITY DEFINER functions owned by the migration owner.

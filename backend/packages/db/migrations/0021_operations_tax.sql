-- Spec S-03 (tasks T-023, T-024): property operations, net distributable, FBR withholding tax,
-- tax certificates, the sealed CNIC for tax filing (ADR 0014, Proposed) and the operations / tax
-- screens of the admin portal.
--
-- Applies on top of 0020 (S-06 recovery): role tax_officer is incompatible with 0020's legal_officer
-- as with every other role but ops_checker; the role-matrix digest is fixed again after both.
--
-- Safety properties enforced by the database itself (schemas ops and tax, plus admin.* wrappers):
--   OT-1  Rent collections come from imported bank statement lines (recon.bank_lines) only: a line is
--         used once, must be a credit on a registered account, and is either a credit the bank
--         service already matched to this token's rent pool (no new journal), a suspense credit
--         re-attributed to the pool (bank:suspense -> pool, OP-12), or a line nothing has booked
--         yet (bank -> pool). Maker-checker; the journal is posted on approval, keyed
--         rent:collected:<token>:<period>-c<id> with the bank reference, so the cash check still
--         matches the bank line. The period is the month of the line's value date (OP-17).
--   OT-2  Expenses, fees and reserve movements ("charges") carry a SHA-256 of their evidence
--         (vendor invoice, fee calculation, reserve rule), are maker-checker, and post their ledger
--         journal only on approval (S-03 §7 keys). Expenses and fees above the operations limit
--         are refused: they need the trustee (OP-21, trustee portal 6d).
--   OT-3  The operating statement per (token, period) is computed here from approved records only:
--         net operating cash = collected - expenses - fees (OP-30); distributable gross = net
--         operating cash - reserve contribution + reserve release (OP-31), never below zero.
--   OT-4  A distribution calculation reads the read model at the record block (chain.transfers),
--         splits the distributable gross by the largest remainder in paisa (ties by wallet
--         ascending, OP-35) and applies withholding per line: WHT = floor((gross x rate_ppm +
--         500,000) / 1,000,000), i.e. round half up to the paisa; net = gross - WHT (OP-36). All
--         integer / numeric arithmetic, never floating point. CHECKs hold gross = net + WHT and the
--         rounding rule on every line, and sum(gross) = distributable gross on the calculation.
--         The period is locked while a calculation is live (no new collections or charges).
--   OT-5  The Merkle leaf carries NET (S-03 OP-37, adopted default): leaf format unchanged
--         (wallet, amountPaisa), so /verify, chain/rent.py and the DistributionRegistry stay as
--         they are. The statement (pt-rent-statement-v2) and the private tax schedule
--         (pt-tax-schedule-v1) are attached by the operations service and checked here line by
--         line against the calculation; the statement carries the tax schedule's hash.
--   OT-6  Approval is maker-checker (checker <> calculator <> attacher) and refuses placeholder tax
--         rates unless ops.settings allows them (local development only). Booking needs the
--         finalized on-chain distribution with the same root, total (= sum of net) and statement
--         hash, and posts rent:wht:<token>:<id> (pool -> tax:wht-payable:<token>) and
--         rent:distribution:<token>:<id> (pool -> payables) in one transaction.
--   OT-7  Tax rates are versioned, dated configuration (tax.rates), never code. The seed rows are
--         PLACEHOLDERS (LEGAL/TAX TO CONFIRM). A change is proposed and approved by two different
--         tax officers, takes effect on a future date only, and never changes a past calculation
--         (each line keeps its rate id and rate).
--   OT-8  Filer status (Active Taxpayers List) is a dated check per investor; at a record date the
--         latest result not older than 30 days counts, else the non-filer rate applies and the
--         line is flagged (OP-41). The CNIC needed for the check is sealed under the tax key
--         (ADR 0014), bound to the subject's peppered CNIC hash; only the tax service receives
--         the ciphertext, and every release is audited.
--   OT-9  FBR filing exports (the only human-triggered unseal, ADR 0014): requested by one tax
--         officer, approved by a different one (both with a fresh security-key step-up), valid
--         24 hours, generated once through a one-time ticket (2 minutes) by the tax service, which
--         records the file's SHA-256 before releasing it. No partial export: every line in scope
--         needs a sealed CNIC.
--   OT-10 Remittances to FBR are maker-checker, carry the CPR number, never exceed what was
--         withheld for the period, and post tax:remit:<token>:<cpr>. tax.reconcile() checks per
--         token and period that withheld - remitted equals the FBR payable account, and every
--         line's arithmetic.
--   OT-11 Every row is written by a function that also appends to the hash-chained ops.audit;
--         decided rows never change; officer handles are bound to officer sessions (as 0016/0019).

CREATE SCHEMA IF NOT EXISTS ops;
CREATE SCHEMA IF NOT EXISTS tax;
REVOKE ALL ON SCHEMA ops FROM PUBLIC;
REVOKE ALL ON SCHEMA tax FROM PUBLIC;

DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['pt_ops_operator', 'pt_ops_reader', 'pt_tax_service'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN', r);
    END IF;
  END LOOP;
END $$;

-- ================================================================== helpers
CREATE FUNCTION ops.forbid_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'operations and tax records are append-only: % on %.% is not allowed', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END $$;

/**
 * Trigger for rows with a state: never deleted; only the transitions listed in TG_ARGV[0]
 * ("a>b,c>d"); only the columns named in TG_ARGV[1..] may change, and only together with the state.
 */
CREATE FUNCTION ops.guard_row() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_mut text[] := ARRAY['status'];
  v_old jsonb := to_jsonb(OLD);
  v_new jsonb;
  i integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '%.% rows are never deleted', TG_TABLE_SCHEMA, TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
  END IF;
  v_new := to_jsonb(NEW);
  FOR i IN 1 .. TG_NARGS - 1 LOOP
    v_mut := v_mut || TG_ARGV[i];
  END LOOP;
  IF (v_new - v_mut) IS DISTINCT FROM (v_old - v_mut) THEN
    RAISE EXCEPTION '%.% %: only the state and its decision fields ever change', TG_TABLE_SCHEMA, TG_TABLE_NAME, v_old->>'id'
      USING ERRCODE = 'check_violation';
  END IF;
  IF (v_new->>'status') = (v_old->>'status') THEN
    IF v_new IS DISTINCT FROM v_old THEN
      RAISE EXCEPTION '%.% %: decision fields change only with the state', TG_TABLE_SCHEMA, TG_TABLE_NAME, v_old->>'id'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF position(',' || (v_old->>'status') || '>' || (v_new->>'status') || ',' IN ',' || TG_ARGV[0] || ',') = 0 THEN
    RAISE EXCEPTION '%.% %: % -> % is not a transition of its state machine', TG_TABLE_SCHEMA, TG_TABLE_NAME, v_old->>'id',
      v_old->>'status', v_new->>'status' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION ops.utc(p timestamptz) RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT to_char(p AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
$$;

CREATE FUNCTION ops.is_address(p text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT p IS NOT NULL AND length(p) = 42 AND p ~ '^0x[0-9a-f]+$'
$$;

CREATE FUNCTION ops.is_period(p text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT p IS NOT NULL AND p ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
$$;

/** Today in Pakistan (PKT, UTC+5): rate effective dates and record dates are PKT dates. */
CREATE FUNCTION ops.pkt_today() RETURNS date
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT (clock_timestamp() AT TIME ZONE 'Asia/Karachi')::date
$$;

/** A valid actor name; an officer's handle only inside the portal (bound to their checked session, OT-11). */
CREATE FUNCTION ops.check_actor(p_actor text) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, ops AS $$
BEGIN
  IF p_actor IS NULL OR length(p_actor) NOT BETWEEN 2 AND 100 THEN
    RAISE EXCEPTION 'an actor name of 2 to 100 characters is required' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM admin.guard_officer_name(p_actor, 'operations or tax actor');
END $$;

CREATE FUNCTION ops.check_reason(p text, p_min integer, p_max integer) RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
BEGIN
  IF NOT compliance.free_text_ok(p, p_min, p_max) THEN
    RAISE EXCEPTION 'a text of % to % characters is required (never a CNIC, IBAN or phone number)', p_min, p_max USING ERRCODE = 'check_violation';
  END IF;
END $$;

-- ================================================================== audit (OT-11)
CREATE TABLE ops.audit (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at        timestamptz NOT NULL,
  actor     text NOT NULL CHECK (length(actor) BETWEEN 1 AND 100),
  action    text NOT NULL CHECK (action ~ '^[a-z][a-z_.]{2,63}$'),
  detail    jsonb NOT NULL CHECK (jsonb_typeof(detail) = 'object' AND octet_length(detail::text) <= 8192),
  prev_hash bytea NOT NULL CHECK (length(prev_hash) = 32),
  hash      bytea NOT NULL UNIQUE CHECK (length(hash) = 32)
);
CREATE INDEX audit_action_idx ON ops.audit (action, id);

CREATE FUNCTION ops.audit_digest(p_prev bytea, p_id bigint, p_at timestamptz, p_actor text, p_action text, p_detail jsonb)
RETURNS bytea LANGUAGE sql STABLE SET search_path = pg_catalog, ops AS $$
  SELECT sha256(p_prev || convert_to('pt-ops-audit-v1' || jsonb_build_array(p_id, ops.utc(p_at), p_actor, p_action, p_detail)::text, 'UTF8'))
$$;

CREATE FUNCTION ops.audit_append(p_actor text, p_action text, p_detail jsonb)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, ops AS $$
DECLARE
  v_prev bytea;
  v_id bigint;
  v_at timestamptz := date_trunc('microseconds', clock_timestamp());
BEGIN
  PERFORM pg_advisory_xact_lock(586586210);
  SELECT hash INTO v_prev FROM ops.audit ORDER BY id DESC LIMIT 1;
  v_prev := coalesce(v_prev, decode(repeat('00', 32), 'hex'));
  v_id := nextval(pg_get_serial_sequence('ops.audit', 'id'));
  INSERT INTO ops.audit (id, at, actor, action, detail, prev_hash, hash)
  OVERRIDING SYSTEM VALUE
  VALUES (v_id, v_at, left(p_actor, 100), p_action, coalesce(p_detail, '{}'::jsonb), v_prev,
          ops.audit_digest(v_prev, v_id, v_at, left(p_actor, 100), p_action, coalesce(p_detail, '{}'::jsonb)));
  RETURN v_id;
END $$;

-- ================================================================== settings
CREATE TABLE ops.settings (
  key   text PRIMARY KEY CHECK (key ~ '^[a-z][a-z_]{2,63}$'),
  value jsonb NOT NULL,
  note  text NOT NULL CHECK (length(note) BETWEEN 10 AND 300)
);
INSERT INTO ops.settings (key, value, note) VALUES
  ('allow_placeholder_rates', 'false', 'Local development only: lets a calculation that uses placeholder tax rates be approved. Never true in production.'),
  ('filer_check_max_age_days', '30', 'OP-41: an ATL result older than this does not count at a record date (then the non-filer rate applies).'),
  ('expense_ops_limit_paisa', '100000000', 'OP-21 / Q-5 placeholder: an expense or fee above Rs 1,000,000 needs the trustee (trustee portal 6d). Owner to confirm.'),
  ('export_valid_hours', '24', 'OT-9: an export request must be decided, and an approved export generated, within this many hours.'),
  ('export_ticket_seconds', '120', 'OT-9: lifetime of the one-time ticket the portal hands to the tax service.'),
  ('wht_due_days', '15', 'OP-45 placeholder (LEGAL/TAX TO CONFIRM): withholding is due to FBR this many days after the distribution is booked.');

CREATE FUNCTION ops.setting(p_key text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, ops AS $$
  SELECT value FROM ops.settings WHERE key = p_key
$$;

CREATE FUNCTION ops.setting_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, ops AS $$
BEGIN
  IF TG_OP <> 'UPDATE' OR NEW.key <> OLD.key THEN
    RAISE EXCEPTION 'settings are only ever updated in place' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM ops.audit_append('db:' || session_user, 'setting.changed', jsonb_build_object('key', NEW.key, 'from', OLD.value, 'to', NEW.value));
  RETURN NEW;
END $$;
CREATE TRIGGER settings_audited BEFORE UPDATE OR DELETE ON ops.settings FOR EACH ROW EXECUTE FUNCTION ops.setting_changed();

-- ================================================================== tax configuration (OT-7)
CREATE TABLE tax.income_types (
  code  text PRIMARY KEY CHECK (code ~ '^[a-z][a-z_]{2,31}$'),
  label text NOT NULL CHECK (length(label) BETWEEN 5 AND 120),
  note  text NOT NULL CHECK (length(note) BETWEEN 10 AND 300)
);
INSERT INTO tax.income_types (code, label, note) VALUES
  ('reit_dividend', 'Dividend from a REIT scheme', 'LEGAL/TAX TO CONFIRM: section and rates for unit distributions of a REIT scheme (Income Tax Ordinance 2001, s.150 / First Schedule).'),
  ('spv_dividend', 'Dividend from an SPV company', 'LEGAL/TAX TO CONFIRM: section and rates for dividends of the property SPV.'),
  ('rent', 'Rent passed through to holders', 'LEGAL/TAX TO CONFIRM: s.155 is slab-based; no flat rate is seeded, so a calculation for this type is refused until confirmed rates exist.');

CREATE TABLE tax.rates (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  income_type     text NOT NULL REFERENCES tax.income_types (code),
  status          text NOT NULL CHECK (status IN ('filer', 'non_filer', 'exempt')),
  -- Parts per million of the gross: 150000 = 15 %. Below 100 %.
  rate_ppm        integer NOT NULL CHECK (rate_ppm BETWEEN 0 AND 999999),
  -- First PKT date the rate applies to (by record date).
  effective_from  date NOT NULL,
  version         integer NOT NULL CHECK (version >= 1),
  basis           text NOT NULL CHECK (length(basis) BETWEEN 10 AND 300),
  placeholder     boolean NOT NULL,
  state           text NOT NULL CHECK (state IN ('proposed', 'active', 'rejected')),
  proposed_by     text NOT NULL CHECK (length(proposed_by) BETWEEN 2 AND 100),
  proposed_at     timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  decided_by      text CHECK (length(decided_by) BETWEEN 2 AND 100),
  decision_reason text CHECK (length(decision_reason) BETWEEN 10 AND 500),
  decided_at      timestamptz,
  UNIQUE (income_type, status, version),
  CHECK ((state = 'proposed') = (decided_by IS NULL AND decided_at IS NULL AND decision_reason IS NULL)),
  -- OT-7 maker-checker, also against a direct UPDATE.
  CHECK (decided_by IS NULL OR decided_by <> proposed_by)
);
CREATE UNIQUE INDEX rates_one_open ON tax.rates (income_type, status) WHERE state = 'proposed';

CREATE FUNCTION tax.guard_rate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'tax rates are never deleted' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF OLD.state <> 'proposed' THEN RAISE EXCEPTION 'tax rate % is decided (%) and never changes', OLD.id, OLD.state USING ERRCODE = 'check_violation'; END IF;
  IF (NEW.id, NEW.income_type, NEW.status, NEW.rate_ppm, NEW.effective_from, NEW.version, NEW.basis, NEW.placeholder, NEW.proposed_by, NEW.proposed_at)
     IS DISTINCT FROM (OLD.id, OLD.income_type, OLD.status, OLD.rate_ppm, OLD.effective_from, OLD.version, OLD.basis, OLD.placeholder, OLD.proposed_by, OLD.proposed_at) THEN
    RAISE EXCEPTION 'tax rate %: only the decision is recorded', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rates_guard BEFORE UPDATE OR DELETE ON tax.rates FOR EACH ROW EXECUTE FUNCTION tax.guard_rate();

-- PLACEHOLDER rates, LEGAL/TAX TO CONFIRM. Illustrative only (the S-03 §5 worked example); not tax
-- advice. Approval of a distribution that uses any of them is refused unless
-- ops.settings.allow_placeholder_rates is true (local development).
INSERT INTO tax.rates (income_type, status, rate_ppm, effective_from, version, basis, placeholder, state, proposed_by, decided_by, decision_reason, decided_at) VALUES
  ('reit_dividend', 'filer',     150000, DATE '2025-07-01', 1, 'PLACEHOLDER - LEGAL/TAX TO CONFIRM: REIT dividend, filer on the ATL (S-03 example 15 %)', true, 'active', 'migration:0021', 'migration:0021:seed', 'placeholder seed, must be replaced by confirmed rates', clock_timestamp()),
  ('reit_dividend', 'non_filer', 300000, DATE '2025-07-01', 1, 'PLACEHOLDER - LEGAL/TAX TO CONFIRM: REIT dividend, not on the ATL (S-03 example 30 %)', true, 'active', 'migration:0021', 'migration:0021:seed', 'placeholder seed, must be replaced by confirmed rates', clock_timestamp()),
  ('reit_dividend', 'exempt',         0, DATE '2025-07-01', 1, 'PLACEHOLDER - LEGAL/TAX TO CONFIRM: exemption certificate holder (no exemption path is built yet)', true, 'active', 'migration:0021', 'migration:0021:seed', 'placeholder seed, must be replaced by confirmed rates', clock_timestamp()),
  ('spv_dividend',  'filer',     150000, DATE '2025-07-01', 1, 'PLACEHOLDER - LEGAL/TAX TO CONFIRM: SPV dividend, filer on the ATL', true, 'active', 'migration:0021', 'migration:0021:seed', 'placeholder seed, must be replaced by confirmed rates', clock_timestamp()),
  ('spv_dividend',  'non_filer', 300000, DATE '2025-07-01', 1, 'PLACEHOLDER - LEGAL/TAX TO CONFIRM: SPV dividend, not on the ATL', true, 'active', 'migration:0021', 'migration:0021:seed', 'placeholder seed, must be replaced by confirmed rates', clock_timestamp()),
  ('spv_dividend',  'exempt',         0, DATE '2025-07-01', 1, 'PLACEHOLDER - LEGAL/TAX TO CONFIRM: exemption certificate holder (no exemption path is built yet)', true, 'active', 'migration:0021', 'migration:0021:seed', 'placeholder seed, must be replaced by confirmed rates', clock_timestamp());

/** The rate in force for a record date: the latest effective date on or before it, then the highest version. */
CREATE FUNCTION tax.rate_for(p_income_type text, p_status text, p_on date)
RETURNS TABLE (id bigint, rate_ppm integer, placeholder boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, tax AS $$
  SELECT r.id, r.rate_ppm, r.placeholder FROM tax.rates r
  WHERE r.income_type = p_income_type AND r.status = p_status AND r.state = 'active' AND r.effective_from <= p_on
  ORDER BY r.effective_from DESC, r.version DESC LIMIT 1
$$;

/** OT-4 rounding rule: round half up to the paisa. Integer / numeric only. */
CREATE FUNCTION tax.withholding(p_gross bigint, p_rate_ppm integer) RETURNS bigint
LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog AS $$
  SELECT floor((p_gross::numeric * p_rate_ppm + 500000) / 1000000)::bigint
$$;

CREATE FUNCTION tax.rate_digest(p_id bigint) RETURNS bytea
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, tax AS $$
  SELECT sha256(convert_to('pt-tax-rate-v1' || jsonb_build_array(r.id, r.income_type, r.status, r.rate_ppm, r.effective_from, r.version,
           r.basis, r.placeholder, r.state, r.proposed_by)::text, 'UTF8'))
  FROM tax.rates r WHERE r.id = p_id
$$;

CREATE FUNCTION tax.propose_rate(p_income_type text, p_status text, p_rate_ppm integer, p_effective_from date, p_basis text, p_actor text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, tax AS $$
DECLARE
  v_id bigint;
  v_version integer;
BEGIN
  PERFORM ops.check_actor(p_actor);
  PERFORM ops.check_reason(p_basis, 10, 300);
  IF NOT EXISTS (SELECT 1 FROM tax.income_types WHERE code = p_income_type) THEN
    RAISE EXCEPTION 'unknown income type' USING ERRCODE = 'check_violation';
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('filer', 'non_filer', 'exempt') THEN
    RAISE EXCEPTION 'status must be filer, non_filer or exempt' USING ERRCODE = 'check_violation';
  END IF;
  IF p_rate_ppm IS NULL OR p_rate_ppm NOT BETWEEN 0 AND 999999 THEN
    RAISE EXCEPTION 'the rate must be 0 to 999,999 parts per million (below 100 %%)' USING ERRCODE = 'check_violation';
  END IF;
  IF p_effective_from IS NULL OR p_effective_from < ops.pkt_today() THEN
    RAISE EXCEPTION 'a rate takes effect today or later (no retroactive change: correct a past period with an adjustment)' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(586586211);
  SELECT coalesce(max(version), 0) + 1 INTO v_version FROM tax.rates WHERE income_type = p_income_type AND status = p_status;
  INSERT INTO tax.rates (income_type, status, rate_ppm, effective_from, version, basis, placeholder, state, proposed_by)
  VALUES (p_income_type, p_status, p_rate_ppm, p_effective_from, v_version, btrim(p_basis), false, 'proposed', p_actor)
  RETURNING id INTO v_id;
  PERFORM ops.audit_append(p_actor, 'rate.proposed', jsonb_build_object('rate', v_id, 'incomeType', p_income_type, 'status', p_status,
    'ratePpm', p_rate_ppm, 'effectiveFrom', p_effective_from, 'version', v_version));
  RETURN v_id;
END $$;

CREATE FUNCTION tax.decide_rate(p_id bigint, p_actor text, p_decision text, p_reason text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, tax AS $$
DECLARE
  r tax.rates;
  v_to text;
BEGIN
  PERFORM ops.check_actor(p_actor);
  PERFORM ops.check_reason(p_reason, 10, 500);
  IF p_decision IS NULL OR p_decision NOT IN ('approve', 'reject') THEN
    RAISE EXCEPTION 'decision must be approve or reject' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO r FROM tax.rates WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown tax rate' USING ERRCODE = 'no_data_found'; END IF;
  IF r.state <> 'proposed' THEN RAISE EXCEPTION 'the rate is already %', r.state USING ERRCODE = 'check_violation'; END IF;
  IF r.proposed_by = p_actor THEN
    RAISE EXCEPTION 'maker-checker: the officer who proposed a rate cannot decide it' USING ERRCODE = 'check_violation';
  END IF;
  IF p_decision = 'approve' AND r.effective_from < ops.pkt_today() THEN
    RAISE EXCEPTION 'the proposed effective date has passed: propose it again with a future date' USING ERRCODE = 'check_violation';
  END IF;
  v_to := CASE p_decision WHEN 'approve' THEN 'active' ELSE 'rejected' END;
  UPDATE tax.rates SET state = v_to, decided_by = p_actor, decision_reason = btrim(p_reason), decided_at = clock_timestamp() WHERE id = p_id;
  PERFORM ops.audit_append(p_actor, 'rate.decided', jsonb_build_object('rate', p_id, 'decision', p_decision, 'state', v_to, 'proposedBy', r.proposed_by));
  RETURN v_to;
END $$;

-- ================================================================== sealed CNIC and filer status (OT-8, ADR 0014)
CREATE TABLE tax.sealed_cnics (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subject_id     uuid NOT NULL REFERENCES kyc.subjects (id),
  -- Version of TAX_CNIC_KEY_V<n> (outside the database) that sealed it.
  key_version    smallint NOT NULL CHECK (key_version BETWEEN 1 AND 999),
  -- AES-256-GCM: version | IV | ciphertext | tag; associated data binds subject, hash and pepper version.
  sealed         bytea NOT NULL CHECK (length(sealed) BETWEEN 30 AND 200),
  -- The subject's own peppered CNIC hash (kyc.cnic_hashes) the CNIC was checked against before sealing.
  cnic_hash      bytea NOT NULL CHECK (length(cnic_hash) = 32),
  pepper_version smallint NOT NULL CHECK (pepper_version BETWEEN 1 AND 999),
  enrolled_by    text NOT NULL CHECK (length(enrolled_by) BETWEEN 2 AND 100),
  enrolled_at    timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  UNIQUE (subject_id, key_version),
  FOREIGN KEY (cnic_hash) REFERENCES kyc.cnic_hashes (cnic_hash)
);

/**
 * The tax service seals a CNIC it was given (by the investor or at onboarding) only after proving it
 * is the subject's verified CNIC: one of the peppered hashes it computed (one candidate per active
 * pepper version, each sealed with that hash in its associated data) must be the subject's own.
 * A mismatch is audited and answered with NULL (a RAISE would roll the audit entry back).
 */
CREATE FUNCTION tax.enrol_cnic(p_subject uuid, p_key_version integer, p_candidates jsonb, p_actor text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, tax AS $$
DECLARE
  h kyc.cnic_hashes;
  v_sealed bytea;
  v_id bigint;
BEGIN
  PERFORM ops.check_actor(p_actor);
  IF jsonb_typeof(p_candidates) IS DISTINCT FROM 'array' OR jsonb_array_length(p_candidates) NOT BETWEEN 1 AND 20
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_candidates) e WHERE (e->>'hash') !~ '^[0-9a-f]{64}$' OR length(e->>'sealed') NOT BETWEEN 60 AND 400 OR (e->>'sealed') !~ '^[0-9a-f]+$'
                OR (e->>'version') !~ '^[1-9][0-9]{0,2}$') THEN
    RAISE EXCEPTION 'candidates must be an array of {version, hash, sealed} (hex)' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM kyc.subjects WHERE id = p_subject) THEN RAISE EXCEPTION 'unknown subject' USING ERRCODE = 'no_data_found'; END IF;
  SELECT c.cnic_hash, c.pepper_version, c.subject_id, decode(e->>'sealed', 'hex') INTO h.cnic_hash, h.pepper_version, h.subject_id, v_sealed FROM kyc.cnic_hashes c
  JOIN jsonb_array_elements(p_candidates) e ON (e->>'version')::smallint = c.pepper_version AND c.cnic_hash = decode(e->>'hash', 'hex')
  WHERE c.subject_id = p_subject LIMIT 1;
  IF v_sealed IS NULL THEN
    PERFORM ops.audit_append(p_actor, 'cnic.refused', jsonb_build_object('subject', p_subject, 'reason', 'not the subject''s verified CNIC'));
    RETURN NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM tax.sealed_cnics WHERE subject_id = p_subject AND key_version = p_key_version) THEN
    RAISE EXCEPTION 'a CNIC is already sealed for this subject under key version %', p_key_version USING ERRCODE = 'unique_violation';
  END IF;
  INSERT INTO tax.sealed_cnics (subject_id, key_version, sealed, cnic_hash, pepper_version, enrolled_by)
  VALUES (p_subject, p_key_version, v_sealed, h.cnic_hash, h.pepper_version, p_actor) RETURNING id INTO v_id;
  PERFORM ops.audit_append(p_actor, 'cnic.sealed', jsonb_build_object('sealed', v_id, 'subject', p_subject, 'keyVersion', p_key_version));
  RETURN v_id;
END $$;

CREATE TABLE tax.filer_checks (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subject_id      uuid NOT NULL REFERENCES kyc.subjects (id),
  status          text NOT NULL CHECK (status IN ('filer', 'non_filer', 'unavailable')),
  -- The ATL edition the provider answered from (NULL when unavailable).
  as_of           date,
  provider        text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9-]{1,39}$'),
  evidence_sha256 bytea NOT NULL CHECK (length(evidence_sha256) = 32),
  checked_at      timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  recorded_by     text NOT NULL CHECK (length(recorded_by) BETWEEN 2 AND 100),
  CHECK ((status = 'unavailable') = (as_of IS NULL))
);
CREATE INDEX filer_checks_subject_idx ON tax.filer_checks (subject_id, checked_at DESC);

CREATE FUNCTION tax.record_filer_check(p_subject uuid, p_status text, p_as_of date, p_provider text, p_evidence bytea, p_actor text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, tax AS $$
DECLARE
  v_id bigint;
BEGIN
  PERFORM ops.check_actor(p_actor);
  IF NOT EXISTS (SELECT 1 FROM kyc.subjects WHERE id = p_subject) THEN RAISE EXCEPTION 'unknown subject' USING ERRCODE = 'no_data_found'; END IF;
  IF p_status = 'filer' OR p_status = 'non_filer' THEN
    IF p_as_of IS NULL OR p_as_of > ops.pkt_today() THEN RAISE EXCEPTION 'an ATL result needs its as-of date (not in the future)' USING ERRCODE = 'check_violation'; END IF;
  END IF;
  INSERT INTO tax.filer_checks (subject_id, status, as_of, provider, evidence_sha256, recorded_by)
  VALUES (p_subject, p_status, CASE WHEN p_status = 'unavailable' THEN NULL ELSE p_as_of END, p_provider, p_evidence, p_actor) RETURNING id INTO v_id;
  PERFORM ops.audit_append(p_actor, 'filer.checked', jsonb_build_object('check', v_id, 'subject', p_subject, 'status', p_status, 'asOf', p_as_of,
    'provider', p_provider, 'evidence', encode(p_evidence, 'hex')));
  RETURN v_id;
END $$;

/**
 * OP-41: the filer status that counts at a record date. The latest ATL result recorded by the end
 * of that day (PKT) counts if it is at most filer_check_max_age_days old; a newer "unavailable"
 * is flagged (fallback used). Otherwise, or with no KYC subject: non-filer, flagged for review.
 */
CREATE FUNCTION tax.filer_status(p_subject uuid, p_on date)
RETURNS TABLE (status text, check_id bigint, as_of date, flagged boolean, flag text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, tax AS $$
#variable_conflict use_column
DECLARE
  v_end timestamptz := ((p_on + 1)::timestamp AT TIME ZONE 'Asia/Karachi');
  v_age integer := (ops.setting('filer_check_max_age_days'))::text::integer;
  g tax.filer_checks;
  v_last text;
BEGIN
  IF p_subject IS NULL THEN
    RETURN QUERY SELECT 'non_filer'::text, NULL::bigint, NULL::date, true, 'no KYC subject for this wallet: non-filer rate'::text;
    RETURN;
  END IF;
  SELECT * INTO g FROM tax.filer_checks c
  WHERE c.subject_id = p_subject AND c.status IN ('filer', 'non_filer') AND c.checked_at < v_end
  ORDER BY c.checked_at DESC, c.id DESC LIMIT 1;
  SELECT c.status INTO v_last FROM tax.filer_checks c WHERE c.subject_id = p_subject AND c.checked_at < v_end ORDER BY c.checked_at DESC, c.id DESC LIMIT 1;
  IF g.id IS NOT NULL AND g.checked_at >= v_end - make_interval(days => v_age + 1) THEN
    RETURN QUERY SELECT g.status, g.id, g.as_of, v_last = 'unavailable',
      CASE WHEN v_last = 'unavailable' THEN 'ATL unavailable at the last check: last result used'::text END;
  ELSE
    RETURN QUERY SELECT 'non_filer'::text, g.id, g.as_of, true,
      format('no ATL result within %s days of the record date: non-filer rate', v_age);
  END IF;
END $$;

-- ================================================================== operations: collections (OT-1)
CREATE TABLE ops.collections (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  token           text NOT NULL CHECK (ops.is_address(token)),
  period          text NOT NULL CHECK (ops.is_period(period)),
  statement_id    bigint NOT NULL,
  line_no         integer NOT NULL,
  bank_account    text NOT NULL,
  bank_reference  text NOT NULL,
  value_date      date NOT NULL,
  amount_paisa    bigint NOT NULL CHECK (amount_paisa > 0),
  source          text NOT NULL CHECK (source IN ('matched_credit', 'suspense_credit', 'unbooked_line')),
  debit_account   text,
  note            text NOT NULL CHECK (compliance.free_text_ok(note, 5, 300)),
  status          text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'approved', 'rejected')),
  proposed_by     text NOT NULL CHECK (length(proposed_by) BETWEEN 2 AND 100),
  proposed_at     timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  decided_by      text CHECK (length(decided_by) BETWEEN 2 AND 100),
  decision_reason text CHECK (decision_reason IS NULL OR compliance.free_text_ok(decision_reason, 10, 500)),
  decided_at      timestamptz,
  journal_id      bigint REFERENCES ledger.journal (id),
  FOREIGN KEY (statement_id, line_no) REFERENCES recon.bank_lines (statement_id, line_no),
  CHECK (period = to_char(value_date, 'YYYY-MM')),
  CHECK ((source = 'matched_credit') = (debit_account IS NULL)),
  CHECK ((status = 'proposed') = (decided_by IS NULL AND decided_at IS NULL AND decision_reason IS NULL)),
  CHECK (decided_by IS NULL OR decided_by <> proposed_by),
  CHECK ((status = 'approved') = (journal_id IS NOT NULL))
);
CREATE UNIQUE INDEX collections_line_once ON ops.collections (statement_id, line_no) WHERE status <> 'rejected';
CREATE UNIQUE INDEX collections_journal_once ON ops.collections (journal_id) WHERE journal_id IS NOT NULL;
CREATE INDEX collections_period_idx ON ops.collections (token, period);
CREATE TRIGGER collections_guard BEFORE UPDATE OR DELETE ON ops.collections
  FOR EACH ROW EXECUTE FUNCTION ops.guard_row('proposed>approved,proposed>rejected', 'decided_by', 'decision_reason', 'decided_at', 'journal_id');

-- ================================================================== operations: charges (OT-2)
CREATE TABLE ops.charges (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  token           text NOT NULL CHECK (ops.is_address(token)),
  period          text NOT NULL CHECK (ops.is_period(period)),
  kind            text NOT NULL CHECK (kind IN ('expense', 'fee', 'reserve_contribution', 'reserve_release')),
  fee_type        text CHECK (fee_type IN ('property_manager', 'trustee', 'platform')),
  payee           text CHECK (payee ~ '^[a-z0-9][a-z0-9_-]{1,39}$'),
  description     text NOT NULL CHECK (compliance.free_text_ok(description, 5, 300)),
  amount_paisa    bigint NOT NULL CHECK (amount_paisa > 0 AND amount_paisa <= 100000000000000),
  evidence_sha256 bytea NOT NULL CHECK (length(evidence_sha256) = 32),
  status          text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'approved', 'rejected')),
  proposed_by     text NOT NULL CHECK (length(proposed_by) BETWEEN 2 AND 100),
  proposed_at     timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  decided_by      text CHECK (length(decided_by) BETWEEN 2 AND 100),
  decision_reason text CHECK (decision_reason IS NULL OR compliance.free_text_ok(decision_reason, 10, 500)),
  decided_at      timestamptz,
  journal_id      bigint UNIQUE REFERENCES ledger.journal (id),
  CHECK ((kind = 'fee') = (fee_type IS NOT NULL)),
  CHECK ((kind IN ('expense', 'fee')) = (payee IS NOT NULL)),
  CHECK ((status = 'proposed') = (decided_by IS NULL AND decided_at IS NULL AND decision_reason IS NULL)),
  CHECK (decided_by IS NULL OR decided_by <> proposed_by),
  CHECK ((status = 'approved') = (journal_id IS NOT NULL))
);
CREATE UNIQUE INDEX charges_fee_once ON ops.charges (token, period, fee_type) WHERE kind = 'fee' AND status <> 'rejected';
CREATE UNIQUE INDEX charges_reserve_once ON ops.charges (token, period) WHERE kind = 'reserve_contribution' AND status <> 'rejected';
CREATE INDEX charges_period_idx ON ops.charges (token, period);
CREATE TRIGGER charges_guard BEFORE UPDATE OR DELETE ON ops.charges
  FOR EACH ROW EXECUTE FUNCTION ops.guard_row('proposed>approved,proposed>rejected', 'decided_by', 'decision_reason', 'decided_at', 'journal_id');

CREATE FUNCTION ops.charge_digest(p_id bigint) RETURNS bytea
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, ops AS $$
  SELECT sha256(convert_to('pt-ops-charge-v1' || jsonb_build_array(c.id, c.token, c.period, c.kind, c.fee_type, c.payee, c.description,
           c.amount_paisa::text, encode(c.evidence_sha256, 'hex'), c.status, c.proposed_by)::text, 'UTF8'))
  FROM ops.charges c WHERE c.id = p_id
$$;

-- ================================================================== distributions (OT-4..OT-6)
CREATE TABLE ops.distributions (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  token                text NOT NULL CHECK (ops.is_address(token)),
  period               text NOT NULL CHECK (ops.is_period(period)),
  record_date          date NOT NULL,
  record_block         bigint NOT NULL CHECK (record_block >= 0),
  income_type          text NOT NULL REFERENCES tax.income_types (code),
  -- Snapshot of the operating statement (OT-3) at calculation time.
  collected            bigint NOT NULL CHECK (collected >= 0),
  expenses             bigint NOT NULL CHECK (expenses >= 0),
  fees                 bigint NOT NULL CHECK (fees >= 0),
  reserve_contribution bigint NOT NULL CHECK (reserve_contribution >= 0),
  reserve_release      bigint NOT NULL CHECK (reserve_release >= 0),
  distributable_gross  bigint NOT NULL CHECK (distributable_gross > 0),
  holders              integer NOT NULL CHECK (holders > 0),
  total_units          numeric(78,0) NOT NULL CHECK (total_units > 0),
  sum_gross            bigint NOT NULL,
  sum_wht              bigint NOT NULL CHECK (sum_wht >= 0),
  sum_net              bigint NOT NULL CHECK (sum_net >= 0),
  flagged_lines        integer NOT NULL CHECK (flagged_lines >= 0),
  placeholder_lines    integer NOT NULL CHECK (placeholder_lines >= 0),
  status               text NOT NULL DEFAULT 'calculated' CHECK (status IN ('calculated', 'attached', 'approved', 'returned', 'booked')),
  calculated_by        text NOT NULL CHECK (length(calculated_by) BETWEEN 2 AND 100),
  calculated_at        timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  merkle_root          text CHECK (length(merkle_root) = 66 AND merkle_root ~ '^0x[0-9a-f]+$'),
  statement            text CHECK (length(statement) <= 20000000),
  statement_hash       text CHECK (length(statement_hash) = 66 AND statement_hash ~ '^0x[0-9a-f]+$'),
  tax_schedule         text CHECK (length(tax_schedule) <= 40000000),
  tax_schedule_hash    text CHECK (length(tax_schedule_hash) = 66 AND tax_schedule_hash ~ '^0x[0-9a-f]+$'),
  attached_by          text CHECK (length(attached_by) BETWEEN 2 AND 100),
  attached_at          timestamptz,
  decided_by           text CHECK (length(decided_by) BETWEEN 2 AND 100),
  decision_reason      text CHECK (decision_reason IS NULL OR compliance.free_text_ok(decision_reason, 10, 500)),
  decided_at           timestamptz,
  registry             text CHECK (registry IS NULL OR ops.is_address(registry)),
  onchain_id           numeric(78,0) CHECK (onchain_id > 0),
  wht_journal_id       bigint UNIQUE REFERENCES ledger.journal (id),
  distribution_journal_id bigint UNIQUE REFERENCES ledger.journal (id),
  booked_by            text CHECK (length(booked_by) BETWEEN 2 AND 100),
  booked_at            timestamptz,
  CHECK (sum_gross = distributable_gross),
  CHECK (sum_gross = sum_wht + sum_net),
  CHECK ((attached_by IS NULL) = (statement IS NULL) AND (statement IS NULL) = (statement_hash IS NULL)
         AND (statement IS NULL) = (tax_schedule IS NULL) AND (statement IS NULL) = (tax_schedule_hash IS NULL)
         AND (statement IS NULL) = (merkle_root IS NULL) AND (statement IS NULL) = (attached_at IS NULL)),
  CHECK (status NOT IN ('attached', 'approved', 'booked') OR statement IS NOT NULL),
  CHECK (status NOT IN ('approved', 'booked', 'returned') OR (decided_by IS NOT NULL AND decided_at IS NOT NULL AND decision_reason IS NOT NULL)),
  -- OT-6 maker-checker, also against a direct UPDATE.
  CHECK (decided_by IS NULL OR (decided_by <> calculated_by AND decided_by IS DISTINCT FROM attached_by)),
  CHECK ((status = 'booked') = (onchain_id IS NOT NULL AND registry IS NOT NULL AND distribution_journal_id IS NOT NULL
                                AND booked_by IS NOT NULL AND booked_at IS NOT NULL)),
  CHECK ((sum_wht > 0 AND status = 'booked') = (wht_journal_id IS NOT NULL))
);
CREATE UNIQUE INDEX distributions_one_live ON ops.distributions (token, period) WHERE status <> 'returned';
CREATE UNIQUE INDEX distributions_onchain_once ON ops.distributions (registry, onchain_id) WHERE onchain_id IS NOT NULL;
CREATE TRIGGER distributions_guard BEFORE UPDATE OR DELETE ON ops.distributions
  FOR EACH ROW EXECUTE FUNCTION ops.guard_row('calculated>attached,calculated>returned,attached>approved,attached>returned,approved>booked',
    'merkle_root', 'statement', 'statement_hash', 'tax_schedule', 'tax_schedule_hash', 'attached_by', 'attached_at',
    'decided_by', 'decision_reason', 'decided_at', 'registry', 'onchain_id', 'wht_journal_id', 'distribution_journal_id', 'booked_by', 'booked_at');

CREATE TABLE ops.distribution_lines (
  distribution_id  bigint NOT NULL REFERENCES ops.distributions (id),
  wallet           text NOT NULL CHECK (ops.is_address(wallet)),
  subject_id       uuid REFERENCES kyc.subjects (id),
  units            numeric(78,0) NOT NULL CHECK (units > 0),
  gross            bigint NOT NULL CHECK (gross > 0),
  filer_status     text NOT NULL CHECK (filer_status IN ('filer', 'non_filer', 'exempt')),
  filer_check_id   bigint REFERENCES tax.filer_checks (id),
  filer_as_of      date,
  flagged          boolean NOT NULL,
  flag_reason      text CHECK (length(flag_reason) <= 200),
  rate_id          bigint NOT NULL REFERENCES tax.rates (id),
  rate_ppm         integer NOT NULL CHECK (rate_ppm BETWEEN 0 AND 999999),
  placeholder_rate boolean NOT NULL,
  wht              bigint NOT NULL CHECK (wht >= 0),
  net              bigint NOT NULL CHECK (net >= 0),
  PRIMARY KEY (distribution_id, wallet),
  -- OT-4: per line, gross = net + WHT and the rounding rule, whoever writes the row.
  CHECK (gross = net + wht),
  CHECK (wht::numeric = floor((gross::numeric * rate_ppm + 500000) / 1000000)),
  CHECK (flagged = (flag_reason IS NOT NULL))
);
CREATE INDEX distribution_lines_subject_idx ON ops.distribution_lines (subject_id);

CREATE FUNCTION ops.distribution_digest(p_id bigint) RETURNS bytea
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, ops AS $$
  SELECT sha256(convert_to('pt-ops-distribution-v1' || jsonb_build_array(d.id, d.token, d.period, d.record_date, d.record_block, d.income_type,
           d.distributable_gross::text, d.sum_wht::text, d.sum_net::text, d.holders, d.flagged_lines, d.placeholder_lines, d.status,
           d.merkle_root, d.statement_hash, d.tax_schedule_hash, d.calculated_by, d.attached_by)::text, 'UTF8'))
  FROM ops.distributions d WHERE d.id = p_id
$$;

/** A period is locked while a calculation for it is live (OT-4). */
CREATE FUNCTION ops.require_open_period(p_token text, p_period text) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, ops AS $$
DECLARE
  v_id bigint;
BEGIN
  SELECT id INTO v_id FROM ops.distributions WHERE token = p_token AND period = p_period AND status <> 'returned' LIMIT 1;
  IF v_id IS NOT NULL THEN
    RAISE EXCEPTION 'period % of % is locked by distribution calculation %: record it in a later period (OP-17)', p_period, p_token, v_id
      USING ERRCODE = 'check_violation';
  END IF;
END $$;

-- ------------------------------------------------------------------ collections: propose / decide
CREATE FUNCTION ops.propose_collection(p_token text, p_statement bigint, p_line integer, p_note text, p_actor text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, ops AS $$
DECLARE
  l recon.bank_lines;
  c bank.credits;
  i bank.payment_intents;
  v_ledger text;
  v_source text;
  v_debit text;
  v_period text;
  v_id bigint;
BEGIN
  PERFORM ops.check_actor(p_actor);
  PERFORM ops.check_reason(p_note, 5, 300);
  IF NOT ops.is_address(p_token) THEN RAISE EXCEPTION 'token must be a lower-case address' USING ERRCODE = 'check_violation'; END IF;
  SELECT * INTO l FROM recon.bank_lines WHERE statement_id = p_statement AND line_no = p_line;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown bank statement line' USING ERRCODE = 'no_data_found'; END IF;
  IF l.amount_paisa <= 0 THEN RAISE EXCEPTION 'only an incoming bank line (a credit) is rent collected' USING ERRCODE = 'check_violation'; END IF;
  SELECT ledger_account INTO v_ledger FROM recon.bank_accounts WHERE account = l.account;
  IF v_ledger IS NULL THEN RAISE EXCEPTION 'the bank account % is not registered for reconciliation', l.account USING ERRCODE = 'check_violation'; END IF;
  v_period := to_char(l.value_date, 'YYYY-MM');
  PERFORM ops.require_open_period(p_token, v_period);
  IF EXISTS (SELECT 1 FROM ops.collections WHERE statement_id = p_statement AND line_no = p_line AND status <> 'rejected') THEN
    RAISE EXCEPTION 'the bank line is already recorded as a collection' USING ERRCODE = 'unique_violation';
  END IF;
  SELECT * INTO c FROM bank.credits WHERE raast_ref = l.reference;
  IF FOUND THEN
    IF c.amount_paisa <> l.amount_paisa THEN
      RAISE EXCEPTION 'the bank credit % and the statement line differ in amount', l.reference USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM bank.credit_returns r WHERE r.raast_ref = c.raast_ref) THEN
      RAISE EXCEPTION 'the credit % was returned to the payer', c.raast_ref USING ERRCODE = 'check_violation';
    END IF;
    IF c.status = 'matched' THEN
      SELECT * INTO i FROM bank.payment_intents WHERE code = c.intent_code;
      IF i.purpose IS DISTINCT FROM 'rent_collection' OR i.credit_account IS DISTINCT FROM 'rent:pool:' || p_token THEN
        RAISE EXCEPTION 'the credit was matched to a % payment, not to rent of this token', i.purpose USING ERRCODE = 'check_violation';
      END IF;
      v_source := 'matched_credit';
    ELSE
      IF EXISTS (SELECT 1 FROM ledger.journal j JOIN ledger.postings p ON p.journal_id = j.id JOIN ledger.accounts a ON a.id = p.account_id
                 WHERE j.external_ref = l.reference AND a.code = 'bank:suspense' AND p.amount > 0) THEN
        RAISE EXCEPTION 'the suspense credit % was already re-attributed', l.reference USING ERRCODE = 'check_violation';
      END IF;
      v_source := 'suspense_credit';
      v_debit := 'bank:suspense';
    END IF;
  ELSE
    IF EXISTS (SELECT 1 FROM ledger.journal j JOIN ledger.postings p ON p.journal_id = j.id JOIN ledger.accounts a ON a.id = p.account_id
               WHERE j.external_ref = l.reference AND a.code = v_ledger) THEN
      RAISE EXCEPTION 'the bank line % is already booked in the ledger as something else', l.reference USING ERRCODE = 'check_violation';
    END IF;
    v_source := 'unbooked_line';
    v_debit := v_ledger;
  END IF;
  INSERT INTO ops.collections (token, period, statement_id, line_no, bank_account, bank_reference, value_date, amount_paisa, source, debit_account, note, proposed_by)
  VALUES (p_token, v_period, p_statement, p_line, l.account, l.reference, l.value_date, l.amount_paisa, v_source, v_debit, btrim(p_note), p_actor)
  RETURNING id INTO v_id;
  PERFORM ops.audit_append(p_actor, 'collection.proposed', jsonb_build_object('collection', v_id, 'token', p_token, 'period', v_period,
    'statement', p_statement, 'line', p_line, 'reference', l.reference, 'amount', l.amount_paisa::text, 'source', v_source));
  RETURN v_id;
END $$;

CREATE FUNCTION ops.decide_collection(p_id bigint, p_actor text, p_decision text, p_reason text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, ops AS $$
DECLARE
  r ops.collections;
  v_pool text;
  v_journal bigint;
  v_to text;
BEGIN
  PERFORM ops.check_actor(p_actor);
  PERFORM ops.check_reason(p_reason, 10, 500);
  IF p_decision IS NULL OR p_decision NOT IN ('approve', 'reject') THEN RAISE EXCEPTION 'decision must be approve or reject' USING ERRCODE = 'check_violation'; END IF;
  SELECT * INTO r FROM ops.collections WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown collection' USING ERRCODE = 'no_data_found'; END IF;
  IF r.status <> 'proposed' THEN RAISE EXCEPTION 'the collection is already %', r.status USING ERRCODE = 'check_violation'; END IF;
  IF r.proposed_by = p_actor THEN RAISE EXCEPTION 'maker-checker: the person who recorded a collection cannot decide it' USING ERRCODE = 'check_violation'; END IF;
  IF p_decision = 'approve' THEN
    PERFORM ops.require_open_period(r.token, r.period);
    v_pool := 'rent:pool:' || r.token;
    IF r.source = 'matched_credit' THEN
      SELECT journal_id INTO v_journal FROM bank.credits WHERE raast_ref = r.bank_reference AND status = 'matched';
      IF v_journal IS NULL THEN RAISE EXCEPTION 'the matched credit is gone' USING ERRCODE = 'check_violation'; END IF;
    ELSE
      PERFORM ledger.open_account(v_pool, 'liability', 'PKR');
      v_journal := ledger.post_journal(format('rent:collected:%s:%s-c%s', r.token, r.period, r.id), 'rent_collected',
        left('Rent collected: ' || r.note, 200), r.bank_reference, p_actor,
        jsonb_build_array(jsonb_build_object('account', r.debit_account, 'amount', r.amount_paisa::text),
                          jsonb_build_object('account', v_pool, 'amount', (-r.amount_paisa)::text)));
    END IF;
    v_to := 'approved';
  ELSE
    v_to := 'rejected';
  END IF;
  UPDATE ops.collections SET status = v_to, decided_by = p_actor, decision_reason = btrim(p_reason), decided_at = clock_timestamp(), journal_id = v_journal
  WHERE id = p_id;
  PERFORM ops.audit_append(p_actor, 'collection.decided', jsonb_build_object('collection', p_id, 'decision', p_decision, 'status', v_to, 'journal', v_journal));
  RETURN v_to;
END $$;

-- ------------------------------------------------------------------ charges: propose / decide
CREATE FUNCTION ops.propose_charge(p_token text, p_period text, p_kind text, p_fee_type text, p_payee text, p_description text,
                                   p_amount bigint, p_evidence bytea, p_actor text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, ops AS $$
DECLARE
  v_id bigint;
BEGIN
  PERFORM ops.check_actor(p_actor);
  PERFORM ops.check_reason(p_description, 5, 300);
  IF NOT ops.is_address(p_token) THEN RAISE EXCEPTION 'token must be a lower-case address' USING ERRCODE = 'check_violation'; END IF;
  IF NOT ops.is_period(p_period) THEN RAISE EXCEPTION 'period must be YYYY-MM' USING ERRCODE = 'check_violation'; END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('expense', 'fee', 'reserve_contribution', 'reserve_release') THEN
    RAISE EXCEPTION 'kind must be expense, fee, reserve_contribution or reserve_release' USING ERRCODE = 'check_violation';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 OR p_amount > 100000000000000 THEN RAISE EXCEPTION 'the amount must be positive paisa' USING ERRCODE = 'check_violation'; END IF;
  IF p_evidence IS NULL OR length(p_evidence) <> 32 THEN RAISE EXCEPTION 'the SHA-256 of the evidence (invoice, calculation) is required' USING ERRCODE = 'check_violation'; END IF;
  PERFORM ops.require_open_period(p_token, p_period);
  INSERT INTO ops.charges (token, period, kind, fee_type, payee, description, amount_paisa, evidence_sha256, proposed_by)
  VALUES (p_token, p_period, p_kind, CASE WHEN p_kind = 'fee' THEN p_fee_type END, CASE WHEN p_kind IN ('expense', 'fee') THEN p_payee END,
          btrim(p_description), p_amount, p_evidence, p_actor)
  RETURNING id INTO v_id;
  PERFORM ops.audit_append(p_actor, 'charge.proposed', jsonb_build_object('charge', v_id, 'token', p_token, 'period', p_period, 'kind', p_kind,
    'feeType', p_fee_type, 'payee', p_payee, 'amount', p_amount::text, 'evidence', encode(p_evidence, 'hex')));
  RETURN v_id;
END $$;

CREATE FUNCTION ops.decide_charge(p_id bigint, p_actor text, p_decision text, p_reason text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, ops AS $$
DECLARE
  r ops.charges;
  v_pool text;
  v_other text;
  v_key text;
  v_kind text;
  v_amount bigint;
  v_journal bigint;
  v_to text;
  v_limit bigint := (ops.setting('expense_ops_limit_paisa'))::text::bigint;
BEGIN
  PERFORM ops.check_actor(p_actor);
  PERFORM ops.check_reason(p_reason, 10, 500);
  IF p_decision IS NULL OR p_decision NOT IN ('approve', 'reject') THEN RAISE EXCEPTION 'decision must be approve or reject' USING ERRCODE = 'check_violation'; END IF;
  SELECT * INTO r FROM ops.charges WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown charge' USING ERRCODE = 'no_data_found'; END IF;
  IF r.status <> 'proposed' THEN RAISE EXCEPTION 'the charge is already %', r.status USING ERRCODE = 'check_violation'; END IF;
  IF r.proposed_by = p_actor THEN RAISE EXCEPTION 'maker-checker: the person who proposed a charge cannot decide it' USING ERRCODE = 'check_violation'; END IF;
  IF p_decision = 'approve' THEN
    PERFORM ops.require_open_period(r.token, r.period);
    IF r.kind IN ('expense', 'fee') AND r.amount_paisa > v_limit THEN
      RAISE EXCEPTION 'above the operations limit (% paisa): this needs the trustee (OP-21), which the trustee portal will add', v_limit
        USING ERRCODE = 'check_violation';
    END IF;
    v_pool := 'rent:pool:' || r.token;
    PERFORM ledger.open_account(v_pool, 'liability', 'PKR');
    v_amount := r.amount_paisa;
    IF r.kind = 'expense' THEN
      v_other := 'vendor:payable:' || r.payee;
      v_key := format('expense:%s:%s:approved', r.token, r.id);
      v_kind := 'expense_approved';
    ELSIF r.kind = 'fee' THEN
      v_other := 'fees:payable:' || r.payee;
      v_key := format('fee:%s:%s:%s', r.token, r.period, replace(r.fee_type, '_', '-'));
      v_kind := 'fee_accrued';
    ELSIF r.kind = 'reserve_contribution' THEN
      v_other := 'reserve:' || r.token;
      v_key := format('reserve:%s:%s', r.token, r.period);
      v_kind := 'reserve_contribution';
    ELSE
      v_other := 'reserve:' || r.token;
      v_key := format('reserve:%s:release:%s', r.token, r.id);
      v_kind := 'reserve_release';
      v_amount := -r.amount_paisa;  -- reserve -> pool
    END IF;
    PERFORM ledger.open_account(v_other, 'liability', 'PKR');
    v_journal := ledger.post_journal(v_key, v_kind, left(r.description, 200), encode(r.evidence_sha256, 'hex'), p_actor,
      jsonb_build_array(jsonb_build_object('account', v_pool, 'amount', v_amount::text),
                        jsonb_build_object('account', v_other, 'amount', (-v_amount)::text)));
    v_to := 'approved';
  ELSE
    v_to := 'rejected';
  END IF;
  UPDATE ops.charges SET status = v_to, decided_by = p_actor, decision_reason = btrim(p_reason), decided_at = clock_timestamp(), journal_id = v_journal
  WHERE id = p_id;
  PERFORM ops.audit_append(p_actor, 'charge.decided', jsonb_build_object('charge', p_id, 'decision', p_decision, 'status', v_to, 'journal', v_journal));
  RETURN v_to;
END $$;

-- ------------------------------------------------------------------ operating statement (OT-3)
CREATE FUNCTION ops.period_totals(p_token text, p_period text)
RETURNS TABLE (collected bigint, expenses bigint, fee_property_manager bigint, fee_trustee bigint, fee_platform bigint, fees bigint,
               reserve_contribution bigint, reserve_release bigint, net_operating_cash bigint, distributable_gross bigint, shortfall bigint,
               pending integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, ops AS $$
#variable_conflict use_column
DECLARE
  v_c bigint;
  v_e bigint;
  v_pm bigint;
  v_tr bigint;
  v_pl bigint;
  v_rc bigint;
  v_rr bigint;
  v_p integer;
  v_noc bigint;
  v_dist bigint;
BEGIN
  SELECT coalesce(sum(amount_paisa), 0)::bigint INTO v_c FROM ops.collections WHERE token = p_token AND period = p_period AND status = 'approved';
  SELECT coalesce(sum(amount_paisa) FILTER (WHERE kind = 'expense'), 0)::bigint,
         coalesce(sum(amount_paisa) FILTER (WHERE kind = 'fee' AND fee_type = 'property_manager'), 0)::bigint,
         coalesce(sum(amount_paisa) FILTER (WHERE kind = 'fee' AND fee_type = 'trustee'), 0)::bigint,
         coalesce(sum(amount_paisa) FILTER (WHERE kind = 'fee' AND fee_type = 'platform'), 0)::bigint,
         coalesce(sum(amount_paisa) FILTER (WHERE kind = 'reserve_contribution'), 0)::bigint,
         coalesce(sum(amount_paisa) FILTER (WHERE kind = 'reserve_release'), 0)::bigint
    INTO v_e, v_pm, v_tr, v_pl, v_rc, v_rr
  FROM ops.charges WHERE token = p_token AND period = p_period AND status = 'approved';
  SELECT (SELECT count(*) FROM ops.collections WHERE token = p_token AND period = p_period AND status = 'proposed')
       + (SELECT count(*) FROM ops.charges WHERE token = p_token AND period = p_period AND status = 'proposed') INTO v_p;
  v_noc := v_c - v_e - v_pm - v_tr - v_pl;
  v_dist := v_noc - v_rc + v_rr;
  RETURN QUERY SELECT v_c, v_e, v_pm, v_tr, v_pl, v_pm + v_tr + v_pl, v_rc, v_rr, v_noc, greatest(v_dist, 0), greatest(-v_dist, 0), v_p;
END $$;

/** The per-period operating statement (S-03 §5 table) as JSON: totals and the records behind them. */
CREATE FUNCTION ops.operating_statement(p_token text, p_period text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, ops AS $$
  SELECT jsonb_build_object(
    'token', p_token, 'period', p_period,
    'totals', (SELECT jsonb_build_object('collected', t.collected::text, 'expenses', t.expenses::text,
                 'fees', jsonb_build_object('propertyManager', t.fee_property_manager::text, 'trustee', t.fee_trustee::text, 'platform', t.fee_platform::text,
                                            'total', t.fees::text),
                 'reserveContribution', t.reserve_contribution::text, 'reserveRelease', t.reserve_release::text,
                 'netOperatingCash', t.net_operating_cash::text, 'distributableGross', t.distributable_gross::text, 'shortfall', t.shortfall::text,
                 'pending', t.pending)
               FROM ops.period_totals(p_token, p_period) t),
    'collections', coalesce((SELECT jsonb_agg(jsonb_build_object('id', c.id, 'reference', c.bank_reference, 'valueDate', c.value_date, 'amount', c.amount_paisa::text,
                   'source', c.source, 'status', c.status, 'proposedBy', c.proposed_by, 'decidedBy', c.decided_by, 'journal', c.journal_id) ORDER BY c.id)
                 FROM ops.collections c WHERE c.token = p_token AND c.period = p_period), '[]'::jsonb),
    'charges', coalesce((SELECT jsonb_agg(jsonb_build_object('id', c.id, 'kind', c.kind, 'feeType', c.fee_type, 'payee', c.payee, 'description', c.description,
                   'amount', c.amount_paisa::text, 'evidence', encode(c.evidence_sha256, 'hex'), 'status', c.status, 'proposedBy', c.proposed_by,
                   'decidedBy', c.decided_by, 'journal', c.journal_id) ORDER BY c.id)
                 FROM ops.charges c WHERE c.token = p_token AND c.period = p_period), '[]'::jsonb),
    'distributions', coalesce((SELECT jsonb_agg(jsonb_build_object('id', d.id, 'status', d.status, 'recordDate', d.record_date, 'recordBlock', d.record_block,
                   'incomeType', d.income_type, 'gross', d.sum_gross::text, 'wht', d.sum_wht::text, 'net', d.sum_net::text, 'holders', d.holders,
                   'flagged', d.flagged_lines, 'placeholder', d.placeholder_lines, 'onchainId', d.onchain_id::text) ORDER BY d.id)
                 FROM ops.distributions d WHERE d.token = p_token AND d.period = p_period), '[]'::jsonb))
$$;

-- ------------------------------------------------------------------ calculation (OT-4)
CREATE FUNCTION ops.calculate_distribution(p_token text, p_period text, p_record_date date, p_record_block bigint, p_income_type text, p_actor text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, ops AS $$
DECLARE
  t record;
  v_cursor bigint;
  v_from bigint;
  v_id bigint;
  v_period_end date;
  s record;
BEGIN
  PERFORM ops.check_actor(p_actor);
  IF NOT ops.is_address(p_token) THEN RAISE EXCEPTION 'token must be a lower-case address' USING ERRCODE = 'check_violation'; END IF;
  IF NOT ops.is_period(p_period) THEN RAISE EXCEPTION 'period must be YYYY-MM' USING ERRCODE = 'check_violation'; END IF;
  IF NOT EXISTS (SELECT 1 FROM tax.income_types WHERE code = p_income_type) THEN RAISE EXCEPTION 'unknown income type' USING ERRCODE = 'check_violation'; END IF;
  v_period_end := (to_date(p_period || '-01', 'YYYY-MM-DD') + interval '1 month')::date - 1;
  IF p_record_date IS NULL OR p_record_date <= v_period_end OR p_record_date > ops.pkt_today() THEN
    RAISE EXCEPTION 'the record date must fall after the period (%) and not in the future', v_period_end USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(586586212, hashtext(p_token || p_period));
  PERFORM ops.require_open_period(p_token, p_period);
  SELECT * INTO t FROM ops.period_totals(p_token, p_period);
  IF t.pending > 0 THEN
    RAISE EXCEPTION 'decide every pending collection and charge of the period first (% pending)', t.pending USING ERRCODE = 'check_violation';
  END IF;
  IF t.distributable_gross <= 0 THEN
    RAISE EXCEPTION 'nothing to distribute for % (net operating cash %, shortfall %): no distribution (D13)', p_period,
      t.net_operating_cash, t.shortfall USING ERRCODE = 'check_violation';
  END IF;
  SELECT c.block_number, d.from_block INTO v_cursor, v_from
  FROM chain.tokens k JOIN chain.cursors c ON c.deployment = k.deployment JOIN chain.deployments d ON d.deployment = k.deployment
  WHERE k.token = p_token;
  IF v_cursor IS NULL THEN RAISE EXCEPTION 'the token is not in the read model' USING ERRCODE = 'no_data_found'; END IF;
  IF p_record_block IS NULL OR p_record_block < v_from OR p_record_block > v_cursor THEN
    RAISE EXCEPTION 'the record block must be indexed already (% to %)', v_from, v_cursor USING ERRCODE = 'check_violation';
  END IF;
  FOR s IN SELECT x.status FROM (VALUES ('filer'), ('non_filer')) x(status) LOOP
    IF NOT EXISTS (SELECT 1 FROM tax.rate_for(p_income_type, s.status, p_record_date)) THEN
      RAISE EXCEPTION 'no % rate is in force for % on %: a tax officer must set one', s.status, p_income_type, p_record_date USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;

  -- Holders at the record block from the read model, then the largest remainder (OP-35) and WHT (OP-36).
  DROP TABLE IF EXISTS pg_temp.ops_calc_lines;
  CREATE TEMP TABLE ops_calc_lines ON COMMIT DROP AS
  WITH moves AS (
    SELECT x.to_addr AS holder, x.amount FROM chain.transfers x WHERE x.token = p_token AND x.block_number <= p_record_block
    UNION ALL
    SELECT x.from_addr, -x.amount FROM chain.transfers x WHERE x.token = p_token AND x.block_number <= p_record_block
  ), b AS (
    SELECT holder, sum(amount) AS units FROM moves WHERE holder <> '0x0000000000000000000000000000000000000000' GROUP BY holder HAVING sum(amount) > 0
  ), tot AS (
    SELECT sum(units) AS total FROM b
  ), sh AS (
    SELECT b.holder, b.units, floor(t.distributable_gross::numeric * b.units / tot.total) AS base,
           mod(t.distributable_gross::numeric * b.units, tot.total) AS rem
    FROM b, tot
  ), rk AS (
    SELECT sh.*, row_number() OVER (ORDER BY sh.rem DESC, sh.holder ASC) AS rn, t.distributable_gross - sum(sh.base) OVER () AS lft FROM sh
  ), g AS (
    SELECT rk.holder, rk.units, (rk.base + CASE WHEN rk.rn <= rk.lft THEN 1 ELSE 0 END)::bigint AS gross FROM rk
  )
  SELECT g.holder AS wallet, w.subject_id, g.units, g.gross, fs.status AS filer_status, fs.check_id AS filer_check_id, fs.as_of AS filer_as_of,
         fs.flagged, fs.flag AS flag_reason, rt.id AS rate_id, rt.rate_ppm, rt.placeholder AS placeholder_rate,
         tax.withholding(g.gross, rt.rate_ppm) AS wht
  FROM g
  LEFT JOIN kyc.wallets w ON w.wallet = g.holder
  CROSS JOIN LATERAL tax.filer_status(w.subject_id, p_record_date) fs
  CROSS JOIN LATERAL tax.rate_for(p_income_type, fs.status, p_record_date) rt
  WHERE g.gross > 0;

  IF NOT EXISTS (SELECT 1 FROM ops_calc_lines) THEN
    RAISE EXCEPTION 'no tokens are held at block %', p_record_block USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO ops.distributions (token, period, record_date, record_block, income_type, collected, expenses, fees, reserve_contribution, reserve_release,
                                 distributable_gross, holders, total_units, sum_gross, sum_wht, sum_net, flagged_lines, placeholder_lines, calculated_by)
  SELECT p_token, p_period, p_record_date, p_record_block, p_income_type, t.collected, t.expenses, t.fees, t.reserve_contribution, t.reserve_release,
         t.distributable_gross, count(*), (SELECT coalesce(sum(units), 0) FROM ops_calc_lines),
         sum(l.gross), sum(l.wht), sum(l.gross - l.wht), count(*) FILTER (WHERE l.flagged), count(*) FILTER (WHERE l.placeholder_rate), p_actor
  FROM ops_calc_lines l
  RETURNING id INTO v_id;

  INSERT INTO ops.distribution_lines (distribution_id, wallet, subject_id, units, gross, filer_status, filer_check_id, filer_as_of, flagged, flag_reason,
                                      rate_id, rate_ppm, placeholder_rate, wht, net)
  SELECT v_id, l.wallet, l.subject_id, l.units, l.gross, l.filer_status, l.filer_check_id, l.filer_as_of, l.flagged, l.flag_reason,
         l.rate_id, l.rate_ppm, l.placeholder_rate, l.wht, l.gross - l.wht
  FROM ops_calc_lines l;
  DROP TABLE pg_temp.ops_calc_lines;

  PERFORM ops.audit_append(p_actor, 'distribution.calculated', (SELECT jsonb_build_object('distribution', d.id, 'token', d.token, 'period', d.period,
    'recordDate', d.record_date, 'recordBlock', d.record_block, 'incomeType', d.income_type, 'gross', d.sum_gross::text, 'wht', d.sum_wht::text,
    'net', d.sum_net::text, 'holders', d.holders, 'flagged', d.flagged_lines, 'placeholder', d.placeholder_lines) FROM ops.distributions d WHERE d.id = v_id));
  RETURN v_id;
END $$;

/** Lines as the operations service needs them to build the statement and the tax schedule. */
CREATE FUNCTION ops.distribution_lines_of(p_id bigint)
RETURNS TABLE (wallet text, subject_id uuid, units text, gross bigint, filer_status text, filer_check_id bigint, filer_as_of date, flagged boolean,
               flag_reason text, rate_id bigint, rate_ppm integer, placeholder_rate boolean, wht bigint, net bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, ops AS $$
  SELECT l.wallet, l.subject_id, l.units::text, l.gross, l.filer_status, l.filer_check_id, l.filer_as_of, l.flagged, l.flag_reason, l.rate_id, l.rate_ppm,
         l.placeholder_rate, l.wht, l.net
  FROM ops.distribution_lines l WHERE l.distribution_id = p_id ORDER BY l.wallet
$$;

-- ------------------------------------------------------------------ statement and tax schedule (OT-5)
CREATE FUNCTION ops.attach_statement(p_id bigint, p_root text, p_statement text, p_statement_hash text, p_schedule text, p_schedule_hash text, p_actor text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, ops AS $$
DECLARE
  d ops.distributions;
  v_s jsonb;
  v_t jsonb;
  v_lines integer;
  v_paid integer;
  v_bad integer;
BEGIN
  PERFORM ops.check_actor(p_actor);
  SELECT * INTO d FROM ops.distributions WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown distribution calculation' USING ERRCODE = 'no_data_found'; END IF;
  IF d.status <> 'calculated' THEN RAISE EXCEPTION 'a statement is attached once, to a calculated distribution (this one is %)', d.status USING ERRCODE = 'check_violation'; END IF;
  IF p_root !~ '^0x[0-9a-f]{64}$' OR p_statement_hash !~ '^0x[0-9a-f]{64}$' OR p_schedule_hash !~ '^0x[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'root and hashes must be 0x + 64 lower-case hex characters' USING ERRCODE = 'check_violation';
  END IF;
  BEGIN
    v_s := p_statement::jsonb;
    v_t := p_schedule::jsonb;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'the statement and the tax schedule must be JSON' USING ERRCODE = 'check_violation';
  END;
  SELECT count(*), count(*) FILTER (WHERE net > 0) INTO v_lines, v_paid FROM ops.distribution_lines WHERE distribution_id = p_id;

  -- The public statement: header, totals and one entitlement (wallet, units, net) per paid line.
  IF v_s->>'kind' IS DISTINCT FROM 'pt-rent-statement-v2' OR v_s->>'token' IS DISTINCT FROM d.token OR v_s->>'period' IS DISTINCT FROM d.period
     OR v_s->>'recordDate' IS DISTINCT FROM d.record_date::text OR v_s->>'recordBlock' IS DISTINCT FROM d.record_block::text
     OR v_s->>'calculation' IS DISTINCT FROM d.id::text OR v_s->>'incomeType' IS DISTINCT FROM d.income_type
     OR v_s->>'taxScheduleHash' IS DISTINCT FROM p_schedule_hash
     OR v_s->'totals'->>'collected' IS DISTINCT FROM d.collected::text OR v_s->'totals'->>'expenses' IS DISTINCT FROM d.expenses::text
     OR v_s->'totals'->>'fees' IS DISTINCT FROM d.fees::text OR v_s->'totals'->>'reserveContribution' IS DISTINCT FROM d.reserve_contribution::text
     OR v_s->'totals'->>'reserveRelease' IS DISTINCT FROM d.reserve_release::text
     OR v_s->'totals'->>'distributableGross' IS DISTINCT FROM d.distributable_gross::text
     OR v_s->'totals'->>'wht' IS DISTINCT FROM d.sum_wht::text OR v_s->'totals'->>'net' IS DISTINCT FROM d.sum_net::text
     OR jsonb_typeof(v_s->'entitlements') IS DISTINCT FROM 'array' OR jsonb_array_length(v_s->'entitlements') <> v_paid THEN
    RAISE EXCEPTION 'the statement does not match calculation %', p_id USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*) INTO v_bad FROM ops.distribution_lines l
  WHERE l.distribution_id = p_id AND l.net > 0 AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_s->'entitlements') e
    WHERE e->>'wallet' = l.wallet AND e->>'units' = l.units::text AND e->>'netPaisa' = l.net::text);
  IF v_bad > 0 THEN RAISE EXCEPTION 'the statement differs from the calculation in % entitlement(s)', v_bad USING ERRCODE = 'check_violation'; END IF;

  -- The private tax schedule: every line with its status, evidence, rate, WHT and net.
  IF v_t->>'kind' IS DISTINCT FROM 'pt-tax-schedule-v1' OR v_t->>'token' IS DISTINCT FROM d.token OR v_t->>'period' IS DISTINCT FROM d.period
     OR v_t->>'calculation' IS DISTINCT FROM d.id::text OR v_t->>'incomeType' IS DISTINCT FROM d.income_type
     OR v_t->>'recordDate' IS DISTINCT FROM d.record_date::text OR v_t->>'rounding' IS DISTINCT FROM 'half-up-paisa'
     OR v_t->>'rateScale' IS DISTINCT FROM '1000000'
     OR jsonb_typeof(v_t->'lines') IS DISTINCT FROM 'array' OR jsonb_array_length(v_t->'lines') <> v_lines THEN
    RAISE EXCEPTION 'the tax schedule does not match calculation %', p_id USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*) INTO v_bad FROM ops.distribution_lines l
  WHERE l.distribution_id = p_id AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_t->'lines') e
    WHERE e->>'wallet' = l.wallet AND e->>'subject' IS NOT DISTINCT FROM l.subject_id::text AND e->>'units' = l.units::text
      AND e->>'grossPaisa' = l.gross::text AND e->>'status' = l.filer_status AND e->>'filerCheck' IS NOT DISTINCT FROM l.filer_check_id::text
      AND e->>'filerAsOf' IS NOT DISTINCT FROM l.filer_as_of::text AND (e->>'flagged')::boolean = l.flagged
      AND e->>'rateId' = l.rate_id::text AND e->>'ratePpm' = l.rate_ppm::text AND e->>'whtPaisa' = l.wht::text AND e->>'netPaisa' = l.net::text);
  IF v_bad > 0 THEN RAISE EXCEPTION 'the tax schedule differs from the calculation in % line(s)', v_bad USING ERRCODE = 'check_violation'; END IF;

  UPDATE ops.distributions SET status = 'attached', merkle_root = p_root, statement = p_statement, statement_hash = p_statement_hash,
         tax_schedule = p_schedule, tax_schedule_hash = p_schedule_hash, attached_by = p_actor, attached_at = clock_timestamp()
  WHERE id = p_id;
  PERFORM ops.audit_append(p_actor, 'distribution.attached', jsonb_build_object('distribution', p_id, 'root', p_root, 'statementHash', p_statement_hash,
    'taxScheduleHash', p_schedule_hash));
END $$;

CREATE FUNCTION ops.decide_distribution(p_id bigint, p_actor text, p_decision text, p_reason text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, ops AS $$
DECLARE
  d ops.distributions;
  v_to text;
BEGIN
  PERFORM ops.check_actor(p_actor);
  PERFORM ops.check_reason(p_reason, 10, 500);
  IF p_decision IS NULL OR p_decision NOT IN ('approve', 'reject') THEN RAISE EXCEPTION 'decision must be approve or reject' USING ERRCODE = 'check_violation'; END IF;
  SELECT * INTO d FROM ops.distributions WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown distribution calculation' USING ERRCODE = 'no_data_found'; END IF;
  IF p_actor = d.calculated_by OR p_actor IS NOT DISTINCT FROM d.attached_by THEN
    RAISE EXCEPTION 'maker-checker: whoever calculated or attached the statement cannot decide the distribution' USING ERRCODE = 'check_violation';
  END IF;
  IF p_decision = 'approve' THEN
    IF d.status <> 'attached' THEN RAISE EXCEPTION 'only a calculation with its statement attached can be approved (this one is %)', d.status USING ERRCODE = 'check_violation'; END IF;
    IF d.placeholder_lines > 0 AND (ops.setting('allow_placeholder_rates'))::text <> 'true' THEN
      RAISE EXCEPTION 'the calculation uses PLACEHOLDER tax rates on % line(s) (LEGAL/TAX TO CONFIRM): confirmed rates are needed first', d.placeholder_lines
        USING ERRCODE = 'check_violation';
    END IF;
    v_to := 'approved';
  ELSE
    IF d.status NOT IN ('calculated', 'attached') THEN RAISE EXCEPTION 'the distribution is already %', d.status USING ERRCODE = 'check_violation'; END IF;
    v_to := 'returned';
  END IF;
  UPDATE ops.distributions SET status = v_to, decided_by = p_actor, decision_reason = btrim(p_reason), decided_at = clock_timestamp() WHERE id = p_id;
  PERFORM ops.audit_append(p_actor, 'distribution.decided', jsonb_build_object('distribution', p_id, 'decision', p_decision, 'status', v_to,
    'calculatedBy', d.calculated_by, 'attachedBy', d.attached_by, 'statementHash', d.statement_hash));
  RETURN v_to;
END $$;

-- ------------------------------------------------------------------ booking (OT-6, D9)
CREATE FUNCTION ops.book_distribution(p_id bigint, p_registry text, p_onchain_id numeric, p_actor text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, ops AS $$
DECLARE
  d ops.distributions;
  c chain.distributions;
  v_pool text;
  v_wht bigint;
  v_dist bigint;
  v_postings jsonb;
  l record;
BEGIN
  PERFORM ops.check_actor(p_actor);
  SELECT * INTO d FROM ops.distributions WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown distribution calculation' USING ERRCODE = 'no_data_found'; END IF;
  IF d.status <> 'approved' THEN RAISE EXCEPTION 'only an approved distribution is booked (this one is %)', d.status USING ERRCODE = 'check_violation'; END IF;
  SELECT * INTO c FROM chain.distributions WHERE registry = lower(p_registry) AND id = p_onchain_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'the distribution is not in the read model' USING ERRCODE = 'no_data_found'; END IF;
  IF c.status NOT IN ('finalized', 'paid') THEN
    RAISE EXCEPTION 'the on-chain distribution is % (booking needs it finalized: D9)', c.status USING ERRCODE = 'check_violation';
  END IF;
  IF c.token <> d.token OR c.record_block <> d.record_block OR c.merkle_root <> d.merkle_root OR c.statement_hash <> d.statement_hash
     OR c.total_paisa <> d.sum_net THEN
    RAISE EXCEPTION 'the on-chain distribution differs from calculation % (token, record block, root, statement hash or total = sum of net)', p_id
      USING ERRCODE = 'check_violation';
  END IF;
  v_pool := 'rent:pool:' || d.token;
  PERFORM ledger.open_account(v_pool, 'liability', 'PKR');
  IF d.sum_wht > 0 THEN
    PERFORM ledger.open_account('tax:wht-payable:' || d.token, 'liability', 'PKR');
    v_wht := ledger.post_journal(format('rent:wht:%s:%s', d.token, c.id), 'rent_wht',
      format('FBR withholding on distribution %s (%s, %s)', c.id, d.period, d.income_type), d.statement_hash, p_actor,
      jsonb_build_array(jsonb_build_object('account', v_pool, 'amount', d.sum_wht::text),
                        jsonb_build_object('account', 'tax:wht-payable:' || d.token, 'amount', (-d.sum_wht)::text)));
  END IF;
  v_postings := jsonb_build_array(jsonb_build_object('account', v_pool, 'amount', d.sum_net::text));
  FOR l IN SELECT CASE WHEN x.subject_id IS NULL THEN 'rent:payable:wallet:' || x.wallet ELSE 'rent:payable:' || x.subject_id::text END AS account,
                  sum(x.net) AS net
           FROM ops.distribution_lines x WHERE x.distribution_id = p_id AND x.net > 0 GROUP BY 1 ORDER BY 1 LOOP
    PERFORM ledger.open_account(l.account, 'liability', 'PKR');
    v_postings := v_postings || jsonb_build_array(jsonb_build_object('account', l.account, 'amount', (-l.net)::text));
  END LOOP;
  v_dist := ledger.post_journal(format('rent:distribution:%s:%s', d.token, c.id), 'rent_distribution',
    format('Rent distribution %s (%s), net of withholding', c.id, d.period), d.statement_hash, p_actor, v_postings);
  UPDATE ops.distributions SET status = 'booked', registry = c.registry, onchain_id = c.id, wht_journal_id = v_wht, distribution_journal_id = v_dist,
         booked_by = p_actor, booked_at = clock_timestamp()
  WHERE id = p_id;
  PERFORM ops.audit_append(p_actor, 'distribution.booked', jsonb_build_object('distribution', p_id, 'registry', c.registry, 'onchainId', c.id::text,
    'whtJournal', v_wht, 'distributionJournal', v_dist, 'wht', d.sum_wht::text, 'net', d.sum_net::text));
  RETURN v_dist;
END $$;

-- ================================================================== remittances to FBR (OT-10)
CREATE TABLE tax.remittances (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  token           text NOT NULL CHECK (ops.is_address(token)),
  period          text NOT NULL CHECK (ops.is_period(period)),
  amount_paisa    bigint NOT NULL CHECK (amount_paisa > 0),
  -- Computerised Payment Receipt number of the FBR payment.
  cpr             text NOT NULL CHECK (cpr ~ '^[A-Z0-9][A-Z0-9-]{5,39}$'),
  bank_reference  text NOT NULL CHECK (bank_reference ~ '^[A-Z0-9][A-Z0-9-]{3,63}$'),
  -- The trustee bank account (registered for reconciliation) the payment to FBR left from.
  bank_account    text NOT NULL REFERENCES recon.bank_accounts (account),
  payment_date    date NOT NULL,
  status          text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'approved', 'rejected')),
  proposed_by     text NOT NULL CHECK (length(proposed_by) BETWEEN 2 AND 100),
  proposed_at     timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  decided_by      text CHECK (length(decided_by) BETWEEN 2 AND 100),
  decision_reason text CHECK (decision_reason IS NULL OR compliance.free_text_ok(decision_reason, 10, 500)),
  decided_at      timestamptz,
  journal_id      bigint UNIQUE REFERENCES ledger.journal (id),
  CHECK ((status = 'proposed') = (decided_by IS NULL AND decided_at IS NULL AND decision_reason IS NULL)),
  CHECK (decided_by IS NULL OR decided_by <> proposed_by),
  CHECK ((status = 'approved') = (journal_id IS NOT NULL))
);
CREATE UNIQUE INDEX remittances_cpr_once ON tax.remittances (cpr) WHERE status <> 'rejected';
CREATE TRIGGER remittances_guard BEFORE UPDATE OR DELETE ON tax.remittances
  FOR EACH ROW EXECUTE FUNCTION ops.guard_row('proposed>approved,proposed>rejected', 'decided_by', 'decision_reason', 'decided_at', 'journal_id');

/** Withheld (booked) and remitted per token and period. */
CREATE FUNCTION tax.period_position(p_token text, p_period text)
RETURNS TABLE (withheld bigint, remitted bigint, pending bigint, outstanding bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, tax AS $$
  SELECT w.v, r.v, p.v, w.v - r.v
  FROM (SELECT coalesce(sum(sum_wht), 0)::bigint AS v FROM ops.distributions WHERE token = p_token AND period = p_period AND status = 'booked') w,
       (SELECT coalesce(sum(amount_paisa), 0)::bigint AS v FROM tax.remittances WHERE token = p_token AND period = p_period AND status = 'approved') r,
       (SELECT coalesce(sum(amount_paisa), 0)::bigint AS v FROM tax.remittances WHERE token = p_token AND period = p_period AND status = 'proposed') p
$$;

CREATE FUNCTION tax.propose_remittance(p_token text, p_period text, p_amount bigint, p_cpr text, p_bank_reference text, p_bank_account text,
                                       p_payment_date date, p_actor text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, tax AS $$
DECLARE
  v_pos record;
  v_id bigint;
BEGIN
  PERFORM ops.check_actor(p_actor);
  IF NOT ops.is_address(p_token) OR NOT ops.is_period(p_period) THEN RAISE EXCEPTION 'token and period (YYYY-MM) are required' USING ERRCODE = 'check_violation'; END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'the amount must be positive paisa' USING ERRCODE = 'check_violation'; END IF;
  IF p_payment_date IS NULL OR p_payment_date > ops.pkt_today() THEN RAISE EXCEPTION 'the payment date cannot be in the future' USING ERRCODE = 'check_violation'; END IF;
  IF NOT EXISTS (SELECT 1 FROM recon.bank_accounts WHERE account = p_bank_account) THEN
    RAISE EXCEPTION 'the bank account % is not registered for reconciliation', p_bank_account USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(586586213, hashtext(p_token || p_period));
  SELECT * INTO v_pos FROM tax.period_position(p_token, p_period);
  IF p_amount > v_pos.outstanding - v_pos.pending THEN
    RAISE EXCEPTION 'the remittance (%) exceeds what is withheld and not yet remitted for % (%)', p_amount, p_period, v_pos.outstanding - v_pos.pending
      USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO tax.remittances (token, period, amount_paisa, cpr, bank_reference, bank_account, payment_date, proposed_by)
  VALUES (p_token, p_period, p_amount, upper(p_cpr), upper(p_bank_reference), p_bank_account, p_payment_date, p_actor) RETURNING id INTO v_id;
  PERFORM ops.audit_append(p_actor, 'remittance.proposed', jsonb_build_object('remittance', v_id, 'token', p_token, 'period', p_period,
    'amount', p_amount::text, 'cpr', upper(p_cpr), 'bankReference', upper(p_bank_reference), 'bankAccount', p_bank_account));
  RETURN v_id;
END $$;

CREATE FUNCTION tax.decide_remittance(p_id bigint, p_actor text, p_decision text, p_reason text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, tax AS $$
DECLARE
  r tax.remittances;
  v_journal bigint;
  v_to text;
BEGIN
  PERFORM ops.check_actor(p_actor);
  PERFORM ops.check_reason(p_reason, 10, 500);
  IF p_decision IS NULL OR p_decision NOT IN ('approve', 'reject') THEN RAISE EXCEPTION 'decision must be approve or reject' USING ERRCODE = 'check_violation'; END IF;
  SELECT * INTO r FROM tax.remittances WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown remittance' USING ERRCODE = 'no_data_found'; END IF;
  IF r.status <> 'proposed' THEN RAISE EXCEPTION 'the remittance is already %', r.status USING ERRCODE = 'check_violation'; END IF;
  IF r.proposed_by = p_actor THEN RAISE EXCEPTION 'maker-checker: the person who recorded a remittance cannot decide it' USING ERRCODE = 'check_violation'; END IF;
  IF p_decision = 'approve' THEN
    v_journal := ledger.post_journal(format('tax:remit:%s:%s', r.token, lower(r.cpr)), 'tax_remittance',
      format('Withholding for %s remitted to FBR, CPR %s', r.period, r.cpr), r.bank_reference, p_actor,
      jsonb_build_array(jsonb_build_object('account', 'tax:wht-payable:' || r.token, 'amount', r.amount_paisa::text),
                        jsonb_build_object('account', (SELECT b.ledger_account FROM recon.bank_accounts b WHERE b.account = r.bank_account),
                                           'amount', (-r.amount_paisa)::text)));
    v_to := 'approved';
  ELSE
    v_to := 'rejected';
  END IF;
  UPDATE tax.remittances SET status = v_to, decided_by = p_actor, decision_reason = btrim(p_reason), decided_at = clock_timestamp(), journal_id = v_journal
  WHERE id = p_id;
  PERFORM ops.audit_append(p_actor, 'remittance.decided', jsonb_build_object('remittance', p_id, 'decision', p_decision, 'status', v_to, 'journal', v_journal));
  RETURN v_to;
END $$;

-- ================================================================== tax certificates (OP-51, data only)
CREATE TABLE tax.certificates (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subject_id     uuid NOT NULL REFERENCES kyc.subjects (id),
  -- The fiscal year by its closing year: 2026 = 1 July 2025 to 30 June 2026.
  fiscal_year    integer NOT NULL CHECK (fiscal_year BETWEEN 2000 AND 2200),
  content        jsonb NOT NULL CHECK (jsonb_typeof(content) = 'object'),
  content_sha256 bytea NOT NULL CHECK (length(content_sha256) = 32),
  issued_by      text NOT NULL CHECK (length(issued_by) BETWEEN 2 AND 100),
  issued_at      timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  supersedes     bigint UNIQUE REFERENCES tax.certificates (id),
  CHECK (content_sha256 = sha256(convert_to(content::text, 'UTF8')))
);
CREATE INDEX certificates_subject_idx ON tax.certificates (subject_id, fiscal_year, id DESC);

/** Every booked distribution of the fiscal year for one investor, with the CPR numbers of the remittances. */
CREATE FUNCTION tax.certificate_data(p_subject uuid, p_fiscal_year integer) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, tax AS $$
  WITH lines AS (
    SELECT d.token, d.period, d.record_date, d.id AS calc, d.onchain_id, d.income_type, l.units, l.gross, l.filer_status, l.filer_as_of, l.rate_ppm,
           l.wht, l.net,
           coalesce((SELECT jsonb_agg(r.cpr ORDER BY r.cpr) FROM tax.remittances r WHERE r.token = d.token AND r.period = d.period AND r.status = 'approved'),
                    '[]'::jsonb) AS cprs
    FROM ops.distribution_lines l JOIN ops.distributions d ON d.id = l.distribution_id
    WHERE l.subject_id = p_subject AND d.status = 'booked'
      AND d.record_date BETWEEN make_date(p_fiscal_year - 1, 7, 1) AND make_date(p_fiscal_year, 6, 30)
  )
  SELECT jsonb_build_object(
    'kind', 'pt-tax-certificate-v1', 'subject', p_subject, 'fiscalYear', p_fiscal_year,
    'from', make_date(p_fiscal_year - 1, 7, 1), 'to', make_date(p_fiscal_year, 6, 30),
    'lines', coalesce((SELECT jsonb_agg(jsonb_build_object('token', token, 'period', period, 'recordDate', record_date, 'calculation', calc,
               'distributionId', onchain_id::text, 'incomeType', income_type, 'units', units::text, 'grossPaisa', gross::text, 'status', filer_status,
               'filerAsOf', filer_as_of, 'ratePpm', rate_ppm, 'whtPaisa', wht::text, 'netPaisa', net::text, 'cprs', cprs)
               ORDER BY record_date, token, calc) FROM lines), '[]'::jsonb),
    'totals', (SELECT jsonb_build_object('grossPaisa', coalesce(sum(gross), 0)::text, 'whtPaisa', coalesce(sum(wht), 0)::text,
               'netPaisa', coalesce(sum(net), 0)::text) FROM lines),
    'note', 'Data for the annual withholding certificate (S-03 OP-51). Content requirements LEGAL/TAX TO CONFIRM.')
$$;

/** Issues (or re-issues) the certificate; a changed content supersedes the previous one, both kept. */
CREATE FUNCTION tax.issue_certificate(p_subject uuid, p_fiscal_year integer, p_actor text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, tax AS $$
DECLARE
  v_content jsonb;
  v_sha bytea;
  v_prev tax.certificates;
  v_id bigint;
BEGIN
  PERFORM ops.check_actor(p_actor);
  IF NOT EXISTS (SELECT 1 FROM kyc.subjects WHERE id = p_subject) THEN RAISE EXCEPTION 'unknown subject' USING ERRCODE = 'no_data_found'; END IF;
  IF p_fiscal_year IS NULL OR p_fiscal_year NOT BETWEEN 2000 AND 2200 THEN RAISE EXCEPTION 'fiscal year by its closing year, e.g. 2026' USING ERRCODE = 'check_violation'; END IF;
  PERFORM pg_advisory_xact_lock(586586214, hashtext(p_subject::text || p_fiscal_year::text));
  v_content := tax.certificate_data(p_subject, p_fiscal_year);
  v_sha := sha256(convert_to(v_content::text, 'UTF8'));
  SELECT * INTO v_prev FROM tax.certificates c WHERE c.subject_id = p_subject AND c.fiscal_year = p_fiscal_year
    AND NOT EXISTS (SELECT 1 FROM tax.certificates n WHERE n.supersedes = c.id) ORDER BY c.id DESC LIMIT 1;
  IF v_prev.id IS NOT NULL AND v_prev.content_sha256 = v_sha THEN RETURN v_prev.id; END IF;
  INSERT INTO tax.certificates (subject_id, fiscal_year, content, content_sha256, issued_by, supersedes)
  VALUES (p_subject, p_fiscal_year, v_content, v_sha, p_actor, v_prev.id) RETURNING id INTO v_id;
  PERFORM ops.audit_append(p_actor, 'certificate.issued', jsonb_build_object('certificate', v_id, 'subject', p_subject, 'fiscalYear', p_fiscal_year,
    'sha256', encode(v_sha, 'hex'), 'supersedes', v_prev.id));
  RETURN v_id;
END $$;

-- ================================================================== FBR filing exports (OT-9, ADR 0014)
CREATE TABLE tax.filing_exports (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- NULL token = every token.
  token           text CHECK (token IS NULL OR ops.is_address(token)),
  from_period     text NOT NULL CHECK (ops.is_period(from_period)),
  to_period       text NOT NULL CHECK (ops.is_period(to_period)),
  reason          text NOT NULL CHECK (compliance.free_text_ok(reason, 10, 500)),
  status          text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'approved', 'rejected', 'generated')),
  requested_by    text NOT NULL CHECK (length(requested_by) BETWEEN 2 AND 100),
  requested_at    timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  decided_by      text CHECK (length(decided_by) BETWEEN 2 AND 100),
  decision_reason text CHECK (decision_reason IS NULL OR compliance.free_text_ok(decision_reason, 10, 500)),
  decided_at      timestamptz,
  generated_by    text CHECK (length(generated_by) BETWEEN 2 AND 100),
  generated_at    timestamptz,
  file_sha256     bytea CHECK (length(file_sha256) = 32),
  row_count       integer CHECK (row_count >= 0),
  CHECK (from_period <= to_period),
  CHECK ((status = 'requested') = (decided_by IS NULL AND decided_at IS NULL AND decision_reason IS NULL)),
  -- OT-9: two different officers.
  CHECK (decided_by IS NULL OR decided_by <> requested_by),
  CHECK ((status = 'generated') = (generated_by IS NOT NULL AND generated_at IS NOT NULL AND file_sha256 IS NOT NULL AND row_count IS NOT NULL)),
  CHECK (generated_by IS NULL OR generated_by = requested_by OR generated_by = decided_by)
);
CREATE TRIGGER filing_exports_guard BEFORE UPDATE OR DELETE ON tax.filing_exports
  FOR EACH ROW EXECUTE FUNCTION ops.guard_row('requested>approved,requested>rejected,approved>generated',
    'decided_by', 'decision_reason', 'decided_at', 'generated_by', 'generated_at', 'file_sha256', 'row_count');

CREATE TABLE tax.export_tickets (
  token_hash bytea PRIMARY KEY CHECK (length(token_hash) = 32),
  export_id  bigint NOT NULL REFERENCES tax.filing_exports (id),
  handle     text NOT NULL CHECK (length(handle) BETWEEN 2 AND 100),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '10 minutes')
);
CREATE INDEX export_tickets_export_idx ON tax.export_tickets (export_id);

CREATE FUNCTION tax.guard_ticket() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'export tickets are never deleted' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF OLD.used_at IS NOT NULL OR NEW.used_at IS NULL
     OR (NEW.token_hash, NEW.export_id, NEW.handle, NEW.created_at, NEW.expires_at) IS DISTINCT FROM (OLD.token_hash, OLD.export_id, OLD.handle, OLD.created_at, OLD.expires_at) THEN
    RAISE EXCEPTION 'an export ticket is used once and never changed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER export_tickets_guard BEFORE UPDATE OR DELETE ON tax.export_tickets FOR EACH ROW EXECUTE FUNCTION tax.guard_ticket();

CREATE FUNCTION tax.export_digest(p_id bigint) RETURNS bytea
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, tax AS $$
  SELECT sha256(convert_to('pt-tax-export-v1' || jsonb_build_array(e.id, e.token, e.from_period, e.to_period, e.reason, e.status, e.requested_by,
           e.decided_by)::text, 'UTF8'))
  FROM tax.filing_exports e WHERE e.id = p_id
$$;

/** The booked lines an export covers (no CNIC here: the tax service adds it after the ticket). */
CREATE FUNCTION tax.export_scope(p_id bigint)
RETURNS TABLE (subject_id uuid, wallet text, token text, period text, calculation bigint, onchain_id text, income_type text, filer_status text,
               filer_as_of date, gross bigint, rate_ppm integer, wht bigint, net bigint, record_date date)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, tax AS $$
  SELECT l.subject_id, l.wallet, d.token, d.period, d.id, d.onchain_id::text, d.income_type, l.filer_status, l.filer_as_of, l.gross, l.rate_ppm, l.wht, l.net,
         d.record_date
  FROM tax.filing_exports e
  JOIN ops.distributions d ON d.status = 'booked' AND (e.token IS NULL OR d.token = e.token) AND d.period BETWEEN e.from_period AND e.to_period
  JOIN ops.distribution_lines l ON l.distribution_id = d.id
  WHERE e.id = p_id
  ORDER BY d.token, d.period, d.id, l.wallet
$$;

CREATE FUNCTION tax.request_export(p_token text, p_from text, p_to text, p_reason text, p_actor text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, tax AS $$
DECLARE
  v_id bigint;
BEGIN
  PERFORM ops.check_actor(p_actor);
  PERFORM ops.check_reason(p_reason, 10, 500);
  IF p_token IS NOT NULL AND NOT ops.is_address(p_token) THEN RAISE EXCEPTION 'token must be a lower-case address or empty (all tokens)' USING ERRCODE = 'check_violation'; END IF;
  IF NOT ops.is_period(p_from) OR NOT ops.is_period(p_to) OR p_from > p_to THEN
    RAISE EXCEPTION 'periods must be YYYY-MM, from <= to' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO tax.filing_exports (token, from_period, to_period, reason, requested_by) VALUES (p_token, p_from, p_to, btrim(p_reason), p_actor)
  RETURNING id INTO v_id;
  PERFORM ops.audit_append(p_actor, 'export.requested', jsonb_build_object('export', v_id, 'token', p_token, 'from', p_from, 'to', p_to));
  RETURN v_id;
END $$;

CREATE FUNCTION tax.decide_export(p_id bigint, p_actor text, p_decision text, p_reason text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, tax AS $$
DECLARE
  e tax.filing_exports;
  v_to text;
BEGIN
  PERFORM ops.check_actor(p_actor);
  PERFORM ops.check_reason(p_reason, 10, 500);
  IF p_decision IS NULL OR p_decision NOT IN ('approve', 'reject') THEN RAISE EXCEPTION 'decision must be approve or reject' USING ERRCODE = 'check_violation'; END IF;
  SELECT * INTO e FROM tax.filing_exports WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown export' USING ERRCODE = 'no_data_found'; END IF;
  IF e.status <> 'requested' THEN RAISE EXCEPTION 'the export is already %', e.status USING ERRCODE = 'check_violation'; END IF;
  IF e.requested_by = p_actor THEN
    RAISE EXCEPTION 'two officers: the officer who requested an export cannot approve it' USING ERRCODE = 'check_violation';
  END IF;
  IF p_decision = 'approve' AND clock_timestamp() > e.requested_at + make_interval(hours => (ops.setting('export_valid_hours'))::text::integer) THEN
    RAISE EXCEPTION 'the request expired: request the export again' USING ERRCODE = 'check_violation';
  END IF;
  v_to := CASE p_decision WHEN 'approve' THEN 'approved' ELSE 'rejected' END;
  UPDATE tax.filing_exports SET status = v_to, decided_by = p_actor, decision_reason = btrim(p_reason), decided_at = clock_timestamp() WHERE id = p_id;
  PERFORM ops.audit_append(p_actor, 'export.decided', jsonb_build_object('export', p_id, 'decision', p_decision, 'status', v_to, 'requestedBy', e.requested_by));
  RETURN v_to;
END $$;

/** Step 1 of generation (portal, after a step-up): one of the two officers gets a one-time ticket. */
CREATE FUNCTION tax.issue_export_ticket(p_id bigint, p_actor text, p_token_hash bytea)
RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, tax AS $$
DECLARE
  e tax.filing_exports;
  v_now timestamptz := date_trunc('microseconds', clock_timestamp());
  v_exp timestamptz;
BEGIN
  PERFORM ops.check_actor(p_actor);
  IF p_token_hash IS NULL OR length(p_token_hash) <> 32 THEN RAISE EXCEPTION 'ticket hash must be 32 bytes' USING ERRCODE = 'check_violation'; END IF;
  SELECT * INTO e FROM tax.filing_exports WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown export' USING ERRCODE = 'no_data_found'; END IF;
  IF e.status <> 'approved' THEN RAISE EXCEPTION 'only an approved, not yet generated export can be generated (this one is %)', e.status USING ERRCODE = 'check_violation'; END IF;
  IF p_actor <> e.requested_by AND p_actor <> e.decided_by THEN
    RAISE EXCEPTION 'only the two officers of this export may generate it' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_now > e.decided_at + make_interval(hours => (ops.setting('export_valid_hours'))::text::integer) THEN
    RAISE EXCEPTION 'the approval expired: request the export again' USING ERRCODE = 'check_violation';
  END IF;
  v_exp := v_now + make_interval(secs => (ops.setting('export_ticket_seconds'))::text::integer);
  INSERT INTO tax.export_tickets (token_hash, export_id, handle, created_at, expires_at) VALUES (p_token_hash, p_id, p_actor, v_now, v_exp);
  PERFORM ops.audit_append(p_actor, 'export.ticket', jsonb_build_object('export', p_id, 'ticket', left(encode(p_token_hash, 'hex'), 16), 'expiresAt', ops.utc(v_exp)));
  RETURN v_exp;
END $$;

/**
 * Step 2 (tax service, one transaction with tax.complete_export): uses the ticket once and returns
 * every line in scope with the subject's sealed CNIC. Refuses the whole export if any line has no
 * sealed CNIC (no partial filing). Every release of sealed CNICs is audited.
 */
CREATE FUNCTION tax.redeem_export_ticket(p_token_hash bytea, p_id bigint)
RETURNS TABLE (subject_id uuid, key_version smallint, sealed bytea, cnic_hash bytea, pepper_version smallint, wallet text, token text, period text,
               calculation bigint, onchain_id text, income_type text, filer_status text, filer_as_of date, gross bigint, rate_ppm integer, wht bigint,
               net bigint, record_date date, cprs text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, tax AS $$
#variable_conflict use_column
DECLARE
  t tax.export_tickets;
  e tax.filing_exports;
  v_missing integer;
  v_rows integer;
BEGIN
  SELECT * INTO t FROM tax.export_tickets x WHERE x.token_hash = p_token_hash FOR UPDATE;
  IF NOT FOUND OR t.used_at IS NOT NULL OR t.expires_at < clock_timestamp() OR t.export_id IS DISTINCT FROM p_id THEN
    RAISE EXCEPTION 'export ticket is not valid (unknown, used, expired or for another export)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO e FROM tax.filing_exports x WHERE x.id = p_id FOR UPDATE;
  IF e.status <> 'approved' THEN RAISE EXCEPTION 'the export is %', e.status USING ERRCODE = 'check_violation'; END IF;
  UPDATE tax.export_tickets SET used_at = clock_timestamp() WHERE token_hash = p_token_hash;
  SELECT count(*) INTO v_missing FROM tax.export_scope(p_id) s
  WHERE s.subject_id IS NULL OR NOT EXISTS (SELECT 1 FROM tax.sealed_cnics c WHERE c.subject_id = s.subject_id);
  IF v_missing > 0 THEN
    RAISE EXCEPTION '% line(s) in scope have no sealed CNIC: enrol them first (no partial export)', v_missing USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*) INTO v_rows FROM tax.export_scope(p_id);
  PERFORM ops.audit_append('tax-service', 'cnic.released', jsonb_build_object('purpose', 'filing_export', 'export', p_id, 'lines', v_rows,
    'subjects', (SELECT count(DISTINCT s.subject_id) FROM tax.export_scope(p_id) s), 'officer', t.handle,
    'ticket', left(encode(p_token_hash, 'hex'), 16)));
  RETURN QUERY
  SELECT s.subject_id, c.key_version, c.sealed, c.cnic_hash, c.pepper_version, s.wallet, s.token, s.period, s.calculation, s.onchain_id, s.income_type,
         s.filer_status, s.filer_as_of, s.gross, s.rate_ppm, s.wht, s.net, s.record_date,
         coalesce((SELECT string_agg(r.cpr, ' ' ORDER BY r.cpr) FROM tax.remittances r WHERE r.token = s.token AND r.period = s.period AND r.status = 'approved'), '')
  FROM tax.export_scope(p_id) s
  JOIN LATERAL (SELECT x.* FROM tax.sealed_cnics x WHERE x.subject_id = s.subject_id ORDER BY x.key_version DESC LIMIT 1) c ON true;
END $$;

/** Step 3 (tax service, same transaction): records the file before it is released; generated by the ticket's officer. */
CREATE FUNCTION tax.complete_export(p_token_hash bytea, p_id bigint, p_sha256 bytea, p_rows integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, tax AS $$
DECLARE
  t tax.export_tickets;
  v_audit bigint;
BEGIN
  SELECT * INTO t FROM tax.export_tickets x WHERE x.token_hash = p_token_hash;
  IF NOT FOUND OR t.used_at IS NULL OR t.export_id IS DISTINCT FROM p_id THEN
    RAISE EXCEPTION 'redeem the ticket first' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_sha256 IS NULL OR length(p_sha256) <> 32 OR p_rows IS NULL OR p_rows < 0 THEN RAISE EXCEPTION 'file digest and row count required' USING ERRCODE = 'check_violation'; END IF;
  -- The ticket proves the officer's session (permission, step-up) was checked when it was issued.
  PERFORM admin.bind_officer(t.handle);
  UPDATE tax.filing_exports SET status = 'generated', generated_by = t.handle, generated_at = clock_timestamp(), file_sha256 = p_sha256, row_count = p_rows
  WHERE id = p_id;
  PERFORM admin.unbind_officer(t.handle);
  v_audit := ops.audit_append(t.handle, 'export.generated', jsonb_build_object('export', p_id, 'sha256', encode(p_sha256, 'hex'), 'rows', p_rows,
    'ticket', left(encode(p_token_hash, 'hex'), 16)));
  RETURN (SELECT jsonb_build_object('audit', a.id, 'auditHash', encode(a.hash, 'hex'), 'at', ops.utc(a.at), 'officer', t.handle)
          FROM ops.audit a WHERE a.id = v_audit);
END $$;

-- ================================================================== ATL checks (OT-8): the tax service's queue
/**
 * Subjects with a sealed CNIC whose latest ATL result is older than p_as_of (or missing): the
 * ciphertext goes to the tax service only, and the release is audited.
 */
CREATE FUNCTION tax.atl_due(p_as_of date, p_limit integer, p_worker text)
RETURNS TABLE (subject_id uuid, key_version smallint, sealed bytea, cnic_hash bytea, pepper_version smallint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, tax AS $$
#variable_conflict use_column
DECLARE
  v_n integer;
BEGIN
  PERFORM ops.check_actor(p_worker);
  RETURN QUERY
  SELECT c.subject_id, c.key_version, c.sealed, c.cnic_hash, c.pepper_version
  FROM tax.sealed_cnics c
  WHERE c.key_version = (SELECT max(y.key_version) FROM tax.sealed_cnics y WHERE y.subject_id = c.subject_id)
    AND NOT EXISTS (SELECT 1 FROM tax.filer_checks f WHERE f.subject_id = c.subject_id AND f.status IN ('filer', 'non_filer') AND f.as_of >= p_as_of)
  ORDER BY c.subject_id LIMIT least(greatest(coalesce(p_limit, 100), 1), 1000);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN
    PERFORM ops.audit_append(p_worker, 'cnic.released', jsonb_build_object('purpose', 'atl_check', 'asOf', p_as_of, 'subjects', v_n));
  END IF;
END $$;

-- ================================================================== reconciliation (OT-10)
/**
 * Tax and distribution consistency for one token. Empty = consistent. Check names are those of
 * @pt/recon (tax.line_arithmetic, rent.wht_mismatch, tax.payable_mismatch, tax.wht_unremitted).
 */
CREATE FUNCTION tax.reconcile(p_token text)
RETURNS TABLE (check_name text, subject text, expected text, actual text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, tax AS $$
#variable_conflict use_column
DECLARE
  v_payable text := 'tax:wht-payable:' || p_token;
  v_due integer := (ops.setting('wht_due_days'))::text::integer;
BEGIN
  -- Every line: gross = net + WHT, and WHT follows the rounding rule (CHECKs hold it for honest writers).
  RETURN QUERY
  SELECT 'tax.line_arithmetic', format('calculation %s wallet %s', l.distribution_id, l.wallet),
         format('net %s + WHT %s = gross; WHT = %s', l.net, l.wht, tax.withholding(l.gross, l.rate_ppm)), format('gross %s', l.gross)
  FROM ops.distribution_lines l JOIN ops.distributions d ON d.id = l.distribution_id
  WHERE d.token = p_token AND (l.gross <> l.net + l.wht OR l.wht <> tax.withholding(l.gross, l.rate_ppm));
  -- Every calculation: the lines add up to its totals; sum(gross) = distributable gross.
  RETURN QUERY
  SELECT 'tax.line_arithmetic', format('calculation %s', d.id),
         format('gross %s, WHT %s, net %s', d.distributable_gross, d.sum_wht, d.sum_net),
         format('lines: gross %s, WHT %s, net %s', coalesce(x.g, 0), coalesce(x.w, 0), coalesce(x.n, 0))
  FROM ops.distributions d
  LEFT JOIN LATERAL (SELECT sum(gross) g, sum(wht) w, sum(net) n FROM ops.distribution_lines WHERE distribution_id = d.id) x ON true
  WHERE d.token = p_token AND (x.g IS DISTINCT FROM d.distributable_gross::numeric OR x.w IS DISTINCT FROM d.sum_wht::numeric OR x.n IS DISTINCT FROM d.sum_net::numeric);
  -- Booked distributions: the WHT journal and the distribution journal equal the calculation.
  RETURN QUERY
  SELECT 'rent.wht_mismatch', format('distribution %s', d.onchain_id),
         format('%s paisa withheld (calculation %s)', d.sum_wht, d.id),
         format('%s paisa in rent:wht:%s:%s', coalesce(j.v, 0), d.token, d.onchain_id)
  FROM ops.distributions d
  LEFT JOIN LATERAL (SELECT sum(p.amount) FILTER (WHERE p.amount > 0) v FROM ledger.journal jj JOIN ledger.postings p ON p.journal_id = jj.id
                     WHERE jj.idempotency_key = format('rent:wht:%s:%s', d.token, d.onchain_id)) j ON true
  WHERE d.token = p_token AND d.status = 'booked' AND coalesce(j.v, 0) <> d.sum_wht;
  -- Per period: withheld - remitted = the movement of the FBR payable account for that period.
  RETURN QUERY
  WITH per AS (
    SELECT d.period, sum(d.sum_wht)::numeric AS withheld FROM ops.distributions d WHERE d.token = p_token AND d.status = 'booked' GROUP BY d.period
  ), rem AS (
    SELECT r.period, sum(r.amount_paisa)::numeric AS remitted FROM tax.remittances r WHERE r.token = p_token AND r.status = 'approved' GROUP BY r.period
  ), led AS (
    -- Credits of the payable from rent:wht journals of booked distributions, by their period; debits from remittance journals, by theirs.
    SELECT d.period, -sum(p.amount) AS credited
    FROM ops.distributions d JOIN ledger.journal j ON j.id = d.wht_journal_id JOIN ledger.postings p ON p.journal_id = j.id
    JOIN ledger.accounts a ON a.id = p.account_id AND a.code = v_payable
    WHERE d.token = p_token GROUP BY d.period
  ), ledr AS (
    SELECT r.period, sum(p.amount) AS debited
    FROM tax.remittances r JOIN ledger.postings p ON p.journal_id = r.journal_id JOIN ledger.accounts a ON a.id = p.account_id AND a.code = v_payable
    WHERE r.token = p_token GROUP BY r.period
  ), allp AS (
    SELECT period FROM per UNION SELECT period FROM rem UNION SELECT period FROM led UNION SELECT period FROM ledr
  )
  SELECT 'tax.payable_mismatch', format('%s %s', v_payable, a.period),
         format('withheld %s - remitted %s = %s', coalesce(per.withheld, 0), coalesce(rem.remitted, 0), coalesce(per.withheld, 0) - coalesce(rem.remitted, 0)),
         format('ledger: credited %s - debited %s = %s', coalesce(led.credited, 0), coalesce(ledr.debited, 0), coalesce(led.credited, 0) - coalesce(ledr.debited, 0))
  FROM allp a LEFT JOIN per USING (period) LEFT JOIN rem USING (period) LEFT JOIN led USING (period) LEFT JOIN ledr USING (period)
  WHERE coalesce(per.withheld, 0) IS DISTINCT FROM coalesce(led.credited, 0) OR coalesce(rem.remitted, 0) IS DISTINCT FROM coalesce(ledr.debited, 0)
     OR coalesce(rem.remitted, 0) > coalesce(per.withheld, 0);
  -- The whole account: its balance equals withheld - remitted over all periods (nothing else posts to it).
  RETURN QUERY
  SELECT 'tax.payable_mismatch', v_payable,
         format('balance %s (withheld - remitted)', w.v - r.v), format('ledger balance %s', -coalesce(b.balance, 0))
  FROM (SELECT coalesce(sum(sum_wht), 0)::bigint v FROM ops.distributions WHERE token = p_token AND status = 'booked') w,
       (SELECT coalesce(sum(amount_paisa), 0)::bigint v FROM tax.remittances WHERE token = p_token AND status = 'approved') r,
       (SELECT (SELECT b0.balance FROM ledger.accounts a0 JOIN ledger.account_balances b0 ON b0.account_id = a0.id WHERE a0.code = v_payable) AS balance) b
  WHERE -coalesce(b.balance, 0) <> w.v - r.v;
  -- Withholding not remitted by the due date (placeholder due date, LEGAL/TAX TO CONFIRM).
  RETURN QUERY
  SELECT 'tax.wht_unremitted', format('%s %s', v_payable, d.period), format('remitted within %s days of booking', v_due),
         format('%s paisa outstanding since %s', pos.outstanding, ops.utc(min(d.booked_at)))
  FROM ops.distributions d CROSS JOIN LATERAL tax.period_position(p_token, d.period) pos
  WHERE d.token = p_token AND d.status = 'booked' AND pos.outstanding > 0
  GROUP BY d.period, pos.outstanding
  HAVING min(d.booked_at) + make_interval(days => v_due) < clock_timestamp();
END $$;

-- ================================================================== append-only (OT-11)
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON ops.audit FOR EACH ROW EXECUTE FUNCTION ops.forbid_change();
CREATE TRIGGER distribution_lines_append_only BEFORE UPDATE OR DELETE ON ops.distribution_lines FOR EACH ROW EXECUTE FUNCTION ops.forbid_change();
CREATE TRIGGER income_types_append_only BEFORE UPDATE OR DELETE ON tax.income_types FOR EACH ROW EXECUTE FUNCTION ops.forbid_change();
CREATE TRIGGER sealed_cnics_append_only BEFORE UPDATE OR DELETE ON tax.sealed_cnics FOR EACH ROW EXECUTE FUNCTION ops.forbid_change();
CREATE TRIGGER filer_checks_append_only BEFORE UPDATE OR DELETE ON tax.filer_checks FOR EACH ROW EXECUTE FUNCTION ops.forbid_change();
CREATE TRIGGER certificates_append_only BEFORE UPDATE OR DELETE ON tax.certificates FOR EACH ROW EXECUTE FUNCTION ops.forbid_change();
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ops.audit', 'ops.settings', 'ops.collections', 'ops.charges', 'ops.distributions', 'ops.distribution_lines',
                           'tax.income_types', 'tax.rates', 'tax.sealed_cnics', 'tax.filer_checks', 'tax.remittances', 'tax.certificates',
                           'tax.filing_exports', 'tax.export_tickets'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION ops.forbid_change()',
                   split_part(t, '.', 2) || '_no_truncate', t);
  END LOOP;
END $$;

-- ================================================================== officer names bound to sessions (OT-11, as 0016/0019)
CREATE TRIGGER collections_officer_binding BEFORE INSERT OR UPDATE ON ops.collections FOR EACH ROW EXECUTE FUNCTION compliance.bind_actor('proposed_by', 'decided_by');
CREATE TRIGGER charges_officer_binding BEFORE INSERT OR UPDATE ON ops.charges FOR EACH ROW EXECUTE FUNCTION compliance.bind_actor('proposed_by', 'decided_by');
CREATE TRIGGER distributions_officer_binding BEFORE INSERT OR UPDATE ON ops.distributions
  FOR EACH ROW EXECUTE FUNCTION compliance.bind_actor('calculated_by', 'attached_by', 'decided_by', 'booked_by');
CREATE TRIGGER rates_officer_binding BEFORE INSERT OR UPDATE ON tax.rates FOR EACH ROW EXECUTE FUNCTION compliance.bind_actor('proposed_by', 'decided_by');
CREATE TRIGGER remittances_officer_binding BEFORE INSERT OR UPDATE ON tax.remittances FOR EACH ROW EXECUTE FUNCTION compliance.bind_actor('proposed_by', 'decided_by');
CREATE TRIGGER filing_exports_officer_binding BEFORE INSERT OR UPDATE ON tax.filing_exports
  FOR EACH ROW EXECUTE FUNCTION compliance.bind_actor('requested_by', 'decided_by', 'generated_by');
CREATE TRIGGER export_tickets_officer_binding BEFORE INSERT ON tax.export_tickets FOR EACH ROW EXECUTE FUNCTION compliance.bind_actor('handle');
CREATE TRIGGER sealed_cnics_officer_binding BEFORE INSERT ON tax.sealed_cnics FOR EACH ROW EXECUTE FUNCTION compliance.bind_actor('enrolled_by');
CREATE TRIGGER filer_checks_officer_binding BEFORE INSERT ON tax.filer_checks FOR EACH ROW EXECUTE FUNCTION compliance.bind_actor('recorded_by');
CREATE TRIGGER certificates_officer_binding BEFORE INSERT ON tax.certificates FOR EACH ROW EXECUTE FUNCTION compliance.bind_actor('issued_by');

-- ================================================================== verification (OT-11)
CREATE FUNCTION ops.verify_audit() RETURNS TABLE (audit_id bigint, problem text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, ops AS $$
DECLARE
  a ops.audit;
  v_prev bytea := decode(repeat('00', 32), 'hex');
  r record;
BEGIN
  FOR a IN SELECT * FROM ops.audit ORDER BY id LOOP
    IF a.prev_hash <> v_prev THEN audit_id := a.id; problem := 'prev_hash does not match'; RETURN NEXT; END IF;
    IF a.hash <> ops.audit_digest(a.prev_hash, a.id, a.at, a.actor, a.action, a.detail) THEN
      audit_id := a.id; problem := 'content does not match its hash'; RETURN NEXT;
    END IF;
    v_prev := a.hash;
  END LOOP;
  FOR r IN
    SELECT format('collection %s', c.id) AS what FROM ops.collections c WHERE NOT EXISTS (
      SELECT 1 FROM ops.audit x WHERE x.action = 'collection.proposed' AND (x.detail->>'collection')::bigint = c.id AND x.detail->>'amount' = c.amount_paisa::text)
      OR (c.status <> 'proposed' AND NOT EXISTS (SELECT 1 FROM ops.audit x WHERE x.action = 'collection.decided' AND (x.detail->>'collection')::bigint = c.id
                                                 AND x.detail->>'status' = c.status AND (x.detail->>'journal')::bigint IS NOT DISTINCT FROM c.journal_id))
    UNION ALL
    SELECT format('charge %s', c.id) FROM ops.charges c WHERE NOT EXISTS (
      SELECT 1 FROM ops.audit x WHERE x.action = 'charge.proposed' AND (x.detail->>'charge')::bigint = c.id AND x.detail->>'amount' = c.amount_paisa::text
        AND x.detail->>'evidence' = encode(c.evidence_sha256, 'hex'))
      OR (c.status <> 'proposed' AND NOT EXISTS (SELECT 1 FROM ops.audit x WHERE x.action = 'charge.decided' AND (x.detail->>'charge')::bigint = c.id
                                                 AND x.detail->>'status' = c.status AND (x.detail->>'journal')::bigint IS NOT DISTINCT FROM c.journal_id))
    UNION ALL
    SELECT format('distribution calculation %s', d.id) FROM ops.distributions d WHERE NOT EXISTS (
      SELECT 1 FROM ops.audit x WHERE x.action = 'distribution.calculated' AND (x.detail->>'distribution')::bigint = d.id
        AND x.detail->>'gross' = d.sum_gross::text AND x.detail->>'wht' = d.sum_wht::text AND x.detail->>'net' = d.sum_net::text)
      OR (d.statement_hash IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ops.audit x WHERE x.action = 'distribution.attached'
            AND (x.detail->>'distribution')::bigint = d.id AND x.detail->>'statementHash' = d.statement_hash AND x.detail->>'taxScheduleHash' = d.tax_schedule_hash))
      OR (d.status IN ('approved', 'returned', 'booked') AND NOT EXISTS (SELECT 1 FROM ops.audit x WHERE x.action = 'distribution.decided'
            AND (x.detail->>'distribution')::bigint = d.id))
      OR (d.status = 'booked' AND NOT EXISTS (SELECT 1 FROM ops.audit x WHERE x.action = 'distribution.booked' AND (x.detail->>'distribution')::bigint = d.id
            AND (x.detail->>'distributionJournal')::bigint = d.distribution_journal_id))
    UNION ALL
    SELECT format('tax rate %s', t.id) FROM tax.rates t WHERE t.proposed_by <> 'migration:0021' AND (NOT EXISTS (
      SELECT 1 FROM ops.audit x WHERE x.action = 'rate.proposed' AND (x.detail->>'rate')::bigint = t.id AND (x.detail->>'ratePpm')::integer = t.rate_ppm
        AND x.detail->>'effectiveFrom' = t.effective_from::text)
      OR (t.state <> 'proposed' AND NOT EXISTS (SELECT 1 FROM ops.audit x WHERE x.action = 'rate.decided' AND (x.detail->>'rate')::bigint = t.id
                                                AND x.detail->>'state' = t.state)))
    UNION ALL
    SELECT format('remittance %s', t.id) FROM tax.remittances t WHERE NOT EXISTS (
      SELECT 1 FROM ops.audit x WHERE x.action = 'remittance.proposed' AND (x.detail->>'remittance')::bigint = t.id AND x.detail->>'amount' = t.amount_paisa::text)
      OR (t.status <> 'proposed' AND NOT EXISTS (SELECT 1 FROM ops.audit x WHERE x.action = 'remittance.decided' AND (x.detail->>'remittance')::bigint = t.id
                                                 AND x.detail->>'status' = t.status))
    UNION ALL
    SELECT format('sealed CNIC %s', s.id) FROM tax.sealed_cnics s WHERE NOT EXISTS (
      SELECT 1 FROM ops.audit x WHERE x.action = 'cnic.sealed' AND (x.detail->>'sealed')::bigint = s.id AND x.detail->>'subject' = s.subject_id::text)
    UNION ALL
    SELECT format('filer check %s', f.id) FROM tax.filer_checks f WHERE NOT EXISTS (
      SELECT 1 FROM ops.audit x WHERE x.action = 'filer.checked' AND (x.detail->>'check')::bigint = f.id AND x.detail->>'status' = f.status)
    UNION ALL
    SELECT format('filing export %s', e.id) FROM tax.filing_exports e WHERE NOT EXISTS (
      SELECT 1 FROM ops.audit x WHERE x.action = 'export.requested' AND (x.detail->>'export')::bigint = e.id)
      OR (e.status IN ('approved', 'rejected', 'generated') AND NOT EXISTS (SELECT 1 FROM ops.audit x WHERE x.action = 'export.decided'
            AND (x.detail->>'export')::bigint = e.id))
      OR (e.status = 'generated' AND NOT EXISTS (SELECT 1 FROM ops.audit x WHERE x.action = 'export.generated' AND (x.detail->>'export')::bigint = e.id
            AND x.detail->>'sha256' = encode(e.file_sha256, 'hex')))
    UNION ALL
    SELECT format('certificate %s', c.id) FROM tax.certificates c WHERE NOT EXISTS (
      SELECT 1 FROM ops.audit x WHERE x.action = 'certificate.issued' AND (x.detail->>'certificate')::bigint = c.id
        AND x.detail->>'sha256' = encode(c.content_sha256, 'hex'))
  LOOP
    audit_id := NULL; problem := r.what || ' has no matching audit entry'; RETURN NEXT;
  END LOOP;
END $$;

-- ================================================================== portal (admin.*): role and permissions
INSERT INTO admin.roles (role, description) VALUES
  ('tax_officer', 'Tax: withholding rates, filer status, FBR filing exports (two officers)');
INSERT INTO admin.role_conflicts (a, b, reason) VALUES
  ('admin', 'tax_officer', 'administrators manage officers only and never take tax decisions'),
  ('auditor', 'tax_officer', 'auditors are read-only and independent of everyone they audit'),
  ('tax_officer', 'trustee_officer', 'trustee officers belong to the independent trustee and hold no platform role'),
  ('ops_maker', 'tax_officer', 'whoever prepares a distribution never sets the tax rates it uses'),
  ('compliance_officer', 'tax_officer', 'least privilege: identity reviews and tax filing (which unseals CNICs) stay with different people'),
  ('legal_officer', 'tax_officer', 'the legal reviewer is independent of every other duty in a case');
INSERT INTO admin.role_permissions (role, permission) VALUES
  ('ops_maker', 'operations.read'), ('ops_checker', 'operations.read'), ('tax_officer', 'operations.read'), ('trustee_officer', 'operations.read'),
  ('auditor', 'operations.read'),
  ('ops_maker', 'operations.request'),
  ('ops_checker', 'operations.decide'),
  ('tax_officer', 'tax.read'), ('auditor', 'tax.read'),
  ('tax_officer', 'tax.decide'),
  ('tax_officer', 'tax.export');

DO $$
BEGIN
  EXECUTE format('CREATE OR REPLACE FUNCTION admin.expected_role_matrix_digest() RETURNS text LANGUAGE sql IMMUTABLE AS %L',
                 format('SELECT %L::text', admin.role_matrix_digest()));
END $$;

-- ------------------------------------------------------------------ reads (operations.read, tax.read)
/** Periods with any operations record, newest first, with their totals and calculation state. */
CREATE FUNCTION admin.operations_periods(p_session bytea) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'operations.read');
BEGIN
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('token', p.token, 'period', p.period,
      'collected', t.collected::text, 'distributable', t.distributable_gross::text, 'pending', t.pending,
      'distribution', (SELECT jsonb_build_object('id', d.id, 'status', d.status) FROM ops.distributions d
                       WHERE d.token = p.token AND d.period = p.period AND d.status <> 'returned' LIMIT 1))
      ORDER BY p.period DESC, p.token)
    FROM (SELECT token, period FROM ops.collections UNION SELECT token, period FROM ops.charges UNION SELECT token, period FROM ops.distributions) p
    CROSS JOIN LATERAL ops.period_totals(p.token, p.period) t), '[]'::jsonb);
END $$;

CREATE FUNCTION admin.operations_statement(p_session bytea, p_token text, p_period text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'operations.read');
BEGIN
  IF NOT ops.is_address(p_token) OR NOT ops.is_period(p_period) THEN RETURN NULL; END IF;
  RETURN ops.operating_statement(p_token, p_period) || jsonb_build_object('locked',
    EXISTS (SELECT 1 FROM ops.distributions d WHERE d.token = p_token AND d.period = p_period AND d.status <> 'returned'));
END $$;

CREATE FUNCTION admin.operations_charge(p_session bytea, p_id bigint) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'operations.read');
  v_handle text := admin.handle_of(v_me);
  c ops.charges;
  v_base text[] := '{}';
  v_limit bigint := (ops.setting('expense_ops_limit_paisa'))::text::bigint;
BEGIN
  SELECT * INTO c FROM ops.charges WHERE id = p_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF NOT admin.has_permission(p_session, 'operations.decide') THEN v_base := v_base || 'Only an operations checker decides charges.'::text; END IF;
  IF c.status <> 'proposed' THEN v_base := v_base || format('The charge is %s.', c.status); END IF;
  IF c.proposed_by = v_handle THEN v_base := v_base || 'You proposed it: a different officer decides (maker-checker).'::text; END IF;
  IF EXISTS (SELECT 1 FROM ops.distributions d WHERE d.token = c.token AND d.period = c.period AND d.status <> 'returned') THEN
    v_base := v_base || 'The period is locked by a distribution calculation.'::text;
  END IF;
  RETURN jsonb_build_object('id', c.id, 'token', c.token, 'period', c.period, 'kind', c.kind, 'feeType', c.fee_type, 'payee', c.payee,
    'description', c.description, 'amount', c.amount_paisa::text, 'evidence', encode(c.evidence_sha256, 'hex'), 'status', c.status,
    'proposedBy', c.proposed_by, 'proposedAt', admin.utc(c.proposed_at), 'decidedBy', c.decided_by, 'decisionReason', c.decision_reason,
    'decidedAt', admin.utc(c.decided_at), 'journal', c.journal_id, 'digest', encode(ops.charge_digest(c.id), 'hex'),
    'aboveLimit', c.kind IN ('expense', 'fee') AND c.amount_paisa > v_limit, 'limit', v_limit::text,
    'blockers', jsonb_build_object('approve', to_jsonb(v_base || CASE WHEN c.kind IN ('expense', 'fee') AND c.amount_paisa > v_limit
                                     THEN ARRAY['Above the operations limit: the trustee approves it (trustee portal, Step 6d).'] ELSE '{}'::text[] END),
                                   'reject', to_jsonb(v_base)));
END $$;

CREATE FUNCTION admin.operations_distribution(p_session bytea, p_id bigint) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'operations.read');
  v_handle text := admin.handle_of(v_me);
  d ops.distributions;
  v_base text[] := '{}';
  v_approve text[] := '{}';
BEGIN
  SELECT * INTO d FROM ops.distributions WHERE id = p_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF NOT admin.has_permission(p_session, 'operations.decide') THEN v_base := v_base || 'Only an operations checker decides distributions.'::text; END IF;
  IF d.status NOT IN ('calculated', 'attached') THEN v_base := v_base || format('The distribution is %s.', d.status); END IF;
  IF d.calculated_by = v_handle OR d.attached_by IS NOT DISTINCT FROM v_handle THEN
    v_base := v_base || 'You prepared it: a different officer decides (maker-checker).'::text;
  END IF;
  IF d.status = 'calculated' THEN v_approve := v_approve || 'The statement is not attached yet (operations service).'::text; END IF;
  IF d.placeholder_lines > 0 AND (ops.setting('allow_placeholder_rates'))::text <> 'true' THEN
    v_approve := v_approve || 'Uses PLACEHOLDER tax rates (LEGAL/TAX TO CONFIRM): a tax officer must set confirmed rates.'::text;
  END IF;
  RETURN jsonb_build_object('id', d.id, 'token', d.token, 'period', d.period, 'recordDate', d.record_date, 'recordBlock', d.record_block,
    'incomeType', d.income_type, 'collected', d.collected::text, 'expenses', d.expenses::text, 'fees', d.fees::text,
    'reserveContribution', d.reserve_contribution::text, 'reserveRelease', d.reserve_release::text,
    'gross', d.sum_gross::text, 'wht', d.sum_wht::text, 'net', d.sum_net::text, 'holders', d.holders, 'units', d.total_units::text,
    'flagged', d.flagged_lines, 'placeholder', d.placeholder_lines, 'status', d.status, 'root', d.merkle_root, 'statementHash', d.statement_hash,
    'taxScheduleHash', d.tax_schedule_hash, 'calculatedBy', d.calculated_by, 'calculatedAt', admin.utc(d.calculated_at), 'attachedBy', d.attached_by,
    'decidedBy', d.decided_by, 'decisionReason', d.decision_reason, 'decidedAt', admin.utc(d.decided_at), 'onchainId', d.onchain_id::text,
    'bookedAt', admin.utc(d.booked_at), 'digest', encode(ops.distribution_digest(d.id), 'hex'),
    'blockers', jsonb_build_object('approve', to_jsonb(v_base || v_approve), 'reject', to_jsonb(v_base)),
    'lines', coalesce((SELECT jsonb_agg(jsonb_build_object('wallet', l.wallet,
                 'subject', CASE WHEN l.subject_id IS NULL THEN NULL ELSE left(replace(l.subject_id::text, '-', ''), 8) END,
                 'units', l.units::text, 'gross', l.gross::text, 'status', l.filer_status, 'asOf', l.filer_as_of, 'flag', l.flag_reason,
                 'ratePpm', l.rate_ppm, 'placeholder', l.placeholder_rate, 'wht', l.wht::text, 'net', l.net::text) ORDER BY l.wallet)
               FROM (SELECT * FROM ops.distribution_lines WHERE distribution_id = d.id ORDER BY wallet LIMIT 2000) l), '[]'::jsonb));
END $$;

CREATE FUNCTION admin.tax_overview(p_session bytea) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'tax.read');
  v_handle text := admin.handle_of(v_me);
  v_decide boolean := admin.has_permission(p_session, 'tax.decide');
BEGIN
  RETURN jsonb_build_object(
    'at', admin.utc(clock_timestamp()), 'today', ops.pkt_today(),
    'allowPlaceholder', (ops.setting('allow_placeholder_rates'))::text = 'true',
    'incomeTypes', (SELECT jsonb_agg(jsonb_build_object('code', code, 'label', label, 'note', note) ORDER BY code) FROM tax.income_types),
    'rates', coalesce((SELECT jsonb_agg(jsonb_build_object('id', r.id, 'incomeType', r.income_type, 'status', r.status, 'ratePpm', r.rate_ppm,
               'effectiveFrom', r.effective_from, 'version', r.version, 'basis', r.basis, 'placeholder', r.placeholder, 'state', r.state,
               'proposedBy', r.proposed_by, 'proposedAt', admin.utc(r.proposed_at), 'decidedBy', r.decided_by, 'decidedAt', admin.utc(r.decided_at),
               'inForce', r.id = (SELECT f.id FROM tax.rate_for(r.income_type, r.status, ops.pkt_today()) f),
               'digest', encode(tax.rate_digest(r.id), 'hex'),
               'blockers', to_jsonb(CASE WHEN r.state <> 'proposed' THEN ARRAY[format('The rate is %s.', r.state)] ELSE '{}'::text[] END
                 || CASE WHEN NOT v_decide THEN ARRAY['Only a tax officer decides rates.'] ELSE '{}'::text[] END
                 || CASE WHEN r.proposed_by = v_handle THEN ARRAY['You proposed it: a different tax officer decides (maker-checker).'] ELSE '{}'::text[] END))
               ORDER BY r.income_type, r.status, r.effective_from DESC, r.version DESC) FROM tax.rates r), '[]'::jsonb),
    'filer', jsonb_build_object(
      'sealedCnics', (SELECT count(DISTINCT subject_id) FROM tax.sealed_cnics),
      'checks', coalesce((SELECT jsonb_object_agg(status, n) FROM (SELECT status, count(*) n FROM tax.filer_checks GROUP BY status) q), '{}'::jsonb),
      'lastCheck', (SELECT admin.utc(max(checked_at)) FROM tax.filer_checks)),
    'positions', coalesce((SELECT jsonb_agg(jsonb_build_object('token', p.token, 'period', p.period, 'withheld', x.withheld::text,
               'remitted', x.remitted::text, 'pending', x.pending::text, 'outstanding', x.outstanding::text) ORDER BY p.period DESC, p.token)
               FROM (SELECT DISTINCT token, period FROM ops.distributions WHERE status = 'booked') p
               CROSS JOIN LATERAL tax.period_position(p.token, p.period) x), '[]'::jsonb));
END $$;

CREATE FUNCTION admin.tax_exports(p_session bytea) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'tax.read');
BEGIN
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('id', e.id, 'token', e.token, 'from', e.from_period, 'to', e.to_period, 'status', e.status,
      'requestedBy', e.requested_by, 'requestedAt', admin.utc(e.requested_at), 'decidedBy', e.decided_by, 'generatedBy', e.generated_by,
      'generatedAt', admin.utc(e.generated_at), 'rows', e.row_count) ORDER BY e.id DESC)
    FROM (SELECT * FROM tax.filing_exports ORDER BY id DESC LIMIT 200) e), '[]'::jsonb);
END $$;

CREATE FUNCTION admin.tax_export(p_session bytea, p_id bigint) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'tax.read');
  v_handle text := admin.handle_of(v_me);
  v_export boolean := admin.has_permission(p_session, 'tax.export');
  e tax.filing_exports;
  v_hours integer := (ops.setting('export_valid_hours'))::text::integer;
  v_base text[] := '{}';
  v_gen text[] := '{}';
  v_lines integer;
  v_missing integer;
BEGIN
  SELECT * INTO e FROM tax.filing_exports WHERE id = p_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT count(*), count(*) FILTER (WHERE s.subject_id IS NULL OR NOT EXISTS (SELECT 1 FROM tax.sealed_cnics c WHERE c.subject_id = s.subject_id))
    INTO v_lines, v_missing FROM tax.export_scope(p_id) s;
  IF NOT v_export THEN v_base := v_base || 'Only a tax officer handles filing exports.'::text; END IF;
  IF e.status <> 'requested' THEN v_base := v_base || format('The export is %s.', e.status); END IF;
  IF e.requested_by = v_handle THEN v_base := v_base || 'You requested it: a different tax officer approves (two officers).'::text; END IF;
  IF e.status <> 'approved' THEN v_gen := v_gen || format('Only an approved export is generated (this one is %s).', e.status); END IF;
  IF NOT v_export THEN v_gen := v_gen || 'Only a tax officer handles filing exports.'::text; END IF;
  IF e.status = 'approved' AND v_handle <> e.requested_by AND v_handle IS DISTINCT FROM e.decided_by THEN
    v_gen := v_gen || 'Only the two officers of this export may generate it.'::text;
  END IF;
  IF e.status = 'approved' AND clock_timestamp() > e.decided_at + make_interval(hours => v_hours) THEN
    v_gen := v_gen || 'The approval expired: request the export again.'::text;
  END IF;
  IF v_missing > 0 THEN v_gen := v_gen || format('%s line(s) have no sealed CNIC (no partial export).', v_missing); END IF;
  RETURN jsonb_build_object('id', e.id, 'token', e.token, 'from', e.from_period, 'to', e.to_period, 'reason', e.reason, 'status', e.status,
    'requestedBy', e.requested_by, 'requestedAt', admin.utc(e.requested_at), 'decidedBy', e.decided_by, 'decisionReason', e.decision_reason,
    'decidedAt', admin.utc(e.decided_at), 'generatedBy', e.generated_by, 'generatedAt', admin.utc(e.generated_at),
    'fileSha256', encode(e.file_sha256, 'hex'), 'rows', e.row_count, 'linesInScope', v_lines, 'missingCnic', v_missing,
    'digest', encode(tax.export_digest(e.id), 'hex'),
    'blockers', jsonb_build_object('approve', to_jsonb(v_base), 'reject', to_jsonb(v_base), 'generate', to_jsonb(v_gen)));
END $$;

-- ------------------------------------------------------------------ writes
CREATE FUNCTION admin.propose_charge(p_session bytea, p_token text, p_period text, p_kind text, p_fee_type text, p_payee text,
                                     p_description text, p_amount bigint, p_evidence text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'operations.request');
  v_handle text := admin.handle_of(v_me);
  v_id bigint;
BEGIN
  IF p_evidence IS NULL OR p_evidence !~ '^[0-9a-f]{64}$' THEN
    RETURN admin.refuse(v_me, 'charge', 'new', 'propose', 'the SHA-256 of the evidence (64 hex characters) is required');
  END IF;
  BEGIN
    PERFORM admin.bind_officer(v_handle);
    v_id := ops.propose_charge(p_token, p_period, p_kind, p_fee_type, p_payee, p_description, p_amount, decode(p_evidence, 'hex'), v_handle);
    PERFORM admin.unbind_officer(v_handle);
  EXCEPTION WHEN SQLSTATE '23514' OR SQLSTATE '23505' OR SQLSTATE '42501' OR SQLSTATE '22023' OR SQLSTATE 'P0002' OR SQLSTATE '23503' THEN
    RETURN admin.refuse(v_me, 'charge', 'new', 'propose', SQLERRM);
  END;
  PERFORM admin.audit_append(v_me::text, 'operations.requested', jsonb_build_object('kind', 'charge', 'ref', v_id, 'action', 'propose'));
  RETURN jsonb_build_object('ok', true, 'id', v_id, 'status', 'proposed');
END $$;

CREATE FUNCTION admin.decide_charge(p_session bytea, p_id bigint, p_decision text, p_reason text, p_digest bytea) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'operations.decide');
  v_handle text := admin.handle_of(v_me);
  v_status text;
BEGIN
  PERFORM admin.require_step_up(p_session);
  PERFORM admin.check_decision(p_decision, p_reason);
  IF NOT EXISTS (SELECT 1 FROM ops.charges WHERE id = p_id) THEN RETURN admin.refuse(v_me, 'charge', p_id::text, p_decision, 'unknown charge'); END IF;
  IF ops.charge_digest(p_id) IS DISTINCT FROM p_digest THEN
    RETURN admin.refuse(v_me, 'charge', p_id::text, p_decision, 'the charge differs from what you reviewed: reload and check again');
  END IF;
  BEGIN
    PERFORM admin.bind_officer(v_handle);
    v_status := ops.decide_charge(p_id, v_handle, p_decision, p_reason);
    PERFORM admin.unbind_officer(v_handle);
  EXCEPTION WHEN SQLSTATE '23514' OR SQLSTATE '23505' OR SQLSTATE '42501' OR SQLSTATE '22023' OR SQLSTATE 'P0002' OR SQLSTATE '23503' THEN
    RETURN admin.refuse(v_me, 'charge', p_id::text, p_decision, SQLERRM);
  END;
  PERFORM admin.audit_append(v_me::text, 'operations.decided', jsonb_build_object('kind', 'charge', 'ref', p_id, 'action', p_decision,
    'result', v_status, 'digest', encode(p_digest, 'hex')));
  RETURN jsonb_build_object('ok', true, 'status', v_status);
END $$;

CREATE FUNCTION admin.decide_distribution(p_session bytea, p_id bigint, p_decision text, p_reason text, p_digest bytea) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'operations.decide');
  v_handle text := admin.handle_of(v_me);
  v_status text;
BEGIN
  PERFORM admin.require_step_up(p_session);
  PERFORM admin.check_decision(p_decision, p_reason);
  IF NOT EXISTS (SELECT 1 FROM ops.distributions WHERE id = p_id) THEN RETURN admin.refuse(v_me, 'distribution', p_id::text, p_decision, 'unknown distribution'); END IF;
  IF ops.distribution_digest(p_id) IS DISTINCT FROM p_digest THEN
    RETURN admin.refuse(v_me, 'distribution', p_id::text, p_decision, 'the distribution differs from what you reviewed: reload and check again');
  END IF;
  BEGIN
    PERFORM admin.bind_officer(v_handle);
    v_status := ops.decide_distribution(p_id, v_handle, p_decision, p_reason);
    PERFORM admin.unbind_officer(v_handle);
  EXCEPTION WHEN SQLSTATE '23514' OR SQLSTATE '23505' OR SQLSTATE '42501' OR SQLSTATE '22023' OR SQLSTATE 'P0002' THEN
    RETURN admin.refuse(v_me, 'distribution', p_id::text, p_decision, SQLERRM);
  END;
  PERFORM admin.audit_append(v_me::text, 'operations.decided', jsonb_build_object('kind', 'distribution', 'ref', p_id, 'action', p_decision,
    'result', v_status, 'digest', encode(p_digest, 'hex')));
  RETURN jsonb_build_object('ok', true, 'status', v_status);
END $$;

CREATE FUNCTION admin.propose_tax_rate(p_session bytea, p_income_type text, p_status text, p_rate_ppm integer, p_effective_from date, p_basis text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'tax.decide');
  v_handle text := admin.handle_of(v_me);
  v_id bigint;
BEGIN
  PERFORM admin.require_step_up(p_session);
  BEGIN
    PERFORM admin.bind_officer(v_handle);
    v_id := tax.propose_rate(p_income_type, p_status, p_rate_ppm, p_effective_from, p_basis, v_handle);
    PERFORM admin.unbind_officer(v_handle);
  EXCEPTION WHEN SQLSTATE '23514' OR SQLSTATE '23505' OR SQLSTATE '42501' OR SQLSTATE '22023' OR SQLSTATE 'P0002' OR SQLSTATE '23503' THEN
    RETURN admin.refuse(v_me, 'tax_rate', 'new', 'propose', SQLERRM);
  END;
  PERFORM admin.audit_append(v_me::text, 'tax.requested', jsonb_build_object('kind', 'tax_rate', 'ref', v_id, 'action', 'propose'));
  RETURN jsonb_build_object('ok', true, 'id', v_id, 'status', 'proposed');
END $$;

CREATE FUNCTION admin.decide_tax_rate(p_session bytea, p_id bigint, p_decision text, p_reason text, p_digest bytea) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'tax.decide');
  v_handle text := admin.handle_of(v_me);
  v_status text;
BEGIN
  PERFORM admin.require_step_up(p_session);
  PERFORM admin.check_decision(p_decision, p_reason);
  IF NOT EXISTS (SELECT 1 FROM tax.rates WHERE id = p_id) THEN RETURN admin.refuse(v_me, 'tax_rate', p_id::text, p_decision, 'unknown rate'); END IF;
  IF tax.rate_digest(p_id) IS DISTINCT FROM p_digest THEN
    RETURN admin.refuse(v_me, 'tax_rate', p_id::text, p_decision, 'the rate differs from what you reviewed: reload and check again');
  END IF;
  BEGIN
    PERFORM admin.bind_officer(v_handle);
    v_status := tax.decide_rate(p_id, v_handle, p_decision, p_reason);
    PERFORM admin.unbind_officer(v_handle);
  EXCEPTION WHEN SQLSTATE '23514' OR SQLSTATE '23505' OR SQLSTATE '42501' OR SQLSTATE '22023' OR SQLSTATE 'P0002' THEN
    RETURN admin.refuse(v_me, 'tax_rate', p_id::text, p_decision, SQLERRM);
  END;
  PERFORM admin.audit_append(v_me::text, 'tax.decided', jsonb_build_object('kind', 'tax_rate', 'ref', p_id, 'action', p_decision,
    'result', v_status, 'digest', encode(p_digest, 'hex')));
  RETURN jsonb_build_object('ok', true, 'status', v_status);
END $$;

CREATE FUNCTION admin.request_tax_export(p_session bytea, p_token text, p_from text, p_to text, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'tax.export');
  v_handle text := admin.handle_of(v_me);
  v_id bigint;
BEGIN
  PERFORM admin.require_step_up(p_session);
  BEGIN
    PERFORM admin.bind_officer(v_handle);
    v_id := tax.request_export(nullif(btrim(coalesce(p_token, '')), ''), p_from, p_to, p_reason, v_handle);
    PERFORM admin.unbind_officer(v_handle);
  EXCEPTION WHEN SQLSTATE '23514' OR SQLSTATE '23505' OR SQLSTATE '42501' OR SQLSTATE '22023' OR SQLSTATE 'P0002' THEN
    RETURN admin.refuse(v_me, 'tax_export', 'new', 'request', SQLERRM);
  END;
  PERFORM admin.audit_append(v_me::text, 'tax.requested', jsonb_build_object('kind', 'tax_export', 'ref', v_id, 'action', 'request'));
  RETURN jsonb_build_object('ok', true, 'id', v_id, 'status', 'requested');
END $$;

CREATE FUNCTION admin.decide_tax_export(p_session bytea, p_id bigint, p_decision text, p_reason text, p_digest bytea) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'tax.export');
  v_handle text := admin.handle_of(v_me);
  v_status text;
BEGIN
  PERFORM admin.require_step_up(p_session);
  PERFORM admin.check_decision(p_decision, p_reason);
  IF NOT EXISTS (SELECT 1 FROM tax.filing_exports WHERE id = p_id) THEN RETURN admin.refuse(v_me, 'tax_export', p_id::text, p_decision, 'unknown export'); END IF;
  IF tax.export_digest(p_id) IS DISTINCT FROM p_digest THEN
    RETURN admin.refuse(v_me, 'tax_export', p_id::text, p_decision, 'the export differs from what you reviewed: reload and check again');
  END IF;
  BEGIN
    PERFORM admin.bind_officer(v_handle);
    v_status := tax.decide_export(p_id, v_handle, p_decision, p_reason);
    PERFORM admin.unbind_officer(v_handle);
  EXCEPTION WHEN SQLSTATE '23514' OR SQLSTATE '23505' OR SQLSTATE '42501' OR SQLSTATE '22023' OR SQLSTATE 'P0002' THEN
    RETURN admin.refuse(v_me, 'tax_export', p_id::text, p_decision, SQLERRM);
  END;
  PERFORM admin.audit_append(v_me::text, 'tax.decided', jsonb_build_object('kind', 'tax_export', 'ref', p_id, 'action', p_decision,
    'result', v_status, 'digest', encode(p_digest, 'hex')));
  RETURN jsonb_build_object('ok', true, 'status', v_status);
END $$;

/** Issues the one-time ticket the portal hands to the tax service (step-up checked here). */
CREATE FUNCTION admin.issue_tax_export_ticket(p_session bytea, p_id bigint, p_ticket_hash bytea) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'tax.export');
  v_handle text := admin.handle_of(v_me);
  v_exp timestamptz;
BEGIN
  PERFORM admin.require_step_up(p_session);
  BEGIN
    PERFORM admin.bind_officer(v_handle);
    v_exp := tax.issue_export_ticket(p_id, v_handle, p_ticket_hash);
    PERFORM admin.unbind_officer(v_handle);
  EXCEPTION WHEN SQLSTATE '23514' OR SQLSTATE '23505' OR SQLSTATE '42501' OR SQLSTATE '22023' OR SQLSTATE 'P0002' THEN
    RETURN admin.refuse(v_me, 'tax_export', coalesce(p_id::text, 'none'), 'generate', SQLERRM);
  END;
  PERFORM admin.audit_append(v_me::text, 'tax.ticket', jsonb_build_object('kind', 'tax_export', 'ref', p_id,
    'ticket', left(encode(p_ticket_hash, 'hex'), 16)));
  RETURN jsonb_build_object('ok', true, 'expiresAt', admin.utc(v_exp));
END $$;

-- ================================================================== privileges
REVOKE ALL ON ALL TABLES IN SCHEMA ops FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA tax FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ops FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA tax FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA admin FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA admin FROM PUBLIC;

GRANT USAGE ON SCHEMA ops, tax TO pt_ops_operator, pt_ops_reader, pt_tax_service;
-- The operations service / operator CLI (operator names, never officer handles).
GRANT EXECUTE ON FUNCTION
  ops.propose_collection(text, bigint, integer, text, text),
  ops.decide_collection(bigint, text, text, text),
  ops.propose_charge(text, text, text, text, text, text, bigint, bytea, text),
  ops.decide_charge(bigint, text, text, text),
  ops.period_totals(text, text),
  ops.operating_statement(text, text),
  ops.calculate_distribution(text, text, date, bigint, text, text),
  ops.distribution_lines_of(bigint),
  ops.attach_statement(bigint, text, text, text, text, text, text),
  ops.decide_distribution(bigint, text, text, text),
  ops.book_distribution(bigint, text, numeric, text),
  tax.propose_remittance(text, text, bigint, text, text, text, date, text),
  tax.decide_remittance(bigint, text, text, text),
  tax.period_position(text, text),
  tax.certificate_data(uuid, integer),
  tax.issue_certificate(uuid, integer, text),
  tax.reconcile(text),
  ops.verify_audit()
TO pt_ops_operator;
GRANT SELECT ON ops.distributions, ops.distribution_lines, ops.collections, ops.charges, tax.rates, tax.income_types, tax.remittances,
  tax.certificates, tax.filing_exports TO pt_ops_operator, pt_ops_reader;
GRANT EXECUTE ON FUNCTION ops.period_totals(text, text), ops.operating_statement(text, text), tax.period_position(text, text), tax.reconcile(text),
  ops.verify_audit() TO pt_ops_reader;
-- The tax service: the only holder of the CNIC sealing key (ADR 0014).
GRANT EXECUTE ON FUNCTION
  tax.enrol_cnic(uuid, integer, jsonb, text),
  tax.atl_due(date, integer, text),
  tax.record_filer_check(uuid, text, date, text, bytea, text),
  tax.redeem_export_ticket(bytea, bigint),
  tax.complete_export(bytea, bigint, bytea, integer)
TO pt_tax_service;
-- Reconciliation reads the tax consistency checks.
GRANT USAGE ON SCHEMA ops, tax TO pt_recon_writer, pt_recon_reader;
GRANT EXECUTE ON FUNCTION tax.reconcile(text) TO pt_recon_writer, pt_recon_reader;
GRANT SELECT ON ops.distributions TO pt_recon_writer, pt_recon_reader;
GRANT EXECUTE ON FUNCTION ops.verify_audit() TO pt_admin_auditor;

GRANT EXECUTE ON FUNCTION
  admin.operations_periods(bytea),
  admin.operations_statement(bytea, text, text),
  admin.operations_charge(bytea, bigint),
  admin.operations_distribution(bytea, bigint),
  admin.tax_overview(bytea),
  admin.tax_exports(bytea),
  admin.tax_export(bytea, bigint),
  admin.propose_charge(bytea, text, text, text, text, text, text, bigint, text),
  admin.decide_charge(bytea, bigint, text, text, bytea),
  admin.decide_distribution(bytea, bigint, text, text, bytea),
  admin.propose_tax_rate(bytea, text, text, integer, date, text),
  admin.decide_tax_rate(bytea, bigint, text, text, bytea),
  admin.request_tax_export(bytea, text, text, text, text),
  admin.decide_tax_export(bytea, bigint, text, text, bytea),
  admin.issue_tax_export_ticket(bytea, bigint, bytea)
TO pt_admin_portal;

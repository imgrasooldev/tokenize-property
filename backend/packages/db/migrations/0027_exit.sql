-- Spec S-05 (task T-025, spec S-05 sections 14-16): property sale / scheme wind-up exit, the final
-- distribution, redemption burns through IssuanceGuard, closure, and the phase-0 queue of investor
-- redemption requests, with the PT Control and website functions for them.
--
-- Applies on top of 0001-0026. Nothing earlier changes except where named below (additive: one tax
-- income type with placeholder rates, a register entry source, a signer co-sign kind, the step-up
-- actions, the role matrix and the audit viewer).
--
-- Safety properties enforced by the database itself (schema exit, plus admin.* and webauth.* wrappers):
--   EX-DB-1  Cases follow the S-05 state machine (exit.transitions) through an append-only event log
--            (trigger); the identity of a case never changes; facts recorded by a decision are set
--            once; one live case per token; cases are never deleted.
--   EX-DB-2  Decisions (X1-X12, X18 and the held-line release HR) are proposed by an operations maker
--            with their evidence hashes and approved by one officer per capacity of
--            exit.decision_kinds (operations checker, compliance, legal, trustee): different
--            officers, never the proposer, never an officer who declared a conflict on the case;
--            officer handles only inside PT Control (session, step-up, digest). One rejection ends a
--            decision. Every guard is checked again when the last capacity approves.
--   EX-DB-3  Money: proceeds only from imported bank statement credits on the trustee escrow (or a
--            suspense credit), once per line, maker-checker, journal exit:<token>:deposit /
--            exit:<token>:proceeds:<n> into exit:pool:<token>; the waterfall (maker, operations
--            checker, trustee officer) posts every line's journal in one transaction and never pays
--            out more than the pool holds; waterfall payments come from bank statement debits on the
--            trustee escrow (maker-checker, exit:<token>:waterfall:<line>:paid).
--   EX-DB-4  The final distribution is computed here from the read model at the record block (S-03
--            arithmetic: largest remainder, WHT round half up, net = gross - WHT, integer paisa) from
--            the exit pool; the statement and tax schedule are checked line by line; the trustee
--            pre-checks the root, an operations checker approves (neither the calculator nor the
--            attacher). Booking (rent:wht / rent:distribution from exit:pool) only for the finalized
--            on-chain distribution with the same root, total and statement hash.
--   EX-DB-5  The redemption batch has one line per holder wallet at the record block with exactly
--            its balance there (sum = supply at the record block); refIds are distinct and unused;
--            maker, operations checker, trustee officer. Burns are enqueued only for eligible lines
--            under the case's burn rule (after_payment by default: only a paid line, a nothing-to-pay
--            line or a released held line). exit.burn_allowed() answers the signing service for the
--            new kind issuance.burn: exactly the enqueued command, case Redeeming, line eligible now,
--            not burned yet (deny by default).
--   EX-DB-6  exit.tick() follows the read model: published / rejected / finalized distribution
--            (X13-X15), burns seen (subscriptions V19 -> redeemed and trustee register entries),
--            supply 0 + payout recorded (X17). Closure (X18) needs every money and unit fact closed.
--   EX-DB-7  Redemption requests (phase 0, S-05 section 15): windows proposed and approved by two
--            operations officers, price frozen from the window's NAV and discount, limits on the
--            holder's free balance, one live request per investor per window, the window cap; the
--            website reaches them only through session-bound webauth.web_* wrappers with a step-up;
--            the outcome is maker-checker. No money or unit moves.
--   EX-DB-8  Every row is written by a function that also appends to the hash-chained exit.audit
--            (UTC digests); exit.verify_audit() re-checks the chain and finds rows written around it.
--            Free text never carries a CNIC, IBAN or phone number.

CREATE SCHEMA IF NOT EXISTS exit;
REVOKE ALL ON SCHEMA exit FROM PUBLIC;

DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['pt_exit_operator', 'pt_exit_reader'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN', r);
    END IF;
  END LOOP;
END $$;

-- ================================================================== helpers
CREATE FUNCTION exit.forbid_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'exit records are append-only: % on %.% is not allowed', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE FUNCTION exit.fail(p_code text, p_message text) RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION '%', p_message USING ERRCODE = p_code;
END $$;

CREATE FUNCTION exit.utc(p timestamptz) RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT to_char(p AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
$$;

CREATE FUNCTION exit.is_address(p text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT p IS NOT NULL AND length(p) = 42 AND p ~ '^0x[0-9a-f]+$'
$$;

CREATE FUNCTION exit.is_hash(p text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT p IS NOT NULL AND length(p) = 66 AND p ~ '^0x[0-9a-f]+$'
$$;

/** A SHA-256 given as 64 lower-case hex digits (evidence of a document); raises otherwise. */
CREATE FUNCTION exit.sha(p text, p_what text) RETURNS bytea
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
BEGIN
  IF p IS NULL OR length(p) <> 64 OR p !~ '^[0-9a-f]+$' THEN
    PERFORM exit.fail('22023', format('the SHA-256 of the %s (64 lower-case hex digits) is required', p_what));
  END IF;
  RETURN decode(p, 'hex');
END $$;

/** Today in Pakistan (PKT, UTC+5). */
CREATE FUNCTION exit.pkt_today() RETURNS date
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT (clock_timestamp() AT TIME ZONE 'Asia/Karachi')::date
$$;

/** A valid actor name; an officer's handle only inside the portal (bound to their checked session). */
CREATE FUNCTION exit.check_actor(p_actor text) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, exit AS $$
BEGIN
  IF p_actor IS NULL OR length(p_actor) NOT BETWEEN 2 AND 100 OR p_actor !~ '^[A-Za-z0-9][A-Za-z0-9@._:+-]*$' THEN
    PERFORM exit.fail('22023', 'an actor name of 2 to 100 characters (letters, digits, @._:+-) is required');
  END IF;
  PERFORM admin.guard_officer_name(p_actor, 'exit actor');
END $$;

CREATE FUNCTION exit.check_text(p text, p_min integer, p_max integer, p_what text DEFAULT 'text') RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
BEGIN
  IF NOT compliance.free_text_ok(p, p_min, p_max) THEN
    PERFORM exit.fail('22023', format('a %s of %s to %s characters is required (never a CNIC, IBAN or phone number)', p_what, p_min, p_max));
  END IF;
END $$;

/** The balance of a ledger account on its normal side (a liability's credit balance as a positive number). */
CREATE FUNCTION exit.balance(p_code text) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, exit AS $$
  SELECT coalesce((SELECT CASE WHEN b.normal_side = 'credit' THEN -b.balance ELSE b.balance END FROM ledger.balances b WHERE b.code = p_code), 0)::bigint
$$;

CREATE FUNCTION exit.pool(p_token text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT 'exit:pool:' || p_token $$;
CREATE FUNCTION exit.closure_reserve(p_token text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT 'reserve:' || p_token || ':closure' $$;

/** A contract of the token's deployment in the read model (role as chain.contracts names it). */
CREATE FUNCTION exit.contract_of(p_token text, p_role text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, exit AS $$
  SELECT c.address FROM chain.tokens t JOIN chain.contracts c ON c.deployment = t.deployment AND c.role = p_role WHERE t.token = p_token LIMIT 1
$$;

/** The indexer's cursor block of the token's deployment (NULL if unknown). */
CREATE FUNCTION exit.cursor_of(p_token text) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, exit AS $$
  SELECT c.block_number FROM chain.tokens t JOIN chain.cursors c ON c.deployment = t.deployment WHERE t.token = p_token
$$;

/** Balances per holder at a block, from the Transfer events in the read model. */
CREATE FUNCTION exit.holders_at(p_token text, p_block bigint)
RETURNS TABLE (wallet text, units numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, exit AS $$
  WITH moves AS (
    SELECT x.to_addr AS holder, x.amount FROM chain.transfers x WHERE x.token = p_token AND x.block_number <= p_block
    UNION ALL
    SELECT x.from_addr, -x.amount FROM chain.transfers x WHERE x.token = p_token AND x.block_number <= p_block
  )
  SELECT holder, sum(amount) FROM moves WHERE holder <> '0x0000000000000000000000000000000000000000' GROUP BY holder HAVING sum(amount) > 0
$$;

-- ================================================================== audit (EX-DB-8)
CREATE TABLE exit.audit (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at        timestamptz NOT NULL,
  actor     text NOT NULL CHECK (length(actor) BETWEEN 1 AND 100),
  action    text NOT NULL CHECK (action ~ '^[a-z][a-z_.]{2,63}$'),
  detail    jsonb NOT NULL CHECK (jsonb_typeof(detail) = 'object' AND octet_length(detail::text) <= 8192),
  prev_hash bytea NOT NULL CHECK (length(prev_hash) = 32),
  hash      bytea NOT NULL UNIQUE CHECK (length(hash) = 32)
);
CREATE INDEX audit_action_idx ON exit.audit (action, id);

CREATE FUNCTION exit.audit_digest(p_prev bytea, p_id bigint, p_at timestamptz, p_actor text, p_action text, p_detail jsonb)
RETURNS bytea LANGUAGE sql STABLE SET search_path = pg_catalog, exit AS $$
  SELECT sha256(p_prev || convert_to('pt-exit-audit-v1' || jsonb_build_array(p_id, exit.utc(p_at), p_actor, p_action, p_detail)::text, 'UTF8'))
$$;

CREATE FUNCTION exit.audit_append(p_actor text, p_action text, p_detail jsonb)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, exit AS $$
DECLARE
  v_prev bytea;
  v_id bigint;
  v_at timestamptz := date_trunc('microseconds', clock_timestamp());
BEGIN
  PERFORM pg_advisory_xact_lock(586586270);
  SELECT hash INTO v_prev FROM exit.audit ORDER BY id DESC LIMIT 1;
  v_prev := coalesce(v_prev, decode(repeat('00', 32), 'hex'));
  v_id := nextval(pg_get_serial_sequence('exit.audit', 'id'));
  INSERT INTO exit.audit (id, at, actor, action, detail, prev_hash, hash)
  OVERRIDING SYSTEM VALUE
  VALUES (v_id, v_at, left(p_actor, 100), p_action, coalesce(p_detail, '{}'::jsonb), v_prev,
          exit.audit_digest(v_prev, v_id, v_at, left(p_actor, 100), p_action, coalesce(p_detail, '{}'::jsonb)));
  RETURN v_id;
END $$;

-- ================================================================== settings (LEGAL TO CONFIRM values)
CREATE TABLE exit.settings (
  key   text PRIMARY KEY CHECK (key ~ '^[a-z][a-z_]{2,63}$'),
  value jsonb NOT NULL,
  note  text NOT NULL CHECK (length(note) BETWEEN 10 AND 300)
);
INSERT INTO exit.settings (key, value, note) VALUES
  ('vote_quorum_ppm', '500000', 'EX-3 default proposal (LEGAL TO CONFIRM): votes cast (for, against, abstain) at least 50 % of the eligible units.'),
  ('vote_majority_ppm', '750000', 'EX-3 default proposal (LEGAL TO CONFIRM): votes for at least 75 % of the votes for and against.'),
  ('vote_notice_days', '21', 'EX-3: the vote result may be recorded only this many days after the notice (vote opened).'),
  ('record_notice_days', '14', 'EX-12: at least this many calendar days between the record-date announcement and the record date (10 business days).'),
  ('default_burn_rule', '"after_payment"', 'S-05 section 14.1 (Q-5): burn a holder only after the final line is paid, unless the batch says after_finalization.'),
  ('redeeming_sla_hours', '72', 'S-05 section 7: supply not zero this long after Redeeming started becomes a blocking finding (exit.supply_not_zero).'),
  ('window_cap_ppm', '100000', 'EX-43: a redemption window accepts requests for at most this share of the supply (10 %).'),
  ('window_max_discount_ppm', '200000', 'EX-42: the discount on NAV of a redemption window is at most 20 %.'),
  ('window_max_days', '31', 'EX-41: a redemption window is open at most this many days.');

CREATE FUNCTION exit.setting(p_key text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, exit AS $$
  SELECT value FROM exit.settings WHERE key = p_key
$$;
CREATE FUNCTION exit.setting_int(p_key text) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, exit AS $$
  SELECT (value #>> '{}')::bigint FROM exit.settings WHERE key = p_key
$$;

CREATE FUNCTION exit.setting_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, exit AS $$
BEGIN
  IF TG_OP <> 'UPDATE' OR NEW.key <> OLD.key THEN
    RAISE EXCEPTION 'exit settings are only ever updated in place' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM exit.audit_append('db:' || session_user, 'setting.changed', jsonb_build_object('key', NEW.key, 'from', OLD.value, 'to', NEW.value));
  RETURN NEW;
END $$;
CREATE TRIGGER settings_audited BEFORE UPDATE OR DELETE ON exit.settings FOR EACH ROW EXECUTE FUNCTION exit.setting_changed();

-- ================================================================== tax: the income type of a final distribution (EX-13)
INSERT INTO tax.income_types (code, label, note) VALUES
  ('exit_distribution', 'Final distribution at exit (sale or wind-up)',
   'LEGAL/TAX TO CONFIRM: capital gain or dividend treatment of an exit distribution, section and rates (S-05 EX-13).');
INSERT INTO tax.rates (income_type, status, rate_ppm, effective_from, version, basis, placeholder, state, proposed_by, decided_by, decision_reason, decided_at) VALUES
  ('exit_distribution', 'filer',     150000, DATE '2025-07-01', 1, 'PLACEHOLDER - LEGAL/TAX TO CONFIRM: exit distribution, filer on the ATL (copy of the S-03 placeholder)', true, 'active', 'migration:0027', 'migration:0027:seed', 'placeholder seed, must be replaced by confirmed rates', clock_timestamp()),
  ('exit_distribution', 'non_filer', 300000, DATE '2025-07-01', 1, 'PLACEHOLDER - LEGAL/TAX TO CONFIRM: exit distribution, not on the ATL (copy of the S-03 placeholder)', true, 'active', 'migration:0027', 'migration:0027:seed', 'placeholder seed, must be replaced by confirmed rates', clock_timestamp()),
  ('exit_distribution', 'exempt',         0, DATE '2025-07-01', 1, 'PLACEHOLDER - LEGAL/TAX TO CONFIRM: exemption certificate holder (no exemption path is built yet)', true, 'active', 'migration:0027', 'migration:0027:seed', 'placeholder seed, must be replaced by confirmed rates', clock_timestamp());
-- The seeded rates are in the operations audit like every other rate (ops.verify_audit, 0021 OT-11).
DO $$
DECLARE
  r tax.rates;
BEGIN
  FOR r IN SELECT * FROM tax.rates WHERE income_type = 'exit_distribution' ORDER BY id LOOP
    PERFORM ops.audit_append('migration:0027', 'rate.proposed', jsonb_build_object('rate', r.id, 'incomeType', r.income_type, 'status', r.status,
      'ratePpm', r.rate_ppm, 'effectiveFrom', r.effective_from::text, 'placeholder', r.placeholder));
    PERFORM ops.audit_append('migration:0027:seed', 'rate.decided', jsonb_build_object('rate', r.id, 'decision', 'approve', 'state', r.state,
      'proposedBy', r.proposed_by));
  END LOOP;
END $$;

-- ================================================================== the trustee register learns redemptions (0023 T-4)
ALTER TABLE trustee.register_entries DROP CONSTRAINT register_entries_source_check;
ALTER TABLE trustee.register_entries ADD CONSTRAINT register_entries_source_check CHECK (source IN ('offering', 'adjustment', 'redemption'));

-- ================================================================== cases and the state machine (EX-DB-1)
CREATE FUNCTION exit.live_states() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['proposed', 'vote_open', 'trustee_review', 'buyer_dd', 'contracted', 'completed_sale', 'waterfall', 'final_published',
               'final_finalized', 'redeeming', 'paid_out']
$$;

CREATE TABLE exit.cases (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  token                text NOT NULL CHECK (exit.is_address(token)),
  property_id          uuid,
  state                text NOT NULL DEFAULT 'proposed'
                       CHECK (state IN ('proposed', 'vote_open', 'trustee_review', 'buyer_dd', 'contracted', 'completed_sale', 'waterfall',
                                        'final_published', 'final_finalized', 'redeeming', 'paid_out', 'closed', 'rejected', 'sale_collapsed')),
  rationale            text NOT NULL CHECK (compliance.free_text_ok(rationale, 20, 2000)),
  offer_price_paisa    bigint NOT NULL CHECK (offer_price_paisa > 0 AND offer_price_paisa <= 100000000000000000),
  valuation_a_paisa    bigint NOT NULL CHECK (valuation_a_paisa > 0),
  valuation_a_sha      bytea NOT NULL CHECK (length(valuation_a_sha) = 32),
  valuation_b_paisa    bigint NOT NULL CHECK (valuation_b_paisa > 0),
  valuation_b_sha      bytea NOT NULL CHECK (length(valuation_b_sha) = 32),
  costs_paisa          bigint NOT NULL CHECK (costs_paisa >= 0),
  vote_required        boolean NOT NULL,
  opened_by            text NOT NULL CHECK (length(opened_by) BETWEEN 2 AND 100),
  opened_at            timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  updated_at           timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  -- Facts recorded by decisions and maker steps: each set once.
  ic_minutes_sha       bytea CHECK (length(ic_minutes_sha) = 32),
  vote_notice_sha      bytea CHECK (length(vote_notice_sha) = 32),
  vote_record_block    bigint CHECK (vote_record_block >= 0),
  vote_opened_at       timestamptz,
  eligible_units       numeric(78,0) CHECK (eligible_units > 0),
  votes_for            numeric(78,0) CHECK (votes_for >= 0),
  votes_against        numeric(78,0) CHECK (votes_against >= 0),
  votes_abstain        numeric(78,0) CHECK (votes_abstain >= 0),
  ballots_sha          bytea CHECK (length(ballots_sha) = 32),
  lower_price_approved boolean,
  legal_advice_sha     bytea CHECK (length(legal_advice_sha) = 32),
  buyer_ref            text CHECK (buyer_ref ~ '^[A-Za-z0-9][A-Za-z0-9:._-]{2,63}$'),
  buyer_checks_sha     bytea CHECK (length(buyer_checks_sha) = 32),
  agreement_sha        bytea CHECK (length(agreement_sha) = 32),
  sale_price_paisa     bigint CHECK (sale_price_paisa > 0 AND sale_price_paisa <= 100000000000000000),
  deposit_paisa        bigint CHECK (deposit_paisa >= 0),
  cp_deadline          date,
  deed_sha             bytea CHECK (length(deed_sha) = 32),
  deposit_treatment    text CHECK (deposit_treatment IN ('forfeit', 'refund', 'none')),
  collapse_sha         bytea CHECK (length(collapse_sha) = 32),
  record_date          date,
  record_announced_at  timestamptz,
  record_notice_sha    bytea CHECK (length(record_notice_sha) = 32),
  redeeming_at         timestamptz,
  final_accounts_sha   bytea CHECK (length(final_accounts_sha) = 32),
  windup_sha           bytea CHECK (length(windup_sha) = 32),
  closed_at            timestamptz,
  CHECK (votes_for IS NULL OR votes_for + votes_against + votes_abstain <= eligible_units),
  CHECK ((record_date IS NULL) = (record_announced_at IS NULL) AND (record_date IS NULL) = (record_notice_sha IS NULL)),
  CHECK ((state = 'closed') = (closed_at IS NOT NULL))
);
CREATE UNIQUE INDEX cases_one_live ON exit.cases (token) WHERE state IN ('proposed', 'vote_open', 'trustee_review', 'buyer_dd', 'contracted',
  'completed_sale', 'waterfall', 'final_published', 'final_finalized', 'redeeming', 'paid_out');

CREATE TABLE exit.transitions (
  code       text PRIMARY KEY CHECK (code ~ '^X[0-9]{1,2}$'),
  from_state text NOT NULL,
  to_state   text NOT NULL,
  system     boolean NOT NULL,
  note       text NOT NULL CHECK (length(note) BETWEEN 5 AND 200)
);
INSERT INTO exit.transitions (code, from_state, to_state, system, note) VALUES
  ('X1', 'proposed', 'rejected', false, 'investment committee rejects'),
  ('X2', 'proposed', 'vote_open', false, 'committee recommends, vote notice sent'),
  ('X3', 'proposed', 'trustee_review', false, 'committee recommends, the unit rights need no vote'),
  ('X4', 'vote_open', 'rejected', false, 'vote fails'),
  ('X5', 'vote_open', 'trustee_review', false, 'vote passes'),
  ('X6', 'trustee_review', 'rejected', false, 'trustee refuses'),
  ('X7', 'trustee_review', 'buyer_dd', false, 'trustee approves the sale'),
  ('X8', 'buyer_dd', 'sale_collapsed', false, 'buyer fails the checks'),
  ('X9', 'buyer_dd', 'contracted', false, 'agreement signed, deposit due'),
  ('X10', 'contracted', 'sale_collapsed', false, 'buyer default or condition precedent failed'),
  ('X11', 'contracted', 'completed_sale', false, 'deed registered, full price received'),
  ('X12', 'completed_sale', 'waterfall', false, 'proceeds reconciled'),
  ('X13', 'waterfall', 'final_published', true, 'final distribution published on chain'),
  ('X14', 'final_published', 'waterfall', true, 'final distribution rejected on chain'),
  ('X15', 'final_published', 'final_finalized', true, 'challenge window over, finalized on chain'),
  ('X16', 'final_finalized', 'redeeming', false, 'final distribution booked, burns enqueued'),
  ('X17', 'redeeming', 'paid_out', true, 'supply zero, payout recorded on chain'),
  ('X18', 'paid_out', 'closed', false, 'held amounts resolved, trust wound up');

/** Decisions and the capacities that approve them (S-05 section 14.2); HR changes no state. */
CREATE TABLE exit.decision_kinds (
  code        text PRIMARY KEY CHECK (code ~ '^(X[0-9]{1,2}|HR)$'),
  from_states text[] NOT NULL,
  capacities  text[] NOT NULL CHECK (cardinality(capacities) BETWEEN 1 AND 3
                                     AND capacities <@ ARRAY['ops_checker', 'compliance_officer', 'legal_officer', 'trustee_officer']),
  label       text NOT NULL CHECK (length(label) BETWEEN 5 AND 120)
);
INSERT INTO exit.decision_kinds (code, from_states, capacities, label) VALUES
  ('X1', '{proposed}', '{ops_checker,compliance_officer}', 'Investment committee: reject the sale proposal'),
  ('X2', '{proposed}', '{ops_checker,compliance_officer}', 'Investment committee: recommend, open the investor vote'),
  ('X3', '{proposed}', '{ops_checker,compliance_officer}', 'Investment committee: recommend (no vote needed)'),
  ('X4', '{vote_open}', '{ops_checker,trustee_officer}', 'Vote result: failed'),
  ('X5', '{vote_open}', '{ops_checker,trustee_officer}', 'Vote result: passed'),
  ('X6', '{trustee_review}', '{legal_officer,trustee_officer}', 'Trustee refuses the sale'),
  ('X7', '{trustee_review}', '{legal_officer,trustee_officer}', 'Trustee approves the sale'),
  ('X8', '{buyer_dd}', '{compliance_officer,legal_officer,trustee_officer}', 'Buyer fails the checks: sale collapses'),
  ('X9', '{buyer_dd}', '{compliance_officer,legal_officer,trustee_officer}', 'Buyer cleared, agreement signed'),
  ('X10', '{contracted}', '{legal_officer,trustee_officer}', 'Buyer default or condition failed: sale collapses'),
  ('X11', '{contracted}', '{legal_officer}', 'Sale deed registered, full price received'),
  ('X12', '{completed_sale}', '{ops_checker}', 'Proceeds reconciled'),
  ('X18', '{paid_out}', '{ops_checker,trustee_officer}', 'Close the trust'),
  ('HR', '{redeeming,paid_out}', '{ops_checker,trustee_officer}', 'Release a held line for burning (units cancelled, payable stays owed)');

CREATE TABLE exit.case_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  case_id     bigint NOT NULL REFERENCES exit.cases (id),
  code        text NOT NULL REFERENCES exit.transitions (code),
  from_state  text NOT NULL,
  to_state    text NOT NULL,
  actor       text NOT NULL CHECK (length(actor) BETWEEN 2 AND 100),
  decision_id bigint,
  at          timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp())
);
CREATE INDEX case_events_case_idx ON exit.case_events (case_id, id);

/** EX-DB-1: an event must be an allowed transition from the case's current state. */
CREATE FUNCTION exit.check_event() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_current text;
BEGIN
  SELECT state INTO v_current FROM exit.cases WHERE id = NEW.case_id FOR NO KEY UPDATE;
  IF v_current IS DISTINCT FROM NEW.from_state OR NOT EXISTS (
       SELECT 1 FROM exit.transitions t WHERE t.code = NEW.code AND t.from_state = NEW.from_state AND t.to_state = NEW.to_state) THEN
    RAISE EXCEPTION 'exit transition % from % to % is not allowed (case is %)', NEW.code, NEW.from_state, NEW.to_state, v_current
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER case_events_check BEFORE INSERT ON exit.case_events FOR EACH ROW EXECUTE FUNCTION exit.check_event();

/** EX-DB-1: the state follows the event log; identity never changes; recorded facts are set once. */
CREATE FUNCTION exit.guard_case() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_last text;
  c text;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'exit cases are never deleted' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    SELECT to_state INTO v_last FROM exit.case_events WHERE case_id = NEW.id ORDER BY id DESC LIMIT 1;
    IF v_last IS DISTINCT FROM NEW.state THEN
      RAISE EXCEPTION 'the state of exit case % changes only through its event log', NEW.id USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF (NEW.id, NEW.token, NEW.property_id, NEW.rationale, NEW.offer_price_paisa, NEW.valuation_a_paisa, NEW.valuation_a_sha, NEW.valuation_b_paisa,
      NEW.valuation_b_sha, NEW.costs_paisa, NEW.vote_required, NEW.opened_by, NEW.opened_at)
     IS DISTINCT FROM (OLD.id, OLD.token, OLD.property_id, OLD.rationale, OLD.offer_price_paisa, OLD.valuation_a_paisa, OLD.valuation_a_sha,
      OLD.valuation_b_paisa, OLD.valuation_b_sha, OLD.costs_paisa, OLD.vote_required, OLD.opened_by, OLD.opened_at) THEN
    RAISE EXCEPTION 'exit case % never changes what was proposed', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  FOREACH c IN ARRAY ARRAY['ic_minutes_sha', 'vote_notice_sha', 'vote_record_block', 'vote_opened_at', 'eligible_units', 'votes_for', 'votes_against',
                           'votes_abstain', 'ballots_sha', 'lower_price_approved', 'legal_advice_sha', 'buyer_ref', 'buyer_checks_sha', 'agreement_sha',
                           'sale_price_paisa', 'deposit_paisa', 'cp_deadline', 'deed_sha', 'deposit_treatment', 'collapse_sha', 'record_date',
                           'record_announced_at', 'record_notice_sha', 'redeeming_at', 'final_accounts_sha', 'windup_sha', 'closed_at'] LOOP
    IF to_jsonb(OLD)->c IS DISTINCT FROM 'null'::jsonb AND to_jsonb(NEW)->c IS DISTINCT FROM to_jsonb(OLD)->c THEN
      RAISE EXCEPTION 'exit case %: % is set once', OLD.id, c USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER cases_guard BEFORE UPDATE OR DELETE ON exit.cases FOR EACH ROW EXECUTE FUNCTION exit.guard_case();

/** Internal: moves a case along its state machine and audits it. */
CREATE FUNCTION exit.move(p_case bigint, p_code text, p_actor text, p_decision bigint) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, exit AS $$
DECLARE
  v_from text;
  v_to text;
  v_event bigint;
BEGIN
  SELECT state INTO v_from FROM exit.cases WHERE id = p_case FOR UPDATE;
  SELECT to_state INTO v_to FROM exit.transitions WHERE code = p_code AND from_state = v_from;
  IF v_to IS NULL THEN PERFORM exit.fail('23514', format('transition %s is not possible from %s', p_code, v_from)); END IF;
  INSERT INTO exit.case_events (case_id, code, from_state, to_state, actor, decision_id) VALUES (p_case, p_code, v_from, v_to, p_actor, p_decision)
  RETURNING id INTO v_event;
  UPDATE exit.cases SET state = v_to, updated_at = date_trunc('microseconds', clock_timestamp()),
         closed_at = CASE WHEN v_to = 'closed' THEN date_trunc('microseconds', clock_timestamp()) ELSE closed_at END,
         redeeming_at = CASE WHEN v_to = 'redeeming' THEN date_trunc('microseconds', clock_timestamp()) ELSE redeeming_at END
  WHERE id = p_case;
  PERFORM exit.audit_append(p_actor, 'case.moved', jsonb_build_object('case', p_case, 'code', p_code, 'from', v_from, 'to', v_to, 'event', v_event,
    'decision', p_decision));
  RETURN v_to;
END $$;

CREATE FUNCTION exit.case_digest(p_case bigint) RETURNS bytea
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, exit AS $$
  SELECT sha256(convert_to('pt-exit-case-v1' || jsonb_build_array(c.id, c.token, c.state, c.offer_price_paisa::text, c.valuation_a_paisa::text,
           encode(c.valuation_a_sha, 'hex'), c.valuation_b_paisa::text, encode(c.valuation_b_sha, 'hex'), c.costs_paisa::text, c.vote_required,
           c.opened_by, c.sale_price_paisa::text, encode(c.agreement_sha, 'hex'), encode(c.deed_sha, 'hex'), c.record_date,
           (SELECT max(e.id) FROM exit.case_events e WHERE e.case_id = c.id))::text, 'UTF8'))
  FROM exit.cases c WHERE c.id = p_case
$$;

-- ------------------------------------------------------------------ opening a case (X0, maker)
CREATE FUNCTION exit.open_case(p_token text, p_rationale text, p_offer bigint, p_val_a bigint, p_val_a_sha text, p_val_b bigint, p_val_b_sha text,
                               p_costs bigint, p_vote_required boolean, p_actor text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, exit AS $$
DECLARE
  v_token text := lower(p_token);
  v_property uuid;
  v_id bigint;
BEGIN
  PERFORM exit.check_actor(p_actor);
  PERFORM exit.check_text(p_rationale, 20, 2000, 'rationale');
  IF NOT exit.is_address(v_token) THEN PERFORM exit.fail('22023', 'token must be an address'); END IF;
  IF NOT EXISTS (SELECT 1 FROM chain.tokens WHERE token = v_token) THEN PERFORM exit.fail('P0002', 'the token is not in the read model'); END IF;
  IF p_offer IS NULL OR p_offer <= 0 OR p_val_a IS NULL OR p_val_a <= 0 OR p_val_b IS NULL OR p_val_b <= 0 OR p_costs IS NULL OR p_costs < 0 THEN
    PERFORM exit.fail('22023', 'the offer, two valuations (positive paisa) and the estimated costs (paisa, may be 0) are required');
  END IF;
  IF p_vote_required IS NULL THEN PERFORM exit.fail('22023', 'say whether the unit rights require an investor vote'); END IF;
  IF p_val_a_sha IS NOT DISTINCT FROM p_val_b_sha THEN PERFORM exit.fail('22023', 'two different independent valuations are required (EX-5)'); END IF;
  PERFORM pg_advisory_xact_lock(586586271, hashtext(v_token));
  IF EXISTS (SELECT 1 FROM exit.cases WHERE token = v_token AND state = ANY (exit.live_states())) THEN
    PERFORM exit.fail('23505', 'the token already has a live exit case');
  END IF;
  IF EXISTS (SELECT 1 FROM exit.cases WHERE token = v_token AND state = 'closed') THEN
    PERFORM exit.fail('23514', 'the trust of this token is closed');
  END IF;
  SELECT o.property_id INTO v_property FROM offering.offerings o WHERE o.token = v_token ORDER BY o.created_at DESC LIMIT 1;
  INSERT INTO exit.cases (token, property_id, rationale, offer_price_paisa, valuation_a_paisa, valuation_a_sha, valuation_b_paisa, valuation_b_sha,
                          costs_paisa, vote_required, opened_by)
  VALUES (v_token, v_property, btrim(p_rationale), p_offer, p_val_a, exit.sha(p_val_a_sha, 'first valuation'), p_val_b, exit.sha(p_val_b_sha, 'second valuation'),
          p_costs, p_vote_required, p_actor)
  RETURNING id INTO v_id;
  PERFORM exit.audit_append(p_actor, 'case.opened', jsonb_build_object('case', v_id, 'token', v_token, 'property', v_property, 'offer', p_offer::text,
    'valuationA', p_val_a::text, 'valuationB', p_val_b::text, 'costs', p_costs::text, 'voteRequired', p_vote_required));
  PERFORM pg_notify('exit_alert', json_build_object('kind', 'case_opened', 'case', v_id, 'token', v_token)::text);
  RETURN v_id;
END $$;

-- ================================================================== decisions (EX-DB-2)
CREATE TABLE exit.decisions (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  case_id     bigint NOT NULL REFERENCES exit.cases (id),
  code        text NOT NULL REFERENCES exit.decision_kinds (code),
  detail      jsonb NOT NULL CHECK (jsonb_typeof(detail) = 'object' AND octet_length(detail::text) <= 4096),
  reason      text NOT NULL CHECK (compliance.free_text_ok(reason, 10, 500)),
  proposed_by text NOT NULL CHECK (length(proposed_by) BETWEEN 2 AND 100),
  proposed_at timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'approved', 'rejected')),
  closed_at   timestamptz,
  CHECK ((status = 'open') = (closed_at IS NULL))
);
CREATE UNIQUE INDEX decisions_one_open ON exit.decisions (case_id) WHERE status = 'open';

CREATE FUNCTION exit.guard_decision() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'exit decisions are never deleted' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF OLD.status <> 'open' OR NEW.status = 'open'
     OR (NEW.id, NEW.case_id, NEW.code, NEW.detail, NEW.reason, NEW.proposed_by, NEW.proposed_at)
        IS DISTINCT FROM (OLD.id, OLD.case_id, OLD.code, OLD.detail, OLD.reason, OLD.proposed_by, OLD.proposed_at) THEN
    RAISE EXCEPTION 'exit decision % is closed once and never changes otherwise', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER decisions_guard BEFORE UPDATE OR DELETE ON exit.decisions FOR EACH ROW EXECUTE FUNCTION exit.guard_decision();

CREATE TABLE exit.votes (
  decision_id bigint NOT NULL REFERENCES exit.decisions (id),
  capacity    text NOT NULL CHECK (capacity IN ('ops_checker', 'compliance_officer', 'legal_officer', 'trustee_officer')),
  officer     text NOT NULL CHECK (length(officer) BETWEEN 2 AND 100),
  vote        text NOT NULL CHECK (vote IN ('approve', 'reject')),
  reason      text NOT NULL CHECK (compliance.free_text_ok(reason, 10, 500)),
  digest      bytea NOT NULL CHECK (length(digest) = 32),
  at          timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  PRIMARY KEY (decision_id, capacity),
  UNIQUE (decision_id, officer)
);

/** EX-SOD-2: an officer related to the buyer (or otherwise conflicted) declares it and then decides nothing on the case. */
CREATE TABLE exit.conflicts (
  case_id     bigint NOT NULL REFERENCES exit.cases (id),
  officer     text NOT NULL CHECK (length(officer) BETWEEN 2 AND 100),
  note        text NOT NULL CHECK (compliance.free_text_ok(note, 10, 500)),
  declared_at timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  PRIMARY KEY (case_id, officer)
);

CREATE FUNCTION exit.decision_digest(p_decision bigint) RETURNS bytea
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, exit AS $$
  SELECT sha256(convert_to('pt-exit-decision-v1' || jsonb_build_array(d.id, d.case_id, d.code, d.detail, d.reason, d.proposed_by, d.status,
           encode(exit.case_digest(d.case_id), 'hex'),
           (SELECT jsonb_agg(jsonb_build_array(v.capacity, v.officer, v.vote) ORDER BY v.capacity) FROM exit.votes v WHERE v.decision_id = d.id))::text, 'UTF8'))
  FROM exit.decisions d WHERE d.id = p_decision
$$;

-- ================================================================== money and unit tables (EX-DB-3..5, EX-DB-7)
-- Proceeds (EX-7): a bank statement credit on the trustee escrow (or a suspense credit), once per line.
CREATE TABLE exit.proceeds (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  case_id         bigint NOT NULL REFERENCES exit.cases (id),
  kind            text NOT NULL CHECK (kind IN ('deposit', 'proceeds')),
  seq             integer NOT NULL CHECK (seq >= 1),
  statement_id    bigint NOT NULL,
  line_no         integer NOT NULL,
  bank_account    text NOT NULL,
  bank_reference  text NOT NULL,
  value_date      date NOT NULL,
  amount_paisa    bigint NOT NULL CHECK (amount_paisa > 0),
  source          text NOT NULL CHECK (source IN ('escrow_line', 'suspense_credit')),
  debit_account   text NOT NULL,
  note            text NOT NULL CHECK (compliance.free_text_ok(note, 5, 300)),
  status          text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'approved', 'rejected')),
  proposed_by     text NOT NULL CHECK (length(proposed_by) BETWEEN 2 AND 100),
  proposed_at     timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  decided_by      text CHECK (length(decided_by) BETWEEN 2 AND 100),
  decision_reason text CHECK (decision_reason IS NULL OR compliance.free_text_ok(decision_reason, 10, 500)),
  decided_at      timestamptz,
  journal_id      bigint UNIQUE REFERENCES ledger.journal (id),
  FOREIGN KEY (statement_id, line_no) REFERENCES recon.bank_lines (statement_id, line_no),
  CHECK ((status = 'proposed') = (decided_by IS NULL AND decided_at IS NULL AND decision_reason IS NULL)),
  CHECK (decided_by IS NULL OR decided_by <> proposed_by),
  CHECK ((status = 'approved') = (journal_id IS NOT NULL))
);
CREATE UNIQUE INDEX proceeds_line_once ON exit.proceeds (statement_id, line_no) WHERE status <> 'rejected';
CREATE UNIQUE INDEX proceeds_seq_once ON exit.proceeds (case_id, kind, seq) WHERE status <> 'rejected';
CREATE TRIGGER proceeds_guard BEFORE UPDATE OR DELETE ON exit.proceeds
  FOR EACH ROW EXECUTE FUNCTION ops.guard_row('proposed>approved,proposed>rejected', 'decided_by', 'decision_reason', 'decided_at', 'journal_id');

-- Waterfall (EX-10/11): versions; lines are added to a draft; maker, operations checker, trustee officer.
CREATE TABLE exit.waterfalls (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  case_id         bigint NOT NULL REFERENCES exit.cases (id),
  version         integer NOT NULL CHECK (version >= 1),
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'checked', 'approved', 'returned')),
  created_by      text NOT NULL CHECK (length(created_by) BETWEEN 2 AND 100),
  created_at      timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  submitted_by    text CHECK (length(submitted_by) BETWEEN 2 AND 100),
  submitted_at    timestamptz,
  checked_by      text CHECK (length(checked_by) BETWEEN 2 AND 100),
  checked_at      timestamptz,
  check_reason    text CHECK (check_reason IS NULL OR compliance.free_text_ok(check_reason, 10, 500)),
  approved_by     text CHECK (length(approved_by) BETWEEN 2 AND 100),
  approved_at     timestamptz,
  approve_reason  text CHECK (approve_reason IS NULL OR compliance.free_text_ok(approve_reason, 10, 500)),
  returned_by     text CHECK (length(returned_by) BETWEEN 2 AND 100),
  returned_at     timestamptz,
  return_reason   text CHECK (return_reason IS NULL OR compliance.free_text_ok(return_reason, 10, 500)),
  UNIQUE (case_id, version),
  CHECK ((submitted_by IS NULL) = (submitted_at IS NULL) AND (checked_by IS NULL) = (checked_at IS NULL) AND (approved_by IS NULL) = (approved_at IS NULL)
         AND (returned_by IS NULL) = (returned_at IS NULL)),
  CHECK (status NOT IN ('submitted', 'checked', 'approved') OR submitted_by IS NOT NULL),
  CHECK (status NOT IN ('checked', 'approved') OR checked_by IS NOT NULL),
  CHECK ((status = 'approved') = (approved_by IS NOT NULL)),
  CHECK ((status = 'returned') = (returned_by IS NOT NULL)),
  -- EX-SOD-3: maker <> checker <> trustee approver, also against a direct UPDATE.
  CHECK (checked_by IS NULL OR (checked_by <> submitted_by AND checked_by <> created_by)),
  CHECK (approved_by IS NULL OR (approved_by <> submitted_by AND approved_by <> created_by AND approved_by <> checked_by))
);
CREATE UNIQUE INDEX waterfalls_one_live ON exit.waterfalls (case_id) WHERE status <> 'returned';
CREATE TRIGGER waterfalls_guard BEFORE UPDATE OR DELETE ON exit.waterfalls
  FOR EACH ROW EXECUTE FUNCTION ops.guard_row('draft>submitted,submitted>checked,checked>approved,draft>returned,submitted>returned,checked>returned',
    'submitted_by', 'submitted_at', 'checked_by', 'checked_at', 'check_reason', 'approved_by', 'approved_at', 'approve_reason', 'returned_by', 'returned_at',
    'return_reason');

CREATE FUNCTION exit.line_rank(p_kind text) RETURNS integer LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_kind WHEN 'reserve_release' THEN 0 WHEN 'rent_transfer' THEN 0 WHEN 'secured_debt' THEN 1 WHEN 'transaction_cost' THEN 2
                     WHEN 'sale_tax' THEN 3 WHEN 'payable' THEN 4 WHEN 'tenant_deposit' THEN 5 WHEN 'closure_reserve' THEN 6 END
$$;
CREATE FUNCTION exit.is_inflow(p_kind text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT p_kind IN ('reserve_release', 'rent_transfer') $$;

CREATE TABLE exit.waterfall_lines (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  waterfall_id    bigint NOT NULL REFERENCES exit.waterfalls (id),
  kind            text NOT NULL CHECK (kind IN ('secured_debt', 'transaction_cost', 'sale_tax', 'payable', 'tenant_deposit', 'closure_reserve',
                                                'reserve_release', 'rent_transfer')),
  payee           text CHECK (payee ~ '^[a-z0-9][a-z0-9_-]{1,39}$'),
  description     text NOT NULL CHECK (compliance.free_text_ok(description, 5, 300)),
  amount_paisa    bigint NOT NULL CHECK (amount_paisa > 0 AND amount_paisa <= 100000000000000000),
  evidence_sha    bytea NOT NULL CHECK (length(evidence_sha) = 32),
  added_by        text NOT NULL CHECK (length(added_by) BETWEEN 2 AND 100),
  added_at        timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  withdrawn_at    timestamptz,
  journal_id      bigint UNIQUE REFERENCES ledger.journal (id),
  CHECK ((kind IN ('secured_debt', 'transaction_cost', 'payable', 'tenant_deposit')) = (payee IS NOT NULL)),
  CHECK (withdrawn_at IS NULL OR journal_id IS NULL)
);
CREATE INDEX waterfall_lines_idx ON exit.waterfall_lines (waterfall_id, id);

/** A line changes only once: withdrawn while its waterfall is a draft, or booked at approval. */
CREATE FUNCTION exit.guard_line() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'waterfall lines are never deleted' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF (NEW.id, NEW.waterfall_id, NEW.kind, NEW.payee, NEW.description, NEW.amount_paisa, NEW.evidence_sha, NEW.added_by, NEW.added_at)
     IS DISTINCT FROM (OLD.id, OLD.waterfall_id, OLD.kind, OLD.payee, OLD.description, OLD.amount_paisa, OLD.evidence_sha, OLD.added_by, OLD.added_at)
     OR (OLD.withdrawn_at IS NOT NULL AND NEW.withdrawn_at IS DISTINCT FROM OLD.withdrawn_at)
     OR (OLD.journal_id IS NOT NULL AND NEW.journal_id IS DISTINCT FROM OLD.journal_id) THEN
    RAISE EXCEPTION 'waterfall line % is withdrawn or booked once and never changes otherwise', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER waterfall_lines_guard BEFORE UPDATE OR DELETE ON exit.waterfall_lines FOR EACH ROW EXECUTE FUNCTION exit.guard_line();

/** The payable account an outflow line credits (inflow lines: the account they debit). */
CREATE FUNCTION exit.line_account(p_token text, p_kind text, p_payee text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_kind
    WHEN 'secured_debt' THEN 'debt:payable:' || p_payee
    WHEN 'transaction_cost' THEN 'vendor:payable:' || p_payee
    WHEN 'payable' THEN 'vendor:payable:' || p_payee
    WHEN 'tenant_deposit' THEN 'deposit:payable:' || p_payee
    WHEN 'sale_tax' THEN 'tax:payable:' || p_token
    WHEN 'closure_reserve' THEN 'reserve:' || p_token || ':closure'
    WHEN 'reserve_release' THEN 'reserve:' || p_token
    WHEN 'rent_transfer' THEN 'rent:pool:' || p_token END
$$;

-- Waterfall payments: a bank statement debit on the trustee escrow pays an approved outflow line.
CREATE TABLE exit.payments (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  line_id         bigint NOT NULL REFERENCES exit.waterfall_lines (id),
  statement_id    bigint NOT NULL,
  line_no         integer NOT NULL,
  bank_reference  text NOT NULL,
  value_date      date NOT NULL,
  amount_paisa    bigint NOT NULL CHECK (amount_paisa > 0),
  note            text NOT NULL CHECK (compliance.free_text_ok(note, 5, 300)),
  status          text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'approved', 'rejected')),
  proposed_by     text NOT NULL CHECK (length(proposed_by) BETWEEN 2 AND 100),
  proposed_at     timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  decided_by      text CHECK (length(decided_by) BETWEEN 2 AND 100),
  decision_reason text CHECK (decision_reason IS NULL OR compliance.free_text_ok(decision_reason, 10, 500)),
  decided_at      timestamptz,
  journal_id      bigint UNIQUE REFERENCES ledger.journal (id),
  FOREIGN KEY (statement_id, line_no) REFERENCES recon.bank_lines (statement_id, line_no),
  CHECK ((status = 'proposed') = (decided_by IS NULL AND decided_at IS NULL AND decision_reason IS NULL)),
  CHECK (decided_by IS NULL OR decided_by <> proposed_by),
  CHECK ((status = 'approved') = (journal_id IS NOT NULL))
);
CREATE UNIQUE INDEX payments_line_once ON exit.payments (statement_id, line_no) WHERE status <> 'rejected';
CREATE TRIGGER payments_guard BEFORE UPDATE OR DELETE ON exit.payments
  FOR EACH ROW EXECUTE FUNCTION ops.guard_row('proposed>approved,proposed>rejected', 'decided_by', 'decision_reason', 'decided_at', 'journal_id');

-- The final distribution (EX-12/13): same arithmetic and checks as ops.distributions (0021 OT-4..OT-6).
CREATE TABLE exit.finals (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  case_id              bigint NOT NULL REFERENCES exit.cases (id),
  token                text NOT NULL CHECK (exit.is_address(token)),
  record_date          date NOT NULL,
  record_block         bigint NOT NULL CHECK (record_block >= 0),
  income_type          text NOT NULL REFERENCES tax.income_types (code),
  proceeds             bigint NOT NULL CHECK (proceeds >= 0),
  inflows              bigint NOT NULL CHECK (inflows >= 0),
  outflows             bigint NOT NULL CHECK (outflows >= 0),
  distributable_gross  bigint NOT NULL CHECK (distributable_gross > 0),
  holders              integer NOT NULL CHECK (holders > 0),
  total_units          numeric(78,0) NOT NULL CHECK (total_units > 0),
  sum_gross            bigint NOT NULL,
  sum_wht              bigint NOT NULL CHECK (sum_wht >= 0),
  sum_net              bigint NOT NULL CHECK (sum_net > 0),
  flagged_lines        integer NOT NULL CHECK (flagged_lines >= 0),
  placeholder_lines    integer NOT NULL CHECK (placeholder_lines >= 0),
  status               text NOT NULL DEFAULT 'calculated' CHECK (status IN ('calculated', 'attached', 'approved', 'returned', 'booked')),
  calculated_by        text NOT NULL CHECK (length(calculated_by) BETWEEN 2 AND 100),
  calculated_at        timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  merkle_root          text CHECK (merkle_root IS NULL OR exit.is_hash(merkle_root)),
  statement            text CHECK (length(statement) <= 20000000),
  statement_hash       text CHECK (statement_hash IS NULL OR exit.is_hash(statement_hash)),
  tax_schedule         text CHECK (length(tax_schedule) <= 40000000),
  tax_schedule_hash    text CHECK (tax_schedule_hash IS NULL OR exit.is_hash(tax_schedule_hash)),
  attached_by          text CHECK (length(attached_by) BETWEEN 2 AND 100),
  attached_at          timestamptz,
  decided_by           text CHECK (length(decided_by) BETWEEN 2 AND 100),
  decision_reason      text CHECK (decision_reason IS NULL OR compliance.free_text_ok(decision_reason, 10, 500)),
  decided_at           timestamptz,
  registry             text CHECK (registry IS NULL OR exit.is_address(registry)),
  onchain_id           numeric(78,0) CHECK (onchain_id > 0),
  returned_reason      text CHECK (length(returned_reason) BETWEEN 5 AND 300),
  wht_journal_id       bigint UNIQUE REFERENCES ledger.journal (id),
  distribution_journal_id bigint UNIQUE REFERENCES ledger.journal (id),
  booked_at            timestamptz,
  CHECK (sum_gross = distributable_gross),
  CHECK (sum_gross = sum_wht + sum_net),
  CHECK ((attached_by IS NULL) = (statement IS NULL) AND (statement IS NULL) = (statement_hash IS NULL)
         AND (statement IS NULL) = (tax_schedule IS NULL) AND (statement IS NULL) = (tax_schedule_hash IS NULL)
         AND (statement IS NULL) = (merkle_root IS NULL) AND (statement IS NULL) = (attached_at IS NULL)),
  CHECK (status NOT IN ('attached', 'approved', 'booked') OR statement IS NOT NULL),
  CHECK (status NOT IN ('approved', 'booked') OR decided_by IS NOT NULL),
  -- OT-6 / EX-SOD-3: the checker is neither the calculator nor the attacher (the trustee pre-check: trigger below).
  CHECK (decided_by IS NULL OR (decided_by <> calculated_by AND decided_by IS DISTINCT FROM attached_by)),
  CHECK ((registry IS NULL) = (onchain_id IS NULL)),
  CHECK ((status = 'booked') = (distribution_journal_id IS NOT NULL AND booked_at IS NOT NULL AND onchain_id IS NOT NULL)),
  CHECK ((sum_wht > 0 AND status = 'booked') = (wht_journal_id IS NOT NULL))
);
CREATE UNIQUE INDEX finals_one_live ON exit.finals (case_id) WHERE status <> 'returned';
CREATE UNIQUE INDEX finals_onchain_once ON exit.finals (registry, onchain_id) WHERE onchain_id IS NOT NULL;
CREATE TRIGGER finals_guard BEFORE UPDATE OR DELETE ON exit.finals
  FOR EACH ROW EXECUTE FUNCTION ops.guard_row('calculated>attached,calculated>returned,attached>approved,attached>returned,approved>booked,approved>returned',
    'merkle_root', 'statement', 'statement_hash', 'tax_schedule', 'tax_schedule_hash', 'attached_by', 'attached_at',
    'decided_by', 'decision_reason', 'decided_at', 'registry', 'onchain_id', 'returned_reason', 'wht_journal_id',
    'distribution_journal_id', 'booked_at');

-- D4 for the final distribution: the trustee's pre-check (an independent recomputation of the root).
CREATE TABLE exit.final_prechecks (
  final_id        bigint PRIMARY KEY REFERENCES exit.finals (id),
  decision        text NOT NULL CHECK (decision IN ('approve', 'reject')),
  recomputed_root text CHECK (recomputed_root IS NULL OR exit.is_hash(recomputed_root)),
  reason          text NOT NULL CHECK (compliance.free_text_ok(reason, 10, 500)),
  officer         text NOT NULL CHECK (length(officer) BETWEEN 2 AND 100),
  digest          bytea NOT NULL CHECK (length(digest) = 32),
  at              timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  CHECK ((decision = 'approve') = (recomputed_root IS NOT NULL))
);

-- The on-chain distribution the tick found for an approved final (X13), once.
CREATE TABLE exit.final_links (
  final_id    bigint PRIMARY KEY REFERENCES exit.finals (id),
  registry    text NOT NULL CHECK (exit.is_address(registry)),
  onchain_id  numeric(78,0) NOT NULL CHECK (onchain_id > 0),
  linked_by   text NOT NULL CHECK (length(linked_by) BETWEEN 2 AND 100),
  linked_at   timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  UNIQUE (registry, onchain_id)
);

/** EX-DB-4: approval needs the trustee's approving pre-check with the attached root, by someone else. */
CREATE FUNCTION exit.guard_final_approval() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  p exit.final_prechecks;
BEGIN
  IF NEW.status = 'approved' AND OLD.status = 'attached' THEN
    SELECT * INTO p FROM exit.final_prechecks WHERE final_id = NEW.id;
    IF NOT FOUND OR p.decision <> 'approve' OR p.recomputed_root IS DISTINCT FROM NEW.merkle_root OR p.officer = NEW.decided_by
       OR p.officer = NEW.calculated_by OR p.officer IS NOT DISTINCT FROM NEW.attached_by THEN
      RAISE EXCEPTION 'final distribution %: approval needs the trustee''s approving pre-check of this root by a different officer', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER finals_approval_guard BEFORE UPDATE ON exit.finals FOR EACH ROW EXECUTE FUNCTION exit.guard_final_approval();

CREATE TABLE exit.final_lines (
  final_id         bigint NOT NULL REFERENCES exit.finals (id),
  wallet           text NOT NULL CHECK (exit.is_address(wallet)),
  subject_id       uuid REFERENCES kyc.subjects (id),
  units            numeric(78,0) NOT NULL CHECK (units > 0),
  -- Every holder has a line (EX-15); a holder whose share rounds to 0 paisa has a 0 line.
  gross            bigint NOT NULL CHECK (gross >= 0),
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
  PRIMARY KEY (final_id, wallet),
  CHECK (gross = net + wht),
  CHECK (wht::numeric = floor((gross::numeric * rate_ppm + 500000) / 1000000)),
  CHECK (flagged = (flag_reason IS NOT NULL))
);

-- The redemption batch (X16, EX-14/15) and its lines.
CREATE TABLE exit.redemptions (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  case_id         bigint NOT NULL REFERENCES exit.cases (id),
  final_id        bigint NOT NULL REFERENCES exit.finals (id),
  burn_rule       text NOT NULL CHECK (burn_rule IN ('after_payment', 'after_finalization')),
  lines           integer NOT NULL CHECK (lines > 0),
  total_units     numeric(78,0) NOT NULL CHECK (total_units > 0),
  items_digest    bytea NOT NULL CHECK (length(items_digest) = 32),
  status          text NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'checked', 'approved', 'rejected')),
  created_by      text NOT NULL CHECK (length(created_by) BETWEEN 2 AND 100),
  created_at      timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  checked_by      text CHECK (length(checked_by) BETWEEN 2 AND 100),
  checked_at      timestamptz,
  check_reason    text CHECK (check_reason IS NULL OR compliance.free_text_ok(check_reason, 10, 500)),
  decided_by      text CHECK (length(decided_by) BETWEEN 2 AND 100),
  decided_at      timestamptz,
  decision_reason text CHECK (decision_reason IS NULL OR compliance.free_text_ok(decision_reason, 10, 500)),
  CHECK ((checked_by IS NULL) = (checked_at IS NULL) AND (checked_by IS NULL) = (check_reason IS NULL)),
  CHECK ((decided_by IS NULL) = (decided_at IS NULL) AND (decided_by IS NULL) = (decision_reason IS NULL)),
  CHECK (status NOT IN ('checked', 'approved') OR checked_by IS NOT NULL),
  CHECK ((status IN ('approved', 'rejected')) = (decided_by IS NOT NULL)),
  CHECK (checked_by IS NULL OR checked_by <> created_by),
  CHECK (decided_by IS NULL OR (decided_by <> created_by AND decided_by IS DISTINCT FROM checked_by))
);
CREATE UNIQUE INDEX redemptions_one_live ON exit.redemptions (case_id) WHERE status <> 'rejected';
CREATE TRIGGER redemptions_guard BEFORE UPDATE OR DELETE ON exit.redemptions
  FOR EACH ROW EXECUTE FUNCTION ops.guard_row('created>checked,created>rejected,checked>approved,checked>rejected',
    'checked_by', 'checked_at', 'check_reason', 'decided_by', 'decided_at', 'decision_reason');

CREATE TABLE exit.redemption_lines (
  redemption_id bigint NOT NULL REFERENCES exit.redemptions (id),
  wallet        text NOT NULL CHECK (exit.is_address(wallet)),
  subject_id    uuid REFERENCES kyc.subjects (id),
  units         numeric(78,0) NOT NULL CHECK (units > 0 AND units <= 999999999999999999),
  -- keccak256("property-token:redemption:<token>:<distributionId>:<wallet>"), computed by the service
  -- (no keccak in SQL); the signing service and reconciliation re-derive it.
  ref_id        text NOT NULL UNIQUE CHECK (exit.is_hash(ref_id)),
  net           bigint NOT NULL CHECK (net >= 0),
  PRIMARY KEY (redemption_id, wallet)
);

-- HR decisions: a held line released for burning.
CREATE TABLE exit.releases (
  redemption_id bigint NOT NULL REFERENCES exit.redemptions (id),
  wallet        text NOT NULL,
  decision_id   bigint NOT NULL UNIQUE REFERENCES exit.decisions (id),
  at            timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  PRIMARY KEY (redemption_id, wallet),
  FOREIGN KEY (redemption_id, wallet) REFERENCES exit.redemption_lines (redemption_id, wallet)
);

-- Burn commands enqueued (once per line) and burns seen in the read model (once per refId).
CREATE TABLE exit.burns (
  ref_id        text PRIMARY KEY REFERENCES exit.redemption_lines (ref_id),
  redemption_id bigint NOT NULL REFERENCES exit.redemptions (id),
  command_key   text NOT NULL UNIQUE CHECK (command_key = 'burn:' || ref_id),
  enqueued_by   text NOT NULL CHECK (length(enqueued_by) BETWEEN 2 AND 100),
  enqueued_at   timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp())
);
CREATE TABLE exit.burns_seen (
  ref_id        text PRIMARY KEY REFERENCES exit.redemption_lines (ref_id),
  block_number  bigint NOT NULL,
  tx_hash       text NOT NULL,
  amount        numeric(78,0) NOT NULL,
  register_units bigint NOT NULL,
  seen_at       timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp())
);

-- Redemption windows and requests (phase 0, S-05 section 15).
CREATE TABLE exit.windows (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  token                text NOT NULL CHECK (exit.is_address(token)),
  opens_at             timestamptz NOT NULL,
  closes_at            timestamptz NOT NULL,
  nav_per_unit_paisa   bigint NOT NULL CHECK (nav_per_unit_paisa > 0 AND nav_per_unit_paisa <= 100000000000),
  nav_evidence_sha     bytea NOT NULL CHECK (length(nav_evidence_sha) = 32),
  discount_ppm         integer NOT NULL CHECK (discount_ppm BETWEEN 0 AND 999999),
  -- EX-42: floor(NAV x (1,000,000 - discount) / 1,000,000), frozen with the window.
  price_per_unit_paisa bigint NOT NULL CHECK (price_per_unit_paisa > 0),
  cap_units            numeric(78,0),
  note                 text NOT NULL CHECK (compliance.free_text_ok(note, 10, 300)),
  status               text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'approved', 'rejected')),
  proposed_by          text NOT NULL CHECK (length(proposed_by) BETWEEN 2 AND 100),
  proposed_at          timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  decided_by           text CHECK (length(decided_by) BETWEEN 2 AND 100),
  decision_reason      text CHECK (decision_reason IS NULL OR compliance.free_text_ok(decision_reason, 10, 500)),
  decided_at           timestamptz,
  outcome_status       text NOT NULL DEFAULT 'none' CHECK (outcome_status IN ('none', 'proposed', 'approved')),
  outcome_by           text CHECK (length(outcome_by) BETWEEN 2 AND 100),
  outcome_at           timestamptz,
  outcome_decided_by   text CHECK (length(outcome_decided_by) BETWEEN 2 AND 100),
  outcome_decided_at   timestamptz,
  outcome_reason       text CHECK (outcome_reason IS NULL OR compliance.free_text_ok(outcome_reason, 10, 500)),
  CHECK (closes_at > opens_at),
  CHECK (price_per_unit_paisa = floor(nav_per_unit_paisa::numeric * (1000000 - discount_ppm) / 1000000)),
  CHECK ((status = 'proposed') = (decided_by IS NULL AND decided_at IS NULL AND decision_reason IS NULL)),
  CHECK (decided_by IS NULL OR decided_by <> proposed_by),
  CHECK ((status = 'approved') = (cap_units IS NOT NULL)),
  CHECK ((outcome_status = 'none') = (outcome_by IS NULL)),
  CHECK ((outcome_status = 'approved') = (outcome_decided_by IS NOT NULL AND outcome_decided_at IS NOT NULL AND outcome_reason IS NOT NULL)),
  CHECK (outcome_decided_by IS NULL OR outcome_decided_by <> outcome_by),
  CHECK (outcome_status = 'none' OR status = 'approved')
);
CREATE INDEX windows_token_idx ON exit.windows (token, id DESC);

CREATE FUNCTION exit.guard_window() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'redemption windows are never deleted' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF (NEW.id, NEW.token, NEW.opens_at, NEW.closes_at, NEW.nav_per_unit_paisa, NEW.nav_evidence_sha, NEW.discount_ppm, NEW.price_per_unit_paisa,
      NEW.note, NEW.proposed_by, NEW.proposed_at)
     IS DISTINCT FROM (OLD.id, OLD.token, OLD.opens_at, OLD.closes_at, OLD.nav_per_unit_paisa, OLD.nav_evidence_sha, OLD.discount_ppm,
      OLD.price_per_unit_paisa, OLD.note, OLD.proposed_by, OLD.proposed_at)
     OR (OLD.status <> 'proposed' AND (NEW.status, NEW.decided_by, NEW.decision_reason, NEW.decided_at, NEW.cap_units)
         IS DISTINCT FROM (OLD.status, OLD.decided_by, OLD.decision_reason, OLD.decided_at, OLD.cap_units))
     OR (OLD.outcome_status = 'approved' AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD))
     OR (OLD.outcome_status = 'proposed' AND (NEW.outcome_status <> 'approved' OR NEW.outcome_by IS DISTINCT FROM OLD.outcome_by
                                              OR NEW.outcome_at IS DISTINCT FROM OLD.outcome_at))
     OR (OLD.outcome_status = 'none' AND NEW.outcome_status = 'approved') THEN
    RAISE EXCEPTION 'redemption window % changes only along its decisions', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER windows_guard BEFORE UPDATE OR DELETE ON exit.windows FOR EACH ROW EXECUTE FUNCTION exit.guard_window();

CREATE TABLE exit.requests (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  window_id            bigint NOT NULL REFERENCES exit.windows (id),
  subject_id           uuid NOT NULL REFERENCES kyc.subjects (id),
  wallet               text NOT NULL CHECK (exit.is_address(wallet)),
  units                numeric(78,0) NOT NULL CHECK (units > 0 AND units <= 999999999999999999),
  price_per_unit_paisa bigint NOT NULL CHECK (price_per_unit_paisa > 0),
  indicative_paisa     numeric(78,0) NOT NULL CHECK (indicative_paisa = units * price_per_unit_paisa),
  idempotency_key      text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9:._-]{7,99}$'),
  status               text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'withdrawn', 'recorded', 'declined')),
  actor                text NOT NULL CHECK (length(actor) BETWEEN 2 AND 100),
  created_at           timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  closed_at            timestamptz,
  CHECK ((status = 'submitted') = (closed_at IS NULL)),
  UNIQUE (window_id, subject_id, idempotency_key)
);
CREATE UNIQUE INDEX requests_one_live ON exit.requests (window_id, subject_id) WHERE status = 'submitted';
CREATE INDEX requests_subject_idx ON exit.requests (subject_id, created_at DESC);
CREATE TRIGGER requests_guard BEFORE UPDATE OR DELETE ON exit.requests
  FOR EACH ROW EXECUTE FUNCTION ops.guard_row('submitted>withdrawn,submitted>recorded,submitted>declined', 'closed_at');

/** Units held at a block (supply at that block from the Transfer events). */
CREATE FUNCTION exit.supply_at(p_token text, p_block bigint) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, exit AS $$
  SELECT coalesce(sum(units), 0) FROM exit.holders_at(p_token, p_block)
$$;

/** EX-5 price floor: the lower of the two independent valuations. */
CREATE FUNCTION exit.price_floor(c exit.cases) RETURNS bigint LANGUAGE sql IMMUTABLE AS $$ SELECT least(c.valuation_a_paisa, c.valuation_b_paisa) $$;

/** EX-3: whether a counted vote passes (quorum on votes cast incl. abstentions, majority of for vs against). */
CREATE FUNCTION exit.vote_passes(p_eligible numeric, p_for numeric, p_against numeric, p_abstain numeric) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, exit AS $$
  SELECT (p_for + p_against + p_abstain) * 1000000 >= p_eligible * exit.setting_int('vote_quorum_ppm')
     AND p_for + p_against > 0
     AND p_for * 1000000 >= (p_for + p_against) * exit.setting_int('vote_majority_ppm')
$$;

/** Approved proceeds (deposit + proceeds) of a case, and proposals still open. */
CREATE FUNCTION exit.proceeds_of(p_case bigint, OUT approved bigint, OUT pending integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, exit AS $$
  SELECT coalesce(sum(amount_paisa) FILTER (WHERE status = 'approved'), 0)::bigint, count(*) FILTER (WHERE status = 'proposed')::integer
  FROM exit.proceeds WHERE case_id = p_case
$$;

/**
 * The decision's detail as stored: only the fields its code needs, validated (raises 22023 on bad
 * input). Hex digests are 64 lower-case hex digits.
 */
CREATE FUNCTION exit.normalize_detail(p_code text, p jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
DECLARE
  o jsonb := '{}'::jsonb;
  k text;
  v_shas text[];
BEGIN
  IF p IS NULL OR jsonb_typeof(p) IS DISTINCT FROM 'object' THEN PERFORM exit.fail('22023', 'the decision detail must be a JSON object'); END IF;
  v_shas := CASE p_code
    WHEN 'X1' THEN ARRAY['minutesSha'] WHEN 'X2' THEN ARRAY['minutesSha', 'noticeSha'] WHEN 'X3' THEN ARRAY['minutesSha']
    WHEN 'X4' THEN ARRAY['ballotsSha'] WHEN 'X5' THEN ARRAY['ballotsSha']
    WHEN 'X6' THEN ARRAY['legalAdviceSha'] WHEN 'X7' THEN ARRAY['legalAdviceSha']
    WHEN 'X8' THEN ARRAY['buyerChecksSha'] WHEN 'X9' THEN ARRAY['buyerChecksSha', 'agreementSha']
    WHEN 'X10' THEN ARRAY['evidenceSha'] WHEN 'X11' THEN ARRAY['deedSha']
    WHEN 'X18' THEN ARRAY['finalAccountsSha', 'windupSha'] ELSE '{}'::text[] END;
  FOREACH k IN ARRAY v_shas LOOP
    IF jsonb_typeof(p->k) IS DISTINCT FROM 'string' OR length(p->>k) <> 64 OR (p->>k) !~ '^[0-9a-f]+$' THEN
      PERFORM exit.fail('22023', format('%s: the SHA-256 of the evidence (64 lower-case hex digits) is required', k));
    END IF;
    o := o || jsonb_build_object(k, p->>k);
  END LOOP;
  IF p_code = 'X2' THEN
    IF jsonb_typeof(p->'voteRecordBlock') IS DISTINCT FROM 'string' OR (p->>'voteRecordBlock') !~ '^(0|[1-9][0-9]{0,17})$' THEN
      PERFORM exit.fail('22023', 'voteRecordBlock (a block number as a decimal string) is required');
    END IF;
    o := o || jsonb_build_object('voteRecordBlock', p->>'voteRecordBlock');
  ELSIF p_code IN ('X4', 'X5') THEN
    FOREACH k IN ARRAY ARRAY['eligibleUnits', 'votesFor', 'votesAgainst', 'votesAbstain'] LOOP
      IF jsonb_typeof(p->k) IS DISTINCT FROM 'string' OR (p->>k) !~ '^(0|[1-9][0-9]{0,30})$' THEN
        PERFORM exit.fail('22023', format('%s (units as a decimal string) is required', k));
      END IF;
      o := o || jsonb_build_object(k, p->>k);
    END LOOP;
    IF jsonb_typeof(p->'lowerPriceApproved') IS DISTINCT FROM 'boolean' THEN PERFORM exit.fail('22023', 'lowerPriceApproved (true or false) is required'); END IF;
    o := o || jsonb_build_object('lowerPriceApproved', p->'lowerPriceApproved');
  ELSIF p_code = 'X7' THEN
    IF (p->'conflictsCleared') IS DISTINCT FROM 'true'::jsonb THEN PERFORM exit.fail('22023', 'conflictsCleared must be true: related parties are excluded (EX-SOD-2)'); END IF;
    o := o || jsonb_build_object('conflictsCleared', true);
  ELSIF p_code IN ('X8', 'X9') THEN
    IF jsonb_typeof(p->'buyerRef') IS DISTINCT FROM 'string' OR (p->>'buyerRef') !~ '^[A-Za-z0-9][A-Za-z0-9:._-]{2,63}$' THEN
      PERFORM exit.fail('22023', 'buyerRef (the buyer''s KYB/KYC case reference, no personal data) is required');
    END IF;
    o := o || jsonb_build_object('buyerRef', p->>'buyerRef');
    IF p_code = 'X9' THEN
      IF jsonb_typeof(p->'salePricePaisa') IS DISTINCT FROM 'string' OR (p->>'salePricePaisa') !~ '^[1-9][0-9]{0,17}$'
         OR jsonb_typeof(p->'depositPaisa') IS DISTINCT FROM 'string' OR (p->>'depositPaisa') !~ '^(0|[1-9][0-9]{0,17})$'
         OR jsonb_typeof(p->'cpDeadline') IS DISTINCT FROM 'string' OR (p->>'cpDeadline') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
        PERFORM exit.fail('22023', 'salePricePaisa, depositPaisa (decimal strings) and cpDeadline (YYYY-MM-DD) are required');
      END IF;
      PERFORM (p->>'cpDeadline')::date;
      o := o || jsonb_build_object('salePricePaisa', p->>'salePricePaisa', 'depositPaisa', p->>'depositPaisa', 'cpDeadline', p->>'cpDeadline');
    END IF;
  ELSIF p_code = 'X10' THEN
    IF (p->>'depositTreatment') IS NULL OR (p->>'depositTreatment') NOT IN ('forfeit', 'refund', 'none') THEN
      PERFORM exit.fail('22023', 'depositTreatment (forfeit, refund or none, per the agreement) is required');
    END IF;
    o := o || jsonb_build_object('depositTreatment', p->>'depositTreatment');
  ELSIF p_code = 'HR' THEN
    IF NOT exit.is_address(p->>'wallet') THEN PERFORM exit.fail('22023', 'wallet (a lower-case address) is required'); END IF;
    o := o || jsonb_build_object('wallet', p->>'wallet');
  END IF;
  RETURN o;
END $$;

/** Why a decision with this detail cannot take effect on the case now (NULL = it can). Checked at proposal and at the last approval. */
CREATE FUNCTION exit.decision_problem(p_case bigint, p_code text, d jsonb) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, exit AS $$
DECLARE
  c exit.cases;
  k exit.decision_kinds;
  v_cursor bigint;
  v_eligible numeric;
  v_pass boolean;
  p record;
  g record;
  r exit.redemptions;
  v_problem text;
BEGIN
  SELECT * INTO c FROM exit.cases WHERE id = p_case;
  IF NOT FOUND THEN RETURN 'unknown exit case'; END IF;
  SELECT * INTO k FROM exit.decision_kinds WHERE code = p_code;
  IF NOT FOUND THEN RETURN format('unknown decision %s', p_code); END IF;
  IF NOT (c.state = ANY (k.from_states)) THEN RETURN format('%s is not possible while the case is %s', p_code, c.state); END IF;
  CASE p_code
    WHEN 'X2' THEN
      IF NOT c.vote_required THEN RETURN 'the unit rights need no investor vote: recommend with X3'; END IF;
      v_cursor := exit.cursor_of(c.token);
      IF v_cursor IS NULL OR (d->>'voteRecordBlock')::bigint > v_cursor THEN RETURN 'the vote record block must already be indexed'; END IF;
      IF exit.supply_at(c.token, (d->>'voteRecordBlock')::bigint) <= 0 THEN RETURN 'nobody holds units at the vote record block'; END IF;
    WHEN 'X3' THEN
      IF c.vote_required THEN RETURN 'the unit rights require an investor vote (EX-1): recommend with X2'; END IF;
    WHEN 'X4', 'X5' THEN
      IF clock_timestamp() < c.vote_opened_at + make_interval(days => exit.setting_int('vote_notice_days')::integer) THEN
        RETURN format('the notice period of %s days runs until %s UTC (EX-3)', exit.setting_int('vote_notice_days'),
                      exit.utc(c.vote_opened_at + make_interval(days => exit.setting_int('vote_notice_days')::integer)));
      END IF;
      v_eligible := exit.supply_at(c.token, c.vote_record_block);
      IF (d->>'eligibleUnits')::numeric <> v_eligible THEN
        RETURN format('eligible units must be the supply at the vote record block %s: %s', c.vote_record_block, v_eligible);
      END IF;
      IF (d->>'votesFor')::numeric + (d->>'votesAgainst')::numeric + (d->>'votesAbstain')::numeric > v_eligible THEN
        RETURN 'more votes than eligible units';
      END IF;
      v_pass := exit.vote_passes(v_eligible, (d->>'votesFor')::numeric, (d->>'votesAgainst')::numeric, (d->>'votesAbstain')::numeric);
      IF p_code = 'X5' AND NOT v_pass THEN RETURN 'the counted votes do not reach the quorum and majority (EX-3): record X4'; END IF;
      IF p_code = 'X4' AND v_pass THEN RETURN 'the counted votes pass (EX-3): record X5'; END IF;
      IF p_code = 'X4' AND (d->'lowerPriceApproved') = 'true'::jsonb THEN RETURN 'a failed vote approves nothing'; END IF;
    WHEN 'X7' THEN
      IF c.offer_price_paisa < exit.price_floor(c) AND c.lower_price_approved IS DISTINCT FROM true THEN
        RETURN format('the offer %s is below the lower valuation %s and the vote did not approve a lower price (EX-5)', c.offer_price_paisa, exit.price_floor(c));
      END IF;
    WHEN 'X9' THEN
      IF (d->>'salePricePaisa')::bigint < exit.price_floor(c) AND c.lower_price_approved IS DISTINCT FROM true THEN
        RETURN format('the sale price is below the lower valuation %s and the vote did not approve a lower price (EX-5)', exit.price_floor(c));
      END IF;
      IF (d->>'depositPaisa')::bigint > (d->>'salePricePaisa')::bigint THEN RETURN 'the deposit exceeds the sale price'; END IF;
      IF (d->>'cpDeadline')::date < exit.pkt_today() THEN RETURN 'the condition-precedent deadline is in the past'; END IF;
    WHEN 'X10' THEN
      SELECT * INTO p FROM exit.proceeds_of(c.id);
      IF p.pending > 0 THEN RETURN 'decide the pending proceeds first'; END IF;
      IF EXISTS (SELECT 1 FROM exit.proceeds x WHERE x.case_id = c.id AND x.kind = 'proceeds' AND x.status = 'approved') THEN
        RETURN 'sale proceeds were already received: the sale cannot collapse in the platform (LEGAL)';
      END IF;
    WHEN 'X11' THEN
      SELECT * INTO p FROM exit.proceeds_of(c.id);
      IF p.pending > 0 THEN RETURN 'decide the pending proceeds first'; END IF;
      IF p.approved < c.sale_price_paisa THEN
        RETURN format('only %s of the sale price %s paisa is received (proceeds short: no completion, section 8)', p.approved, c.sale_price_paisa);
      END IF;
    WHEN 'X12' THEN
      SELECT * INTO p FROM exit.proceeds_of(c.id);
      IF p.pending > 0 THEN RETURN 'decide the pending proceeds first'; END IF;
      IF p.approved < c.sale_price_paisa THEN RETURN 'the full sale price is not booked'; END IF;
      SELECT * INTO g FROM recon.payout_gate();
      IF NOT coalesce(g.allowed, false) THEN RETURN 'reconciliation is not clean: ' || coalesce(g.reason, 'no gate answer'); END IF;
    WHEN 'X18' THEN
      RETURN exit.close_problem(c.id);
    WHEN 'HR' THEN
      SELECT * INTO r FROM exit.redemptions WHERE case_id = c.id AND status = 'approved';
      IF NOT FOUND THEN RETURN 'the case has no approved redemption batch'; END IF;
      IF NOT EXISTS (SELECT 1 FROM exit.redemption_lines l WHERE l.redemption_id = r.id AND l.wallet = d->>'wallet') THEN RETURN 'the wallet is not in the redemption batch'; END IF;
      IF r.burn_rule <> 'after_payment' THEN RETURN 'the batch burns after finalization: nothing to release'; END IF;
      IF EXISTS (SELECT 1 FROM exit.releases x WHERE x.redemption_id = r.id AND x.wallet = d->>'wallet') THEN RETURN 'the line is already released'; END IF;
      -- Only a line the bank could not pay (held in the submitted batch, or returned) is released.
      v_problem := exit.line_payment(r.id, d->>'wallet');
      IF v_problem NOT IN ('held', 'returned') THEN RETURN 'only a held or returned line is released; this one is ' || v_problem; END IF;
    ELSE
      NULL;
  END CASE;
  RETURN NULL;
END $$;

/** Records what an approved decision decided, then moves the case. */
CREATE FUNCTION exit.apply_decision(p_decision bigint, p_actor text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, exit AS $$
DECLARE
  x exit.decisions;
  d jsonb;
  r exit.redemptions;
BEGIN
  SELECT * INTO x FROM exit.decisions WHERE id = p_decision;
  d := x.detail;
  CASE x.code
    WHEN 'X1', 'X3' THEN UPDATE exit.cases SET ic_minutes_sha = decode(d->>'minutesSha', 'hex') WHERE id = x.case_id;
    WHEN 'X2' THEN
      UPDATE exit.cases SET ic_minutes_sha = decode(d->>'minutesSha', 'hex'), vote_notice_sha = decode(d->>'noticeSha', 'hex'),
             vote_record_block = (d->>'voteRecordBlock')::bigint, vote_opened_at = date_trunc('microseconds', clock_timestamp())
      WHERE id = x.case_id;
    WHEN 'X4', 'X5' THEN
      UPDATE exit.cases SET eligible_units = (d->>'eligibleUnits')::numeric, votes_for = (d->>'votesFor')::numeric,
             votes_against = (d->>'votesAgainst')::numeric, votes_abstain = (d->>'votesAbstain')::numeric,
             ballots_sha = decode(d->>'ballotsSha', 'hex'), lower_price_approved = (d->>'lowerPriceApproved')::boolean
      WHERE id = x.case_id;
    WHEN 'X6', 'X7' THEN UPDATE exit.cases SET legal_advice_sha = decode(d->>'legalAdviceSha', 'hex') WHERE id = x.case_id;
    WHEN 'X8' THEN UPDATE exit.cases SET buyer_ref = d->>'buyerRef', buyer_checks_sha = decode(d->>'buyerChecksSha', 'hex') WHERE id = x.case_id;
    WHEN 'X9' THEN
      UPDATE exit.cases SET buyer_ref = d->>'buyerRef', buyer_checks_sha = decode(d->>'buyerChecksSha', 'hex'), agreement_sha = decode(d->>'agreementSha', 'hex'),
             sale_price_paisa = (d->>'salePricePaisa')::bigint, deposit_paisa = (d->>'depositPaisa')::bigint, cp_deadline = (d->>'cpDeadline')::date
      WHERE id = x.case_id;
    WHEN 'X10' THEN UPDATE exit.cases SET deposit_treatment = d->>'depositTreatment', collapse_sha = decode(d->>'evidenceSha', 'hex') WHERE id = x.case_id;
    WHEN 'X11' THEN UPDATE exit.cases SET deed_sha = decode(d->>'deedSha', 'hex') WHERE id = x.case_id;
    WHEN 'X18' THEN
      UPDATE exit.cases SET final_accounts_sha = decode(d->>'finalAccountsSha', 'hex'), windup_sha = decode(d->>'windupSha', 'hex') WHERE id = x.case_id;
    WHEN 'HR' THEN
      SELECT * INTO r FROM exit.redemptions WHERE case_id = x.case_id AND status = 'approved';
      INSERT INTO exit.releases (redemption_id, wallet, decision_id) VALUES (r.id, d->>'wallet', x.id);
      PERFORM exit.audit_append(p_actor, 'line.released', jsonb_build_object('case', x.case_id, 'redemption', r.id, 'wallet', d->>'wallet', 'decision', x.id));
      PERFORM exit.enqueue_burns(x.case_id, p_actor);
      RETURN (SELECT state FROM exit.cases WHERE id = x.case_id);
    ELSE NULL;
  END CASE;
  RETURN exit.move(x.case_id, x.code, p_actor, x.id);
END $$;

/** A maker proposes a decision (portal: operations maker; command line: a non-officer operator name). */
CREATE FUNCTION exit.propose(p_case bigint, p_code text, p_detail jsonb, p_reason text, p_actor text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, exit AS $$
DECLARE
  v_detail jsonb;
  v_problem text;
  v_id bigint;
BEGIN
  PERFORM exit.check_actor(p_actor);
  PERFORM exit.check_text(p_reason, 10, 500, 'reason');
  IF NOT EXISTS (SELECT 1 FROM exit.decision_kinds WHERE code = p_code) THEN PERFORM exit.fail('22023', 'unknown decision code'); END IF;
  PERFORM 1 FROM exit.cases WHERE id = p_case FOR UPDATE;
  IF NOT FOUND THEN PERFORM exit.fail('P0002', 'unknown exit case'); END IF;
  IF EXISTS (SELECT 1 FROM exit.decisions WHERE case_id = p_case AND status = 'open') THEN
    PERFORM exit.fail('23505', 'the case already has an open decision: it must be approved or rejected first');
  END IF;
  v_detail := exit.normalize_detail(p_code, p_detail);
  v_problem := exit.decision_problem(p_case, p_code, v_detail);
  IF v_problem IS NOT NULL THEN PERFORM exit.fail('23514', v_problem); END IF;
  INSERT INTO exit.decisions (case_id, code, detail, reason, proposed_by) VALUES (p_case, p_code, v_detail, btrim(p_reason), p_actor) RETURNING id INTO v_id;
  PERFORM exit.audit_append(p_actor, 'decision.proposed', jsonb_build_object('case', p_case, 'decision', v_id, 'code', p_code, 'detail', v_detail,
    'reason', btrim(p_reason)));
  RETURN v_id;
END $$;

/**
 * An officer's vote on an open decision in the capacity their role gives them (EX-DB-2). Returns
 * the decision's status afterwards (open, approved, rejected).
 */
CREATE FUNCTION exit.vote(p_decision bigint, p_officer text, p_vote text, p_reason text, p_digest bytea) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, exit AS $$
DECLARE
  x exit.decisions;
  k exit.decision_kinds;
  c exit.cases;
  v_cap text;
  v_problem text;
BEGIN
  PERFORM exit.check_text(p_reason, 10, 500, 'reason');
  IF p_vote IS NULL OR p_vote NOT IN ('approve', 'reject') THEN PERFORM exit.fail('22023', 'vote must be approve or reject'); END IF;
  SELECT * INTO x FROM exit.decisions WHERE id = p_decision FOR UPDATE;
  IF NOT FOUND THEN PERFORM exit.fail('P0002', 'unknown exit decision'); END IF;
  IF x.status <> 'open' THEN PERFORM exit.fail('23514', format('the decision is %s', x.status)); END IF;
  SELECT * INTO k FROM exit.decision_kinds WHERE code = x.code;
  SELECT * INTO c FROM exit.cases WHERE id = x.case_id FOR UPDATE;
  IF p_officer = x.proposed_by OR p_officer = c.opened_by THEN
    PERFORM exit.fail('42501', 'maker-checker: whoever proposed the case or this decision cannot decide it (EX-SOD-1)');
  END IF;
  IF EXISTS (SELECT 1 FROM exit.conflicts f WHERE f.case_id = c.id AND f.officer = p_officer) THEN
    PERFORM exit.fail('42501', 'you declared a conflict on this case (EX-SOD-2)');
  END IF;
  IF EXISTS (SELECT 1 FROM exit.votes v WHERE v.decision_id = x.id AND v.officer = p_officer) THEN
    PERFORM exit.fail('23505', 'you already decided this; a different officer decides in the other capacity');
  END IF;
  SELECT cap INTO v_cap FROM unnest(k.capacities) cap
  WHERE admin.officer_holds(p_officer, ARRAY[cap], true) AND NOT EXISTS (SELECT 1 FROM exit.votes v WHERE v.decision_id = x.id AND v.capacity = cap)
  LIMIT 1;
  IF v_cap IS NULL THEN
    PERFORM exit.fail('42501', format('%s is decided by %s: you hold no capacity that is still open', x.code, array_to_string(k.capacities, ', ')));
  END IF;
  IF p_digest IS DISTINCT FROM exit.decision_digest(x.id) THEN
    PERFORM exit.fail('23514', 'the case or the decision changed since you reviewed it: reload and check again');
  END IF;
  INSERT INTO exit.votes (decision_id, capacity, officer, vote, reason, digest) VALUES (x.id, v_cap, p_officer, p_vote, btrim(p_reason), p_digest);
  PERFORM exit.audit_append(p_officer, 'decision.voted', jsonb_build_object('case', x.case_id, 'decision', x.id, 'code', x.code, 'capacity', v_cap,
    'vote', p_vote, 'reason', btrim(p_reason), 'digest', encode(p_digest, 'hex')));
  IF p_vote = 'reject' THEN
    UPDATE exit.decisions SET status = 'rejected', closed_at = clock_timestamp() WHERE id = x.id;
    PERFORM exit.audit_append(p_officer, 'decision.closed', jsonb_build_object('case', x.case_id, 'decision', x.id, 'status', 'rejected'));
    RETURN 'rejected';
  END IF;
  IF (SELECT count(*) FROM exit.votes v WHERE v.decision_id = x.id AND v.vote = 'approve') < cardinality(k.capacities) THEN
    RETURN 'open';
  END IF;
  v_problem := exit.decision_problem(x.case_id, x.code, x.detail);
  IF v_problem IS NOT NULL THEN PERFORM exit.fail('23514', 'the decision cannot take effect now: ' || v_problem); END IF;
  UPDATE exit.decisions SET status = 'approved', closed_at = clock_timestamp() WHERE id = x.id;
  PERFORM exit.audit_append(p_officer, 'decision.closed', jsonb_build_object('case', x.case_id, 'decision', x.id, 'status', 'approved'));
  PERFORM exit.apply_decision(x.id, p_officer);
  RETURN 'approved';
END $$;

/** EX-SOD-2: an officer declares a conflict on a case (then votes nothing on it). */
CREATE FUNCTION exit.declare_conflict(p_case bigint, p_officer text, p_note text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, exit AS $$
BEGIN
  PERFORM exit.check_text(p_note, 10, 500, 'note');
  IF NOT EXISTS (SELECT 1 FROM exit.cases WHERE id = p_case) THEN PERFORM exit.fail('P0002', 'unknown exit case'); END IF;
  IF EXISTS (SELECT 1 FROM exit.conflicts WHERE case_id = p_case AND officer = p_officer) THEN PERFORM exit.fail('23505', 'already declared'); END IF;
  INSERT INTO exit.conflicts (case_id, officer, note) VALUES (p_case, p_officer, btrim(p_note));
  PERFORM exit.audit_append(p_officer, 'conflict.declared', jsonb_build_object('case', p_case, 'note', btrim(p_note)));
END $$;

-- ================================================================== proceeds (EX-7, EX-DB-3)
CREATE FUNCTION exit.proceeds_digest(p_id bigint) RETURNS bytea
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, exit AS $$
  SELECT sha256(convert_to('pt-exit-proceeds-v1' || jsonb_build_array(p.id, p.case_id, p.kind, p.seq, p.statement_id, p.line_no, p.bank_account,
           p.bank_reference, p.value_date, p.amount_paisa::text, p.source, p.debit_account, p.note, p.status, p.proposed_by)::text, 'UTF8'))
  FROM exit.proceeds p WHERE p.id = p_id
$$;

/** A maker attributes a bank statement credit to the case as deposit or proceeds. */
CREATE FUNCTION exit.propose_proceeds(p_case bigint, p_kind text, p_statement bigint, p_line integer, p_note text, p_actor text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, exit AS $$
DECLARE
  c exit.cases;
  l recon.bank_lines;
  cr bank.credits;
  v_ledger text;
  v_source text;
  v_debit text;
  v_seq integer;
  v_id bigint;
BEGIN
  PERFORM exit.check_actor(p_actor);
  PERFORM exit.check_text(p_note, 5, 300, 'note');
  IF p_kind IS NULL OR p_kind NOT IN ('deposit', 'proceeds') THEN PERFORM exit.fail('22023', 'kind must be deposit or proceeds'); END IF;
  SELECT * INTO c FROM exit.cases WHERE id = p_case FOR UPDATE;
  IF NOT FOUND THEN PERFORM exit.fail('P0002', 'unknown exit case'); END IF;
  IF c.state NOT IN ('contracted', 'completed_sale') THEN
    PERFORM exit.fail('23514', format('proceeds are recorded once the agreement is signed (the case is %s)', c.state));
  END IF;
  IF p_kind = 'deposit' AND c.state <> 'contracted' THEN PERFORM exit.fail('23514', 'a deposit is recorded before completion'); END IF;
  SELECT * INTO l FROM recon.bank_lines WHERE statement_id = p_statement AND line_no = p_line;
  IF NOT FOUND THEN PERFORM exit.fail('P0002', 'unknown bank statement line'); END IF;
  IF l.amount_paisa <= 0 THEN PERFORM exit.fail('23514', 'only an incoming bank line (a credit) is sale proceeds'); END IF;
  SELECT ledger_account INTO v_ledger FROM recon.bank_accounts WHERE account = l.account;
  IF v_ledger IS NULL THEN PERFORM exit.fail('23514', format('the bank account %s is not registered for reconciliation', l.account)); END IF;
  IF EXISTS (SELECT 1 FROM exit.proceeds WHERE statement_id = p_statement AND line_no = p_line AND status <> 'rejected')
     OR EXISTS (SELECT 1 FROM ops.collections WHERE statement_id = p_statement AND line_no = p_line AND status <> 'rejected') THEN
    PERFORM exit.fail('23505', 'the bank line is already recorded');
  END IF;
  SELECT * INTO cr FROM bank.credits WHERE raast_ref = l.reference;
  IF FOUND THEN
    -- EX-6: a credit the bank service booked is proceeds only if it went to suspense (no payment code matched it).
    IF cr.status <> 'suspense' OR cr.amount_paisa <> l.amount_paisa THEN
      PERFORM exit.fail('23514', format('the credit %s was matched to another payment, or differs from the statement line', l.reference));
    END IF;
    IF EXISTS (SELECT 1 FROM bank.credit_returns r WHERE r.raast_ref = cr.raast_ref) THEN PERFORM exit.fail('23514', 'the credit was returned to the payer'); END IF;
    IF EXISTS (SELECT 1 FROM ledger.journal j JOIN ledger.postings p ON p.journal_id = j.id JOIN ledger.accounts a ON a.id = p.account_id
               WHERE j.external_ref = l.reference AND a.code = 'bank:suspense' AND p.amount > 0) THEN
      PERFORM exit.fail('23514', 'the suspense credit was already re-attributed');
    END IF;
    v_source := 'suspense_credit';
    v_debit := 'bank:suspense';
  ELSE
    IF v_ledger <> 'bank:trustee-escrow' THEN
      PERFORM exit.fail('23514', 'sale proceeds are paid into the trustee escrow only (EX-7): this line is on another account');
    END IF;
    IF EXISTS (SELECT 1 FROM ledger.journal j JOIN ledger.postings p ON p.journal_id = j.id JOIN ledger.accounts a ON a.id = p.account_id
               WHERE j.external_ref = l.reference AND a.code = v_ledger) THEN
      PERFORM exit.fail('23514', format('the bank line %s is already booked in the ledger as something else', l.reference));
    END IF;
    v_source := 'escrow_line';
    v_debit := v_ledger;
  END IF;
  IF p_kind = 'deposit' AND EXISTS (SELECT 1 FROM exit.proceeds WHERE case_id = p_case AND kind = 'deposit' AND status <> 'rejected') THEN
    PERFORM exit.fail('23505', 'the deposit is already recorded');
  END IF;
  SELECT coalesce(max(seq), 0) + 1 INTO v_seq FROM exit.proceeds WHERE case_id = p_case AND kind = p_kind;
  INSERT INTO exit.proceeds (case_id, kind, seq, statement_id, line_no, bank_account, bank_reference, value_date, amount_paisa, source, debit_account, note, proposed_by)
  VALUES (p_case, p_kind, v_seq, p_statement, p_line, l.account, l.reference, l.value_date, l.amount_paisa, v_source, v_debit, btrim(p_note), p_actor)
  RETURNING id INTO v_id;
  PERFORM exit.audit_append(p_actor, 'proceeds.proposed', jsonb_build_object('case', p_case, 'proceeds', v_id, 'kind', p_kind, 'statement', p_statement,
    'line', p_line, 'reference', l.reference, 'amount', l.amount_paisa::text, 'source', v_source));
  RETURN v_id;
END $$;

CREATE FUNCTION exit.decide_proceeds(p_id bigint, p_actor text, p_decision text, p_reason text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, exit AS $$
DECLARE
  r exit.proceeds;
  c exit.cases;
  v_key text;
  v_journal bigint;
  v_to text;
BEGIN
  PERFORM exit.check_actor(p_actor);
  PERFORM exit.check_text(p_reason, 10, 500, 'reason');
  IF p_decision IS NULL OR p_decision NOT IN ('approve', 'reject') THEN PERFORM exit.fail('22023', 'decision must be approve or reject'); END IF;
  SELECT * INTO r FROM exit.proceeds WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN PERFORM exit.fail('P0002', 'unknown proceeds record'); END IF;
  IF r.status <> 'proposed' THEN PERFORM exit.fail('23514', format('the proceeds record is already %s', r.status)); END IF;
  IF r.proposed_by = p_actor THEN PERFORM exit.fail('42501', 'maker-checker: whoever recorded the proceeds cannot decide them'); END IF;
  SELECT * INTO c FROM exit.cases WHERE id = r.case_id FOR UPDATE;
  IF p_decision = 'approve' THEN
    IF c.state NOT IN ('contracted', 'completed_sale') THEN PERFORM exit.fail('23514', format('the case is %s', c.state)); END IF;
    PERFORM ledger.open_account(exit.pool(c.token), 'liability', 'PKR');
    v_key := CASE WHEN r.kind = 'deposit' THEN format('exit:%s:deposit', c.token) ELSE format('exit:%s:proceeds:%s', c.token, r.seq) END;
    v_journal := ledger.post_journal(v_key, CASE WHEN r.kind = 'deposit' THEN 'exit_deposit' ELSE 'exit_proceeds' END,
      left(format('Exit %s of case %s: %s', r.kind, c.id, r.note), 200), r.bank_reference, p_actor,
      jsonb_build_array(jsonb_build_object('account', r.debit_account, 'amount', r.amount_paisa::text),
                        jsonb_build_object('account', exit.pool(c.token), 'amount', (-r.amount_paisa)::text)));
    v_to := 'approved';
  ELSE
    v_to := 'rejected';
  END IF;
  UPDATE exit.proceeds SET status = v_to, decided_by = p_actor, decision_reason = btrim(p_reason), decided_at = clock_timestamp(), journal_id = v_journal
  WHERE id = p_id;
  PERFORM exit.audit_append(p_actor, 'proceeds.decided', jsonb_build_object('case', r.case_id, 'proceeds', p_id, 'decision', p_decision, 'status', v_to,
    'journal', v_journal));
  RETURN v_to;
END $$;

-- ================================================================== waterfall (EX-10/11, EX-DB-3)
CREATE FUNCTION exit.live_waterfall(p_case bigint) RETURNS exit.waterfalls
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, exit AS $$
  SELECT * FROM exit.waterfalls WHERE case_id = p_case AND status <> 'returned'
$$;

CREATE FUNCTION exit.waterfall_totals(p_waterfall bigint, OUT inflows bigint, OUT outflows bigint, OUT lines integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, exit AS $$
  SELECT coalesce(sum(amount_paisa) FILTER (WHERE exit.is_inflow(kind)), 0)::bigint,
         coalesce(sum(amount_paisa) FILTER (WHERE NOT exit.is_inflow(kind)), 0)::bigint, count(*)::integer
  FROM exit.waterfall_lines WHERE waterfall_id = p_waterfall AND withdrawn_at IS NULL
$$;

CREATE FUNCTION exit.waterfall_digest(p_id bigint) RETURNS bytea
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, exit AS $$
  SELECT sha256(convert_to('pt-exit-waterfall-v1' || jsonb_build_array(w.id, w.case_id, w.version, w.status, w.created_by, w.submitted_by, w.checked_by,
           exit.balance(exit.pool(c.token))::text,
           (SELECT jsonb_agg(jsonb_build_array(l.id, l.kind, l.payee, l.description, l.amount_paisa::text, encode(l.evidence_sha, 'hex')) ORDER BY exit.line_rank(l.kind), l.id)
            FROM exit.waterfall_lines l WHERE l.waterfall_id = w.id AND l.withdrawn_at IS NULL))::text, 'UTF8'))
  FROM exit.waterfalls w JOIN exit.cases c ON c.id = w.case_id WHERE w.id = p_id
$$;

/** A maker adds a line to the case's draft waterfall (a draft is started if none is live). */
CREATE FUNCTION exit.add_line(p_case bigint, p_kind text, p_payee text, p_description text, p_amount bigint, p_evidence text, p_actor text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, exit AS $$
DECLARE
  c exit.cases;
  w exit.waterfalls;
  v_id bigint;
BEGIN
  PERFORM exit.check_actor(p_actor);
  PERFORM exit.check_text(p_description, 5, 300, 'description');
  IF p_kind IS NULL OR exit.line_rank(p_kind) IS NULL THEN
    PERFORM exit.fail('22023', 'kind must be secured_debt, transaction_cost, sale_tax, payable, tenant_deposit, closure_reserve, reserve_release or rent_transfer');
  END IF;
  IF (p_kind IN ('secured_debt', 'transaction_cost', 'payable', 'tenant_deposit')) <> (p_payee IS NOT NULL) OR (p_payee IS NOT NULL AND p_payee !~ '^[a-z0-9][a-z0-9_-]{1,39}$') THEN
    PERFORM exit.fail('22023', 'a payee id (lower-case letters, digits, - and _) is given exactly for debts, costs, payables and tenant deposits');
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 OR p_amount > 100000000000000000 THEN PERFORM exit.fail('22023', 'the amount must be positive paisa'); END IF;
  SELECT * INTO c FROM exit.cases WHERE id = p_case FOR UPDATE;
  IF NOT FOUND THEN PERFORM exit.fail('P0002', 'unknown exit case'); END IF;
  IF c.state <> 'waterfall' THEN PERFORM exit.fail('23514', format('the waterfall is prepared after the proceeds are reconciled (the case is %s)', c.state)); END IF;
  w := exit.live_waterfall(p_case);
  IF w.id IS NULL THEN
    INSERT INTO exit.waterfalls (case_id, version, created_by)
    VALUES (p_case, (SELECT coalesce(max(version), 0) + 1 FROM exit.waterfalls WHERE case_id = p_case), p_actor) RETURNING * INTO w;
    PERFORM exit.audit_append(p_actor, 'waterfall.started', jsonb_build_object('case', p_case, 'waterfall', w.id, 'version', w.version));
  ELSIF w.status <> 'draft' THEN
    PERFORM exit.fail('23514', format('the waterfall is %s: lines are added to a draft only', w.status));
  END IF;
  INSERT INTO exit.waterfall_lines (waterfall_id, kind, payee, description, amount_paisa, evidence_sha, added_by)
  VALUES (w.id, p_kind, p_payee, btrim(p_description), p_amount, exit.sha(p_evidence, 'evidence (invoice, discharge letter, tax computation)'), p_actor)
  RETURNING id INTO v_id;
  PERFORM exit.audit_append(p_actor, 'waterfall.line_added', jsonb_build_object('case', p_case, 'waterfall', w.id, 'line', v_id, 'kind', p_kind,
    'payee', p_payee, 'amount', p_amount::text, 'evidence', p_evidence));
  RETURN v_id;
END $$;

CREATE FUNCTION exit.withdraw_line(p_line bigint, p_actor text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, exit AS $$
DECLARE
  l exit.waterfall_lines;
  w exit.waterfalls;
BEGIN
  PERFORM exit.check_actor(p_actor);
  SELECT * INTO l FROM exit.waterfall_lines WHERE id = p_line FOR UPDATE;
  IF NOT FOUND THEN PERFORM exit.fail('P0002', 'unknown waterfall line'); END IF;
  SELECT * INTO w FROM exit.waterfalls WHERE id = l.waterfall_id FOR UPDATE;
  IF w.status <> 'draft' OR l.withdrawn_at IS NOT NULL THEN PERFORM exit.fail('23514', 'only a line of a draft waterfall can be withdrawn, once'); END IF;
  UPDATE exit.waterfall_lines SET withdrawn_at = clock_timestamp() WHERE id = p_line;
  PERFORM exit.audit_append(p_actor, 'waterfall.line_withdrawn', jsonb_build_object('case', w.case_id, 'waterfall', w.id, 'line', p_line));
END $$;

/** Why the live waterfall's lines cannot be booked now (NULL = they can). */
CREATE FUNCTION exit.waterfall_problem(p_waterfall bigint) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, exit AS $$
DECLARE
  w exit.waterfalls;
  c exit.cases;
  t record;
  l record;
  v_pool bigint;
BEGIN
  SELECT * INTO w FROM exit.waterfalls WHERE id = p_waterfall;
  SELECT * INTO c FROM exit.cases WHERE id = w.case_id;
  IF c.state <> 'waterfall' THEN RETURN format('the case is %s', c.state); END IF;
  SELECT * INTO t FROM exit.waterfall_totals(w.id);
  IF t.lines = 0 THEN RETURN 'the waterfall has no lines'; END IF;
  v_pool := exit.balance(exit.pool(c.token));
  IF t.outflows > v_pool + t.inflows THEN
    RETURN format('the lines pay out %s paisa but the exit pool holds %s plus %s of inflows (EX-10)', t.outflows, v_pool, t.inflows);
  END IF;
  FOR l IN SELECT kind, sum(amount_paisa) AS amount FROM exit.waterfall_lines WHERE waterfall_id = w.id AND withdrawn_at IS NULL AND exit.is_inflow(kind) GROUP BY kind LOOP
    IF exit.balance(exit.line_account(c.token, l.kind, NULL)) < l.amount THEN
      RETURN format('%s of %s paisa exceeds what %s holds (%s)', l.kind, l.amount, exit.line_account(c.token, l.kind, NULL),
                    exit.balance(exit.line_account(c.token, l.kind, NULL)));
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM exit.waterfall_lines WHERE waterfall_id = w.id AND withdrawn_at IS NULL AND kind = 'closure_reserve') > 1 THEN
    RETURN 'one closure reserve line only';
  END IF;
  RETURN NULL;
END $$;

CREATE FUNCTION exit.submit_waterfall(p_case bigint, p_actor text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, exit AS $$
DECLARE
  w exit.waterfalls;
  v_problem text;
BEGIN
  PERFORM exit.check_actor(p_actor);
  PERFORM 1 FROM exit.cases WHERE id = p_case FOR UPDATE;
  w := exit.live_waterfall(p_case);
  IF w.id IS NULL OR w.status <> 'draft' THEN PERFORM exit.fail('23514', 'there is no draft waterfall to submit'); END IF;
  v_problem := exit.waterfall_problem(w.id);
  IF v_problem IS NOT NULL THEN PERFORM exit.fail('23514', v_problem); END IF;
  UPDATE exit.waterfalls SET status = 'submitted', submitted_by = p_actor, submitted_at = clock_timestamp() WHERE id = w.id;
  PERFORM exit.audit_append(p_actor, 'waterfall.submitted', jsonb_build_object('case', p_case, 'waterfall', w.id, 'digest', encode(exit.waterfall_digest(w.id), 'hex')));
  RETURN w.id;
END $$;

/** The operations checker's check (approve -> checked, reject -> returned). */
CREATE FUNCTION exit.check_waterfall(p_id bigint, p_actor text, p_decision text, p_reason text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, exit AS $$
DECLARE
  w exit.waterfalls;
  v_problem text;
  v_to text;
BEGIN
  PERFORM exit.check_actor(p_actor);
  PERFORM exit.check_text(p_reason, 10, 500, 'reason');
  IF p_decision IS NULL OR p_decision NOT IN ('approve', 'reject') THEN PERFORM exit.fail('22023', 'decision must be approve or reject'); END IF;
  SELECT * INTO w FROM exit.waterfalls WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN PERFORM exit.fail('P0002', 'unknown waterfall'); END IF;
  IF w.status <> 'submitted' THEN PERFORM exit.fail('23514', format('the waterfall is %s, not submitted', w.status)); END IF;
  IF p_actor IN (w.created_by, w.submitted_by) OR EXISTS (SELECT 1 FROM exit.waterfall_lines l WHERE l.waterfall_id = w.id AND l.added_by = p_actor) THEN
    PERFORM exit.fail('42501', 'maker-checker: whoever prepared the waterfall cannot check it (EX-SOD-3)');
  END IF;
  IF admin.officer_holds(p_actor, ARRAY['trustee_officer'], false) THEN
    PERFORM exit.fail('42501', 'the trustee approves after the operations check, not in its place');
  END IF;
  IF p_decision = 'approve' THEN
    v_problem := exit.waterfall_problem(w.id);
    IF v_problem IS NOT NULL THEN PERFORM exit.fail('23514', v_problem); END IF;
    UPDATE exit.waterfalls SET status = 'checked', checked_by = p_actor, checked_at = clock_timestamp(), check_reason = btrim(p_reason) WHERE id = w.id;
    v_to := 'checked';
  ELSE
    UPDATE exit.waterfalls SET status = 'returned', returned_by = p_actor, returned_at = clock_timestamp(), return_reason = btrim(p_reason) WHERE id = w.id;
    v_to := 'returned';
  END IF;
  PERFORM exit.audit_append(p_actor, 'waterfall.checked', jsonb_build_object('case', w.case_id, 'waterfall', w.id, 'decision', p_decision, 'status', v_to));
  RETURN v_to;
END $$;

/** The trustee officer's approval: every line's journal posts here, in one transaction (EX-11). */
CREATE FUNCTION exit.approve_waterfall(p_id bigint, p_officer text, p_decision text, p_reason text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, exit AS $$
DECLARE
  w exit.waterfalls;
  c exit.cases;
  l exit.waterfall_lines;
  v_problem text;
  v_account text;
  v_journal bigint;
  v_to text;
BEGIN
  PERFORM exit.check_text(p_reason, 10, 500, 'reason');
  IF p_decision IS NULL OR p_decision NOT IN ('approve', 'reject') THEN PERFORM exit.fail('22023', 'decision must be approve or reject'); END IF;
  IF NOT admin.officer_holds(p_officer, ARRAY['trustee_officer'], true) THEN
    PERFORM exit.fail('42501', 'only an active trustee officer approves the waterfall (EX-11)');
  END IF;
  SELECT * INTO w FROM exit.waterfalls WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN PERFORM exit.fail('P0002', 'unknown waterfall'); END IF;
  IF w.status <> 'checked' THEN PERFORM exit.fail('23514', format('the waterfall is %s: the operations checker checks it first', w.status)); END IF;
  IF p_officer IN (w.created_by, w.submitted_by, w.checked_by) THEN PERFORM exit.fail('42501', 'maker, checker and trustee are three different people (EX-SOD-3)'); END IF;
  SELECT * INTO c FROM exit.cases WHERE id = w.case_id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM exit.conflicts f WHERE f.case_id = c.id AND f.officer = p_officer) THEN PERFORM exit.fail('42501', 'you declared a conflict on this case'); END IF;
  IF p_decision = 'reject' THEN
    UPDATE exit.waterfalls SET status = 'returned', returned_by = p_officer, returned_at = clock_timestamp(), return_reason = btrim(p_reason) WHERE id = w.id;
    v_to := 'returned';
  ELSE
    v_problem := exit.waterfall_problem(w.id);
    IF v_problem IS NOT NULL THEN PERFORM exit.fail('23514', v_problem); END IF;
    PERFORM ledger.open_account(exit.pool(c.token), 'liability', 'PKR');
    -- Inflows first (reserve release, undistributed rent), then the outflows in the deed's order.
    FOR l IN SELECT * FROM exit.waterfall_lines WHERE waterfall_id = w.id AND withdrawn_at IS NULL ORDER BY exit.line_rank(kind), id FOR UPDATE LOOP
      v_account := exit.line_account(c.token, l.kind, l.payee);
      PERFORM ledger.open_account(v_account, 'liability', 'PKR');
      IF exit.is_inflow(l.kind) THEN
        v_journal := ledger.post_journal(format('exit:%s:%s:%s', c.token, replace(l.kind, '_', '-'), l.id), 'exit_' || l.kind,
          left(l.description, 200), encode(l.evidence_sha, 'hex'), p_officer,
          jsonb_build_array(jsonb_build_object('account', v_account, 'amount', l.amount_paisa::text),
                            jsonb_build_object('account', exit.pool(c.token), 'amount', (-l.amount_paisa)::text)));
      ELSE
        v_journal := ledger.post_journal(format('exit:%s:waterfall:%s', c.token, l.id), 'exit_waterfall',
          left(l.description, 200), encode(l.evidence_sha, 'hex'), p_officer,
          jsonb_build_array(jsonb_build_object('account', exit.pool(c.token), 'amount', l.amount_paisa::text),
                            jsonb_build_object('account', v_account, 'amount', (-l.amount_paisa)::text)));
      END IF;
      UPDATE exit.waterfall_lines SET journal_id = v_journal WHERE id = l.id;
    END LOOP;
    UPDATE exit.waterfalls SET status = 'approved', approved_by = p_officer, approved_at = clock_timestamp(), approve_reason = btrim(p_reason) WHERE id = w.id;
    v_to := 'approved';
  END IF;
  PERFORM exit.audit_append(p_officer, 'waterfall.decided', jsonb_build_object('case', w.case_id, 'waterfall', w.id, 'decision', p_decision, 'status', v_to,
    'pool', exit.balance(exit.pool(c.token))::text));
  RETURN v_to;
END $$;

-- ================================================================== waterfall payments (EX-DB-3)
CREATE FUNCTION exit.paid_on_line(p_line bigint) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, exit AS $$
  SELECT coalesce(sum(amount_paisa), 0)::bigint FROM exit.payments WHERE line_id = p_line AND status = 'approved'
$$;

CREATE FUNCTION exit.payment_digest(p_id bigint) RETURNS bytea
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, exit AS $$
  SELECT sha256(convert_to('pt-exit-payment-v1' || jsonb_build_array(p.id, p.line_id, p.statement_id, p.line_no, p.bank_reference, p.value_date,
           p.amount_paisa::text, p.note, p.status, p.proposed_by)::text, 'UTF8'))
  FROM exit.payments p WHERE p.id = p_id
$$;

/**
 * A maker matches a bank statement debit on the trustee escrow to an approved outflow line. A line is
 * paid in full by one debit; only the closure reserve may be spent in several (never beyond it).
 */
CREATE FUNCTION exit.propose_payment(p_line bigint, p_statement bigint, p_line_no integer, p_note text, p_actor text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, exit AS $$
DECLARE
  wl exit.waterfall_lines;
  w exit.waterfalls;
  b recon.bank_lines;
  v_ledger text;
  v_open bigint;
  v_id bigint;
BEGIN
  PERFORM exit.check_actor(p_actor);
  PERFORM exit.check_text(p_note, 5, 300, 'note');
  SELECT * INTO wl FROM exit.waterfall_lines WHERE id = p_line FOR UPDATE;
  IF NOT FOUND THEN PERFORM exit.fail('P0002', 'unknown waterfall line'); END IF;
  SELECT * INTO w FROM exit.waterfalls WHERE id = wl.waterfall_id;
  IF w.status <> 'approved' OR wl.journal_id IS NULL OR wl.withdrawn_at IS NOT NULL OR exit.is_inflow(wl.kind) THEN
    PERFORM exit.fail('23514', 'only a booked outflow line of an approved waterfall is paid');
  END IF;
  SELECT * INTO b FROM recon.bank_lines WHERE statement_id = p_statement AND line_no = p_line_no;
  IF NOT FOUND THEN PERFORM exit.fail('P0002', 'unknown bank statement line'); END IF;
  IF b.amount_paisa >= 0 THEN PERFORM exit.fail('23514', 'only an outgoing bank line (a debit) pays a waterfall line'); END IF;
  SELECT ledger_account INTO v_ledger FROM recon.bank_accounts WHERE account = b.account;
  IF v_ledger IS DISTINCT FROM 'bank:trustee-escrow' THEN PERFORM exit.fail('23514', 'waterfall lines are paid from the trustee escrow'); END IF;
  IF EXISTS (SELECT 1 FROM exit.payments WHERE statement_id = p_statement AND line_no = p_line_no AND status <> 'rejected') THEN
    PERFORM exit.fail('23505', 'the bank line is already recorded');
  END IF;
  IF EXISTS (SELECT 1 FROM ledger.journal j JOIN ledger.postings p ON p.journal_id = j.id JOIN ledger.accounts a ON a.id = p.account_id
             WHERE j.external_ref = b.reference AND a.code = v_ledger) THEN
    PERFORM exit.fail('23514', format('the bank line %s is already booked in the ledger as something else', b.reference));
  END IF;
  IF EXISTS (SELECT 1 FROM exit.payments WHERE line_id = p_line AND status = 'proposed') THEN PERFORM exit.fail('23505', 'a payment of this line is waiting for its checker'); END IF;
  v_open := wl.amount_paisa - exit.paid_on_line(p_line);
  IF (wl.kind <> 'closure_reserve' AND -b.amount_paisa <> v_open) OR (wl.kind = 'closure_reserve' AND -b.amount_paisa > v_open) THEN
    PERFORM exit.fail('23514', format('the debit of %s paisa does not settle the line (%s paisa open)', -b.amount_paisa, v_open));
  END IF;
  INSERT INTO exit.payments (line_id, statement_id, line_no, bank_reference, value_date, amount_paisa, note, proposed_by)
  VALUES (p_line, p_statement, p_line_no, b.reference, b.value_date, -b.amount_paisa, btrim(p_note), p_actor) RETURNING id INTO v_id;
  PERFORM exit.audit_append(p_actor, 'payment.proposed', jsonb_build_object('case', w.case_id, 'payment', v_id, 'line', p_line, 'reference', b.reference,
    'amount', (-b.amount_paisa)::text));
  RETURN v_id;
END $$;

CREATE FUNCTION exit.decide_payment(p_id bigint, p_actor text, p_decision text, p_reason text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, exit AS $$
DECLARE
  p exit.payments;
  wl exit.waterfall_lines;
  c exit.cases;
  v_journal bigint;
  v_to text;
BEGIN
  PERFORM exit.check_actor(p_actor);
  PERFORM exit.check_text(p_reason, 10, 500, 'reason');
  IF p_decision IS NULL OR p_decision NOT IN ('approve', 'reject') THEN PERFORM exit.fail('22023', 'decision must be approve or reject'); END IF;
  SELECT * INTO p FROM exit.payments WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN PERFORM exit.fail('P0002', 'unknown payment'); END IF;
  IF p.status <> 'proposed' THEN PERFORM exit.fail('23514', format('the payment is already %s', p.status)); END IF;
  IF p.proposed_by = p_actor THEN PERFORM exit.fail('42501', 'maker-checker: whoever recorded the payment cannot decide it'); END IF;
  SELECT * INTO wl FROM exit.waterfall_lines WHERE id = p.line_id FOR UPDATE;
  SELECT c2.* INTO c FROM exit.cases c2 JOIN exit.waterfalls w ON w.case_id = c2.id WHERE w.id = wl.waterfall_id;
  IF p_decision = 'approve' THEN
    v_journal := ledger.post_journal(
      CASE WHEN wl.kind = 'closure_reserve' THEN format('exit:%s:waterfall:%s:paid:%s', c.token, wl.id, p.id) ELSE format('exit:%s:waterfall:%s:paid', c.token, wl.id) END,
      'exit_waterfall_paid', left(format('Paid: %s', wl.description), 200), p.bank_reference, p_actor,
      jsonb_build_array(jsonb_build_object('account', exit.line_account(c.token, wl.kind, wl.payee), 'amount', p.amount_paisa::text),
                        jsonb_build_object('account', 'bank:trustee-escrow', 'amount', (-p.amount_paisa)::text)));
    v_to := 'approved';
  ELSE
    v_to := 'rejected';
  END IF;
  UPDATE exit.payments SET status = v_to, decided_by = p_actor, decision_reason = btrim(p_reason), decided_at = clock_timestamp(), journal_id = v_journal WHERE id = p_id;
  PERFORM exit.audit_append(p_actor, 'payment.decided', jsonb_build_object('case', c.id, 'payment', p_id, 'decision', p_decision, 'status', v_to, 'journal', v_journal));
  RETURN v_to;
END $$;

-- ================================================================== the final distribution (EX-12/13, EX-DB-4)
/** EX-12: the maker announces the final record date (with the notice's SHA-256), at least record_notice_days ahead. */
CREATE FUNCTION exit.announce_record_date(p_case bigint, p_date date, p_notice text, p_actor text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, exit AS $$
DECLARE
  c exit.cases;
BEGIN
  PERFORM exit.check_actor(p_actor);
  SELECT * INTO c FROM exit.cases WHERE id = p_case FOR UPDATE;
  IF NOT FOUND THEN PERFORM exit.fail('P0002', 'unknown exit case'); END IF;
  IF c.state NOT IN ('completed_sale', 'waterfall') THEN PERFORM exit.fail('23514', format('the record date is announced after completion (the case is %s)', c.state)); END IF;
  IF c.record_date IS NOT NULL THEN PERFORM exit.fail('23505', 'the record date is already announced'); END IF;
  IF p_date IS NULL OR p_date < exit.pkt_today() + exit.setting_int('record_notice_days')::integer THEN
    PERFORM exit.fail('23514', format('the record date must be at least %s days ahead (EX-12)', exit.setting_int('record_notice_days')));
  END IF;
  UPDATE exit.cases SET record_date = p_date, record_announced_at = date_trunc('microseconds', clock_timestamp()),
         record_notice_sha = exit.sha(p_notice, 'record-date notice'), updated_at = date_trunc('microseconds', clock_timestamp())
  WHERE id = p_case;
  PERFORM exit.audit_append(p_actor, 'record_date.announced', jsonb_build_object('case', p_case, 'recordDate', p_date, 'notice', p_notice));
END $$;

CREATE FUNCTION exit.final_digest(p_id bigint) RETURNS bytea
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, exit AS $$
  SELECT sha256(convert_to('pt-exit-final-v1' || jsonb_build_array(f.id, f.case_id, f.token, f.record_date, f.record_block, f.income_type, f.proceeds::text,
           f.inflows::text, f.outflows::text, f.distributable_gross::text, f.sum_wht::text, f.sum_net::text, f.holders, f.flagged_lines, f.placeholder_lines,
           f.status, f.merkle_root, f.statement_hash, f.tax_schedule_hash, f.calculated_by, f.attached_by,
           (SELECT jsonb_build_array(p.decision, p.recomputed_root, p.officer) FROM exit.final_prechecks p WHERE p.final_id = f.id))::text, 'UTF8'))
  FROM exit.finals f WHERE f.id = p_id
$$;

/** The maker's calculation at the record block (OT-4 arithmetic, every holder a line). */
CREATE FUNCTION exit.calculate_final(p_case bigint, p_record_block bigint, p_actor text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, exit AS $$
DECLARE
  c exit.cases;
  w exit.waterfalls;
  t record;
  v_cursor bigint;
  v_from bigint;
  v_paused boolean;
  v_pool bigint;
  v_proceeds bigint;
  v_id bigint;
  s record;
BEGIN
  PERFORM exit.check_actor(p_actor);
  SELECT * INTO c FROM exit.cases WHERE id = p_case FOR UPDATE;
  IF NOT FOUND THEN PERFORM exit.fail('P0002', 'unknown exit case'); END IF;
  IF c.state <> 'waterfall' THEN PERFORM exit.fail('23514', format('the final distribution is calculated after the waterfall (the case is %s)', c.state)); END IF;
  SELECT * INTO w FROM exit.waterfalls WHERE case_id = p_case AND status = 'approved';
  IF NOT FOUND THEN PERFORM exit.fail('23514', 'the waterfall is not approved yet'); END IF;
  IF EXISTS (SELECT 1 FROM exit.finals WHERE case_id = p_case AND status <> 'returned') THEN PERFORM exit.fail('23505', 'a final distribution is already live for the case'); END IF;
  IF c.record_date IS NULL THEN PERFORM exit.fail('23514', 'announce the record date first (EX-12)'); END IF;
  IF c.record_date > exit.pkt_today() THEN PERFORM exit.fail('23514', format('the record date %s has not come yet', c.record_date)); END IF;
  IF (c.record_announced_at AT TIME ZONE 'Asia/Karachi')::date + exit.setting_int('record_notice_days')::integer > c.record_date THEN
    PERFORM exit.fail('23514', 'the record date was announced too late (EX-12)');
  END IF;
  IF EXISTS (SELECT 1 FROM exit.proceeds WHERE case_id = p_case AND status = 'proposed') THEN PERFORM exit.fail('23514', 'decide the pending proceeds first'); END IF;
  SELECT k.paused INTO v_paused FROM chain.tokens k WHERE k.token = c.token;
  IF v_paused IS DISTINCT FROM true THEN PERFORM exit.fail('23514', 'the token must be paused (transfer-closed) before the final record block (EX-12)'); END IF;
  SELECT cu.block_number, d.from_block INTO v_cursor, v_from
  FROM chain.tokens k JOIN chain.cursors cu ON cu.deployment = k.deployment JOIN chain.deployments d ON d.deployment = k.deployment WHERE k.token = c.token;
  IF p_record_block IS NULL OR p_record_block < v_from OR p_record_block > v_cursor THEN
    PERFORM exit.fail('23514', format('the record block must be indexed already (%s to %s)', v_from, v_cursor));
  END IF;
  IF EXISTS (SELECT 1 FROM chain.transfers x WHERE x.token = c.token AND x.block_number > p_record_block) THEN
    PERFORM exit.fail('23514', 'units moved after the record block: choose the block after the last movement (the token is transfer-closed)');
  END IF;
  FOR s IN SELECT x.status FROM (VALUES ('filer'), ('non_filer')) x(status) LOOP
    IF NOT EXISTS (SELECT 1 FROM tax.rate_for('exit_distribution', s.status, c.record_date)) THEN
      PERFORM exit.fail('23514', format('no %s rate is in force for exit distributions on %s: a tax officer must set one', s.status, c.record_date));
    END IF;
  END LOOP;
  v_pool := exit.balance(exit.pool(c.token));
  SELECT approved INTO v_proceeds FROM exit.proceeds_of(p_case);
  SELECT * INTO t FROM exit.waterfall_totals(w.id);
  IF v_pool <= 0 THEN PERFORM exit.fail('23514', 'nothing is left in the exit pool to distribute'); END IF;
  IF v_proceeds + t.inflows - t.outflows <> v_pool THEN
    PERFORM exit.fail('23514', format('the exit pool holds %s paisa, but proceeds %s + inflows %s - waterfall %s = %s (exit.waterfall_mismatch)', v_pool, v_proceeds,
                                      t.inflows, t.outflows, v_proceeds + t.inflows - t.outflows));
  END IF;

  DROP TABLE IF EXISTS pg_temp.exit_calc_lines;
  CREATE TEMP TABLE exit_calc_lines ON COMMIT DROP AS
  WITH b AS (
    SELECT h.wallet AS holder, h.units FROM exit.holders_at(c.token, p_record_block) h
  ), tot AS (
    SELECT sum(units) AS total FROM b
  ), sh AS (
    SELECT b.holder, b.units, floor(v_pool::numeric * b.units / tot.total) AS base, mod(v_pool::numeric * b.units, tot.total) AS rem FROM b, tot
  ), rk AS (
    SELECT sh.*, row_number() OVER (ORDER BY sh.rem DESC, sh.holder ASC) AS rn, v_pool - sum(sh.base) OVER () AS lft FROM sh
  ), g AS (
    SELECT rk.holder, rk.units, (rk.base + CASE WHEN rk.rn <= rk.lft THEN 1 ELSE 0 END)::bigint AS gross FROM rk
  )
  SELECT g.holder AS wallet, wa.subject_id, g.units, g.gross, fs.status AS filer_status, fs.check_id AS filer_check_id, fs.as_of AS filer_as_of,
         fs.flagged, fs.flag AS flag_reason, rt.id AS rate_id, rt.rate_ppm, rt.placeholder AS placeholder_rate, tax.withholding(g.gross, rt.rate_ppm) AS wht
  FROM g
  LEFT JOIN kyc.wallets wa ON wa.wallet = g.holder
  CROSS JOIN LATERAL tax.filer_status(wa.subject_id, c.record_date) fs
  CROSS JOIN LATERAL tax.rate_for('exit_distribution', fs.status, c.record_date) rt;
  IF NOT EXISTS (SELECT 1 FROM exit_calc_lines) THEN PERFORM exit.fail('23514', format('no units are held at block %s', p_record_block)); END IF;

  INSERT INTO exit.finals (case_id, token, record_date, record_block, income_type, proceeds, inflows, outflows, distributable_gross, holders, total_units,
                           sum_gross, sum_wht, sum_net, flagged_lines, placeholder_lines, calculated_by)
  SELECT p_case, c.token, c.record_date, p_record_block, 'exit_distribution', v_proceeds, t.inflows, t.outflows, v_pool, count(*), sum(l.units),
         sum(l.gross), sum(l.wht), sum(l.gross - l.wht), count(*) FILTER (WHERE l.flagged), count(*) FILTER (WHERE l.placeholder_rate), p_actor
  FROM exit_calc_lines l
  RETURNING id INTO v_id;
  INSERT INTO exit.final_lines (final_id, wallet, subject_id, units, gross, filer_status, filer_check_id, filer_as_of, flagged, flag_reason, rate_id, rate_ppm,
                                placeholder_rate, wht, net)
  SELECT v_id, l.wallet, l.subject_id, l.units, l.gross, l.filer_status, l.filer_check_id, l.filer_as_of, l.flagged, l.flag_reason, l.rate_id, l.rate_ppm,
         l.placeholder_rate, l.wht, l.gross - l.wht
  FROM exit_calc_lines l;
  DROP TABLE pg_temp.exit_calc_lines;
  PERFORM exit.audit_append(p_actor, 'final.calculated', (SELECT jsonb_build_object('case', p_case, 'final', f.id, 'recordDate', f.record_date,
    'recordBlock', f.record_block, 'gross', f.sum_gross::text, 'wht', f.sum_wht::text, 'net', f.sum_net::text, 'holders', f.holders,
    'units', f.total_units::text, 'flagged', f.flagged_lines, 'placeholder', f.placeholder_lines) FROM exit.finals f WHERE f.id = v_id));
  RETURN v_id;
END $$;

/** Lines as the exit service needs them for the statement and the tax schedule. */
CREATE FUNCTION exit.final_lines_of(p_id bigint)
RETURNS TABLE (wallet text, subject_id uuid, units text, gross bigint, filer_status text, filer_check_id bigint, filer_as_of date, flagged boolean,
               flag_reason text, rate_id bigint, rate_ppm integer, placeholder_rate boolean, wht bigint, net bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, exit AS $$
  SELECT l.wallet, l.subject_id, l.units::text, l.gross, l.filer_status, l.filer_check_id, l.filer_as_of, l.flagged, l.flag_reason, l.rate_id, l.rate_ppm,
         l.placeholder_rate, l.wht, l.net
  FROM exit.final_lines l WHERE l.final_id = p_id ORDER BY l.wallet
$$;

/** OT-5 for the final distribution: statement (distributionKind final) and tax schedule, checked line by line. */
CREATE FUNCTION exit.attach_final(p_id bigint, p_root text, p_statement text, p_statement_hash text, p_schedule text, p_schedule_hash text, p_actor text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, exit AS $$
DECLARE
  d exit.finals;
  v_s jsonb;
  v_t jsonb;
  v_lines integer;
  v_paid integer;
  v_bad integer;
BEGIN
  PERFORM exit.check_actor(p_actor);
  SELECT * INTO d FROM exit.finals WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN PERFORM exit.fail('P0002', 'unknown final distribution'); END IF;
  IF d.status <> 'calculated' THEN PERFORM exit.fail('23514', format('a statement is attached once, to a calculated final distribution (this one is %s)', d.status)); END IF;
  IF NOT (exit.is_hash(p_root) AND exit.is_hash(p_statement_hash) AND exit.is_hash(p_schedule_hash)) THEN
    PERFORM exit.fail('22023', 'root and hashes must be 0x + 64 lower-case hex characters');
  END IF;
  BEGIN
    v_s := p_statement::jsonb;
    v_t := p_schedule::jsonb;
  EXCEPTION WHEN invalid_text_representation THEN
    PERFORM exit.fail('22023', 'the statement and the tax schedule must be JSON');
  END;
  SELECT count(*), count(*) FILTER (WHERE net > 0) INTO v_lines, v_paid FROM exit.final_lines WHERE final_id = p_id;
  IF v_s->>'kind' IS DISTINCT FROM 'pt-rent-statement-v2' OR v_s->>'distributionKind' IS DISTINCT FROM 'final'
     OR v_s->>'exitCase' IS DISTINCT FROM d.case_id::text OR v_s->>'token' IS DISTINCT FROM d.token OR v_s->>'period' IS DISTINCT FROM 'final'
     OR v_s->>'recordDate' IS DISTINCT FROM d.record_date::text OR v_s->>'recordBlock' IS DISTINCT FROM d.record_block::text
     OR v_s->>'calculation' IS DISTINCT FROM d.id::text OR v_s->>'incomeType' IS DISTINCT FROM d.income_type
     OR v_s->>'taxScheduleHash' IS DISTINCT FROM p_schedule_hash
     OR v_s->'totals'->>'proceeds' IS DISTINCT FROM d.proceeds::text OR v_s->'totals'->>'inflows' IS DISTINCT FROM d.inflows::text
     OR v_s->'totals'->>'waterfall' IS DISTINCT FROM d.outflows::text
     OR v_s->'totals'->>'distributableGross' IS DISTINCT FROM d.distributable_gross::text
     OR v_s->'totals'->>'wht' IS DISTINCT FROM d.sum_wht::text OR v_s->'totals'->>'net' IS DISTINCT FROM d.sum_net::text
     OR v_s->'totals'->>'units' IS DISTINCT FROM d.total_units::text
     OR jsonb_typeof(v_s->'entitlements') IS DISTINCT FROM 'array' OR jsonb_array_length(v_s->'entitlements') <> v_paid THEN
    PERFORM exit.fail('23514', format('the statement does not match final distribution %s', p_id));
  END IF;
  SELECT count(*) INTO v_bad FROM exit.final_lines l
  WHERE l.final_id = p_id AND l.net > 0 AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_s->'entitlements') e WHERE e->>'wallet' = l.wallet AND e->>'units' = l.units::text AND e->>'netPaisa' = l.net::text);
  IF v_bad > 0 THEN PERFORM exit.fail('23514', format('the statement differs from the calculation in %s entitlement(s)', v_bad)); END IF;
  IF v_t->>'kind' IS DISTINCT FROM 'pt-tax-schedule-v1' OR v_t->>'token' IS DISTINCT FROM d.token OR v_t->>'period' IS DISTINCT FROM 'final'
     OR v_t->>'calculation' IS DISTINCT FROM d.id::text OR v_t->>'incomeType' IS DISTINCT FROM d.income_type
     OR v_t->>'recordDate' IS DISTINCT FROM d.record_date::text OR v_t->>'rounding' IS DISTINCT FROM 'half-up-paisa'
     OR v_t->>'rateScale' IS DISTINCT FROM '1000000'
     OR jsonb_typeof(v_t->'lines') IS DISTINCT FROM 'array' OR jsonb_array_length(v_t->'lines') <> v_lines THEN
    PERFORM exit.fail('23514', format('the tax schedule does not match final distribution %s', p_id));
  END IF;
  SELECT count(*) INTO v_bad FROM exit.final_lines l
  WHERE l.final_id = p_id AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_t->'lines') e
    WHERE e->>'wallet' = l.wallet AND e->>'subject' IS NOT DISTINCT FROM l.subject_id::text AND e->>'units' = l.units::text
      AND e->>'grossPaisa' = l.gross::text AND e->>'status' = l.filer_status AND e->>'filerCheck' IS NOT DISTINCT FROM l.filer_check_id::text
      AND e->>'filerAsOf' IS NOT DISTINCT FROM l.filer_as_of::text AND (e->>'flagged')::boolean = l.flagged
      AND e->>'rateId' = l.rate_id::text AND e->>'ratePpm' = l.rate_ppm::text AND e->>'whtPaisa' = l.wht::text AND e->>'netPaisa' = l.net::text);
  IF v_bad > 0 THEN PERFORM exit.fail('23514', format('the tax schedule differs from the calculation in %s line(s)', v_bad)); END IF;
  UPDATE exit.finals SET status = 'attached', merkle_root = p_root, statement = p_statement, statement_hash = p_statement_hash,
         tax_schedule = p_schedule, tax_schedule_hash = p_schedule_hash, attached_by = p_actor, attached_at = clock_timestamp()
  WHERE id = p_id;
  PERFORM exit.audit_append(p_actor, 'final.attached', jsonb_build_object('case', d.case_id, 'final', p_id, 'root', p_root, 'statementHash', p_statement_hash,
    'taxScheduleHash', p_schedule_hash));
END $$;

/** D4: the trustee officer's pre-check (approve with the root they recomputed, or reject: the final is returned). */
CREATE FUNCTION exit.precheck_final(p_id bigint, p_officer text, p_decision text, p_reason text, p_digest bytea, p_root text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, exit AS $$
DECLARE
  d exit.finals;
BEGIN
  PERFORM exit.check_text(p_reason, 10, 500, 'reason');
  IF p_decision IS NULL OR p_decision NOT IN ('approve', 'reject') THEN PERFORM exit.fail('22023', 'decision must be approve or reject'); END IF;
  IF NOT admin.officer_holds(p_officer, ARRAY['trustee_officer'], true) THEN PERFORM exit.fail('42501', 'only an active trustee officer pre-checks the final distribution'); END IF;
  SELECT * INTO d FROM exit.finals WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN PERFORM exit.fail('P0002', 'unknown final distribution'); END IF;
  IF d.status <> 'attached' THEN PERFORM exit.fail('23514', format('the final distribution is %s: the pre-check is of an attached statement', d.status)); END IF;
  IF EXISTS (SELECT 1 FROM exit.final_prechecks WHERE final_id = p_id) THEN PERFORM exit.fail('23505', 'the trustee already pre-checked this final distribution'); END IF;
  IF p_officer = d.calculated_by OR p_officer = d.attached_by THEN PERFORM exit.fail('42501', 'the calculator or attacher cannot pre-check it'); END IF;
  IF EXISTS (SELECT 1 FROM exit.conflicts f WHERE f.case_id = d.case_id AND f.officer = p_officer) THEN PERFORM exit.fail('42501', 'you declared a conflict on this case'); END IF;
  IF p_digest IS DISTINCT FROM exit.final_digest(p_id) THEN PERFORM exit.fail('23514', 'the final distribution changed since you reviewed it: reload'); END IF;
  IF p_decision = 'approve' AND lower(p_root) IS DISTINCT FROM d.merkle_root THEN
    PERFORM exit.fail('23514', 'your recomputed Merkle root differs from the attached root: reject instead');
  END IF;
  INSERT INTO exit.final_prechecks (final_id, decision, recomputed_root, reason, officer, digest)
  VALUES (p_id, p_decision, CASE WHEN p_decision = 'approve' THEN lower(p_root) END, btrim(p_reason), p_officer, p_digest);
  IF p_decision = 'reject' THEN
    UPDATE exit.finals SET status = 'returned', returned_reason = 'refused by the trustee pre-check' WHERE id = p_id;
  END IF;
  PERFORM exit.audit_append(p_officer, 'final.prechecked', jsonb_build_object('case', d.case_id, 'final', p_id, 'decision', p_decision, 'root', d.merkle_root,
    'digest', encode(p_digest, 'hex')));
  RETURN CASE WHEN p_decision = 'approve' THEN 'attached' ELSE 'returned' END;
END $$;

/** OT-6: the operations checker approves (after the trustee pre-check) or returns the calculation. */
CREATE FUNCTION exit.decide_final(p_id bigint, p_actor text, p_decision text, p_reason text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, exit AS $$
DECLARE
  d exit.finals;
  v_to text;
BEGIN
  PERFORM exit.check_actor(p_actor);
  PERFORM exit.check_text(p_reason, 10, 500, 'reason');
  IF p_decision IS NULL OR p_decision NOT IN ('approve', 'reject') THEN PERFORM exit.fail('22023', 'decision must be approve or reject'); END IF;
  SELECT * INTO d FROM exit.finals WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN PERFORM exit.fail('P0002', 'unknown final distribution'); END IF;
  IF p_actor = d.calculated_by OR p_actor IS NOT DISTINCT FROM d.attached_by THEN
    PERFORM exit.fail('42501', 'maker-checker: whoever calculated or attached the statement cannot decide the final distribution');
  END IF;
  IF admin.officer_holds(p_actor, ARRAY['trustee_officer'], false) THEN PERFORM exit.fail('42501', 'the trustee pre-checks; the operations checker decides'); END IF;
  IF p_decision = 'approve' THEN
    IF d.status <> 'attached' THEN PERFORM exit.fail('23514', format('only a final distribution with its statement attached can be approved (this one is %s)', d.status)); END IF;
    IF NOT EXISTS (SELECT 1 FROM exit.final_prechecks p WHERE p.final_id = p_id AND p.decision = 'approve') THEN
      PERFORM exit.fail('23514', 'the trustee''s pre-check (recomputed root) comes first (D4)');
    END IF;
    IF d.placeholder_lines > 0 AND (ops.setting('allow_placeholder_rates'))::text <> 'true' THEN
      PERFORM exit.fail('23514', format('the final distribution uses PLACEHOLDER tax rates on %s line(s) (LEGAL/TAX TO CONFIRM): confirmed rates are needed first', d.placeholder_lines));
    END IF;
    v_to := 'approved';
    UPDATE exit.finals SET status = 'approved', decided_by = p_actor, decision_reason = btrim(p_reason), decided_at = clock_timestamp() WHERE id = p_id;
  ELSE
    IF d.status NOT IN ('calculated', 'attached') THEN PERFORM exit.fail('23514', format('the final distribution is already %s', d.status)); END IF;
    v_to := 'returned';
    UPDATE exit.finals SET status = 'returned', returned_reason = 'returned by the operations checker', decided_by = p_actor, decision_reason = btrim(p_reason),
           decided_at = clock_timestamp() WHERE id = p_id;
  END IF;
  PERFORM exit.audit_append(p_actor, 'final.decided', jsonb_build_object('case', d.case_id, 'final', p_id, 'decision', p_decision, 'status', v_to,
    'statementHash', d.statement_hash));
  RETURN v_to;
END $$;

/** Internal (X16): books the finalized final distribution from the exit pool (rent:wht + rent:distribution). */
CREATE FUNCTION exit.book_final(p_final bigint, p_actor text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, exit AS $$
DECLARE
  d exit.finals;
  k exit.final_links;
  cd chain.distributions;
  v_wht bigint;
  v_dist bigint;
  v_postings jsonb;
  l record;
BEGIN
  SELECT * INTO d FROM exit.finals WHERE id = p_final FOR UPDATE;
  IF d.status <> 'approved' THEN PERFORM exit.fail('23514', format('only an approved final distribution is booked (this one is %s)', d.status)); END IF;
  SELECT * INTO k FROM exit.final_links WHERE final_id = p_final;
  IF NOT FOUND THEN PERFORM exit.fail('23514', 'the final distribution is not seen on chain yet (exit.tick)'); END IF;
  SELECT * INTO cd FROM chain.distributions WHERE registry = k.registry AND id = k.onchain_id;
  IF NOT FOUND OR cd.status NOT IN ('finalized', 'paid') THEN PERFORM exit.fail('23514', 'the on-chain distribution is not finalized (D9)'); END IF;
  IF cd.token <> d.token OR cd.record_block <> d.record_block OR cd.merkle_root <> d.merkle_root OR cd.statement_hash <> d.statement_hash OR cd.total_paisa <> d.sum_net THEN
    PERFORM exit.fail('23514', 'the on-chain distribution differs from the final calculation (token, record block, root, statement hash or total)');
  END IF;
  PERFORM ledger.open_account(exit.pool(d.token), 'liability', 'PKR');
  IF d.sum_wht > 0 THEN
    PERFORM ledger.open_account('tax:wht-payable:' || d.token, 'liability', 'PKR');
    v_wht := ledger.post_journal(format('rent:wht:%s:%s', d.token, cd.id), 'rent_wht',
      format('FBR withholding on the final distribution %s (exit case %s)', cd.id, d.case_id), d.statement_hash, p_actor,
      jsonb_build_array(jsonb_build_object('account', exit.pool(d.token), 'amount', d.sum_wht::text),
                        jsonb_build_object('account', 'tax:wht-payable:' || d.token, 'amount', (-d.sum_wht)::text)));
  END IF;
  v_postings := jsonb_build_array(jsonb_build_object('account', exit.pool(d.token), 'amount', d.sum_net::text));
  FOR l IN SELECT CASE WHEN x.subject_id IS NULL THEN 'rent:payable:wallet:' || x.wallet ELSE 'rent:payable:' || x.subject_id::text END AS account, sum(x.net) AS net
           FROM exit.final_lines x WHERE x.final_id = p_final AND x.net > 0 GROUP BY 1 ORDER BY 1 LOOP
    PERFORM ledger.open_account(l.account, 'liability', 'PKR');
    v_postings := v_postings || jsonb_build_array(jsonb_build_object('account', l.account, 'amount', (-l.net)::text));
  END LOOP;
  v_dist := ledger.post_journal(format('rent:distribution:%s:%s', d.token, cd.id), 'rent_distribution',
    format('Final distribution %s (exit case %s), net of withholding', cd.id, d.case_id), d.statement_hash, p_actor, v_postings);
  UPDATE exit.finals SET status = 'booked', registry = k.registry, onchain_id = k.onchain_id, wht_journal_id = v_wht, distribution_journal_id = v_dist,
         booked_at = clock_timestamp()
  WHERE id = p_final;
  PERFORM exit.audit_append(p_actor, 'final.booked', jsonb_build_object('case', d.case_id, 'final', p_final, 'registry', k.registry, 'onchainId', k.onchain_id::text,
    'whtJournal', v_wht, 'distributionJournal', v_dist, 'wht', d.sum_wht::text, 'net', d.sum_net::text));
  RETURN v_dist;
END $$;

-- ================================================================== the redemption batch (X16, EX-14/15, EX-DB-5)
/** What the exit service needs to derive the refIds: the final's token, on-chain id and the holders at the record block. */
CREATE FUNCTION exit.redemption_holders(p_case bigint)
RETURNS TABLE (token text, distribution_id numeric, record_block bigint, wallet text, units text, subject_id uuid, net bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, exit AS $$
  SELECT f.token, k.onchain_id, f.record_block, l.wallet, l.units::text, l.subject_id, l.net
  FROM exit.finals f JOIN exit.final_links k ON k.final_id = f.id JOIN exit.final_lines l ON l.final_id = f.id
  WHERE f.case_id = p_case AND f.status = 'approved'
  ORDER BY l.wallet
$$;

CREATE FUNCTION exit.redemption_items_digest(p_rows jsonb) RETURNS bytea
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT sha256(convert_to('pt-exit-redemption-v1' || coalesce(p_rows, '[]'::jsonb)::text, 'UTF8'))
$$;

CREATE FUNCTION exit.redemption_digest(p_id bigint) RETURNS bytea
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, exit AS $$
  SELECT sha256(convert_to('pt-exit-redemption-batch-v1' || jsonb_build_array(r.id, r.case_id, r.final_id, r.burn_rule, r.lines, r.total_units::text,
           encode(r.items_digest, 'hex'), r.status, r.created_by, r.checked_by, encode(exit.final_digest(r.final_id), 'hex'))::text, 'UTF8'))
  FROM exit.redemptions r WHERE r.id = p_id
$$;

/**
 * The maker creates the batch after the final distribution is finalized on chain. p_items:
 * [{"wallet", "units", "refId"}] exactly the holders at the record block with their balances; the
 * refIds come from the exit service (keccak256, re-derived by the signer and reconciliation).
 */
CREATE FUNCTION exit.create_redemption(p_case bigint, p_items jsonb, p_burn_rule text, p_actor text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, exit AS $$
DECLARE
  c exit.cases;
  f exit.finals;
  k exit.final_links;
  v_status text;
  v_rule text := coalesce(p_burn_rule, exit.setting('default_burn_rule') #>> '{}');
  v_bad text;
  v_rows jsonb;
  v_total numeric;
  v_id bigint;
BEGIN
  PERFORM exit.check_actor(p_actor);
  IF v_rule NOT IN ('after_payment', 'after_finalization') THEN PERFORM exit.fail('22023', 'burn rule must be after_payment or after_finalization'); END IF;
  SELECT * INTO c FROM exit.cases WHERE id = p_case FOR UPDATE;
  IF NOT FOUND THEN PERFORM exit.fail('P0002', 'unknown exit case'); END IF;
  IF c.state <> 'final_finalized' THEN PERFORM exit.fail('23514', format('the redemption batch follows the finalized final distribution (the case is %s)', c.state)); END IF;
  IF EXISTS (SELECT 1 FROM exit.redemptions WHERE case_id = p_case AND status <> 'rejected') THEN PERFORM exit.fail('23505', 'the case already has a redemption batch'); END IF;
  SELECT * INTO f FROM exit.finals WHERE case_id = p_case AND status = 'approved';
  SELECT * INTO k FROM exit.final_links WHERE final_id = f.id;
  SELECT status INTO v_status FROM chain.distributions WHERE registry = k.registry AND id = k.onchain_id;
  IF f.id IS NULL OR k.final_id IS NULL OR v_status IS DISTINCT FROM 'finalized' THEN
    PERFORM exit.fail('23514', 'the final distribution must be approved and finalized on chain');
  END IF;
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items) NOT BETWEEN 1 AND 50000 THEN
    PERFORM exit.fail('22023', '1 to 50,000 items are required');
  END IF;
  SELECT string_agg(ord::text, ',') INTO v_bad FROM jsonb_array_elements(p_items) WITH ORDINALITY t(e, ord)
  WHERE jsonb_typeof(e) IS DISTINCT FROM 'object' OR NOT exit.is_address(e->>'wallet') OR NOT exit.is_hash(e->>'refId')
     OR jsonb_typeof(e->'units') IS DISTINCT FROM 'string' OR (e->>'units') !~ '^[1-9][0-9]{0,17}$';
  IF v_bad IS NOT NULL THEN PERFORM exit.fail('22023', format('malformed item(s) at position %s', left(v_bad, 200))); END IF;
  IF (SELECT count(DISTINCT e->>'wallet') FROM jsonb_array_elements(p_items) e) <> jsonb_array_length(p_items)
     OR (SELECT count(DISTINCT e->>'refId') FROM jsonb_array_elements(p_items) e) <> jsonb_array_length(p_items) THEN
    PERFORM exit.fail('22023', 'wallets and refIds must be distinct');
  END IF;
  -- EX-15: exactly the holders at the record block, each with its balance there, and nothing moved since.
  IF EXISTS (SELECT 1 FROM chain.transfers x WHERE x.token = c.token AND x.block_number > f.record_block) THEN
    PERFORM exit.fail('23514', 'units moved after the record block: the register must be resolved first (S-06 / S-04)');
  END IF;
  IF EXISTS (
       SELECT 1 FROM (SELECT e->>'wallet' AS wallet, (e->>'units')::numeric AS units FROM jsonb_array_elements(p_items) e) i
       FULL JOIN (SELECT x.wallet, x.units FROM exit.final_lines x WHERE x.final_id = f.id) l ON l.wallet = i.wallet
       WHERE i.wallet IS NULL OR l.wallet IS NULL OR i.units <> l.units)
     OR EXISTS (
       SELECT 1 FROM (SELECT x.wallet, x.units FROM exit.final_lines x WHERE x.final_id = f.id) l
       FULL JOIN exit.holders_at(c.token, f.record_block) h ON h.wallet = l.wallet
       WHERE l.wallet IS NULL OR h.wallet IS NULL OR l.units <> h.units) THEN
    PERFORM exit.fail('23514', 'the items are not exactly the holders and balances at the record block (EX-15)');
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_items) e
             WHERE EXISTS (SELECT 1 FROM chain.issuances i WHERE i.ref_id = lower(e->>'refId'))
                OR EXISTS (SELECT 1 FROM offering.subscriptions s WHERE s.ref_id = lower(e->>'refId'))
                OR EXISTS (SELECT 1 FROM exit.redemption_lines r WHERE r.ref_id = lower(e->>'refId'))) THEN
    PERFORM exit.fail('23505', 'a refId was already used (I-11: each refId once, across mint and burn)');
  END IF;
  SELECT jsonb_agg(jsonb_build_array(e->>'wallet', e->>'units', lower(e->>'refId')) ORDER BY e->>'wallet'), sum((e->>'units')::numeric)
    INTO v_rows, v_total FROM jsonb_array_elements(p_items) e;
  IF v_total <> f.total_units OR v_total <> exit.supply_at(c.token, f.record_block) THEN
    PERFORM exit.fail('23514', 'the units do not sum to the supply at the record block (EX-15)');
  END IF;
  INSERT INTO exit.redemptions (case_id, final_id, burn_rule, lines, total_units, items_digest, created_by)
  VALUES (p_case, f.id, v_rule, jsonb_array_length(p_items), v_total, exit.redemption_items_digest(v_rows), p_actor)
  RETURNING id INTO v_id;
  INSERT INTO exit.redemption_lines (redemption_id, wallet, subject_id, units, ref_id, net)
  SELECT v_id, l.wallet, l.subject_id, l.units, lower(e->>'refId'), l.net
  FROM jsonb_array_elements(p_items) e JOIN exit.final_lines l ON l.final_id = f.id AND l.wallet = e->>'wallet';
  PERFORM exit.audit_append(p_actor, 'redemption.created', jsonb_build_object('case', p_case, 'redemption', v_id, 'final', f.id, 'burnRule', v_rule,
    'lines', jsonb_array_length(p_items), 'units', v_total::text, 'itemsDigest', encode(exit.redemption_items_digest(v_rows), 'hex')));
  RETURN v_id;
END $$;

/** The operations checker's check of the batch (approve -> checked, reject -> rejected). */
CREATE FUNCTION exit.check_redemption(p_id bigint, p_actor text, p_decision text, p_reason text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, exit AS $$
DECLARE
  r exit.redemptions;
  v_to text;
BEGIN
  PERFORM exit.check_actor(p_actor);
  PERFORM exit.check_text(p_reason, 10, 500, 'reason');
  IF p_decision IS NULL OR p_decision NOT IN ('approve', 'reject') THEN PERFORM exit.fail('22023', 'decision must be approve or reject'); END IF;
  SELECT * INTO r FROM exit.redemptions WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN PERFORM exit.fail('P0002', 'unknown redemption batch'); END IF;
  IF r.status <> 'created' THEN PERFORM exit.fail('23514', format('the batch is %s', r.status)); END IF;
  IF p_actor = r.created_by THEN PERFORM exit.fail('42501', 'maker-checker: whoever created the batch cannot check it'); END IF;
  IF admin.officer_holds(p_actor, ARRAY['trustee_officer'], false) THEN PERFORM exit.fail('42501', 'the trustee approves after the operations check, not in its place'); END IF;
  v_to := CASE WHEN p_decision = 'approve' THEN 'checked' ELSE 'rejected' END;
  IF v_to = 'checked' THEN
    UPDATE exit.redemptions SET status = 'checked', checked_by = p_actor, checked_at = clock_timestamp(), check_reason = btrim(p_reason) WHERE id = p_id;
  ELSE
    UPDATE exit.redemptions SET status = 'rejected', decided_by = p_actor, decided_at = clock_timestamp(), decision_reason = btrim(p_reason) WHERE id = p_id;
  END IF;
  PERFORM exit.audit_append(p_actor, 'redemption.checked', jsonb_build_object('case', r.case_id, 'redemption', p_id, 'decision', p_decision, 'status', v_to));
  RETURN v_to;
END $$;

/**
 * X16: the trustee officer approves the checked batch. In one transaction: the final distribution is
 * booked from the exit pool, the case moves to Redeeming and the eligible burns are enqueued.
 */
CREATE FUNCTION exit.approve_redemption(p_id bigint, p_officer text, p_decision text, p_reason text, p_digest bytea) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, exit AS $$
DECLARE
  r exit.redemptions;
  c exit.cases;
  v_to text;
BEGIN
  PERFORM exit.check_text(p_reason, 10, 500, 'reason');
  IF p_decision IS NULL OR p_decision NOT IN ('approve', 'reject') THEN PERFORM exit.fail('22023', 'decision must be approve or reject'); END IF;
  IF NOT admin.officer_holds(p_officer, ARRAY['trustee_officer'], true) THEN PERFORM exit.fail('42501', 'only an active trustee officer approves the redemption batch'); END IF;
  SELECT * INTO r FROM exit.redemptions WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN PERFORM exit.fail('P0002', 'unknown redemption batch'); END IF;
  IF r.status <> 'checked' THEN PERFORM exit.fail('23514', format('the batch is %s: the operations checker checks it first', r.status)); END IF;
  IF p_officer IN (r.created_by, r.checked_by) THEN PERFORM exit.fail('42501', 'maker, checker and trustee are three different people'); END IF;
  SELECT * INTO c FROM exit.cases WHERE id = r.case_id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM exit.conflicts f WHERE f.case_id = c.id AND f.officer = p_officer) THEN PERFORM exit.fail('42501', 'you declared a conflict on this case'); END IF;
  IF p_digest IS DISTINCT FROM exit.redemption_digest(p_id) THEN PERFORM exit.fail('23514', 'the batch changed since you reviewed it: reload and check again'); END IF;
  IF p_decision = 'reject' THEN
    UPDATE exit.redemptions SET status = 'rejected', decided_by = p_officer, decided_at = clock_timestamp(), decision_reason = btrim(p_reason) WHERE id = p_id;
    v_to := 'rejected';
  ELSE
    IF c.state <> 'final_finalized' THEN PERFORM exit.fail('23514', format('the case is %s', c.state)); END IF;
    PERFORM exit.book_final(r.final_id, p_officer);
    UPDATE exit.redemptions SET status = 'approved', decided_by = p_officer, decided_at = clock_timestamp(), decision_reason = btrim(p_reason) WHERE id = p_id;
    PERFORM exit.move(c.id, 'X16', p_officer, NULL);
    v_to := 'approved';
  END IF;
  PERFORM exit.audit_append(p_officer, 'redemption.decided', jsonb_build_object('case', r.case_id, 'redemption', p_id, 'decision', p_decision, 'status', v_to,
    'digest', encode(p_digest, 'hex')));
  IF v_to = 'approved' THEN PERFORM exit.enqueue_burns(c.id, p_officer); END IF;
  RETURN v_to;
END $$;

/**
 * Where a final line stands with the bank: nothing_to_pay (net 0), paid (in a submitted batch of the
 * final distribution, not held, not returned), in_payment (in a batch not submitted yet), held (held
 * in the batch, or no KYC binding), returned (the bank returned it), unpaid (no batch yet).
 */
CREATE FUNCTION exit.line_payment(p_redemption bigint, p_wallet text) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, exit AS $$
DECLARE
  l exit.redemption_lines;
  f exit.finals;
  v_token text;
  v_dist numeric;
BEGIN
  SELECT * INTO l FROM exit.redemption_lines WHERE redemption_id = p_redemption AND wallet = p_wallet;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF l.net = 0 THEN RETURN 'nothing_to_pay'; END IF;
  IF l.subject_id IS NULL THEN RETURN 'held'; END IF;
  SELECT f2.* INTO f FROM exit.finals f2 JOIN exit.redemptions r ON r.final_id = f2.id WHERE r.id = p_redemption;
  v_token := f.token;
  v_dist := coalesce(f.onchain_id, (SELECT onchain_id FROM exit.final_links WHERE final_id = f.id));
  IF EXISTS (SELECT 1 FROM bank.payout_batches b JOIN bank.payout_items i ON i.batch_id = b.id
             WHERE b.token = v_token AND b.distribution_id = v_dist AND b.status = 'submitted' AND i.subject_id = l.subject_id AND NOT i.held
               AND NOT EXISTS (SELECT 1 FROM bank.payout_returns x WHERE x.batch_id = i.batch_id AND x.line_no = i.line_no)) THEN
    RETURN 'paid';
  END IF;
  IF EXISTS (SELECT 1 FROM bank.payout_batches b JOIN bank.payout_items i ON i.batch_id = b.id
             WHERE b.token = v_token AND b.distribution_id = v_dist AND b.status = 'submitted' AND i.subject_id = l.subject_id AND NOT i.held) THEN
    RETURN 'returned';
  END IF;
  IF EXISTS (SELECT 1 FROM bank.payout_batches b JOIN bank.payout_items i ON i.batch_id = b.id
             WHERE b.token = v_token AND b.distribution_id = v_dist AND b.status IN ('created', 'approved') AND i.subject_id = l.subject_id AND NOT i.held) THEN
    RETURN 'in_payment';
  END IF;
  IF EXISTS (SELECT 1 FROM bank.payout_batches b JOIN bank.payout_items i ON i.batch_id = b.id
             WHERE b.token = v_token AND b.distribution_id = v_dist AND b.status = 'submitted' AND i.subject_id = l.subject_id AND i.held) THEN
    RETURN 'held';
  END IF;
  RETURN 'unpaid';
END $$;

/** Why a line may not be burned now (NULL = it may), under the batch's burn rule (S-05 section 14.1). */
CREATE FUNCTION exit.line_burn_problem(p_redemption bigint, p_wallet text) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, exit AS $$
DECLARE
  r exit.redemptions;
  l exit.redemption_lines;
  c exit.cases;
  v_pay text;
BEGIN
  SELECT * INTO r FROM exit.redemptions WHERE id = p_redemption;
  IF NOT FOUND OR r.status <> 'approved' THEN RETURN 'the redemption batch is not approved'; END IF;
  SELECT * INTO c FROM exit.cases WHERE id = r.case_id;
  IF c.state <> 'redeeming' THEN RETURN format('the case is %s, not redeeming', c.state); END IF;
  SELECT * INTO l FROM exit.redemption_lines WHERE redemption_id = p_redemption AND wallet = p_wallet;
  IF NOT FOUND THEN RETURN 'the wallet is not in the redemption batch'; END IF;
  IF EXISTS (SELECT 1 FROM chain.issuances i WHERE i.ref_id = l.ref_id) THEN RETURN 'already burned'; END IF;
  IF r.burn_rule = 'after_finalization' THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM exit.releases x WHERE x.redemption_id = p_redemption AND x.wallet = p_wallet) THEN RETURN NULL; END IF;
  v_pay := exit.line_payment(p_redemption, p_wallet);
  IF v_pay IN ('paid', 'nothing_to_pay') THEN RETURN NULL; END IF;
  RETURN format('the holder''s final line is %s: burned only after payment (burn rule after_payment) or a held-line release', v_pay);
END $$;

/** The outbox payload of a line's burn: IssuanceGuard.burn(wallet, units, refId). */
CREATE FUNCTION exit.burn_payload(p_token text, l exit.redemption_lines) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, exit AS $$
  SELECT jsonb_build_object('issuance', exit.contract_of(p_token, 'issuance'), 'from', l.wallet, 'amount', l.units::text, 'refId', l.ref_id)
$$;

/** Enqueues the burn of every line that became eligible (once per line). Returns how many were enqueued now. */
CREATE FUNCTION exit.enqueue_burns(p_case bigint, p_actor text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, exit AS $$
DECLARE
  c exit.cases;
  r exit.redemptions;
  l exit.redemption_lines;
  v_n integer := 0;
BEGIN
  SELECT * INTO c FROM exit.cases WHERE id = p_case;
  IF c.state <> 'redeeming' THEN RETURN 0; END IF;
  SELECT * INTO r FROM exit.redemptions WHERE case_id = p_case AND status = 'approved';
  IF NOT FOUND THEN RETURN 0; END IF;
  IF exit.contract_of(c.token, 'issuance') IS NULL THEN PERFORM exit.fail('23514', 'the IssuanceGuard of the token is not in the read model'); END IF;
  FOR l IN SELECT * FROM exit.redemption_lines x WHERE x.redemption_id = r.id AND NOT EXISTS (SELECT 1 FROM exit.burns b WHERE b.ref_id = x.ref_id) ORDER BY x.wallet LOOP
    CONTINUE WHEN exit.line_burn_problem(r.id, l.wallet) IS NOT NULL;
    PERFORM outbox.enqueue('burn:' || l.ref_id, 'issuance.burn', exit.burn_payload(c.token, l), coalesce(l.subject_id::text, l.wallet), p_actor);
    INSERT INTO exit.burns (ref_id, redemption_id, command_key, enqueued_by) VALUES (l.ref_id, r.id, 'burn:' || l.ref_id, p_actor);
    PERFORM exit.audit_append(p_actor, 'burn.enqueued', jsonb_build_object('case', p_case, 'redemption', r.id, 'wallet', l.wallet, 'units', l.units::text,
      'refId', l.ref_id, 'command', 'burn:' || l.ref_id));
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END $$;

/**
 * EX-DB-5, for the signing service (deny by default): problem is NULL when this is exactly a burn the
 * approved batch enqueued and the line may be burned now; token and distribution_id let the signer
 * re-derive the refId.
 */
CREATE FUNCTION exit.burn_allowed(p_payload jsonb) RETURNS TABLE (problem text, token text, distribution_id numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, exit AS $$
DECLARE
  l exit.redemption_lines;
  r exit.redemptions;
  f exit.finals;
  o outbox.commands;
BEGIN
  IF p_payload IS NULL OR NOT exit.is_hash(lower(p_payload->>'refId')) THEN
    RETURN QUERY SELECT 'malformed burn payload'::text, NULL::text, NULL::numeric; RETURN;
  END IF;
  SELECT * INTO l FROM exit.redemption_lines WHERE ref_id = lower(p_payload->>'refId');
  IF NOT FOUND THEN RETURN QUERY SELECT 'refId is not a line of an exit redemption batch'::text, NULL::text, NULL::numeric; RETURN; END IF;
  SELECT * INTO r FROM exit.redemptions WHERE id = l.redemption_id;
  SELECT * INTO f FROM exit.finals WHERE id = r.final_id;
  SELECT * INTO o FROM outbox.commands WHERE idempotency_key = 'burn:' || l.ref_id;
  IF NOT FOUND OR o.kind <> 'issuance.burn' OR o.payload <> p_payload THEN
    RETURN QUERY SELECT 'not the burn command the redemption batch enqueued'::text, f.token, f.onchain_id; RETURN;
  END IF;
  RETURN QUERY SELECT exit.line_burn_problem(r.id, l.wallet), f.token, f.onchain_id;
END $$;

-- ================================================================== X18 closure
/** Why the case cannot close now (NULL = it can). */
CREATE FUNCTION exit.close_problem(p_case bigint) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, exit AS $$
DECLARE
  c exit.cases;
  r exit.redemptions;
  t chain.tokens;
  v_n integer;
  v_register numeric;
BEGIN
  SELECT * INTO c FROM exit.cases WHERE id = p_case;
  IF c.state <> 'paid_out' THEN RETURN format('the case is %s, not paid out', c.state); END IF;
  SELECT * INTO r FROM exit.redemptions WHERE case_id = p_case AND status = 'approved';
  SELECT count(*) INTO v_n FROM exit.redemption_lines l WHERE l.redemption_id = r.id AND exit.line_payment(r.id, l.wallet) NOT IN ('paid', 'nothing_to_pay');
  IF v_n > 0 THEN RETURN format('%s final line(s) are not paid yet (held or returned): pay them by follow-up batches first (unclaimed rules: LEGAL)', v_n); END IF;
  IF exit.balance(exit.pool(c.token)) <> 0 THEN RETURN format('the exit pool still holds %s paisa', exit.balance(exit.pool(c.token))); END IF;
  IF exit.balance(exit.closure_reserve(c.token)) <> 0 THEN
    RETURN format('the closure reserve still holds %s paisa (spend it on wind-up costs or release it by a final adjustment)', exit.balance(exit.closure_reserve(c.token)));
  END IF;
  SELECT count(*) INTO v_n FROM exit.waterfall_lines wl JOIN exit.waterfalls w ON w.id = wl.waterfall_id
  WHERE w.case_id = p_case AND w.status = 'approved' AND wl.withdrawn_at IS NULL AND NOT exit.is_inflow(wl.kind) AND wl.kind <> 'closure_reserve'
    AND exit.paid_on_line(wl.id) <> wl.amount_paisa;
  IF v_n > 0 THEN RETURN format('%s waterfall line(s) are not paid from the escrow yet', v_n); END IF;
  SELECT * INTO t FROM chain.tokens WHERE token = c.token;
  IF t.total_supply <> 0 THEN RETURN format('the supply is %s, not 0', t.total_supply); END IF;
  IF t.trustee_cap <> 0 THEN RETURN 'the trustee cap is not 0 yet (setTrusteeCap(0) through the timelock, EX-15)'; END IF;
  SELECT coalesce(sum(units), 0) INTO v_register FROM trustee.register_entries WHERE token = c.token;
  IF v_register <> 0 THEN RETURN format('the trustee register still shows %s units', v_register); END IF;
  RETURN NULL;
END $$;

-- ================================================================== the tick (X13-X15, X17, burns seen; EX-DB-6)
/** Internal: a burn seen in the read model: subscriptions redeemed (V19) and the trustee register updated. */
CREATE FUNCTION exit.record_burn(c exit.cases, l exit.redemption_lines, p_actor text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, exit AS $$
DECLARE
  i chain.issuances;
  s record;
  v_register bigint := 0;
  v_rest bigint;
BEGIN
  SELECT * INTO i FROM chain.issuances WHERE ref_id = l.ref_id AND kind = 'burn';
  FOR s IN SELECT x.id, x.units FROM offering.subscriptions x JOIN offering.offerings o ON o.id = x.offering_id
           WHERE o.token = c.token AND x.wallet = l.wallet AND x.state = 'active' ORDER BY x.created_at, x.id LOOP
    PERFORM offering.sub_move(s.id, 'V19', 'redeemed', p_actor, format('units cancelled at exit (case %s, refId %s)', c.id, l.ref_id), NULL);
    v_register := v_register + s.units;
  END LOOP;
  v_rest := l.units::bigint - v_register;
  IF v_rest > 0 AND trustee.register_balance(c.token, l.wallet) >= v_rest THEN
    PERFORM trustee.enter(c.token, l.wallet, -v_rest, 'redemption', format('exit:%s:%s', c.id, l.ref_id), p_actor);
    v_register := v_register + v_rest;
  END IF;
  INSERT INTO exit.burns_seen (ref_id, block_number, tx_hash, amount, register_units) VALUES (l.ref_id, i.block_number, i.tx_hash, i.amount, v_register);
  PERFORM exit.audit_append(p_actor, 'burn.seen', jsonb_build_object('case', c.id, 'wallet', l.wallet, 'refId', l.ref_id, 'amount', i.amount::text,
    'block', i.block_number, 'tx', i.tx_hash, 'registerUnits', v_register));
END $$;

CREATE FUNCTION exit.tick_case(p_case bigint, p_actor text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, exit AS $$
DECLARE
  c exit.cases;
  f exit.finals;
  k exit.final_links;
  cd chain.distributions;
  r exit.redemptions;
  l exit.redemption_lines;
  v_n integer := 0;
BEGIN
  SELECT * INTO c FROM exit.cases WHERE id = p_case FOR UPDATE;
  IF NOT FOUND THEN RETURN 0; END IF;
  -- X13: link the approved final to its published distribution.
  IF c.state = 'waterfall' THEN
    SELECT * INTO f FROM exit.finals WHERE case_id = c.id AND status = 'approved';
    IF FOUND AND NOT EXISTS (SELECT 1 FROM exit.final_links WHERE final_id = f.id) THEN
      SELECT d.* INTO cd FROM chain.distributions d
      WHERE d.token = c.token AND d.record_block = f.record_block AND d.merkle_root = f.merkle_root AND d.statement_hash = f.statement_hash
        AND d.total_paisa = f.sum_net AND NOT EXISTS (SELECT 1 FROM exit.final_links x WHERE x.registry = d.registry AND x.onchain_id = d.id)
      ORDER BY d.id DESC LIMIT 1;
      IF FOUND THEN
        INSERT INTO exit.final_links (final_id, registry, onchain_id, linked_by) VALUES (f.id, cd.registry, cd.id, p_actor);
        PERFORM exit.audit_append(p_actor, 'final.linked', jsonb_build_object('case', c.id, 'final', f.id, 'registry', cd.registry, 'onchainId', cd.id::text,
          'status', cd.status));
        IF cd.status = 'rejected' THEN
          UPDATE exit.finals SET status = 'returned', returned_reason = 'rejected on chain (Trustee Safe)' WHERE id = f.id;
        ELSE
          PERFORM exit.move(c.id, 'X13', p_actor, NULL);
        END IF;
        v_n := v_n + 1;
        SELECT * INTO c FROM exit.cases WHERE id = p_case;
      END IF;
    END IF;
  END IF;
  -- X14 / X15: follow the on-chain distribution.
  IF c.state = 'final_published' THEN
    SELECT f2.* INTO f FROM exit.finals f2 WHERE f2.case_id = c.id AND f2.status = 'approved';
    SELECT * INTO k FROM exit.final_links WHERE final_id = f.id;
    SELECT * INTO cd FROM chain.distributions WHERE registry = k.registry AND id = k.onchain_id;
    IF cd.status = 'rejected' THEN
      UPDATE exit.finals SET status = 'returned', returned_reason = 'rejected on chain (Trustee Safe)' WHERE id = f.id;
      PERFORM exit.move(c.id, 'X14', p_actor, NULL);
      v_n := v_n + 1;
    ELSIF cd.status IN ('finalized', 'paid') THEN
      PERFORM exit.move(c.id, 'X15', p_actor, NULL);
      v_n := v_n + 1;
    END IF;
    SELECT * INTO c FROM exit.cases WHERE id = p_case;
  END IF;
  -- Redeeming: newly eligible burns, burns seen, then X17.
  IF c.state = 'redeeming' THEN
    v_n := v_n + exit.enqueue_burns(c.id, p_actor);
    SELECT * INTO r FROM exit.redemptions WHERE case_id = c.id AND status = 'approved';
    FOR l IN SELECT x.* FROM exit.redemption_lines x WHERE x.redemption_id = r.id
               AND EXISTS (SELECT 1 FROM chain.issuances i WHERE i.ref_id = x.ref_id AND i.kind = 'burn')
               AND NOT EXISTS (SELECT 1 FROM exit.burns_seen s WHERE s.ref_id = x.ref_id) ORDER BY x.wallet LOOP
      PERFORM exit.record_burn(c, l, p_actor);
      v_n := v_n + 1;
    END LOOP;
    SELECT f2.* INTO f FROM exit.finals f2 WHERE f2.id = r.final_id;
    SELECT * INTO cd FROM chain.distributions WHERE registry = f.registry AND id = f.onchain_id;
    IF (SELECT count(*) FROM exit.burns_seen s JOIN exit.redemption_lines x ON x.ref_id = s.ref_id WHERE x.redemption_id = r.id) = r.lines
       AND (SELECT total_supply FROM chain.tokens WHERE token = c.token) = 0
       AND cd.status = 'paid'
       AND EXISTS (SELECT 1 FROM bank.payout_batches b WHERE b.token = c.token AND b.distribution_id = f.onchain_id AND b.kind = 'distribution' AND b.status = 'submitted') THEN
      PERFORM exit.move(c.id, 'X17', p_actor, NULL);
      v_n := v_n + 1;
    END IF;
  END IF;
  RETURN v_n;
END $$;

/** All live cases (npm run exit:tick, and the portal's "Refresh from chain"). Idempotent. */
CREATE FUNCTION exit.tick(p_actor text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, exit AS $$
DECLARE
  v_case bigint;
  v_n integer := 0;
BEGIN
  PERFORM exit.check_actor(p_actor);
  PERFORM pg_advisory_xact_lock(586586272);
  FOR v_case IN SELECT id FROM exit.cases WHERE state IN ('waterfall', 'final_published', 'redeeming') ORDER BY id LOOP
    v_n := v_n + exit.tick_case(v_case, p_actor);
  END LOOP;
  RETURN v_n;
END $$;

-- ================================================================== redemption requests (phase 0, S-05 section 15, EX-DB-7)
/** EX-41: a token with a live exit case from Vote Open on takes no redemption windows or requests. */
CREATE FUNCTION exit.exit_underway(p_token text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, exit AS $$
  SELECT EXISTS (SELECT 1 FROM exit.cases c WHERE c.token = p_token AND c.state = ANY (exit.live_states()) AND c.state <> 'proposed')
$$;

CREATE FUNCTION exit.window_digest(p_id bigint) RETURNS bytea
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, exit AS $$
  SELECT sha256(convert_to('pt-exit-window-v1' || jsonb_build_array(w.id, w.token, exit.utc(w.opens_at), exit.utc(w.closes_at), w.nav_per_unit_paisa::text,
           encode(w.nav_evidence_sha, 'hex'), w.discount_ppm, w.price_per_unit_paisa::text, w.cap_units::text, w.note, w.status, w.proposed_by,
           w.outcome_status, w.outcome_by,
           (SELECT jsonb_build_array(count(*), coalesce(sum(r.units), 0)::text) FROM exit.requests r WHERE r.window_id = w.id AND r.status = 'submitted'))::text, 'UTF8'))
  FROM exit.windows w WHERE w.id = p_id
$$;

CREATE FUNCTION exit.propose_window(p_token text, p_opens timestamptz, p_closes timestamptz, p_nav bigint, p_nav_sha text, p_discount integer, p_note text,
                                    p_actor text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, exit AS $$
DECLARE
  v_token text := lower(p_token);
  v_id bigint;
BEGIN
  PERFORM exit.check_actor(p_actor);
  PERFORM exit.check_text(p_note, 10, 300, 'note');
  IF NOT exit.is_address(v_token) OR NOT EXISTS (SELECT 1 FROM chain.tokens WHERE token = v_token) THEN PERFORM exit.fail('P0002', 'the token is not in the read model'); END IF;
  IF p_opens IS NULL OR p_closes IS NULL OR p_closes <= p_opens OR p_closes <= clock_timestamp()
     OR p_closes > p_opens + make_interval(days => exit.setting_int('window_max_days')::integer) THEN
    PERFORM exit.fail('22023', format('a window closes after it opens, in the future, and lasts at most %s days', exit.setting_int('window_max_days')));
  END IF;
  IF p_nav IS NULL OR p_nav <= 0 OR p_nav > 100000000000 THEN PERFORM exit.fail('22023', 'the NAV per unit (positive paisa) is required'); END IF;
  IF p_discount IS NULL OR p_discount < 0 OR p_discount > exit.setting_int('window_max_discount_ppm') THEN
    PERFORM exit.fail('22023', format('the discount is 0 to %s ppm', exit.setting_int('window_max_discount_ppm')));
  END IF;
  PERFORM pg_advisory_xact_lock(586586273, hashtext(v_token));
  IF exit.exit_underway(v_token) THEN PERFORM exit.fail('23514', 'an exit is under way for this token: no redemption windows (EX-41)'); END IF;
  IF EXISTS (SELECT 1 FROM exit.windows w WHERE w.token = v_token AND w.status IN ('proposed', 'approved')
             AND tstzrange(w.opens_at, w.closes_at) && tstzrange(p_opens, p_closes)) THEN
    PERFORM exit.fail('23505', 'another window of this token overlaps these dates');
  END IF;
  INSERT INTO exit.windows (token, opens_at, closes_at, nav_per_unit_paisa, nav_evidence_sha, discount_ppm, price_per_unit_paisa, note, proposed_by)
  VALUES (v_token, p_opens, p_closes, p_nav, exit.sha(p_nav_sha, 'NAV valuation evidence'), p_discount,
          floor(p_nav::numeric * (1000000 - p_discount) / 1000000)::bigint, btrim(p_note), p_actor)
  RETURNING id INTO v_id;
  PERFORM exit.audit_append(p_actor, 'window.proposed', jsonb_build_object('window', v_id, 'token', v_token, 'opensAt', exit.utc(p_opens),
    'closesAt', exit.utc(p_closes), 'nav', p_nav::text, 'discountPpm', p_discount));
  RETURN v_id;
END $$;

CREATE FUNCTION exit.decide_window(p_id bigint, p_actor text, p_decision text, p_reason text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, exit AS $$
DECLARE
  w exit.windows;
  v_supply numeric;
  v_cap numeric;
  v_to text;
BEGIN
  PERFORM exit.check_actor(p_actor);
  PERFORM exit.check_text(p_reason, 10, 500, 'reason');
  IF p_decision IS NULL OR p_decision NOT IN ('approve', 'reject') THEN PERFORM exit.fail('22023', 'decision must be approve or reject'); END IF;
  SELECT * INTO w FROM exit.windows WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN PERFORM exit.fail('P0002', 'unknown redemption window'); END IF;
  IF w.status <> 'proposed' THEN PERFORM exit.fail('23514', format('the window is already %s', w.status)); END IF;
  IF w.proposed_by = p_actor THEN PERFORM exit.fail('42501', 'maker-checker: whoever proposed the window cannot decide it'); END IF;
  IF p_decision = 'approve' THEN
    IF w.closes_at <= clock_timestamp() THEN PERFORM exit.fail('23514', 'the window would already be closed'); END IF;
    IF exit.exit_underway(w.token) THEN PERFORM exit.fail('23514', 'an exit is under way for this token (EX-41)'); END IF;
    SELECT total_supply INTO v_supply FROM chain.tokens WHERE token = w.token;
    v_cap := floor(coalesce(v_supply, 0) * exit.setting_int('window_cap_ppm') / 1000000);
    IF v_cap < 1 THEN PERFORM exit.fail('23514', 'the supply is too small for a window cap of at least one unit'); END IF;
    UPDATE exit.windows SET status = 'approved', decided_by = p_actor, decision_reason = btrim(p_reason), decided_at = clock_timestamp(), cap_units = v_cap WHERE id = p_id;
    v_to := 'approved';
  ELSE
    UPDATE exit.windows SET status = 'rejected', decided_by = p_actor, decision_reason = btrim(p_reason), decided_at = clock_timestamp() WHERE id = p_id;
    v_to := 'rejected';
  END IF;
  PERFORM exit.audit_append(p_actor, 'window.decided', jsonb_build_object('window', p_id, 'decision', p_decision, 'status', v_to, 'capUnits', v_cap::text));
  RETURN v_to;
END $$;

/**
 * EX-40..43: a request of a KYC-verified holder in an open window, priced at the window's frozen
 * price. Idempotent per (window, investor, idempotency key). Raises 23514 with an investor-safe
 * message on a refusal.
 */
CREATE FUNCTION exit.request_redemption(p_window bigint, p_subject uuid, p_units numeric, p_idempotency text, p_actor text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, exit AS $$
DECLARE
  w exit.windows;
  q exit.requests;
  v_wallet text;
  v_balance numeric;
  v_frozen numeric;
  v_address_frozen boolean;
  v_used numeric;
BEGIN
  IF p_actor IS NULL OR length(p_actor) NOT BETWEEN 2 AND 100 THEN PERFORM exit.fail('22023', 'an actor is required'); END IF;
  IF p_idempotency IS NULL OR p_idempotency !~ '^[A-Za-z0-9][A-Za-z0-9:._-]{7,99}$' THEN PERFORM exit.fail('22023', 'an idempotency key is required'); END IF;
  IF p_units IS NULL OR p_units < 1 OR p_units <> trunc(p_units) OR p_units > 999999999999999999 THEN PERFORM exit.fail('22023', 'units must be a whole number of at least 1'); END IF;
  SELECT * INTO w FROM exit.windows WHERE id = p_window FOR UPDATE;
  IF NOT FOUND OR w.status <> 'approved' THEN PERFORM exit.fail('P0002', 'redemption window not found'); END IF;
  SELECT * INTO q FROM exit.requests WHERE window_id = p_window AND subject_id = p_subject AND idempotency_key = p_idempotency;
  IF FOUND THEN
    RETURN jsonb_build_object('id', q.id, 'status', q.status, 'units', q.units::text, 'pricePerUnitPaisa', q.price_per_unit_paisa::text,
                              'indicativePaisa', q.indicative_paisa::text, 'replayed', true);
  END IF;
  IF clock_timestamp() < w.opens_at OR clock_timestamp() >= w.closes_at THEN PERFORM exit.fail('23514', 'the redemption window is not open'); END IF;
  IF exit.exit_underway(w.token) THEN PERFORM exit.fail('23514', 'an exit is under way for this property: requests are closed'); END IF;
  IF kyc.subject_status(p_subject) IS DISTINCT FROM 'verified' THEN PERFORM exit.fail('42501', 'only a verified investor can request a redemption'); END IF;
  SELECT wallet INTO v_wallet FROM kyc.wallets WHERE subject_id = p_subject;
  IF v_wallet IS NULL THEN PERFORM exit.fail('42501', 'only a verified investor can request a redemption'); END IF;
  SELECT coalesce((SELECT balance FROM chain.holdings WHERE token = w.token AND holder = v_wallet), 0) INTO v_balance;
  SELECT coalesce(f.frozen_amount, 0), coalesce(f.address_frozen, false) INTO v_frozen, v_address_frozen FROM chain.freezes f WHERE f.token = w.token AND f.holder = v_wallet;
  IF coalesce(v_address_frozen, false) THEN PERFORM exit.fail('23514', 'your holding cannot be redeemed at the moment: please contact support'); END IF;
  IF p_units > v_balance - coalesce(v_frozen, 0) THEN PERFORM exit.fail('23514', 'you can request at most the units you hold (free of any hold)'); END IF;
  IF EXISTS (SELECT 1 FROM exit.requests WHERE window_id = p_window AND subject_id = p_subject AND status = 'submitted') THEN
    PERFORM exit.fail('23505', 'you already have a request in this window: withdraw it first to change it');
  END IF;
  SELECT coalesce(sum(units), 0) INTO v_used FROM exit.requests WHERE window_id = p_window AND status = 'submitted';
  IF v_used + p_units > w.cap_units THEN PERFORM exit.fail('23514', 'the window is full: it accepts no more units'); END IF;
  INSERT INTO exit.requests (window_id, subject_id, wallet, units, price_per_unit_paisa, indicative_paisa, idempotency_key, actor)
  VALUES (p_window, p_subject, v_wallet, p_units, w.price_per_unit_paisa, p_units * w.price_per_unit_paisa, p_idempotency, p_actor)
  RETURNING * INTO q;
  PERFORM exit.audit_append(p_actor, 'request.submitted', jsonb_build_object('window', p_window, 'request', q.id, 'subject', p_subject, 'units', p_units::text,
    'indicative', q.indicative_paisa::text));
  RETURN jsonb_build_object('id', q.id, 'status', q.status, 'units', q.units::text, 'pricePerUnitPaisa', q.price_per_unit_paisa::text,
                            'indicativePaisa', q.indicative_paisa::text, 'replayed', false);
END $$;

CREATE FUNCTION exit.withdraw_request(p_request uuid, p_subject uuid, p_actor text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, exit AS $$
DECLARE
  q exit.requests;
  w exit.windows;
BEGIN
  SELECT * INTO q FROM exit.requests WHERE id = p_request AND subject_id = p_subject FOR UPDATE;
  IF NOT FOUND THEN PERFORM exit.fail('P0002', 'request not found'); END IF;
  IF q.status <> 'submitted' THEN PERFORM exit.fail('23514', 'only a submitted request can be withdrawn'); END IF;
  SELECT * INTO w FROM exit.windows WHERE id = q.window_id;
  IF clock_timestamp() >= w.closes_at THEN PERFORM exit.fail('23514', 'the window has closed: the request can no longer be withdrawn'); END IF;
  UPDATE exit.requests SET status = 'withdrawn', closed_at = clock_timestamp() WHERE id = p_request;
  PERFORM exit.audit_append(p_actor, 'request.withdrawn', jsonb_build_object('window', q.window_id, 'request', p_request));
  RETURN 'withdrawn';
END $$;

/** EX-45: the maker proposes the outcome of a closed window. */
CREATE FUNCTION exit.propose_outcome(p_window bigint, p_actor text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, exit AS $$
DECLARE
  w exit.windows;
BEGIN
  PERFORM exit.check_actor(p_actor);
  SELECT * INTO w FROM exit.windows WHERE id = p_window FOR UPDATE;
  IF NOT FOUND THEN PERFORM exit.fail('P0002', 'unknown redemption window'); END IF;
  IF w.status <> 'approved' OR w.outcome_status <> 'none' THEN PERFORM exit.fail('23514', 'only an approved window without an outcome'); END IF;
  IF clock_timestamp() < w.closes_at THEN PERFORM exit.fail('23514', 'the window is still open'); END IF;
  UPDATE exit.windows SET outcome_status = 'proposed', outcome_by = p_actor, outcome_at = clock_timestamp() WHERE id = p_window;
  PERFORM exit.audit_append(p_actor, 'window.outcome_proposed', jsonb_build_object('window', p_window));
  RETURN 'proposed';
END $$;

/** EX-45: the checker approves (requests recorded or declined) or rejects (back to the maker) the outcome. */
CREATE FUNCTION exit.decide_outcome(p_window bigint, p_actor text, p_decision text, p_reason text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, exit AS $$
DECLARE
  w exit.windows;
  v_recorded integer;
  v_declined integer;
BEGIN
  PERFORM exit.check_actor(p_actor);
  PERFORM exit.check_text(p_reason, 10, 500, 'reason');
  IF p_decision IS NULL OR p_decision NOT IN ('approve', 'reject') THEN PERFORM exit.fail('22023', 'decision must be approve or reject'); END IF;
  SELECT * INTO w FROM exit.windows WHERE id = p_window FOR UPDATE;
  IF NOT FOUND THEN PERFORM exit.fail('P0002', 'unknown redemption window'); END IF;
  IF w.outcome_status <> 'proposed' THEN PERFORM exit.fail('23514', 'no outcome is waiting for a decision'); END IF;
  IF w.outcome_by = p_actor THEN PERFORM exit.fail('42501', 'maker-checker: whoever proposed the outcome cannot decide it'); END IF;
  IF p_decision = 'reject' THEN
    UPDATE exit.windows SET outcome_status = 'none', outcome_by = NULL, outcome_at = NULL WHERE id = p_window;
    PERFORM exit.audit_append(p_actor, 'window.outcome_decided', jsonb_build_object('window', p_window, 'decision', 'reject', 'reason', btrim(p_reason)));
    RETURN 'none';
  END IF;
  UPDATE exit.requests SET status = CASE WHEN kyc.subject_status(subject_id) = 'verified' THEN 'recorded' ELSE 'declined' END, closed_at = clock_timestamp()
  WHERE window_id = p_window AND status = 'submitted';
  SELECT count(*) FILTER (WHERE status = 'recorded'), count(*) FILTER (WHERE status = 'declined') INTO v_recorded, v_declined
  FROM exit.requests WHERE window_id = p_window;
  UPDATE exit.windows SET outcome_status = 'approved', outcome_decided_by = p_actor, outcome_decided_at = clock_timestamp(), outcome_reason = btrim(p_reason)
  WHERE id = p_window;
  PERFORM exit.audit_append(p_actor, 'window.outcome_decided', jsonb_build_object('window', p_window, 'decision', 'approve', 'recorded', v_recorded,
    'declined', v_declined));
  RETURN 'approved';
END $$;

-- The outcome may also go back from proposed to none (a rejected outcome): replace the window guard accordingly.
CREATE OR REPLACE FUNCTION exit.guard_window() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'redemption windows are never deleted' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF (NEW.id, NEW.token, NEW.opens_at, NEW.closes_at, NEW.nav_per_unit_paisa, NEW.nav_evidence_sha, NEW.discount_ppm, NEW.price_per_unit_paisa,
      NEW.note, NEW.proposed_by, NEW.proposed_at)
     IS DISTINCT FROM (OLD.id, OLD.token, OLD.opens_at, OLD.closes_at, OLD.nav_per_unit_paisa, OLD.nav_evidence_sha, OLD.discount_ppm,
      OLD.price_per_unit_paisa, OLD.note, OLD.proposed_by, OLD.proposed_at)
     OR (OLD.status <> 'proposed' AND (NEW.status, NEW.decided_by, NEW.decision_reason, NEW.decided_at, NEW.cap_units)
         IS DISTINCT FROM (OLD.status, OLD.decided_by, OLD.decision_reason, OLD.decided_at, OLD.cap_units))
     OR (OLD.outcome_status = 'approved' AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD))
     OR (OLD.outcome_status = 'proposed' AND NOT (
           (NEW.outcome_status = 'approved' AND NEW.outcome_by IS NOT DISTINCT FROM OLD.outcome_by AND NEW.outcome_at IS NOT DISTINCT FROM OLD.outcome_at)
           OR (NEW.outcome_status = 'none' AND NEW.outcome_by IS NULL AND NEW.outcome_at IS NULL)))
     OR (OLD.outcome_status = 'none' AND NEW.outcome_status = 'approved')
     OR (OLD.outcome_status IN ('none', 'proposed') AND (NEW.outcome_decided_by, NEW.outcome_decided_at, NEW.outcome_reason)
         IS DISTINCT FROM (OLD.outcome_decided_by, OLD.outcome_decided_at, OLD.outcome_reason) AND NEW.outcome_status <> 'approved') THEN
    RAISE EXCEPTION 'redemption window % changes only along its decisions', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- ================================================================== views for reconciliation (ADR 0007 amendment) and readers
CREATE VIEW exit.recon_lines AS
SELECT c.token, c.id AS case_id, c.state AS case_state, c.redeeming_at, r.id AS redemption_id, r.status AS redemption_status, r.burn_rule,
       f.record_block, coalesce(f.onchain_id, k.onchain_id) AS distribution_id, l.wallet, l.subject_id, l.units, l.ref_id, l.net,
       exit.line_payment(r.id, l.wallet) AS payment,
       EXISTS (SELECT 1 FROM exit.releases x WHERE x.redemption_id = r.id AND x.wallet = l.wallet) AS released,
       EXISTS (SELECT 1 FROM exit.burns b WHERE b.ref_id = l.ref_id) AS enqueued
FROM exit.redemption_lines l
JOIN exit.redemptions r ON r.id = l.redemption_id
JOIN exit.cases c ON c.id = r.case_id
JOIN exit.finals f ON f.id = r.final_id
LEFT JOIN exit.final_links k ON k.final_id = f.id;

CREATE VIEW exit.recon_cases AS
SELECT c.id AS case_id, c.token, c.state, c.redeeming_at, c.closed_at,
       (SELECT f.id FROM exit.finals f WHERE f.case_id = c.id AND f.status = 'booked') AS final_id,
       exit.balance(exit.pool(c.token)) AS pool_balance,
       exit.balance(exit.closure_reserve(c.token)) AS closure_reserve_balance,
       (SELECT coalesce(sum(e.units), 0) FROM trustee.register_entries e WHERE e.token = c.token) AS register_units
FROM exit.cases c;

CREATE VIEW exit.recon_finals AS
SELECT f.id, f.case_id, f.token, f.status, f.onchain_id, f.statement, f.statement_hash, f.tax_schedule, f.tax_schedule_hash, f.merkle_root
FROM exit.finals f WHERE f.statement IS NOT NULL;

-- ================================================================== append-only and officer bindings (EX-DB-8)
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['audit', 'transitions', 'decision_kinds', 'case_events', 'votes', 'conflicts', 'final_lines', 'final_prechecks', 'final_links',
                           'redemption_lines', 'releases', 'burns', 'burns_seen'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON exit.%I FOR EACH ROW EXECUTE FUNCTION exit.forbid_change()', t || '_append_only', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['audit', 'transitions', 'decision_kinds', 'cases', 'case_events', 'decisions', 'votes', 'conflicts', 'proceeds', 'waterfalls',
                           'waterfall_lines', 'payments', 'finals', 'final_lines', 'final_prechecks', 'final_links', 'redemptions', 'redemption_lines',
                           'releases', 'burns', 'burns_seen', 'windows', 'requests', 'settings'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON exit.%I FOR EACH STATEMENT EXECUTE FUNCTION exit.forbid_change()', t || '_no_truncate', t);
  END LOOP;
END $$;

-- Officer handles only inside PT Control (as 0016 A-3 / 0019 C-7).
CREATE TRIGGER cases_officer_binding BEFORE INSERT ON exit.cases FOR EACH ROW EXECUTE FUNCTION compliance.bind_actor('opened_by');
CREATE TRIGGER decisions_officer_binding BEFORE INSERT ON exit.decisions FOR EACH ROW EXECUTE FUNCTION compliance.bind_actor('proposed_by');
CREATE TRIGGER votes_officer_binding BEFORE INSERT ON exit.votes FOR EACH ROW EXECUTE FUNCTION compliance.bind_actor('officer');
CREATE TRIGGER conflicts_officer_binding BEFORE INSERT ON exit.conflicts FOR EACH ROW EXECUTE FUNCTION compliance.bind_actor('officer');
CREATE TRIGGER proceeds_officer_binding BEFORE INSERT OR UPDATE ON exit.proceeds FOR EACH ROW EXECUTE FUNCTION compliance.bind_actor('proposed_by', 'decided_by');
CREATE TRIGGER waterfalls_officer_binding BEFORE INSERT OR UPDATE ON exit.waterfalls
  FOR EACH ROW EXECUTE FUNCTION compliance.bind_actor('created_by', 'submitted_by', 'checked_by', 'approved_by', 'returned_by');
CREATE TRIGGER waterfall_lines_officer_binding BEFORE INSERT ON exit.waterfall_lines FOR EACH ROW EXECUTE FUNCTION compliance.bind_actor('added_by');
CREATE TRIGGER payments_officer_binding BEFORE INSERT OR UPDATE ON exit.payments FOR EACH ROW EXECUTE FUNCTION compliance.bind_actor('proposed_by', 'decided_by');
CREATE TRIGGER finals_officer_binding BEFORE INSERT OR UPDATE ON exit.finals
  FOR EACH ROW EXECUTE FUNCTION compliance.bind_actor('calculated_by', 'attached_by', 'decided_by');
CREATE TRIGGER final_prechecks_officer_binding BEFORE INSERT ON exit.final_prechecks FOR EACH ROW EXECUTE FUNCTION compliance.bind_actor('officer');
CREATE TRIGGER redemptions_officer_binding BEFORE INSERT OR UPDATE ON exit.redemptions
  FOR EACH ROW EXECUTE FUNCTION compliance.bind_actor('created_by', 'checked_by', 'decided_by');
CREATE TRIGGER windows_officer_binding BEFORE INSERT OR UPDATE ON exit.windows
  FOR EACH ROW EXECUTE FUNCTION compliance.bind_actor('proposed_by', 'decided_by', 'outcome_by', 'outcome_decided_by');

-- ================================================================== verification (EX-DB-8)
CREATE FUNCTION exit.verify_audit() RETURNS TABLE (audit_id bigint, problem text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, exit AS $$
DECLARE
  a exit.audit;
  v_prev bytea := decode(repeat('00', 32), 'hex');
  r record;
BEGIN
  FOR a IN SELECT * FROM exit.audit ORDER BY id LOOP
    IF a.prev_hash <> v_prev THEN audit_id := a.id; problem := 'prev_hash does not match'; RETURN NEXT; END IF;
    IF a.hash <> exit.audit_digest(a.prev_hash, a.id, a.at, a.actor, a.action, a.detail) THEN
      audit_id := a.id; problem := 'content does not match its hash'; RETURN NEXT;
    END IF;
    v_prev := a.hash;
  END LOOP;
  -- Rows without the audit entry their API function always writes: written around the API.
  FOR r IN
    SELECT format('case %s', c.id) AS what FROM exit.cases c WHERE NOT EXISTS (
      SELECT 1 FROM exit.audit x WHERE x.action = 'case.opened' AND (x.detail->>'case')::bigint = c.id AND x.detail->>'token' = c.token)
    UNION ALL
    SELECT format('case event %s', e.id) FROM exit.case_events e WHERE NOT EXISTS (
      SELECT 1 FROM exit.audit x WHERE x.action = 'case.moved' AND (x.detail->>'event')::bigint = e.id AND x.detail->>'code' = e.code)
    UNION ALL
    SELECT format('decision %s', d.id) FROM exit.decisions d WHERE NOT EXISTS (
      SELECT 1 FROM exit.audit x WHERE x.action = 'decision.proposed' AND (x.detail->>'decision')::bigint = d.id AND x.detail->>'code' = d.code)
    UNION ALL
    SELECT format('vote on decision %s by %s', v.decision_id, v.officer) FROM exit.votes v WHERE NOT EXISTS (
      SELECT 1 FROM exit.audit x WHERE x.action = 'decision.voted' AND (x.detail->>'decision')::bigint = v.decision_id AND x.actor = v.officer
        AND x.detail->>'vote' = v.vote AND x.detail->>'capacity' = v.capacity)
    UNION ALL
    SELECT format('proceeds %s', p.id) FROM exit.proceeds p WHERE NOT EXISTS (
      SELECT 1 FROM exit.audit x WHERE x.action = 'proceeds.proposed' AND (x.detail->>'proceeds')::bigint = p.id AND x.detail->>'amount' = p.amount_paisa::text)
      OR (p.status <> 'proposed' AND NOT EXISTS (
      SELECT 1 FROM exit.audit x WHERE x.action = 'proceeds.decided' AND (x.detail->>'proceeds')::bigint = p.id AND x.actor = p.decided_by))
    UNION ALL
    SELECT format('waterfall line %s', l.id) FROM exit.waterfall_lines l WHERE NOT EXISTS (
      SELECT 1 FROM exit.audit x WHERE x.action = 'waterfall.line_added' AND (x.detail->>'line')::bigint = l.id AND x.detail->>'amount' = l.amount_paisa::text)
    UNION ALL
    SELECT format('waterfall %s: %s without its audit entry', w.id, w.status) FROM exit.waterfalls w WHERE w.status = 'approved' AND NOT EXISTS (
      SELECT 1 FROM exit.audit x WHERE x.action = 'waterfall.decided' AND (x.detail->>'waterfall')::bigint = w.id AND x.actor = w.approved_by)
    UNION ALL
    SELECT format('payment %s', p.id) FROM exit.payments p WHERE NOT EXISTS (
      SELECT 1 FROM exit.audit x WHERE x.action = 'payment.proposed' AND (x.detail->>'payment')::bigint = p.id)
      OR (p.status <> 'proposed' AND NOT EXISTS (
      SELECT 1 FROM exit.audit x WHERE x.action = 'payment.decided' AND (x.detail->>'payment')::bigint = p.id AND x.actor = p.decided_by))
    UNION ALL
    SELECT format('final %s', f.id) FROM exit.finals f WHERE NOT EXISTS (
      SELECT 1 FROM exit.audit x WHERE x.action = 'final.calculated' AND (x.detail->>'final')::bigint = f.id AND x.detail->>'net' = f.sum_net::text)
      OR (f.status = 'booked' AND NOT EXISTS (SELECT 1 FROM exit.audit x WHERE x.action = 'final.booked' AND (x.detail->>'final')::bigint = f.id))
    UNION ALL
    SELECT format('redemption %s', r2.id) FROM exit.redemptions r2 WHERE NOT EXISTS (
      SELECT 1 FROM exit.audit x WHERE x.action = 'redemption.created' AND (x.detail->>'redemption')::bigint = r2.id
        AND x.detail->>'itemsDigest' = encode(r2.items_digest, 'hex'))
      OR (r2.status = 'approved' AND NOT EXISTS (
      SELECT 1 FROM exit.audit x WHERE x.action = 'redemption.decided' AND (x.detail->>'redemption')::bigint = r2.id AND x.actor = r2.decided_by))
    UNION ALL
    SELECT format('burn command %s', b.command_key) FROM exit.burns b WHERE NOT EXISTS (
      SELECT 1 FROM exit.audit x WHERE x.action = 'burn.enqueued' AND x.detail->>'refId' = b.ref_id)
    UNION ALL
    SELECT format('window %s', w.id) FROM exit.windows w WHERE NOT EXISTS (
      SELECT 1 FROM exit.audit x WHERE x.action = 'window.proposed' AND (x.detail->>'window')::bigint = w.id)
    UNION ALL
    SELECT format('request %s', q.id) FROM exit.requests q WHERE NOT EXISTS (
      SELECT 1 FROM exit.audit x WHERE x.action = 'request.submitted' AND x.detail->>'request' = q.id::text AND x.detail->>'units' = q.units::text)
  LOOP
    audit_id := NULL; problem := r.what || ' has no matching audit entry'; RETURN NEXT;
  END LOOP;
END $$;

-- ================================================================== signer: burns are Issuance Safe actions with a trustee signer (0023 T-1)
INSERT INTO signer.trustee_cosign_kinds (kind, note) VALUES
  ('issuance.burn', 'S-05 X16: redemption burns are Issuance Safe actions; when the burn policy asks for approvals, a trustee officer co-signs in addition');

-- ================================================================== website: step-up actions (T-030 IP-6)
INSERT INTO webauth.step_up_actions (action, min_amount_paisa, note) VALUES
  ('exit.redemption_request', 0, 'S-05 EX-40: lodging a redemption request (always)'),
  ('exit.redemption_withdraw', 0, 'S-05 EX-44: withdrawing a redemption request (always)');

-- ================================================================== portal (admin.*): permissions
INSERT INTO admin.role_permissions (role, permission) VALUES
  ('ops_maker', 'exit.read'), ('ops_checker', 'exit.read'), ('compliance_officer', 'exit.read'), ('legal_officer', 'exit.read'),
  ('trustee_officer', 'exit.read'), ('auditor', 'exit.read'),
  ('ops_maker', 'exit.request'),
  ('ops_checker', 'exit.decide'), ('compliance_officer', 'exit.decide'), ('legal_officer', 'exit.decide'), ('trustee_officer', 'exit.decide');

DO $$
BEGIN
  EXECUTE format('CREATE OR REPLACE FUNCTION admin.expected_role_matrix_digest() RETURNS text LANGUAGE sql IMMUTABLE AS %L',
                 format('SELECT %L::text', admin.role_matrix_digest()));
END $$;

-- ------------------------------------------------------------------ reads (exit.read)
CREATE FUNCTION admin.exit_decision_json(p_decision bigint, p_handle text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
  SELECT jsonb_build_object('id', d.id, 'code', d.code, 'label', k.label, 'detail', d.detail, 'reason', d.reason, 'proposedBy', d.proposed_by,
    'proposedAt', admin.utc(d.proposed_at), 'status', d.status, 'closedAt', admin.utc(d.closed_at), 'capacities', to_jsonb(k.capacities),
    'votes', coalesce((SELECT jsonb_agg(jsonb_build_object('capacity', v.capacity, 'officer', v.officer, 'vote', v.vote, 'reason', v.reason, 'at', admin.utc(v.at))
                                 ORDER BY v.at) FROM exit.votes v WHERE v.decision_id = d.id), '[]'::jsonb),
    'myCapacities', to_jsonb(ARRAY(SELECT cap FROM unnest(k.capacities) cap WHERE admin.officer_holds(p_handle, ARRAY[cap], true)
                                     AND NOT EXISTS (SELECT 1 FROM exit.votes v WHERE v.decision_id = d.id AND v.capacity = cap))),
    'problem', CASE WHEN d.status = 'open' THEN exit.decision_problem(d.case_id, d.code, d.detail) END,
    'digest', encode(exit.decision_digest(d.id), 'hex'))
  FROM exit.decisions d JOIN exit.decision_kinds k ON k.code = d.code WHERE d.id = p_decision
$$;

CREATE FUNCTION admin.exit_overview(p_session bytea) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'exit.read');
BEGIN
  RETURN jsonb_build_object(
    'cases', coalesce((SELECT jsonb_agg(jsonb_build_object('id', c.id, 'token', c.token, 'state', c.state, 'openedBy', c.opened_by,
        'openedAt', admin.utc(c.opened_at), 'updatedAt', admin.utc(c.updated_at), 'offerPaisa', c.offer_price_paisa::text,
        'salePricePaisa', c.sale_price_paisa::text, 'recordDate', c.record_date,
        'openDecision', (SELECT jsonb_build_object('id', d.id, 'code', d.code, 'votes', (SELECT count(*) FROM exit.votes v WHERE v.decision_id = d.id),
                                                   'needed', (SELECT cardinality(k.capacities) FROM exit.decision_kinds k WHERE k.code = d.code))
                         FROM exit.decisions d WHERE d.case_id = c.id AND d.status = 'open')) ORDER BY c.id DESC)
      FROM exit.cases c), '[]'::jsonb),
    'windows', coalesce((SELECT jsonb_agg(jsonb_build_object('id', w.id, 'token', w.token, 'status', w.status, 'opensAt', admin.utc(w.opens_at),
        'closesAt', admin.utc(w.closes_at), 'pricePerUnitPaisa', w.price_per_unit_paisa::text, 'capUnits', w.cap_units::text, 'outcome', w.outcome_status,
        'open', w.status = 'approved' AND clock_timestamp() >= w.opens_at AND clock_timestamp() < w.closes_at,
        'requested', (SELECT coalesce(sum(r.units), 0)::text FROM exit.requests r WHERE r.window_id = w.id AND r.status IN ('submitted', 'recorded')),
        'requests', (SELECT count(*) FROM exit.requests r WHERE r.window_id = w.id)) ORDER BY w.id DESC)
      FROM (SELECT * FROM exit.windows ORDER BY id DESC LIMIT 200) w), '[]'::jsonb),
    'tokens', coalesce((SELECT jsonb_agg(jsonb_build_object('token', t.token, 'supply', t.total_supply::text, 'cap', t.trustee_cap::text, 'paused', t.paused,
        'exitUnderway', exit.exit_underway(t.token)) ORDER BY t.token) FROM chain.tokens t), '[]'::jsonb),
    'burnPolicy', EXISTS (SELECT 1 FROM signer.policies p WHERE p.kind = 'issuance.burn' AND p.approved_at IS NOT NULL AND p.retired_at IS NULL),
    'settings', (SELECT jsonb_object_agg(s.key, s.value) FROM exit.settings s));
END $$;

CREATE FUNCTION admin.exit_case(p_session bytea, p_id bigint) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'exit.read');
  v_handle text := admin.handle_of(v_me);
  c exit.cases;
  w exit.waterfalls;
  f exit.finals;
  r exit.redemptions;
  v_in bigint;
  v_out bigint;
BEGIN
  SELECT * INTO c FROM exit.cases WHERE id = p_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  w := exit.live_waterfall(c.id);
  IF w.id IS NULL THEN SELECT * INTO w FROM exit.waterfalls WHERE case_id = c.id ORDER BY id DESC LIMIT 1; END IF;
  SELECT * INTO f FROM exit.finals WHERE case_id = c.id ORDER BY id DESC LIMIT 1;
  SELECT * INTO r FROM exit.redemptions WHERE case_id = c.id ORDER BY id DESC LIMIT 1;
  IF w.id IS NOT NULL THEN SELECT x.inflows, x.outflows INTO v_in, v_out FROM exit.waterfall_totals(w.id) x; END IF;
  RETURN jsonb_build_object(
    'id', c.id, 'token', c.token, 'property', c.property_id, 'state', c.state, 'rationale', c.rationale,
    'offerPaisa', c.offer_price_paisa::text, 'valuationA', c.valuation_a_paisa::text, 'valuationASha', encode(c.valuation_a_sha, 'hex'),
    'valuationB', c.valuation_b_paisa::text, 'valuationBSha', encode(c.valuation_b_sha, 'hex'), 'priceFloor', exit.price_floor(c)::text,
    'costsPaisa', c.costs_paisa::text, 'voteRequired', c.vote_required, 'openedBy', c.opened_by, 'openedAt', admin.utc(c.opened_at),
    'updatedAt', admin.utc(c.updated_at),
    'facts', jsonb_strip_nulls(jsonb_build_object('icMinutesSha', encode(c.ic_minutes_sha, 'hex'), 'voteNoticeSha', encode(c.vote_notice_sha, 'hex'),
      'voteRecordBlock', c.vote_record_block, 'voteOpenedAt', admin.utc(c.vote_opened_at), 'eligibleUnits', c.eligible_units::text,
      'votesFor', c.votes_for::text, 'votesAgainst', c.votes_against::text, 'votesAbstain', c.votes_abstain::text, 'ballotsSha', encode(c.ballots_sha, 'hex'),
      'lowerPriceApproved', c.lower_price_approved, 'legalAdviceSha', encode(c.legal_advice_sha, 'hex'), 'buyerRef', c.buyer_ref,
      'buyerChecksSha', encode(c.buyer_checks_sha, 'hex'), 'agreementSha', encode(c.agreement_sha, 'hex'), 'salePricePaisa', c.sale_price_paisa::text,
      'depositPaisa', c.deposit_paisa::text, 'cpDeadline', c.cp_deadline, 'deedSha', encode(c.deed_sha, 'hex'), 'depositTreatment', c.deposit_treatment,
      'recordDate', c.record_date, 'recordAnnouncedAt', admin.utc(c.record_announced_at), 'recordNoticeSha', encode(c.record_notice_sha, 'hex'),
      'redeemingAt', admin.utc(c.redeeming_at), 'finalAccountsSha', encode(c.final_accounts_sha, 'hex'), 'windupSha', encode(c.windup_sha, 'hex'),
      'closedAt', admin.utc(c.closed_at))),
    'events', coalesce((SELECT jsonb_agg(jsonb_build_object('code', e.code, 'from', e.from_state, 'to', e.to_state, 'actor', e.actor, 'decision', e.decision_id,
        'at', admin.utc(e.at)) ORDER BY e.id) FROM exit.case_events e WHERE e.case_id = c.id), '[]'::jsonb),
    'decisions', coalesce((SELECT jsonb_agg(admin.exit_decision_json(d.id, v_handle) ORDER BY d.id DESC) FROM exit.decisions d WHERE d.case_id = c.id), '[]'::jsonb),
    'possibleDecisions', coalesce((SELECT jsonb_agg(jsonb_build_object('code', k.code, 'label', k.label, 'capacities', to_jsonb(k.capacities)) ORDER BY k.code)
      FROM exit.decision_kinds k WHERE c.state = ANY (k.from_states)), '[]'::jsonb),
    'conflicts', coalesce((SELECT jsonb_agg(jsonb_build_object('officer', x.officer, 'note', x.note, 'at', admin.utc(x.declared_at)) ORDER BY x.declared_at)
      FROM exit.conflicts x WHERE x.case_id = c.id), '[]'::jsonb),
    'proceeds', coalesce((SELECT jsonb_agg(jsonb_build_object('id', p.id, 'kind', p.kind, 'seq', p.seq, 'reference', p.bank_reference, 'valueDate', p.value_date,
        'amount', p.amount_paisa::text, 'source', p.source, 'status', p.status, 'proposedBy', p.proposed_by, 'decidedBy', p.decided_by, 'journal', p.journal_id,
        'note', p.note, 'digest', encode(exit.proceeds_digest(p.id), 'hex')) ORDER BY p.id) FROM exit.proceeds p WHERE p.case_id = c.id), '[]'::jsonb),
    'proceedsApproved', (SELECT approved::text FROM exit.proceeds_of(c.id)),
    'pool', exit.balance(exit.pool(c.token))::text,
    'closureReserve', exit.balance(exit.closure_reserve(c.token))::text,
    'waterfall', CASE WHEN w.id IS NOT NULL THEN jsonb_build_object('id', w.id, 'version', w.version, 'status', w.status, 'createdBy', w.created_by,
        'submittedBy', w.submitted_by, 'checkedBy', w.checked_by, 'approvedBy', w.approved_by, 'returnedBy', w.returned_by, 'returnReason', w.return_reason,
        'inflows', v_in::text, 'outflows', v_out::text, 'problem', CASE WHEN w.status IN ('draft', 'submitted', 'checked') THEN exit.waterfall_problem(w.id) END,
        'digest', encode(exit.waterfall_digest(w.id), 'hex'),
        'lines', coalesce((SELECT jsonb_agg(jsonb_build_object('id', l.id, 'kind', l.kind, 'rank', exit.line_rank(l.kind), 'payee', l.payee,
            'description', l.description, 'amount', l.amount_paisa::text, 'evidence', encode(l.evidence_sha, 'hex'), 'addedBy', l.added_by,
            'withdrawn', l.withdrawn_at IS NOT NULL, 'journal', l.journal_id, 'paid', exit.paid_on_line(l.id)::text,
            'payments', coalesce((SELECT jsonb_agg(jsonb_build_object('id', p.id, 'reference', p.bank_reference, 'amount', p.amount_paisa::text, 'status', p.status,
                'proposedBy', p.proposed_by, 'decidedBy', p.decided_by, 'digest', encode(exit.payment_digest(p.id), 'hex')) ORDER BY p.id)
              FROM exit.payments p WHERE p.line_id = l.id), '[]'::jsonb)) ORDER BY exit.line_rank(l.kind), l.id)
          FROM exit.waterfall_lines l WHERE l.waterfall_id = w.id), '[]'::jsonb)) END,
    'final', CASE WHEN f.id IS NOT NULL THEN jsonb_build_object('id', f.id, 'status', f.status, 'recordDate', f.record_date, 'recordBlock', f.record_block,
        'incomeType', f.income_type, 'proceeds', f.proceeds::text, 'inflows', f.inflows::text, 'outflows', f.outflows::text,
        'distributableGross', f.distributable_gross::text, 'wht', f.sum_wht::text, 'net', f.sum_net::text, 'holders', f.holders, 'units', f.total_units::text,
        'flagged', f.flagged_lines, 'placeholder', f.placeholder_lines, 'root', f.merkle_root, 'statementHash', f.statement_hash,
        'calculatedBy', f.calculated_by, 'attachedBy', f.attached_by, 'decidedBy', f.decided_by, 'returnedReason', f.returned_reason,
        'precheck', (SELECT jsonb_build_object('decision', p.decision, 'root', p.recomputed_root, 'officer', p.officer, 'reason', p.reason, 'at', admin.utc(p.at))
                     FROM exit.final_prechecks p WHERE p.final_id = f.id),
        'onchain', (SELECT jsonb_build_object('registry', k.registry, 'id', k.onchain_id::text,
                      'status', (SELECT d.status FROM chain.distributions d WHERE d.registry = k.registry AND d.id = k.onchain_id))
                    FROM exit.final_links k WHERE k.final_id = f.id),
        'digest', encode(exit.final_digest(f.id), 'hex')) END,
    'redemption', CASE WHEN r.id IS NOT NULL THEN jsonb_build_object('id', r.id, 'status', r.status, 'burnRule', r.burn_rule, 'lines', r.lines,
        'units', r.total_units::text, 'createdBy', r.created_by, 'checkedBy', r.checked_by, 'decidedBy', r.decided_by,
        'itemsDigest', encode(r.items_digest, 'hex'), 'digest', encode(exit.redemption_digest(r.id), 'hex'),
        'items', coalesce((SELECT jsonb_agg(jsonb_build_object('wallet', l.wallet, 'units', l.units::text, 'refId', l.ref_id, 'net', l.net::text,
            'payment', exit.line_payment(r.id, l.wallet), 'released', EXISTS (SELECT 1 FROM exit.releases x WHERE x.redemption_id = r.id AND x.wallet = l.wallet),
            'command', admin.command_json('burn:' || l.ref_id),
            'burned', (SELECT jsonb_build_object('block', s.block_number, 'tx', s.tx_hash, 'registerUnits', s.register_units) FROM exit.burns_seen s WHERE s.ref_id = l.ref_id),
            'problem', CASE WHEN r.status = 'approved' THEN exit.line_burn_problem(r.id, l.wallet) END) ORDER BY l.wallet)
          FROM (SELECT * FROM exit.redemption_lines x WHERE x.redemption_id = r.id ORDER BY x.wallet LIMIT 2000) l), '[]'::jsonb)) END,
    'chain', (SELECT jsonb_build_object('supply', t.total_supply::text, 'cap', t.trustee_cap::text, 'paused', t.paused, 'cursor', exit.cursor_of(t.token),
        'issuance', exit.contract_of(t.token, 'issuance'))
      FROM chain.tokens t WHERE t.token = c.token),
    'registerUnits', (SELECT coalesce(sum(e.units), 0)::text FROM trustee.register_entries e WHERE e.token = c.token),
    'closeProblem', CASE WHEN c.state = 'paid_out' THEN exit.close_problem(c.id) END,
    'caseDigest', encode(exit.case_digest(c.id), 'hex'),
    'me', jsonb_build_object('handle', v_handle,
      'roles', to_jsonb(ARRAY(SELECT g.role FROM admin.role_grants g WHERE g.officer_id = v_me AND g.revoked_at IS NULL ORDER BY g.role)),
      'conflicted', EXISTS (SELECT 1 FROM exit.conflicts x WHERE x.case_id = c.id AND x.officer = v_handle)));
END $$;

CREATE FUNCTION admin.exit_window(p_session bytea, p_id bigint) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'exit.read');
  w exit.windows;
BEGIN
  SELECT * INTO w FROM exit.windows WHERE id = p_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('id', w.id, 'token', w.token, 'status', w.status, 'opensAt', admin.utc(w.opens_at), 'closesAt', admin.utc(w.closes_at),
    'navPerUnitPaisa', w.nav_per_unit_paisa::text, 'navSha', encode(w.nav_evidence_sha, 'hex'), 'discountPpm', w.discount_ppm,
    'pricePerUnitPaisa', w.price_per_unit_paisa::text, 'capUnits', w.cap_units::text, 'note', w.note, 'proposedBy', w.proposed_by,
    'proposedAt', admin.utc(w.proposed_at), 'decidedBy', w.decided_by, 'decisionReason', w.decision_reason,
    'open', w.status = 'approved' AND clock_timestamp() >= w.opens_at AND clock_timestamp() < w.closes_at,
    'closed', clock_timestamp() >= w.closes_at,
    'outcome', jsonb_build_object('status', w.outcome_status, 'by', w.outcome_by, 'decidedBy', w.outcome_decided_by, 'reason', w.outcome_reason),
    'requests', coalesce((SELECT jsonb_agg(jsonb_build_object('id', r.id, 'subject', left(replace(r.subject_id::text, '-', ''), 8), 'wallet', r.wallet,
        'units', r.units::text, 'indicativePaisa', r.indicative_paisa::text, 'status', r.status, 'createdAt', admin.utc(r.created_at)) ORDER BY r.created_at)
      FROM exit.requests r WHERE r.window_id = w.id), '[]'::jsonb),
    'digest', encode(exit.window_digest(w.id), 'hex'));
END $$;

-- ------------------------------------------------------------------ writes
/**
 * Operations maker actions (exit.request), each with a fresh security-key step-up, under the
 * officer's handle (bound): open, propose, proceeds, line, withdraw_line, submit_waterfall, payment,
 * announce, window, outcome. Backend refusals are returned (audited), not raised.
 */
CREATE FUNCTION admin.exit_request(p_session bytea, p_case bigint, p_action text, p_args jsonb, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'exit.request');
  v_handle text := admin.handle_of(v_me);
  a jsonb := coalesce(p_args, '{}'::jsonb);
  v_id bigint;
  v_status text;
BEGIN
  PERFORM admin.require_step_up(p_session);
  BEGIN
    PERFORM admin.bind_officer(v_handle);
    CASE p_action
      WHEN 'open' THEN
        v_id := exit.open_case(a->>'token', p_reason, (a->>'offerPaisa')::bigint, (a->>'valuationAPaisa')::bigint, a->>'valuationASha',
                               (a->>'valuationBPaisa')::bigint, a->>'valuationBSha', (a->>'costsPaisa')::bigint, (a->>'voteRequired')::boolean, v_handle);
        v_status := 'proposed';
      WHEN 'propose' THEN
        v_id := exit.propose(p_case, a->>'code', a->'detail', p_reason, v_handle);
        v_status := 'open';
      WHEN 'proceeds' THEN
        v_id := exit.propose_proceeds(p_case, a->>'kind', (a->>'statementId')::bigint, (a->>'lineNo')::integer, p_reason, v_handle);
        v_status := 'proposed';
      WHEN 'line' THEN
        v_id := exit.add_line(p_case, a->>'kind', nullif(a->>'payee', ''), p_reason, (a->>'amountPaisa')::bigint, a->>'evidenceSha', v_handle);
        v_status := 'draft';
      WHEN 'withdraw_line' THEN
        PERFORM exit.withdraw_line((a->>'lineId')::bigint, v_handle);
        v_id := (a->>'lineId')::bigint;
        v_status := 'withdrawn';
      WHEN 'submit_waterfall' THEN
        v_id := exit.submit_waterfall(p_case, v_handle);
        v_status := 'submitted';
      WHEN 'payment' THEN
        v_id := exit.propose_payment((a->>'lineId')::bigint, (a->>'statementId')::bigint, (a->>'lineNo')::integer, p_reason, v_handle);
        v_status := 'proposed';
      WHEN 'announce' THEN
        PERFORM exit.announce_record_date(p_case, (a->>'recordDate')::date, a->>'noticeSha', v_handle);
        v_id := p_case;
        v_status := 'announced';
      WHEN 'window' THEN
        v_id := exit.propose_window(a->>'token', (a->>'opensAt')::timestamptz, (a->>'closesAt')::timestamptz, (a->>'navPerUnitPaisa')::bigint,
                                    a->>'navSha', coalesce((a->>'discountPpm')::integer, 0), p_reason, v_handle);
        v_status := 'proposed';
      WHEN 'outcome' THEN
        v_status := exit.propose_outcome((a->>'windowId')::bigint, v_handle);
        v_id := (a->>'windowId')::bigint;
      ELSE
        PERFORM exit.fail('22023', 'unknown action');
    END CASE;
    PERFORM admin.unbind_officer(v_handle);
  EXCEPTION WHEN SQLSTATE '23514' OR SQLSTATE '23505' OR SQLSTATE '42501' OR SQLSTATE '22023' OR SQLSTATE 'P0002' OR SQLSTATE '23503'
                 OR SQLSTATE '22P02' OR SQLSTATE '22007' OR SQLSTATE '22008' OR SQLSTATE '22003' THEN
    RETURN admin.refuse(v_me, 'exit', coalesce(p_case::text, '-'), coalesce(p_action, '?'), SQLERRM) || jsonb_build_object('state', SQLSTATE);
  END;
  PERFORM admin.audit_append(v_me::text, 'exit.requested', jsonb_build_object('case', p_case, 'action', p_action, 'ref', v_id, 'status', v_status));
  RETURN jsonb_build_object('ok', true, 'id', v_id, 'status', v_status);
END $$;

/**
 * Decisions (exit.decide), each with a fresh step-up and the digest of what was shown:
 *   vote (decision, by capacity), conflict (case), proceeds, payment, final, window, outcome
 *   (operations checker), waterfall and redemption (operations checker checks, then a trustee
 *   officer approves), precheck (trustee officer; p_args.root).
 */
CREATE FUNCTION admin.exit_decide(p_session bytea, p_kind text, p_ref bigint, p_decision text, p_reason text, p_digest bytea, p_args jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'exit.decide');
  v_handle text := admin.handle_of(v_me);
  v_checker boolean;
  v_trustee boolean;
  v_status text;
  v_wstatus text;
BEGIN
  PERFORM admin.require_step_up(p_session);
  PERFORM admin.check_text(p_reason, 10, 500);
  v_checker := admin.officer_holds(v_handle, ARRAY['ops_checker'], true);
  v_trustee := admin.officer_holds(v_handle, ARRAY['trustee_officer'], true);
  BEGIN
    PERFORM admin.bind_officer(v_handle);
    IF p_kind IN ('proceeds', 'payment', 'final', 'window', 'outcome') AND NOT v_checker THEN
      PERFORM exit.fail('42501', 'only an operations checker decides this');
    END IF;
    IF p_kind = 'precheck' AND NOT v_trustee THEN PERFORM exit.fail('42501', 'only a trustee officer pre-checks the final distribution'); END IF;
    CASE p_kind
      WHEN 'vote' THEN
        v_status := exit.vote(p_ref, v_handle, p_decision, p_reason, p_digest);
      WHEN 'conflict' THEN
        IF p_digest IS DISTINCT FROM exit.case_digest(p_ref) THEN PERFORM exit.fail('23514', 'the case changed since you reviewed it: reload'); END IF;
        PERFORM exit.declare_conflict(p_ref, v_handle, p_reason);
        v_status := 'declared';
      WHEN 'proceeds' THEN
        IF p_digest IS DISTINCT FROM exit.proceeds_digest(p_ref) THEN PERFORM exit.fail('23514', 'the record changed since you reviewed it: reload'); END IF;
        v_status := exit.decide_proceeds(p_ref, v_handle, p_decision, p_reason);
      WHEN 'payment' THEN
        IF p_digest IS DISTINCT FROM exit.payment_digest(p_ref) THEN PERFORM exit.fail('23514', 'the record changed since you reviewed it: reload'); END IF;
        v_status := exit.decide_payment(p_ref, v_handle, p_decision, p_reason);
      WHEN 'final' THEN
        IF p_digest IS DISTINCT FROM exit.final_digest(p_ref) THEN PERFORM exit.fail('23514', 'the final distribution changed since you reviewed it: reload'); END IF;
        v_status := exit.decide_final(p_ref, v_handle, p_decision, p_reason);
      WHEN 'precheck' THEN
        v_status := exit.precheck_final(p_ref, v_handle, p_decision, p_reason, p_digest, p_args->>'root');
      WHEN 'window' THEN
        IF p_digest IS DISTINCT FROM exit.window_digest(p_ref) THEN PERFORM exit.fail('23514', 'the window changed since you reviewed it: reload'); END IF;
        v_status := exit.decide_window(p_ref, v_handle, p_decision, p_reason);
      WHEN 'outcome' THEN
        IF p_digest IS DISTINCT FROM exit.window_digest(p_ref) THEN PERFORM exit.fail('23514', 'the window changed since you reviewed it: reload'); END IF;
        v_status := exit.decide_outcome(p_ref, v_handle, p_decision, p_reason);
      WHEN 'waterfall' THEN
        IF p_digest IS DISTINCT FROM exit.waterfall_digest(p_ref) THEN PERFORM exit.fail('23514', 'the waterfall changed since you reviewed it: reload'); END IF;
        SELECT status INTO v_wstatus FROM exit.waterfalls WHERE id = p_ref;
        IF v_wstatus = 'submitted' THEN
          IF NOT v_checker THEN PERFORM exit.fail('42501', 'an operations checker checks the waterfall first'); END IF;
          v_status := exit.check_waterfall(p_ref, v_handle, p_decision, p_reason);
        ELSIF v_wstatus = 'checked' THEN
          IF NOT v_trustee THEN PERFORM exit.fail('42501', 'a trustee officer approves the checked waterfall'); END IF;
          v_status := exit.approve_waterfall(p_ref, v_handle, p_decision, p_reason);
        ELSE
          PERFORM exit.fail('23514', format('the waterfall is %s', coalesce(v_wstatus, 'unknown')));
        END IF;
      WHEN 'redemption' THEN
        SELECT status INTO v_wstatus FROM exit.redemptions WHERE id = p_ref;
        IF v_wstatus = 'created' THEN
          IF NOT v_checker THEN PERFORM exit.fail('42501', 'an operations checker checks the redemption batch first'); END IF;
          IF p_digest IS DISTINCT FROM exit.redemption_digest(p_ref) THEN PERFORM exit.fail('23514', 'the batch changed since you reviewed it: reload'); END IF;
          v_status := exit.check_redemption(p_ref, v_handle, p_decision, p_reason);
        ELSIF v_wstatus = 'checked' THEN
          IF NOT v_trustee THEN PERFORM exit.fail('42501', 'a trustee officer approves the checked redemption batch'); END IF;
          v_status := exit.approve_redemption(p_ref, v_handle, p_decision, p_reason, p_digest);
        ELSE
          PERFORM exit.fail('23514', format('the redemption batch is %s', coalesce(v_wstatus, 'unknown')));
        END IF;
      ELSE
        PERFORM exit.fail('22023', 'unknown decision kind');
    END CASE;
    PERFORM admin.unbind_officer(v_handle);
  EXCEPTION WHEN SQLSTATE '23514' OR SQLSTATE '23505' OR SQLSTATE '42501' OR SQLSTATE '22023' OR SQLSTATE 'P0002' OR SQLSTATE '23503' THEN
    RETURN admin.refuse(v_me, 'exit.' || coalesce(p_kind, '?'), coalesce(p_ref::text, '-'), coalesce(p_decision, '?'), SQLERRM) || jsonb_build_object('state', SQLSTATE);
  END;
  PERFORM admin.audit_append(v_me::text, 'exit.decided', jsonb_build_object('kind', p_kind, 'ref', p_ref, 'decision', p_decision, 'result', v_status,
    'digest', encode(p_digest, 'hex')));
  RETURN jsonb_build_object('ok', true, 'status', v_status);
END $$;

/** "Refresh from chain": the tick (idempotent, deterministic from the read model, the bank and the outbox). */
CREATE FUNCTION admin.exit_sync(p_session bytea) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'exit.request');
  v_n integer;
BEGIN
  v_n := exit.tick('portal:' || left(admin.handle_of(v_me), 90));
  PERFORM admin.audit_append(v_me::text, 'exit.synced', jsonb_build_object('changes', v_n));
  RETURN jsonb_build_object('ok', true, 'status', format('%s change(s)', v_n), 'id', v_n);
END $$;

-- ------------------------------------------------------------------ the exit audit chain in the audit viewer (exit.read)
CREATE OR REPLACE FUNCTION admin.audit_rows(p_session bytea, p_source text, p_from timestamptz, p_to timestamptz, p_actor text, p_action text,
                                            p_before bigint, p_limit integer)
RETURNS TABLE (id bigint, at timestamptz, actor text, action text, ref text, detail jsonb, prev_hash text, hash text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
#variable_conflict use_column
DECLARE
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 50000);
BEGIN
  IF p_source = 'admin' THEN
    PERFORM admin.require(p_session, 'audit.read.admin');
    RETURN QUERY SELECT a.id, a.at, a.actor, a.action, NULL::text, a.detail, encode(a.prev_hash, 'hex'), encode(a.hash, 'hex')
      FROM admin.audit a
      WHERE (p_from IS NULL OR a.at >= p_from) AND (p_to IS NULL OR a.at < p_to)
        AND (p_actor IS NULL OR strpos(a.actor, p_actor) > 0) AND (p_action IS NULL OR starts_with(a.action, p_action))
        AND (p_before IS NULL OR a.id < p_before)
      ORDER BY a.id DESC LIMIT v_limit;
  ELSIF p_source = 'signer' THEN
    PERFORM admin.require(p_session, 'audit.read.ops');
    RETURN QUERY SELECT a.id, a.at, a.actor, a.action, a.request_id::text, a.detail, encode(a.prev_hash, 'hex'), encode(a.hash, 'hex')
      FROM signer.audit a
      WHERE (p_from IS NULL OR a.at >= p_from) AND (p_to IS NULL OR a.at < p_to)
        AND (p_actor IS NULL OR strpos(a.actor, p_actor) > 0) AND (p_action IS NULL OR starts_with(a.action, p_action))
        AND (p_before IS NULL OR a.id < p_before)
      ORDER BY a.id DESC LIMIT v_limit;
  ELSIF p_source = 'recon' THEN
    PERFORM admin.require(p_session, 'audit.read.ops');
    RETURN QUERY SELECT a.id, a.at, a.actor, a.action, NULL::text, a.detail, encode(a.prev_hash, 'hex'), encode(a.hash, 'hex')
      FROM recon.audit a
      WHERE (p_from IS NULL OR a.at >= p_from) AND (p_to IS NULL OR a.at < p_to)
        AND (p_actor IS NULL OR strpos(a.actor, p_actor) > 0) AND (p_action IS NULL OR starts_with(a.action, p_action))
        AND (p_before IS NULL OR a.id < p_before)
      ORDER BY a.id DESC LIMIT v_limit;
  ELSIF p_source = 'ledger' THEN
    PERFORM admin.require(p_session, 'audit.read.ops');
    RETURN QUERY SELECT j.id, j.created_at, j.created_by, j.kind, j.external_ref,
        jsonb_build_object('idempotencyKey', j.idempotency_key, 'memo', j.memo), encode(j.prev_hash, 'hex'), encode(j.hash, 'hex')
      FROM ledger.journal j
      WHERE (p_from IS NULL OR j.created_at >= p_from) AND (p_to IS NULL OR j.created_at < p_to)
        AND (p_actor IS NULL OR strpos(j.created_by, p_actor) > 0) AND (p_action IS NULL OR starts_with(j.kind, p_action))
        AND (p_before IS NULL OR j.id < p_before)
      ORDER BY j.id DESC LIMIT v_limit;
  ELSIF p_source = 'compliance' THEN
    PERFORM admin.require(p_session, 'compliance.read');
    RETURN QUERY SELECT a.id, a.at, a.actor, a.action, coalesce(a.detail->>'case', a.detail->>'request', a.detail->>'rescreen'), a.detail,
        encode(a.prev_hash, 'hex'), encode(a.hash, 'hex')
      FROM compliance.audit a
      WHERE (p_from IS NULL OR a.at >= p_from) AND (p_to IS NULL OR a.at < p_to)
        AND (p_actor IS NULL OR strpos(a.actor, p_actor) > 0) AND (p_action IS NULL OR starts_with(a.action, p_action))
        AND (p_before IS NULL OR a.id < p_before)
      ORDER BY a.id DESC LIMIT v_limit;
  ELSIF p_source = 'recovery' THEN
    PERFORM admin.require(p_session, 'recovery.read');
    RETURN QUERY SELECT a.id, a.at, a.actor, a.action, a.detail->>'case', a.detail, encode(a.prev_hash, 'hex'), encode(a.hash, 'hex')
      FROM recovery.audit a
      WHERE (p_from IS NULL OR a.at >= p_from) AND (p_to IS NULL OR a.at < p_to)
        AND (p_actor IS NULL OR strpos(a.actor, p_actor) > 0) AND (p_action IS NULL OR starts_with(a.action, p_action))
        AND (p_before IS NULL OR a.id < p_before)
      ORDER BY a.id DESC LIMIT v_limit;
  ELSIF p_source = 'trustee' THEN
    PERFORM admin.require(p_session, 'trustee.read');
    RETURN QUERY SELECT a.id, a.at, a.actor, a.action,
        coalesce(a.detail->>'request', a.detail->>'review', a.detail->>'adjustment', a.detail->>'entry', a.detail->>'token'), a.detail,
        encode(a.prev_hash, 'hex'), encode(a.hash, 'hex')
      FROM trustee.audit a
      WHERE (p_from IS NULL OR a.at >= p_from) AND (p_to IS NULL OR a.at < p_to)
        AND (p_actor IS NULL OR strpos(a.actor, p_actor) > 0) AND (p_action IS NULL OR starts_with(a.action, p_action))
        AND (p_before IS NULL OR a.id < p_before)
      ORDER BY a.id DESC LIMIT v_limit;
  ELSIF p_source = 'exit' THEN
    PERFORM admin.require(p_session, 'exit.read');
    RETURN QUERY SELECT a.id, a.at, a.actor, a.action, coalesce(a.detail->>'case', a.detail->>'window'), a.detail,
        encode(a.prev_hash, 'hex'), encode(a.hash, 'hex')
      FROM exit.audit a
      WHERE (p_from IS NULL OR a.at >= p_from) AND (p_to IS NULL OR a.at < p_to)
        AND (p_actor IS NULL OR strpos(a.actor, p_actor) > 0) AND (p_action IS NULL OR starts_with(a.action, p_action))
        AND (p_before IS NULL OR a.id < p_before)
      ORDER BY a.id DESC LIMIT v_limit;
  ELSE
    RAISE EXCEPTION 'unknown audit source' USING ERRCODE = 'check_violation';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION admin.verify_chains(p_session bytea, p_source text)
RETURNS TABLE (source text, entries bigint, problems bigint, first_problem text, verified_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
#variable_conflict use_column
DECLARE
  v_ops boolean;
  v_admin boolean;
  v_comp boolean;
  v_rec boolean;
  v_trustee boolean;
  v_exit boolean;
BEGIN
  PERFORM admin.require(p_session, NULL);
  v_ops := admin.has_permission(p_session, 'audit.read.ops');
  v_admin := admin.has_permission(p_session, 'audit.read.admin');
  v_comp := admin.has_permission(p_session, 'compliance.read');
  v_rec := admin.has_permission(p_session, 'recovery.read');
  v_trustee := admin.has_permission(p_session, 'trustee.read');
  v_exit := admin.has_permission(p_session, 'exit.read');
  IF v_ops AND coalesce(p_source, 'signer') = 'signer' THEN
    RETURN QUERY SELECT 'signer'::text, (SELECT count(*) FROM signer.audit), count(*), min(v.problem), clock_timestamp() FROM signer.verify_audit() v;
  END IF;
  IF v_ops AND coalesce(p_source, 'recon') = 'recon' THEN
    RETURN QUERY SELECT 'recon'::text, (SELECT count(*) FROM recon.audit), count(*), min(v.problem), clock_timestamp() FROM recon.verify_audit() v;
  END IF;
  IF v_ops AND coalesce(p_source, 'ledger') = 'ledger' THEN
    RETURN QUERY SELECT 'ledger'::text, (SELECT count(*) FROM ledger.journal), count(*), min(v.problem), clock_timestamp() FROM ledger.verify_chain() v;
  END IF;
  IF v_admin AND coalesce(p_source, 'admin') = 'admin' THEN
    RETURN QUERY SELECT 'admin'::text, (SELECT count(*) FROM admin.audit), count(*), min(v.problem), clock_timestamp() FROM admin.verify_audit() v;
  END IF;
  IF v_comp AND coalesce(p_source, 'compliance') = 'compliance' THEN
    RETURN QUERY SELECT 'compliance'::text, (SELECT count(*) FROM compliance.audit), count(*), min(v.problem), clock_timestamp()
      FROM compliance.verify_audit() v;
  END IF;
  IF v_rec AND coalesce(p_source, 'recovery') = 'recovery' THEN
    RETURN QUERY SELECT 'recovery'::text, (SELECT count(*) FROM recovery.audit), count(*), min(v.problem), clock_timestamp()
      FROM recovery.verify_audit() v;
  END IF;
  IF v_trustee AND coalesce(p_source, 'trustee') = 'trustee' THEN
    RETURN QUERY SELECT 'trustee'::text, (SELECT count(*) FROM trustee.audit), count(*), min(v.problem), clock_timestamp()
      FROM trustee.verify_audit() v;
  END IF;
  IF v_exit AND coalesce(p_source, 'exit') = 'exit' THEN
    RETURN QUERY SELECT 'exit'::text, (SELECT count(*) FROM exit.audit), count(*), min(v.problem), clock_timestamp() FROM exit.verify_audit() v;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION admin.record_export(p_session bytea, p_source text, p_filters jsonb, p_rows integer, p_format text, p_sha256 text)
RETURNS TABLE (audit_id bigint, audit_hash text, at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
#variable_conflict use_column
DECLARE
  v_me uuid := admin.require(p_session, 'audit.export');
  v_id bigint;
BEGIN
  IF p_source NOT IN ('admin', 'signer', 'recon', 'ledger', 'compliance', 'recovery', 'trustee', 'exit') OR p_format NOT IN ('csv', 'json')
     OR p_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid export description' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM admin.require(p_session, CASE p_source WHEN 'admin' THEN 'audit.read.admin' WHEN 'compliance' THEN 'compliance.read'
                                                 WHEN 'recovery' THEN 'recovery.read' WHEN 'trustee' THEN 'trustee.read' WHEN 'exit' THEN 'exit.read'
                                                 ELSE 'audit.read.ops' END);
  v_id := admin.audit_append(v_me::text, 'audit.exported', jsonb_build_object('source', p_source, 'format', p_format, 'rows', p_rows,
                                                                             'filters', coalesce(p_filters, '{}'::jsonb), 'sha256', p_sha256));
  RETURN QUERY SELECT a.id, encode(a.hash, 'hex'), a.at FROM admin.audit a WHERE a.id = v_id;
END $$;

-- ================================================================== website (webauth.web_*): exit status and redemption requests (EX-DB-7)
/** The investor's own exit facts: holdings, exit status and final entitlement per token, windows and requests. */
CREATE FUNCTION webauth.web_exit_overview(p_session bytea) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, webauth AS $$
DECLARE
  s webauth.sessions := webauth.live_session(p_session);
  v_subject uuid;
  v_wallet text;
BEGIN
  IF s.token_hash IS NULL THEN RETURN jsonb_build_object('error', 'session'); END IF;
  s := webauth.touch(s);
  SELECT i.kyc_subject INTO v_subject FROM webdemo.investors i WHERE i.id = s.investor_id;
  SELECT w.wallet INTO v_wallet FROM kyc.wallets w WHERE w.subject_id = v_subject;
  IF v_subject IS NULL OR v_wallet IS NULL THEN
    RETURN jsonb_build_object('verified', false, 'holdings', '[]'::jsonb, 'requests', '[]'::jsonb);
  END IF;
  RETURN jsonb_build_object(
    'verified', kyc.subject_status(v_subject) = 'verified',
    'wallet', v_wallet,
    'holdings', coalesce((SELECT jsonb_agg(x.j ORDER BY x.token) FROM (
      SELECT t.token, jsonb_build_object(
        'token', t.token,
        'units', coalesce((SELECT h.balance FROM chain.holdings h WHERE h.token = t.token AND h.holder = v_wallet), 0)::text,
        'paused', t.paused,
        -- An exit is shown once it left the committee (a proposal the committee rejected stays internal).
        'exit', (SELECT jsonb_build_object('case', c.id, 'state', c.state, 'recordDate', c.record_date, 'voteOpenedAt', webauth.utc(c.vote_opened_at),
                   'salePricePaisa', CASE WHEN c.state NOT IN ('proposed', 'vote_open', 'trustee_review', 'buyer_dd') THEN c.sale_price_paisa::text END,
                   'updatedAt', webauth.utc(c.updated_at),
                   'final', (SELECT jsonb_build_object('status', f.status, 'grossPaisa', l.gross::text, 'whtPaisa', l.wht::text, 'netPaisa', l.net::text,
                               'units', l.units::text, 'distributionId', f.onchain_id::text,
                               'payment', (SELECT CASE exit.line_payment(r.id, l.wallet) WHEN 'held' THEN 'held' WHEN 'returned' THEN 'held'
                                                   ELSE exit.line_payment(r.id, l.wallet) END
                                           FROM exit.redemptions r WHERE r.final_id = f.id AND r.status = 'approved'),
                               'burned', EXISTS (SELECT 1 FROM exit.redemption_lines rl JOIN exit.burns_seen b ON b.ref_id = rl.ref_id
                                                 JOIN exit.redemptions r ON r.id = rl.redemption_id WHERE r.final_id = f.id AND rl.wallet = l.wallet))
                             FROM exit.finals f JOIN exit.final_lines l ON l.final_id = f.id AND l.wallet = v_wallet
                             WHERE f.case_id = c.id AND f.status IN ('approved', 'booked') AND c.state NOT IN ('waterfall'))
                 ) FROM exit.cases c
                 WHERE c.token = t.token AND EXISTS (SELECT 1 FROM exit.case_events e WHERE e.case_id = c.id AND e.code <> 'X1')
                 ORDER BY c.id DESC LIMIT 1),
        'windows', coalesce((SELECT jsonb_agg(jsonb_build_object('id', w.id, 'opensAt', webauth.utc(w.opens_at), 'closesAt', webauth.utc(w.closes_at),
                     'navPerUnitPaisa', w.nav_per_unit_paisa::text, 'discountPpm', w.discount_ppm, 'pricePerUnitPaisa', w.price_per_unit_paisa::text,
                     'open', clock_timestamp() >= w.opens_at AND clock_timestamp() < w.closes_at,
                     'full', (SELECT coalesce(sum(r.units), 0) FROM exit.requests r WHERE r.window_id = w.id AND r.status = 'submitted') >= w.cap_units) ORDER BY w.opens_at)
                   FROM exit.windows w WHERE w.token = t.token AND w.status = 'approved' AND w.closes_at > clock_timestamp()), '[]'::jsonb)
      ) AS j
      FROM chain.tokens t
      WHERE EXISTS (SELECT 1 FROM chain.holdings h WHERE h.token = t.token AND h.holder = v_wallet AND h.balance > 0)
         OR EXISTS (SELECT 1 FROM exit.finals f JOIN exit.final_lines l ON l.final_id = f.id WHERE f.token = t.token AND l.wallet = v_wallet)
    ) x), '[]'::jsonb),
    'requests', coalesce((SELECT jsonb_agg(jsonb_build_object('id', r.id, 'token', w.token, 'window', w.id, 'units', r.units::text,
        'pricePerUnitPaisa', r.price_per_unit_paisa::text, 'indicativePaisa', r.indicative_paisa::text,
        -- No tipping-off: a declined request reads "under review" (S-05 EX-45).
        'status', CASE WHEN r.status = 'declined' THEN 'under_review' ELSE r.status END,
        'withdrawable', r.status = 'submitted' AND clock_timestamp() < w.closes_at,
        'createdAt', webauth.utc(r.created_at)) ORDER BY r.created_at DESC)
      FROM exit.requests r JOIN exit.windows w ON w.id = r.window_id WHERE r.subject_id = v_subject), '[]'::jsonb));
END $$;

/**
 * EX-40: a redemption request for the signed-in investor (the subject comes from the session), after
 * a passkey step-up (exit.redemption_request is always sensitive). {"error": "session"|"step_up"|"enrol"}
 * when the gate refuses; otherwise the request (backend refusals raise with an investor-safe message).
 */
CREATE FUNCTION webauth.web_redemption_request(p_session bytea, p_window bigint, p_units numeric, p_idempotency text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, webauth AS $$
DECLARE
  v_subject uuid;
  v_price bigint;
  g record;
BEGIN
  SELECT w.price_per_unit_paisa INTO v_price FROM exit.windows w WHERE w.id = p_window;
  SELECT * INTO g FROM webauth.gate(p_session, 'exit.redemption_request', coalesce(v_price, 0)::numeric * greatest(coalesce(p_units, 0), 0));
  IF g.decision NOT IN ('ok', 'waived') THEN RETURN jsonb_build_object('error', g.decision); END IF;
  SELECT i.kyc_subject INTO v_subject FROM webdemo.investors i WHERE i.id = g.investor_id;
  IF v_subject IS NULL THEN RAISE EXCEPTION 'only a verified investor can request a redemption' USING ERRCODE = '42501'; END IF;
  RETURN exit.request_redemption(p_window, v_subject, p_units, p_idempotency, webauth.actor(g.investor_id));
END $$;

/** EX-44: withdraws the signed-in investor's own submitted request, after a passkey step-up. */
CREATE FUNCTION webauth.web_redemption_withdraw(p_session bytea, p_request uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, webauth AS $$
DECLARE
  v_subject uuid;
  g record;
BEGIN
  SELECT * INTO g FROM webauth.gate(p_session, 'exit.redemption_withdraw', 0);
  IF g.decision NOT IN ('ok', 'waived') THEN RETURN jsonb_build_object('error', g.decision); END IF;
  SELECT i.kyc_subject INTO v_subject FROM webdemo.investors i WHERE i.id = g.investor_id;
  IF v_subject IS NULL THEN RAISE EXCEPTION 'request not found' USING ERRCODE = 'P0002'; END IF;
  RETURN jsonb_build_object('status', exit.withdraw_request(p_request, v_subject, webauth.actor(g.investor_id)));
END $$;

-- ================================================================== privileges
REVOKE ALL ON ALL TABLES IN SCHEMA exit FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA exit FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.exit_decision_json(bigint, text), admin.exit_overview(bytea), admin.exit_case(bytea, bigint), admin.exit_window(bytea, bigint),
  admin.exit_request(bytea, bigint, text, jsonb, text), admin.exit_decide(bytea, text, bigint, text, text, bytea, jsonb), admin.exit_sync(bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION webauth.web_exit_overview(bytea), webauth.web_redemption_request(bytea, bigint, numeric, text),
  webauth.web_redemption_withdraw(bytea, uuid) FROM PUBLIC;
-- CREATE OR REPLACE keeps the grants of admin.audit_rows, admin.verify_chains and admin.record_export.

GRANT EXECUTE ON FUNCTION
  admin.exit_overview(bytea),
  admin.exit_case(bytea, bigint),
  admin.exit_window(bytea, bigint),
  admin.exit_request(bytea, bigint, text, jsonb, text),
  admin.exit_decide(bytea, text, bigint, text, text, bytea, jsonb),
  admin.exit_sync(bytea)
TO pt_admin_portal;

GRANT EXECUTE ON FUNCTION
  webauth.web_exit_overview(bytea),
  webauth.web_redemption_request(bytea, bigint, numeric, text),
  webauth.web_redemption_withdraw(bytea, uuid)
TO pt_web;

GRANT USAGE ON SCHEMA exit TO pt_exit_operator, pt_exit_reader, pt_signer, pt_recon_writer, pt_recon_reader, pt_admin_auditor;
-- The exit service / operator command line (operator names, never officer handles): maker steps,
-- the statement, the redemption items, the operations checker's steps (as S-03) and the tick.
-- Trustee, legal and compliance capacities are officers in PT Control only.
GRANT EXECUTE ON FUNCTION
  exit.open_case(text, text, bigint, bigint, text, bigint, text, bigint, boolean, text),
  exit.propose(bigint, text, jsonb, text, text),
  exit.propose_proceeds(bigint, text, bigint, integer, text, text),
  exit.decide_proceeds(bigint, text, text, text),
  exit.add_line(bigint, text, text, text, bigint, text, text),
  exit.withdraw_line(bigint, text),
  exit.submit_waterfall(bigint, text),
  exit.check_waterfall(bigint, text, text, text),
  exit.propose_payment(bigint, bigint, integer, text, text),
  exit.decide_payment(bigint, text, text, text),
  exit.announce_record_date(bigint, date, text, text),
  exit.calculate_final(bigint, bigint, text),
  exit.final_lines_of(bigint),
  exit.attach_final(bigint, text, text, text, text, text, text),
  exit.decide_final(bigint, text, text, text),
  exit.redemption_holders(bigint),
  exit.create_redemption(bigint, jsonb, text, text),
  exit.check_redemption(bigint, text, text, text),
  exit.tick(text),
  exit.propose_window(text, timestamptz, timestamptz, bigint, text, integer, text, text),
  exit.decide_window(bigint, text, text, text),
  exit.propose_outcome(bigint, text),
  exit.decide_outcome(bigint, text, text, text),
  exit.verify_audit()
TO pt_exit_operator;
GRANT SELECT ON ALL TABLES IN SCHEMA exit TO pt_exit_operator, pt_exit_reader;
GRANT EXECUTE ON FUNCTION exit.verify_audit(), exit.balance(text), exit.line_payment(bigint, text), exit.line_burn_problem(bigint, text),
  exit.close_problem(bigint), exit.case_digest(bigint), exit.decision_digest(bigint), exit.final_digest(bigint), exit.redemption_digest(bigint)
TO pt_exit_reader;
-- The signing service checks every burn against the redemption batch (EX-DB-5).
GRANT EXECUTE ON FUNCTION exit.burn_allowed(jsonb) TO pt_signer;
-- Reconciliation reads the exit views (ADR 0007 amendment).
GRANT SELECT ON exit.recon_lines, exit.recon_cases, exit.recon_finals, exit.settings TO pt_recon_writer, pt_recon_reader;
-- Functions a view calls are checked against the view's user.
GRANT EXECUTE ON FUNCTION exit.line_payment(bigint, text), exit.balance(text), exit.pool(text), exit.closure_reserve(text)
TO pt_recon_writer, pt_recon_reader, pt_exit_reader, pt_exit_operator;
GRANT EXECUTE ON FUNCTION exit.verify_audit() TO pt_recon_writer, pt_recon_reader, pt_admin_auditor;

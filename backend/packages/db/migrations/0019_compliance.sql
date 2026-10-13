-- Internal portals, Step 6c (task T-005, ADR 0011 section 11): the compliance officer portal.
--
-- Numbered 0019: 0018 is reserved for work built in parallel. Nothing here depends on 0018. Until
-- both are merged the backend runner refuses the gap (the admin portal's runner does not check it).
--
-- Safety properties enforced by the database itself (schema compliance, plus admin.* wrappers):
--   C-1  KYC review cases. A possible sanctions or PEP match (kyc.checks: sanctions, review) and a
--        confirmed list hit (sanctions, fail) open a case by themselves, in the same transaction
--        as the check; a newer screening supersedes the older open case. Officers open manual
--        cases (adverse information, source of funds) for a subject. The state machine lives in a
--        trigger: open <-> info_requested, open -> pending_second -> approved | rejected | open,
--        open -> approved | rejected (one officer, standard risk only), any open state ->
--        superseded. Closed cases never change.
--   C-2  Maker-checker for high risk, in the table itself: an approved high-risk or screening case,
--        and a rejected screening case, carry a proposer and a different decider (CHECK). For a
--        screening match the decision IS the existing two-officer clearance of ADR 0009 Y-4
--        (kyc.request_clearance by the proposer, kyc.decide_clearance by the second officer), so
--        the KYC status keeps being derived only in kyc.evaluate. A PEP match is accepted only as
--        "accept_edd" (enhanced due diligence) by two officers; a confirmed list hit is final and
--        can only be closed as rejected (Y-3). Rejecting any other case revokes the verification
--        (kyc.revoke, a protective action: one officer).
--   C-3  Freeze and unfreeze of an investor wallet are maker-checker (proposer <> decider, 24 hours
--        to decide), need a reason code of the right kind and a reason. An approved freeze places
--        a compliance hold: kyc.subject_status() then reads "suspended" (not verified), which is
--        exactly what the existing compliance.freeze signing policy requires, and one
--        compliance.freeze command goes to the outbox in the same transaction. An approved
--        unfreeze needs an active hold, an investor whose own KYC status is verified, lifts the
--        hold and enqueues compliance.unfreeze, which the signing service signs only when
--        compliance.unfreeze_allowed() confirms this two-officer decision (policy, ADR 0005).
--   C-4  Suspicious transaction report (STR) cases: open -> under_review -> filed | closed. Closing
--        without filing needs a second officer (nobody buries a suspicion alone). Filing needs an
--        export recorded first (the FMU file is made by hand from it: nothing is sent anywhere
--        automatically) and the FMU reference. Notes are append-only. Tipping-off: STR cases are
--        visible to compliance officers and auditors only and never change the investor's status.
--   C-5  Re-screening requests are queued here and executed by the KYC service (the only holder of
--        the sealed-name key); the portal never sees a name.
--   C-6  Least data: no table holds a name, CNIC, IBAN or phone number. Free text (reasons,
--        summaries, notes) is refused if it contains a CNIC, an IBAN or a mobile number.
--   C-7  Every row is written by a function that also appends to the hash-chained compliance.audit
--        (UTC digests); compliance.verify_audit() re-checks the chain and finds rows written around
--        the API. Cases, requests, holds, events, notes and exports are append-only or change only
--        along their state machine. Officer handles are bound to officer sessions (as in 0016): a
--        row carrying an officer's handle is refused unless the admin function that checked that
--        officer's session (permission, step-up for decisions) is on the stack. The same binding now
--        covers kyc.clearances and kyc.decisions.
--   C-8  Permissions: compliance.decide and compliance.export (compliance officers only);
--        compliance.read (compliance officers and auditors). Operations officers have none of them.

CREATE SCHEMA IF NOT EXISTS compliance;
REVOKE ALL ON SCHEMA compliance FROM PUBLIC;

-- ================================================================== helpers
CREATE FUNCTION compliance.forbid_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'compliance records are append-only: % on %.% is not allowed', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE FUNCTION compliance.utc(p timestamptz) RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT to_char(p AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
$$;

/** C-6: free text of the right length that carries no CNIC, IBAN or mobile number. */
CREATE FUNCTION compliance.free_text_ok(p text, p_min integer, p_max integer) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT p IS NOT NULL AND length(btrim(p)) BETWEEN p_min AND p_max
     AND p !~ '[0-9]{13}'
     AND p !~ '[0-9]{5}[ -][0-9]{7}[ -][0-9]'
     AND p !~* 'PK[0-9]{2} ?[A-Z]{4}'
     AND p !~ '(\+92|0092)[ -]?3[0-9]{2}'
     AND p !~ '(^|[^0-9])03[0-9]{2}[ -]?[0-9]{7}'
$$;

/** Service levels for the dashboard (ageing): how long an item may wait in a state. */
CREATE FUNCTION compliance.sla(p_what text) RETURNS interval
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT CASE p_what
    WHEN 'kyc.open' THEN interval '48 hours'
    WHEN 'kyc.info_requested' THEN interval '7 days'
    WHEN 'kyc.pending_second' THEN interval '24 hours'
    WHEN 'freeze.open' THEN interval '4 hours'
    WHEN 'str.open' THEN interval '3 days'
    WHEN 'str.under_review' THEN interval '7 days'
    WHEN 'str.close_proposed' THEN interval '2 days'
    WHEN 'rescreen.queued' THEN interval '1 hour'
    ELSE NULL END
$$;

-- ================================================================== audit (C-7)
CREATE TABLE compliance.audit (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at        timestamptz NOT NULL,
  actor     text NOT NULL CHECK (length(actor) BETWEEN 1 AND 100),
  action    text NOT NULL CHECK (action ~ '^[a-z][a-z_.]{2,63}$'),
  detail    jsonb NOT NULL CHECK (jsonb_typeof(detail) = 'object' AND octet_length(detail::text) <= 8192),
  prev_hash bytea NOT NULL CHECK (length(prev_hash) = 32),
  hash      bytea NOT NULL UNIQUE CHECK (length(hash) = 32)
);
CREATE INDEX audit_action_idx ON compliance.audit (action, id);

CREATE FUNCTION compliance.audit_digest(p_prev bytea, p_id bigint, p_at timestamptz, p_actor text, p_action text, p_detail jsonb)
RETURNS bytea LANGUAGE sql STABLE SET search_path = pg_catalog, compliance AS $$
  SELECT sha256(p_prev || convert_to('pt-compliance-audit-v1' || jsonb_build_array(p_id, compliance.utc(p_at), p_actor, p_action, p_detail)::text, 'UTF8'))
$$;

CREATE FUNCTION compliance.audit_append(p_actor text, p_action text, p_detail jsonb)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, compliance AS $$
DECLARE
  v_prev bytea;
  v_id bigint;
  v_at timestamptz := date_trunc('microseconds', clock_timestamp());
BEGIN
  PERFORM pg_advisory_xact_lock(586586190);
  SELECT hash INTO v_prev FROM compliance.audit ORDER BY id DESC LIMIT 1;
  v_prev := coalesce(v_prev, decode(repeat('00', 32), 'hex'));
  v_id := nextval(pg_get_serial_sequence('compliance.audit', 'id'));
  INSERT INTO compliance.audit (id, at, actor, action, detail, prev_hash, hash)
  OVERRIDING SYSTEM VALUE
  VALUES (v_id, v_at, left(p_actor, 100), p_action, coalesce(p_detail, '{}'::jsonb), v_prev,
          compliance.audit_digest(v_prev, v_id, v_at, left(p_actor, 100), p_action, coalesce(p_detail, '{}'::jsonb)));
  RETURN v_id;
END $$;

-- ================================================================== reason codes (C-3, C-4)
CREATE TABLE compliance.reason_codes (
  code       text NOT NULL CHECK (code ~ '^[a-z][a-z_]{2,39}$'),
  applies_to text NOT NULL CHECK (applies_to IN ('freeze', 'unfreeze', 'str')),
  label      text NOT NULL CHECK (length(label) BETWEEN 5 AND 120),
  PRIMARY KEY (code, applies_to)
);
INSERT INTO compliance.reason_codes (code, applies_to, label) VALUES
  ('court_order', 'freeze', 'Court or tribunal order'),
  ('regulator_direction', 'freeze', 'Direction from SECP, FMU or a law-enforcement agency'),
  ('sanctions_match', 'freeze', 'Sanctions or proscribed-person match under review'),
  ('suspicious_activity', 'freeze', 'Suspicious activity under investigation (STR case)'),
  ('fraud_suspected', 'freeze', 'Suspected fraud or account takeover'),
  ('kyc_deficiency', 'freeze', 'KYC deficiency (documents expired, information not provided)'),
  ('court_release', 'unfreeze', 'Court or tribunal order lifted'),
  ('regulator_release', 'unfreeze', 'Direction from SECP, FMU or a law-enforcement agency lifted'),
  ('investigation_closed', 'unfreeze', 'Investigation closed without findings'),
  ('kyc_remediated', 'unfreeze', 'KYC deficiency remediated'),
  ('error_correction', 'unfreeze', 'Freeze placed in error'),
  ('structuring', 'str', 'Structuring or smurfing below reporting thresholds'),
  ('third_party_funding', 'str', 'Funding from a third party or an unexplained source'),
  ('unusual_pattern', 'str', 'Unusual pattern against the investor profile'),
  ('rapid_in_out', 'str', 'Rapid investment and exit without economic purpose'),
  ('sanctions_related', 'str', 'Sanctions, proscription or terrorist-financing indicator'),
  ('identity_concern', 'str', 'Identity fraud or impersonation indicator'),
  ('adverse_information', 'str', 'Adverse media or credible adverse information'),
  ('other', 'str', 'Other ground (explained in the summary)');

-- ================================================================== KYC review cases (C-1, C-2)
CREATE TABLE compliance.kyc_cases (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subject_id      uuid NOT NULL REFERENCES kyc.subjects (id),
  kind            text NOT NULL CHECK (kind IN ('screening_match', 'sanctions_hit', 'manual')),
  check_id        bigint UNIQUE REFERENCES kyc.checks (id),
  risk            text NOT NULL CHECK (risk IN ('standard', 'high')),
  flags           text[] NOT NULL DEFAULT '{}'
                  CHECK (flags <@ ARRAY['sanctions_possible_match', 'pep', 'sanctions_hit', 'manual']::text[]),
  summary         text NOT NULL CHECK (compliance.free_text_ok(summary, 10, 500)),
  status          text NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open', 'info_requested', 'pending_second', 'approved', 'rejected', 'superseded')),
  proposal        text CHECK (proposal IN ('approve', 'reject')),
  proposed_by     text CHECK (length(proposed_by) BETWEEN 2 AND 100),
  proposal_reason text CHECK (proposal_reason IS NULL OR compliance.free_text_ok(proposal_reason, 10, 500)),
  proposed_at     timestamptz,
  clearance_id    bigint REFERENCES kyc.clearances (id),
  opened_by       text NOT NULL CHECK (length(opened_by) BETWEEN 2 AND 100),
  opened_at       timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  updated_at      timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  decided_by      text CHECK (length(decided_by) BETWEEN 2 AND 100),
  decision_reason text CHECK (length(decision_reason) BETWEEN 10 AND 500),
  decided_at      timestamptz,
  CHECK (kind = 'manual' OR check_id IS NOT NULL),
  CHECK (kind <> 'manual' OR check_id IS NULL),
  CHECK (kind = 'manual' OR risk = 'high'),
  CHECK (clearance_id IS NULL OR kind = 'screening_match'),
  CHECK (status <> 'pending_second' OR proposal IS NOT NULL),
  CHECK (status NOT IN ('open', 'info_requested') OR (proposal IS NULL AND clearance_id IS NULL)),
  CHECK ((proposal IS NULL) = (proposed_by IS NULL) AND (proposal IS NULL) = (proposal_reason IS NULL) AND (proposal IS NULL) = (proposed_at IS NULL)),
  CHECK ((status IN ('approved', 'rejected', 'superseded')) = (decided_by IS NOT NULL AND decision_reason IS NOT NULL AND decided_at IS NOT NULL)),
  -- C-2: maker-checker, also against a direct UPDATE.
  CHECK (decided_by IS NULL OR proposed_by IS NULL OR decided_by <> proposed_by),
  CHECK (status <> 'approved' OR kind <> 'sanctions_hit'),
  CHECK (status <> 'approved' OR (kind = 'manual' AND risk = 'standard') OR proposal IS NOT DISTINCT FROM 'approve'),
  CHECK (status <> 'rejected' OR kind <> 'screening_match' OR proposal IS NOT DISTINCT FROM 'reject')
);
CREATE INDEX kyc_cases_subject_idx ON compliance.kyc_cases (subject_id, id DESC);
CREATE INDEX kyc_cases_live_idx ON compliance.kyc_cases (status) WHERE status IN ('open', 'info_requested', 'pending_second');

CREATE FUNCTION compliance.guard_kyc_case() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'KYC cases are never deleted' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF OLD.status IN ('approved', 'rejected', 'superseded') THEN
    RAISE EXCEPTION 'KYC case % is closed (%)', OLD.id, OLD.status USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.id, NEW.subject_id, NEW.kind, NEW.check_id, NEW.summary, NEW.opened_by, NEW.opened_at)
     IS DISTINCT FROM (OLD.id, OLD.subject_id, OLD.kind, OLD.check_id, OLD.summary, OLD.opened_by, OLD.opened_at) THEN
    RAISE EXCEPTION 'KYC case %: subject, kind, check, summary and opening never change', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.risk <> OLD.risk AND NOT (OLD.risk = 'standard' AND NEW.risk = 'high') THEN
    RAISE EXCEPTION 'KYC case %: the risk is only ever raised', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NOT (OLD.flags <@ NEW.flags) THEN
    RAISE EXCEPTION 'KYC case %: flags are only ever added', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status <> OLD.status AND (OLD.status || '>' || NEW.status) NOT IN (
       'open>info_requested', 'info_requested>open', 'open>pending_second', 'pending_second>open',
       'pending_second>approved', 'pending_second>rejected', 'open>approved', 'open>rejected',
       'open>superseded', 'info_requested>superseded', 'pending_second>superseded') THEN
    RAISE EXCEPTION 'KYC case %: % -> % is not a transition of the case state machine', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := date_trunc('microseconds', clock_timestamp());
  RETURN NEW;
END $$;
CREATE TRIGGER kyc_cases_guard BEFORE UPDATE OR DELETE ON compliance.kyc_cases FOR EACH ROW EXECUTE FUNCTION compliance.guard_kyc_case();

CREATE TABLE compliance.kyc_case_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  case_id     bigint NOT NULL REFERENCES compliance.kyc_cases (id),
  action      text NOT NULL CHECK (action IN ('opened', 'request_info', 'info_received', 'escalate', 'approve', 'reject',
                                              'confirm', 'decline', 'expired', 'superseded')),
  from_status text,
  to_status   text NOT NULL,
  actor       text NOT NULL CHECK (length(actor) BETWEEN 2 AND 100),
  reason      text NOT NULL CHECK (compliance.free_text_ok(reason, 2, 500)),
  at          timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp())
);
CREATE INDEX kyc_case_events_case_idx ON compliance.kyc_case_events (case_id, id);

/** Digest of a case as the officer saw it (what you see is what you decide). */
CREATE FUNCTION compliance.kyc_case_digest(p_case bigint) RETURNS bytea
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, compliance AS $$
  SELECT sha256(convert_to('pt-kyc-case-v1' || jsonb_build_array(k.id, k.subject_id, k.kind, k.check_id, k.risk, k.flags, k.status,
           k.proposal, k.proposed_by, k.clearance_id, compliance.utc(k.updated_at))::text, 'UTF8'))
  FROM compliance.kyc_cases k WHERE k.id = p_case
$$;

/** Internal: opens a case and writes its first event and audit entry. */
CREATE FUNCTION compliance.insert_kyc_case(p_subject uuid, p_kind text, p_check bigint, p_risk text, p_flags text[], p_summary text, p_actor text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, compliance AS $$
DECLARE
  v_id bigint;
BEGIN
  INSERT INTO compliance.kyc_cases (subject_id, kind, check_id, risk, flags, summary, opened_by)
  VALUES (p_subject, p_kind, p_check, p_risk, p_flags, btrim(p_summary), p_actor) RETURNING id INTO v_id;
  INSERT INTO compliance.kyc_case_events (case_id, action, from_status, to_status, actor, reason)
  VALUES (v_id, 'opened', NULL, 'open', p_actor, btrim(p_summary));
  PERFORM compliance.audit_append(p_actor, 'kyc_case.opened', jsonb_build_object('case', v_id, 'subject', p_subject, 'kind', p_kind,
    'check', p_check, 'risk', p_risk, 'flags', to_jsonb(p_flags)));
  RETURN v_id;
END $$;

/** C-1: a compliance officer opens a manual review case for a subject. */
CREATE FUNCTION compliance.open_kyc_case(p_subject uuid, p_risk text, p_summary text, p_actor text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, compliance AS $$
BEGIN
  IF p_risk IS NULL OR p_risk NOT IN ('standard', 'high') THEN
    RAISE EXCEPTION 'risk must be standard or high' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT compliance.free_text_ok(p_summary, 10, 500) THEN
    RAISE EXCEPTION 'a summary of 10 to 500 characters is required (never a CNIC, IBAN or phone number)' USING ERRCODE = 'check_violation';
  END IF;
  IF p_actor IS NULL OR NOT EXISTS (SELECT 1 FROM kyc.subjects WHERE id = p_subject) THEN
    RAISE EXCEPTION 'unknown subject' USING ERRCODE = 'no_data_found';
  END IF;
  RETURN compliance.insert_kyc_case(p_subject, 'manual', NULL, p_risk, ARRAY['manual'], p_summary, p_actor);
END $$;

/** C-1: a sanctions screening opens (or supersedes) cases by itself, in the check's transaction. */
CREATE FUNCTION compliance.on_screening() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, compliance AS $$
DECLARE
  k compliance.kyc_cases;
BEGIN
  IF NEW.kind <> 'sanctions' OR NEW.outcome = 'error' THEN RETURN NULL; END IF;
  FOR k IN SELECT * FROM compliance.kyc_cases
           WHERE subject_id = NEW.subject_id AND kind = 'screening_match' AND status IN ('open', 'info_requested', 'pending_second')
           ORDER BY id FOR UPDATE LOOP
    UPDATE compliance.kyc_cases SET status = 'superseded', decided_by = NEW.recorded_by, decided_at = clock_timestamp(),
           decision_reason = format('superseded by the newer screening %s (%s)', NEW.id, NEW.outcome)
    WHERE id = k.id;
    INSERT INTO compliance.kyc_case_events (case_id, action, from_status, to_status, actor, reason)
    VALUES (k.id, 'superseded', k.status, 'superseded', NEW.recorded_by, format('newer screening %s: %s', NEW.id, NEW.outcome));
    PERFORM compliance.audit_append(NEW.recorded_by, 'kyc_case.superseded', jsonb_build_object('case', k.id, 'subject', k.subject_id,
      'from', k.status, 'to', 'superseded', 'check', NEW.id));
  END LOOP;
  IF NEW.outcome = 'review' THEN
    PERFORM compliance.insert_kyc_case(NEW.subject_id, 'screening_match', NEW.id, 'high',
      CASE WHEN NEW.reason = 'pep_match' THEN ARRAY['pep'] ELSE ARRAY['sanctions_possible_match'] END,
      format('%s from %s (score %s, list %s): two compliance officers decide',
             CASE WHEN NEW.reason = 'pep_match' THEN 'Possible PEP match' ELSE 'Possible sanctions list match' END,
             NEW.provider, coalesce(NEW.score::text, '?'), coalesce(NEW.list_version, '?')),
      NEW.recorded_by);
  ELSIF NEW.outcome = 'fail' THEN
    PERFORM compliance.insert_kyc_case(NEW.subject_id, 'sanctions_hit', NEW.id, 'high', ARRAY['sanctions_hit'],
      format('Confirmed sanctions list hit from %s (list %s): final, consider an STR and a freeze', NEW.provider, coalesce(NEW.list_version, '?')),
      NEW.recorded_by);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER checks_compliance_cases AFTER INSERT ON kyc.checks FOR EACH ROW EXECUTE FUNCTION compliance.on_screening();

/**
 * C-1/C-2: one officer action on a KYC case. Returns the new status. Two-officer outcomes go
 * through pending_second; for a screening match the decision runs Y-4 (kyc.request_clearance /
 * kyc.decide_clearance), which re-evaluates the subject.
 */
CREATE FUNCTION compliance.kyc_case_act(p_case bigint, p_actor text, p_action text, p_reason text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, compliance AS $$
DECLARE
  k compliance.kyc_cases;
  c kyc.checks;
  v_to text;
  v_two boolean;
  v_clear bigint;
  v_res text;
  v_reason text := btrim(p_reason);
BEGIN
  IF p_action IS NULL OR p_action NOT IN ('request_info', 'info_received', 'escalate', 'approve', 'reject', 'confirm', 'decline') THEN
    RAISE EXCEPTION 'unknown action' USING ERRCODE = 'check_violation';
  END IF;
  IF p_actor IS NULL OR length(p_actor) NOT BETWEEN 2 AND 100 OR NOT compliance.free_text_ok(p_reason, 10, 500) THEN
    RAISE EXCEPTION 'a reason of 10 to 500 characters is required (never a CNIC, IBAN or phone number)' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO k FROM compliance.kyc_cases WHERE id = p_case FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown KYC case' USING ERRCODE = 'no_data_found'; END IF;
  IF k.status IN ('approved', 'rejected', 'superseded') THEN
    RAISE EXCEPTION 'the case is closed (%)', k.status USING ERRCODE = 'check_violation';
  END IF;
  v_two := k.kind = 'screening_match' OR k.risk = 'high';

  IF p_action = 'request_info' THEN
    IF k.status <> 'open' THEN RAISE EXCEPTION 'more information can be requested only on an open case (it is %)', k.status USING ERRCODE = 'check_violation'; END IF;
    v_to := 'info_requested';
    UPDATE compliance.kyc_cases SET status = v_to WHERE id = k.id;
  ELSIF p_action = 'info_received' THEN
    IF k.status <> 'info_requested' THEN RAISE EXCEPTION 'no information was requested' USING ERRCODE = 'check_violation'; END IF;
    v_to := 'open';
    UPDATE compliance.kyc_cases SET status = v_to WHERE id = k.id;
  ELSIF p_action = 'escalate' THEN
    IF k.risk = 'high' THEN RAISE EXCEPTION 'the case is already high risk' USING ERRCODE = 'check_violation'; END IF;
    IF k.status NOT IN ('open', 'info_requested') THEN RAISE EXCEPTION 'escalate before a decision is proposed' USING ERRCODE = 'check_violation'; END IF;
    v_to := k.status;
    UPDATE compliance.kyc_cases SET risk = 'high' WHERE id = k.id;
  ELSIF p_action IN ('approve', 'reject') THEN
    IF k.status <> 'open' THEN RAISE EXCEPTION 'only an open case can be decided (it is %)', k.status USING ERRCODE = 'check_violation'; END IF;
    IF p_action = 'approve' AND k.kind = 'sanctions_hit' THEN
      RAISE EXCEPTION 'a confirmed sanctions list hit is final (rule Y-3): it can only be closed as rejected' USING ERRCODE = 'check_violation';
    END IF;
    IF k.kind = 'screening_match' THEN
      SELECT * INTO c FROM kyc.checks WHERE id = k.check_id;
      v_clear := kyc.request_clearance(k.check_id, p_actor,
        CASE WHEN p_action = 'reject' THEN 'true_match' WHEN c.reason = 'pep_match' THEN 'accept_edd' ELSE 'false_positive' END, v_reason);
      v_to := 'pending_second';
      UPDATE compliance.kyc_cases SET status = v_to, proposal = p_action, proposed_by = p_actor, proposal_reason = v_reason,
             proposed_at = clock_timestamp(), clearance_id = v_clear WHERE id = k.id;
    ELSIF p_action = 'approve' AND v_two THEN
      v_to := 'pending_second';
      UPDATE compliance.kyc_cases SET status = v_to, proposal = p_action, proposed_by = p_actor, proposal_reason = v_reason,
             proposed_at = clock_timestamp() WHERE id = k.id;
    ELSE
      IF p_action = 'reject' AND k.kind = 'manual' AND kyc.subject_status(k.subject_id) NOT IN ('revoked', 'rejected', 'unknown') THEN
        PERFORM kyc.revoke(k.subject_id, p_actor, left(v_reason, 300));
      END IF;
      v_to := CASE WHEN p_action = 'approve' THEN 'approved' ELSE 'rejected' END;
      UPDATE compliance.kyc_cases SET status = v_to, decided_by = p_actor, decision_reason = v_reason, decided_at = clock_timestamp() WHERE id = k.id;
    END IF;
  ELSE
    -- confirm or decline a proposal: a second, different officer (C-2).
    IF k.status <> 'pending_second' THEN RAISE EXCEPTION 'nothing is waiting for a second officer' USING ERRCODE = 'check_violation'; END IF;
    IF k.proposed_by = p_actor THEN
      RAISE EXCEPTION 'maker-checker: the officer who proposed the decision cannot confirm or decline it' USING ERRCODE = 'check_violation';
    END IF;
    IF k.kind = 'screening_match' THEN
      v_res := kyc.decide_clearance(k.clearance_id, p_actor, CASE WHEN p_action = 'confirm' THEN 'approve' ELSE 'reject' END, v_reason);
      IF v_res = 'expired' THEN
        UPDATE compliance.kyc_cases SET status = 'open', proposal = NULL, proposed_by = NULL, proposal_reason = NULL, proposed_at = NULL,
               clearance_id = NULL WHERE id = k.id;
        INSERT INTO compliance.kyc_case_events (case_id, action, from_status, to_status, actor, reason)
        VALUES (k.id, 'expired', k.status, 'open', p_actor, 'the clearance expired (72 hours) or a newer screening exists: propose again');
        PERFORM compliance.audit_append(p_actor, 'kyc_case.expired', jsonb_build_object('case', k.id, 'subject', k.subject_id, 'from', k.status,
          'to', 'open', 'clearance', k.clearance_id));
        RETURN 'open';
      ELSIF v_res NOT IN ('approved', 'rejected') THEN
        RAISE EXCEPTION 'the clearance was already %', v_res USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF p_action = 'confirm' THEN
      v_to := CASE WHEN k.proposal = 'approve' THEN 'approved' ELSE 'rejected' END;
      UPDATE compliance.kyc_cases SET status = v_to, decided_by = p_actor, decision_reason = v_reason, decided_at = clock_timestamp() WHERE id = k.id;
    ELSE
      v_to := 'open';
      UPDATE compliance.kyc_cases SET status = 'open', proposal = NULL, proposed_by = NULL, proposal_reason = NULL, proposed_at = NULL,
             clearance_id = NULL WHERE id = k.id;
    END IF;
  END IF;

  INSERT INTO compliance.kyc_case_events (case_id, action, from_status, to_status, actor, reason)
  VALUES (k.id, p_action, k.status, v_to, p_actor, v_reason);
  PERFORM compliance.audit_append(p_actor, 'kyc_case.' || p_action, jsonb_build_object('case', k.id, 'subject', k.subject_id, 'from', k.status,
    'to', v_to, 'proposal', CASE WHEN p_action IN ('approve', 'reject') AND v_to = 'pending_second' THEN p_action ELSE k.proposal END,
    'proposedBy', k.proposed_by, 'clearance', coalesce(v_clear, k.clearance_id), 'reason', v_reason));
  RETURN v_to;
END $$;

-- ------------------------------------------------------------------ PEP acceptance (C-2) in the KYC rules
-- A PEP match is not a sanctions match: two officers may accept it after enhanced due diligence.
ALTER TABLE kyc.clearances DROP CONSTRAINT clearances_proposal_check;
ALTER TABLE kyc.clearances ADD CONSTRAINT clearances_proposal_check CHECK (proposal IN ('false_positive', 'true_match', 'accept_edd'));

CREATE OR REPLACE FUNCTION kyc.request_clearance(p_check bigint, p_officer text, p_proposal text, p_reason text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, kyc AS $$
DECLARE
  c kyc.checks;
  v_id bigint;
BEGIN
  IF p_proposal IS NULL OR p_proposal NOT IN ('false_positive', 'true_match', 'accept_edd') THEN
    RAISE EXCEPTION 'proposal must be false_positive, true_match or accept_edd' USING ERRCODE = 'check_violation';
  END IF;
  IF p_officer IS NULL OR length(p_officer) NOT BETWEEN 2 AND 100 OR p_reason IS NULL OR length(p_reason) NOT BETWEEN 10 AND 500 THEN
    RAISE EXCEPTION 'an officer and a reason of 10 to 500 characters are required' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO c FROM kyc.checks WHERE id = p_check;
  IF NOT FOUND OR c.kind <> 'sanctions' OR c.outcome <> 'review' THEN
    RAISE EXCEPTION 'check % is not a sanctions screening in review', p_check USING ERRCODE = 'check_violation';
  END IF;
  IF p_proposal = 'accept_edd' AND c.reason <> 'pep_match' THEN
    RAISE EXCEPTION 'accept_edd is only for a PEP match; a possible sanctions match is a false positive or a true match' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM kyc.checks WHERE subject_id = c.subject_id AND kind = 'sanctions' AND outcome <> 'error' AND id > c.id) THEN
    RAISE EXCEPTION 'check % is no longer the latest sanctions screening of its subject', p_check USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(586586093);
  UPDATE kyc.clearances SET status = 'expired', decided_at = clock_timestamp() WHERE status = 'open' AND expires_at < now();
  IF EXISTS (SELECT 1 FROM kyc.clearances WHERE check_id = p_check AND status IN ('open', 'approved')) THEN
    RAISE EXCEPTION 'check % already has an open or approved clearance', p_check USING ERRCODE = 'unique_violation';
  END IF;
  INSERT INTO kyc.clearances (subject_id, check_id, proposal, requested_by, reason)
  VALUES (c.subject_id, p_check, p_proposal, p_officer, p_reason) RETURNING id INTO v_id;
  PERFORM kyc.audit_append(p_officer, 'clearance.requested', jsonb_build_object('clearance', v_id, 'check', p_check, 'subject', c.subject_id,
                                                                               'proposal', p_proposal, 'reason', p_reason));
  RETURN v_id;
END $$;

-- Same rules as 0009 (Y-3); new: an approved accept_edd clears a PEP match like a false positive, with its own reason.
CREATE OR REPLACE FUNCTION kyc.evaluate(p_subject uuid, p_actor text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, kyc AS $$
DECLARE
  cur kyc.decisions;
  n kyc.checks;
  l kyc.checks;
  s kyc.checks;
  v_clear text;
  v_status text;
  v_reason text;
  v_valid timestamptz;
  v_was_verified boolean;
  v_basis jsonb;
  v_id bigint;
BEGIN
  IF p_subject IS NULL OR p_actor IS NULL THEN
    RAISE EXCEPTION 'subject and actor are required' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(586586092, hashtext(p_subject::text));
  IF NOT EXISTS (SELECT 1 FROM kyc.subjects WHERE id = p_subject) THEN
    RAISE EXCEPTION 'unknown subject %', p_subject USING ERRCODE = 'no_data_found';
  END IF;
  SELECT * INTO cur FROM kyc.decisions WHERE subject_id = p_subject ORDER BY id DESC LIMIT 1;
  IF cur.status = 'revoked' THEN RETURN 'revoked'; END IF;
  v_was_verified := coalesce(cur.status = 'verified' AND cur.valid_until > now(), false);

  SELECT * INTO n FROM kyc.checks WHERE subject_id = p_subject AND kind = 'nadra' AND outcome <> 'error' ORDER BY id DESC LIMIT 1;
  SELECT * INTO l FROM kyc.checks WHERE subject_id = p_subject AND kind = 'liveness' AND outcome <> 'error' ORDER BY id DESC LIMIT 1;
  SELECT * INTO s FROM kyc.checks WHERE subject_id = p_subject AND kind = 'sanctions' AND outcome <> 'error' ORDER BY id DESC LIMIT 1;
  IF s.outcome = 'review' THEN
    SELECT proposal INTO v_clear FROM kyc.clearances WHERE check_id = s.id AND status = 'approved';
  END IF;
  v_basis := jsonb_build_object('nadra', n.id, 'liveness', l.id, 'sanctions', s.id, 'clearance', v_clear);

  IF EXISTS (SELECT 1 FROM kyc.checks WHERE subject_id = p_subject AND kind = 'sanctions' AND outcome = 'fail')
     OR EXISTS (SELECT 1 FROM kyc.clearances WHERE subject_id = p_subject AND status = 'approved' AND proposal = 'true_match') THEN
    v_status := 'rejected';
    v_reason := 'sanctions match (final)';
  ELSIF s.outcome = 'review' AND v_clear IS NULL THEN
    v_status := 'review';
    v_reason := CASE WHEN s.reason = 'pep_match' THEN 'possible PEP match: two compliance officers must decide (enhanced due diligence)'
                     ELSE 'possible sanctions match: two compliance officers must decide' END;
  ELSIF n.outcome = 'fail' THEN
    v_status := 'rejected';
    v_reason := format('NADRA did not confirm the identity (%s)', n.reason);
  ELSIF l.outcome = 'fail' THEN
    v_status := 'rejected';
    v_reason := format('liveness check failed (%s)', l.reason);
  ELSIF n.id IS NULL OR l.id IS NULL OR s.id IS NULL THEN
    v_status := 'pending';
    v_reason := 'waiting for: ' || concat_ws(', ', CASE WHEN n.id IS NULL THEN 'NADRA' END, CASE WHEN l.id IS NULL THEN 'liveness' END,
                                             CASE WHEN s.id IS NULL THEN 'sanctions screening' END);
  ELSIF NOT v_was_verified AND least(n.at, l.at, s.at) < now() - interval '30 days' THEN
    v_status := 'pending';
    v_reason := 'checks are older than 30 days: repeat them';
  ELSE
    v_status := 'verified';
    v_valid := CASE WHEN v_was_verified THEN cur.valid_until ELSE least(n.at, l.at, s.at) + interval '365 days' END;
    v_reason := format('NADRA match, liveness %s, sanctions clear%s', l.score,
                       CASE WHEN v_clear = 'false_positive' THEN ' (possible match cleared by two officers)'
                            WHEN v_clear = 'accept_edd' THEN ' (PEP accepted after enhanced due diligence by two officers)' ELSE '' END);
  END IF;

  IF cur.id IS NOT NULL AND (cur.status, cur.reason, cur.valid_until) IS NOT DISTINCT FROM (v_status, v_reason, v_valid) THEN
    RETURN v_status;
  END IF;
  INSERT INTO kyc.decisions (subject_id, status, reason, basis, valid_until, decided_by)
  VALUES (p_subject, v_status, v_reason, v_basis, v_valid, p_actor) RETURNING id INTO v_id;
  PERFORM kyc.audit_append(p_actor, 'decision', jsonb_build_object('decision', v_id, 'subject', p_subject, 'status', v_status,
                                                                  'validUntil', kyc.utc(v_valid), 'basis', v_basis));
  IF cur.status = 'verified' AND v_status <> 'verified' THEN
    PERFORM pg_notify('kyc_alert', json_build_object('subject', p_subject, 'from', cur.status, 'to', v_status)::text);
  END IF;
  RETURN v_status;
END $$;

-- ================================================================== freezes, holds (C-3)
CREATE TABLE compliance.freeze_requests (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind              text NOT NULL CHECK (kind IN ('freeze', 'unfreeze')),
  subject_id        uuid NOT NULL REFERENCES kyc.subjects (id),
  wallet            text NOT NULL CHECK (length(wallet) = 42 AND wallet ~ '^0x[0-9a-f]+$'),
  reason_code       text NOT NULL,
  reason            text NOT NULL CHECK (compliance.free_text_ok(reason, 10, 500)),
  kyc_case_id       bigint REFERENCES compliance.kyc_cases (id),
  str_case_id       bigint,
  -- For an unfreeze: the freeze whose hold it lifts.
  lifts_request_id  bigint REFERENCES compliance.freeze_requests (id),
  -- bytes32 caseId sent to FreezeGuard (only in events on chain): SHA-256 of the domain and the id.
  case_ref          bytea NOT NULL UNIQUE CHECK (length(case_ref) = 32),
  requested_by      text NOT NULL CHECK (length(requested_by) BETWEEN 2 AND 100),
  requested_at      timestamptz NOT NULL,
  expires_at        timestamptz NOT NULL,
  status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'approved', 'rejected', 'expired')),
  decided_by        text CHECK (length(decided_by) BETWEEN 2 AND 100),
  decision_reason   text CHECK (decision_reason IS NULL OR compliance.free_text_ok(decision_reason, 10, 500)),
  decided_at        timestamptz,
  command_key       text UNIQUE,
  FOREIGN KEY (reason_code, kind) REFERENCES compliance.reason_codes (code, applies_to),
  CHECK (expires_at = requested_at + interval '24 hours'),
  CHECK ((kind = 'unfreeze') = (lifts_request_id IS NOT NULL)),
  -- C-3 maker-checker, also against a direct UPDATE.
  CHECK (decided_by IS NULL OR decided_by <> requested_by),
  CHECK ((status = 'open') = (decided_at IS NULL)),
  CHECK ((status IN ('approved', 'rejected')) = (decided_by IS NOT NULL AND decision_reason IS NOT NULL)),
  CHECK ((status = 'approved') = (command_key IS NOT NULL))
);
CREATE UNIQUE INDEX freeze_requests_one_open ON compliance.freeze_requests (wallet) WHERE status = 'open';

CREATE FUNCTION compliance.guard_freeze_request() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'freeze requests are never deleted' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF OLD.status <> 'open'
     OR (NEW.id, NEW.kind, NEW.subject_id, NEW.wallet, NEW.reason_code, NEW.reason, NEW.kyc_case_id, NEW.str_case_id, NEW.lifts_request_id,
         NEW.case_ref, NEW.requested_by, NEW.requested_at, NEW.expires_at)
        IS DISTINCT FROM (OLD.id, OLD.kind, OLD.subject_id, OLD.wallet, OLD.reason_code, OLD.reason, OLD.kyc_case_id, OLD.str_case_id,
         OLD.lifts_request_id, OLD.case_ref, OLD.requested_by, OLD.requested_at, OLD.expires_at) THEN
    RAISE EXCEPTION 'freeze request % can only be decided once', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER freeze_requests_guard BEFORE UPDATE OR DELETE ON compliance.freeze_requests FOR EACH ROW EXECUTE FUNCTION compliance.guard_freeze_request();

CREATE TABLE compliance.holds (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subject_id        uuid NOT NULL REFERENCES kyc.subjects (id),
  wallet            text NOT NULL,
  freeze_request_id bigint NOT NULL UNIQUE REFERENCES compliance.freeze_requests (id),
  placed_at         timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  lifted_at         timestamptz,
  lifted_by_request bigint UNIQUE REFERENCES compliance.freeze_requests (id),
  CHECK ((lifted_at IS NULL) = (lifted_by_request IS NULL))
);
CREATE UNIQUE INDEX holds_one_active ON compliance.holds (wallet) WHERE lifted_at IS NULL;
CREATE INDEX holds_subject_idx ON compliance.holds (subject_id) WHERE lifted_at IS NULL;

CREATE FUNCTION compliance.guard_hold() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'holds are never deleted' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF OLD.lifted_at IS NOT NULL OR NEW.lifted_at IS NULL
     OR (NEW.id, NEW.subject_id, NEW.wallet, NEW.freeze_request_id, NEW.placed_at)
        IS DISTINCT FROM (OLD.id, OLD.subject_id, OLD.wallet, OLD.freeze_request_id, OLD.placed_at) THEN
    RAISE EXCEPTION 'hold % can only be lifted, once', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER holds_guard BEFORE UPDATE OR DELETE ON compliance.holds FOR EACH ROW EXECUTE FUNCTION compliance.guard_hold();

-- The KYC status a gate relies on (0009) with the compliance hold on top: a verified (or expired)
-- investor under an approved freeze reads "suspended", so no gate (signer, bank, offering) treats
-- them as verified while the hold lasts, and the signer's freeze policy (owner not verified) holds.
CREATE FUNCTION kyc.underlying_status(p_subject uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, kyc AS $$
  SELECT CASE
    WHEN NOT EXISTS (SELECT 1 FROM kyc.subjects WHERE id = p_subject) THEN 'unknown'
    ELSE coalesce((SELECT CASE WHEN d.status = 'verified' AND d.valid_until <= now() THEN 'expired' ELSE d.status END
                   FROM kyc.decisions d WHERE d.subject_id = p_subject ORDER BY d.id DESC LIMIT 1), 'pending')
  END
$$;

CREATE OR REPLACE FUNCTION kyc.subject_status(p_subject uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, kyc AS $$
  SELECT CASE WHEN u.st IN ('verified', 'expired')
                   AND EXISTS (SELECT 1 FROM compliance.holds h WHERE h.subject_id = p_subject AND h.lifted_at IS NULL)
              THEN 'suspended' ELSE u.st END
  FROM (SELECT kyc.underlying_status(p_subject) AS st) u
$$;

/** The FreezeGuard the active signing policy of a kind targets (NULL without an active policy). */
CREATE FUNCTION compliance.freeze_guard(p_kind text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, compliance AS $$
  SELECT lower(p.rule->>'freezeGuard') FROM signer.policies p
  WHERE p.kind = p_kind AND p.approved_at IS NOT NULL AND p.retired_at IS NULL
$$;

/** Internal: marks open requests older than 24 hours as expired (audited). */
CREATE FUNCTION compliance.expire_freeze_requests(p_actor text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, compliance AS $$
DECLARE
  r compliance.freeze_requests;
  n integer := 0;
BEGIN
  FOR r IN SELECT * FROM compliance.freeze_requests WHERE status = 'open' AND expires_at < clock_timestamp() ORDER BY id FOR UPDATE LOOP
    UPDATE compliance.freeze_requests SET status = 'expired', decided_at = clock_timestamp() WHERE id = r.id;
    PERFORM compliance.audit_append(p_actor, 'freeze.expired', jsonb_build_object('request', r.id, 'kind', r.kind, 'wallet', r.wallet));
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;

/** C-3 maker: proposes to freeze or unfreeze a bound investor wallet. */
CREATE FUNCTION compliance.request_freeze(p_kind text, p_wallet text, p_reason_code text, p_reason text, p_actor text,
                                          p_kyc_case bigint, p_str_case bigint)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, compliance AS $$
DECLARE
  v_wallet text := lower(btrim(p_wallet));
  v_subject uuid;
  h compliance.holds;
  v_id bigint;
  v_now timestamptz := date_trunc('microseconds', clock_timestamp());
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('freeze', 'unfreeze') THEN
    RAISE EXCEPTION 'kind must be freeze or unfreeze' USING ERRCODE = 'check_violation';
  END IF;
  IF v_wallet IS NULL OR length(v_wallet) <> 42 OR v_wallet !~ '^0x[0-9a-f]+$' THEN
    RAISE EXCEPTION 'a wallet address (0x + 40 hex digits) is required' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM compliance.reason_codes WHERE code = p_reason_code AND applies_to = p_kind) THEN
    RAISE EXCEPTION 'reason code % is not a % reason', coalesce(p_reason_code, '(none)'), p_kind USING ERRCODE = 'check_violation';
  END IF;
  IF p_actor IS NULL OR length(p_actor) NOT BETWEEN 2 AND 100 OR NOT compliance.free_text_ok(p_reason, 10, 500) THEN
    RAISE EXCEPTION 'a reason of 10 to 500 characters is required (never a CNIC, IBAN or phone number)' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(586586191);
  PERFORM compliance.expire_freeze_requests(p_actor);
  SELECT subject_id INTO v_subject FROM kyc.wallets WHERE wallet = v_wallet;
  IF NOT FOUND THEN RAISE EXCEPTION 'no investor wallet is bound to this address' USING ERRCODE = 'no_data_found'; END IF;
  IF p_kyc_case IS NOT NULL AND NOT EXISTS (SELECT 1 FROM compliance.kyc_cases WHERE id = p_kyc_case AND subject_id = v_subject) THEN
    RAISE EXCEPTION 'KYC case % is not a case of this investor', p_kyc_case USING ERRCODE = 'check_violation';
  END IF;
  IF p_str_case IS NOT NULL AND NOT EXISTS (SELECT 1 FROM compliance.str_cases WHERE id = p_str_case) THEN
    RAISE EXCEPTION 'unknown STR case %', p_str_case USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM compliance.freeze_requests WHERE wallet = v_wallet AND status = 'open') THEN
    RAISE EXCEPTION 'an open freeze or unfreeze request exists for this wallet: decide it first' USING ERRCODE = 'unique_violation';
  END IF;
  SELECT * INTO h FROM compliance.holds WHERE wallet = v_wallet AND lifted_at IS NULL;
  IF p_kind = 'freeze' AND h.id IS NOT NULL THEN
    RAISE EXCEPTION 'the wallet is already held by the approved freeze request %', h.freeze_request_id USING ERRCODE = 'unique_violation';
  END IF;
  IF p_kind = 'unfreeze' AND h.id IS NULL THEN
    RAISE EXCEPTION 'the wallet has no active compliance freeze to lift' USING ERRCODE = 'check_violation';
  END IF;
  v_id := nextval(pg_get_serial_sequence('compliance.freeze_requests', 'id'));
  INSERT INTO compliance.freeze_requests (id, kind, subject_id, wallet, reason_code, reason, kyc_case_id, str_case_id, lifts_request_id, case_ref,
                                          requested_by, requested_at, expires_at)
  OVERRIDING SYSTEM VALUE
  VALUES (v_id, p_kind, v_subject, v_wallet, p_reason_code, btrim(p_reason), p_kyc_case, p_str_case,
          CASE WHEN p_kind = 'unfreeze' THEN h.freeze_request_id END,
          sha256(convert_to('pt-compliance-freeze-v1:' || v_id || ':' || p_kind, 'UTF8')),
          p_actor, v_now, v_now + interval '24 hours');
  PERFORM compliance.audit_append(p_actor, 'freeze.requested', jsonb_build_object('request', v_id, 'kind', p_kind, 'subject', v_subject,
    'wallet', v_wallet, 'reasonCode', p_reason_code, 'reason', btrim(p_reason), 'kycCase', p_kyc_case, 'strCase', p_str_case,
    'lifts', CASE WHEN p_kind = 'unfreeze' THEN h.freeze_request_id END));
  RETURN v_id;
END $$;

/**
 * C-3 checker: a different officer approves or rejects. An approved freeze places the hold and
 * enqueues compliance.freeze; an approved unfreeze lifts it and enqueues compliance.unfreeze; both
 * in this transaction (outbox O-1), so the decision and the command exist together or not at all.
 */
CREATE FUNCTION compliance.decide_freeze(p_request bigint, p_actor text, p_decision text, p_reason text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, compliance AS $$
DECLARE
  q compliance.freeze_requests;
  h compliance.holds;
  v_guard text;
  v_under text;
  v_key text;
BEGIN
  IF p_decision IS NULL OR p_decision NOT IN ('approve', 'reject') THEN
    RAISE EXCEPTION 'decision must be approve or reject' USING ERRCODE = 'check_violation';
  END IF;
  IF p_actor IS NULL OR length(p_actor) NOT BETWEEN 2 AND 100 OR NOT compliance.free_text_ok(p_reason, 10, 500) THEN
    RAISE EXCEPTION 'a reason of 10 to 500 characters is required (never a CNIC, IBAN or phone number)' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(586586191);
  SELECT * INTO q FROM compliance.freeze_requests WHERE id = p_request FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown freeze request' USING ERRCODE = 'no_data_found'; END IF;
  IF q.status <> 'open' THEN RAISE EXCEPTION 'the request is already %', q.status USING ERRCODE = 'check_violation'; END IF;
  IF q.requested_by = p_actor THEN
    RAISE EXCEPTION 'maker-checker: the officer who proposed the % cannot decide it', q.kind USING ERRCODE = 'check_violation';
  END IF;
  IF q.expires_at < clock_timestamp() THEN
    PERFORM compliance.expire_freeze_requests(p_actor);
    RETURN 'expired';
  END IF;
  IF p_decision = 'reject' THEN
    UPDATE compliance.freeze_requests SET status = 'rejected', decided_by = p_actor, decision_reason = btrim(p_reason), decided_at = clock_timestamp()
    WHERE id = q.id;
    PERFORM compliance.audit_append(p_actor, 'freeze.decided', jsonb_build_object('request', q.id, 'kind', q.kind, 'decision', 'reject',
      'requestedBy', q.requested_by, 'reason', btrim(p_reason)));
    RETURN 'rejected';
  END IF;

  IF q.kind = 'freeze' THEN
    v_guard := compliance.freeze_guard('compliance.freeze');
    IF v_guard IS NULL THEN
      RAISE EXCEPTION 'no active compliance.freeze signing policy: the freeze could not be executed' USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM compliance.holds WHERE wallet = q.wallet AND lifted_at IS NULL) THEN
      RAISE EXCEPTION 'the wallet is already held' USING ERRCODE = 'unique_violation';
    END IF;
    INSERT INTO compliance.holds (subject_id, wallet, freeze_request_id) VALUES (q.subject_id, q.wallet, q.id);
  ELSE
    SELECT * INTO h FROM compliance.holds WHERE freeze_request_id = q.lifts_request_id AND lifted_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'the freeze was already lifted' USING ERRCODE = 'check_violation'; END IF;
    v_under := kyc.underlying_status(q.subject_id);
    IF v_under <> 'verified' THEN
      RAISE EXCEPTION 'the investor is not KYC-verified (%): the signing service would refuse to unfreeze; settle the KYC first', v_under
        USING ERRCODE = 'check_violation';
    END IF;
    v_guard := compliance.freeze_guard('compliance.unfreeze');
    IF v_guard IS NULL THEN
      RAISE EXCEPTION 'no active compliance.unfreeze signing policy: the unfreeze could not be executed' USING ERRCODE = 'check_violation';
    END IF;
    UPDATE compliance.holds SET lifted_at = clock_timestamp(), lifted_by_request = q.id WHERE id = h.id;
  END IF;
  v_key := format('compliance.%s:request:%s', q.kind, q.id);
  PERFORM outbox.enqueue(v_key, 'compliance.' || q.kind,
    jsonb_build_object('freezeGuard', v_guard, 'account', q.wallet, 'caseId', '0x' || encode(q.case_ref, 'hex')),
    q.subject_id::text, p_actor);
  UPDATE compliance.freeze_requests SET status = 'approved', decided_by = p_actor, decision_reason = btrim(p_reason), decided_at = clock_timestamp(),
         command_key = v_key
  WHERE id = q.id;
  PERFORM compliance.audit_append(p_actor, 'freeze.decided', jsonb_build_object('request', q.id, 'kind', q.kind, 'decision', 'approve',
    'requestedBy', q.requested_by, 'reason', btrim(p_reason), 'command', v_key, 'wallet', q.wallet, 'caseId', '0x' || encode(q.case_ref, 'hex')));
  RETURN 'approved';
END $$;

/** For the signing service (compliance.unfreeze policy): is this unfreeze a two-officer decision? */
CREATE FUNCTION compliance.unfreeze_allowed(p_account text, p_case_id text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, compliance AS $$
  SELECT EXISTS (SELECT 1 FROM compliance.freeze_requests q
                 WHERE q.kind = 'unfreeze' AND q.status = 'approved' AND q.wallet = lower(p_account)
                   AND '0x' || encode(q.case_ref, 'hex') = lower(p_case_id))
     AND NOT EXISTS (SELECT 1 FROM compliance.holds h WHERE h.wallet = lower(p_account) AND h.lifted_at IS NULL)
$$;

-- ================================================================== STR cases (C-4)
CREATE TABLE compliance.str_cases (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subject_id            uuid REFERENCES kyc.subjects (id),
  category              text NOT NULL,
  applies_to            text NOT NULL DEFAULT 'str' CHECK (applies_to = 'str'),
  summary               text NOT NULL CHECK (compliance.free_text_ok(summary, 20, 2000)),
  status                text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'under_review', 'close_proposed', 'closed', 'filed')),
  opened_by             text NOT NULL CHECK (length(opened_by) BETWEEN 2 AND 100),
  opened_at             timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  updated_at            timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  close_proposed_by     text CHECK (length(close_proposed_by) BETWEEN 2 AND 100),
  close_proposed_reason text CHECK (close_proposed_reason IS NULL OR compliance.free_text_ok(close_proposed_reason, 10, 500)),
  closed_by             text CHECK (length(closed_by) BETWEEN 2 AND 100),
  closed_reason         text CHECK (closed_reason IS NULL OR compliance.free_text_ok(closed_reason, 10, 500)),
  filed_by              text CHECK (length(filed_by) BETWEEN 2 AND 100),
  fmu_reference         text CHECK (fmu_reference ~ '^[A-Za-z0-9][A-Za-z0-9/._-]{3,39}$'),
  finished_at           timestamptz,
  FOREIGN KEY (category, applies_to) REFERENCES compliance.reason_codes (code, applies_to),
  CHECK ((status IN ('close_proposed', 'closed')) = (close_proposed_by IS NOT NULL AND close_proposed_reason IS NOT NULL)
         OR (status = 'filed' AND close_proposed_by IS NULL)),
  CHECK ((status = 'closed') = (closed_by IS NOT NULL AND closed_reason IS NOT NULL)),
  CHECK ((status = 'filed') = (filed_by IS NOT NULL AND fmu_reference IS NOT NULL)),
  CHECK ((status IN ('closed', 'filed')) = (finished_at IS NOT NULL)),
  -- C-4: closing without filing needs a second officer, also against a direct UPDATE.
  CHECK (closed_by IS NULL OR closed_by <> close_proposed_by)
);
ALTER TABLE compliance.freeze_requests ADD FOREIGN KEY (str_case_id) REFERENCES compliance.str_cases (id);

CREATE FUNCTION compliance.guard_str_case() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'STR cases are never deleted' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF OLD.status IN ('closed', 'filed') THEN RAISE EXCEPTION 'STR case % is %', OLD.id, OLD.status USING ERRCODE = 'check_violation'; END IF;
  IF (NEW.id, NEW.subject_id, NEW.category, NEW.summary, NEW.opened_by, NEW.opened_at)
     IS DISTINCT FROM (OLD.id, OLD.subject_id, OLD.category, OLD.summary, OLD.opened_by, OLD.opened_at) THEN
    RAISE EXCEPTION 'STR case %: subject, category, summary and opening never change (add a note)', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status <> OLD.status AND (OLD.status || '>' || NEW.status) NOT IN (
       'open>under_review', 'open>close_proposed', 'under_review>close_proposed', 'close_proposed>under_review',
       'close_proposed>closed', 'open>filed', 'under_review>filed') THEN
    RAISE EXCEPTION 'STR case %: % -> % is not a transition of the STR state machine', OLD.id, OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := date_trunc('microseconds', clock_timestamp());
  RETURN NEW;
END $$;
CREATE TRIGGER str_cases_guard BEFORE UPDATE OR DELETE ON compliance.str_cases FOR EACH ROW EXECUTE FUNCTION compliance.guard_str_case();

CREATE TABLE compliance.str_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  case_id     bigint NOT NULL REFERENCES compliance.str_cases (id),
  action      text NOT NULL CHECK (action IN ('opened', 'start_review', 'propose_close', 'confirm_close', 'decline_close', 'mark_filed')),
  from_status text,
  to_status   text NOT NULL,
  actor       text NOT NULL CHECK (length(actor) BETWEEN 2 AND 100),
  reason      text NOT NULL CHECK (compliance.free_text_ok(reason, 2, 2000)),
  at          timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp())
);
CREATE INDEX str_events_case_idx ON compliance.str_events (case_id, id);

CREATE TABLE compliance.str_notes (
  id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  case_id bigint NOT NULL REFERENCES compliance.str_cases (id),
  author  text NOT NULL CHECK (length(author) BETWEEN 2 AND 100),
  body    text NOT NULL CHECK (compliance.free_text_ok(body, 2, 2000)),
  at      timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp())
);
CREATE INDEX str_notes_case_idx ON compliance.str_notes (case_id, id);

-- Exports for the FMU: recorded (with the SHA-256 of the exact file) before the file is handed out.
CREATE TABLE compliance.str_exports (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  case_id     bigint NOT NULL REFERENCES compliance.str_cases (id),
  exported_by text NOT NULL CHECK (length(exported_by) BETWEEN 2 AND 100),
  sha256      bytea NOT NULL CHECK (length(sha256) = 32),
  at          timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp())
);

CREATE FUNCTION compliance.str_case_digest(p_case bigint) RETURNS bytea
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, compliance AS $$
  SELECT sha256(convert_to('pt-str-case-v1' || jsonb_build_array(s.id, s.status, s.category, s.subject_id, s.close_proposed_by,
           compliance.utc(s.updated_at), (SELECT count(*) FROM compliance.str_notes n WHERE n.case_id = s.id),
           (SELECT count(*) FROM compliance.str_exports x WHERE x.case_id = s.id))::text, 'UTF8'))
  FROM compliance.str_cases s WHERE s.id = p_case
$$;

CREATE FUNCTION compliance.open_str(p_subject uuid, p_category text, p_summary text, p_actor text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, compliance AS $$
DECLARE
  v_id bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM compliance.reason_codes WHERE code = p_category AND applies_to = 'str') THEN
    RAISE EXCEPTION 'unknown STR category' USING ERRCODE = 'check_violation';
  END IF;
  IF p_actor IS NULL OR length(p_actor) NOT BETWEEN 2 AND 100 OR NOT compliance.free_text_ok(p_summary, 20, 2000) THEN
    RAISE EXCEPTION 'a summary of 20 to 2000 characters is required (never a CNIC, IBAN or phone number)' USING ERRCODE = 'check_violation';
  END IF;
  IF p_subject IS NOT NULL AND NOT EXISTS (SELECT 1 FROM kyc.subjects WHERE id = p_subject) THEN
    RAISE EXCEPTION 'unknown subject' USING ERRCODE = 'no_data_found';
  END IF;
  INSERT INTO compliance.str_cases (subject_id, category, summary, opened_by) VALUES (p_subject, p_category, btrim(p_summary), p_actor)
  RETURNING id INTO v_id;
  INSERT INTO compliance.str_events (case_id, action, from_status, to_status, actor, reason) VALUES (v_id, 'opened', NULL, 'open', p_actor, btrim(p_summary));
  PERFORM compliance.audit_append(p_actor, 'str.opened', jsonb_build_object('case', v_id, 'subject', p_subject, 'category', p_category));
  RETURN v_id;
END $$;

/** Notes are append-only; allowed in every state (later information is kept with the case). */
CREATE FUNCTION compliance.add_str_note(p_case bigint, p_actor text, p_body text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, compliance AS $$
DECLARE
  v_id bigint;
BEGIN
  IF p_actor IS NULL OR length(p_actor) NOT BETWEEN 2 AND 100 OR NOT compliance.free_text_ok(p_body, 2, 2000) THEN
    RAISE EXCEPTION 'a note of 2 to 2000 characters is required (never a CNIC, IBAN or phone number)' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM 1 FROM compliance.str_cases WHERE id = p_case FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown STR case' USING ERRCODE = 'no_data_found'; END IF;
  INSERT INTO compliance.str_notes (case_id, author, body) VALUES (p_case, p_actor, btrim(p_body)) RETURNING id INTO v_id;
  PERFORM compliance.audit_append(p_actor, 'str.noted', jsonb_build_object('case', p_case, 'note', v_id,
    'bodySha256', encode(sha256(convert_to(btrim(p_body), 'UTF8')), 'hex')));
  RETURN v_id;
END $$;

/** Records an FMU export BEFORE the file is handed out. */
CREATE FUNCTION compliance.record_str_export(p_case bigint, p_actor text, p_sha256 bytea)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, compliance AS $$
DECLARE
  v_id bigint;
BEGIN
  IF p_sha256 IS NULL OR length(p_sha256) <> 32 OR p_actor IS NULL THEN
    RAISE EXCEPTION 'the SHA-256 of the export and an actor are required' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM compliance.str_cases WHERE id = p_case) THEN RAISE EXCEPTION 'unknown STR case' USING ERRCODE = 'no_data_found'; END IF;
  INSERT INTO compliance.str_exports (case_id, exported_by, sha256) VALUES (p_case, p_actor, p_sha256) RETURNING id INTO v_id;
  PERFORM compliance.audit_append(p_actor, 'str.exported', jsonb_build_object('case', p_case, 'export', v_id, 'sha256', encode(p_sha256, 'hex')));
  RETURN v_id;
END $$;

/** C-4: one officer action on an STR case; returns the new status. */
CREATE FUNCTION compliance.str_act(p_case bigint, p_actor text, p_action text, p_reason text, p_fmu_reference text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, compliance AS $$
DECLARE
  s compliance.str_cases;
  v_to text;
  v_reason text := btrim(p_reason);
BEGIN
  IF p_action IS NULL OR p_action NOT IN ('start_review', 'propose_close', 'confirm_close', 'decline_close', 'mark_filed') THEN
    RAISE EXCEPTION 'unknown action' USING ERRCODE = 'check_violation';
  END IF;
  IF p_actor IS NULL OR length(p_actor) NOT BETWEEN 2 AND 100 OR NOT compliance.free_text_ok(p_reason, 10, 500) THEN
    RAISE EXCEPTION 'a reason of 10 to 500 characters is required (never a CNIC, IBAN or phone number)' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO s FROM compliance.str_cases WHERE id = p_case FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown STR case' USING ERRCODE = 'no_data_found'; END IF;
  IF s.status IN ('closed', 'filed') THEN RAISE EXCEPTION 'the STR case is %', s.status USING ERRCODE = 'check_violation'; END IF;

  IF p_action = 'start_review' THEN
    IF s.status <> 'open' THEN RAISE EXCEPTION 'the review has already started' USING ERRCODE = 'check_violation'; END IF;
    v_to := 'under_review';
    UPDATE compliance.str_cases SET status = v_to WHERE id = s.id;
  ELSIF p_action = 'propose_close' THEN
    IF s.status NOT IN ('open', 'under_review') THEN RAISE EXCEPTION 'closing is already proposed' USING ERRCODE = 'check_violation'; END IF;
    v_to := 'close_proposed';
    UPDATE compliance.str_cases SET status = v_to, close_proposed_by = p_actor, close_proposed_reason = v_reason WHERE id = s.id;
  ELSIF p_action IN ('confirm_close', 'decline_close') THEN
    IF s.status <> 'close_proposed' THEN RAISE EXCEPTION 'nothing is waiting for a second officer' USING ERRCODE = 'check_violation'; END IF;
    IF s.close_proposed_by = p_actor THEN
      RAISE EXCEPTION 'maker-checker: the officer who proposed closing without a report cannot confirm or decline it' USING ERRCODE = 'check_violation';
    END IF;
    IF p_action = 'confirm_close' THEN
      v_to := 'closed';
      UPDATE compliance.str_cases SET status = v_to, closed_by = p_actor, closed_reason = v_reason, finished_at = clock_timestamp() WHERE id = s.id;
    ELSE
      v_to := 'under_review';
      UPDATE compliance.str_cases SET status = v_to, close_proposed_by = NULL, close_proposed_reason = NULL WHERE id = s.id;
    END IF;
  ELSE
    IF s.status NOT IN ('open', 'under_review') THEN RAISE EXCEPTION 'decline the proposal to close first' USING ERRCODE = 'check_violation'; END IF;
    IF NOT EXISTS (SELECT 1 FROM compliance.str_exports WHERE case_id = s.id) THEN
      RAISE EXCEPTION 'export the case for the FMU first (the export is recorded before it is handed out)' USING ERRCODE = 'check_violation';
    END IF;
    IF p_fmu_reference IS NULL OR btrim(p_fmu_reference) !~ '^[A-Za-z0-9][A-Za-z0-9/._-]{3,39}$' THEN
      RAISE EXCEPTION 'the FMU reference (4 to 40 letters, digits or / . _ -) is required' USING ERRCODE = 'check_violation';
    END IF;
    v_to := 'filed';
    UPDATE compliance.str_cases SET status = v_to, filed_by = p_actor, fmu_reference = btrim(p_fmu_reference), finished_at = clock_timestamp()
    WHERE id = s.id;
  END IF;
  INSERT INTO compliance.str_events (case_id, action, from_status, to_status, actor, reason) VALUES (s.id, p_action, s.status, v_to, p_actor, v_reason);
  PERFORM compliance.audit_append(p_actor, 'str.' || p_action, jsonb_build_object('case', s.id, 'from', s.status, 'to', v_to,
    'proposedBy', s.close_proposed_by, 'fmuReference', CASE WHEN p_action = 'mark_filed' THEN btrim(p_fmu_reference) END));
  RETURN v_to;
END $$;

-- ================================================================== re-screening queue (C-5)
CREATE TABLE compliance.rescreens (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subject_id    uuid NOT NULL REFERENCES kyc.subjects (id),
  requested_by  text NOT NULL CHECK (length(requested_by) BETWEEN 2 AND 100),
  reason        text NOT NULL CHECK (compliance.free_text_ok(reason, 10, 500)),
  requested_at  timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  status        text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  claimed_by    text CHECK (length(claimed_by) BETWEEN 2 AND 100),
  claimed_at    timestamptz,
  finished_at   timestamptz,
  result_status text CHECK (result_status ~ '^[a-z]{3,20}$'),
  check_id      bigint REFERENCES kyc.checks (id),
  error         text CHECK (error ~ '^[A-Za-z0-9_ .:-]{1,80}$'),
  CHECK ((status = 'queued') = (claimed_at IS NULL)),
  CHECK ((status IN ('done', 'failed')) = (finished_at IS NOT NULL)),
  CHECK (status <> 'done' OR result_status IS NOT NULL),
  CHECK (status <> 'failed' OR error IS NOT NULL)
);
CREATE UNIQUE INDEX rescreens_one_live ON compliance.rescreens (subject_id) WHERE status IN ('queued', 'running');

CREATE FUNCTION compliance.guard_rescreen() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'rescreen requests are never deleted' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF (NEW.id, NEW.subject_id, NEW.requested_by, NEW.reason, NEW.requested_at) IS DISTINCT FROM (OLD.id, OLD.subject_id, OLD.requested_by, OLD.reason, OLD.requested_at)
     OR OLD.status IN ('done', 'failed')
     OR (NEW.status <> OLD.status AND (OLD.status || '>' || NEW.status) NOT IN ('queued>running', 'running>done', 'running>failed', 'running>queued')) THEN
    RAISE EXCEPTION 'rescreen %: only queued > running > done | failed', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rescreens_guard BEFORE UPDATE OR DELETE ON compliance.rescreens FOR EACH ROW EXECUTE FUNCTION compliance.guard_rescreen();

CREATE FUNCTION compliance.request_rescreen(p_subject uuid, p_actor text, p_reason text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, compliance AS $$
DECLARE
  v_id bigint;
BEGIN
  IF p_actor IS NULL OR length(p_actor) NOT BETWEEN 2 AND 100 OR NOT compliance.free_text_ok(p_reason, 10, 500) THEN
    RAISE EXCEPTION 'a reason of 10 to 500 characters is required (never a CNIC, IBAN or phone number)' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM kyc.subjects WHERE id = p_subject) THEN RAISE EXCEPTION 'unknown subject' USING ERRCODE = 'no_data_found'; END IF;
  IF EXISTS (SELECT 1 FROM compliance.rescreens WHERE subject_id = p_subject AND status IN ('queued', 'running')) THEN
    RAISE EXCEPTION 'a re-screening of this investor is already queued' USING ERRCODE = 'unique_violation';
  END IF;
  INSERT INTO compliance.rescreens (subject_id, requested_by, reason) VALUES (p_subject, p_actor, btrim(p_reason)) RETURNING id INTO v_id;
  PERFORM compliance.audit_append(p_actor, 'rescreen.requested', jsonb_build_object('rescreen', v_id, 'subject', p_subject));
  PERFORM pg_notify('compliance_rescreen', v_id::text);
  RETURN v_id;
END $$;

/** KYC service: claims queued re-screenings (and ones stuck running for 10 minutes). */
CREATE FUNCTION compliance.claim_rescreens(p_worker text, p_limit integer)
RETURNS TABLE (id bigint, subject_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, compliance AS $$
#variable_conflict use_column
BEGIN
  IF p_worker IS NULL OR length(p_worker) NOT BETWEEN 2 AND 100 THEN
    RAISE EXCEPTION 'a worker name is required' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE compliance.rescreens SET status = 'queued', claimed_by = NULL, claimed_at = NULL
  WHERE status = 'running' AND claimed_at < clock_timestamp() - interval '10 minutes';
  RETURN QUERY
  UPDATE compliance.rescreens r SET status = 'running', claimed_by = p_worker, claimed_at = clock_timestamp()
  WHERE r.id IN (SELECT x.id FROM compliance.rescreens x WHERE x.status = 'queued' ORDER BY x.id
                 LIMIT least(greatest(coalesce(p_limit, 10), 1), 100) FOR UPDATE SKIP LOCKED)
  RETURNING r.id, r.subject_id;
END $$;

CREATE FUNCTION compliance.complete_rescreen(p_id bigint, p_worker text, p_result_status text, p_check bigint, p_error text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, compliance AS $$
DECLARE
  r compliance.rescreens;
BEGIN
  SELECT * INTO r FROM compliance.rescreens WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR r.status <> 'running' OR r.claimed_by IS DISTINCT FROM p_worker THEN
    RAISE EXCEPTION 'rescreen % is not running for %', p_id, p_worker USING ERRCODE = 'check_violation';
  END IF;
  IF p_check IS NOT NULL AND NOT EXISTS (SELECT 1 FROM kyc.checks WHERE id = p_check AND subject_id = r.subject_id AND kind = 'sanctions') THEN
    RAISE EXCEPTION 'check % is not a sanctions screening of this subject', p_check USING ERRCODE = 'check_violation';
  END IF;
  IF p_error IS NULL THEN
    p_check := coalesce(p_check, (SELECT max(c.id) FROM kyc.checks c WHERE c.subject_id = r.subject_id AND c.kind = 'sanctions'));
    UPDATE compliance.rescreens SET status = 'done', finished_at = clock_timestamp(), result_status = p_result_status, check_id = p_check WHERE id = p_id;
  ELSE
    UPDATE compliance.rescreens SET status = 'failed', finished_at = clock_timestamp(), error = left(p_error, 80) WHERE id = p_id;
  END IF;
  PERFORM compliance.audit_append(p_worker, 'rescreen.' || CASE WHEN p_error IS NULL THEN 'done' ELSE 'failed' END,
    jsonb_build_object('rescreen', p_id, 'subject', r.subject_id, 'status', p_result_status, 'check', p_check, 'error', left(p_error, 80)));
END $$;

-- ================================================================== append-only (C-7)
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON compliance.audit FOR EACH ROW EXECUTE FUNCTION compliance.forbid_change();
CREATE TRIGGER reason_codes_append_only BEFORE UPDATE OR DELETE ON compliance.reason_codes FOR EACH ROW EXECUTE FUNCTION compliance.forbid_change();
CREATE TRIGGER kyc_case_events_append_only BEFORE UPDATE OR DELETE ON compliance.kyc_case_events FOR EACH ROW EXECUTE FUNCTION compliance.forbid_change();
CREATE TRIGGER str_events_append_only BEFORE UPDATE OR DELETE ON compliance.str_events FOR EACH ROW EXECUTE FUNCTION compliance.forbid_change();
CREATE TRIGGER str_notes_append_only BEFORE UPDATE OR DELETE ON compliance.str_notes FOR EACH ROW EXECUTE FUNCTION compliance.forbid_change();
CREATE TRIGGER str_exports_append_only BEFORE UPDATE OR DELETE ON compliance.str_exports FOR EACH ROW EXECUTE FUNCTION compliance.forbid_change();
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['audit', 'reason_codes', 'kyc_cases', 'kyc_case_events', 'freeze_requests', 'holds', 'str_cases', 'str_events',
                           'str_notes', 'str_exports', 'rescreens'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON compliance.%I FOR EACH STATEMENT EXECUTE FUNCTION compliance.forbid_change()', t || '_no_truncate', t);
  END LOOP;
END $$;

-- ================================================================== officer names bound to sessions (C-7, as 0016 A-3)
/** Trigger: the column named in TG_ARGV[0] (and TG_ARGV[1] on UPDATE, when it changes) may hold an officer's handle only inside the portal. */
CREATE FUNCTION compliance.bind_actor() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, compliance AS $$
DECLARE
  v_new jsonb := to_jsonb(NEW);
  v_old jsonb;
  i integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM admin.guard_officer_name(v_new->>TG_ARGV[0], TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME || ' by');
  ELSE
    v_old := to_jsonb(OLD);
    FOR i IN 1 .. TG_NARGS - 1 LOOP
      IF (v_new->>TG_ARGV[i]) IS DISTINCT FROM (v_old->>TG_ARGV[i]) THEN
        PERFORM admin.guard_officer_name(v_new->>TG_ARGV[i], TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME || ' by');
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER kyc_cases_officer_binding BEFORE INSERT OR UPDATE ON compliance.kyc_cases
  FOR EACH ROW EXECUTE FUNCTION compliance.bind_actor('opened_by', 'proposed_by', 'decided_by');
CREATE TRIGGER kyc_case_events_officer_binding BEFORE INSERT ON compliance.kyc_case_events FOR EACH ROW EXECUTE FUNCTION compliance.bind_actor('actor');
CREATE TRIGGER freeze_requests_officer_binding BEFORE INSERT OR UPDATE ON compliance.freeze_requests
  FOR EACH ROW EXECUTE FUNCTION compliance.bind_actor('requested_by', 'decided_by');
CREATE TRIGGER str_cases_officer_binding BEFORE INSERT OR UPDATE ON compliance.str_cases
  FOR EACH ROW EXECUTE FUNCTION compliance.bind_actor('opened_by', 'close_proposed_by', 'closed_by', 'filed_by');
CREATE TRIGGER str_events_officer_binding BEFORE INSERT ON compliance.str_events FOR EACH ROW EXECUTE FUNCTION compliance.bind_actor('actor');
CREATE TRIGGER str_notes_officer_binding BEFORE INSERT ON compliance.str_notes FOR EACH ROW EXECUTE FUNCTION compliance.bind_actor('author');
CREATE TRIGGER str_exports_officer_binding BEFORE INSERT ON compliance.str_exports FOR EACH ROW EXECUTE FUNCTION compliance.bind_actor('exported_by');
CREATE TRIGGER rescreens_officer_binding BEFORE INSERT ON compliance.rescreens FOR EACH ROW EXECUTE FUNCTION compliance.bind_actor('requested_by');
-- ADR 0011 consequence 2: the KYC officer names (Y-4 clearances, revocations) are bound as well.
CREATE TRIGGER clearances_officer_binding BEFORE INSERT OR UPDATE ON kyc.clearances
  FOR EACH ROW EXECUTE FUNCTION compliance.bind_actor('requested_by', 'decided_by');
CREATE TRIGGER decisions_officer_binding BEFORE INSERT ON kyc.decisions FOR EACH ROW EXECUTE FUNCTION compliance.bind_actor('decided_by');

-- ================================================================== verification (C-7)
CREATE FUNCTION compliance.verify_audit() RETURNS TABLE (audit_id bigint, problem text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, compliance AS $$
DECLARE
  a compliance.audit;
  v_prev bytea := decode(repeat('00', 32), 'hex');
  r record;
BEGIN
  FOR a IN SELECT * FROM compliance.audit ORDER BY id LOOP
    IF a.prev_hash <> v_prev THEN audit_id := a.id; problem := 'prev_hash does not match'; RETURN NEXT; END IF;
    IF a.hash <> compliance.audit_digest(a.prev_hash, a.id, a.at, a.actor, a.action, a.detail) THEN
      audit_id := a.id; problem := 'content does not match its hash'; RETURN NEXT;
    END IF;
    v_prev := a.hash;
  END LOOP;
  FOR r IN
    SELECT format('KYC case %s', k.id) AS what FROM compliance.kyc_cases k WHERE NOT EXISTS (
      SELECT 1 FROM compliance.audit x WHERE x.action = 'kyc_case.opened' AND (x.detail->>'case')::bigint = k.id AND x.detail->>'subject' = k.subject_id::text)
    UNION ALL
    SELECT format('KYC case %s: status %s differs from its last event', k.id, k.status) FROM compliance.kyc_cases k
      WHERE k.status IS DISTINCT FROM (SELECT e.to_status FROM compliance.kyc_case_events e WHERE e.case_id = k.id ORDER BY e.id DESC LIMIT 1)
    UNION ALL
    SELECT format('KYC case event %s', e.id) FROM compliance.kyc_case_events e WHERE e.action <> 'opened' AND NOT EXISTS (
      SELECT 1 FROM compliance.audit x WHERE x.action = 'kyc_case.' || e.action AND (x.detail->>'case')::bigint = e.case_id AND x.detail->>'to' = e.to_status)
    UNION ALL
    SELECT format('freeze request %s', q.id) FROM compliance.freeze_requests q WHERE NOT EXISTS (
      SELECT 1 FROM compliance.audit x WHERE x.action = 'freeze.requested' AND (x.detail->>'request')::bigint = q.id AND x.detail->>'wallet' = q.wallet)
      OR (q.status IN ('approved', 'rejected') AND NOT EXISTS (
      SELECT 1 FROM compliance.audit x WHERE x.action = 'freeze.decided' AND (x.detail->>'request')::bigint = q.id
        AND x.detail->>'decision' = CASE q.status WHEN 'approved' THEN 'approve' ELSE 'reject' END))
    UNION ALL
    SELECT format('hold %s', h.id) FROM compliance.holds h WHERE NOT EXISTS (
      SELECT 1 FROM compliance.freeze_requests q WHERE q.id = h.freeze_request_id AND q.kind = 'freeze' AND q.status = 'approved' AND q.wallet = h.wallet)
      OR (h.lifted_at IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM compliance.freeze_requests q WHERE q.id = h.lifted_by_request AND q.kind = 'unfreeze' AND q.status = 'approved' AND q.wallet = h.wallet))
    UNION ALL
    SELECT format('STR case %s', s.id) FROM compliance.str_cases s WHERE NOT EXISTS (
      SELECT 1 FROM compliance.audit x WHERE x.action = 'str.opened' AND (x.detail->>'case')::bigint = s.id)
      OR s.status IS DISTINCT FROM (SELECT e.to_status FROM compliance.str_events e WHERE e.case_id = s.id ORDER BY e.id DESC LIMIT 1)
    UNION ALL
    SELECT format('STR note %s', n.id) FROM compliance.str_notes n WHERE NOT EXISTS (
      SELECT 1 FROM compliance.audit x WHERE x.action = 'str.noted' AND (x.detail->>'note')::bigint = n.id
        AND x.detail->>'bodySha256' = encode(sha256(convert_to(n.body, 'UTF8')), 'hex'))
    UNION ALL
    SELECT format('STR export %s', x0.id) FROM compliance.str_exports x0 WHERE NOT EXISTS (
      SELECT 1 FROM compliance.audit x WHERE x.action = 'str.exported' AND (x.detail->>'export')::bigint = x0.id AND x.detail->>'sha256' = encode(x0.sha256, 'hex'))
    UNION ALL
    SELECT format('rescreen %s', r0.id) FROM compliance.rescreens r0 WHERE NOT EXISTS (
      SELECT 1 FROM compliance.audit x WHERE x.action = 'rescreen.requested' AND (x.detail->>'rescreen')::bigint = r0.id)
  LOOP
    audit_id := NULL; problem := r.what || ' has no matching audit entry or event'; RETURN NEXT;
  END LOOP;
END $$;

-- ================================================================== backfill
-- Subjects already in review before this migration get their screening case now.
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN SELECT x.* FROM kyc.checks x
           WHERE x.kind = 'sanctions' AND x.outcome = 'review'
             AND x.id = (SELECT max(y.id) FROM kyc.checks y WHERE y.subject_id = x.subject_id AND y.kind = 'sanctions' AND y.outcome <> 'error')
             AND NOT EXISTS (SELECT 1 FROM kyc.clearances z WHERE z.check_id = x.id AND z.status = 'approved')
           ORDER BY x.id LOOP
    PERFORM compliance.insert_kyc_case(c.subject_id, 'screening_match', c.id, 'high', ARRAY['sanctions_possible_match'],
      format('Possible sanctions list match from %s (score %s, list %s): two compliance officers decide', c.provider,
             coalesce(c.score::text, '?'), coalesce(c.list_version, '?')), 'migration:0019');
  END LOOP;
END $$;

-- ================================================================== portal (admin.*): permissions (C-8)
INSERT INTO admin.role_permissions (role, permission) VALUES
  ('compliance_officer', 'compliance.decide'),
  ('compliance_officer', 'compliance.export');

DO $$
BEGIN
  EXECUTE format('CREATE OR REPLACE FUNCTION admin.expected_role_matrix_digest() RETURNS text LANGUAGE sql IMMUTABLE AS %L',
                 format('SELECT %L::text', admin.role_matrix_digest()));
END $$;

/** CNIC shown only as its last four digits: *****-****567-1. */
CREATE FUNCTION admin.mask_cnic(p_last4 text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT CASE WHEN p_last4 ~ '^[0-9]{4}$' THEN '*****-****' || substr(p_last4, 1, 3) || '-' || substr(p_last4, 4, 1) ELSE '*****-*******-*' END
$$;

/** What the portal shows of an investor: no name, no CNIC beyond the last four digits. */
CREATE FUNCTION admin.subject_json(p_subject uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
  SELECT jsonb_build_object('id', s.id, 'ref', left(replace(s.id::text, '-', ''), 8), 'cnic', admin.mask_cnic(s.cnic_last4),
    'status', kyc.subject_status(s.id), 'underlyingStatus', kyc.underlying_status(s.id), 'wallet', w.wallet,
    'decisionReason', (SELECT d.reason FROM kyc.decisions d WHERE d.subject_id = s.id ORDER BY d.id DESC LIMIT 1),
    'validUntil', (SELECT admin.utc(d.valid_until) FROM kyc.decisions d WHERE d.subject_id = s.id ORDER BY d.id DESC LIMIT 1),
    'since', admin.utc(s.created_at),
    'hold', (SELECT jsonb_build_object('id', h.id, 'freezeRequest', h.freeze_request_id, 'placedAt', admin.utc(h.placed_at))
             FROM compliance.holds h WHERE h.subject_id = s.id AND h.lifted_at IS NULL LIMIT 1))
  FROM kyc.subjects s LEFT JOIN kyc.wallets w ON w.subject_id = s.id
  WHERE s.id = p_subject
$$;

/** The outbox command behind a decision (status only; the payload is the decision's own data). */
CREATE FUNCTION admin.command_json(p_key text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
  SELECT jsonb_build_object('id', c.id, 'kind', c.kind, 'status', c.status, 'attempts', c.attempts, 'txHash', c.tx_hash,
                            'lastError', left(c.last_error, 200), 'createdAt', admin.utc(c.created_at))
  FROM outbox.commands c WHERE c.idempotency_key = p_key
$$;

-- ------------------------------------------------------------------ reads (compliance.read)
CREATE FUNCTION admin.compliance_dashboard(p_session bytea) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'compliance.read');
BEGIN
  RETURN jsonb_build_object(
    'at', admin.utc(clock_timestamp()),
    'kycStatus', coalesce((SELECT jsonb_object_agg(st, n) FROM (SELECT kyc.subject_status(s.id) AS st, count(*) AS n FROM kyc.subjects s GROUP BY 1) q), '{}'::jsonb),
    'kycCases', coalesce((SELECT jsonb_object_agg(status, n) FROM (SELECT status, count(*) AS n FROM compliance.kyc_cases GROUP BY 1) q), '{}'::jsonb),
    'highRiskOpen', (SELECT count(*) FROM compliance.kyc_cases WHERE risk = 'high' AND status IN ('open', 'info_requested', 'pending_second')),
    'freezes', coalesce((SELECT jsonb_object_agg(status, n) FROM (SELECT status, count(*) AS n FROM compliance.freeze_requests GROUP BY 1) q), '{}'::jsonb),
    'activeHolds', (SELECT count(*) FROM compliance.holds WHERE lifted_at IS NULL),
    'str', coalesce((SELECT jsonb_object_agg(status, n) FROM (SELECT status, count(*) AS n FROM compliance.str_cases GROUP BY 1) q), '{}'::jsonb),
    'rescreens', coalesce((SELECT jsonb_object_agg(status, n) FROM (SELECT status, count(*) AS n FROM compliance.rescreens GROUP BY 1) q), '{}'::jsonb),
    'breaches', coalesce((SELECT jsonb_agg(b ORDER BY (b->>'overdueSeconds')::numeric DESC) FROM (
        SELECT jsonb_build_object('kind', 'kyc', 'id', k.id, 'state', k.status, 'risk', k.risk, 'since', admin.utc(k.updated_at),
               'sla', compliance.sla('kyc.' || k.status)::text,
               'overdueSeconds', round(extract(epoch FROM clock_timestamp() - k.updated_at - compliance.sla('kyc.' || k.status)))) AS b
        FROM compliance.kyc_cases k
        WHERE k.status IN ('open', 'info_requested', 'pending_second') AND clock_timestamp() - k.updated_at > compliance.sla('kyc.' || k.status)
        UNION ALL
        SELECT jsonb_build_object('kind', 'freeze', 'id', q.id, 'state', q.kind || ' ' || q.status, 'risk', 'high', 'since', admin.utc(q.requested_at),
               'sla', compliance.sla('freeze.open')::text,
               'overdueSeconds', round(extract(epoch FROM clock_timestamp() - q.requested_at - compliance.sla('freeze.open'))))
        FROM compliance.freeze_requests q WHERE q.status = 'open' AND clock_timestamp() - q.requested_at > compliance.sla('freeze.open')
        UNION ALL
        SELECT jsonb_build_object('kind', 'str', 'id', s.id, 'state', s.status, 'risk', 'high', 'since', admin.utc(s.updated_at),
               'sla', compliance.sla('str.' || s.status)::text,
               'overdueSeconds', round(extract(epoch FROM clock_timestamp() - s.updated_at - compliance.sla('str.' || s.status))))
        FROM compliance.str_cases s
        WHERE s.status IN ('open', 'under_review', 'close_proposed') AND clock_timestamp() - s.updated_at > compliance.sla('str.' || s.status)
        UNION ALL
        SELECT jsonb_build_object('kind', 'rescreen', 'id', r.id, 'state', r.status, 'risk', 'standard', 'since', admin.utc(r.requested_at),
               'sla', compliance.sla('rescreen.queued')::text,
               'overdueSeconds', round(extract(epoch FROM clock_timestamp() - r.requested_at - compliance.sla('rescreen.queued'))))
        FROM compliance.rescreens r WHERE r.status IN ('queued', 'running') AND clock_timestamp() - r.requested_at > compliance.sla('rescreen.queued')
      ) z), '[]'::jsonb),
    'oldestOpen', jsonb_build_object(
      'kyc', (SELECT admin.utc(min(updated_at)) FROM compliance.kyc_cases WHERE status IN ('open', 'info_requested', 'pending_second')),
      'freeze', (SELECT admin.utc(min(requested_at)) FROM compliance.freeze_requests WHERE status = 'open'),
      'str', (SELECT admin.utc(min(updated_at)) FROM compliance.str_cases WHERE status IN ('open', 'under_review', 'close_proposed'))),
    'recent', coalesce((SELECT jsonb_agg(r.x ORDER BY r.x->>'at' DESC) FROM (SELECT u.x FROM (
        (SELECT jsonb_build_object('kind', 'kyc', 'id', e.case_id, 'action', e.action, 'to', e.to_status, 'actor', e.actor, 'at', admin.utc(e.at)) AS x
         FROM compliance.kyc_case_events e WHERE e.action IN ('approve', 'reject', 'confirm', 'decline', 'request_info', 'escalate')
         ORDER BY e.id DESC LIMIT 15)
        UNION ALL
        (SELECT jsonb_build_object('kind', q.kind, 'id', q.id, 'action', CASE q.status WHEN 'approved' THEN 'approve' ELSE 'reject' END, 'to', q.status,
                                   'actor', q.decided_by, 'at', admin.utc(q.decided_at))
         FROM compliance.freeze_requests q WHERE q.status IN ('approved', 'rejected') ORDER BY q.decided_at DESC LIMIT 15)
        UNION ALL
        (SELECT jsonb_build_object('kind', 'str', 'id', e.case_id, 'action', e.action, 'to', e.to_status, 'actor', e.actor, 'at', admin.utc(e.at))
         FROM compliance.str_events e WHERE e.action <> 'opened' ORDER BY e.id DESC LIMIT 15)
      ) u ORDER BY u.x->>'at' DESC LIMIT 15) r), '[]'::jsonb));
END $$;

/** The KYC review queue: live cases by default, or one state. */
CREATE FUNCTION admin.kyc_queue(p_session bytea, p_status text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'compliance.read');
  v_handle text := admin.handle_of(v_me);
BEGIN
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object(
      'id', k.id, 'kind', k.kind, 'risk', k.risk, 'flags', to_jsonb(k.flags), 'status', k.status,
      'subject', left(replace(k.subject_id::text, '-', ''), 8), 'cnic', admin.mask_cnic(s.cnic_last4),
      'openedAt', admin.utc(k.opened_at), 'updatedAt', admin.utc(k.updated_at), 'proposal', k.proposal, 'proposedBy', k.proposed_by,
      'waitingForMe', k.status = 'pending_second' AND k.proposed_by IS DISTINCT FROM v_handle,
      'overdue', k.status IN ('open', 'info_requested', 'pending_second') AND clock_timestamp() - k.updated_at > compliance.sla('kyc.' || k.status))
      ORDER BY (k.risk = 'high') DESC, k.updated_at)
    FROM (SELECT * FROM compliance.kyc_cases
          WHERE (p_status IS NULL AND status IN ('open', 'info_requested', 'pending_second')) OR status = p_status
          ORDER BY id DESC LIMIT 500) k
    JOIN kyc.subjects s ON s.id = k.subject_id), '[]'::jsonb);
END $$;

/** Why this officer cannot take each action on a KYC case now (empty list = they can). */
CREATE FUNCTION admin.kyc_case_blockers(p_officer uuid, k compliance.kyc_cases) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_handle text := admin.handle_of(p_officer);
  v_decide boolean := EXISTS (SELECT 1 FROM admin.role_grants g JOIN admin.role_permissions p ON p.role = g.role
                              WHERE g.officer_id = p_officer AND g.revoked_at IS NULL AND p.permission = 'compliance.decide');
  v_closed boolean := k.status IN ('approved', 'rejected', 'superseded');
  v_base text[] := '{}';
  v_newer boolean := k.check_id IS NOT NULL AND EXISTS (SELECT 1 FROM kyc.checks c WHERE c.subject_id = k.subject_id AND c.kind = 'sanctions'
                                                        AND c.outcome <> 'error' AND c.id > k.check_id);
BEGIN
  IF NOT v_decide THEN v_base := v_base || 'Only a compliance officer decides KYC cases; your role reads them.'::text; END IF;
  IF v_closed THEN v_base := v_base || format('The case is %s.', k.status); END IF;
  RETURN jsonb_build_object(
    'request_info', to_jsonb(v_base || CASE WHEN NOT v_closed AND k.status <> 'open' THEN ARRAY[format('Only an open case (this one is %s).', k.status)] ELSE '{}'::text[] END),
    'info_received', to_jsonb(v_base || CASE WHEN NOT v_closed AND k.status <> 'info_requested' THEN ARRAY['No information is outstanding.'] ELSE '{}'::text[] END),
    'escalate', to_jsonb(v_base || CASE WHEN k.risk = 'high' THEN ARRAY['The case is already high risk.']
                                        WHEN NOT v_closed AND k.status = 'pending_second' THEN ARRAY['A decision is already proposed.'] ELSE '{}'::text[] END),
    'approve', to_jsonb(v_base || CASE WHEN NOT v_closed AND k.status <> 'open' THEN ARRAY[format('Only an open case can be decided (this one is %s).', k.status)] ELSE '{}'::text[] END
                               || CASE WHEN k.kind = 'sanctions_hit' THEN ARRAY['A confirmed sanctions list hit is final (rule Y-3): close it as rejected.'] ELSE '{}'::text[] END
                               || CASE WHEN v_newer THEN ARRAY['A newer screening exists: this case is out of date.'] ELSE '{}'::text[] END),
    'reject', to_jsonb(v_base || CASE WHEN NOT v_closed AND k.status <> 'open' THEN ARRAY[format('Only an open case can be decided (this one is %s).', k.status)] ELSE '{}'::text[] END
                              || CASE WHEN v_newer THEN ARRAY['A newer screening exists: this case is out of date.'] ELSE '{}'::text[] END),
    'confirm', to_jsonb(v_base || CASE WHEN NOT v_closed AND k.status <> 'pending_second' THEN ARRAY['Nothing is waiting for a second officer.'] ELSE '{}'::text[] END
                               || CASE WHEN k.status = 'pending_second' AND k.proposed_by = v_handle THEN ARRAY['You proposed it: a different compliance officer confirms (maker-checker).'] ELSE '{}'::text[] END),
    'decline', to_jsonb(v_base || CASE WHEN NOT v_closed AND k.status <> 'pending_second' THEN ARRAY['Nothing is waiting for a second officer.'] ELSE '{}'::text[] END
                               || CASE WHEN k.status = 'pending_second' AND k.proposed_by = v_handle THEN ARRAY['You proposed it: a different compliance officer declines (maker-checker).'] ELSE '{}'::text[] END));
END $$;

/** One KYC case with what a reviewer needs: masked subject, screening results (no evidence), clearances, events. */
CREATE FUNCTION admin.kyc_case(p_session bytea, p_id bigint) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'compliance.read');
  k compliance.kyc_cases;
BEGIN
  SELECT * INTO k FROM compliance.kyc_cases WHERE id = p_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN jsonb_build_object(
    'id', k.id, 'kind', k.kind, 'risk', k.risk, 'flags', to_jsonb(k.flags), 'summary', k.summary, 'status', k.status,
    'twoOfficers', k.kind = 'screening_match' OR k.risk = 'high',
    'proposal', k.proposal, 'proposedBy', k.proposed_by, 'proposalReason', k.proposal_reason, 'proposedAt', admin.utc(k.proposed_at),
    'clearance', (SELECT jsonb_build_object('id', c.id, 'proposal', c.proposal, 'status', c.status, 'requestedBy', c.requested_by,
                                            'expiresAt', admin.utc(c.expires_at), 'decidedBy', c.decided_by)
                  FROM kyc.clearances c WHERE c.id = k.clearance_id),
    'openedBy', k.opened_by, 'openedAt', admin.utc(k.opened_at), 'updatedAt', admin.utc(k.updated_at),
    'decidedBy', k.decided_by, 'decisionReason', k.decision_reason, 'decidedAt', admin.utc(k.decided_at),
    'checkId', k.check_id,
    'digest', encode(compliance.kyc_case_digest(k.id), 'hex'),
    'subject', admin.subject_json(k.subject_id),
    'checks', coalesce((SELECT jsonb_agg(jsonb_build_object('id', c.id, 'kind', c.kind, 'outcome', c.outcome, 'reason', c.reason, 'score', c.score,
                                                            'listVersion', c.list_version, 'provider', c.provider, 'at', admin.utc(c.at))
                                         ORDER BY c.id DESC)
                        FROM (SELECT * FROM kyc.checks WHERE subject_id = k.subject_id ORDER BY id DESC LIMIT 30) c), '[]'::jsonb),
    'events', coalesce((SELECT jsonb_agg(jsonb_build_object('action', e.action, 'from', e.from_status, 'to', e.to_status, 'actor', e.actor,
                                                            'reason', e.reason, 'at', admin.utc(e.at)) ORDER BY e.id)
                        FROM compliance.kyc_case_events e WHERE e.case_id = k.id), '[]'::jsonb),
    'otherCases', coalesce((SELECT jsonb_agg(jsonb_build_object('id', o.id, 'kind', o.kind, 'status', o.status) ORDER BY o.id DESC)
                            FROM compliance.kyc_cases o WHERE o.subject_id = k.subject_id AND o.id <> k.id), '[]'::jsonb),
    'rescreens', coalesce((SELECT jsonb_agg(jsonb_build_object('id', r.id, 'status', r.status, 'requestedBy', r.requested_by,
                                                               'requestedAt', admin.utc(r.requested_at), 'result', r.result_status) ORDER BY r.id DESC)
                           FROM (SELECT * FROM compliance.rescreens WHERE subject_id = k.subject_id ORDER BY id DESC LIMIT 5) r), '[]'::jsonb),
    'blockers', admin.kyc_case_blockers(v_me, k));
END $$;

/** Screening results: the latest sanctions/PEP screening of every investor, with the re-screening queue. */
CREATE FUNCTION admin.screenings(p_session bytea, p_outcome text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'compliance.read');
BEGIN
  RETURN jsonb_build_object(
    'listVersions', coalesce((SELECT jsonb_agg(DISTINCT c.list_version) FROM kyc.checks c WHERE c.kind = 'sanctions' AND c.list_version IS NOT NULL), '[]'::jsonb),
    'rows', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'subjectId', x.subject_id, 'subject', left(replace(x.subject_id::text, '-', ''), 8), 'cnic', admin.mask_cnic(s.cnic_last4),
        'status', kyc.subject_status(x.subject_id), 'checkId', x.id, 'outcome', x.outcome, 'reason', x.reason, 'score', x.score,
        'listVersion', x.list_version, 'provider', x.provider, 'at', admin.utc(x.at),
        'case', (SELECT k.id FROM compliance.kyc_cases k WHERE k.check_id = x.id),
        'rescreen', (SELECT r.status FROM compliance.rescreens r WHERE r.subject_id = x.subject_id ORDER BY r.id DESC LIMIT 1))
        ORDER BY CASE x.outcome WHEN 'fail' THEN 0 WHEN 'review' THEN 1 WHEN 'error' THEN 2 ELSE 3 END, x.at DESC)
      FROM (SELECT DISTINCT ON (c.subject_id) c.* FROM kyc.checks c WHERE c.kind = 'sanctions' ORDER BY c.subject_id, c.id DESC) x
      JOIN kyc.subjects s ON s.id = x.subject_id
      WHERE p_outcome IS NULL OR x.outcome = p_outcome), '[]'::jsonb),
    'queue', coalesce((SELECT jsonb_agg(jsonb_build_object('id', r.id, 'subject', left(replace(r.subject_id::text, '-', ''), 8), 'status', r.status,
                                                           'requestedBy', r.requested_by, 'requestedAt', admin.utc(r.requested_at),
                                                           'finishedAt', admin.utc(r.finished_at), 'result', r.result_status, 'error', r.error)
                                        ORDER BY r.id DESC)
                       FROM (SELECT * FROM compliance.rescreens ORDER BY id DESC LIMIT 50) r), '[]'::jsonb));
END $$;

CREATE FUNCTION admin.freeze_digest(p_id bigint) RETURNS bytea
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
  SELECT sha256(convert_to('pt-freeze-request-v1' || jsonb_build_array(q.id, q.kind, q.wallet, q.reason_code, q.reason, q.requested_by,
           q.status, q.lifts_request_id, admin.utc(q.requested_at))::text, 'UTF8'))
  FROM compliance.freeze_requests q WHERE q.id = p_id
$$;

CREATE FUNCTION admin.freeze_requests(p_session bytea) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'compliance.read');
BEGIN
  RETURN jsonb_build_object(
    'reasonCodes', (SELECT jsonb_agg(jsonb_build_object('code', code, 'appliesTo', applies_to, 'label', label) ORDER BY applies_to, code)
                    FROM compliance.reason_codes WHERE applies_to IN ('freeze', 'unfreeze')),
    'policies', jsonb_build_object('freeze', compliance.freeze_guard('compliance.freeze') IS NOT NULL,
                                   'unfreeze', compliance.freeze_guard('compliance.unfreeze') IS NOT NULL),
    'holds', coalesce((SELECT jsonb_agg(jsonb_build_object('id', h.id, 'wallet', h.wallet, 'subject', left(replace(h.subject_id::text, '-', ''), 8),
                                                           'freezeRequest', h.freeze_request_id, 'placedAt', admin.utc(h.placed_at)) ORDER BY h.id)
                       FROM compliance.holds h WHERE h.lifted_at IS NULL), '[]'::jsonb),
    'requests', coalesce((SELECT jsonb_agg(jsonb_build_object('id', q.id, 'kind', q.kind, 'wallet', q.wallet, 'reasonCode', q.reason_code,
        'status', CASE WHEN q.status = 'open' AND q.expires_at < clock_timestamp() THEN 'expired' ELSE q.status END,
        'requestedBy', q.requested_by, 'requestedAt', admin.utc(q.requested_at), 'decidedBy', q.decided_by, 'decidedAt', admin.utc(q.decided_at),
        'command', admin.command_json(q.command_key)) ORDER BY q.id DESC)
      FROM (SELECT * FROM compliance.freeze_requests ORDER BY id DESC LIMIT 200) q), '[]'::jsonb));
END $$;

CREATE FUNCTION admin.freeze_request(p_session bytea, p_id bigint) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'compliance.read');
  v_handle text := admin.handle_of(v_me);
  q compliance.freeze_requests;
  v text[] := '{}';
  a text[] := '{}';
  v_under text;
BEGIN
  SELECT * INTO q FROM compliance.freeze_requests WHERE id = p_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  v_under := kyc.underlying_status(q.subject_id);
  IF NOT admin.has_permission(p_session, 'compliance.decide') THEN v := v || 'Only a compliance officer decides freezes; your role reads them.'::text; END IF;
  IF q.status <> 'open' THEN v := v || format('The request is %s.', q.status); END IF;
  IF q.status = 'open' AND q.expires_at < clock_timestamp() THEN v := v || 'The request is older than 24 hours: ask again.'::text; END IF;
  IF q.requested_by = v_handle THEN v := v || format('You proposed this %s: a different compliance officer decides (maker-checker).', q.kind); END IF;
  IF q.kind = 'freeze' AND compliance.freeze_guard('compliance.freeze') IS NULL THEN a := a || 'No active compliance.freeze signing policy.'::text; END IF;
  IF q.kind = 'unfreeze' AND compliance.freeze_guard('compliance.unfreeze') IS NULL THEN a := a || 'No active compliance.unfreeze signing policy.'::text; END IF;
  IF q.kind = 'unfreeze' AND v_under <> 'verified' THEN
    a := a || format('The investor''s own KYC status is %s: the signing service unfreezes only verified investors.', v_under);
  END IF;
  RETURN jsonb_build_object(
    'id', q.id, 'kind', q.kind, 'wallet', q.wallet, 'reasonCode', q.reason_code,
    'reasonLabel', (SELECT label FROM compliance.reason_codes WHERE code = q.reason_code AND applies_to = q.kind),
    'reason', q.reason, 'kycCase', q.kyc_case_id, 'strCase', q.str_case_id, 'lifts', q.lifts_request_id,
    'caseId', '0x' || encode(q.case_ref, 'hex'), 'requestedBy', q.requested_by, 'requestedAt', admin.utc(q.requested_at),
    'expiresAt', admin.utc(q.expires_at), 'status', q.status, 'decidedBy', q.decided_by, 'decisionReason', q.decision_reason,
    'decidedAt', admin.utc(q.decided_at), 'commandKey', q.command_key, 'command', admin.command_json(q.command_key),
    'subject', admin.subject_json(q.subject_id),
    'digest', encode(admin.freeze_digest(q.id), 'hex'),
    'blockers', to_jsonb(v), 'approveBlockers', to_jsonb(a));
END $$;

CREATE FUNCTION admin.str_cases(p_session bytea) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'compliance.read');
BEGIN
  RETURN jsonb_build_object(
    'categories', (SELECT jsonb_agg(jsonb_build_object('code', code, 'label', label) ORDER BY code) FROM compliance.reason_codes WHERE applies_to = 'str'),
    'cases', coalesce((SELECT jsonb_agg(jsonb_build_object('id', s.id, 'category', s.category, 'status', s.status,
        'subject', left(replace(s.subject_id::text, '-', ''), 8), 'openedBy', s.opened_by, 'openedAt', admin.utc(s.opened_at),
        'updatedAt', admin.utc(s.updated_at), 'notes', (SELECT count(*) FROM compliance.str_notes n WHERE n.case_id = s.id),
        'fmuReference', s.fmu_reference,
        'overdue', s.status IN ('open', 'under_review', 'close_proposed') AND clock_timestamp() - s.updated_at > compliance.sla('str.' || s.status))
        ORDER BY s.id DESC)
      FROM (SELECT * FROM compliance.str_cases ORDER BY id DESC LIMIT 300) s), '[]'::jsonb));
END $$;

CREATE FUNCTION admin.str_case(p_session bytea, p_id bigint) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'compliance.read');
  v_handle text := admin.handle_of(v_me);
  s compliance.str_cases;
  v_decide boolean := admin.has_permission(p_session, 'compliance.decide');
  v_live boolean;
  v_base text[] := '{}';
BEGIN
  SELECT * INTO s FROM compliance.str_cases WHERE id = p_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  v_live := s.status NOT IN ('closed', 'filed');
  IF NOT v_decide THEN v_base := v_base || 'Only a compliance officer acts on STR cases; your role reads them.'::text; END IF;
  IF NOT v_live THEN v_base := v_base || format('The case is %s.', s.status); END IF;
  RETURN jsonb_build_object(
    'id', s.id, 'category', s.category, 'categoryLabel', (SELECT label FROM compliance.reason_codes WHERE code = s.category AND applies_to = 'str'),
    'summary', s.summary, 'status', s.status, 'openedBy', s.opened_by, 'openedAt', admin.utc(s.opened_at), 'updatedAt', admin.utc(s.updated_at),
    'closeProposedBy', s.close_proposed_by, 'closeProposedReason', s.close_proposed_reason, 'closedBy', s.closed_by, 'closedReason', s.closed_reason,
    'filedBy', s.filed_by, 'fmuReference', s.fmu_reference, 'finishedAt', admin.utc(s.finished_at),
    'subject', CASE WHEN s.subject_id IS NOT NULL THEN admin.subject_json(s.subject_id) END,
    'digest', encode(compliance.str_case_digest(s.id), 'hex'),
    'notes', coalesce((SELECT jsonb_agg(jsonb_build_object('id', n.id, 'author', n.author, 'body', n.body, 'at', admin.utc(n.at)) ORDER BY n.id)
                       FROM compliance.str_notes n WHERE n.case_id = s.id), '[]'::jsonb),
    'events', coalesce((SELECT jsonb_agg(jsonb_build_object('action', e.action, 'from', e.from_status, 'to', e.to_status, 'actor', e.actor,
                                                            'reason', e.reason, 'at', admin.utc(e.at)) ORDER BY e.id)
                        FROM compliance.str_events e WHERE e.case_id = s.id), '[]'::jsonb),
    'exports', coalesce((SELECT jsonb_agg(jsonb_build_object('id', x.id, 'by', x.exported_by, 'sha256', encode(x.sha256, 'hex'), 'at', admin.utc(x.at))
                                          ORDER BY x.id) FROM compliance.str_exports x WHERE x.case_id = s.id), '[]'::jsonb),
    'blockers', jsonb_build_object(
      'note', to_jsonb(CASE WHEN NOT v_decide THEN ARRAY['Only a compliance officer adds notes.'] ELSE '{}'::text[] END),
      'start_review', to_jsonb(v_base || CASE WHEN v_live AND s.status <> 'open' THEN ARRAY['The review has already started.'] ELSE '{}'::text[] END),
      'propose_close', to_jsonb(v_base || CASE WHEN v_live AND s.status NOT IN ('open', 'under_review') THEN ARRAY['Closing is already proposed.'] ELSE '{}'::text[] END),
      'confirm_close', to_jsonb(v_base || CASE WHEN v_live AND s.status <> 'close_proposed' THEN ARRAY['Nothing is waiting for a second officer.'] ELSE '{}'::text[] END
                               || CASE WHEN s.status = 'close_proposed' AND s.close_proposed_by = v_handle THEN ARRAY['You proposed closing: a different compliance officer confirms (maker-checker).'] ELSE '{}'::text[] END),
      'decline_close', to_jsonb(v_base || CASE WHEN v_live AND s.status <> 'close_proposed' THEN ARRAY['Nothing is waiting for a second officer.'] ELSE '{}'::text[] END
                               || CASE WHEN s.status = 'close_proposed' AND s.close_proposed_by = v_handle THEN ARRAY['You proposed closing: a different compliance officer declines (maker-checker).'] ELSE '{}'::text[] END),
      'mark_filed', to_jsonb(v_base || CASE WHEN v_live AND s.status NOT IN ('open', 'under_review') THEN ARRAY['Decline the proposal to close first.'] ELSE '{}'::text[] END
                            || CASE WHEN NOT EXISTS (SELECT 1 FROM compliance.str_exports x WHERE x.case_id = s.id) THEN ARRAY['Export the case for the FMU first.'] ELSE '{}'::text[] END),
      'export', to_jsonb(CASE WHEN NOT admin.has_permission(p_session, 'compliance.export') THEN ARRAY['Only a compliance officer exports for the FMU.'] ELSE '{}'::text[] END)));
END $$;

/** The content of an FMU export (compliance.export): the case, notes, events and the investor's masked identifiers and screening. */
CREATE FUNCTION admin.str_export_data(p_session bytea, p_id bigint) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'compliance.export');
  s compliance.str_cases;
BEGIN
  SELECT * INTO s FROM compliance.str_cases WHERE id = p_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN jsonb_build_object(
    'kind', 'pt-str-case-v1', 'case', s.id, 'category', s.category,
    'categoryLabel', (SELECT label FROM compliance.reason_codes WHERE code = s.category AND applies_to = 'str'),
    'summary', s.summary, 'status', s.status, 'openedBy', s.opened_by, 'openedAtUtc', admin.utc(s.opened_at),
    'investor', CASE WHEN s.subject_id IS NOT NULL THEN jsonb_build_object(
        'subjectId', s.subject_id, 'cnic', (SELECT admin.mask_cnic(x.cnic_last4) FROM kyc.subjects x WHERE x.id = s.subject_id),
        'kycStatus', kyc.underlying_status(s.subject_id), 'wallet', (SELECT w.wallet FROM kyc.wallets w WHERE w.subject_id = s.subject_id),
        'screening', coalesce((SELECT jsonb_agg(jsonb_build_object('kind', c.kind, 'outcome', c.outcome, 'reason', c.reason, 'score', c.score,
                                                                   'listVersion', c.list_version, 'atUtc', admin.utc(c.at)) ORDER BY c.id)
                               FROM kyc.checks c WHERE c.subject_id = s.subject_id), '[]'::jsonb),
        'freezes', coalesce((SELECT jsonb_agg(jsonb_build_object('request', q.id, 'kind', q.kind, 'status', q.status, 'reasonCode', q.reason_code,
                                                                 'caseId', '0x' || encode(q.case_ref, 'hex')) ORDER BY q.id)
                             FROM compliance.freeze_requests q WHERE q.subject_id = s.subject_id), '[]'::jsonb)) END,
    'notes', coalesce((SELECT jsonb_agg(jsonb_build_object('author', n.author, 'atUtc', admin.utc(n.at), 'body', n.body) ORDER BY n.id)
                       FROM compliance.str_notes n WHERE n.case_id = s.id), '[]'::jsonb),
    'events', coalesce((SELECT jsonb_agg(jsonb_build_object('action', e.action, 'from', e.from_status, 'to', e.to_status, 'actor', e.actor,
                                                            'reason', e.reason, 'atUtc', admin.utc(e.at)) ORDER BY e.id)
                        FROM compliance.str_events e WHERE e.case_id = s.id), '[]'::jsonb),
    'note', 'Prepared for a manual filing with the Financial Monitoring Unit (goAML). The investor''s name and CNIC are not in this file: '
            || 'they come from the KYC record on request of the MLRO. Never share with the investor (tipping-off, AML Act 2010 s.34).');
END $$;

-- ------------------------------------------------------------------ writes (compliance.decide / compliance.export)
/** Internal: runs one compliance call for an officer: binding (C-7), refusals audited (as 0016). */
CREATE FUNCTION admin.check_text(p text, p_min integer, p_max integer) RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
BEGIN
  IF p IS NULL OR length(btrim(p)) NOT BETWEEN p_min AND p_max THEN
    RAISE EXCEPTION 'a text of % to % characters is required', p_min, p_max USING ERRCODE = 'check_violation';
  END IF;
END $$;

CREATE FUNCTION admin.open_kyc_case(p_session bytea, p_subject uuid, p_risk text, p_summary text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'compliance.decide');
  v_handle text := admin.handle_of(v_me);
  v_id bigint;
BEGIN
  PERFORM admin.check_text(p_summary, 10, 500);
  BEGIN
    PERFORM admin.bind_officer(v_handle);
    v_id := compliance.open_kyc_case(p_subject, p_risk, p_summary, v_handle);
    PERFORM admin.unbind_officer(v_handle);
  EXCEPTION WHEN SQLSTATE '23514' OR SQLSTATE '23505' OR SQLSTATE '42501' OR SQLSTATE '22023' OR SQLSTATE 'P0002' OR SQLSTATE '23503' THEN
    RETURN admin.refuse(v_me, 'kyc_case', 'new', 'open', SQLERRM);
  END;
  PERFORM admin.audit_append(v_me::text, 'compliance.requested', jsonb_build_object('kind', 'kyc_case', 'ref', v_id, 'action', 'open'));
  RETURN jsonb_build_object('ok', true, 'id', v_id, 'status', 'open');
END $$;

CREATE FUNCTION admin.kyc_case_act(p_session bytea, p_case bigint, p_action text, p_reason text, p_digest bytea) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'compliance.decide');
  v_handle text := admin.handle_of(v_me);
  v_status text;
BEGIN
  PERFORM admin.require_step_up(p_session);
  PERFORM admin.check_text(p_reason, 10, 500);
  IF NOT EXISTS (SELECT 1 FROM compliance.kyc_cases WHERE id = p_case) THEN
    RETURN admin.refuse(v_me, 'kyc_case', p_case::text, p_action, 'unknown KYC case');
  END IF;
  IF compliance.kyc_case_digest(p_case) IS DISTINCT FROM p_digest THEN
    RETURN admin.refuse(v_me, 'kyc_case', p_case::text, p_action, 'the case differs from what you reviewed: reload and check again');
  END IF;
  BEGIN
    PERFORM admin.bind_officer(v_handle);
    v_status := compliance.kyc_case_act(p_case, v_handle, p_action, p_reason);
    PERFORM admin.unbind_officer(v_handle);
  EXCEPTION WHEN SQLSTATE '23514' OR SQLSTATE '23505' OR SQLSTATE '42501' OR SQLSTATE '22023' OR SQLSTATE 'P0002' THEN
    RETURN admin.refuse(v_me, 'kyc_case', p_case::text, p_action, SQLERRM);
  END;
  PERFORM admin.audit_append(v_me::text, 'compliance.decided', jsonb_build_object('kind', 'kyc_case', 'ref', p_case, 'action', p_action,
    'result', v_status, 'digest', encode(p_digest, 'hex')));
  RETURN jsonb_build_object('ok', true, 'status', v_status);
END $$;

CREATE FUNCTION admin.request_rescreen(p_session bytea, p_subject uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'compliance.decide');
  v_handle text := admin.handle_of(v_me);
  v_id bigint;
BEGIN
  PERFORM admin.check_text(p_reason, 10, 500);
  BEGIN
    PERFORM admin.bind_officer(v_handle);
    v_id := compliance.request_rescreen(p_subject, v_handle, p_reason);
    PERFORM admin.unbind_officer(v_handle);
  EXCEPTION WHEN SQLSTATE '23514' OR SQLSTATE '23505' OR SQLSTATE '42501' OR SQLSTATE '22023' OR SQLSTATE 'P0002' THEN
    RETURN admin.refuse(v_me, 'rescreen', coalesce(p_subject::text, 'none'), 'request', SQLERRM);
  END;
  PERFORM admin.audit_append(v_me::text, 'compliance.requested', jsonb_build_object('kind', 'rescreen', 'ref', v_id, 'action', 'request'));
  RETURN jsonb_build_object('ok', true, 'id', v_id, 'status', 'queued');
END $$;

CREATE FUNCTION admin.request_freeze(p_session bytea, p_kind text, p_wallet text, p_reason_code text, p_reason text, p_kyc_case bigint, p_str_case bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'compliance.decide');
  v_handle text := admin.handle_of(v_me);
  v_id bigint;
BEGIN
  PERFORM admin.require_step_up(p_session);
  PERFORM admin.check_text(p_reason, 10, 500);
  BEGIN
    PERFORM admin.bind_officer(v_handle);
    v_id := compliance.request_freeze(p_kind, p_wallet, p_reason_code, p_reason, v_handle, p_kyc_case, p_str_case);
    PERFORM admin.unbind_officer(v_handle);
  EXCEPTION WHEN SQLSTATE '23514' OR SQLSTATE '23505' OR SQLSTATE '42501' OR SQLSTATE '22023' OR SQLSTATE 'P0002' OR SQLSTATE '23503' THEN
    RETURN admin.refuse(v_me, 'freeze', 'new', coalesce(p_kind, '?'), SQLERRM);
  END;
  PERFORM admin.audit_append(v_me::text, 'compliance.requested', jsonb_build_object('kind', p_kind, 'ref', v_id, 'action', 'request'));
  RETURN jsonb_build_object('ok', true, 'id', v_id, 'status', 'open');
END $$;

CREATE FUNCTION admin.decide_freeze(p_session bytea, p_request bigint, p_decision text, p_reason text, p_digest bytea) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'compliance.decide');
  v_handle text := admin.handle_of(v_me);
  v_status text;
BEGIN
  PERFORM admin.require_step_up(p_session);
  PERFORM admin.check_decision(p_decision, p_reason);
  IF NOT EXISTS (SELECT 1 FROM compliance.freeze_requests WHERE id = p_request) THEN
    RETURN admin.refuse(v_me, 'freeze', p_request::text, p_decision, 'unknown freeze request');
  END IF;
  IF admin.freeze_digest(p_request) IS DISTINCT FROM p_digest THEN
    RETURN admin.refuse(v_me, 'freeze', p_request::text, p_decision, 'the request differs from what you reviewed: reload and check again');
  END IF;
  BEGIN
    PERFORM admin.bind_officer(v_handle);
    v_status := compliance.decide_freeze(p_request, v_handle, p_decision, p_reason);
    PERFORM admin.unbind_officer(v_handle);
  EXCEPTION WHEN SQLSTATE '23514' OR SQLSTATE '23505' OR SQLSTATE '42501' OR SQLSTATE '22023' OR SQLSTATE 'P0002' THEN
    RETURN admin.refuse(v_me, 'freeze', p_request::text, p_decision, SQLERRM);
  END;
  PERFORM admin.audit_append(v_me::text, 'compliance.decided', jsonb_build_object('kind', 'freeze', 'ref', p_request, 'action', p_decision,
    'result', v_status, 'digest', encode(p_digest, 'hex')));
  RETURN jsonb_build_object('ok', true, 'status', v_status);
END $$;

CREATE FUNCTION admin.open_str(p_session bytea, p_subject uuid, p_category text, p_summary text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'compliance.decide');
  v_handle text := admin.handle_of(v_me);
  v_id bigint;
BEGIN
  PERFORM admin.check_text(p_summary, 20, 2000);
  BEGIN
    PERFORM admin.bind_officer(v_handle);
    v_id := compliance.open_str(p_subject, p_category, p_summary, v_handle);
    PERFORM admin.unbind_officer(v_handle);
  EXCEPTION WHEN SQLSTATE '23514' OR SQLSTATE '23505' OR SQLSTATE '42501' OR SQLSTATE '22023' OR SQLSTATE 'P0002' OR SQLSTATE '23503' THEN
    RETURN admin.refuse(v_me, 'str', 'new', 'open', SQLERRM);
  END;
  PERFORM admin.audit_append(v_me::text, 'compliance.requested', jsonb_build_object('kind', 'str', 'ref', v_id, 'action', 'open'));
  RETURN jsonb_build_object('ok', true, 'id', v_id, 'status', 'open');
END $$;

CREATE FUNCTION admin.add_str_note(p_session bytea, p_case bigint, p_body text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'compliance.decide');
  v_handle text := admin.handle_of(v_me);
  v_id bigint;
BEGIN
  PERFORM admin.check_text(p_body, 2, 2000);
  BEGIN
    PERFORM admin.bind_officer(v_handle);
    v_id := compliance.add_str_note(p_case, v_handle, p_body);
    PERFORM admin.unbind_officer(v_handle);
  EXCEPTION WHEN SQLSTATE '23514' OR SQLSTATE '23505' OR SQLSTATE '42501' OR SQLSTATE '22023' OR SQLSTATE 'P0002' THEN
    RETURN admin.refuse(v_me, 'str', p_case::text, 'note', SQLERRM);
  END;
  PERFORM admin.audit_append(v_me::text, 'compliance.requested', jsonb_build_object('kind', 'str', 'ref', p_case, 'action', 'note', 'note', v_id));
  RETURN jsonb_build_object('ok', true, 'id', v_id);
END $$;

CREATE FUNCTION admin.str_act(p_session bytea, p_case bigint, p_action text, p_reason text, p_fmu_reference text, p_digest bytea) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'compliance.decide');
  v_handle text := admin.handle_of(v_me);
  v_status text;
BEGIN
  PERFORM admin.require_step_up(p_session);
  PERFORM admin.check_text(p_reason, 10, 500);
  IF NOT EXISTS (SELECT 1 FROM compliance.str_cases WHERE id = p_case) THEN
    RETURN admin.refuse(v_me, 'str', p_case::text, p_action, 'unknown STR case');
  END IF;
  IF compliance.str_case_digest(p_case) IS DISTINCT FROM p_digest THEN
    RETURN admin.refuse(v_me, 'str', p_case::text, p_action, 'the case differs from what you reviewed: reload and check again');
  END IF;
  BEGIN
    PERFORM admin.bind_officer(v_handle);
    v_status := compliance.str_act(p_case, v_handle, p_action, p_reason, p_fmu_reference);
    PERFORM admin.unbind_officer(v_handle);
  EXCEPTION WHEN SQLSTATE '23514' OR SQLSTATE '23505' OR SQLSTATE '42501' OR SQLSTATE '22023' OR SQLSTATE 'P0002' THEN
    RETURN admin.refuse(v_me, 'str', p_case::text, p_action, SQLERRM);
  END;
  PERFORM admin.audit_append(v_me::text, 'compliance.decided', jsonb_build_object('kind', 'str', 'ref', p_case, 'action', p_action,
    'result', v_status, 'digest', encode(p_digest, 'hex')));
  RETURN jsonb_build_object('ok', true, 'status', v_status);
END $$;

/** Records an FMU export (step-up, compliance.export) BEFORE the portal hands out the file. */
CREATE FUNCTION admin.record_str_export(p_session bytea, p_case bigint, p_sha256 text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'compliance.export');
  v_handle text := admin.handle_of(v_me);
  v_export bigint;
  v_audit bigint;
BEGIN
  PERFORM admin.require_step_up(p_session);
  IF p_sha256 IS NULL OR p_sha256 !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid export digest' USING ERRCODE = 'check_violation'; END IF;
  BEGIN
    PERFORM admin.bind_officer(v_handle);
    v_export := compliance.record_str_export(p_case, v_handle, decode(p_sha256, 'hex'));
    PERFORM admin.unbind_officer(v_handle);
  EXCEPTION WHEN SQLSTATE '23514' OR SQLSTATE '42501' OR SQLSTATE 'P0002' THEN
    RETURN admin.refuse(v_me, 'str', p_case::text, 'export', SQLERRM);
  END;
  v_audit := admin.audit_append(v_me::text, 'compliance.exported', jsonb_build_object('kind', 'str', 'ref', p_case, 'export', v_export, 'sha256', p_sha256));
  RETURN (SELECT jsonb_build_object('ok', true, 'id', v_export, 'auditId', a.id, 'auditHash', encode(a.hash, 'hex'), 'at', admin.utc(a.at))
          FROM admin.audit a WHERE a.id = v_audit);
END $$;

-- ------------------------------------------------------------------ the compliance audit chain in the audit viewer
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
BEGIN
  PERFORM admin.require(p_session, NULL);
  v_ops := admin.has_permission(p_session, 'audit.read.ops');
  v_admin := admin.has_permission(p_session, 'audit.read.admin');
  v_comp := admin.has_permission(p_session, 'compliance.read');
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
END $$;

CREATE OR REPLACE FUNCTION admin.record_export(p_session bytea, p_source text, p_filters jsonb, p_rows integer, p_format text, p_sha256 text)
RETURNS TABLE (audit_id bigint, audit_hash text, at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
#variable_conflict use_column
DECLARE
  v_me uuid := admin.require(p_session, 'audit.export');
  v_id bigint;
BEGIN
  IF p_source NOT IN ('admin', 'signer', 'recon', 'ledger', 'compliance') OR p_format NOT IN ('csv', 'json') OR p_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid export description' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM admin.require(p_session, CASE p_source WHEN 'admin' THEN 'audit.read.admin' WHEN 'compliance' THEN 'compliance.read' ELSE 'audit.read.ops' END);
  v_id := admin.audit_append(v_me::text, 'audit.exported', jsonb_build_object('source', p_source, 'format', p_format, 'rows', p_rows,
                                                                             'filters', coalesce(p_filters, '{}'::jsonb), 'sha256', p_sha256));
  RETURN QUERY SELECT a.id, encode(a.hash, 'hex'), a.at FROM admin.audit a WHERE a.id = v_id;
END $$;

-- ================================================================== privileges
REVOKE ALL ON ALL TABLES IN SCHEMA compliance FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA compliance FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA admin FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA admin FROM PUBLIC;
REVOKE ALL ON FUNCTION kyc.underlying_status(uuid) FROM PUBLIC;
-- CREATE OR REPLACE keeps the 0009 grants of kyc.subject_status, kyc.evaluate and kyc.request_clearance.

GRANT EXECUTE ON FUNCTION
  admin.compliance_dashboard(bytea),
  admin.kyc_queue(bytea, text),
  admin.kyc_case(bytea, bigint),
  admin.screenings(bytea, text),
  admin.freeze_requests(bytea),
  admin.freeze_request(bytea, bigint),
  admin.str_cases(bytea),
  admin.str_case(bytea, bigint),
  admin.str_export_data(bytea, bigint),
  admin.open_kyc_case(bytea, uuid, text, text),
  admin.kyc_case_act(bytea, bigint, text, text, bytea),
  admin.request_rescreen(bytea, uuid, text),
  admin.request_freeze(bytea, text, text, text, text, bigint, bigint),
  admin.decide_freeze(bytea, bigint, text, text, bytea),
  admin.open_str(bytea, uuid, text, text),
  admin.add_str_note(bytea, bigint, text),
  admin.str_act(bytea, bigint, text, text, text, bytea),
  admin.record_str_export(bytea, bigint, text)
TO pt_admin_portal;

-- The signing service checks an unfreeze against the two-officer decision (compliance.unfreeze policy).
GRANT USAGE ON SCHEMA compliance TO pt_signer, pt_kyc_service, pt_kyc_officer;
GRANT EXECUTE ON FUNCTION compliance.unfreeze_allowed(text, text) TO pt_signer;
-- The KYC service executes queued re-screenings (it alone holds the sealed-name key).
GRANT EXECUTE ON FUNCTION compliance.claim_rescreens(text, integer), compliance.complete_rescreen(bigint, text, text, bigint, text) TO pt_kyc_service;
GRANT EXECUTE ON FUNCTION compliance.verify_audit() TO pt_kyc_officer, pt_admin_auditor;
GRANT EXECUTE ON FUNCTION kyc.underlying_status(uuid) TO pt_kyc_service, pt_kyc_officer, pt_kyc_reader;

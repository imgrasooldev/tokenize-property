-- Reconciliation (Step 5f): chain <-> ledger <-> bank, and the payout freeze gate (ADR 0007).
--
-- Safety properties enforced by the database itself:
--   R-1  Runs, findings, bank statements, gate events and the audit log are append-only. A run moves
--        once, from running to passed | failed | error; its findings are written in the same call
--        (recon.complete_run), so a run can never end up with half of its findings.
--   R-2  A run with any blocking finding freezes payouts in the same transaction. Nothing ever
--        unfreezes automatically, not even a later passed run.
--   R-3  Unfreezing is maker-checker: one operator requests it and a DIFFERENT operator approves it,
--        each with a reason of at least 10 characters. The request is bound to the current freeze
--        (a newer freeze makes it stale), expires after 24 hours, and can be approved only after a
--        run that passed AFTER the freeze.
--   R-4  recon.payouts_allowed() is deny-by-default: true only when payouts are not frozen AND the
--        latest finished run passed AND it finished less than 26 hours ago (daily reconciliation).
--        A run that ends in error does not freeze, but payouts stay denied until a run passes.
--   R-5  A bank statement is imported once: the same content returns the same statement; different
--        content for the same account and date is refused. Opening + lines = closing, every running
--        balance adds up, and a reference is used once per account and direction.
--   R-6  Every action is written to a hash-chained audit log. recon.verify_audit() re-checks the
--        chain, recomputes every finished run (with its findings) and every imported statement from
--        the stored rows, and finds gate events without an audit entry (a direct INSERT).
--   R-7  Roles: pt_recon_writer runs reconciliations and imports statements; pt_recon_operator
--        registers bank accounts, imports statements and decides unfreezes; pt_recon_reader reads.
--        No role writes tables directly. The signing service and outbox workers may only ask the gate.
-- Amounts: bigint paisa, never floating point. Timestamps inside digests are formatted in UTC, so a
-- verification gives the same answer whatever the session's TimeZone is.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pt_recon_writer') THEN CREATE ROLE pt_recon_writer NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pt_recon_operator') THEN CREATE ROLE pt_recon_operator NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pt_recon_reader') THEN CREATE ROLE pt_recon_reader NOLOGIN; END IF;
END $$;

-- ------------------------------------------------------------------ helpers
CREATE FUNCTION recon.forbid_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'recon is append-only: % on %.% is not allowed', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE FUNCTION recon.utc(p timestamptz) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT to_char(p AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
$$;

-- ------------------------------------------------------------------ audit (R-6)
CREATE TABLE recon.audit (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at        timestamptz NOT NULL,
  actor     text NOT NULL CHECK (length(actor) BETWEEN 1 AND 100),
  action    text NOT NULL CHECK (action ~ '^[a-z][a-z_.]{2,63}$'),
  detail    jsonb NOT NULL CHECK (jsonb_typeof(detail) = 'object' AND octet_length(detail::text) <= 8192),
  prev_hash bytea NOT NULL CHECK (length(prev_hash) = 32),
  hash      bytea NOT NULL UNIQUE CHECK (length(hash) = 32)
);
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON recon.audit FOR EACH ROW EXECUTE FUNCTION recon.forbid_change();
CREATE TRIGGER audit_no_truncate BEFORE TRUNCATE ON recon.audit FOR EACH STATEMENT EXECUTE FUNCTION recon.forbid_change();

CREATE FUNCTION recon.audit_digest(p_prev bytea, p_id bigint, p_at timestamptz, p_actor text, p_action text, p_detail jsonb)
RETURNS bytea LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, recon AS $$
  SELECT sha256(p_prev || convert_to(jsonb_build_array(p_id, recon.utc(p_at), p_actor, p_action, p_detail)::text, 'UTF8'))
$$;

CREATE FUNCTION recon.audit_append(p_actor text, p_action text, p_detail jsonb)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, recon AS $$
DECLARE
  v_prev bytea;
  v_id bigint;
  v_at timestamptz := date_trunc('microseconds', clock_timestamp());
BEGIN
  PERFORM pg_advisory_xact_lock(586586080);
  SELECT hash INTO v_prev FROM recon.audit ORDER BY id DESC LIMIT 1;
  v_prev := coalesce(v_prev, decode(repeat('00', 32), 'hex'));
  v_id := nextval(pg_get_serial_sequence('recon.audit', 'id'));
  INSERT INTO recon.audit (id, at, actor, action, detail, prev_hash, hash)
  OVERRIDING SYSTEM VALUE
  VALUES (v_id, v_at, p_actor, p_action, coalesce(p_detail, '{}'::jsonb), v_prev,
          recon.audit_digest(v_prev, v_id, v_at, p_actor, p_action, coalesce(p_detail, '{}'::jsonb)));
  RETURN v_id;
END $$;

-- ------------------------------------------------------------------ runs and findings (R-1)
CREATE TABLE recon.runs (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  started_at   timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  started_by   text NOT NULL CHECK (length(started_by) BETWEEN 1 AND 100),
  deployment   text CHECK (length(deployment) <= 80),
  params       jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(params) = 'object' AND octet_length(params::text) <= 4096),
  status       text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'passed', 'failed', 'error')),
  -- The chain block every chain comparison of this run is pinned to (the read model's cursor).
  pinned_block bigint CHECK (pinned_block >= -1),
  finished_at  timestamptz,
  blocking     integer CHECK (blocking >= 0),
  warnings     integer CHECK (warnings >= 0),
  summary      jsonb CHECK (summary IS NULL OR (jsonb_typeof(summary) = 'object' AND octet_length(summary::text) <= 65536)),
  error        text CHECK (length(error) <= 1000),
  CHECK ((status = 'running') = (finished_at IS NULL)),
  CHECK (status NOT IN ('passed', 'failed') OR (blocking IS NOT NULL AND warnings IS NOT NULL AND summary IS NOT NULL)),
  CHECK (status <> 'passed' OR blocking = 0),
  CHECK (status <> 'failed' OR blocking > 0)
);
CREATE INDEX runs_finished_idx ON recon.runs (id DESC) WHERE status <> 'running';

CREATE FUNCTION recon.guard_run() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'recon runs are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status <> 'running' THEN
    RAISE EXCEPTION 'recon run % is final (%)', OLD.id, OLD.status USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.id <> OLD.id OR NEW.started_at <> OLD.started_at OR NEW.started_by <> OLD.started_by
     OR NEW.deployment IS DISTINCT FROM OLD.deployment OR NEW.params <> OLD.params OR NEW.status = 'running' THEN
    RAISE EXCEPTION 'recon run % can only be finished once', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER runs_guard BEFORE UPDATE OR DELETE ON recon.runs FOR EACH ROW EXECUTE FUNCTION recon.guard_run();
CREATE TRIGGER runs_no_truncate BEFORE TRUNCATE ON recon.runs FOR EACH STATEMENT EXECUTE FUNCTION recon.forbid_change();

CREATE TABLE recon.findings (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id     bigint NOT NULL REFERENCES recon.runs (id),
  check_name text NOT NULL CHECK (length(check_name) <= 64 AND check_name ~ '^[a-z]+\.[a-z_]+$'),
  severity   text NOT NULL CHECK (severity IN ('blocking', 'warning')),
  subject    text NOT NULL CHECK (length(subject) BETWEEN 1 AND 300),
  expected   text CHECK (length(expected) <= 500),
  actual     text CHECK (length(actual) <= 500),
  detail     jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(detail) = 'object' AND octet_length(detail::text) <= 4096)
);
CREATE INDEX findings_run_idx ON recon.findings (run_id, id);
CREATE TRIGGER findings_append_only BEFORE UPDATE OR DELETE ON recon.findings FOR EACH ROW EXECUTE FUNCTION recon.forbid_change();
CREATE TRIGGER findings_no_truncate BEFORE TRUNCATE ON recon.findings FOR EACH STATEMENT EXECUTE FUNCTION recon.forbid_change();

/** Canonical digest of a finished run and all its findings (R-6). */
CREATE FUNCTION recon.run_digest(p_run bigint) RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog, recon AS $$
  SELECT encode(sha256(convert_to(jsonb_build_array(
    r.id, recon.utc(r.started_at), r.started_by, coalesce(r.deployment, ''), r.params, r.status, r.pinned_block,
    recon.utc(r.finished_at), r.blocking, r.warnings, coalesce(r.summary, '{}'::jsonb), coalesce(r.error, ''),
    coalesce((SELECT jsonb_agg(jsonb_build_array(f.id, f.check_name, f.severity, f.subject, coalesce(f.expected, ''),
                                                 coalesce(f.actual, ''), f.detail) ORDER BY f.id)
              FROM recon.findings f WHERE f.run_id = r.id), '[]'::jsonb)
  )::text, 'UTF8')), 'hex')
  FROM recon.runs r WHERE r.id = p_run
$$;

-- ------------------------------------------------------------------ payout gate (R-2, R-3, R-4)
CREATE TABLE recon.gate_events (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  action     text NOT NULL CHECK (action IN ('freeze', 'unfreeze')),
  run_id     bigint REFERENCES recon.runs (id),
  request_id bigint,
  actor      text NOT NULL CHECK (length(actor) BETWEEN 1 AND 100),
  reason     text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  CHECK ((action = 'freeze') = (run_id IS NOT NULL)),
  CHECK ((action = 'unfreeze') = (request_id IS NOT NULL))
);
CREATE TRIGGER gate_events_append_only BEFORE UPDATE OR DELETE ON recon.gate_events FOR EACH ROW EXECUTE FUNCTION recon.forbid_change();
CREATE TRIGGER gate_events_no_truncate BEFORE TRUNCATE ON recon.gate_events FOR EACH STATEMENT EXECUTE FUNCTION recon.forbid_change();

CREATE TABLE recon.unfreeze_requests (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  freeze_event    bigint NOT NULL REFERENCES recon.gate_events (id),
  requested_by    text NOT NULL CHECK (length(requested_by) BETWEEN 2 AND 100),
  reason          text NOT NULL CHECK (length(reason) BETWEEN 10 AND 500),
  requested_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at      timestamptz NOT NULL DEFAULT clock_timestamp() + interval '24 hours',
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'approved', 'rejected', 'expired')),
  decided_by      text CHECK (length(decided_by) BETWEEN 2 AND 100),
  decision_reason text CHECK (length(decision_reason) BETWEEN 10 AND 500),
  decided_at      timestamptz,
  -- Maker-checker, also against a direct UPDATE.
  CHECK (decided_by IS NULL OR decided_by <> requested_by),
  CHECK ((status = 'open') = (decided_at IS NULL)),
  CHECK ((status IN ('approved', 'rejected')) = (decided_by IS NOT NULL AND decision_reason IS NOT NULL))
);
CREATE UNIQUE INDEX unfreeze_one_open ON recon.unfreeze_requests (freeze_event) WHERE status = 'open';
ALTER TABLE recon.gate_events ADD FOREIGN KEY (request_id) REFERENCES recon.unfreeze_requests (id);

CREATE FUNCTION recon.guard_request() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'unfreeze requests are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status <> 'open' OR NEW.id <> OLD.id OR NEW.freeze_event <> OLD.freeze_event OR NEW.requested_by <> OLD.requested_by
     OR NEW.reason <> OLD.reason OR NEW.requested_at <> OLD.requested_at OR NEW.expires_at <> OLD.expires_at THEN
    RAISE EXCEPTION 'unfreeze request % can only be decided once', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER unfreeze_requests_guard BEFORE UPDATE OR DELETE ON recon.unfreeze_requests FOR EACH ROW EXECUTE FUNCTION recon.guard_request();
CREATE TRIGGER unfreeze_requests_no_truncate BEFORE TRUNCATE ON recon.unfreeze_requests FOR EACH STATEMENT EXECUTE FUNCTION recon.forbid_change();

/** R-4: the gate every payout path asks. Explains itself, so a denial can be shown and audited. */
CREATE FUNCTION recon.payout_gate()
RETURNS TABLE (allowed boolean, frozen boolean, reason text, freeze_event bigint, last_run bigint, last_status text, last_finished timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, recon AS $$
DECLARE
  e recon.gate_events;
  r recon.runs;
BEGIN
  SELECT * INTO e FROM recon.gate_events ORDER BY id DESC LIMIT 1;
  SELECT * INTO r FROM recon.runs WHERE status <> 'running' ORDER BY id DESC LIMIT 1;
  frozen := coalesce(e.action = 'freeze', false);
  freeze_event := CASE WHEN frozen THEN e.id END;
  last_run := r.id;
  last_status := r.status;
  last_finished := r.finished_at;
  IF frozen THEN
    allowed := false;
    reason := format('payouts are frozen since %s by run %s (%s); unfreezing needs two operators', recon.utc(e.at), e.run_id, e.reason);
  ELSIF r.id IS NULL THEN
    allowed := false;
    reason := 'no reconciliation run has finished yet';
  ELSIF r.status <> 'passed' THEN
    allowed := false;
    reason := format('the latest reconciliation run %s ended %s', r.id, r.status);
  ELSIF r.finished_at < now() - interval '26 hours' THEN
    allowed := false;
    reason := format('the latest passed reconciliation run %s is older than 26 hours', r.id);
  ELSE
    allowed := true;
    reason := format('run %s passed at %s', r.id, recon.utc(r.finished_at));
  END IF;
  RETURN NEXT;
END $$;

CREATE FUNCTION recon.payouts_allowed() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, recon AS $$
  SELECT coalesce((SELECT allowed FROM recon.payout_gate()), false)
$$;

-- ------------------------------------------------------------------ run API
/** Starts a run. One run at a time; a run left running for an hour (crashed) is closed as error. */
CREATE FUNCTION recon.start_run(p_actor text, p_deployment text, p_params jsonb)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, recon AS $$
DECLARE
  v_id bigint;
  r record;
BEGIN
  PERFORM pg_advisory_xact_lock(586586081);
  FOR r IN SELECT id FROM recon.runs WHERE status = 'running' AND started_at < now() - interval '1 hour' LOOP
    UPDATE recon.runs SET status = 'error', finished_at = clock_timestamp(), error = 'abandoned: still running after one hour' WHERE id = r.id;
    PERFORM recon.audit_append('recon', 'run.finished', jsonb_build_object('run', r.id, 'status', 'error', 'digest', recon.run_digest(r.id)));
  END LOOP;
  IF EXISTS (SELECT 1 FROM recon.runs WHERE status = 'running') THEN
    RAISE EXCEPTION 'another reconciliation run is in progress' USING ERRCODE = 'lock_not_available';
  END IF;
  INSERT INTO recon.runs (started_by, deployment, params) VALUES (p_actor, p_deployment, coalesce(p_params, '{}'::jsonb))
  RETURNING id INTO v_id;
  PERFORM recon.audit_append(p_actor, 'run.started', jsonb_build_object('run', v_id, 'deployment', p_deployment, 'params', coalesce(p_params, '{}'::jsonb)));
  RETURN v_id;
END $$;

/**
 * R-1/R-2: records all findings of a run and finishes it, in one transaction. The status is derived
 * here from the findings, never taken from the caller. Any blocking finding freezes payouts.
 * p_findings: [{check, severity, subject, expected?, actual?, detail?}]
 */
CREATE FUNCTION recon.complete_run(p_run bigint, p_actor text, p_pinned_block bigint, p_findings jsonb, p_summary jsonb)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, recon AS $$
DECLARE
  v_run recon.runs;
  v_blocking integer;
  v_warnings integer;
  v_status text;
  v_event bigint;
  f jsonb;
BEGIN
  IF p_findings IS NULL OR jsonb_typeof(p_findings) <> 'array' THEN
    RAISE EXCEPTION 'findings must be an array' USING ERRCODE = 'check_violation';
  END IF;
  IF jsonb_array_length(p_findings) > 20000 THEN
    RAISE EXCEPTION 'too many findings in one run (%)', jsonb_array_length(p_findings) USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v_run FROM recon.runs WHERE id = p_run FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown run %', p_run USING ERRCODE = 'no_data_found'; END IF;
  IF v_run.status <> 'running' THEN RAISE EXCEPTION 'recon run % is final (%)', p_run, v_run.status USING ERRCODE = 'check_violation'; END IF;

  FOR f IN SELECT e FROM jsonb_array_elements(p_findings) AS t(e) LOOP
    IF jsonb_typeof(f) <> 'object' OR jsonb_typeof(f->'check') IS DISTINCT FROM 'string'
       OR jsonb_typeof(f->'severity') IS DISTINCT FROM 'string' OR jsonb_typeof(f->'subject') IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'malformed finding: %', left(f::text, 200) USING ERRCODE = 'check_violation';
    END IF;
    INSERT INTO recon.findings (run_id, check_name, severity, subject, expected, actual, detail)
    VALUES (p_run, f->>'check', f->>'severity', f->>'subject', f->>'expected', f->>'actual', coalesce(f->'detail', '{}'::jsonb));
  END LOOP;

  SELECT count(*) FILTER (WHERE severity = 'blocking'), count(*) FILTER (WHERE severity = 'warning')
    INTO v_blocking, v_warnings FROM recon.findings WHERE run_id = p_run;
  v_status := CASE WHEN v_blocking > 0 THEN 'failed' ELSE 'passed' END;
  UPDATE recon.runs SET status = v_status, pinned_block = p_pinned_block, finished_at = date_trunc('microseconds', clock_timestamp()),
         blocking = v_blocking, warnings = v_warnings, summary = coalesce(p_summary, '{}'::jsonb)
  WHERE id = p_run;
  PERFORM recon.audit_append(p_actor, 'run.finished', jsonb_build_object('run', p_run, 'status', v_status, 'blocking', v_blocking,
                                                                          'warnings', v_warnings, 'digest', recon.run_digest(p_run)));
  IF v_blocking > 0 THEN
    INSERT INTO recon.gate_events (action, run_id, actor, reason)
    VALUES ('freeze', p_run, p_actor, format('%s blocking finding(s) in run %s', v_blocking, p_run))
    RETURNING id INTO v_event;
    PERFORM recon.audit_append(p_actor, 'gate.freeze', jsonb_build_object('event', v_event, 'run', p_run, 'blocking', v_blocking));
    PERFORM pg_notify('recon_alert', json_build_object('run', p_run, 'blocking', v_blocking, 'frozen', true)::text);
  END IF;
  RETURN v_status;
END $$;

/** A run that could not complete (chain or database unavailable). Does not freeze; R-4 still denies payouts. */
CREATE FUNCTION recon.fail_run(p_run bigint, p_actor text, p_error text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, recon AS $$
BEGIN
  UPDATE recon.runs SET status = 'error', finished_at = date_trunc('microseconds', clock_timestamp()), error = left(coalesce(p_error, 'unknown error'), 1000)
  WHERE id = p_run AND status = 'running';
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM recon.audit_append(p_actor, 'run.finished', jsonb_build_object('run', p_run, 'status', 'error', 'digest', recon.run_digest(p_run)));
  PERFORM pg_notify('recon_alert', json_build_object('run', p_run, 'error', true)::text);
  RETURN true;
END $$;

-- ------------------------------------------------------------------ unfreeze, maker-checker (R-3)
CREATE FUNCTION recon.request_unfreeze(p_operator text, p_reason text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, recon AS $$
DECLARE
  e recon.gate_events;
  v_id bigint;
BEGIN
  IF p_operator IS NULL OR length(p_operator) NOT BETWEEN 2 AND 100 OR p_reason IS NULL OR length(p_reason) NOT BETWEEN 10 AND 500 THEN
    RAISE EXCEPTION 'an operator and a reason of 10 to 500 characters are required' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(586586082);
  SELECT * INTO e FROM recon.gate_events ORDER BY id DESC LIMIT 1;
  IF NOT FOUND OR e.action <> 'freeze' THEN
    RAISE EXCEPTION 'payouts are not frozen' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE recon.unfreeze_requests SET status = 'expired', decided_at = clock_timestamp()
  WHERE status = 'open' AND expires_at < now();
  IF EXISTS (SELECT 1 FROM recon.unfreeze_requests WHERE freeze_event = e.id AND status = 'open') THEN
    RAISE EXCEPTION 'an unfreeze request for this freeze is already open' USING ERRCODE = 'unique_violation';
  END IF;
  INSERT INTO recon.unfreeze_requests (freeze_event, requested_by, reason) VALUES (e.id, p_operator, p_reason) RETURNING id INTO v_id;
  PERFORM recon.audit_append(p_operator, 'unfreeze.requested', jsonb_build_object('request', v_id, 'freezeEvent', e.id, 'reason', p_reason));
  RETURN v_id;
END $$;

/** The checker's decision. Returns the request's resulting status. */
CREATE FUNCTION recon.decide_unfreeze(p_request bigint, p_operator text, p_decision text, p_reason text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, recon AS $$
DECLARE
  q recon.unfreeze_requests;
  e recon.gate_events;
  f recon.gate_events;
  r recon.runs;
  v_event bigint;
BEGIN
  IF p_decision IS NULL OR p_decision NOT IN ('approve', 'reject') THEN
    RAISE EXCEPTION 'decision must be approve or reject' USING ERRCODE = 'check_violation';
  END IF;
  IF p_operator IS NULL OR length(p_operator) NOT BETWEEN 2 AND 100 OR p_reason IS NULL OR length(p_reason) NOT BETWEEN 10 AND 500 THEN
    RAISE EXCEPTION 'an operator and a reason of 10 to 500 characters are required' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(586586082);
  SELECT * INTO q FROM recon.unfreeze_requests WHERE id = p_request FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown unfreeze request %', p_request USING ERRCODE = 'no_data_found'; END IF;
  IF q.status <> 'open' THEN RETURN q.status; END IF;
  IF q.requested_by = p_operator THEN
    RAISE EXCEPTION 'maker-checker: the requester cannot decide their own unfreeze request' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO e FROM recon.gate_events ORDER BY id DESC LIMIT 1;
  IF q.expires_at < now() OR e.id <> q.freeze_event THEN
    UPDATE recon.unfreeze_requests SET status = 'expired', decided_at = clock_timestamp() WHERE id = q.id;
    PERFORM recon.audit_append(p_operator, 'unfreeze.expired', jsonb_build_object('request', q.id,
      'why', CASE WHEN q.expires_at < now() THEN 'request older than 24 hours' ELSE 'payouts were frozen again after the request' END));
    RETURN 'expired';
  END IF;
  IF p_decision = 'reject' THEN
    UPDATE recon.unfreeze_requests SET status = 'rejected', decided_by = p_operator, decision_reason = p_reason, decided_at = clock_timestamp()
    WHERE id = q.id;
    PERFORM recon.audit_append(p_operator, 'unfreeze.rejected', jsonb_build_object('request', q.id, 'reason', p_reason));
    RETURN 'rejected';
  END IF;
  SELECT * INTO f FROM recon.gate_events WHERE id = q.freeze_event;
  SELECT * INTO r FROM recon.runs WHERE status <> 'running' ORDER BY id DESC LIMIT 1;
  IF r.status IS DISTINCT FROM 'passed' OR r.id <= f.run_id THEN
    RAISE EXCEPTION 'unfreezing needs a reconciliation run that passed after run % froze payouts', f.run_id
      USING ERRCODE = 'check_violation';
  END IF;
  UPDATE recon.unfreeze_requests SET status = 'approved', decided_by = p_operator, decision_reason = p_reason, decided_at = clock_timestamp()
  WHERE id = q.id;
  INSERT INTO recon.gate_events (action, request_id, actor, reason)
  VALUES ('unfreeze', q.id, p_operator, left(format('requested by %s: %s; approved: %s', q.requested_by, q.reason, p_reason), 500))
  RETURNING id INTO v_event;
  PERFORM recon.audit_append(p_operator, 'gate.unfreeze', jsonb_build_object('event', v_event, 'request', q.id, 'requestedBy', q.requested_by,
                                                                            'reason', p_reason, 'passedRun', r.id));
  RETURN 'approved';
END $$;

-- ------------------------------------------------------------------ bank statements (R-5)
CREATE TABLE recon.bank_accounts (
  account        text PRIMARY KEY CHECK (account ~ '^[A-Z0-9][A-Z0-9-]{2,39}$'),
  ledger_account text NOT NULL UNIQUE REFERENCES ledger.accounts (code),
  registered_by  text NOT NULL CHECK (length(registered_by) BETWEEN 2 AND 100),
  registered_at  timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER bank_accounts_append_only BEFORE UPDATE OR DELETE ON recon.bank_accounts FOR EACH ROW EXECUTE FUNCTION recon.forbid_change();
CREATE TRIGGER bank_accounts_no_truncate BEFORE TRUNCATE ON recon.bank_accounts FOR EACH STATEMENT EXECUTE FUNCTION recon.forbid_change();

CREATE TABLE recon.bank_statements (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account        text NOT NULL REFERENCES recon.bank_accounts (account),
  statement_date date NOT NULL,
  opening_paisa  bigint NOT NULL,
  closing_paisa  bigint NOT NULL,
  line_count     integer NOT NULL CHECK (line_count BETWEEN 0 AND 100000),
  -- sha256 of the canonical content, computed here: the same content imported twice is the same statement.
  digest         text NOT NULL UNIQUE CHECK (length(digest) = 64 AND digest ~ '^[0-9a-f]+$'),
  imported_by    text NOT NULL CHECK (length(imported_by) BETWEEN 1 AND 100),
  imported_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (account, statement_date)
);

CREATE TABLE recon.bank_lines (
  statement_id  bigint NOT NULL REFERENCES recon.bank_statements (id),
  line_no       integer NOT NULL CHECK (line_no >= 1),
  account       text NOT NULL,
  value_date    date NOT NULL,
  amount_paisa  bigint NOT NULL CHECK (amount_paisa <> 0),
  direction     text NOT NULL GENERATED ALWAYS AS (CASE WHEN amount_paisa > 0 THEN 'in' ELSE 'out' END) STORED,
  reference     text NOT NULL CHECK (length(reference) BETWEEN 4 AND 64 AND reference ~ '^[A-Z0-9][A-Z0-9-]*$'),
  counterparty  text NOT NULL CHECK (length(counterparty) <= 140),
  balance_paisa bigint NOT NULL,
  PRIMARY KEY (statement_id, line_no),
  UNIQUE (account, reference, direction)
);
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['bank_statements', 'bank_lines'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON recon.%I FOR EACH ROW EXECUTE FUNCTION recon.forbid_change()', t || '_append_only', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON recon.%I FOR EACH STATEMENT EXECUTE FUNCTION recon.forbid_change()', t || '_no_truncate', t);
  END LOOP;
END $$;

/** Canonical digest of a statement: account, date, opening, closing and [line_no, value_date, amount, reference, counterparty, balance] lines. */
CREATE FUNCTION recon.statement_digest(p_account text, p_date date, p_opening bigint, p_closing bigint, p_lines jsonb)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT encode(sha256(convert_to(jsonb_build_array(p_account, p_date::text, p_opening::text, p_closing::text, p_lines)::text, 'UTF8')), 'hex')
$$;

CREATE FUNCTION recon.stored_statement_digest(p_statement bigint) RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog, recon AS $$
  SELECT recon.statement_digest(s.account, s.statement_date, s.opening_paisa, s.closing_paisa,
    coalesce((SELECT jsonb_agg(jsonb_build_array(l.line_no, l.value_date::text, l.amount_paisa::text, l.reference, l.counterparty,
                                                 l.balance_paisa::text) ORDER BY l.line_no)
              FROM recon.bank_lines l WHERE l.statement_id = s.id), '[]'::jsonb))
  FROM recon.bank_statements s WHERE s.id = p_statement
$$;

CREATE FUNCTION recon.register_bank_account(p_account text, p_ledger_account text, p_operator text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, recon AS $$
DECLARE
  v recon.bank_accounts;
BEGIN
  SELECT * INTO v FROM recon.bank_accounts WHERE account = p_account;
  IF FOUND THEN
    IF v.ledger_account = p_ledger_account THEN RETURN false; END IF;
    RAISE EXCEPTION 'bank account % is already mapped to another ledger account', p_account USING ERRCODE = 'unique_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM ledger.accounts WHERE code = p_ledger_account AND kind = 'asset' AND asset = 'PKR') THEN
    RAISE EXCEPTION 'ledger account % must exist and be a PKR asset account', p_ledger_account USING ERRCODE = 'foreign_key_violation';
  END IF;
  INSERT INTO recon.bank_accounts (account, ledger_account, registered_by) VALUES (p_account, p_ledger_account, p_operator);
  PERFORM recon.audit_append(p_operator, 'bank.account_registered', jsonb_build_object('account', p_account, 'ledgerAccount', p_ledger_account));
  RETURN true;
END $$;

/**
 * Imports one day's statement (R-5). Returns the statement id; the same content again returns the
 * same id without writing anything. p_lines: [{valueDate, amountPaisa, reference, counterparty, balancePaisa}]
 * in statement order, amounts as integer strings.
 */
CREATE FUNCTION recon.import_bank_statement(
  p_actor text, p_account text, p_date date, p_opening bigint, p_closing bigint, p_lines jsonb
) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, recon AS $$
DECLARE
  v_lines jsonb;
  v_digest text;
  v_existing recon.bank_statements;
  v_id bigint;
  v_bad text;
  v_running bigint := p_opening;
  v_dup text;
  r record;
BEGIN
  IF p_actor IS NULL OR p_account IS NULL OR p_date IS NULL OR p_opening IS NULL OR p_closing IS NULL
     OR p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' THEN
    RAISE EXCEPTION 'actor, account, date, opening, closing and a lines array are required' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM recon.bank_accounts WHERE account = p_account) THEN
    RAISE EXCEPTION 'unknown bank account %; register it first', p_account USING ERRCODE = 'foreign_key_violation';
  END IF;
  SELECT string_agg(ord::text, ',') INTO v_bad
  FROM jsonb_array_elements(p_lines) WITH ORDINALITY AS t(e, ord)
  -- IS DISTINCT FROM, not <>: a missing field gives NULL, which must count as malformed.
  WHERE jsonb_typeof(e) <> 'object'
     OR jsonb_typeof(e->'valueDate') IS DISTINCT FROM 'string' OR (e->>'valueDate') !~ '^\d{4}-\d{2}-\d{2}$'
     OR jsonb_typeof(e->'amountPaisa') IS DISTINCT FROM 'string' OR (e->>'amountPaisa') !~ '^-?[1-9][0-9]{0,17}$'
     OR jsonb_typeof(e->'balancePaisa') IS DISTINCT FROM 'string' OR (e->>'balancePaisa') !~ '^(0|-?[1-9][0-9]{0,17})$'
     OR jsonb_typeof(e->'reference') IS DISTINCT FROM 'string' OR jsonb_typeof(e->'counterparty') IS DISTINCT FROM 'string';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'malformed statement line(s) at position %', v_bad USING ERRCODE = 'check_violation';
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_array(ord, e->>'valueDate', e->>'amountPaisa', e->>'reference', e->>'counterparty', e->>'balancePaisa')
                            ORDER BY ord), '[]'::jsonb)
    INTO v_lines FROM jsonb_array_elements(p_lines) WITH ORDINALITY AS t(e, ord);
  v_digest := recon.statement_digest(p_account, p_date, p_opening, p_closing, v_lines);

  PERFORM pg_advisory_xact_lock(586586083, hashtext(p_account));
  SELECT * INTO v_existing FROM recon.bank_statements WHERE digest = v_digest;
  IF FOUND THEN RETURN v_existing.id; END IF;
  IF EXISTS (SELECT 1 FROM recon.bank_statements WHERE account = p_account AND statement_date = p_date) THEN
    RAISE EXCEPTION 'a different statement for % on % was already imported; corrections need an investigation, not a re-import', p_account, p_date
      USING ERRCODE = 'unique_violation';
  END IF;

  -- Opening + every line = each running balance; the last one = closing.
  FOR r IN SELECT (l->>0)::int AS n, (l->>1)::date AS value_date, (l->>2)::bigint AS amount, (l->>5)::bigint AS balance
           FROM jsonb_array_elements(v_lines) l ORDER BY (l->>0)::int LOOP
    IF r.value_date > p_date THEN
      RAISE EXCEPTION 'line %: value date % is after the statement date %', r.n, r.value_date, p_date USING ERRCODE = 'check_violation';
    END IF;
    v_running := v_running + r.amount;
    IF v_running <> r.balance THEN
      RAISE EXCEPTION 'line %: running balance % does not equal opening plus lines (%)', r.n, r.balance, v_running USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  IF v_running <> p_closing THEN
    RAISE EXCEPTION 'closing balance % does not equal opening plus lines (%)', p_closing, v_running USING ERRCODE = 'check_violation';
  END IF;
  SELECT string_agg(ref, ', ') INTO v_dup FROM (
    SELECT l->>3 AS ref FROM jsonb_array_elements(v_lines) l
    GROUP BY l->>3, (l->>2)::bigint > 0 HAVING count(*) > 1) d;
  IF v_dup IS NOT NULL THEN
    RAISE EXCEPTION 'reference(s) repeated within the statement: %', left(v_dup, 300) USING ERRCODE = 'unique_violation';
  END IF;
  SELECT string_agg(DISTINCT l->>3, ', ') INTO v_dup FROM jsonb_array_elements(v_lines) l
  WHERE EXISTS (SELECT 1 FROM recon.bank_lines b WHERE b.account = p_account AND b.reference = l->>3
                  AND b.direction = CASE WHEN (l->>2)::bigint > 0 THEN 'in' ELSE 'out' END);
  IF v_dup IS NOT NULL THEN
    RAISE EXCEPTION 'reference(s) already imported for %: %', p_account, left(v_dup, 300) USING ERRCODE = 'unique_violation';
  END IF;

  INSERT INTO recon.bank_statements (account, statement_date, opening_paisa, closing_paisa, line_count, digest, imported_by)
  VALUES (p_account, p_date, p_opening, p_closing, jsonb_array_length(v_lines), v_digest, p_actor)
  RETURNING id INTO v_id;
  INSERT INTO recon.bank_lines (statement_id, line_no, account, value_date, amount_paisa, reference, counterparty, balance_paisa)
  SELECT v_id, (l->>0)::int, p_account, (l->>1)::date, (l->>2)::bigint, l->>3, l->>4, (l->>5)::bigint
  FROM jsonb_array_elements(v_lines) l;
  PERFORM recon.audit_append(p_actor, 'bank.imported', jsonb_build_object('statement', v_id, 'account', p_account, 'date', p_date::text,
                                                                         'lines', jsonb_array_length(v_lines), 'digest', v_digest));
  RETURN v_id;
END $$;

-- ------------------------------------------------------------------ R-6 verification
CREATE FUNCTION recon.verify_audit() RETURNS TABLE (audit_id bigint, problem text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, recon AS $$
DECLARE
  a recon.audit;
  v_prev bytea := decode(repeat('00', 32), 'hex');
  r record;
BEGIN
  FOR a IN SELECT * FROM recon.audit ORDER BY id LOOP
    IF a.prev_hash <> v_prev THEN audit_id := a.id; problem := 'prev_hash does not match'; RETURN NEXT; END IF;
    IF a.hash <> recon.audit_digest(a.prev_hash, a.id, a.at, a.actor, a.action, a.detail) THEN
      audit_id := a.id; problem := 'content does not match its hash'; RETURN NEXT;
    END IF;
    IF a.action = 'run.finished' AND recon.run_digest((a.detail->>'run')::bigint) IS DISTINCT FROM a.detail->>'digest' THEN
      audit_id := a.id; problem := format('run %s or its findings changed after it finished', a.detail->>'run'); RETURN NEXT;
    END IF;
    IF a.action = 'bank.imported' AND recon.stored_statement_digest((a.detail->>'statement')::bigint) IS DISTINCT FROM a.detail->>'digest' THEN
      audit_id := a.id; problem := format('bank statement %s changed after import', a.detail->>'statement'); RETURN NEXT;
    END IF;
    v_prev := a.hash;
  END LOOP;
  -- Rows that exist without the audit entry their API function always writes: inserted directly.
  FOR r IN SELECT g.id FROM recon.gate_events g WHERE NOT EXISTS (
             SELECT 1 FROM recon.audit x WHERE x.action IN ('gate.freeze', 'gate.unfreeze') AND (x.detail->>'event')::bigint = g.id) LOOP
    audit_id := NULL; problem := format('gate event %s has no audit entry', r.id); RETURN NEXT;
  END LOOP;
  FOR r IN SELECT x.id FROM recon.runs x WHERE x.status <> 'running' AND NOT EXISTS (
             SELECT 1 FROM recon.audit y WHERE y.action = 'run.finished' AND (y.detail->>'run')::bigint = x.id) LOOP
    audit_id := NULL; problem := format('run %s has no audit entry', r.id); RETURN NEXT;
  END LOOP;
  FOR r IN SELECT s.id FROM recon.bank_statements s WHERE NOT EXISTS (
             SELECT 1 FROM recon.audit y WHERE y.action = 'bank.imported' AND (y.detail->>'statement')::bigint = s.id) LOOP
    audit_id := NULL; problem := format('bank statement %s has no audit entry', r.id); RETURN NEXT;
  END LOOP;
END $$;

-- ------------------------------------------------------------------ privileges (R-7)
REVOKE ALL ON ALL TABLES IN SCHEMA recon FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA recon FROM PUBLIC;

GRANT USAGE ON SCHEMA recon TO pt_recon_writer, pt_recon_operator, pt_recon_reader, pt_signer, pt_outbox_worker;
GRANT EXECUTE ON FUNCTION
  recon.start_run(text, text, jsonb),
  recon.complete_run(bigint, text, bigint, jsonb, jsonb),
  recon.fail_run(bigint, text, text)
  TO pt_recon_writer;
GRANT EXECUTE ON FUNCTION recon.import_bank_statement(text, text, date, bigint, bigint, jsonb) TO pt_recon_writer, pt_recon_operator;
GRANT EXECUTE ON FUNCTION
  recon.register_bank_account(text, text, text),
  recon.request_unfreeze(text, text),
  recon.decide_unfreeze(bigint, text, text, text)
  TO pt_recon_operator;
GRANT EXECUTE ON FUNCTION recon.verify_audit() TO pt_recon_writer, pt_recon_operator, pt_recon_reader;
GRANT EXECUTE ON FUNCTION recon.payout_gate(), recon.payouts_allowed()
  TO pt_recon_writer, pt_recon_operator, pt_recon_reader, pt_signer, pt_outbox_worker;
GRANT SELECT ON ALL TABLES IN SCHEMA recon TO pt_recon_writer, pt_recon_operator, pt_recon_reader;

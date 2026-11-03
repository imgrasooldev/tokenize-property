-- Transaction monitoring (PT Control compliance, roadmap 2026-11-03 item 1). Applies on top of 0050.
--
--   TM-1  compliance.tm_rules: four rules that look at an investor's money movements, each with its
--         thresholds. Every threshold is a PLACEHOLDER until the MLRO confirms it; the page says so.
--           structuring             several subscription payments just below a threshold in a short window
--           rapid_in_out            money in, then most of it back out (refund or exit request) soon after
--           income_band             payments in a year above the investor's declared annual income
--           payout_account_changes  many payout accounts registered in a short window
--   TM-2  compliance.tm_income: the declared annual income band of an investor, recorded by a
--         compliance officer (append-only; the newest row counts). No band, no income_band alert.
--   TM-3  compliance.tm_check(subject, actor) evaluates the enabled rules for one investor and opens
--         at most one alert per rule for a window that does not overlap an earlier alert of that rule
--         (no repeats while the pattern grows). It runs in the same transaction as a matched credit,
--         a refund, an exit request and a new payout account (triggers), and never makes that
--         transaction fail: an error is audited and the money movement goes on. compliance.tm_sweep
--         checks every investor (after a threshold change); officers run it from the portal.
--   TM-4  An alert is a candidate, not a report: open -> escalated (an STR case is opened in the same
--         transaction and linked), open -> dismiss_proposed -> dismissed (a second officer: nobody
--         buries a suspicion alone) or back to open. Evidence, window, thresholds and summary never
--         change; alerts are never deleted; events are append-only.
--   TM-5  Tipping-off: alerts are visible to compliance.read only (compliance officers, auditors) and
--         never change the investor's status. Evidence holds references and amounts only: no name,
--         CNIC or IBAN (C-6).
--   TM-6  Changes go through admin.* functions (compliance.decide, step-up for decisions), with
--         officer handles bound to the session (C-7) and every write appended to compliance.audit and
--         admin.audit.

-- ================================================================== TM-1 rules
CREATE TABLE compliance.tm_rules (
  code        text PRIMARY KEY CHECK (code IN ('structuring', 'rapid_in_out', 'income_band', 'payout_account_changes')),
  label       text NOT NULL CHECK (length(label) BETWEEN 5 AND 120),
  str_category text NOT NULL,
  params      jsonb NOT NULL CHECK (jsonb_typeof(params) = 'object'),
  enabled     boolean NOT NULL DEFAULT true,
  placeholder boolean NOT NULL DEFAULT true,
  updated_by  text NOT NULL DEFAULT 'migration:0051',
  updated_at  timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  applies_to  text NOT NULL DEFAULT 'str' CHECK (applies_to = 'str'),
  FOREIGN KEY (str_category, applies_to) REFERENCES compliance.reason_codes (code, applies_to)
);

-- Placeholder thresholds (paisa; Rs 1 = 100 paisa) until the MLRO confirms them.
INSERT INTO compliance.tm_rules (code, label, str_category, params) VALUES
  ('structuring', 'Several payments just below a threshold', 'structuring',
   '{"thresholdPaisa": 200000000, "bandPercent": 80, "minCount": 3, "windowDays": 7}'),
  ('rapid_in_out', 'Money in, then most of it out again soon after', 'rapid_in_out',
   '{"windowDays": 30, "outPercent": 80, "minInPaisa": 10000000}'),
  ('income_band', 'Payments above the declared annual income', 'unusual_pattern',
   '{"lookbackDays": 365, "percentOfIncome": 100}'),
  ('payout_account_changes', 'Many payout accounts in a short time', 'unusual_pattern',
   '{"windowDays": 180, "maxAccounts": 2}');

/** The whole-number parameters each rule needs, with their allowed range. */
CREATE FUNCTION compliance.tm_param_spec(p_rule text) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT CASE p_rule
    WHEN 'structuring' THEN '{"thresholdPaisa": [100, 100000000000000], "bandPercent": [1, 99], "minCount": [2, 100], "windowDays": [1, 90]}'::jsonb
    WHEN 'rapid_in_out' THEN '{"windowDays": [1, 365], "outPercent": [1, 100], "minInPaisa": [0, 100000000000000]}'::jsonb
    WHEN 'income_band' THEN '{"lookbackDays": [30, 730], "percentOfIncome": [10, 1000]}'::jsonb
    WHEN 'payout_account_changes' THEN '{"windowDays": [1, 730], "maxAccounts": [1, 20]}'::jsonb
  END
$$;

/** Exactly the parameters of the rule, each a whole number in its range. */
CREATE FUNCTION compliance.tm_params_ok(p_rule text, p jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT p IS NOT NULL AND jsonb_typeof(p) = 'object' AND compliance.tm_param_spec(p_rule) IS NOT NULL
     AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) = (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(compliance.tm_param_spec(p_rule)) k)
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_each(compliance.tm_param_spec(p_rule)) s
        WHERE jsonb_typeof(p->s.key) <> 'number' OR (p->>s.key) !~ '^[0-9]{1,15}$'
           OR (p->>s.key)::bigint NOT BETWEEN (s.value->>0)::bigint AND (s.value->>1)::bigint)
$$;
ALTER TABLE compliance.tm_rules ADD CHECK (compliance.tm_params_ok(code, params));

-- ================================================================== TM-2 declared income
CREATE TABLE compliance.tm_income (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subject_id        uuid NOT NULL REFERENCES kyc.subjects (id),
  annual_max_paisa  bigint NOT NULL CHECK (annual_max_paisa > 0 AND annual_max_paisa <= 100000000000000),
  recorded_by       text NOT NULL CHECK (length(recorded_by) BETWEEN 2 AND 100),
  reason            text NOT NULL CHECK (compliance.free_text_ok(reason, 10, 500)),
  at                timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp())
);
CREATE INDEX tm_income_subject_idx ON compliance.tm_income (subject_id, id DESC);
CREATE TRIGGER tm_income_append_only BEFORE UPDATE OR DELETE ON compliance.tm_income FOR EACH ROW EXECUTE FUNCTION compliance.forbid_change();

-- ================================================================== TM-4 alerts
CREATE TABLE compliance.tm_alerts (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  rule                text NOT NULL REFERENCES compliance.tm_rules (code),
  subject_id          uuid NOT NULL REFERENCES kyc.subjects (id),
  window_from         timestamptz NOT NULL,
  window_to           timestamptz NOT NULL CHECK (window_to >= window_from),
  amount_paisa        bigint NOT NULL CHECK (amount_paisa >= 0),
  evidence            jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'array' AND jsonb_array_length(evidence) BETWEEN 1 AND 200),
  params              jsonb NOT NULL CHECK (jsonb_typeof(params) = 'object'),
  summary             text NOT NULL CHECK (compliance.free_text_ok(summary, 20, 500)),
  status              text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'dismiss_proposed', 'dismissed', 'escalated')),
  opened_by           text NOT NULL CHECK (length(opened_by) BETWEEN 2 AND 100),
  opened_at           timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  updated_at          timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  dismiss_proposed_by text CHECK (length(dismiss_proposed_by) BETWEEN 2 AND 100),
  dismiss_reason      text CHECK (dismiss_reason IS NULL OR compliance.free_text_ok(dismiss_reason, 10, 500)),
  dismissed_by        text CHECK (length(dismissed_by) BETWEEN 2 AND 100),
  escalated_by        text CHECK (length(escalated_by) BETWEEN 2 AND 100),
  str_case_id         bigint UNIQUE REFERENCES compliance.str_cases (id),
  finished_at         timestamptz,
  CHECK ((status IN ('dismiss_proposed', 'dismissed')) = (dismiss_proposed_by IS NOT NULL AND dismiss_reason IS NOT NULL)),
  CHECK ((status = 'dismissed') = (dismissed_by IS NOT NULL)),
  CHECK ((status = 'escalated') = (escalated_by IS NOT NULL AND str_case_id IS NOT NULL)),
  CHECK ((status IN ('dismissed', 'escalated')) = (finished_at IS NOT NULL)),
  -- TM-4: dismissing needs a second officer, also against a direct UPDATE.
  CHECK (dismissed_by IS NULL OR dismissed_by <> dismiss_proposed_by)
);
CREATE INDEX tm_alerts_subject_idx ON compliance.tm_alerts (subject_id, rule, window_to DESC);
CREATE INDEX tm_alerts_status_idx ON compliance.tm_alerts (status, id DESC);

CREATE FUNCTION compliance.guard_tm_alert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'monitoring alerts are never deleted' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF OLD.status IN ('dismissed', 'escalated') THEN RAISE EXCEPTION 'monitoring alert % is %', OLD.id, OLD.status USING ERRCODE = 'check_violation'; END IF;
  IF (NEW.id, NEW.rule, NEW.subject_id, NEW.window_from, NEW.window_to, NEW.amount_paisa, NEW.evidence, NEW.params, NEW.summary, NEW.opened_by, NEW.opened_at)
     IS DISTINCT FROM (OLD.id, OLD.rule, OLD.subject_id, OLD.window_from, OLD.window_to, OLD.amount_paisa, OLD.evidence, OLD.params, OLD.summary, OLD.opened_by, OLD.opened_at) THEN
    RAISE EXCEPTION 'monitoring alert %: what was detected never changes', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status <> OLD.status AND (OLD.status || '>' || NEW.status) NOT IN (
       'open>escalated', 'open>dismiss_proposed', 'dismiss_proposed>dismissed', 'dismiss_proposed>open', 'dismiss_proposed>escalated') THEN
    RAISE EXCEPTION 'monitoring alert %: % -> % is not allowed', OLD.id, OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := date_trunc('microseconds', clock_timestamp());
  RETURN NEW;
END $$;
CREATE TRIGGER tm_alerts_guard BEFORE UPDATE OR DELETE ON compliance.tm_alerts FOR EACH ROW EXECUTE FUNCTION compliance.guard_tm_alert();

CREATE TABLE compliance.tm_alert_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  alert_id    bigint NOT NULL REFERENCES compliance.tm_alerts (id),
  action      text NOT NULL CHECK (action IN ('opened', 'escalate', 'propose_dismiss', 'confirm_dismiss', 'decline_dismiss')),
  from_status text,
  to_status   text NOT NULL,
  actor       text NOT NULL CHECK (length(actor) BETWEEN 2 AND 100),
  reason      text NOT NULL CHECK (compliance.free_text_ok(reason, 2, 2000)),
  at          timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp())
);
CREATE INDEX tm_alert_events_alert_idx ON compliance.tm_alert_events (alert_id, id);
CREATE TRIGGER tm_alert_events_append_only BEFORE UPDATE OR DELETE ON compliance.tm_alert_events FOR EACH ROW EXECUTE FUNCTION compliance.forbid_change();

CREATE TRIGGER tm_rules_officer_binding BEFORE INSERT OR UPDATE ON compliance.tm_rules FOR EACH ROW EXECUTE FUNCTION compliance.bind_actor('updated_by', 'updated_by');
CREATE TRIGGER tm_income_officer_binding BEFORE INSERT ON compliance.tm_income FOR EACH ROW EXECUTE FUNCTION compliance.bind_actor('recorded_by');
CREATE TRIGGER tm_alerts_officer_binding BEFORE INSERT OR UPDATE ON compliance.tm_alerts
  FOR EACH ROW EXECUTE FUNCTION compliance.bind_actor('opened_by', 'dismiss_proposed_by', 'dismissed_by', 'escalated_by');
CREATE TRIGGER tm_alert_events_officer_binding BEFORE INSERT ON compliance.tm_alert_events FOR EACH ROW EXECUTE FUNCTION compliance.bind_actor('actor');

CREATE FUNCTION compliance.tm_alert_digest(p_alert bigint) RETURNS bytea
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, compliance AS $$
  SELECT sha256(convert_to('pt-tm-alert-v1' || jsonb_build_array(a.id, a.status, a.rule, a.subject_id, a.dismiss_proposed_by, compliance.utc(a.updated_at))::text, 'UTF8'))
  FROM compliance.tm_alerts a WHERE a.id = p_alert
$$;

-- ================================================================== TM-3 detection
/** One rule for one investor: the window, amount and evidence of a hit, or no row. */
CREATE FUNCTION compliance.tm_detect(p_rule text, p_params jsonb, p_subject uuid)
RETURNS TABLE (window_from timestamptz, window_to timestamptz, amount_paisa bigint, evidence jsonb, summary text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, compliance AS $$
DECLARE
  v_days integer;
BEGIN
  IF p_rule = 'structuring' THEN
    v_days := (p_params->>'windowDays')::integer;
    -- For each matched credit: the credits of the window ending there that sit just below the threshold.
    RETURN QUERY
    WITH c AS (
      SELECT cr.raast_ref, cr.amount_paisa, cr.booked_at FROM bank.credits cr JOIN bank.payment_intents i ON i.code = cr.intent_code
       WHERE i.subject_id = p_subject AND cr.status = 'matched'
         AND cr.amount_paisa < (p_params->>'thresholdPaisa')::bigint
         AND cr.amount_paisa * 100 >= (p_params->>'thresholdPaisa')::bigint * (p_params->>'bandPercent')::bigint),
    w AS (
      SELECT e.booked_at AS t_end, min(x.booked_at) AS t_start, count(*) AS n, sum(x.amount_paisa)::bigint AS total,
             jsonb_agg(jsonb_build_object('kind', 'credit', 'ref', x.raast_ref, 'at', compliance.utc(x.booked_at), 'amountPaisa', x.amount_paisa::text) ORDER BY x.booked_at) AS ev
        FROM c e JOIN c x ON x.booked_at BETWEEN e.booked_at - make_interval(days => v_days) AND e.booked_at
       GROUP BY e.booked_at)
    SELECT w.t_start, w.t_end, w.total, w.ev,
           format('%s payments just below the threshold within %s days', w.n, v_days)
      FROM w WHERE w.n >= (p_params->>'minCount')::bigint ORDER BY w.t_end DESC LIMIT 1;

  ELSIF p_rule = 'rapid_in_out' THEN
    v_days := (p_params->>'windowDays')::integer;
    RETURN QUERY
    WITH inn AS (
      SELECT cr.raast_ref, cr.amount_paisa, cr.booked_at FROM bank.credits cr JOIN bank.payment_intents i ON i.code = cr.intent_code
       WHERE i.subject_id = p_subject AND cr.status = 'matched' AND cr.amount_paisa >= (p_params->>'minInPaisa')::bigint),
    outs AS (
      SELECT 'refund'::text AS kind, cr.raast_ref || '-R' AS ref, cr.amount_paisa::numeric AS amount, r.at
        FROM bank.credit_refunds r JOIN bank.credits cr ON cr.raast_ref = r.raast_ref JOIN bank.payment_intents i ON i.code = cr.intent_code
       WHERE i.subject_id = p_subject
      UNION ALL
      SELECT 'exit_request', q.id::text, q.indicative_paisa, q.created_at FROM exit.requests q
       WHERE q.subject_id = p_subject AND q.status <> 'withdrawn'),
    hit AS (
      SELECT n.raast_ref, n.amount_paisa, n.booked_at,
             (SELECT coalesce(sum(o.amount), 0) FROM outs o WHERE o.at > n.booked_at AND o.at <= n.booked_at + make_interval(days => v_days)) AS out_total,
             (SELECT max(o.at) FROM outs o WHERE o.at > n.booked_at AND o.at <= n.booked_at + make_interval(days => v_days)) AS last_out,
             (SELECT jsonb_agg(jsonb_build_object('kind', o.kind, 'ref', o.ref, 'at', compliance.utc(o.at), 'amountPaisa', o.amount::text) ORDER BY o.at)
                FROM outs o WHERE o.at > n.booked_at AND o.at <= n.booked_at + make_interval(days => v_days)) AS ev
        FROM inn n)
    SELECT h.booked_at, h.last_out, least(h.out_total, 9223372036854775807)::bigint,
           jsonb_build_array(jsonb_build_object('kind', 'credit', 'ref', h.raast_ref, 'at', compliance.utc(h.booked_at), 'amountPaisa', h.amount_paisa::text)) || h.ev,
           format('%s %% of a payment went out again within %s days', (h.out_total * 100 / h.amount_paisa)::bigint, v_days)
      FROM hit h WHERE h.out_total * 100 >= h.amount_paisa::numeric * (p_params->>'outPercent')::bigint
     ORDER BY h.booked_at DESC LIMIT 1;

  ELSIF p_rule = 'income_band' THEN
    v_days := (p_params->>'lookbackDays')::integer;
    RETURN QUERY
    WITH band AS (SELECT annual_max_paisa FROM compliance.tm_income WHERE subject_id = p_subject ORDER BY id DESC LIMIT 1),
    c AS (
      SELECT cr.raast_ref, cr.amount_paisa, cr.booked_at FROM bank.credits cr JOIN bank.payment_intents i ON i.code = cr.intent_code
       WHERE i.subject_id = p_subject AND cr.status = 'matched' AND cr.booked_at > clock_timestamp() - make_interval(days => v_days))
    SELECT min(c.booked_at), max(c.booked_at), sum(c.amount_paisa)::bigint,
           jsonb_agg(jsonb_build_object('kind', 'credit', 'ref', c.raast_ref, 'at', compliance.utc(c.booked_at), 'amountPaisa', c.amount_paisa::text) ORDER BY c.booked_at)
             || jsonb_build_array(jsonb_build_object('kind', 'declared_income', 'ref', 'tm_income', 'amountPaisa', (SELECT annual_max_paisa FROM band)::text)),
           format('payments of %s days are above %s %% of the declared annual income', v_days, p_params->>'percentOfIncome')
      FROM c
    HAVING count(*) > 0 AND (SELECT annual_max_paisa FROM band) IS NOT NULL
       AND sum(c.amount_paisa) * 100 > (SELECT annual_max_paisa FROM band)::numeric * (p_params->>'percentOfIncome')::bigint;

  ELSIF p_rule = 'payout_account_changes' THEN
    v_days := (p_params->>'windowDays')::integer;
    RETURN QUERY
    SELECT min(p.registered_at), max(p.registered_at), 0::bigint,
           jsonb_agg(jsonb_build_object('kind', 'payout_account', 'ref', 'payee:' || p.id, 'at', compliance.utc(p.registered_at), 'last4', p.iban_last4) ORDER BY p.registered_at),
           format('%s payout accounts registered within %s days', count(*), v_days)
      FROM bank.payees p
     WHERE p.subject_id = p_subject AND p.registered_at > clock_timestamp() - make_interval(days => v_days)
    HAVING count(*) > (p_params->>'maxAccounts')::bigint;
  END IF;
END $$;

/** TM-3: the enabled rules for one investor; opens new alerts and returns how many. */
CREATE FUNCTION compliance.tm_check(p_subject uuid, p_actor text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, compliance AS $$
DECLARE
  r compliance.tm_rules;
  d record;
  v_id bigint;
  v_opened integer := 0;
BEGIN
  IF p_subject IS NULL THEN RETURN 0; END IF;
  FOR r IN SELECT * FROM compliance.tm_rules WHERE enabled ORDER BY code LOOP
    FOR d IN SELECT * FROM compliance.tm_detect(r.code, r.params, p_subject) LOOP
      -- No repeat while the same pattern goes on: a window that overlaps an earlier alert of the rule.
      CONTINUE WHEN EXISTS (SELECT 1 FROM compliance.tm_alerts a WHERE a.subject_id = p_subject AND a.rule = r.code AND a.window_to >= d.window_from);
      INSERT INTO compliance.tm_alerts (rule, subject_id, window_from, window_to, amount_paisa, evidence, params, summary, opened_by)
      VALUES (r.code, p_subject, d.window_from, d.window_to, d.amount_paisa, d.evidence, r.params, d.summary, p_actor)
      RETURNING id INTO v_id;
      INSERT INTO compliance.tm_alert_events (alert_id, action, from_status, to_status, actor, reason) VALUES (v_id, 'opened', NULL, 'open', p_actor, d.summary);
      PERFORM compliance.audit_append(p_actor, 'tm.opened', jsonb_build_object('alert', v_id, 'rule', r.code, 'subject', p_subject));
      v_opened := v_opened + 1;
    END LOOP;
  END LOOP;
  RETURN v_opened;
END $$;

/** TM-3: every investor with a money movement (after a threshold change, or by hand). */
CREATE FUNCTION compliance.tm_sweep(p_actor text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, compliance AS $$
DECLARE
  v_subject uuid;
  v_opened integer := 0;
BEGIN
  FOR v_subject IN
    SELECT i.subject_id FROM bank.credits c JOIN bank.payment_intents i ON i.code = c.intent_code WHERE i.subject_id IS NOT NULL
    UNION SELECT subject_id FROM bank.payees
    UNION SELECT subject_id FROM exit.requests
  LOOP
    v_opened := v_opened + compliance.tm_check(v_subject, p_actor);
  END LOOP;
  PERFORM compliance.audit_append(p_actor, 'tm.swept', jsonb_build_object('opened', v_opened));
  RETURN v_opened;
END $$;

/** TM-3: the money movement is never refused because of monitoring; a failure is audited instead. */
CREATE FUNCTION compliance.tm_on_movement() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, compliance AS $$
DECLARE
  v_subject uuid;
BEGIN
  -- One branch per table: a record field of another table must never be read.
  IF TG_TABLE_NAME = 'credits' THEN
    SELECT subject_id INTO v_subject FROM bank.payment_intents WHERE code = NEW.intent_code;
  ELSIF TG_TABLE_NAME = 'credit_refunds' THEN
    SELECT i.subject_id INTO v_subject FROM bank.credits c JOIN bank.payment_intents i ON i.code = c.intent_code WHERE c.raast_ref = NEW.raast_ref;
  ELSE
    v_subject := NEW.subject_id;
  END IF;
  IF v_subject IS NULL THEN RETURN NULL; END IF;
  BEGIN
    PERFORM compliance.tm_check(v_subject, 'monitor:' || TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME);
  EXCEPTION WHEN OTHERS THEN
    PERFORM compliance.audit_append('monitor:' || TG_TABLE_NAME, 'tm.failed', jsonb_build_object('subject', v_subject, 'error', left(SQLERRM, 300)));
  END;
  RETURN NULL;
END $$;
CREATE TRIGGER credits_tm AFTER INSERT ON bank.credits FOR EACH ROW WHEN (NEW.status = 'matched') EXECUTE FUNCTION compliance.tm_on_movement();
CREATE TRIGGER credit_refunds_tm AFTER INSERT ON bank.credit_refunds FOR EACH ROW EXECUTE FUNCTION compliance.tm_on_movement();
CREATE TRIGGER exit_requests_tm AFTER INSERT ON exit.requests FOR EACH ROW EXECUTE FUNCTION compliance.tm_on_movement();
CREATE TRIGGER payees_tm AFTER INSERT ON bank.payees FOR EACH ROW EXECUTE FUNCTION compliance.tm_on_movement();

-- ================================================================== TM-4 decisions
CREATE FUNCTION compliance.tm_alert_act(p_alert bigint, p_actor text, p_action text, p_reason text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, compliance AS $$
DECLARE
  a compliance.tm_alerts;
  v_to text;
  v_str bigint;
BEGIN
  SELECT * INTO a FROM compliance.tm_alerts WHERE id = p_alert FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown monitoring alert' USING ERRCODE = 'no_data_found'; END IF;
  IF NOT compliance.free_text_ok(p_reason, 10, 500) THEN
    RAISE EXCEPTION 'a reason of 10 to 500 characters is required (never a CNIC, IBAN or phone number)' USING ERRCODE = 'check_violation';
  END IF;
  IF p_action = 'escalate' AND a.status IN ('open', 'dismiss_proposed') THEN
    v_str := compliance.open_str(a.subject_id, (SELECT str_category FROM compliance.tm_rules WHERE code = a.rule),
                                 left(format('Monitoring alert %s (%s): %s. %s', a.id, a.rule, a.summary, btrim(p_reason)), 2000), p_actor);
    UPDATE compliance.tm_alerts SET status = 'escalated', escalated_by = p_actor, str_case_id = v_str, finished_at = clock_timestamp(),
           dismiss_proposed_by = NULL, dismiss_reason = NULL WHERE id = a.id;
    v_to := 'escalated';
  ELSIF p_action = 'propose_dismiss' AND a.status = 'open' THEN
    UPDATE compliance.tm_alerts SET status = 'dismiss_proposed', dismiss_proposed_by = p_actor, dismiss_reason = btrim(p_reason) WHERE id = a.id;
    v_to := 'dismiss_proposed';
  ELSIF p_action = 'confirm_dismiss' AND a.status = 'dismiss_proposed' THEN
    IF a.dismiss_proposed_by = p_actor THEN
      RAISE EXCEPTION 'a second officer confirms the dismissal (nobody dismisses a suspicion alone)' USING ERRCODE = 'insufficient_privilege';
    END IF;
    UPDATE compliance.tm_alerts SET status = 'dismissed', dismissed_by = p_actor, finished_at = clock_timestamp() WHERE id = a.id;
    v_to := 'dismissed';
  ELSIF p_action = 'decline_dismiss' AND a.status = 'dismiss_proposed' THEN
    UPDATE compliance.tm_alerts SET status = 'open', dismiss_proposed_by = NULL, dismiss_reason = NULL WHERE id = a.id;
    v_to := 'open';
  ELSE
    RAISE EXCEPTION 'monitoring alert % is %: % is not possible', a.id, a.status, coalesce(p_action, '-') USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO compliance.tm_alert_events (alert_id, action, from_status, to_status, actor, reason) VALUES (a.id, p_action, a.status, v_to, p_actor, btrim(p_reason));
  PERFORM compliance.audit_append(p_actor, 'tm.' || p_action, jsonb_build_object('alert', a.id, 'from', a.status, 'to', v_to, 'str', v_str));
  RETURN v_to;
END $$;

-- ================================================================== portal API (TM-5, TM-6)
CREATE FUNCTION admin.tm_alert_json(a compliance.tm_alerts) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
  SELECT jsonb_build_object('id', a.id, 'rule', a.rule, 'ruleLabel', (SELECT label FROM compliance.tm_rules WHERE code = a.rule), 'status', a.status,
    'subject', left(replace(a.subject_id::text, '-', ''), 8), 'windowFrom', admin.utc(a.window_from), 'windowTo', admin.utc(a.window_to),
    'amountPaisa', a.amount_paisa::text, 'summary', a.summary, 'openedBy', a.opened_by, 'openedAt', admin.utc(a.opened_at), 'updatedAt', admin.utc(a.updated_at),
    'dismissProposedBy', a.dismiss_proposed_by, 'dismissReason', a.dismiss_reason, 'dismissedBy', a.dismissed_by, 'escalatedBy', a.escalated_by,
    'strCase', a.str_case_id, 'overdue', a.status IN ('open', 'dismiss_proposed') AND clock_timestamp() - a.updated_at > interval '72 hours')
$$;

/** The monitoring desk: rules with their thresholds, the alert queue and the latest closed alerts. */
CREATE FUNCTION admin.tm_desk(p_session bytea) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'compliance.read');
BEGIN
  RETURN jsonb_build_object(
    'rules', (SELECT jsonb_agg(jsonb_build_object('code', r.code, 'label', r.label, 'strCategory', r.str_category, 'params', r.params, 'spec', compliance.tm_param_spec(r.code),
               'enabled', r.enabled, 'placeholder', r.placeholder, 'updatedBy', r.updated_by, 'updatedAt', admin.utc(r.updated_at)) ORDER BY r.code)
              FROM compliance.tm_rules r),
    'open', coalesce((SELECT jsonb_agg(admin.tm_alert_json(a) ORDER BY a.id DESC) FROM compliance.tm_alerts a WHERE a.status IN ('open', 'dismiss_proposed')), '[]'::jsonb),
    'closed', coalesce((SELECT jsonb_agg(admin.tm_alert_json(a) ORDER BY a.id DESC)
                        FROM (SELECT * FROM compliance.tm_alerts WHERE status IN ('dismissed', 'escalated') ORDER BY id DESC LIMIT 100) a), '[]'::jsonb));
END $$;

/** One alert with its evidence, history, the investor (masked) and the decision digest. */
CREATE FUNCTION admin.tm_alert(p_session bytea, p_id bigint) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'compliance.read');
  v_handle text := admin.handle_of(v_me);
  v_base text[] := '{}';
  a compliance.tm_alerts;
BEGIN
  SELECT * INTO a FROM compliance.tm_alerts WHERE id = p_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF NOT admin.has_permission(p_session, 'compliance.decide') THEN v_base := v_base || 'Only a compliance officer acts on monitoring alerts; your role reads them.'::text; END IF;
  IF a.status IN ('dismissed', 'escalated') THEN v_base := v_base || format('The alert is %s.', a.status); END IF;
  RETURN admin.tm_alert_json(a) || jsonb_build_object(
    'blockers', jsonb_build_object(
      'escalate', to_jsonb(v_base),
      'propose_dismiss', to_jsonb(v_base || CASE WHEN a.status = 'dismiss_proposed' THEN ARRAY['Dismissing is already proposed.'] ELSE '{}'::text[] END),
      'confirm_dismiss', to_jsonb(v_base || CASE WHEN a.status = 'open' THEN ARRAY['Nothing is waiting for a second officer.'] ELSE '{}'::text[] END
                                 || CASE WHEN a.status = 'dismiss_proposed' AND a.dismiss_proposed_by = v_handle THEN ARRAY['You proposed dismissing: a different compliance officer confirms (maker-checker).'] ELSE '{}'::text[] END),
      'decline_dismiss', to_jsonb(v_base || CASE WHEN a.status = 'open' THEN ARRAY['Nothing is waiting for a second officer.'] ELSE '{}'::text[] END
                                 || CASE WHEN a.status = 'dismiss_proposed' AND a.dismiss_proposed_by = v_handle THEN ARRAY['You proposed dismissing: a different compliance officer declines (maker-checker).'] ELSE '{}'::text[] END)),
    'evidence', a.evidence, 'params', a.params, 'investor', admin.subject_json(a.subject_id),
    'declaredIncomePaisa', (SELECT annual_max_paisa::text FROM compliance.tm_income WHERE subject_id = a.subject_id ORDER BY id DESC LIMIT 1),
    'events', coalesce((SELECT jsonb_agg(jsonb_build_object('action', e.action, 'from', e.from_status, 'to', e.to_status, 'actor', e.actor, 'reason', e.reason, 'at', admin.utc(e.at)) ORDER BY e.id)
                        FROM compliance.tm_alert_events e WHERE e.alert_id = a.id), '[]'::jsonb),
    'digest', encode(compliance.tm_alert_digest(a.id), 'hex'));
END $$;

/** TM-4 through the portal: one compliance officer per step, step-up, bound handle, the digest of what they saw. */
CREATE FUNCTION admin.tm_alert_act(p_session bytea, p_alert bigint, p_action text, p_reason text, p_digest bytea) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'compliance.decide');
  v_handle text := admin.handle_of(v_me);
  v_to text;
  v_str bigint;
BEGIN
  PERFORM admin.require_step_up(p_session);
  IF p_digest IS DISTINCT FROM compliance.tm_alert_digest(p_alert) THEN
    RETURN admin.refuse(v_me, 'tm', coalesce(p_alert::text, '-'), coalesce(p_action, '-'), 'the alert changed while you were reading it: reload and check again');
  END IF;
  BEGIN
    PERFORM admin.bind_officer(v_handle);
    v_to := compliance.tm_alert_act(p_alert, v_handle, p_action, p_reason);
    PERFORM admin.unbind_officer(v_handle);
  EXCEPTION WHEN SQLSTATE '23514' OR SQLSTATE '23505' OR SQLSTATE '42501' OR SQLSTATE '22023' OR SQLSTATE 'P0002' OR SQLSTATE '23503' THEN
    RETURN admin.refuse(v_me, 'tm', coalesce(p_alert::text, '-'), coalesce(p_action, '-'), SQLERRM);
  END;
  SELECT str_case_id INTO v_str FROM compliance.tm_alerts WHERE id = p_alert;
  PERFORM admin.audit_append(v_me::text, 'compliance.tm_act', jsonb_build_object('alert', p_alert, 'action', p_action, 'to', v_to));
  RETURN jsonb_build_object('ok', true, 'status', v_to, 'strCase', v_str);
END $$;

/** TM-1: a compliance officer changes a rule's thresholds or switches it (no longer a placeholder). */
CREATE FUNCTION admin.tm_rule_set(p_session bytea, p_rule text, p_params jsonb, p_enabled boolean, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'compliance.decide');
  v_handle text := admin.handle_of(v_me);
  v_old compliance.tm_rules;
BEGIN
  PERFORM admin.require_step_up(p_session);
  IF NOT admin.reason_ok(p_reason) THEN RETURN admin.refuse(v_me, 'tm_rule', coalesce(p_rule, '-'), 'set', 'a reason of 10 to 500 characters is required'); END IF;
  SELECT * INTO v_old FROM compliance.tm_rules WHERE code = p_rule;
  IF NOT FOUND THEN RETURN admin.refuse(v_me, 'tm_rule', coalesce(p_rule, '-'), 'set', 'unknown monitoring rule'); END IF;
  IF p_enabled IS NULL OR NOT compliance.tm_params_ok(p_rule, p_params) THEN
    RETURN admin.refuse(v_me, 'tm_rule', p_rule, 'set', 'every threshold of the rule is required, as a whole number in its range');
  END IF;
  PERFORM admin.bind_officer(v_handle);
  UPDATE compliance.tm_rules SET params = p_params, enabled = p_enabled, placeholder = false, updated_by = v_handle, updated_at = clock_timestamp() WHERE code = p_rule;
  PERFORM admin.unbind_officer(v_handle);
  PERFORM compliance.audit_append(v_handle, 'tm.rule_set', jsonb_build_object('rule', p_rule, 'from', v_old.params, 'to', p_params,
    'enabledFrom', v_old.enabled, 'enabledTo', p_enabled, 'reason', btrim(p_reason)));
  PERFORM admin.audit_append(v_me::text, 'compliance.tm_rule_set', jsonb_build_object('rule', p_rule, 'enabled', p_enabled));
  RETURN jsonb_build_object('ok', true, 'status', 'saved');
END $$;

/** TM-2: a compliance officer records an investor's declared annual income band. */
CREATE FUNCTION admin.tm_set_income(p_session bytea, p_subject uuid, p_annual_max_paisa bigint, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'compliance.decide');
  v_handle text := admin.handle_of(v_me);
BEGIN
  PERFORM admin.require_step_up(p_session);
  IF NOT admin.reason_ok(p_reason) OR NOT compliance.free_text_ok(p_reason, 10, 500) THEN
    RETURN admin.refuse(v_me, 'tm_income', coalesce(p_subject::text, '-'), 'set', 'a reason of 10 to 500 characters is required (never a CNIC, IBAN or phone number)');
  END IF;
  IF p_subject IS NULL OR NOT EXISTS (SELECT 1 FROM kyc.subjects WHERE id = p_subject) THEN RETURN admin.refuse(v_me, 'tm_income', '-', 'set', 'unknown investor'); END IF;
  IF p_annual_max_paisa IS NULL OR p_annual_max_paisa NOT BETWEEN 1 AND 100000000000000 THEN
    RETURN admin.refuse(v_me, 'tm_income', p_subject::text, 'set', 'an annual income above zero is required');
  END IF;
  PERFORM admin.bind_officer(v_handle);
  INSERT INTO compliance.tm_income (subject_id, annual_max_paisa, recorded_by, reason) VALUES (p_subject, p_annual_max_paisa, v_handle, btrim(p_reason));
  PERFORM admin.unbind_officer(v_handle);
  PERFORM compliance.audit_append(v_handle, 'tm.income_set', jsonb_build_object('subject', p_subject, 'annualMaxPaisa', p_annual_max_paisa::text));
  PERFORM admin.audit_append(v_me::text, 'compliance.tm_income_set', jsonb_build_object('subject', p_subject));
  RETURN jsonb_build_object('ok', true, 'status', 'saved', 'opened', compliance.tm_check(p_subject, 'monitor:income'));
END $$;

/** TM-3 by hand: check every investor now (for example after a threshold change). */
CREATE FUNCTION admin.tm_sweep(p_session bytea) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'compliance.decide');
  v_opened integer;
BEGIN
  v_opened := compliance.tm_sweep('monitor:sweep:' || admin.handle_of(v_me));
  PERFORM admin.audit_append(v_me::text, 'compliance.tm_sweep', jsonb_build_object('opened', v_opened));
  RETURN jsonb_build_object('ok', true, 'status', 'swept', 'opened', v_opened);
END $$;

REVOKE ALL ON TABLE compliance.tm_rules, compliance.tm_income, compliance.tm_alerts, compliance.tm_alert_events FROM PUBLIC;
REVOKE ALL ON FUNCTION compliance.tm_param_spec(text), compliance.tm_params_ok(text, jsonb), compliance.tm_detect(text, jsonb, uuid), compliance.tm_check(uuid, text),
  compliance.tm_sweep(text), compliance.tm_on_movement(), compliance.tm_alert_act(bigint, text, text, text), compliance.tm_alert_digest(bigint), compliance.guard_tm_alert(),
  admin.tm_alert_json(compliance.tm_alerts), admin.tm_desk(bytea), admin.tm_alert(bytea, bigint), admin.tm_alert_act(bytea, bigint, text, text, bytea),
  admin.tm_rule_set(bytea, text, jsonb, boolean, text), admin.tm_set_income(bytea, uuid, bigint, text), admin.tm_sweep(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.tm_desk(bytea), admin.tm_alert(bytea, bigint), admin.tm_alert_act(bytea, bigint, text, text, bytea),
  admin.tm_rule_set(bytea, text, jsonb, boolean, text), admin.tm_set_income(bytea, uuid, bigint, text), admin.tm_sweep(bytea) TO pt_admin_portal;

-- Operations health and alerting in PT Control (roadmap 2026-11-03 item 2). Applies on top of 0051.
--
--   MH-1  monitor.db_checks(): the database part of deploy/ops/pt-health.sh, live: indexer cursors
--         (halted, stale), outbox (expired leases, review, old pending), signer approvals waiting,
--         the reconciliation payout gate (frozen, error, age), anchoring (age, failures, open) and
--         notification producer failures. Thresholds in monitor.settings (the script's defaults).
--   MH-2  monitor.record_report(host, text): pt-health.sh --record hands over its lines for what only
--         the server sees (validators, disk, memory, swap, units, HTTP, backups). Lines about the
--         database checks are skipped (MH-1 has them live). A missing or old report is itself a check.
--   MH-3  monitor.evaluate(actor): one alert per failing check, opened on WARN or CRIT, raised when
--         WARN becomes CRIT (the acknowledgement is cleared then), resolved when the check is OK
--         again. Runs with every recorded report and on "Check now" in the portal. Alerts and their
--         events are never deleted; reports older than 30 days are pruned.
--   MH-4  PT Control /health (ops.read): every check with its level and since when, open alerts,
--         recent history. Operations makers and checkers and the platform owner acknowledge an
--         alert with a note (new permission ops.acknowledge); auditors and compliance read only.
--   MH-5  Content rule of the ops pack: states, counts, ages and block numbers only; never a name,
--         CNIC, IBAN, wallet-to-person link or secret. Details are cut to 300 characters.

CREATE SCHEMA IF NOT EXISTS monitor;
REVOKE ALL ON SCHEMA monitor FROM PUBLIC;

CREATE TABLE monitor.settings (
  key         text PRIMARY KEY,
  value       integer NOT NULL CHECK (value BETWEEN 1 AND 1000000),
  description text NOT NULL CHECK (length(description) BETWEEN 5 AND 200)
);
INSERT INTO monitor.settings (key, value, description) VALUES
  ('indexer_stale_warn_s', 300, 'indexer cursor not updated for this many seconds: WARN'),
  ('indexer_stale_crit_s', 1800, 'indexer cursor not updated for this many seconds: CRIT'),
  ('outbox_lease_stuck_min', 10, 'outbox command with a lease expired this many minutes ago: CRIT'),
  ('outbox_pending_warn_min', 15, 'outbox command pending for this many minutes: WARN'),
  ('signer_pending_warn_min', 60, 'signing request waiting for approval this many minutes: WARN'),
  ('recon_max_age_h', 26, 'last reconciliation run older than this many hours: WARN'),
  ('anchor_warn_min', 150, 'last confirmed anchor older than this many minutes: WARN'),
  ('anchor_crit_min', 360, 'last confirmed anchor older than this many minutes: CRIT'),
  ('report_stale_min', 15, 'no server health report for this many minutes: WARN'),
  ('notify_failures_24h_warn', 1, 'notification producer failures in 24 hours from this count: WARN');

CREATE FUNCTION monitor.setting(p_key text) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, monitor AS $$
  SELECT value FROM monitor.settings WHERE key = p_key
$$;

/** MH-5: a detail fit for an alert: no control characters, at most 300 characters. */
CREATE FUNCTION monitor.clean(p text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT left(btrim(regexp_replace(coalesce(p, ''), '[[:cntrl:]]+', ' ', 'g')), 300)
$$;

-- ================================================================== MH-2 server reports
CREATE TABLE monitor.reports (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  host        text NOT NULL CHECK (host ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$'),
  received_at timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  lines       jsonb NOT NULL CHECK (jsonb_typeof(lines) = 'array' AND jsonb_array_length(lines) <= 200)
);
CREATE INDEX reports_host_idx ON monitor.reports (host, id DESC);

-- ================================================================== MH-3 alerts
CREATE TABLE monitor.alerts (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  check_key       text NOT NULL CHECK (length(check_key) BETWEEN 2 AND 120),
  level           text NOT NULL CHECK (level IN ('WARN', 'CRIT')),
  detail          text NOT NULL CHECK (length(detail) <= 300),
  opened_at       timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  last_seen_at    timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  acknowledged_by text CHECK (length(acknowledged_by) BETWEEN 2 AND 100),
  acknowledged_at timestamptz,
  ack_note        text CHECK (ack_note IS NULL OR length(btrim(ack_note)) BETWEEN 5 AND 300),
  resolved_at     timestamptz,
  CHECK ((acknowledged_by IS NULL) = (acknowledged_at IS NULL) AND (acknowledged_by IS NULL) = (ack_note IS NULL))
);
CREATE UNIQUE INDEX alerts_one_open ON monitor.alerts (check_key) WHERE resolved_at IS NULL;
CREATE INDEX alerts_recent_idx ON monitor.alerts (id DESC);

CREATE FUNCTION monitor.guard_alert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'alerts are never deleted' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF OLD.resolved_at IS NOT NULL THEN RAISE EXCEPTION 'alert % is resolved', OLD.id USING ERRCODE = 'check_violation'; END IF;
  IF (NEW.id, NEW.check_key, NEW.opened_at) IS DISTINCT FROM (OLD.id, OLD.check_key, OLD.opened_at) THEN
    RAISE EXCEPTION 'alert %: the check and the opening never change', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER alerts_guard BEFORE UPDATE OR DELETE ON monitor.alerts FOR EACH ROW EXECUTE FUNCTION monitor.guard_alert();

CREATE TABLE monitor.alert_events (
  id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  alert_id bigint NOT NULL REFERENCES monitor.alerts (id),
  action   text NOT NULL CHECK (action IN ('opened', 'raised', 'lowered', 'resolved', 'acknowledged')),
  level    text CHECK (level IN ('WARN', 'CRIT')),
  actor    text NOT NULL CHECK (length(actor) BETWEEN 2 AND 100),
  note     text CHECK (length(note) <= 300),
  at       timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp())
);
CREATE INDEX alert_events_alert_idx ON monitor.alert_events (alert_id, id);

CREATE FUNCTION monitor.forbid_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'monitor events are append-only' USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER alert_events_append_only BEFORE UPDATE OR DELETE ON monitor.alert_events FOR EACH ROW EXECUTE FUNCTION monitor.forbid_change();

CREATE FUNCTION monitor.bind_actor() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, monitor AS $$
BEGIN
  -- One branch per table: a record field of the other table must never be read.
  IF TG_TABLE_NAME = 'alerts' THEN
    PERFORM admin.guard_officer_name(NEW.acknowledged_by, 'monitor.alerts by');
  ELSE
    PERFORM admin.guard_officer_name(NEW.actor, 'monitor.alert_events by');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER alerts_officer_binding BEFORE INSERT OR UPDATE OF acknowledged_by ON monitor.alerts FOR EACH ROW EXECUTE FUNCTION monitor.bind_actor();
CREATE TRIGGER alert_events_officer_binding BEFORE INSERT ON monitor.alert_events FOR EACH ROW EXECUTE FUNCTION monitor.bind_actor();

-- ================================================================== MH-1 database checks
CREATE FUNCTION monitor.db_checks() RETURNS TABLE (check_key text, level text, detail text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, monitor AS $$
DECLARE
  r record;
  v_now timestamptz := clock_timestamp();
BEGIN
  -- Indexer: one check per deployment cursor.
  IF to_regclass('chain.cursors') IS NOT NULL THEN
    FOR r IN EXECUTE 'SELECT deployment, block_number, halted_at, halt_reason, extract(epoch FROM $1 - updated_at)::bigint AS age FROM chain.cursors ORDER BY deployment' USING v_now LOOP
      check_key := 'indexer:' || r.deployment;
      IF r.halted_at IS NOT NULL THEN
        level := 'CRIT'; detail := format('HALTED at block %s (%s); see docs/runbooks/indexer-halt.md', r.block_number, monitor.clean(r.halt_reason));
      ELSIF r.age > monitor.setting('indexer_stale_crit_s') THEN
        level := 'CRIT'; detail := format('cursor %s not updated for %s s (worker not running?)', r.block_number, r.age);
      ELSIF r.age > monitor.setting('indexer_stale_warn_s') THEN
        level := 'WARN'; detail := format('cursor %s not updated for %s s', r.block_number, r.age);
      ELSE
        level := 'OK'; detail := format('cursor %s, updated %s s ago', r.block_number, r.age);
      END IF;
      RETURN NEXT;
    END LOOP;
  END IF;

  -- Outbox: stuck leases, review, old pending.
  check_key := 'outbox';
  IF to_regclass('outbox.commands') IS NULL THEN
    level := 'N/A'; detail := 'not migrated here';
  ELSE
    EXECUTE 'SELECT count(*) FILTER (WHERE status = ''review'') AS review,
                    count(*) FILTER (WHERE status IN (''claimed'', ''submitted'') AND lease_until < $1 - make_interval(mins => $2)) AS stuck,
                    count(*) FILTER (WHERE status = ''pending'' AND available_at < $1 - make_interval(mins => $3)) AS old,
                    count(*) FILTER (WHERE status IN (''pending'', ''claimed'', ''submitted'')) AS open
               FROM outbox.commands WHERE status IN (''pending'', ''claimed'', ''submitted'', ''review'')'
      INTO r USING v_now, monitor.setting('outbox_lease_stuck_min'), monitor.setting('outbox_pending_warn_min');
    IF r.stuck > 0 THEN level := 'CRIT'; detail := format('%s command(s) with an expired lease (worker died mid-send?)', r.stuck);
    ELSIF r.review > 0 THEN level := 'WARN'; detail := format('%s command(s) in review (operator decision needed)', r.review);
    ELSIF r.old > 0 THEN level := 'WARN'; detail := format('%s pending command(s) older than %s min (worker not running?)', r.old, monitor.setting('outbox_pending_warn_min'));
    ELSE level := 'OK'; detail := format('%s open, none stuck', r.open);
    END IF;
  END IF;
  RETURN NEXT;

  -- Signer: requests waiting for an approval.
  check_key := 'signer';
  IF to_regclass('signer.requests') IS NULL THEN
    level := 'N/A'; detail := 'not migrated here';
  ELSE
    EXECUTE 'SELECT count(*) AS n, coalesce(extract(epoch FROM $1 - min(created_at))::bigint, 0) AS oldest FROM signer.requests WHERE status = ''pending_approval'''
      INTO r USING v_now;
    IF r.n > 0 AND r.oldest > monitor.setting('signer_pending_warn_min') * 60 THEN
      level := 'WARN'; detail := format('%s request(s) waiting for approval, oldest %s min', r.n, r.oldest / 60);
    ELSE
      level := 'OK'; detail := format('%s pending approval(s)', r.n);
    END IF;
  END IF;
  RETURN NEXT;

  -- Reconciliation and the payout gate.
  check_key := 'recon';
  IF to_regprocedure('recon.payout_gate()') IS NULL THEN
    level := 'N/A'; detail := 'not migrated here';
  ELSE
    EXECUTE 'SELECT allowed, frozen, last_status, extract(epoch FROM $1 - last_finished)::bigint AS age, reason FROM recon.payout_gate()' INTO r USING v_now;
    IF r.frozen THEN level := 'CRIT'; detail := format('payouts FROZEN (%s); see docs/runbooks/reconciliation-freeze.md', monitor.clean(r.reason));
    ELSIF r.last_status IS NULL THEN level := 'WARN'; detail := 'no reconciliation run yet; payouts not allowed';
    ELSIF r.last_status = 'error' THEN level := 'CRIT'; detail := format('last run ended in error %s h ago; payouts not allowed', r.age / 3600);
    ELSIF r.age > monitor.setting('recon_max_age_h') * 3600 THEN level := 'WARN'; detail := format('last run %s h old; payouts not allowed until a new passed run', r.age / 3600);
    ELSIF r.allowed THEN level := 'OK'; detail := format('last run %s %s h ago, payouts allowed', r.last_status, r.age / 3600);
    ELSE level := 'WARN'; detail := format('payouts not allowed (last run %s, %s)', r.last_status, monitor.clean(r.reason));
    END IF;
  END IF;
  RETURN NEXT;

  -- Anchoring.
  check_key := 'anchor';
  IF to_regclass('anchor.anchors') IS NULL THEN
    level := 'N/A'; detail := 'not migrated here';
  ELSE
    EXECUTE 'SELECT count(*) AS n, extract(epoch FROM $1 - max(confirmed_at))::bigint AS age,
                    count(*) FILTER (WHERE status = ''failed'' AND created_at > $1 - interval ''24 hours'') AS failed,
                    count(*) FILTER (WHERE status IN (''recorded'', ''sent'') AND created_at < $1 - interval ''30 minutes'') AS open
               FROM anchor.anchors' INTO r USING v_now;
    IF r.n = 0 THEN level := 'N/A'; detail := 'no anchors recorded (job not running here)';
    ELSIF r.age IS NULL OR r.age > monitor.setting('anchor_crit_min') * 60 THEN level := 'CRIT'; detail := format('last confirmed anchor %s min ago', coalesce((r.age / 60)::text, 'never'));
    ELSIF r.failed > 0 THEN level := 'WARN'; detail := format('%s failed anchor(s) in the last 24 h; see docs/runbooks/anchor-alarm.md', r.failed);
    ELSIF r.open > 0 THEN level := 'WARN'; detail := 'an anchor is open > 30 min (not confirmed)';
    ELSIF r.age > monitor.setting('anchor_warn_min') * 60 THEN level := 'WARN'; detail := format('last confirmed anchor %s min ago', r.age / 60);
    ELSE level := 'OK'; detail := format('last confirmed anchor %s min ago', r.age / 60);
    END IF;
  END IF;
  RETURN NEXT;

  -- Notification producers (a failure is kept, the business action went on).
  check_key := 'notify';
  IF to_regclass('notify.producer_failures') IS NULL THEN
    level := 'N/A'; detail := 'not migrated here';
  ELSE
    EXECUTE 'SELECT count(*) AS n FROM notify.producer_failures WHERE at > $1 - interval ''24 hours''' INTO r USING v_now;
    IF r.n >= monitor.setting('notify_failures_24h_warn') THEN level := 'WARN'; detail := format('%s producer failure(s) in the last 24 h', r.n);
    ELSE level := 'OK'; detail := 'no producer failure in the last 24 h';
    END IF;
  END IF;
  RETURN NEXT;
END $$;

/** MH-2: the latest report of each host, as checks; an old or missing report is a check of its own. */
CREATE FUNCTION monitor.host_checks() RETURNS TABLE (check_key text, level text, detail text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, monitor AS $$
DECLARE
  r record;
  v_age bigint;
BEGIN
  FOR r IN SELECT DISTINCT ON (host) host, received_at, lines FROM monitor.reports ORDER BY host, id DESC LOOP
    v_age := extract(epoch FROM clock_timestamp() - r.received_at)::bigint;
    check_key := 'report:' || r.host;
    IF v_age > monitor.setting('report_stale_min') * 60 THEN
      level := 'WARN'; detail := format('last health report %s min ago (pt-health timer not running?)', v_age / 60);
    ELSE
      level := 'OK'; detail := format('last health report %s s ago', v_age);
    END IF;
    RETURN NEXT;
    RETURN QUERY SELECT 'host:' || r.host || ':' || (l->>'check'), l->>'level', l->>'detail' FROM jsonb_array_elements(r.lines) l;
  END LOOP;
END $$;

/** Every check now: the database's own and the hosts' latest reports. */
CREATE FUNCTION monitor.checks() RETURNS TABLE (source text, check_key text, level text, detail text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, monitor AS $$
  SELECT 'database', d.check_key, d.level, d.detail FROM monitor.db_checks() d
  UNION ALL
  SELECT 'server', h.check_key, h.level, h.detail FROM monitor.host_checks() h
$$;

/** MH-3: opens, raises, lowers and resolves alerts to match the checks; returns how many alerts changed. */
CREATE FUNCTION monitor.evaluate(p_actor text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, monitor AS $$
DECLARE
  c record;
  a monitor.alerts;
  v_changed integer := 0;
  v_failing text[] := '{}';
BEGIN
  PERFORM pg_advisory_xact_lock(586586052);
  FOR c IN SELECT * FROM monitor.checks() LOOP
    IF c.level NOT IN ('WARN', 'CRIT') THEN CONTINUE; END IF;
    v_failing := v_failing || c.check_key;
    SELECT * INTO a FROM monitor.alerts WHERE check_key = c.check_key AND resolved_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN
      INSERT INTO monitor.alerts (check_key, level, detail) VALUES (c.check_key, c.level, monitor.clean(c.detail)) RETURNING * INTO a;
      INSERT INTO monitor.alert_events (alert_id, action, level, actor, note) VALUES (a.id, 'opened', c.level, p_actor, monitor.clean(c.detail));
      v_changed := v_changed + 1;
    ELSIF a.level <> c.level THEN
      -- A CRIT that was WARN must be seen again: the acknowledgement does not carry over.
      UPDATE monitor.alerts SET level = c.level, detail = monitor.clean(c.detail), last_seen_at = clock_timestamp(),
             acknowledged_by = CASE WHEN c.level = 'CRIT' THEN NULL ELSE acknowledged_by END,
             acknowledged_at = CASE WHEN c.level = 'CRIT' THEN NULL ELSE acknowledged_at END,
             ack_note = CASE WHEN c.level = 'CRIT' THEN NULL ELSE ack_note END
       WHERE id = a.id;
      INSERT INTO monitor.alert_events (alert_id, action, level, actor, note)
      VALUES (a.id, CASE WHEN c.level = 'CRIT' THEN 'raised' ELSE 'lowered' END, c.level, p_actor, monitor.clean(c.detail));
      v_changed := v_changed + 1;
    ELSE
      UPDATE monitor.alerts SET detail = monitor.clean(c.detail), last_seen_at = clock_timestamp() WHERE id = a.id;
    END IF;
  END LOOP;
  FOR a IN SELECT * FROM monitor.alerts WHERE resolved_at IS NULL AND NOT (check_key = ANY (v_failing)) FOR UPDATE LOOP
    UPDATE monitor.alerts SET resolved_at = clock_timestamp() WHERE id = a.id;
    INSERT INTO monitor.alert_events (alert_id, action, level, actor, note) VALUES (a.id, 'resolved', NULL, p_actor, NULL);
    v_changed := v_changed + 1;
  END LOOP;
  RETURN v_changed;
END $$;

/**
 * MH-2: pt-health.sh --record. `p_text` holds the script's lines ("LEVEL check: detail"); lines
 * about the database checks are skipped (MH-1 has them live). Then the alerts are evaluated.
 */
CREATE FUNCTION monitor.record_report(p_host text, p_text text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, monitor AS $$
DECLARE
  v_lines jsonb;
  v_id bigint;
BEGIN
  IF p_host IS NULL OR p_host !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$' THEN
    RAISE EXCEPTION 'a host name of letters, digits, dot, dash or underscore is required' USING ERRCODE = 'check_violation';
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('level', m[1], 'check', left(btrim(m[2]), 80), 'detail', monitor.clean(m[3])) ORDER BY n), '[]'::jsonb)
    INTO v_lines
    FROM (SELECT regexp_match(line, '^(OK|WARN|CRIT|N/A)\s+(.{1,80}?):\s(.*)$') AS m, n
            FROM regexp_split_to_table(coalesce(p_text, ''), '\r?\n') WITH ORDINALITY AS t(line, n)) x
   WHERE m IS NOT NULL AND btrim(m[2]) !~ '^(postgres|indexer|outbox|signer|recon|anchor)\M';
  IF jsonb_array_length(v_lines) > 200 THEN RAISE EXCEPTION 'at most 200 health lines per report' USING ERRCODE = 'check_violation'; END IF;
  INSERT INTO monitor.reports (host, lines) VALUES (p_host, v_lines) RETURNING id INTO v_id;
  DELETE FROM monitor.reports WHERE received_at < clock_timestamp() - interval '30 days';
  RETURN jsonb_build_object('report', v_id, 'lines', jsonb_array_length(v_lines), 'changed', monitor.evaluate('monitor:' || p_host));
END $$;

-- ================================================================== MH-4 portal
INSERT INTO admin.role_permissions (role, permission) VALUES
  ('ops_maker', 'ops.acknowledge'), ('ops_checker', 'ops.acknowledge'), ('platform_owner', 'ops.acknowledge');

-- The role matrix changed: pin its new digest (admin.verify_audit compares against it).
DO $$
BEGIN
  EXECUTE format('CREATE OR REPLACE FUNCTION admin.expected_role_matrix_digest() RETURNS text LANGUAGE sql IMMUTABLE AS %L',
                 format('SELECT %L::text', admin.role_matrix_digest()));
END $$;

CREATE FUNCTION admin.monitor_alert_json(a monitor.alerts) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
  SELECT jsonb_build_object('id', a.id, 'check', a.check_key, 'level', a.level, 'detail', a.detail, 'openedAt', admin.utc(a.opened_at),
    'lastSeenAt', admin.utc(a.last_seen_at), 'acknowledgedBy', a.acknowledged_by, 'acknowledgedAt', admin.utc(a.acknowledged_at),
    'ackNote', a.ack_note, 'resolvedAt', admin.utc(a.resolved_at))
$$;

/** The health page: every check, the open alerts, the last 50 closed ones and the thresholds. */
CREATE FUNCTION admin.health(p_session bytea) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'ops.read');
BEGIN
  RETURN jsonb_build_object(
    'at', admin.utc(clock_timestamp()),
    'checks', coalesce((SELECT jsonb_agg(jsonb_build_object('source', c.source, 'check', c.check_key, 'level', c.level, 'detail', c.detail,
                 'since', (SELECT admin.utc(a.opened_at) FROM monitor.alerts a WHERE a.check_key = c.check_key AND a.resolved_at IS NULL))
               ORDER BY c.source, c.check_key) FROM monitor.checks() c), '[]'::jsonb),
    'open', coalesce((SELECT jsonb_agg(admin.monitor_alert_json(a) ORDER BY (a.level = 'CRIT') DESC, a.id DESC) FROM monitor.alerts a WHERE a.resolved_at IS NULL), '[]'::jsonb),
    'closed', coalesce((SELECT jsonb_agg(admin.monitor_alert_json(a) ORDER BY a.id DESC)
                        FROM (SELECT * FROM monitor.alerts WHERE resolved_at IS NOT NULL ORDER BY id DESC LIMIT 50) a), '[]'::jsonb),
    'reports', coalesce((SELECT jsonb_agg(jsonb_build_object('host', r.host, 'at', admin.utc(r.received_at)) ORDER BY r.host)
                         FROM (SELECT DISTINCT ON (host) host, received_at FROM monitor.reports ORDER BY host, id DESC) r), '[]'::jsonb),
    'settings', (SELECT jsonb_agg(jsonb_build_object('key', key, 'value', value, 'description', description) ORDER BY key) FROM monitor.settings),
    'canAcknowledge', admin.has_permission(p_session, 'ops.acknowledge'));
END $$;

/** "Check now": evaluates the alerts against the current checks (it only opens, raises, lowers or resolves). */
CREATE FUNCTION admin.health_refresh(p_session bytea) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'ops.read');
BEGIN
  RETURN jsonb_build_object('ok', true, 'status', 'checked', 'opened', monitor.evaluate('monitor:portal'));
END $$;

/** MH-4: an operations officer acknowledges an open alert with a note (bound handle, audited). */
CREATE FUNCTION admin.health_acknowledge(p_session bytea, p_alert bigint, p_note text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'ops.acknowledge');
  v_handle text := admin.handle_of(v_me);
  a monitor.alerts;
BEGIN
  IF p_note IS NULL OR length(btrim(p_note)) NOT BETWEEN 5 AND 300 THEN
    RETURN admin.refuse(v_me, 'health', coalesce(p_alert::text, '-'), 'acknowledge', 'a note of 5 to 300 characters is required');
  END IF;
  SELECT * INTO a FROM monitor.alerts WHERE id = p_alert FOR UPDATE;
  IF NOT FOUND OR a.resolved_at IS NOT NULL THEN
    RETURN admin.refuse(v_me, 'health', coalesce(p_alert::text, '-'), 'acknowledge', 'this alert is not open');
  END IF;
  IF a.acknowledged_by IS NOT NULL THEN
    RETURN admin.refuse(v_me, 'health', p_alert::text, 'acknowledge', format('already acknowledged by %s', a.acknowledged_by));
  END IF;
  PERFORM admin.bind_officer(v_handle);
  UPDATE monitor.alerts SET acknowledged_by = v_handle, acknowledged_at = clock_timestamp(), ack_note = btrim(p_note) WHERE id = a.id;
  INSERT INTO monitor.alert_events (alert_id, action, level, actor, note) VALUES (a.id, 'acknowledged', a.level, v_handle, monitor.clean(p_note));
  PERFORM admin.unbind_officer(v_handle);
  PERFORM admin.audit_append(v_me::text, 'health.acknowledged', jsonb_build_object('alert', a.id, 'check', a.check_key, 'level', a.level));
  RETURN jsonb_build_object('ok', true, 'status', 'acknowledged');
END $$;

REVOKE ALL ON TABLE monitor.settings, monitor.reports, monitor.alerts, monitor.alert_events FROM PUBLIC;
REVOKE ALL ON FUNCTION monitor.setting(text), monitor.clean(text), monitor.db_checks(), monitor.host_checks(), monitor.checks(), monitor.evaluate(text),
  monitor.record_report(text, text), monitor.guard_alert(), monitor.forbid_change(), monitor.bind_actor(),
  admin.monitor_alert_json(monitor.alerts), admin.health(bytea), admin.health_refresh(bytea), admin.health_acknowledge(bytea, bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.health(bytea), admin.health_refresh(bytea), admin.health_acknowledge(bytea, bigint, text) TO pt_admin_portal;

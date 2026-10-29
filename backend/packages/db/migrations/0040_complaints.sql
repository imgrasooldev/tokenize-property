-- Investor complaints (later features: complaints system). Applies on top of 0039.
--
--   CP-1  A signed-in investor files a complaint on the website (category, title, description); it
--         gets a reference (CMP-XXXXXXXX), an acknowledgement deadline and a resolution deadline
--         from complaints.settings (PLACEHOLDERS: 2 and 15 calendar days; LEGAL TO CONFIRM against
--         the SECP complaint-handling rules). The session gives the investor (never a parameter).
--   CP-2  The conversation is append-only messages (investor or officer); free text refuses CNIC,
--         IBAN and phone numbers (compliance.free_text_ok) so personal data does not spread into
--         it. Every status change is an event in the case history, which both sides see.
--   CP-3  PT Control: complaints.read lists and reads cases (support, operations, compliance,
--         auditors, platform owner); complaints.handle (support agents, operations makers)
--         acknowledges, replies, resolves (with a resolution summary) and refers a case to
--         compliance. Officers act under their own handle with a fresh step-up; refusals audited.
--   CP-4  The investor may reply while the case is open, and accept a resolution (closed) or reopen
--         it within 7 days of the resolution. A referred case reads "under review" on the website
--         and nothing else (no tipping-off).
--   CP-5  Cases and events cannot be rewritten (guard triggers); messages and events are append-only.

CREATE SCHEMA complaints;
REVOKE ALL ON SCHEMA complaints FROM PUBLIC;

CREATE TABLE complaints.settings (
  key   text PRIMARY KEY,
  value integer NOT NULL CHECK (value BETWEEN 1 AND 90),
  note  text NOT NULL
);
INSERT INTO complaints.settings (key, value, note) VALUES
  ('ack_days', 2, 'acknowledge within N calendar days (PLACEHOLDER, LEGAL TO CONFIRM)'),
  ('resolve_days', 15, 'resolve within N calendar days (PLACEHOLDER, LEGAL TO CONFIRM)'),
  ('reopen_days', 7, 'the investor may reopen a resolved case within N days');

CREATE TABLE complaints.cases (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ref           text NOT NULL UNIQUE CHECK (ref ~ '^CMP-[0-9A-F]{8}$'),
  investor_id   uuid NOT NULL REFERENCES webdemo.investors (id),
  category      text NOT NULL CHECK (category IN ('payment', 'payout', 'tax', 'account', 'offering', 'transfer', 'website', 'other')),
  title         text NOT NULL CHECK (length(title) BETWEEN 5 AND 120),
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved', 'closed', 'referred')),
  created_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  ack_due       timestamptz NOT NULL,
  resolve_due   timestamptz NOT NULL,
  acknowledged_at timestamptz,
  resolved_at   timestamptz,
  resolution    text CHECK (resolution IS NULL OR length(resolution) BETWEEN 10 AND 1000),
  closed_at     timestamptz,
  CHECK ((status = 'resolved') <= (resolved_at IS NOT NULL AND resolution IS NOT NULL))
);
CREATE INDEX cases_investor ON complaints.cases (investor_id, id DESC);
CREATE INDEX cases_status ON complaints.cases (status, resolve_due);

CREATE TABLE complaints.messages (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  case_id     bigint NOT NULL REFERENCES complaints.cases (id),
  author_kind text NOT NULL CHECK (author_kind IN ('investor', 'officer')),
  author      text NOT NULL CHECK (length(author) BETWEEN 2 AND 100),
  body        text NOT NULL CHECK (length(body) BETWEEN 2 AND 2000),
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX messages_case ON complaints.messages (case_id, id);

CREATE TABLE complaints.events (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  case_id    bigint NOT NULL REFERENCES complaints.cases (id),
  action     text NOT NULL CHECK (action IN ('filed', 'acknowledged', 'replied', 'resolved', 'closed', 'reopened', 'referred')),
  actor      text NOT NULL CHECK (length(actor) BETWEEN 2 AND 100),
  at         timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX events_case ON complaints.events (case_id, id);

CREATE FUNCTION complaints.append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER messages_append_only BEFORE UPDATE OR DELETE ON complaints.messages FOR EACH ROW EXECUTE FUNCTION complaints.append_only();
CREATE TRIGGER events_append_only BEFORE UPDATE OR DELETE ON complaints.events FOR EACH ROW EXECUTE FUNCTION complaints.append_only();

/** A case's identity, text and deadlines never change; only the status fields move forward. */
CREATE FUNCTION complaints.guard_case() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' OR (NEW.ref, NEW.investor_id, NEW.category, NEW.title, NEW.created_at, NEW.ack_due, NEW.resolve_due)
     IS DISTINCT FROM (OLD.ref, OLD.investor_id, OLD.category, OLD.title, OLD.created_at, OLD.ack_due, OLD.resolve_due) THEN
    RAISE EXCEPTION 'a complaint''s identity, text and deadlines never change' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cases_guard BEFORE UPDATE OR DELETE ON complaints.cases FOR EACH ROW EXECUTE FUNCTION complaints.guard_case();

CREATE FUNCTION complaints.setting(p_key text) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, complaints AS $$
  SELECT value FROM complaints.settings WHERE key = p_key
$$;

/** CP-2: free text without CNIC, IBAN or phone numbers. */
CREATE FUNCTION complaints.check_text(p text, p_min integer, p_max integer) RETURNS void
LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $$
BEGIN
  IF p IS NULL OR length(btrim(p)) NOT BETWEEN p_min AND p_max THEN
    RAISE EXCEPTION 'text of % to % characters is required', p_min, p_max USING ERRCODE = 'check_violation';
  END IF;
  IF NOT compliance.free_text_ok(btrim(p), p_min, p_max) THEN
    RAISE EXCEPTION 'please leave out CNIC, bank account and phone numbers' USING ERRCODE = 'check_violation';
  END IF;
END $$;

/** What the investor sees of a status (CP-4: a referral reads as "under review"). */
CREATE FUNCTION complaints.web_status(p text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT CASE WHEN p = 'referred' THEN 'under_review' ELSE p END
$$;

-- ================================================================== website (CP-1, CP-4)
CREATE FUNCTION complaints.web_investor(p_session bytea) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, complaints AS $$
DECLARE
  s webauth.sessions := webauth.live_session(p_session);
BEGIN
  IF s.token_hash IS NULL THEN RETURN NULL; END IF;
  PERFORM webauth.touch(s);
  RETURN s.investor_id;
END $$;

CREATE FUNCTION complaints.web_file(p_session bytea, p_category text, p_title text, p_body text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, complaints AS $$
DECLARE
  v_inv uuid := complaints.web_investor(p_session);
  v_actor text;
  v_id bigint;
  v_ref text;
BEGIN
  IF v_inv IS NULL THEN RETURN jsonb_build_object('error', 'session'); END IF;
  v_actor := 'web:' || v_inv::text;
  IF p_category IS NULL OR p_category NOT IN ('payment', 'payout', 'tax', 'account', 'offering', 'transfer', 'website', 'other') THEN
    RAISE EXCEPTION 'unknown category' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM complaints.check_text(p_title, 5, 120);
  PERFORM complaints.check_text(p_body, 10, 2000);
  IF (SELECT count(*) FROM complaints.cases WHERE investor_id = v_inv AND created_at > clock_timestamp() - interval '1 day') >= 5 THEN
    RAISE EXCEPTION 'at most 5 complaints a day; please add to an open one' USING ERRCODE = 'check_violation';
  END IF;
  LOOP
    v_ref := 'CMP-' || upper(left(replace(gen_random_uuid()::text, '-', ''), 8));
    EXIT WHEN NOT EXISTS (SELECT 1 FROM complaints.cases WHERE ref = v_ref);
  END LOOP;
  INSERT INTO complaints.cases (ref, investor_id, category, title, ack_due, resolve_due)
  VALUES (v_ref, v_inv, p_category, btrim(p_title), clock_timestamp() + make_interval(days => complaints.setting('ack_days')),
          clock_timestamp() + make_interval(days => complaints.setting('resolve_days')))
  RETURNING id INTO v_id;
  INSERT INTO complaints.messages (case_id, author_kind, author, body) VALUES (v_id, 'investor', v_actor, btrim(p_body));
  INSERT INTO complaints.events (case_id, action, actor) VALUES (v_id, 'filed', v_actor);
  RETURN jsonb_build_object('id', v_id, 'ref', v_ref);
END $$;

CREATE FUNCTION complaints.case_json(c complaints.cases, p_web boolean) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, complaints AS $$
  SELECT jsonb_build_object('id', c.id, 'ref', c.ref, 'category', c.category, 'title', c.title,
    'status', CASE WHEN p_web THEN complaints.web_status(c.status) ELSE c.status END,
    'createdAt', c.created_at, 'ackDue', c.ack_due, 'resolveDue', c.resolve_due, 'acknowledgedAt', c.acknowledged_at,
    'resolvedAt', c.resolved_at, 'resolution', c.resolution, 'closedAt', c.closed_at,
    'reopenUntil', CASE WHEN c.status = 'resolved' THEN c.resolved_at + make_interval(days => complaints.setting('reopen_days')) END,
    'messages', coalesce((SELECT jsonb_agg(jsonb_build_object('from', m.author_kind,
                  'author', CASE WHEN p_web THEN NULL ELSE m.author END, 'body', m.body, 'at', m.created_at) ORDER BY m.id)
                FROM complaints.messages m WHERE m.case_id = c.id), '[]'::jsonb),
    'events', coalesce((SELECT jsonb_agg(jsonb_build_object('action', CASE WHEN p_web AND e.action = 'referred' THEN 'under_review' ELSE e.action END,
                  'actor', CASE WHEN p_web THEN NULL ELSE e.actor END, 'at', e.at) ORDER BY e.id)
                FROM complaints.events e WHERE e.case_id = c.id), '[]'::jsonb))
$$;

CREATE FUNCTION complaints.web_cases(p_session bytea) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, complaints AS $$
DECLARE
  v_inv uuid := complaints.web_investor(p_session);
BEGIN
  IF v_inv IS NULL THEN RETURN NULL; END IF;
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('id', c.id, 'ref', c.ref, 'category', c.category, 'title', c.title,
                     'status', complaints.web_status(c.status), 'createdAt', c.created_at, 'resolveDue', c.resolve_due) ORDER BY c.id DESC)
                   FROM (SELECT * FROM complaints.cases WHERE investor_id = v_inv ORDER BY id DESC LIMIT 100) c), '[]'::jsonb);
END $$;

CREATE FUNCTION complaints.web_case(p_session bytea, p_id bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, complaints AS $$
DECLARE
  v_inv uuid := complaints.web_investor(p_session);
  c complaints.cases;
BEGIN
  IF v_inv IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO c FROM complaints.cases WHERE id = p_id AND investor_id = v_inv;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN complaints.case_json(c, true);
END $$;

/** The investor replies, accepts the resolution (close) or reopens within the reopen window. */
CREATE FUNCTION complaints.web_act(p_session bytea, p_id bigint, p_action text, p_body text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, complaints AS $$
DECLARE
  v_inv uuid := complaints.web_investor(p_session);
  v_actor text;
  c complaints.cases;
BEGIN
  IF v_inv IS NULL THEN RETURN jsonb_build_object('error', 'session'); END IF;
  v_actor := 'web:' || v_inv::text;
  SELECT * INTO c FROM complaints.cases WHERE id = p_id AND investor_id = v_inv FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'complaint not found' USING ERRCODE = 'no_data_found'; END IF;
  IF p_action = 'reply' THEN
    IF c.status = 'closed' THEN RAISE EXCEPTION 'this complaint is closed' USING ERRCODE = 'check_violation'; END IF;
    PERFORM complaints.check_text(p_body, 2, 2000);
    INSERT INTO complaints.messages (case_id, author_kind, author, body) VALUES (c.id, 'investor', v_actor, btrim(p_body));
    INSERT INTO complaints.events (case_id, action, actor) VALUES (c.id, 'replied', v_actor);
  ELSIF p_action = 'close' THEN
    IF c.status <> 'resolved' THEN RAISE EXCEPTION 'only a resolved complaint can be closed' USING ERRCODE = 'check_violation'; END IF;
    UPDATE complaints.cases SET status = 'closed', closed_at = clock_timestamp() WHERE id = c.id;
    INSERT INTO complaints.events (case_id, action, actor) VALUES (c.id, 'closed', v_actor);
  ELSIF p_action = 'reopen' THEN
    IF c.status <> 'resolved' OR clock_timestamp() > c.resolved_at + make_interval(days => complaints.setting('reopen_days')) THEN
      RAISE EXCEPTION 'only a complaint resolved in the last % days can be reopened', complaints.setting('reopen_days') USING ERRCODE = 'check_violation';
    END IF;
    PERFORM complaints.check_text(p_body, 10, 2000);
    UPDATE complaints.cases SET status = 'acknowledged' WHERE id = c.id;
    INSERT INTO complaints.messages (case_id, author_kind, author, body) VALUES (c.id, 'investor', v_actor, btrim(p_body));
    INSERT INTO complaints.events (case_id, action, actor) VALUES (c.id, 'reopened', v_actor);
  ELSE
    RAISE EXCEPTION 'unknown action' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO c FROM complaints.cases WHERE id = p_id;
  RETURN jsonb_build_object('status', complaints.web_status(c.status));
END $$;

-- ================================================================== PT Control (CP-3)
INSERT INTO admin.role_permissions (role, permission) VALUES
  ('support_agent', 'complaints.read'), ('support_agent', 'complaints.handle'),
  ('ops_maker', 'complaints.read'), ('ops_maker', 'complaints.handle'),
  ('ops_checker', 'complaints.read'), ('compliance_officer', 'complaints.read'),
  ('auditor', 'complaints.read'), ('platform_owner', 'complaints.read');

DO $$
BEGIN
  EXECUTE format('CREATE OR REPLACE FUNCTION admin.expected_role_matrix_digest() RETURNS text LANGUAGE sql IMMUTABLE AS %L',
                 format('SELECT %L::text', admin.role_matrix_digest()));
END $$;

CREATE FUNCTION admin.complaints(p_session bytea) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
BEGIN
  PERFORM admin.require(p_session, 'complaints.read');
  RETURN jsonb_build_object(
    'at', admin.utc(clock_timestamp()),
    'cases', coalesce((SELECT jsonb_agg(jsonb_build_object('id', c.id, 'ref', c.ref, 'category', c.category, 'title', c.title, 'status', c.status,
                  'createdAt', admin.utc(c.created_at), 'ackDue', admin.utc(c.ack_due), 'resolveDue', admin.utc(c.resolve_due),
                  'ackLate', c.acknowledged_at IS NULL AND c.status = 'open' AND clock_timestamp() > c.ack_due,
                  'resolveLate', c.status IN ('open', 'acknowledged') AND clock_timestamp() > c.resolve_due)
                  ORDER BY (c.status IN ('open', 'acknowledged')) DESC, c.resolve_due, c.id)
                FROM (SELECT * FROM complaints.cases ORDER BY id DESC LIMIT 300) c), '[]'::jsonb));
END $$;

CREATE FUNCTION admin.complaint(p_session bytea, p_id bigint) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  c complaints.cases;
BEGIN
  PERFORM admin.require(p_session, 'complaints.read');
  SELECT * INTO c FROM complaints.cases WHERE id = p_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  -- The investor is shown by support reference only (the 8 hex characters of their KYC subject), never by name.
  RETURN complaints.case_json(c, false) || jsonb_build_object('investorRef',
    (SELECT left(replace(i.kyc_subject::text, '-', ''), 8) FROM webdemo.investors i WHERE i.id = c.investor_id));
END $$;

CREATE FUNCTION admin.complaint_act(p_session bytea, p_id bigint, p_action text, p_body text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'complaints.handle');
  v_handle text := admin.handle_of(v_me);
  c complaints.cases;
BEGIN
  PERFORM admin.require_step_up(p_session);
  SELECT * INTO c FROM complaints.cases WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RETURN admin.refuse(v_me, 'complaint', coalesce(p_id::text, '-'), coalesce(p_action, '-'), 'unknown complaint'); END IF;
  BEGIN
    IF p_action = 'acknowledge' THEN
      IF c.status <> 'open' THEN RAISE EXCEPTION 'only an open complaint is acknowledged' USING ERRCODE = 'check_violation'; END IF;
      IF p_body IS NOT NULL AND btrim(p_body) <> '' THEN
        PERFORM complaints.check_text(p_body, 2, 2000);
        INSERT INTO complaints.messages (case_id, author_kind, author, body) VALUES (c.id, 'officer', v_handle, btrim(p_body));
      END IF;
      UPDATE complaints.cases SET status = 'acknowledged', acknowledged_at = clock_timestamp() WHERE id = c.id;
      INSERT INTO complaints.events (case_id, action, actor) VALUES (c.id, 'acknowledged', v_handle);
    ELSIF p_action = 'reply' THEN
      IF c.status IN ('closed', 'referred') THEN RAISE EXCEPTION 'the complaint is %', c.status USING ERRCODE = 'check_violation'; END IF;
      PERFORM complaints.check_text(p_body, 2, 2000);
      INSERT INTO complaints.messages (case_id, author_kind, author, body) VALUES (c.id, 'officer', v_handle, btrim(p_body));
      INSERT INTO complaints.events (case_id, action, actor) VALUES (c.id, 'replied', v_handle);
      IF c.status = 'open' THEN UPDATE complaints.cases SET status = 'acknowledged', acknowledged_at = clock_timestamp() WHERE id = c.id; END IF;
    ELSIF p_action = 'resolve' THEN
      IF c.status NOT IN ('open', 'acknowledged') THEN RAISE EXCEPTION 'the complaint is %', c.status USING ERRCODE = 'check_violation'; END IF;
      PERFORM complaints.check_text(p_body, 10, 1000);
      UPDATE complaints.cases SET status = 'resolved', resolved_at = clock_timestamp(), resolution = btrim(p_body),
             acknowledged_at = coalesce(acknowledged_at, clock_timestamp()) WHERE id = c.id;
      INSERT INTO complaints.events (case_id, action, actor) VALUES (c.id, 'resolved', v_handle);
    ELSIF p_action = 'refer' THEN
      IF c.status NOT IN ('open', 'acknowledged') THEN RAISE EXCEPTION 'the complaint is %', c.status USING ERRCODE = 'check_violation'; END IF;
      UPDATE complaints.cases SET status = 'referred' WHERE id = c.id;
      INSERT INTO complaints.events (case_id, action, actor) VALUES (c.id, 'referred', v_handle);
    ELSE
      RAISE EXCEPTION 'choose acknowledge, reply, resolve or refer' USING ERRCODE = 'check_violation';
    END IF;
  EXCEPTION WHEN SQLSTATE '23514' THEN
    RETURN admin.refuse(v_me, 'complaint', p_id::text, coalesce(p_action, '-'), SQLERRM);
  END;
  PERFORM admin.audit_append(v_me::text, 'complaint.handled', jsonb_build_object('complaint', p_id, 'action', p_action));
  SELECT * INTO c FROM complaints.cases WHERE id = p_id;
  RETURN jsonb_build_object('ok', true, 'id', p_id, 'status', c.status);
END $$;

-- ================================================================== privileges
REVOKE ALL ON ALL TABLES IN SCHEMA complaints FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA complaints FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.complaints(bytea), admin.complaint(bytea, bigint), admin.complaint_act(bytea, bigint, text, text) FROM PUBLIC;
GRANT USAGE ON SCHEMA complaints TO pt_web;
GRANT EXECUTE ON FUNCTION complaints.web_file(bytea, text, text, text), complaints.web_cases(bytea), complaints.web_case(bytea, bigint),
  complaints.web_act(bytea, bigint, text, text) TO pt_web;
GRANT EXECUTE ON FUNCTION admin.complaints(bytea), admin.complaint(bytea, bigint), admin.complaint_act(bytea, bigint, text, text) TO pt_admin_portal;

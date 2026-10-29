-- Token-holder voting (later features: token-holder voting). Applies on top of 0045.
--
--   TV-1  A poll belongs to one token: title, question, 2 to 6 options, a record block (holdings are
--         counted at that block from the read model, never at vote time), an opening and closing
--         time, and a quorum (share of the units at the record block, in ppm). PLACEHOLDER rules:
--         which matters need a vote and which quorum applies are for the trust deed (LEGAL TO CONFIRM).
--   TV-2  Maker-checker: an operations maker proposes (step-up), a trustee officer approves or rejects
--         (step-up). Nothing about a poll changes after approval except closing it.
--   TV-3  One ballot per KYC subject per poll, cast on the website with the session (passkey step-up
--         rule 'vote.cast'), weight = the units of the subject's wallet at the record block; ballots
--         are final (append-only). Officers never vote under their handle here.
--   TV-4  Closing (after closes_at, operations maker) records the tally per option, the total weight,
--         turnout against all units at the record block and whether the quorum was met. Before
--         closing, investors see only their own ballot, never running totals.

CREATE SCHEMA voting;
REVOKE ALL ON SCHEMA voting FROM PUBLIC;

CREATE TABLE voting.polls (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  token        text NOT NULL CHECK (length(token) = 42 AND token ~ '^0x[0-9a-f]+$'),
  title        text NOT NULL CHECK (compliance.free_text_ok(title, 5, 120)),
  question     text NOT NULL CHECK (compliance.free_text_ok(question, 10, 1000)),
  options      text[] NOT NULL CHECK (cardinality(options) BETWEEN 2 AND 6),
  record_block bigint NOT NULL CHECK (record_block > 0),
  opens_at     timestamptz NOT NULL,
  closes_at    timestamptz NOT NULL,
  quorum_ppm   integer NOT NULL DEFAULT 0 CHECK (quorum_ppm BETWEEN 0 AND 1000000),
  status       text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'approved', 'rejected', 'closed')),
  proposed_by  text NOT NULL CHECK (length(proposed_by) BETWEEN 2 AND 100),
  proposed_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  decided_by   text,
  decided_at   timestamptz,
  decision_reason text,
  result       jsonb,
  CHECK (closes_at >= opens_at + interval '1 day'),
  CHECK (decided_by IS NULL OR decided_by <> proposed_by),
  CHECK ((status = 'closed') = (result IS NOT NULL))
);

CREATE TABLE voting.ballots (
  poll_id    bigint NOT NULL REFERENCES voting.polls (id),
  subject_id uuid NOT NULL REFERENCES kyc.subjects (id),
  wallet     text NOT NULL,
  choice     smallint NOT NULL CHECK (choice >= 0),
  weight     numeric NOT NULL CHECK (weight > 0),
  cast_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (poll_id, subject_id)
);

CREATE FUNCTION voting.append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'ballots are final' USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER ballots_append_only BEFORE UPDATE OR DELETE ON voting.ballots FOR EACH ROW EXECUTE FUNCTION voting.append_only();

CREATE FUNCTION voting.guard_poll() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' OR (NEW.token, NEW.title, NEW.question, NEW.options, NEW.record_block, NEW.opens_at, NEW.closes_at, NEW.quorum_ppm, NEW.proposed_by, NEW.proposed_at)
     IS DISTINCT FROM (OLD.token, OLD.title, OLD.question, OLD.options, OLD.record_block, OLD.opens_at, OLD.closes_at, OLD.quorum_ppm, OLD.proposed_by, OLD.proposed_at)
     OR OLD.status IN ('rejected', 'closed') OR (OLD.status = 'approved' AND NEW.status <> 'closed') THEN
    RAISE EXCEPTION 'a poll''s terms never change; it moves proposed -> approved | rejected, approved -> closed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER polls_guard BEFORE UPDATE OR DELETE ON voting.polls FOR EACH ROW EXECUTE FUNCTION voting.guard_poll();

/** Units of one wallet at the poll's record block (TV-3). */
CREATE FUNCTION voting.weight(p_poll bigint, p_wallet text) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, voting AS $$
  SELECT coalesce((SELECT h.units FROM voting.polls p CROSS JOIN LATERAL exit.holders_at(p.token, p.record_block) h
                   WHERE p.id = p_poll AND h.wallet = lower(p_wallet)), 0)
$$;

CREATE FUNCTION voting.tally(p_poll bigint) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, voting AS $$
  WITH p AS (SELECT * FROM voting.polls WHERE id = p_poll),
       total AS (SELECT coalesce(sum(h.units), 0) AS units FROM p CROSS JOIN LATERAL exit.holders_at(p.token, p.record_block) h),
       votes AS (SELECT choice, sum(weight) AS w, count(*) AS n FROM voting.ballots WHERE poll_id = p_poll GROUP BY choice)
  SELECT jsonb_build_object(
    'options', (SELECT jsonb_agg(jsonb_build_object('option', o.opt, 'weight', coalesce(v.w, 0)::text, 'ballots', coalesce(v.n, 0)) ORDER BY o.i)
                FROM p CROSS JOIN LATERAL unnest(p.options) WITH ORDINALITY o(opt, i) LEFT JOIN votes v ON v.choice = o.i - 1),
    'votedWeight', coalesce((SELECT sum(w) FROM votes), 0)::text,
    'ballots', coalesce((SELECT sum(n) FROM votes), 0),
    'unitsAtRecord', (SELECT units FROM total)::text,
    'turnoutPpm', CASE WHEN (SELECT units FROM total) > 0 THEN floor(coalesce((SELECT sum(w) FROM votes), 0) * 1000000 / (SELECT units FROM total)) ELSE 0 END,
    'quorumMet', CASE WHEN (SELECT units FROM total) > 0 THEN coalesce((SELECT sum(w) FROM votes), 0) * 1000000 >= (SELECT quorum_ppm FROM p) * (SELECT units FROM total) ELSE false END)
$$;

-- ================================================================== TV-2, TV-4 PT Control
CREATE FUNCTION admin.propose_poll(p_session bytea, p_token text, p_title text, p_question text, p_options text[], p_record_block bigint,
                                   p_opens timestamptz, p_closes timestamptz, p_quorum_ppm integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'operations.request');
  v_cursor bigint;
  v_id bigint;
BEGIN
  PERFORM admin.require_step_up(p_session);
  SELECT c.block_number INTO v_cursor FROM chain.tokens t JOIN chain.cursors c ON c.deployment = t.deployment WHERE t.token = lower(coalesce(p_token, ''));
  IF v_cursor IS NULL THEN RETURN admin.refuse(v_me, 'poll', '-', 'propose', 'unknown token'); END IF;
  IF p_record_block IS NULL OR p_record_block < 1 OR p_record_block > v_cursor THEN
    RETURN admin.refuse(v_me, 'poll', '-', 'propose', format('the record block must be indexed already (1 to %s)', v_cursor));
  END IF;
  IF p_options IS NULL OR cardinality(p_options) NOT BETWEEN 2 AND 6
     OR EXISTS (SELECT 1 FROM unnest(p_options) o WHERE NOT compliance.free_text_ok(o, 1, 80))
     OR (SELECT count(DISTINCT lower(btrim(o))) FROM unnest(p_options) o) <> cardinality(p_options) THEN
    RETURN admin.refuse(v_me, 'poll', '-', 'propose', '2 to 6 distinct options of 1 to 80 characters');
  END IF;
  IF NOT compliance.free_text_ok(coalesce(p_title, ''), 5, 120) OR NOT compliance.free_text_ok(coalesce(p_question, ''), 10, 1000) THEN
    RETURN admin.refuse(v_me, 'poll', '-', 'propose', 'a title (5-120) and a question (10-1000) without ID numbers');
  END IF;
  IF p_opens IS NULL OR p_closes IS NULL OR p_closes < p_opens + interval '1 day' OR p_quorum_ppm IS NULL OR p_quorum_ppm NOT BETWEEN 0 AND 1000000 THEN
    RETURN admin.refuse(v_me, 'poll', '-', 'propose', 'the poll is open at least one day; the quorum is 0 to 100 %');
  END IF;
  INSERT INTO voting.polls (token, title, question, options, record_block, opens_at, closes_at, quorum_ppm, proposed_by)
  VALUES (lower(p_token), btrim(p_title), btrim(p_question), p_options, p_record_block, p_opens, p_closes, p_quorum_ppm, admin.handle_of(v_me))
  RETURNING id INTO v_id;
  PERFORM admin.audit_append(v_me::text, 'operations.requested', jsonb_build_object('kind', 'poll', 'ref', v_id, 'action', 'propose'));
  RETURN jsonb_build_object('ok', true, 'id', v_id, 'status', 'proposed');
END $$;

CREATE FUNCTION admin.decide_poll(p_session bytea, p_id bigint, p_decision text, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'trustee.decide');
  v_handle text := admin.handle_of(v_me);
  p voting.polls;
BEGIN
  PERFORM admin.require_step_up(p_session);
  PERFORM admin.check_decision(p_decision, p_reason);
  SELECT * INTO p FROM voting.polls WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR p.status <> 'proposed' THEN RETURN admin.refuse(v_me, 'poll', coalesce(p_id::text, '-'), p_decision, 'no proposed poll with this id'); END IF;
  IF p.proposed_by = v_handle THEN RETURN admin.refuse(v_me, 'poll', p_id::text, p_decision, 'you proposed it: a different officer decides'); END IF;
  IF p_decision = 'approve' AND p.closes_at <= clock_timestamp() THEN RETURN admin.refuse(v_me, 'poll', p_id::text, p_decision, 'the poll would already be closed'); END IF;
  UPDATE voting.polls SET status = CASE p_decision WHEN 'approve' THEN 'approved' ELSE 'rejected' END, decided_by = v_handle,
         decided_at = clock_timestamp(), decision_reason = btrim(p_reason)
  WHERE id = p_id;
  PERFORM admin.audit_append(v_me::text, 'trustee.decided', jsonb_build_object('kind', 'poll', 'ref', p_id, 'action', p_decision));
  RETURN jsonb_build_object('ok', true, 'id', p_id, 'status', CASE p_decision WHEN 'approve' THEN 'approved' ELSE 'rejected' END);
END $$;

CREATE FUNCTION admin.close_poll(p_session bytea, p_id bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'operations.request');
  p voting.polls;
BEGIN
  PERFORM admin.require_step_up(p_session);
  SELECT * INTO p FROM voting.polls WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR p.status <> 'approved' OR p.closes_at > clock_timestamp() THEN
    RETURN admin.refuse(v_me, 'poll', coalesce(p_id::text, '-'), 'close', 'only an approved poll past its closing time is closed');
  END IF;
  UPDATE voting.polls SET status = 'closed', result = voting.tally(p_id) || jsonb_build_object('closedAt', clock_timestamp(), 'closedBy', admin.handle_of(v_me))
  WHERE id = p_id;
  PERFORM admin.audit_append(v_me::text, 'operations.requested', jsonb_build_object('kind', 'poll', 'ref', p_id, 'action', 'close'));
  RETURN jsonb_build_object('ok', true, 'id', p_id, 'status', 'closed');
END $$;

CREATE FUNCTION admin.polls(p_session bytea) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
BEGIN
  PERFORM admin.require(p_session, 'operations.read');
  RETURN jsonb_build_object(
    'polls', coalesce((SELECT jsonb_agg(jsonb_build_object('id', p.id, 'token', p.token, 'title', p.title, 'question', p.question, 'options', to_jsonb(p.options),
                 'recordBlock', p.record_block, 'opensAt', admin.utc(p.opens_at), 'closesAt', admin.utc(p.closes_at), 'quorumPpm', p.quorum_ppm,
                 'status', p.status, 'proposedBy', p.proposed_by, 'decidedBy', p.decided_by, 'canClose', p.status = 'approved' AND p.closes_at <= clock_timestamp(),
                 'ballots', (SELECT count(*) FROM voting.ballots b WHERE b.poll_id = p.id), 'result', p.result) ORDER BY p.id DESC)
               FROM (SELECT * FROM voting.polls ORDER BY id DESC LIMIT 100) p), '[]'::jsonb),
    'tokens', coalesce((SELECT jsonb_agg(jsonb_build_object('token', t.token, 'cursor', c.block_number) ORDER BY t.token)
               FROM chain.tokens t JOIN chain.cursors c ON c.deployment = t.deployment), '[]'::jsonb));
END $$;

-- ================================================================== TV-3 website
INSERT INTO webauth.step_up_actions (action, min_amount_paisa, note) VALUES
  ('vote.cast', 0, 'Casting a token-holder vote (one ballot per investor, final)');

CREATE FUNCTION voting.web_subject(p_session bytea) RETURNS TABLE (subject uuid, wallet text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, voting AS $$
DECLARE
  s webauth.sessions := webauth.live_session(p_session);
BEGIN
  IF s.token_hash IS NULL THEN RETURN; END IF;
  PERFORM webauth.touch(s);
  RETURN QUERY SELECT i.kyc_subject, w.wallet FROM webdemo.investors i JOIN kyc.wallets w ON w.subject_id = i.kyc_subject WHERE i.id = s.investor_id;
END $$;

/** Polls of tokens the investor held at the record block: terms, own ballot, result once closed (never running totals). */
CREATE FUNCTION voting.web_polls(p_session bytea) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, voting AS $$
DECLARE
  me record;
BEGIN
  SELECT * INTO me FROM voting.web_subject(p_session);
  IF me.subject IS NULL THEN RETURN NULL; END IF;
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('id', p.id, 'token', p.token, 'title', p.title, 'question', p.question, 'options', to_jsonb(p.options),
             'recordBlock', p.record_block, 'opensAt', p.opens_at, 'closesAt', p.closes_at, 'quorumPpm', p.quorum_ppm,
             'state', CASE WHEN p.status = 'closed' THEN 'closed' WHEN clock_timestamp() < p.opens_at THEN 'upcoming'
                           WHEN clock_timestamp() >= p.closes_at THEN 'counting' ELSE 'open' END,
             'weight', voting.weight(p.id, me.wallet)::text,
             'myChoice', (SELECT b.choice FROM voting.ballots b WHERE b.poll_id = p.id AND b.subject_id = me.subject),
             'result', p.result) ORDER BY p.closes_at DESC)
           FROM voting.polls p WHERE p.status IN ('approved', 'closed') AND voting.weight(p.id, me.wallet) > 0), '[]'::jsonb);
END $$;

CREATE FUNCTION webauth.web_vote(p_session bytea, p_poll bigint, p_choice integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, webauth AS $$
DECLARE
  g record;
  me record;
  p voting.polls;
  v_weight numeric;
BEGIN
  SELECT * INTO g FROM webauth.gate(p_session, 'vote.cast', 0);
  IF g.decision NOT IN ('ok', 'waived') THEN RETURN jsonb_build_object('error', g.decision); END IF;
  SELECT * INTO me FROM voting.web_subject(p_session);
  IF me.subject IS NULL THEN RAISE EXCEPTION 'only a KYC-verified investor with a wallet votes' USING ERRCODE = '42501'; END IF;
  SELECT * INTO p FROM voting.polls WHERE id = p_poll;
  IF NOT FOUND OR p.status <> 'approved' OR clock_timestamp() < p.opens_at OR clock_timestamp() >= p.closes_at THEN
    RAISE EXCEPTION 'this poll is not open for voting' USING ERRCODE = 'check_violation';
  END IF;
  IF p_choice IS NULL OR p_choice < 0 OR p_choice >= cardinality(p.options) THEN RAISE EXCEPTION 'unknown option' USING ERRCODE = 'check_violation'; END IF;
  v_weight := voting.weight(p.id, me.wallet);
  IF v_weight <= 0 THEN RAISE EXCEPTION 'you held no units of this token at the record block' USING ERRCODE = 'check_violation'; END IF;
  BEGIN
    INSERT INTO voting.ballots (poll_id, subject_id, wallet, choice, weight) VALUES (p.id, me.subject, me.wallet, p_choice, v_weight);
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'you have already voted in this poll' USING ERRCODE = 'check_violation';
  END;
  PERFORM webauth.audit_append(webauth.actor(g.investor_id), 'vote.cast', jsonb_build_object('poll', p.id));
  RETURN jsonb_build_object('ok', true, 'weight', v_weight::text);
END $$;

REVOKE ALL ON ALL TABLES IN SCHEMA voting FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA voting FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.propose_poll(bytea, text, text, text, text[], bigint, timestamptz, timestamptz, integer), admin.decide_poll(bytea, bigint, text, text),
  admin.close_poll(bytea, bigint), admin.polls(bytea), webauth.web_vote(bytea, bigint, integer) FROM PUBLIC;
GRANT USAGE ON SCHEMA voting TO pt_web;
GRANT EXECUTE ON FUNCTION voting.web_polls(bytea) TO pt_web;
GRANT EXECUTE ON FUNCTION webauth.web_vote(bytea, bigint, integer) TO pt_web;
GRANT EXECUTE ON FUNCTION admin.propose_poll(bytea, text, text, text, text[], bigint, timestamptz, timestamptz, integer), admin.decide_poll(bytea, bigint, text, text),
  admin.close_poll(bytea, bigint), admin.polls(bytea) TO pt_admin_portal;

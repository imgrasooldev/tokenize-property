-- Internal portals, Step 6b (task T-004, ADR 0011 section 10): operations approvals in the portal.
--
-- Numbered 0016: 0015 belongs to the offering module (S-02), built in parallel. Nothing here depends
-- on 0015. Until both are merged the runner refuses the gap; tests renumber a temporary copy.
--
-- Safety properties enforced by the database itself:
--   A-1  Permissions: approvals.decide (operations checker) decides signing requests, payout batches
--        and unfreezes; approvals.request (operations maker) asks for an unfreeze; property.read and
--        property.decide (checker, compliance) see and decide S-01 maker-checker requests;
--        auditors read everything. The role matrix digest is fixed again below.
--   A-2  The portal never decides anything itself. Each decision runs the backend's own function
--        (signer.decide via the signing service, recon.decide_unfreeze, bank.decide_payout_batch,
--        property.decide_request) under the officer's handle, inside a function that first checks
--        the session, the permission and a step-up younger than five minutes (admin.require_step_up).
--        The backend keeps enforcing maker-checker, expiry, the payout gate and the duties.
--   A-3  Officer names are bound to officer sessions: a signer approval, an unfreeze request or
--        decision, or a payout batch created, decided or submitted under the handle of a portal
--        officer is refused unless the admin function that checked that officer's session is on the
--        stack (a per-transaction binding no backend role can write). The command line keeps working
--        with its own operator names.
--   A-4  What you see is what you sign: every decision carries the digest of what the officer
--        reviewed (signer: payload hash and the hash of the exact call; payout: the items digest;
--        unfreeze: the freeze it lifts; property: the request digest) and is refused if it changed.
--   A-5  Signing requests are decided by the signing service (ADR 0005), never by the portal's
--        database role: the portal obtains a one-time decision ticket (2 minutes, only its hash
--        stored, bound to session, request, decision, reason, payload hash and call hash); the
--        signing service redeems it through signer.decide_officer, which re-checks the session,
--        permission and step-up in the same transaction.
--   A-6  Every view of a pending item (page views, admin.authorize) and every decision, refusal and
--        ticket is in the hash-chained admin audit, next to the backend's own audit.
--   A-7  S-01 duties are linked to officers: a duty in property.staff_duties needs an officer of the
--        admin portal with a matching role (trustee only for trustee officers, onboarding only for
--        operations makers, compliance only for compliance officers); property.has_duty() also needs
--        that officer to be active and still hold the role, so disabling an officer or revoking the
--        role ends their duties at once.

-- ================================================================== A-1 permissions
INSERT INTO admin.role_permissions (role, permission) VALUES
  ('auditor', 'approvals.read'),
  ('ops_checker', 'approvals.decide'),
  ('ops_maker', 'approvals.request'),
  ('ops_maker', 'property.read'), ('ops_checker', 'property.read'), ('compliance_officer', 'property.read'), ('auditor', 'property.read'),
  ('ops_checker', 'property.decide'), ('compliance_officer', 'property.decide');

-- The role matrix changed on purpose: fix the expected digest again (admin.verify_audit compares).
DO $$
BEGIN
  EXECUTE format('CREATE OR REPLACE FUNCTION admin.expected_role_matrix_digest() RETURNS text LANGUAGE sql IMMUTABLE AS %L',
                 format('SELECT %L::text', admin.role_matrix_digest()));
END $$;

-- ================================================================== helpers
CREATE FUNCTION admin.handle_of(p_officer uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
  SELECT handle FROM admin.officers WHERE id = p_officer
$$;

/** Input every decision needs: approve or reject, and a reason of 10 to 500 characters. */
CREATE FUNCTION admin.check_decision(p_decision text, p_reason text) RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
BEGIN
  IF p_decision IS NULL OR p_decision NOT IN ('approve', 'reject') THEN
    RAISE EXCEPTION 'decision must be approve or reject' USING ERRCODE = 'check_violation';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 10 AND 500 THEN
    RAISE EXCEPTION 'a reason of 10 to 500 characters is required' USING ERRCODE = 'check_violation';
  END IF;
END $$;

/** A refused decision: audited (the function returns instead of raising, so the entry stays). */
CREATE FUNCTION admin.refuse(p_officer uuid, p_kind text, p_ref text, p_decision text, p_error text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
BEGIN
  PERFORM admin.audit_append(p_officer::text, 'approval.refused', jsonb_build_object('kind', p_kind, 'ref', left(p_ref, 80),
    'decision', p_decision, 'error', left(coalesce(p_error, ''), 300)));
  RETURN jsonb_build_object('ok', false, 'error', left(coalesce(p_error, 'refused'), 300));
END $$;

-- ================================================================== A-3 officer names bound to sessions
-- One row per (transaction, officer) while an admin function acts for that officer; removed again
-- before the function returns. No role but the owner can write it.
CREATE TABLE admin.decision_context (
  txid   bigint NOT NULL,
  handle text NOT NULL,
  PRIMARY KEY (txid, handle)
);

CREATE FUNCTION admin.bind_officer(p_handle text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
  INSERT INTO admin.decision_context (txid, handle) VALUES (txid_current(), p_handle) ON CONFLICT DO NOTHING
$$;

CREATE FUNCTION admin.unbind_officer(p_handle text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
  DELETE FROM admin.decision_context WHERE txid = txid_current() AND handle = p_handle
$$;

/** Refuses a backend operator name that is a portal officer's handle, unless that officer's session was checked. */
CREATE FUNCTION admin.guard_officer_name(p_name text, p_what text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
BEGIN
  IF p_name IS NOT NULL AND EXISTS (SELECT 1 FROM admin.officers WHERE handle = p_name)
     AND NOT EXISTS (SELECT 1 FROM admin.decision_context WHERE txid = txid_current() AND handle = p_name) THEN
    RAISE EXCEPTION '% "%" is an officer of the admin portal: officers decide there (session, security key, audit), never under their name elsewhere',
      p_what, p_name USING ERRCODE = 'insufficient_privilege';
  END IF;
END $$;

CREATE FUNCTION admin.bind_signer_approval() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
BEGIN
  PERFORM admin.guard_officer_name(NEW.operator, 'signer approval by');
  RETURN NEW;
END $$;
CREATE TRIGGER approvals_officer_binding BEFORE INSERT ON signer.approvals FOR EACH ROW EXECUTE FUNCTION admin.bind_signer_approval();

CREATE FUNCTION admin.bind_unfreeze() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM admin.guard_officer_name(NEW.requested_by, 'unfreeze request by');
  ELSIF NEW.decided_by IS DISTINCT FROM OLD.decided_by THEN
    PERFORM admin.guard_officer_name(NEW.decided_by, 'unfreeze decision by');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER unfreeze_officer_binding BEFORE INSERT OR UPDATE ON recon.unfreeze_requests FOR EACH ROW EXECUTE FUNCTION admin.bind_unfreeze();

CREATE FUNCTION admin.bind_payout_batch() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM admin.guard_officer_name(NEW.created_by, 'payout batch created by');
  ELSE
    IF NEW.decided_by IS DISTINCT FROM OLD.decided_by THEN PERFORM admin.guard_officer_name(NEW.decided_by, 'payout batch decision by'); END IF;
    IF NEW.submitted_by IS DISTINCT FROM OLD.submitted_by THEN PERFORM admin.guard_officer_name(NEW.submitted_by, 'payout batch submitted by'); END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payout_batches_officer_binding BEFORE INSERT OR UPDATE ON bank.payout_batches FOR EACH ROW EXECUTE FUNCTION admin.bind_payout_batch();

-- ================================================================== A-5 signer decision tickets
CREATE TABLE admin.signer_tickets (
  token_hash   bytea PRIMARY KEY CHECK (length(token_hash) = 32),
  session_hash bytea NOT NULL REFERENCES admin.sessions (token_hash),
  officer_id   uuid NOT NULL REFERENCES admin.officers (id),
  request_id   uuid NOT NULL,
  decision     text NOT NULL CHECK (decision IN ('approve', 'reject')),
  reason       text NOT NULL CHECK (length(reason) BETWEEN 10 AND 500),
  payload_hash bytea NOT NULL CHECK (length(payload_hash) = 32),
  call_hash    bytea NOT NULL CHECK (length(call_hash) = 32),
  -- Both set from one clock reading (two defaults would differ by microseconds).
  created_at   timestamptz NOT NULL,
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz,
  result       text CHECK (length(result) <= 40),
  CHECK (expires_at = created_at + interval '2 minutes'),
  CHECK (result IS NULL OR used_at IS NOT NULL)
);
CREATE INDEX signer_tickets_request_idx ON admin.signer_tickets (request_id);

CREATE FUNCTION admin.guard_signer_ticket() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'decision tickets are never deleted' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF (NEW.token_hash, NEW.session_hash, NEW.officer_id, NEW.request_id, NEW.decision, NEW.reason, NEW.payload_hash, NEW.call_hash, NEW.created_at, NEW.expires_at)
     IS DISTINCT FROM (OLD.token_hash, OLD.session_hash, OLD.officer_id, OLD.request_id, OLD.decision, OLD.reason, OLD.payload_hash, OLD.call_hash, OLD.created_at, OLD.expires_at)
     OR (OLD.used_at IS NOT NULL AND NEW.used_at IS DISTINCT FROM OLD.used_at)
     OR (OLD.result IS NOT NULL AND NEW.result IS DISTINCT FROM OLD.result) THEN
    RAISE EXCEPTION 'a decision ticket is used once and never changed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER signer_tickets_guard BEFORE UPDATE OR DELETE ON admin.signer_tickets FOR EACH ROW EXECUTE FUNCTION admin.guard_signer_ticket();
CREATE TRIGGER signer_tickets_no_truncate BEFORE TRUNCATE ON admin.signer_tickets FOR EACH STATEMENT EXECUTE FUNCTION admin.forbid_change();

/** Why this officer cannot decide this signing request now (empty = they can). */
CREATE FUNCTION admin.signer_blockers(p_officer uuid, r signer.requests) RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_handle text := admin.handle_of(p_officer);
  v text[] := '{}';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admin.role_grants g JOIN admin.role_permissions p ON p.role = g.role
                 WHERE g.officer_id = p_officer AND g.revoked_at IS NULL AND p.permission = 'approvals.decide') THEN
    v := v || 'Only an operations checker decides signing requests; your roles prepare or review them.'::text;
  END IF;
  IF r.status <> 'pending_approval' THEN v := v || format('The request is %s, no longer waiting for approval.', r.status); END IF;
  IF r.status = 'pending_approval' AND r.expires_at <= now() THEN v := v || 'The 24-hour approval window has closed.'::text; END IF;
  IF r.requested_by = v_handle THEN v := v || 'You requested it: a different officer decides (maker-checker).'::text; END IF;
  IF EXISTS (SELECT 1 FROM signer.approvals a WHERE a.request_id = r.id AND a.operator = v_handle) THEN
    v := v || 'You already decided this request: the next approval must come from a different officer.'::text;
  END IF;
  RETURN v;
END $$;

/**
 * Step 1 of a signing decision (portal): checks the session, approvals.decide and a fresh step-up,
 * that the request still is what the officer reviewed (payload hash) and that this officer may
 * decide it; then stores a one-time ticket (only its hash) for the signing service. Refusals are
 * audited and returned as {ok: false, error}.
 */
CREATE FUNCTION admin.issue_signer_ticket(p_session bytea, p_request uuid, p_decision text, p_reason text,
                                          p_payload_hash bytea, p_call_hash bytea, p_token_hash bytea)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'approvals.decide');
  r signer.requests;
  v_blockers text[];
  v_now timestamptz := date_trunc('microseconds', clock_timestamp());
BEGIN
  PERFORM admin.require_step_up(p_session);
  PERFORM admin.check_decision(p_decision, p_reason);
  IF length(p_payload_hash) IS DISTINCT FROM 32 OR length(p_call_hash) IS DISTINCT FROM 32 OR length(p_token_hash) IS DISTINCT FROM 32 THEN
    RAISE EXCEPTION 'payload hash, call hash and ticket must be 32 bytes' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO r FROM signer.requests WHERE id = p_request;
  IF NOT FOUND THEN RETURN admin.refuse(v_me, 'signer', p_request::text, p_decision, 'unknown signing request'); END IF;
  IF r.payload_hash <> p_payload_hash THEN
    RETURN admin.refuse(v_me, 'signer', r.id::text, p_decision, 'the request differs from what you reviewed: reload and check again');
  END IF;
  v_blockers := admin.signer_blockers(v_me, r);
  IF cardinality(v_blockers) > 0 THEN RETURN admin.refuse(v_me, 'signer', r.id::text, p_decision, v_blockers[1]); END IF;
  INSERT INTO admin.signer_tickets (token_hash, session_hash, officer_id, request_id, decision, reason, payload_hash, call_hash, created_at, expires_at)
  VALUES (p_token_hash, p_session, v_me, r.id, p_decision, btrim(p_reason), p_payload_hash, p_call_hash, v_now, v_now + interval '2 minutes');
  PERFORM admin.audit_append(v_me::text, 'approval.ticket', jsonb_build_object('kind', 'signer', 'ref', r.id, 'decision', p_decision,
    'payloadHash', encode(p_payload_hash, 'hex'), 'callHash', encode(p_call_hash, 'hex'), 'ticket', left(encode(p_token_hash, 'hex'), 16)));
  RETURN jsonb_build_object('ok', true, 'expiresAt', admin.utc(v_now + interval '2 minutes'));
END $$;

/**
 * Step 2 (signing service, inside signer.decide_officer): uses a ticket once. The ticket must match
 * the request, decision, reason and call hash exactly; the officer's session must still be valid,
 * hold approvals.decide and have a fresh step-up. Binds the officer's handle to this transaction
 * (A-3) and returns it.
 */
CREATE FUNCTION admin.redeem_signer_ticket(p_token_hash bytea, p_request uuid, p_decision text, p_reason text, p_call_hash bytea)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  t admin.signer_tickets;
  v_officer uuid;
  v_handle text;
BEGIN
  SELECT * INTO t FROM admin.signer_tickets WHERE token_hash = p_token_hash FOR UPDATE;
  IF NOT FOUND OR t.used_at IS NOT NULL OR t.expires_at <= clock_timestamp() OR t.request_id IS DISTINCT FROM p_request
     OR t.decision IS DISTINCT FROM p_decision OR t.reason IS DISTINCT FROM btrim(p_reason) OR t.call_hash IS DISTINCT FROM p_call_hash THEN
    RAISE EXCEPTION 'decision ticket is not valid (unknown, used, expired or for another decision)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  v_officer := admin.require(t.session_hash, 'approvals.decide');
  PERFORM admin.require_step_up(t.session_hash);
  IF v_officer IS DISTINCT FROM t.officer_id THEN
    RAISE EXCEPTION 'decision ticket belongs to another officer' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE admin.signer_tickets SET used_at = clock_timestamp() WHERE token_hash = t.token_hash;
  v_handle := admin.handle_of(v_officer);
  PERFORM admin.bind_officer(v_handle);
  RETURN v_handle;
END $$;

/** Step 3 (signing service): records the outcome in the ticket and the admin audit; unbinds. */
CREATE FUNCTION admin.complete_signer_ticket(p_token_hash bytea, p_result text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  t admin.signer_tickets;
BEGIN
  SELECT * INTO t FROM admin.signer_tickets WHERE token_hash = p_token_hash FOR UPDATE;
  UPDATE admin.signer_tickets SET result = left(p_result, 40) WHERE token_hash = p_token_hash;
  PERFORM admin.audit_append(t.officer_id::text, 'approval.decided', jsonb_build_object('kind', 'signer', 'ref', t.request_id, 'decision', t.decision,
    'result', p_result, 'callHash', encode(t.call_hash, 'hex'), 'ticket', left(encode(t.token_hash, 'hex'), 16)));
  PERFORM admin.unbind_officer(admin.handle_of(t.officer_id));
END $$;

/**
 * The signing service decides a request for a portal officer (ADR 0005 + A-5). Called by the
 * service after it recomputed the call hash from the request and the active policy.
 */
CREATE FUNCTION signer.decide_officer(p_ticket_hash bytea, p_request uuid, p_decision text, p_reason text, p_call_hash bytea)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, signer AS $$
DECLARE
  v_handle text;
  v_status text;
BEGIN
  v_handle := admin.redeem_signer_ticket(p_ticket_hash, p_request, p_decision, p_reason, p_call_hash);
  v_status := signer.decide(p_request, v_handle, p_decision, btrim(p_reason));
  PERFORM admin.complete_signer_ticket(p_ticket_hash, v_status);
  RETURN v_status;
END $$;

-- ================================================================== A-2 decisions (recon, bank, property)
/** Checker: approve or reject an unfreeze request (recon.decide_unfreeze, ADR 0007 R-3). */
CREATE FUNCTION admin.decide_unfreeze(p_session bytea, p_request bigint, p_decision text, p_reason text, p_freeze_event bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'approvals.decide');
  v_handle text := admin.handle_of(v_me);
  q recon.unfreeze_requests;
  v_status text;
BEGIN
  PERFORM admin.require_step_up(p_session);
  PERFORM admin.check_decision(p_decision, p_reason);
  SELECT * INTO q FROM recon.unfreeze_requests WHERE id = p_request;
  IF NOT FOUND THEN RETURN admin.refuse(v_me, 'unfreeze', p_request::text, p_decision, 'unknown unfreeze request'); END IF;
  IF q.freeze_event IS DISTINCT FROM p_freeze_event THEN
    RETURN admin.refuse(v_me, 'unfreeze', q.id::text, p_decision, 'the request differs from what you reviewed: reload and check again');
  END IF;
  BEGIN
    PERFORM admin.bind_officer(v_handle);
    v_status := recon.decide_unfreeze(q.id, v_handle, p_decision, btrim(p_reason));
    PERFORM admin.unbind_officer(v_handle);
  EXCEPTION WHEN SQLSTATE '23514' OR SQLSTATE '23505' OR SQLSTATE '42501' OR SQLSTATE '22023' OR SQLSTATE 'P0002' THEN
    RETURN admin.refuse(v_me, 'unfreeze', q.id::text, p_decision, SQLERRM);
  END;
  PERFORM admin.audit_append(v_me::text, 'approval.decided', jsonb_build_object('kind', 'unfreeze', 'ref', q.id, 'decision', p_decision,
    'result', v_status, 'freezeEvent', q.freeze_event));
  RETURN jsonb_build_object('ok', true, 'status', v_status);
END $$;

/** Maker: ask for payouts to be unfrozen (recon.request_unfreeze); a checker decides. */
CREATE FUNCTION admin.request_unfreeze(p_session bytea, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'approvals.request');
  v_handle text := admin.handle_of(v_me);
  v_id bigint;
BEGIN
  PERFORM admin.check_decision('approve', p_reason);
  BEGIN
    PERFORM admin.bind_officer(v_handle);
    v_id := recon.request_unfreeze(v_handle, btrim(p_reason));
    PERFORM admin.unbind_officer(v_handle);
  EXCEPTION WHEN SQLSTATE '23514' OR SQLSTATE '23505' OR SQLSTATE '42501' OR SQLSTATE '22023' OR SQLSTATE 'P0002' THEN
    RETURN admin.refuse(v_me, 'unfreeze', 'new', 'request', SQLERRM);
  END;
  PERFORM admin.audit_append(v_me::text, 'approval.requested', jsonb_build_object('kind', 'unfreeze', 'ref', v_id));
  RETURN jsonb_build_object('ok', true, 'id', v_id);
END $$;

/** Checker: approve or reject a payout batch (bank.decide_payout_batch: maker-checker, payout gate, B-5). */
CREATE FUNCTION admin.decide_payout_batch(p_session bytea, p_batch bigint, p_decision text, p_reason text, p_items_digest bytea)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'approvals.decide');
  v_handle text := admin.handle_of(v_me);
  b bank.payout_batches;
  v_status text;
BEGIN
  PERFORM admin.require_step_up(p_session);
  PERFORM admin.check_decision(p_decision, p_reason);
  SELECT * INTO b FROM bank.payout_batches WHERE id = p_batch;
  IF NOT FOUND THEN RETURN admin.refuse(v_me, 'payout', p_batch::text, p_decision, 'unknown payout batch'); END IF;
  IF b.items_digest IS DISTINCT FROM p_items_digest THEN
    RETURN admin.refuse(v_me, 'payout', b.id::text, p_decision, 'the batch differs from what you reviewed: reload and check again');
  END IF;
  BEGIN
    PERFORM admin.bind_officer(v_handle);
    v_status := bank.decide_payout_batch(b.id, v_handle, p_decision, btrim(p_reason));
    PERFORM admin.unbind_officer(v_handle);
  EXCEPTION WHEN SQLSTATE '23514' OR SQLSTATE '23505' OR SQLSTATE '42501' OR SQLSTATE '22023' OR SQLSTATE 'P0002' THEN
    RETURN admin.refuse(v_me, 'payout', b.id::text, p_decision, SQLERRM);
  END;
  PERFORM admin.audit_append(v_me::text, 'approval.decided', jsonb_build_object('kind', 'payout', 'ref', b.id, 'decision', p_decision,
    'result', v_status, 'itemsDigest', encode(b.items_digest, 'hex')));
  RETURN jsonb_build_object('ok', true, 'status', v_status);
END $$;

/** Digest of an S-01 maker-checker request as the officer reviewed it (A-4). */
CREATE FUNCTION admin.property_request_digest(p_request bigint) RETURNS bytea
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
  SELECT sha256(convert_to('pt-property-request-v1' || jsonb_build_array(q.id, q.entity, q.entity_id, q.code, q.from_state, q.requested_by,
           q.reason, q.detail, admin.utc(q.requested_at), admin.utc(q.expires_at))::text, 'UTF8'))
  FROM property.requests q WHERE q.id = p_request
$$;

/** The duties property.decide_request will ask of the checker (mirrors 0014). */
CREATE FUNCTION admin.property_checker_duties(q property.requests) RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
  SELECT CASE
    WHEN q.entity = 'sponsor' AND q.code = 'K4'
         AND (SELECT rating FROM property.risk_ratings WHERE sponsor_id = q.entity_id ORDER BY id DESC LIMIT 1) = 'high' THEN ARRAY['compliance_senior']
    WHEN q.entity = 'sponsor' THEN ARRAY['compliance', 'compliance_senior']
    WHEN q.code = 'P6' THEN CASE property.discipline_group(q.detail->>'discipline') WHEN 'legal' THEN ARRAY['legal', 'legal_head']
                                 ELSE ARRAY[property.discipline_group(q.detail->>'discipline'), 'legal_head'] END
    ELSE ARRAY['legal_head'] END
$$;

/** Why this officer cannot decide this property request now (empty = they can). */
CREATE FUNCTION admin.property_blockers(p_officer uuid, q property.requests) RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_handle text := admin.handle_of(p_officer);
  v text[] := '{}';
  v_state text;
  v_duties text[] := admin.property_checker_duties(q);
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admin.role_grants g JOIN admin.role_permissions p ON p.role = g.role
                 WHERE g.officer_id = p_officer AND g.revoked_at IS NULL AND p.permission = 'property.decide') THEN
    v := v || 'Only a compliance officer or an operations checker decides property and KYB requests.'::text;
  END IF;
  IF q.status <> 'open' THEN v := v || format('The request is %s.', q.status); END IF;
  IF q.status = 'open' AND q.expires_at < now() THEN v := v || 'The request has expired (72 hours).'::text; END IF;
  v_state := CASE WHEN q.entity = 'sponsor' THEN property.sponsor_state(q.entity_id)
                  ELSE (SELECT state FROM property.properties WHERE id = q.entity_id) END;
  IF q.status = 'open' AND v_state IS DISTINCT FROM q.from_state THEN
    v := v || format('The file moved from %s to %s since the request: it is stale.', q.from_state, v_state);
  END IF;
  IF q.requested_by = v_handle THEN v := v || 'You requested it: a different officer decides (maker-checker).'::text; END IF;
  IF NOT property.has_duty(v_handle, v_duties) THEN
    v := v || format('Deciding needs an active %s duty (granted in S-01 duties).', array_to_string(v_duties, ' or '));
  END IF;
  IF (q.entity = 'sponsor' AND EXISTS (SELECT 1 FROM property.sponsor_events WHERE sponsor_id = q.entity_id AND code IN ('K1', 'K9') AND actor = v_handle))
     OR (q.entity = 'property' AND v_handle = ANY (coalesce(property.submitters(q.entity_id), '{}'))) THEN
    v := v || 'You entered or submitted this file: you never decide it (OB-SOD-1).'::text;
  END IF;
  RETURN v;
END $$;

/** Checker: approve or reject an S-01 request (property.decide_request: duties, SoD, expiry, guards). */
CREATE FUNCTION admin.decide_property_request(p_session bytea, p_request bigint, p_decision text, p_reason text, p_digest bytea)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'property.decide');
  v_handle text := admin.handle_of(v_me);
  v_status text;
BEGIN
  PERFORM admin.require_step_up(p_session);
  PERFORM admin.check_decision(p_decision, p_reason);
  IF NOT EXISTS (SELECT 1 FROM property.requests WHERE id = p_request) THEN
    RETURN admin.refuse(v_me, 'property', p_request::text, p_decision, 'unknown request');
  END IF;
  IF admin.property_request_digest(p_request) IS DISTINCT FROM p_digest THEN
    RETURN admin.refuse(v_me, 'property', p_request::text, p_decision, 'the request differs from what you reviewed: reload and check again');
  END IF;
  BEGIN
    PERFORM admin.bind_officer(v_handle);
    v_status := property.decide_request(p_request, v_handle, p_decision = 'approve', btrim(p_reason));
    PERFORM admin.unbind_officer(v_handle);
  EXCEPTION WHEN SQLSTATE '23514' OR SQLSTATE '23505' OR SQLSTATE '42501' OR SQLSTATE '22023' OR SQLSTATE 'P0002' THEN
    RETURN admin.refuse(v_me, 'property', p_request::text, p_decision, SQLERRM);
  END;
  PERFORM admin.audit_append(v_me::text, 'approval.decided', jsonb_build_object('kind', 'property', 'ref', p_request, 'decision', p_decision,
    'result', v_status, 'digest', encode(p_digest, 'hex')));
  RETURN jsonb_build_object('ok', true, 'status', v_status);
END $$;

-- ================================================================== reads for the portal (no personal data)
CREATE FUNCTION admin.gate_json() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
  SELECT jsonb_build_object('allowed', g.allowed, 'frozen', g.frozen, 'reason', g.reason, 'freezeEvent', g.freeze_event,
                            'lastRun', g.last_run, 'lastStatus', g.last_status, 'lastFinished', admin.utc(g.last_finished))
  FROM recon.payout_gate() g
$$;

/** The approvals inbox: sections the officer may read (approvals.read and/or property.read). */
CREATE FUNCTION admin.approvals_inbox(p_session bytea) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, NULL);
  v_handle text := admin.handle_of(v_me);
  v_ops boolean := admin.has_permission(p_session, 'approvals.read');
  v_prop boolean := admin.has_permission(p_session, 'property.read');
BEGIN
  IF NOT (v_ops OR v_prop) THEN
    RAISE EXCEPTION 'permission approvals.read or property.read is not held' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN jsonb_build_object(
    'at', admin.utc(clock_timestamp()),
    'gate', CASE WHEN v_ops THEN admin.gate_json() END,
    'signer', CASE WHEN v_ops THEN coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id', r.id, 'kind', r.kind, 'amount', r.amount::text, 'requestedBy', r.requested_by, 'createdAt', admin.utc(r.created_at),
        'expiresAt', admin.utc(r.expires_at), 'expired', r.expires_at <= now(), 'approvalsNeeded', r.approvals_needed,
        'approvals', (SELECT count(*) FROM signer.approvals a WHERE a.request_id = r.id AND a.decision = 'approve'),
        'mine', EXISTS (SELECT 1 FROM signer.approvals a WHERE a.request_id = r.id AND a.operator = v_handle),
        'to', coalesce(r.payload->>'to', r.payload->>'account', r.payload->>'wallet'), 'from', r.payload->>'from',
        'distributionId', r.payload->>'distributionId') ORDER BY r.created_at)
      FROM signer.requests r WHERE r.status = 'pending_approval'), '[]'::jsonb) END,
    'payouts', CASE WHEN v_ops THEN coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id', b.id, 'reference', b.reference, 'kind', b.kind, 'token', b.token, 'distributionId', b.distribution_id::text, 'status', b.status,
        'totalPaisa', b.total_paisa::text, 'paidPaisa', b.paid_paisa::text, 'items', b.item_count,
        'held', (SELECT count(*) FROM bank.payout_items i WHERE i.batch_id = b.id AND i.held),
        'createdBy', b.created_by, 'createdAt', admin.utc(b.created_at), 'decidedBy', b.decided_by) ORDER BY b.id)
      FROM bank.payout_batches b WHERE b.status IN ('created', 'approved')), '[]'::jsonb) END,
    'unfreeze', CASE WHEN v_ops THEN coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id', q.id, 'freezeEvent', q.freeze_event, 'requestedBy', q.requested_by, 'reason', q.reason, 'requestedAt', admin.utc(q.requested_at),
        'expiresAt', admin.utc(q.expires_at), 'expired', q.expires_at < now()) ORDER BY q.id)
      FROM recon.unfreeze_requests q WHERE q.status = 'open'), '[]'::jsonb) END,
    'property', CASE WHEN v_prop THEN coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id', q.id, 'entity', q.entity, 'entityId', q.entity_id, 'code', q.code, 'fromState', q.from_state,
        'toState', (SELECT t.to_state FROM property.transitions t WHERE t.entity = q.entity AND t.code = q.code AND t.from_state = q.from_state),
        'requestedBy', q.requested_by, 'requestedAt', admin.utc(q.requested_at), 'expiresAt', admin.utc(q.expires_at),
        'expired', q.expires_at < now()) ORDER BY q.id)
      FROM property.requests q WHERE q.status = 'open'), '[]'::jsonb) END);
END $$;

/** One signing request with everything a checker needs; nothing is decided here. */
CREATE FUNCTION admin.signer_request(p_session bytea, p_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'approvals.read');
  r signer.requests;
BEGIN
  SELECT * INTO r FROM signer.requests WHERE id = p_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN jsonb_build_object(
    'id', r.id, 'commandRef', r.command_ref, 'kind', r.kind, 'keyRef', r.key_ref,
    'keyAddress', (SELECT k.address FROM signer.keys k WHERE k.key_ref = r.key_ref),
    'payload', r.payload, 'payloadHash', encode(r.payload_hash, 'hex'), 'amount', r.amount::text, 'requestedBy', r.requested_by,
    'status', r.status, 'approvalsNeeded', r.approvals_needed, 'reason', r.reason, 'createdAt', admin.utc(r.created_at),
    'expiresAt', admin.utc(r.expires_at),
    'policy', (SELECT jsonb_build_object('id', p.id, 'version', p.version, 'proposedBy', p.proposed_by, 'approvedBy', p.approved_by,
                                         'active', p.approved_at IS NOT NULL AND p.retired_at IS NULL)
               FROM signer.policies p WHERE p.id = r.policy_id),
    'approvals', coalesce((SELECT jsonb_agg(jsonb_build_object('operator', a.operator, 'decision', a.decision, 'reason', a.reason, 'at', admin.utc(a.at))
                                            ORDER BY a.at) FROM signer.approvals a WHERE a.request_id = r.id), '[]'::jsonb),
    'command', (SELECT jsonb_build_object('id', c.id, 'status', c.status, 'createdBy', c.created_by, 'ref', c.ref, 'attempts', c.attempts,
                                          'lastError', left(c.last_error, 200), 'createdAt', admin.utc(c.created_at))
                FROM outbox.commands c WHERE c.idempotency_key = r.command_ref),
    'gate', CASE WHEN r.kind ~ '^(payout|rent|distribution)\.' THEN admin.gate_json() END,
    'blockers', to_jsonb(admin.signer_blockers(v_me, r)));
END $$;

/** One payout batch: lines (no names, last four IBAN digits), totals, held lines, gate, digests. */
CREATE FUNCTION admin.payout_batch(p_session bytea, p_id bigint) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'approvals.read');
  v_handle text := admin.handle_of(v_me);
  b bank.payout_batches;
  v_gate jsonb := admin.gate_json();
  v text[] := '{}';
  v_problems text;
BEGIN
  SELECT * INTO b FROM bank.payout_batches WHERE id = p_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF NOT admin.has_permission(p_session, 'approvals.decide') THEN
    v := v || 'Only an operations checker decides payout batches; your roles prepare or review them.'::text;
  END IF;
  IF b.status <> 'created' THEN v := v || format('The batch is %s, no longer waiting for a decision.', b.status); END IF;
  IF b.created_by = v_handle THEN v := v || 'You created it: a different officer decides (maker-checker).'::text; END IF;
  v_problems := bank.batch_problems(b.id);
  RETURN jsonb_build_object(
    'id', b.id, 'reference', b.reference, 'kind', b.kind, 'parentId', b.parent_id, 'token', b.token, 'distributionId', b.distribution_id::text,
    'status', b.status, 'totalPaisa', b.total_paisa::text, 'paidPaisa', b.paid_paisa::text, 'heldPaisa', (b.total_paisa - b.paid_paisa)::text,
    'items', b.item_count, 'itemsDigest', encode(b.items_digest, 'hex'), 'itemsDigestVersion', b.items_digest_version,
    'fileSha256', encode(b.file_sha256, 'hex'), 'journalId', b.journal_id, 'createdBy', b.created_by, 'createdAt', admin.utc(b.created_at),
    'decidedBy', b.decided_by, 'decisionReason', b.decision_reason, 'decidedAt', admin.utc(b.decided_at),
    'submittedBy', b.submitted_by, 'submittedAt', admin.utc(b.submitted_at),
    'lines', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'line', i.line_no, 'subject', left(i.subject_id::text, 8), 'bank', p.bank_code, 'ibanLast4', p.iban_last4,
        'amountPaisa', i.amount_paisa::text, 'held', i.held, 'heldReason', i.held_reason,
        'returned', EXISTS (SELECT 1 FROM bank.payout_returns x WHERE x.batch_id = i.batch_id AND x.line_no = i.line_no)) ORDER BY i.line_no)
      FROM (SELECT * FROM bank.payout_items WHERE batch_id = b.id ORDER BY line_no LIMIT 1000) i
      LEFT JOIN bank.payees p ON p.id = i.payee_id), '[]'::jsonb),
    'problems', v_problems,
    'gate', v_gate,
    'blockers', to_jsonb(v),
    'approveBlockers', to_jsonb(
      CASE WHEN NOT coalesce((v_gate->>'allowed')::boolean, false) THEN ARRAY['Payouts are blocked by reconciliation: ' || coalesce(v_gate->>'reason', 'no gate answer')] ELSE '{}'::text[] END
      || CASE WHEN v_problems IS NOT NULL THEN ARRAY['The batch can no longer be paid as created: ' || v_problems] ELSE '{}'::text[] END));
END $$;

/** One unfreeze request with the freeze it lifts and the runs that decide whether it may. */
CREATE FUNCTION admin.unfreeze_request(p_session bytea, p_id bigint) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'approvals.read');
  v_handle text := admin.handle_of(v_me);
  q recon.unfreeze_requests;
  f recon.gate_events;
  e recon.gate_events;
  r recon.runs;
  v text[] := '{}';
  a text[] := '{}';
BEGIN
  SELECT * INTO q FROM recon.unfreeze_requests WHERE id = p_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO f FROM recon.gate_events WHERE id = q.freeze_event;
  SELECT * INTO e FROM recon.gate_events ORDER BY id DESC LIMIT 1;
  SELECT * INTO r FROM recon.runs WHERE status <> 'running' ORDER BY id DESC LIMIT 1;
  IF NOT admin.has_permission(p_session, 'approvals.decide') THEN
    v := v || 'Only an operations checker decides unfreezes; your roles prepare or review them.'::text;
  END IF;
  IF q.status <> 'open' THEN v := v || format('The request is %s.', q.status); END IF;
  IF q.status = 'open' AND q.expires_at < now() THEN v := v || 'The request is older than 24 hours.'::text; END IF;
  IF q.status = 'open' AND e.id IS DISTINCT FROM q.freeze_event THEN v := v || 'Payouts were frozen again after this request.'::text; END IF;
  IF q.requested_by = v_handle THEN v := v || 'You requested it: a different officer decides (maker-checker).'::text; END IF;
  IF r.status IS DISTINCT FROM 'passed' OR r.id <= f.run_id THEN
    a := a || format('Unfreezing needs a reconciliation run that passed after run %s froze payouts (latest: run %s, %s).', f.run_id, r.id, coalesce(r.status, 'none'));
  END IF;
  RETURN jsonb_build_object(
    'id', q.id, 'status', q.status, 'requestedBy', q.requested_by, 'reason', q.reason, 'requestedAt', admin.utc(q.requested_at),
    'expiresAt', admin.utc(q.expires_at), 'decidedBy', q.decided_by, 'decisionReason', q.decision_reason, 'decidedAt', admin.utc(q.decided_at),
    'freeze', jsonb_build_object('event', f.id, 'at', admin.utc(f.at), 'run', f.run_id, 'reason', f.reason, 'actor', f.actor),
    'freezingRun', (SELECT jsonb_build_object('id', x.id, 'status', x.status, 'blocking', x.blocking, 'warnings', x.warnings,
                                              'finishedAt', admin.utc(x.finished_at)) FROM recon.runs x WHERE x.id = f.run_id),
    'latestRun', CASE WHEN r.id IS NOT NULL THEN jsonb_build_object('id', r.id, 'status', r.status, 'blocking', r.blocking, 'warnings', r.warnings,
                                                                    'finishedAt', admin.utc(r.finished_at)) END,
    'gate', admin.gate_json(),
    'blockers', to_jsonb(v),
    'approveBlockers', to_jsonb(a));
END $$;

/** One S-01 request: the transition, the file's state and identifiers (no sealed data), duties, digest. */
CREATE FUNCTION admin.property_request(p_session bytea, p_id bigint) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'property.read');
  q property.requests;
BEGIN
  SELECT * INTO q FROM property.requests WHERE id = p_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN jsonb_build_object(
    'id', q.id, 'entity', q.entity, 'entityId', q.entity_id, 'code', q.code, 'fromState', q.from_state,
    'transition', (SELECT jsonb_build_object('toState', t.to_state, 'action', t.action) FROM property.transitions t
                   WHERE t.entity = q.entity AND t.code = q.code AND t.from_state = q.from_state),
    'requestedBy', q.requested_by, 'reason', q.reason, 'detail', q.detail, 'requestedAt', admin.utc(q.requested_at),
    'expiresAt', admin.utc(q.expires_at), 'status', q.status, 'decidedBy', q.decided_by, 'decisionReason', q.decision_reason,
    'decidedAt', admin.utc(q.decided_at), 'digest', encode(admin.property_request_digest(q.id), 'hex'),
    'sponsor', CASE WHEN q.entity = 'sponsor' THEN (SELECT jsonb_build_object('kind', s.kind, 'state', s.state, 'cuinLast4', s.cuin_last4,
                    'ntnLast4', s.ntn_last4, 'kybValidUntil', admin.utc(s.kyb_valid_until),
                    'risk', (SELECT rating FROM property.risk_ratings WHERE sponsor_id = s.sponsor_id ORDER BY id DESC LIMIT 1))
                    FROM property.sponsor_overview s WHERE s.sponsor_id = q.entity_id) END,
    'property', CASE WHEN q.entity = 'property' THEN (SELECT jsonb_build_object('state', p.state, 'province', p.province, 'district', p.district,
                    'propertyKey', p.property_key, 'use', p.use, 'submittedAt', admin.utc(p.submitted_at))
                    FROM property.property_overview p WHERE p.property_id = q.entity_id) END,
    'checkerDuties', to_jsonb(admin.property_checker_duties(q)),
    'blockers', to_jsonb(admin.property_blockers(v_me, q)));
END $$;

-- ================================================================== A-7 S-01 duties linked to officers
/** The portal roles that may hold an S-01 duty. */
CREATE FUNCTION admin.duty_roles(p_duty text) RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT CASE p_duty
    WHEN 'onboarding' THEN ARRAY['ops_maker']
    WHEN 'compliance' THEN ARRAY['compliance_officer']
    WHEN 'compliance_senior' THEN ARRAY['compliance_officer']
    WHEN 'trustee' THEN ARRAY['trustee_officer']
    -- Due diligence and the investment committee: any platform officer (never trustee, auditor or administrator).
    WHEN 'legal' THEN ARRAY['ops_maker', 'ops_checker', 'compliance_officer']
    WHEN 'legal_head' THEN ARRAY['ops_maker', 'ops_checker', 'compliance_officer']
    WHEN 'valuation' THEN ARRAY['ops_maker', 'ops_checker', 'compliance_officer']
    WHEN 'technical' THEN ARRAY['ops_maker', 'ops_checker', 'compliance_officer']
    WHEN 'ic_member' THEN ARRAY['ops_maker', 'ops_checker', 'compliance_officer']
    WHEN 'ic_independent' THEN ARRAY['ops_maker', 'ops_checker', 'compliance_officer']
    ELSE '{}'::text[] END
$$;

/** Whether the officer with this handle holds one of the roles now (and is active, or also invited). */
CREATE FUNCTION admin.officer_holds(p_handle text, p_roles text[], p_active_only boolean) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
  SELECT EXISTS (SELECT 1 FROM admin.officers o JOIN admin.role_grants g ON g.officer_id = o.id AND g.revoked_at IS NULL
                 WHERE o.handle = p_handle AND g.role = ANY (p_roles)
                   AND (o.status = 'active' OR (NOT p_active_only AND o.status = 'invited')))
$$;

CREATE FUNCTION admin.check_staff_duty() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NOT admin.officer_holds(NEW.actor, admin.duty_roles(NEW.duty), false) THEN
    RAISE EXCEPTION 'a % duty needs an officer of the admin portal with the role %; % is not one',
      NEW.duty, array_to_string(admin.duty_roles(NEW.duty), ' or '), NEW.actor USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.status = 'active' AND OLD.status = 'pending' AND NOT admin.officer_holds(NEW.actor, admin.duty_roles(NEW.duty), true) THEN
    RAISE EXCEPTION 'a % duty is activated only for an active officer with the role %', NEW.duty, array_to_string(admin.duty_roles(NEW.duty), ' or ')
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER staff_duties_officer BEFORE INSERT OR UPDATE ON property.staff_duties FOR EACH ROW EXECUTE FUNCTION admin.check_staff_duty();

-- A duty counts only while its officer is active and still holds a matching role.
CREATE OR REPLACE FUNCTION property.has_duty(p_actor text, p_duties text[]) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, property AS $$
  SELECT EXISTS (SELECT 1 FROM property.staff_duties d
                 WHERE d.actor = p_actor AND d.status = 'active' AND d.duty = ANY (p_duties)
                   AND admin.officer_holds(d.actor, admin.duty_roles(d.duty), true))
$$;

-- ================================================================== privileges
REVOKE ALL ON ALL TABLES IN SCHEMA admin FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA admin FROM PUBLIC;
REVOKE ALL ON FUNCTION signer.decide_officer(bytea, uuid, text, text, bytea) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
  admin.approvals_inbox(bytea),
  admin.signer_request(bytea, uuid),
  admin.payout_batch(bytea, bigint),
  admin.unfreeze_request(bytea, bigint),
  admin.property_request(bytea, bigint),
  admin.issue_signer_ticket(bytea, uuid, text, text, bytea, bytea, bytea),
  admin.decide_unfreeze(bytea, bigint, text, text, bigint),
  admin.request_unfreeze(bytea, text),
  admin.decide_payout_batch(bytea, bigint, text, text, bytea),
  admin.decide_property_request(bytea, bigint, text, text, bytea)
TO pt_admin_portal;
-- The signing service redeems tickets (ADR 0005: the service, not the portal, decides).
GRANT EXECUTE ON FUNCTION signer.decide_officer(bytea, uuid, text, text, bytea) TO pt_signer;

-- Internal portals, Step 6d (task T-006, ADR 0011 section 12): the trustee portal.
--
-- Applies on top of 0020 (S-06 recovery: role legal_officer, audit source recovery), 0021 (S-03
-- operations and tax: role tax_officer, schemas ops and tax, the rent booking path) and 0022
-- (T-045 website account). The role-matrix digest is fixed again after all of them.
--
-- The trustee (e.g. CDC) is an independent regulated organisation. Its officers hold no platform
-- role (0013 role conflicts). Safety properties enforced by the database itself:
--   T-1  Trustee co-signature in the signer's maker-checker (spec S-02 §3/§8, contract-spec §3:
--        the Issuance Safe always includes a trustee signer). signer.trustee_cosign_kinds lists the
--        kinds the specs assign to the trustee (issuance.mint). A request of such a kind that needs
--        platform approvals (amount above the policy threshold) needs ONE trustee approval IN
--        ADDITION, set by a trigger on insert (the service cannot opt out) and immutable. An
--        approval's capacity (platform | trustee) is derived by a trigger from the approver's role,
--        never taken from the caller. signer.decide counts both separately; the
--        pending_approval -> approved transition is re-checked by a trigger (deny by default, also
--        against a direct UPDATE). Platform checkers cannot stand in for the trustee and trustee
--        officers approve only requests that need them. Officer handles are bound to sessions (0016).
--   T-2  Trustee decisions in the portal: signer co-signatures go through the 6b ticket path
--        (admin.signer_tickets gains a capacity; redeeming a trustee ticket needs trustee.decide);
--        offering requests that need the trustee duty (IB issuance batch, CMP completion record
--        incl. the completion payment batch, L3, L7, L8, L10..L16, SD) are voted through
--        admin.decide_offering_request under the officer's handle. For a portal officer the S-02
--        trustee duty IS the trustee_officer role (active), and a trustee officer holds no other
--        offering duty (OF-SOD-4). Every portal decision needs a step-up younger than five minutes
--        and the digest of what was shown. Offering votes under an officer's handle from the
--        command line stay possible (break-glass, as the S-01 property path; the demo catalogue
--        seed of T-045 relies on it): binding them to sessions is an open item.
--   T-3  Rent distributions (spec S-03 D4/D6): a trustee officer approves (stating the Merkle root
--        they recomputed, which must equal the published root) or rejects with a reason while the
--        distribution is published on chain and inside the 48-hour challenge window counted from
--        its publish block. One decision per distribution. A rejection blocks finalisation in SQL:
--        no payout batch (bank.payout_batches) and no `rent:distribution:<token>:<id>` ledger
--        journal can be written for it afterwards (triggers), whatever the chain says.
--   T-4  The trustee's own register (ledger of units per wallet): append-only entries, written
--        automatically when the trustee confirms an offering's register entries (V18: subscription
--        active, + units) or a redemption (- units), and by two-officer adjustments (opening
--        balances, corrections) with evidence SHA-256: a different trustee officer decides within
--        72 hours; no wallet's register balance may go negative.
--   T-5  Reads compare that register with the read model pinned to its cursor block, supply with
--        the trustee cap, and show reconciliation runs and findings and recovery requests; exports
--        are recorded (SHA-256, pinned block) in the trustee and admin audits BEFORE release.
--   T-6  Hash-chained, append-only trustee.audit (UTC digests); trustee.verify_audit() re-checks the
--        chain and finds rows written around the API (reviews, adjustments, register entries,
--        trustee co-signatures).
--   T-7  Permissions: trustee.decide (trustee officers), trustee.export (trustee officers and
--        auditors), trustee.read (both, from 0013), audit.export for trustee officers (only the
--        trustee chain is readable to them). The role matrix digest is fixed again.
--   T-8  S-03 trustee duties on the operations path of 0021: an expense or fee above the operations
--        limit needs the trustee's approval before the operations checker may approve it (OP-21,
--        E1; a trustee rejection refuses it), and a distribution calculation needs the trustee's
--        pre-check (independent recomputation of the Merkle root equal to the attached root, D4,
--        OP-SOD-2) before the operations checker may approve it. A trustee rejection of the
--        on-chain distribution (T-3) also refuses the rent:wht journal of S-03's booking.
--   T-9  Recovery and succession cases (0020) are shown to the trustee read-only through
--        trustee.recovery_cases_json(); the trustee's own approval of a recovery (S-06 C4) is not a
--        capacity of 0020 yet (open item).

CREATE SCHEMA IF NOT EXISTS trustee;
REVOKE ALL ON SCHEMA trustee FROM PUBLIC;

-- ================================================================== helpers and audit (T-6)
CREATE FUNCTION trustee.forbid_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'trustee records are append-only: % on %.% is not allowed', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE FUNCTION trustee.utc(p timestamptz) RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT to_char(p AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
$$;

CREATE FUNCTION trustee.fail(p_code text, p_message text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '%', p_message USING ERRCODE = p_code;
END $$;

/** Deny by default: only an active officer holding the trustee_officer role acts for the trustee. */
CREATE FUNCTION trustee.need_trustee(p_actor text, p_what text) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, trustee AS $$
BEGIN
  IF p_actor IS NULL OR NOT admin.officer_holds(p_actor, ARRAY['trustee_officer'], true) THEN
    PERFORM trustee.fail('42501', format('only an active trustee officer can %s', p_what));
  END IF;
END $$;

CREATE FUNCTION trustee.check_reason(p text) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, trustee AS $$
BEGIN
  IF NOT compliance.free_text_ok(p, 10, 500) THEN
    PERFORM trustee.fail('22023', 'a reason of 10 to 500 characters is required, without a CNIC, IBAN or phone number');
  END IF;
END $$;

CREATE TABLE trustee.audit (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at        timestamptz NOT NULL,
  actor     text NOT NULL CHECK (length(actor) BETWEEN 1 AND 100),
  action    text NOT NULL CHECK (action ~ '^[a-z][a-z_.]{2,63}$'),
  detail    jsonb NOT NULL CHECK (jsonb_typeof(detail) = 'object' AND octet_length(detail::text) <= 8192),
  prev_hash bytea NOT NULL CHECK (length(prev_hash) = 32),
  hash      bytea NOT NULL UNIQUE CHECK (length(hash) = 32)
);
CREATE INDEX audit_action_idx ON trustee.audit (action, id);

CREATE FUNCTION trustee.audit_digest(p_prev bytea, p_id bigint, p_at timestamptz, p_actor text, p_action text, p_detail jsonb)
RETURNS bytea LANGUAGE sql STABLE SET search_path = pg_catalog, trustee AS $$
  SELECT sha256(p_prev || convert_to('pt-trustee-audit-v1' || jsonb_build_array(p_id, trustee.utc(p_at), p_actor, p_action, p_detail)::text, 'UTF8'))
$$;

CREATE FUNCTION trustee.audit_append(p_actor text, p_action text, p_detail jsonb)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trustee AS $$
DECLARE
  v_prev bytea;
  v_id bigint;
  v_at timestamptz := date_trunc('microseconds', clock_timestamp());
BEGIN
  PERFORM pg_advisory_xact_lock(586586230);
  SELECT hash INTO v_prev FROM trustee.audit ORDER BY id DESC LIMIT 1;
  v_prev := coalesce(v_prev, decode(repeat('00', 32), 'hex'));
  v_id := nextval(pg_get_serial_sequence('trustee.audit', 'id'));
  INSERT INTO trustee.audit (id, at, actor, action, detail, prev_hash, hash)
  OVERRIDING SYSTEM VALUE
  VALUES (v_id, v_at, left(p_actor, 100), p_action, coalesce(p_detail, '{}'::jsonb), v_prev,
          trustee.audit_digest(v_prev, v_id, v_at, left(p_actor, 100), p_action, coalesce(p_detail, '{}'::jsonb)));
  RETURN v_id;
END $$;

-- ================================================================== T-7 permissions
INSERT INTO admin.role_permissions (role, permission) VALUES
  ('trustee_officer', 'trustee.decide'),
  ('trustee_officer', 'trustee.export'),
  ('trustee_officer', 'audit.export'),
  ('auditor', 'trustee.export');

DO $$
BEGIN
  EXECUTE format('CREATE OR REPLACE FUNCTION admin.expected_role_matrix_digest() RETURNS text LANGUAGE sql IMMUTABLE AS %L',
                 format('SELECT %L::text', admin.role_matrix_digest()));
END $$;

-- ================================================================== T-1 trustee co-signature in the signer
CREATE TABLE signer.trustee_cosign_kinds (
  kind text PRIMARY KEY CHECK (kind ~ '^[a-z]+\.[a-z_]+$'),
  note text NOT NULL CHECK (length(note) BETWEEN 10 AND 300)
);
INSERT INTO signer.trustee_cosign_kinds (kind, note) VALUES
  ('issuance.mint', 'S-02 §3/§8 and contract-spec §3: the Issuance Safe always includes a trustee signer; every mint above the policy threshold needs the trustee in addition to the platform approvals');
CREATE TRIGGER trustee_cosign_kinds_append_only BEFORE UPDATE OR DELETE ON signer.trustee_cosign_kinds FOR EACH ROW EXECUTE FUNCTION signer.forbid_change();
CREATE TRIGGER trustee_cosign_kinds_no_truncate BEFORE TRUNCATE ON signer.trustee_cosign_kinds FOR EACH STATEMENT EXECUTE FUNCTION signer.forbid_change();

ALTER TABLE signer.requests ADD COLUMN trustee_approvals_needed integer NOT NULL DEFAULT 0 CHECK (trustee_approvals_needed BETWEEN 0 AND 1);
ALTER TABLE signer.approvals ADD COLUMN capacity text NOT NULL DEFAULT 'platform' CHECK (capacity IN ('platform', 'trustee'));

-- Requests already waiting when this migration runs: deny by default, they need the trustee as well.
UPDATE signer.requests r SET trustee_approvals_needed = 1
WHERE r.status = 'pending_approval' AND r.approvals_needed > 0 AND r.kind IN (SELECT kind FROM signer.trustee_cosign_kinds);

/** T-1: whether a request needs the trustee is decided here, on insert, never by the caller. */
CREATE FUNCTION signer.set_trustee_requirement() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, signer AS $$
BEGIN
  NEW.trustee_approvals_needed := CASE
    WHEN NEW.approvals_needed > 0 AND EXISTS (SELECT 1 FROM signer.trustee_cosign_kinds k WHERE k.kind = NEW.kind) THEN 1 ELSE 0 END;
  RETURN NEW;
END $$;
CREATE TRIGGER requests_trustee_requirement BEFORE INSERT ON signer.requests FOR EACH ROW EXECUTE FUNCTION signer.set_trustee_requirement();

/** Approvals of each capacity on a request. */
CREATE FUNCTION signer.approval_counts(p_request uuid, OUT platform integer, OUT trustee integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, signer AS $$
  SELECT count(*) FILTER (WHERE a.capacity = 'platform')::integer, count(*) FILTER (WHERE a.capacity = 'trustee')::integer
  FROM signer.approvals a WHERE a.request_id = p_request AND a.decision = 'approve'
$$;

/** T-1: the requirement never changes, and "approved" needs enough approvals of BOTH capacities. */
CREATE FUNCTION signer.guard_trustee_requirement() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, signer AS $$
DECLARE
  c record;
BEGIN
  IF NEW.trustee_approvals_needed IS DISTINCT FROM OLD.trustee_approvals_needed THEN
    RAISE EXCEPTION 'signing request %: the trustee requirement never changes', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'pending_approval' AND NEW.status = 'approved' THEN
    SELECT * INTO c FROM signer.approval_counts(NEW.id);
    IF c.platform < NEW.approvals_needed OR c.trustee < NEW.trustee_approvals_needed THEN
      RAISE EXCEPTION 'signing request % lacks approvals: platform % of %, trustee % of %', NEW.id, c.platform, NEW.approvals_needed,
        c.trustee, NEW.trustee_approvals_needed USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER requests_trustee_guard BEFORE UPDATE ON signer.requests FOR EACH ROW EXECUTE FUNCTION signer.guard_trustee_requirement();

/** T-1: an approval's capacity follows the approver's role, whatever the INSERT says. */
CREATE FUNCTION signer.set_approval_capacity() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, signer AS $$
BEGIN
  NEW.capacity := CASE WHEN admin.officer_holds(NEW.operator, ARRAY['trustee_officer'], true) THEN 'trustee' ELSE 'platform' END;
  RETURN NEW;
END $$;
CREATE TRIGGER approvals_capacity BEFORE INSERT ON signer.approvals FOR EACH ROW EXECUTE FUNCTION signer.set_approval_capacity();

/**
 * S-3 + T-1: one operator's decision. Platform approvals and the trustee co-signature are counted
 * separately; the request is approved when both are complete. One rejection is final.
 */
CREATE OR REPLACE FUNCTION signer.decide(p_request uuid, p_operator text, p_decision text, p_reason text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, signer AS $$
DECLARE
  r signer.requests;
  c record;
  v_trustee boolean;
BEGIN
  IF p_decision NOT IN ('approve', 'reject') THEN RAISE EXCEPTION 'decision must be approve or reject' USING ERRCODE = 'check_violation'; END IF;
  SELECT * INTO r FROM signer.requests WHERE id = p_request FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown request' USING ERRCODE = 'no_data_found'; END IF;
  IF r.status <> 'pending_approval' THEN RETURN r.status; END IF;
  IF r.expires_at < now() THEN
    UPDATE signer.requests SET status = 'expired', reason = 'approval window closed' WHERE id = r.id;
    PERFORM signer.audit_append(p_operator, 'request.expired', r.id, '{}'::jsonb);
    RETURN 'expired';
  END IF;
  IF p_operator = r.requested_by THEN
    RAISE EXCEPTION 'maker-checker: the requester cannot approve their own request' USING ERRCODE = 'check_violation';
  END IF;
  v_trustee := admin.officer_holds(p_operator, ARRAY['trustee_officer'], true);
  IF v_trustee AND r.trustee_approvals_needed = 0 THEN
    RAISE EXCEPTION 'this request needs no trustee co-signature' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO c FROM signer.approval_counts(r.id);
  IF p_decision = 'approve' AND v_trustee AND c.trustee >= r.trustee_approvals_needed THEN
    RAISE EXCEPTION 'the trustee co-signature is already recorded' USING ERRCODE = 'check_violation';
  END IF;
  IF p_decision = 'approve' AND NOT v_trustee AND c.platform >= r.approvals_needed THEN
    RAISE EXCEPTION 'the platform approvals are complete: only the trustee co-signs now' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO signer.approvals (request_id, operator, decision, reason) VALUES (r.id, p_operator, p_decision, p_reason);
  PERFORM signer.audit_append(p_operator, 'request.' || p_decision, r.id,
    jsonb_build_object('reason', p_reason, 'capacity', CASE WHEN v_trustee THEN 'trustee' ELSE 'platform' END));
  IF p_decision = 'reject' THEN
    UPDATE signer.requests SET status = 'rejected', reason = left('rejected by ' || p_operator || ': ' || coalesce(p_reason, ''), 500) WHERE id = r.id;
    RETURN 'rejected';
  END IF;
  SELECT * INTO c FROM signer.approval_counts(r.id);
  IF c.platform >= r.approvals_needed AND c.trustee >= r.trustee_approvals_needed THEN
    UPDATE signer.requests SET status = 'approved' WHERE id = r.id;
    PERFORM signer.audit_append('signer', 'request.approved', r.id, jsonb_build_object('approvals', c.platform + c.trustee, 'trustee', c.trustee));
    RETURN 'approved';
  END IF;
  RETURN 'pending_approval';
END $$;

-- ------------------------------------------------------------------ T-2 trustee tickets (6b path)
ALTER TABLE admin.signer_tickets ADD COLUMN capacity text NOT NULL DEFAULT 'platform' CHECK (capacity IN ('platform', 'trustee'));

CREATE OR REPLACE FUNCTION admin.guard_signer_ticket() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'decision tickets are never deleted' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF (NEW.token_hash, NEW.session_hash, NEW.officer_id, NEW.request_id, NEW.decision, NEW.reason, NEW.payload_hash, NEW.call_hash, NEW.created_at, NEW.expires_at, NEW.capacity)
     IS DISTINCT FROM (OLD.token_hash, OLD.session_hash, OLD.officer_id, OLD.request_id, OLD.decision, OLD.reason, OLD.payload_hash, OLD.call_hash, OLD.created_at, OLD.expires_at, OLD.capacity)
     OR (OLD.used_at IS NOT NULL AND NEW.used_at IS DISTINCT FROM OLD.used_at)
     OR (OLD.result IS NOT NULL AND NEW.result IS DISTINCT FROM OLD.result) THEN
    RAISE EXCEPTION 'a decision ticket is used once and never changed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

/** Why this operations officer cannot decide this signing request now (empty = they can). 0016 + T-1. */
CREATE OR REPLACE FUNCTION admin.signer_blockers(p_officer uuid, r signer.requests) RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_handle text := admin.handle_of(p_officer);
  v text[] := '{}';
  c record;
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
  SELECT * INTO c FROM signer.approval_counts(r.id);
  IF r.status = 'pending_approval' AND c.platform >= r.approvals_needed THEN
    v := v || 'The platform approvals are complete: the trustee co-signs next (trustee portal).'::text;
  END IF;
  RETURN v;
END $$;

/** Why this officer cannot co-sign this signing request for the trustee now (empty = they can). */
CREATE FUNCTION admin.trustee_signer_blockers(p_officer uuid, r signer.requests) RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_handle text := admin.handle_of(p_officer);
  v text[] := '{}';
  c record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admin.role_grants g JOIN admin.role_permissions p ON p.role = g.role
                 WHERE g.officer_id = p_officer AND g.revoked_at IS NULL AND p.permission = 'trustee.decide') THEN
    v := v || 'Only a trustee officer co-signs for the trustee; your role reviews.'::text;
  END IF;
  IF r.trustee_approvals_needed = 0 THEN v := v || 'This request needs no trustee co-signature.'::text; END IF;
  IF r.status <> 'pending_approval' THEN v := v || format('The request is %s, no longer waiting for approval.', r.status); END IF;
  IF r.status = 'pending_approval' AND r.expires_at <= now() THEN v := v || 'The 24-hour approval window has closed.'::text; END IF;
  IF r.requested_by = v_handle THEN v := v || 'You requested it: a different officer decides (maker-checker).'::text; END IF;
  IF EXISTS (SELECT 1 FROM signer.approvals a WHERE a.request_id = r.id AND a.operator = v_handle) THEN
    v := v || 'You already decided this request.'::text;
  END IF;
  SELECT * INTO c FROM signer.approval_counts(r.id);
  IF r.trustee_approvals_needed > 0 AND c.trustee >= r.trustee_approvals_needed THEN
    v := v || 'The trustee co-signature is already recorded.'::text;
  END IF;
  RETURN v;
END $$;

/**
 * Step 1 of a trustee co-signature (portal): session, trustee.decide, fresh step-up, the payload the
 * officer reviewed, blockers; then a one-time ticket of capacity "trustee" for the signing service.
 */
CREATE FUNCTION admin.issue_trustee_ticket(p_session bytea, p_request uuid, p_decision text, p_reason text,
                                           p_payload_hash bytea, p_call_hash bytea, p_token_hash bytea)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'trustee.decide');
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
  IF NOT FOUND THEN RETURN admin.refuse(v_me, 'trustee.signer', p_request::text, p_decision, 'unknown signing request'); END IF;
  IF r.payload_hash <> p_payload_hash THEN
    RETURN admin.refuse(v_me, 'trustee.signer', r.id::text, p_decision, 'the request differs from what you reviewed: reload and check again');
  END IF;
  v_blockers := admin.trustee_signer_blockers(v_me, r);
  IF cardinality(v_blockers) > 0 THEN RETURN admin.refuse(v_me, 'trustee.signer', r.id::text, p_decision, v_blockers[1]); END IF;
  INSERT INTO admin.signer_tickets (token_hash, session_hash, officer_id, request_id, decision, reason, payload_hash, call_hash, created_at, expires_at, capacity)
  VALUES (p_token_hash, p_session, v_me, r.id, p_decision, btrim(p_reason), p_payload_hash, p_call_hash, v_now, v_now + interval '2 minutes', 'trustee');
  PERFORM admin.audit_append(v_me::text, 'approval.ticket', jsonb_build_object('kind', 'trustee.signer', 'ref', r.id, 'decision', p_decision,
    'payloadHash', encode(p_payload_hash, 'hex'), 'callHash', encode(p_call_hash, 'hex'), 'ticket', left(encode(p_token_hash, 'hex'), 16)));
  RETURN jsonb_build_object('ok', true, 'expiresAt', admin.utc(v_now + interval '2 minutes'));
END $$;

/** 0016 step 2 + T-2: a trustee ticket needs trustee.decide on redemption, a platform ticket approvals.decide. */
CREATE OR REPLACE FUNCTION admin.redeem_signer_ticket(p_token_hash bytea, p_request uuid, p_decision text, p_reason text, p_call_hash bytea)
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
  v_officer := admin.require(t.session_hash, CASE t.capacity WHEN 'trustee' THEN 'trustee.decide' ELSE 'approvals.decide' END);
  PERFORM admin.require_step_up(t.session_hash);
  IF v_officer IS DISTINCT FROM t.officer_id THEN
    RAISE EXCEPTION 'decision ticket belongs to another officer' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE admin.signer_tickets SET used_at = clock_timestamp() WHERE token_hash = t.token_hash;
  v_handle := admin.handle_of(v_officer);
  PERFORM admin.bind_officer(v_handle);
  RETURN v_handle;
END $$;

/** 0016 step 3 + T-2/T-6: the outcome in the ticket and the admin audit; a trustee co-signature also in trustee.audit. */
CREATE OR REPLACE FUNCTION admin.complete_signer_ticket(p_token_hash bytea, p_result text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  t admin.signer_tickets;
BEGIN
  SELECT * INTO t FROM admin.signer_tickets WHERE token_hash = p_token_hash FOR UPDATE;
  UPDATE admin.signer_tickets SET result = left(p_result, 40) WHERE token_hash = p_token_hash;
  PERFORM admin.audit_append(t.officer_id::text, 'approval.decided', jsonb_build_object('kind', CASE t.capacity WHEN 'trustee' THEN 'trustee.signer' ELSE 'signer' END,
    'ref', t.request_id, 'decision', t.decision, 'result', p_result, 'callHash', encode(t.call_hash, 'hex'), 'ticket', left(encode(t.token_hash, 'hex'), 16)));
  IF t.capacity = 'trustee' THEN
    PERFORM trustee.audit_append(admin.handle_of(t.officer_id), 'cosign.signer', jsonb_build_object('request', t.request_id, 'decision', t.decision,
      'result', p_result, 'reason', t.reason, 'payloadHash', encode(t.payload_hash, 'hex'), 'callHash', encode(t.call_hash, 'hex')));
  END IF;
  PERFORM admin.unbind_officer(admin.handle_of(t.officer_id));
END $$;

/** 0016 detail of a signing request, plus the trustee requirement and each approval's capacity. */
CREATE OR REPLACE FUNCTION admin.signer_request(p_session bytea, p_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'approvals.read');
BEGIN
  RETURN admin.signer_request_json(v_me, p_id, false);
END $$;

/** Shared body of the signing request reads (operations and trustee views). */
CREATE FUNCTION admin.signer_request_json(p_me uuid, p_id uuid, p_trustee boolean) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  r signer.requests;
  c record;
BEGIN
  SELECT * INTO r FROM signer.requests WHERE id = p_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO c FROM signer.approval_counts(r.id);
  RETURN jsonb_build_object(
    'id', r.id, 'commandRef', r.command_ref, 'kind', r.kind, 'keyRef', r.key_ref,
    'keyAddress', (SELECT k.address FROM signer.keys k WHERE k.key_ref = r.key_ref),
    'payload', r.payload, 'payloadHash', encode(r.payload_hash, 'hex'), 'amount', r.amount::text, 'requestedBy', r.requested_by,
    'status', r.status, 'approvalsNeeded', r.approvals_needed, 'trusteeApprovalsNeeded', r.trustee_approvals_needed,
    'platformApprovals', c.platform, 'trusteeApprovals', c.trustee, 'reason', r.reason, 'createdAt', admin.utc(r.created_at),
    'expiresAt', admin.utc(r.expires_at),
    'policy', (SELECT jsonb_build_object('id', p.id, 'version', p.version, 'proposedBy', p.proposed_by, 'approvedBy', p.approved_by,
                                         'active', p.approved_at IS NOT NULL AND p.retired_at IS NULL)
               FROM signer.policies p WHERE p.id = r.policy_id),
    'approvals', coalesce((SELECT jsonb_agg(jsonb_build_object('operator', a.operator, 'decision', a.decision, 'reason', a.reason, 'at', admin.utc(a.at),
                                                               'capacity', a.capacity) ORDER BY a.at) FROM signer.approvals a WHERE a.request_id = r.id), '[]'::jsonb),
    'command', (SELECT jsonb_build_object('id', x.id, 'status', x.status, 'createdBy', x.created_by, 'ref', x.ref, 'attempts', x.attempts,
                                          'lastError', left(x.last_error, 200), 'createdAt', admin.utc(x.created_at))
                FROM outbox.commands x WHERE x.idempotency_key = r.command_ref),
    'gate', CASE WHEN r.kind ~ '^(payout|rent|distribution)\.' THEN admin.gate_json() END,
    'blockers', to_jsonb(CASE WHEN p_trustee THEN admin.trustee_signer_blockers(p_me, r) ELSE admin.signer_blockers(p_me, r) END));
END $$;

-- ================================================================== T-2 offering requests that need the trustee
/**
 * S-02 duties for portal officers: the trustee duty is the trustee_officer role (active); any other
 * duty needs its row and an officer who is not a trustee officer (OF-SOD-4). Names that are not
 * portal officers keep the 0015 rule (command line, break-glass; see ADR 0011 section 12).
 */
CREATE OR REPLACE FUNCTION offering.has_duty(p_actor text, p_duty text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, offering AS $$
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM admin.officers o WHERE o.handle = p_actor) THEN
      CASE WHEN p_duty = 'trustee' THEN admin.officer_holds(p_actor, ARRAY['trustee_officer'], true)
           ELSE EXISTS (SELECT 1 FROM offering.duties WHERE actor = p_actor AND status = 'active' AND duty = p_duty)
                AND NOT admin.officer_holds(p_actor, ARRAY['trustee_officer'], false) END
    ELSE EXISTS (SELECT 1 FROM offering.duties WHERE actor = p_actor AND status = 'active' AND duty = p_duty)
  END
$$;

/** OF-SOD-4 for portal officers: a trustee duty row only for a trustee officer, no other duty for one. */
CREATE FUNCTION admin.check_offering_duty() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM admin.officers WHERE handle = NEW.actor) THEN
    IF NEW.duty = 'trustee' AND NOT admin.officer_holds(NEW.actor, ARRAY['trustee_officer'], false) THEN
      RAISE EXCEPTION 'the offering trustee duty belongs to trustee officers only; % is not one', NEW.actor USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.duty <> 'trustee' AND admin.officer_holds(NEW.actor, ARRAY['trustee_officer'], false) THEN
      RAISE EXCEPTION 'a trustee officer holds no platform duty (OF-SOD-4)' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER duties_officer_check BEFORE INSERT ON offering.duties FOR EACH ROW EXECUTE FUNCTION admin.check_offering_duty();


/** Digest of an S-02 request as the trustee officer reviewed it. */
CREATE FUNCTION admin.offering_request_digest(p_request bigint) RETURNS bytea
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
  SELECT sha256(convert_to('pt-offering-request-v1' || jsonb_build_array(q.id, q.offering_id, q.subscription_id, q.code, q.offering_state,
           q.requested_by, q.reason, q.detail, admin.utc(q.requested_at), admin.utc(q.expires_at),
           (SELECT encode(b.digest, 'hex') FROM offering.issuance_batches b WHERE b.request_id = q.id))::text, 'UTF8'))
  FROM offering.requests q WHERE q.id = p_request
$$;

/** Whether an open offering request still needs a trustee vote. */
CREATE FUNCTION admin.offering_needs_trustee(q offering.requests) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
  SELECT q.status = 'open'
     AND (SELECT count(*) FROM offering.request_rules rr, unnest(rr.needs) x WHERE rr.code = q.code AND x = 'trustee')
       > (SELECT count(*) FROM offering.request_votes v WHERE v.request_id = q.id AND v.duty = 'trustee' AND v.approve)
$$;

CREATE FUNCTION admin.trustee_offering_blockers(p_officer uuid, q offering.requests) RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_handle text := admin.handle_of(p_officer);
  v text[] := '{}';
  rr offering.request_rules;
  v_state text;
BEGIN
  SELECT * INTO rr FROM offering.request_rules WHERE code = q.code;
  SELECT state INTO v_state FROM offering.offerings WHERE id = q.offering_id;
  IF NOT EXISTS (SELECT 1 FROM admin.role_grants g JOIN admin.role_permissions p ON p.role = g.role
                 WHERE g.officer_id = p_officer AND g.revoked_at IS NULL AND p.permission = 'trustee.decide') THEN
    v := v || 'Only a trustee officer votes for the trustee; your role reviews.'::text;
  END IF;
  IF NOT ('trustee' = ANY (rr.needs)) THEN v := v || 'This request needs no trustee vote.'::text; END IF;
  IF q.status <> 'open' THEN v := v || format('The request is %s.', q.status); END IF;
  IF q.status = 'open' AND rr.expires AND q.expires_at < now() THEN v := v || 'The request has expired (72 hours).'::text; END IF;
  IF q.status = 'open' AND rr.stale_on_state AND v_state IS DISTINCT FROM q.offering_state THEN
    v := v || format('The offering moved from %s to %s since the request: it is stale.', q.offering_state, v_state);
  END IF;
  IF q.requested_by = v_handle THEN v := v || 'You requested it: a different officer decides (maker-checker).'::text; END IF;
  IF EXISTS (SELECT 1 FROM offering.request_votes WHERE request_id = q.id AND officer = v_handle) THEN
    v := v || 'You already voted on this request.'::text;
  ELSIF q.status = 'open' AND 'trustee' = ANY (rr.needs) AND NOT admin.offering_needs_trustee(q) THEN
    v := v || 'The trustee vote is already recorded.'::text;
  END IF;
  RETURN v;
END $$;

/** One S-02 request as the trustee sees it: the transition, the batch or completion, votes, digest. */
CREATE FUNCTION admin.trustee_offering_request(p_session bytea, p_id bigint) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'trustee.read');
  q offering.requests;
  o offering.offerings;
  rr offering.request_rules;
  b offering.issuance_batches;
  v_problem text;
BEGIN
  SELECT * INTO q FROM offering.requests WHERE id = p_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO o FROM offering.offerings WHERE id = q.offering_id;
  SELECT * INTO rr FROM offering.request_rules WHERE code = q.code;
  SELECT * INTO b FROM offering.issuance_batches WHERE request_id = q.id;
  IF q.status = 'open' THEN v_problem := offering.request_problem(q.offering_id, q.code, q.subscription_id, q.detail); END IF;
  RETURN jsonb_build_object(
    'id', q.id, 'code', q.code, 'note', rr.note, 'needs', to_jsonb(rr.needs), 'status', q.status, 'offeringState', q.offering_state,
    'requestedBy', q.requested_by, 'reason', q.reason, 'detail', q.detail, 'requestedAt', admin.utc(q.requested_at),
    'expiresAt', admin.utc(q.expires_at), 'decidedAt', admin.utc(q.decided_at),
    'offering', jsonb_build_object('id', o.id, 'state', o.state, 'token', o.token, 'priceRupees', CASE WHEN o.price_paisa IS NOT NULL THEN (o.price_paisa / 100.0)::text END,
                                   'minRaiseUnits', o.min_raise_units, 'targetUnits', o.target_units, 'hardCapUnits', o.hard_cap_units,
                                   'trusteeCap', (SELECT t.trustee_cap::text FROM chain.tokens t WHERE t.token = o.token),
                                   'supply', (SELECT t.total_supply::text FROM chain.tokens t WHERE t.token = o.token)),
    'batch', CASE WHEN b.id IS NOT NULL THEN jsonb_build_object('id', b.id, 'digest', encode(b.digest, 'hex'), 'items', b.item_count,
               'totalUnits', b.total_units, 'preparedBy', b.prepared_by, 'preparedAt', admin.utc(b.prepared_at),
               'matchesAllocations', b.digest = offering.batch_digest(offering.allocation_items(q.offering_id)),
               'lines', coalesce((SELECT jsonb_agg(jsonb_build_object('line', i.line_no, 'refId', i.ref_id, 'wallet', i.wallet, 'units', i.units) ORDER BY i.line_no)
                                  FROM (SELECT * FROM offering.issuance_items WHERE batch_id = b.id ORDER BY line_no LIMIT 1000) i), '[]'::jsonb)) END,
    'votes', coalesce((SELECT jsonb_agg(jsonb_build_object('officer', v.officer, 'duty', v.duty, 'approve', v.approve, 'reason', v.reason, 'at', admin.utc(v.at)) ORDER BY v.at)
                       FROM offering.request_votes v WHERE v.request_id = q.id), '[]'::jsonb),
    'problem', v_problem,
    'digest', encode(admin.offering_request_digest(q.id), 'hex'),
    'blockers', to_jsonb(admin.trustee_offering_blockers(v_me, q)),
    'approveBlockers', to_jsonb(CASE WHEN v_problem IS NOT NULL THEN ARRAY['The request no longer holds: ' || v_problem] ELSE '{}'::text[] END));
END $$;

/** Trustee officer: vote on an S-02 request that needs the trustee (offering.decide under the officer's handle). */
CREATE FUNCTION admin.decide_offering_request(p_session bytea, p_request bigint, p_decision text, p_reason text, p_digest bytea)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'trustee.decide');
  v_handle text := admin.handle_of(v_me);
  q offering.requests;
  v_blockers text[];
  v_status text;
BEGIN
  PERFORM admin.require_step_up(p_session);
  PERFORM admin.check_decision(p_decision, p_reason);
  SELECT * INTO q FROM offering.requests WHERE id = p_request;
  IF NOT FOUND THEN RETURN admin.refuse(v_me, 'trustee.offering', p_request::text, p_decision, 'unknown request'); END IF;
  IF admin.offering_request_digest(q.id) IS DISTINCT FROM p_digest THEN
    RETURN admin.refuse(v_me, 'trustee.offering', q.id::text, p_decision, 'the request differs from what you reviewed: reload and check again');
  END IF;
  v_blockers := admin.trustee_offering_blockers(v_me, q);
  IF cardinality(v_blockers) > 0 THEN RETURN admin.refuse(v_me, 'trustee.offering', q.id::text, p_decision, v_blockers[1]); END IF;
  BEGIN
    PERFORM admin.bind_officer(v_handle);
    v_status := offering.decide(q.id, v_handle, p_decision = 'approve', btrim(p_reason));
    PERFORM admin.unbind_officer(v_handle);
  EXCEPTION WHEN SQLSTATE '23514' OR SQLSTATE '23505' OR SQLSTATE '42501' OR SQLSTATE '22023' OR SQLSTATE 'P0002' THEN
    RETURN admin.refuse(v_me, 'trustee.offering', q.id::text, p_decision, SQLERRM);
  END;
  PERFORM trustee.audit_append(v_handle, 'cosign.offering', jsonb_build_object('request', q.id, 'code', q.code, 'offering', q.offering_id,
    'decision', p_decision, 'result', v_status, 'reason', btrim(p_reason), 'digest', encode(p_digest, 'hex')));
  PERFORM admin.audit_append(v_me::text, 'approval.decided', jsonb_build_object('kind', 'trustee.offering', 'ref', q.id, 'decision', p_decision,
    'result', v_status, 'digest', encode(p_digest, 'hex')));
  RETURN jsonb_build_object('ok', true, 'status', v_status);
END $$;

-- ================================================================== T-3 rent distribution review
CREATE TABLE trustee.distribution_reviews (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  registry        text NOT NULL CHECK (length(registry) = 42 AND registry ~ '^0x[0-9a-f]+$'),
  distribution_id numeric(78,0) NOT NULL CHECK (distribution_id > 0),
  token           text NOT NULL CHECK (length(token) = 42 AND token ~ '^0x[0-9a-f]+$'),
  decision        text NOT NULL CHECK (decision IN ('approve', 'reject')),
  reason          text NOT NULL CHECK (length(reason) BETWEEN 10 AND 500),
  -- What the officer reviewed (trustee.distribution_digest) and, for an approval, the root they recomputed.
  digest          bytea NOT NULL CHECK (length(digest) = 32),
  recomputed_root text CHECK (length(recomputed_root) = 66 AND recomputed_root ~ '^0x[0-9a-f]+$'),
  window_closes   timestamptz NOT NULL,
  decided_by      text NOT NULL CHECK (length(decided_by) BETWEEN 2 AND 100),
  decided_at      timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  UNIQUE (registry, distribution_id),
  CHECK ((decision = 'approve') = (recomputed_root IS NOT NULL)),
  CHECK (decided_at < window_closes)
);
CREATE INDEX distribution_reviews_token_idx ON trustee.distribution_reviews (token, distribution_id);

CREATE FUNCTION trustee.distribution_digest(p_registry text, p_id numeric) RETURNS bytea
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trustee AS $$
  SELECT sha256(convert_to('pt-trustee-distribution-v1' || jsonb_build_array(d.registry, d.id::text, d.token, d.record_block, d.merkle_root,
           d.total_paisa::text, d.statement_hash, d.status, d.published_block)::text, 'UTF8'))
  FROM chain.distributions d WHERE d.registry = p_registry AND d.id = p_id
$$;

/** End of the 48-hour challenge window (contract CHALLENGE_WINDOW), from the publish block's time; NULL if unknown. */
CREATE FUNCTION trustee.window_closes(p_registry text, p_id numeric) RETURNS timestamptz
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trustee AS $$
  SELECT b.block_time + interval '48 hours'
  FROM chain.distributions d JOIN chain.blocks b ON b.number = d.published_block
  WHERE d.registry = p_registry AND d.id = p_id
$$;

/** T-3: why finalisation of this distribution is blocked (NULL = not blocked by the trustee). Hook for any finalise path. */
CREATE FUNCTION trustee.distribution_blocked(p_token text, p_id numeric) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trustee AS $$
  SELECT format('the trustee rejected distribution %s of %s (%s): %s', r.distribution_id, r.token, r.decided_by, r.reason)
  FROM trustee.distribution_reviews r WHERE r.token = lower(p_token) AND r.distribution_id = p_id AND r.decision = 'reject'
  LIMIT 1
$$;

/** Records the trustee's decision on a published distribution inside the window. */
CREATE FUNCTION trustee.review_distribution(p_registry text, p_id numeric, p_actor text, p_decision text, p_reason text, p_digest bytea, p_root text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trustee AS $$
DECLARE
  d chain.distributions;
  v_closes timestamptz;
  v_id bigint;
BEGIN
  PERFORM trustee.need_trustee(p_actor, 'review a distribution');
  PERFORM trustee.check_reason(p_reason);
  IF p_decision IS NULL OR p_decision NOT IN ('approve', 'reject') THEN PERFORM trustee.fail('22023', 'decision must be approve or reject'); END IF;
  SELECT * INTO d FROM chain.distributions WHERE registry = lower(p_registry) AND id = p_id;
  IF NOT FOUND THEN PERFORM trustee.fail('P0002', 'unknown distribution'); END IF;
  -- One decision per distribution, serialised.
  PERFORM pg_advisory_xact_lock(586586231, hashtext(d.registry || ':' || d.id::text));
  IF EXISTS (SELECT 1 FROM trustee.distribution_reviews WHERE registry = d.registry AND distribution_id = d.id) THEN
    PERFORM trustee.fail('23505', 'the trustee already decided this distribution');
  END IF;
  IF d.status <> 'published' THEN PERFORM trustee.fail('23514', format('the distribution is %s on chain: the review window is for published distributions', d.status)); END IF;
  v_closes := trustee.window_closes(d.registry, d.id);
  IF v_closes IS NULL THEN PERFORM trustee.fail('23514', 'the publish time is unknown in the read model: wait for the indexer'); END IF;
  IF clock_timestamp() >= v_closes THEN PERFORM trustee.fail('23514', format('the 48-hour review window closed at %s UTC', trustee.utc(v_closes))); END IF;
  IF trustee.distribution_digest(d.registry, d.id) IS DISTINCT FROM p_digest THEN
    PERFORM trustee.fail('23514', 'the distribution differs from what you reviewed: reload and check again');
  END IF;
  IF p_decision = 'approve' AND (p_root IS NULL OR lower(p_root) IS DISTINCT FROM lower(d.merkle_root)) THEN
    PERFORM trustee.fail('23514', 'your recomputed Merkle root differs from the published root: reject the distribution instead');
  END IF;
  INSERT INTO trustee.distribution_reviews (registry, distribution_id, token, decision, reason, digest, recomputed_root, window_closes, decided_by)
  VALUES (d.registry, d.id, d.token, p_decision, btrim(p_reason), p_digest, CASE WHEN p_decision = 'approve' THEN lower(p_root) END, v_closes, p_actor)
  RETURNING id INTO v_id;
  PERFORM trustee.audit_append(p_actor, 'distribution.reviewed', jsonb_build_object('review', v_id, 'registry', d.registry, 'distribution', d.id::text,
    'token', d.token, 'decision', p_decision, 'reason', btrim(p_reason), 'digest', encode(p_digest, 'hex'), 'merkleRoot', d.merkle_root));
  IF p_decision = 'reject' THEN
    PERFORM pg_notify('trustee_alert', json_build_object('kind', 'distribution_rejected', 'registry', d.registry, 'distribution', d.id::text)::text);
  END IF;
  RETURN v_id;
END $$;

/** T-3: a rejected distribution gets no payout batch. */
CREATE FUNCTION trustee.guard_payout_batch() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trustee AS $$
DECLARE
  v text := trustee.distribution_blocked(NEW.token, NEW.distribution_id);
BEGIN
  IF v IS NOT NULL THEN RAISE EXCEPTION 'payout refused: %', v USING ERRCODE = 'check_violation'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payout_batches_trustee_review BEFORE INSERT ON bank.payout_batches FOR EACH ROW EXECUTE FUNCTION trustee.guard_payout_batch();

/** T-3: a rejected distribution is never booked (rent:distribution:<token>:<id>, and S-03's rent:wht:<token>:<id>). */
CREATE FUNCTION trustee.guard_distribution_journal() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trustee AS $$
DECLARE
  v_token text := split_part(NEW.idempotency_key, ':', 3);
  v_id text := split_part(NEW.idempotency_key, ':', 4);
  v text;
BEGIN
  IF v_id ~ '^[1-9][0-9]{0,77}$' THEN
    v := trustee.distribution_blocked(v_token, v_id::numeric);
    IF v IS NOT NULL THEN RAISE EXCEPTION 'booking refused: %', v USING ERRCODE = 'check_violation'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER journal_trustee_review BEFORE INSERT ON ledger.journal FOR EACH ROW
  WHEN (NEW.idempotency_key LIKE 'rent:distribution:%' OR NEW.idempotency_key LIKE 'rent:wht:%') EXECUTE FUNCTION trustee.guard_distribution_journal();

-- ================================================================== T-4 the trustee's register
CREATE TABLE trustee.register_entries (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  token      text NOT NULL CHECK (length(token) = 42 AND token ~ '^0x[0-9a-f]+$'),
  wallet     text NOT NULL CHECK (length(wallet) = 42 AND wallet ~ '^0x[0-9a-f]+$'),
  units      bigint NOT NULL CHECK (units <> 0 AND units BETWEEN -1000000000000 AND 1000000000000),
  source     text NOT NULL CHECK (source IN ('offering', 'adjustment')),
  source_ref text NOT NULL CHECK (length(source_ref) BETWEEN 3 AND 120),
  entered_by text NOT NULL CHECK (length(entered_by) BETWEEN 2 AND 100),
  at         timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  UNIQUE (source, source_ref)
);
CREATE INDEX register_entries_token_idx ON trustee.register_entries (token, wallet);

CREATE FUNCTION trustee.register_balance(p_token text, p_wallet text) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trustee AS $$
  SELECT coalesce(sum(units), 0)::bigint FROM trustee.register_entries WHERE token = p_token AND wallet = p_wallet
$$;

CREATE FUNCTION trustee.enter(p_token text, p_wallet text, p_units bigint, p_source text, p_ref text, p_actor text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trustee AS $$
DECLARE
  v_id bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(586586232, hashtext(p_token || ':' || p_wallet));
  IF trustee.register_balance(p_token, p_wallet) + p_units < 0 THEN
    PERFORM trustee.fail('23514', format('the register balance of %s would go below zero', p_wallet));
  END IF;
  INSERT INTO trustee.register_entries (token, wallet, units, source, source_ref, entered_by)
  VALUES (p_token, p_wallet, p_units, p_source, p_ref, p_actor) RETURNING id INTO v_id;
  PERFORM trustee.audit_append(p_actor, 'register.entered', jsonb_build_object('entry', v_id, 'token', p_token, 'wallet', p_wallet,
    'units', p_units::text, 'source', p_source, 'ref', p_ref));
  RETURN v_id;
END $$;

/** V18 (trustee confirmed the register entries) adds units; a redemption removes them (S-05). */
CREATE FUNCTION trustee.on_subscription_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trustee AS $$
DECLARE
  s offering.subscriptions;
  v_token text;
BEGIN
  SELECT * INTO s FROM offering.subscriptions WHERE id = NEW.subscription_id;
  SELECT token INTO v_token FROM offering.offerings WHERE id = s.offering_id;
  IF v_token IS NULL OR s.wallet IS NULL THEN
    RAISE EXCEPTION 'subscription % reached % without a token or wallet: the trustee register cannot record it', s.id, NEW.to_state
      USING ERRCODE = 'check_violation';
  END IF;
  PERFORM trustee.enter(v_token, s.wallet, CASE WHEN NEW.to_state = 'active' THEN s.units ELSE -s.units END, 'offering',
                        format('subscription:%s:%s', s.id, NEW.to_state), NEW.actor);
  RETURN NEW;
END $$;
CREATE TRIGGER subscription_events_trustee_register AFTER INSERT ON offering.subscription_events FOR EACH ROW
  WHEN (NEW.to_state IN ('active', 'redeemed')) EXECUTE FUNCTION trustee.on_subscription_event();

-- Backfill: register entries the trustee already confirmed before this migration.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT s.id, s.wallet, s.units, o.token FROM offering.subscriptions s JOIN offering.offerings o ON o.id = s.offering_id
           WHERE s.state IN ('active', 'redeemed') AND o.token IS NOT NULL AND s.wallet IS NOT NULL ORDER BY s.created_at, s.id LOOP
    PERFORM trustee.enter(r.token, r.wallet, r.units, 'offering', format('subscription:%s:active', r.id), 'migration:0023');
  END LOOP;
  FOR r IN SELECT s.id, s.wallet, s.units, o.token FROM offering.subscriptions s JOIN offering.offerings o ON o.id = s.offering_id
           WHERE s.state = 'redeemed' AND o.token IS NOT NULL AND s.wallet IS NOT NULL ORDER BY s.created_at, s.id LOOP
    PERFORM trustee.enter(r.token, r.wallet, -r.units, 'offering', format('subscription:%s:redeemed', r.id), 'migration:0023');
  END LOOP;
END $$;

-- Two-officer register adjustments (opening balances and corrections), with evidence.
CREATE TABLE trustee.adjustments (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  token           text NOT NULL CHECK (length(token) = 42 AND token ~ '^0x[0-9a-f]+$'),
  wallet          text NOT NULL CHECK (length(wallet) = 42 AND wallet ~ '^0x[0-9a-f]+$'),
  units           bigint NOT NULL CHECK (units <> 0 AND units BETWEEN -1000000000000 AND 1000000000000),
  evidence_sha    bytea NOT NULL CHECK (length(evidence_sha) = 32),
  reason          text NOT NULL CHECK (length(reason) BETWEEN 10 AND 500),
  proposed_by     text NOT NULL CHECK (length(proposed_by) BETWEEN 2 AND 100),
  proposed_at     timestamptz NOT NULL,
  expires_at      timestamptz NOT NULL,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'approved', 'rejected', 'expired')),
  decided_by      text CHECK (length(decided_by) BETWEEN 2 AND 100),
  decision_reason text CHECK (length(decision_reason) BETWEEN 10 AND 500),
  decided_at      timestamptz,
  entry_id        bigint UNIQUE REFERENCES trustee.register_entries (id),
  CHECK (expires_at = proposed_at + interval '72 hours'),
  CHECK (decided_by IS DISTINCT FROM proposed_by),
  CHECK ((status IN ('approved', 'rejected')) = (decided_by IS NOT NULL AND decision_reason IS NOT NULL)),
  CHECK ((status = 'open') = (decided_at IS NULL)),
  CHECK ((status = 'approved') = (entry_id IS NOT NULL))
);
CREATE UNIQUE INDEX adjustments_one_open ON trustee.adjustments (token, wallet) WHERE status = 'open';

CREATE FUNCTION trustee.guard_adjustment() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'adjustments are never deleted' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF OLD.status <> 'open' OR NEW.status = 'open'
     OR (NEW.id, NEW.token, NEW.wallet, NEW.units, NEW.evidence_sha, NEW.reason, NEW.proposed_by, NEW.proposed_at, NEW.expires_at)
        IS DISTINCT FROM (OLD.id, OLD.token, OLD.wallet, OLD.units, OLD.evidence_sha, OLD.reason, OLD.proposed_by, OLD.proposed_at, OLD.expires_at) THEN
    RAISE EXCEPTION 'adjustment % is decided once', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER adjustments_guard BEFORE UPDATE OR DELETE ON trustee.adjustments FOR EACH ROW EXECUTE FUNCTION trustee.guard_adjustment();

CREATE FUNCTION trustee.adjustment_digest(p_id bigint) RETURNS bytea
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trustee AS $$
  SELECT sha256(convert_to('pt-trustee-adjustment-v1' || jsonb_build_array(a.id, a.token, a.wallet, a.units::text, encode(a.evidence_sha, 'hex'),
           a.reason, a.proposed_by, trustee.utc(a.proposed_at), trustee.utc(a.expires_at))::text, 'UTF8'))
  FROM trustee.adjustments a WHERE a.id = p_id
$$;

CREATE FUNCTION trustee.propose_adjustment(p_token text, p_wallet text, p_units bigint, p_evidence bytea, p_reason text, p_actor text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trustee AS $$
DECLARE
  v_id bigint;
  v_now timestamptz := date_trunc('microseconds', clock_timestamp());
BEGIN
  PERFORM trustee.need_trustee(p_actor, 'propose a register adjustment');
  PERFORM trustee.check_reason(p_reason);
  IF p_token IS NULL OR NOT EXISTS (SELECT 1 FROM chain.tokens WHERE token = p_token) THEN PERFORM trustee.fail('P0002', 'unknown token'); END IF;
  IF p_wallet IS NULL OR length(p_wallet) <> 42 OR p_wallet !~ '^0x[0-9a-f]+$' THEN PERFORM trustee.fail('22023', 'a wallet address (0x and 40 lower-case hex) is required'); END IF;
  IF p_units IS NULL OR p_units = 0 OR abs(p_units) > 1000000000000 THEN PERFORM trustee.fail('22023', 'units must be a non-zero whole number'); END IF;
  IF length(p_evidence) IS DISTINCT FROM 32 THEN PERFORM trustee.fail('22023', 'the SHA-256 of the evidence is required'); END IF;
  IF trustee.register_balance(p_token, p_wallet) + p_units < 0 THEN
    PERFORM trustee.fail('23514', 'the register balance of this wallet would go below zero');
  END IF;
  IF EXISTS (SELECT 1 FROM trustee.adjustments WHERE token = p_token AND wallet = p_wallet AND status = 'open') THEN
    PERFORM trustee.fail('23505', 'an adjustment for this wallet is already open');
  END IF;
  INSERT INTO trustee.adjustments (token, wallet, units, evidence_sha, reason, proposed_by, proposed_at, expires_at)
  VALUES (p_token, p_wallet, p_units, p_evidence, btrim(p_reason), p_actor, v_now, v_now + interval '72 hours') RETURNING id INTO v_id;
  PERFORM trustee.audit_append(p_actor, 'adjustment.proposed', jsonb_build_object('adjustment', v_id, 'token', p_token, 'wallet', p_wallet,
    'units', p_units::text, 'evidence', encode(p_evidence, 'hex'), 'reason', btrim(p_reason)));
  RETURN v_id;
END $$;

CREATE FUNCTION trustee.decide_adjustment(p_id bigint, p_actor text, p_decision text, p_reason text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trustee AS $$
DECLARE
  a trustee.adjustments;
  v_entry bigint;
BEGIN
  PERFORM trustee.need_trustee(p_actor, 'decide a register adjustment');
  PERFORM trustee.check_reason(p_reason);
  IF p_decision IS NULL OR p_decision NOT IN ('approve', 'reject') THEN PERFORM trustee.fail('22023', 'decision must be approve or reject'); END IF;
  SELECT * INTO a FROM trustee.adjustments WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN PERFORM trustee.fail('P0002', 'unknown adjustment'); END IF;
  IF a.status <> 'open' THEN PERFORM trustee.fail('23514', format('the adjustment is %s', a.status)); END IF;
  IF a.expires_at <= clock_timestamp() THEN
    UPDATE trustee.adjustments SET status = 'expired', decided_at = clock_timestamp() WHERE id = a.id;
    PERFORM trustee.audit_append(p_actor, 'adjustment.expired', jsonb_build_object('adjustment', a.id));
    RETURN 'expired';
  END IF;
  IF a.proposed_by = p_actor THEN PERFORM trustee.fail('42501', 'you proposed it: a different trustee officer decides (four eyes)'); END IF;
  IF p_decision = 'approve' THEN
    v_entry := trustee.enter(a.token, a.wallet, a.units, 'adjustment', format('adjustment:%s', a.id), p_actor);
  END IF;
  UPDATE trustee.adjustments SET status = CASE WHEN p_decision = 'approve' THEN 'approved' ELSE 'rejected' END, decided_by = p_actor,
         decision_reason = btrim(p_reason), decided_at = date_trunc('microseconds', clock_timestamp()), entry_id = v_entry
  WHERE id = a.id;
  PERFORM trustee.audit_append(p_actor, 'adjustment.decided', jsonb_build_object('adjustment', a.id, 'decision', p_decision,
    'reason', btrim(p_reason), 'entry', v_entry));
  RETURN CASE WHEN p_decision = 'approve' THEN 'approved' ELSE 'rejected' END;
END $$;

/** The register next to the read model for one token: one line per wallet that holds units in either. */
CREATE FUNCTION trustee.register_lines(p_token text)
RETURNS TABLE (wallet text, register_units numeric, chain_units numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trustee AS $$
  WITH r AS (SELECT e.wallet, sum(e.units)::numeric AS u FROM trustee.register_entries e WHERE e.token = p_token GROUP BY e.wallet),
       c AS (SELECT h.holder AS wallet, h.balance AS u FROM chain.holdings h WHERE h.token = p_token AND h.balance > 0)
  SELECT coalesce(r.wallet, c.wallet), coalesce(r.u, 0), coalesce(c.u, 0)
  FROM r FULL JOIN c ON c.wallet = r.wallet
  WHERE coalesce(r.u, 0) <> 0 OR coalesce(c.u, 0) <> 0
$$;

-- ================================================================== officer names bound to sessions (as 0016 A-3)
CREATE FUNCTION trustee.bind_actor() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trustee AS $$
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
CREATE TRIGGER distribution_reviews_officer_binding BEFORE INSERT ON trustee.distribution_reviews FOR EACH ROW EXECUTE FUNCTION trustee.bind_actor('decided_by');
CREATE TRIGGER adjustments_officer_binding BEFORE INSERT OR UPDATE ON trustee.adjustments
  FOR EACH ROW EXECUTE FUNCTION trustee.bind_actor('proposed_by', 'decided_by');
CREATE TRIGGER register_entries_officer_binding BEFORE INSERT ON trustee.register_entries FOR EACH ROW EXECUTE FUNCTION trustee.bind_actor('entered_by');

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['audit', 'distribution_reviews', 'register_entries'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON trustee.%I FOR EACH ROW EXECUTE FUNCTION trustee.forbid_change()', t || '_append_only', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['audit', 'distribution_reviews', 'register_entries', 'adjustments'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON trustee.%I FOR EACH STATEMENT EXECUTE FUNCTION trustee.forbid_change()', t || '_no_truncate', t);
  END LOOP;
END $$;

-- ================================================================== T-6 verification
CREATE FUNCTION trustee.verify_audit() RETURNS TABLE (audit_id bigint, problem text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, trustee AS $$
DECLARE
  a trustee.audit;
  v_prev bytea := decode(repeat('00', 32), 'hex');
  r record;
BEGIN
  FOR a IN SELECT * FROM trustee.audit ORDER BY id LOOP
    IF a.prev_hash <> v_prev THEN audit_id := a.id; problem := 'prev_hash does not match'; RETURN NEXT; END IF;
    IF a.hash <> trustee.audit_digest(a.prev_hash, a.id, a.at, a.actor, a.action, a.detail) THEN
      audit_id := a.id; problem := 'content does not match its hash'; RETURN NEXT;
    END IF;
    v_prev := a.hash;
  END LOOP;
  FOR r IN
    SELECT format('distribution review %s', d.id) AS what FROM trustee.distribution_reviews d WHERE NOT EXISTS (
      SELECT 1 FROM trustee.audit x WHERE x.action = 'distribution.reviewed' AND (x.detail->>'review')::bigint = d.id
        AND x.detail->>'decision' = d.decision AND x.detail->>'digest' = encode(d.digest, 'hex'))
    UNION ALL
    SELECT format('register entry %s', e.id) FROM trustee.register_entries e WHERE NOT EXISTS (
      SELECT 1 FROM trustee.audit x WHERE x.action = 'register.entered' AND (x.detail->>'entry')::bigint = e.id
        AND x.detail->>'units' = e.units::text AND x.detail->>'wallet' = e.wallet AND x.detail->>'token' = e.token)
    UNION ALL
    SELECT format('register entry %s: adjustment not approved', e.id) FROM trustee.register_entries e
      WHERE e.source = 'adjustment' AND NOT EXISTS (
        SELECT 1 FROM trustee.adjustments j WHERE j.entry_id = e.id AND j.status = 'approved' AND j.units = e.units AND j.wallet = e.wallet)
    UNION ALL
    SELECT format('adjustment %s', j.id) FROM trustee.adjustments j WHERE NOT EXISTS (
      SELECT 1 FROM trustee.audit x WHERE x.action = 'adjustment.proposed' AND (x.detail->>'adjustment')::bigint = j.id AND x.detail->>'units' = j.units::text)
      OR (j.status IN ('approved', 'rejected') AND NOT EXISTS (
      SELECT 1 FROM trustee.audit x WHERE x.action = 'adjustment.decided' AND (x.detail->>'adjustment')::bigint = j.id
        AND x.detail->>'decision' = CASE j.status WHEN 'approved' THEN 'approve' ELSE 'reject' END))
    UNION ALL
    SELECT format('trustee charge decision %s', d.id) FROM trustee.charge_decisions d WHERE NOT EXISTS (
      SELECT 1 FROM trustee.audit x WHERE x.action = 'charge.decided' AND (x.detail->>'decision_id')::bigint = d.id AND x.detail->>'decision' = d.decision)
    UNION ALL
    SELECT format('trustee pre-check %s', d.id) FROM trustee.calculation_checks d WHERE NOT EXISTS (
      SELECT 1 FROM trustee.audit x WHERE x.action = 'calculation.checked' AND (x.detail->>'check')::bigint = d.id AND x.detail->>'decision' = d.decision)
    UNION ALL
    SELECT format('trustee co-signature on signing request %s by %s', p.request_id, p.operator) FROM signer.approvals p
      WHERE p.capacity = 'trustee' AND NOT EXISTS (
        SELECT 1 FROM trustee.audit x WHERE x.action = 'cosign.signer' AND x.detail->>'request' = p.request_id::text AND x.actor = p.operator
          AND x.detail->>'decision' = p.decision)
  LOOP
    audit_id := NULL; problem := r.what || ' has no matching audit entry'; RETURN NEXT;
  END LOOP;
END $$;

-- ================================================================== T-9 recovery and succession cases (0020), read-only for the trustee
/**
 * The S-06 cases the trustee needs to see (the RecoveryGuard requests they lead to are Trustee Safe
 * transactions): kind, state, wallets, units, objection window, approvals by capacity and the
 * on-chain request; no subject identifiers beyond a short reference, no documents (hashes only).
 */
CREATE FUNCTION trustee.recovery_cases_json() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trustee AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'id', c.id, 'kind', c.kind, 'state', c.status,
      'subject', CASE WHEN c.subject_id IS NOT NULL THEN left(replace(c.subject_id::text, '-', ''), 8) END,
      'wallet', c.from_wallet, 'newWallet', c.to_wallet, 'token', c.token,
      'units', c.units_total::text, 'residualUnits', c.units_residual::text,
      'objectionUntil', recovery.utc(c.objection_until),
      'evidenceHash', CASE WHEN c.evidence_hash IS NOT NULL THEN '0x' || encode(c.evidence_hash, 'hex') END,
      'approvals', (SELECT coalesce(jsonb_agg(a.capacity || ':' || a.decision ORDER BY a.capacity), '[]'::jsonb) FROM recovery.approvals a WHERE a.case_id = c.id),
      'onchainRequest', (SELECT r.id::text || ' ' || r.status FROM chain.recoveries r
                         WHERE c.kind <> 'reversal' AND r.guard = c.recovery_guard AND r.from_addr = c.from_wallet
                         ORDER BY r.proposed_block DESC LIMIT 1),
      'updatedAt', recovery.utc(c.updated_at)) ORDER BY c.id DESC), '[]'::jsonb)
  FROM (SELECT * FROM recovery.cases WHERE kind <> 'reversal' ORDER BY id DESC LIMIT 200) c
$$;

-- ================================================================== portal reads (trustee.read)
/** The read model's position for a token: the block every chain number of a page is pinned to. */
CREATE FUNCTION admin.pinned_json(p_token text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
  SELECT jsonb_build_object('deployment', c.deployment, 'block', c.block_number, 'hash', c.block_hash, 'updatedAt', admin.utc(c.updated_at),
                            'halted', c.halted_at IS NOT NULL, 'haltReason', c.halt_reason)
  FROM chain.tokens t JOIN chain.cursors c ON c.deployment = t.deployment WHERE t.token = p_token
$$;

CREATE FUNCTION admin.trustee_tokens_json() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'token', t.token, 'deployment', t.deployment, 'supply', t.total_supply::text, 'cap', t.trustee_cap::text, 'paused', t.paused,
      'registerTotal', (SELECT coalesce(sum(e.units), 0)::text FROM trustee.register_entries e WHERE e.token = t.token),
      'differences', (SELECT count(*) FROM trustee.register_lines(t.token) l WHERE l.register_units <> l.chain_units),
      'pinned', admin.pinned_json(t.token)) ORDER BY t.deployment), '[]'::jsonb)
  FROM chain.tokens t
$$;

CREATE FUNCTION admin.trustee_dashboard(p_session bytea) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'trustee.read');
BEGIN
  RETURN jsonb_build_object(
    'at', admin.utc(clock_timestamp()),
    'tokens', admin.trustee_tokens_json(),
    'cosignSigner', (SELECT count(*) FROM signer.requests r WHERE r.status = 'pending_approval' AND r.trustee_approvals_needed > 0
                       AND r.expires_at > now() AND (SELECT trustee FROM signer.approval_counts(r.id)) < r.trustee_approvals_needed),
    'cosignOffering', (SELECT count(*) FROM offering.requests q WHERE admin.offering_needs_trustee(q)),
    'cosignCharges', (SELECT count(*) FROM ops.charges c WHERE c.status = 'proposed' AND trustee.charge_above_limit(c)
                        AND NOT EXISTS (SELECT 1 FROM trustee.charge_decisions x WHERE x.charge_id = c.id)),
    'prechecks', (SELECT count(*) FROM ops.distributions d WHERE d.status = 'attached'
                    AND NOT EXISTS (SELECT 1 FROM trustee.calculation_checks x WHERE x.distribution_id = d.id)),
    'distributionsInWindow', (SELECT count(*) FROM chain.distributions d WHERE d.status = 'published'
                                AND trustee.window_closes(d.registry, d.id) > clock_timestamp()
                                AND NOT EXISTS (SELECT 1 FROM trustee.distribution_reviews x WHERE x.registry = d.registry AND x.distribution_id = d.id)),
    'rejectedNotOnChain', (SELECT count(*) FROM trustee.distribution_reviews x JOIN chain.distributions d ON d.registry = x.registry AND d.id = x.distribution_id
                             WHERE x.decision = 'reject' AND d.status <> 'rejected'),
    'openAdjustments', (SELECT count(*) FROM trustee.adjustments WHERE status = 'open' AND expires_at > clock_timestamp()),
    'pendingRecoveries', (SELECT count(*) FROM chain.recoveries WHERE status = 'pending'),
    'gate', admin.gate_json(),
    'latestRun', (SELECT jsonb_build_object('id', r.id, 'status', r.status, 'blocking', r.blocking, 'warnings', r.warnings,
                                            'pinnedBlock', r.pinned_block, 'finishedAt', admin.utc(r.finished_at))
                  FROM recon.runs r WHERE r.status <> 'running' ORDER BY r.id DESC LIMIT 1));
END $$;

/** The register of one token next to the read model, supply and cap; every chain number pinned to one block. */
CREATE FUNCTION admin.trustee_register(p_session bytea, p_token text, p_limit integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'trustee.read');
  t chain.tokens;
  v_limit integer := least(greatest(coalesce(p_limit, 500), 1), 100000);
BEGIN
  SELECT * INTO t FROM chain.tokens WHERE token = lower(p_token);
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN jsonb_build_object(
    'token', t.token, 'deployment', t.deployment, 'supply', t.total_supply::text, 'cap', t.trustee_cap::text, 'paused', t.paused,
    'tokenUpdatedBlock', t.updated_block, 'pinned', admin.pinned_json(t.token), 'at', admin.utc(clock_timestamp()),
    'registerTotal', (SELECT coalesce(sum(e.units), 0)::text FROM trustee.register_entries e WHERE e.token = t.token),
    'chainHolders', (SELECT count(*) FROM chain.holdings h WHERE h.token = t.token AND h.balance > 0),
    'differences', (SELECT count(*) FROM trustee.register_lines(t.token) l WHERE l.register_units <> l.chain_units),
    'attestation', (SELECT jsonb_build_object('offering', a.offering_id, 'totalUnits', a.total_units, 'registerSha', encode(a.register_sha, 'hex'), 'at', admin.utc(a.at))
                    FROM offering.register_attestations a JOIN offering.offerings o ON o.id = a.offering_id WHERE o.token = t.token ORDER BY a.at DESC LIMIT 1),
    'lines', coalesce((SELECT jsonb_agg(jsonb_build_object('wallet', l.wallet, 'register', l.register_units::text, 'chain', l.chain_units::text,
                                                           'difference', (l.chain_units - l.register_units)::text)
                                        ORDER BY (l.register_units = l.chain_units), greatest(l.register_units, l.chain_units) DESC, l.wallet)
                       FROM (SELECT * FROM trustee.register_lines(t.token) x
                             ORDER BY (x.register_units = x.chain_units), greatest(x.register_units, x.chain_units) DESC, x.wallet LIMIT v_limit) l), '[]'::jsonb),
    'lineCount', (SELECT count(*) FROM trustee.register_lines(t.token)),
    'adjustments', coalesce((SELECT jsonb_agg(jsonb_build_object('id', a.id, 'wallet', a.wallet, 'units', a.units::text, 'status',
                                CASE WHEN a.status = 'open' AND a.expires_at <= clock_timestamp() THEN 'expired' ELSE a.status END,
                                'proposedBy', a.proposed_by, 'proposedAt', admin.utc(a.proposed_at), 'decidedBy', a.decided_by) ORDER BY a.id DESC)
                             FROM (SELECT * FROM trustee.adjustments WHERE token = t.token ORDER BY id DESC LIMIT 50) a), '[]'::jsonb));
END $$;

CREATE FUNCTION admin.register_adjustment(p_session bytea, p_id bigint) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'trustee.read');
  v_handle text := admin.handle_of(v_me);
  a trustee.adjustments;
  v text[] := '{}';
BEGIN
  SELECT * INTO a FROM trustee.adjustments WHERE id = p_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF NOT admin.has_permission(p_session, 'trustee.decide') THEN v := v || 'Only a trustee officer decides register adjustments; your role reviews.'::text; END IF;
  IF a.status <> 'open' THEN v := v || format('The adjustment is %s.', a.status); END IF;
  IF a.status = 'open' AND a.expires_at <= clock_timestamp() THEN v := v || 'The adjustment is older than 72 hours: propose it again.'::text; END IF;
  IF a.proposed_by = v_handle THEN v := v || 'You proposed it: a different trustee officer decides (four eyes).'::text; END IF;
  RETURN jsonb_build_object(
    'id', a.id, 'token', a.token, 'wallet', a.wallet, 'units', a.units::text, 'evidenceSha256', encode(a.evidence_sha, 'hex'), 'reason', a.reason,
    'proposedBy', a.proposed_by, 'proposedAt', admin.utc(a.proposed_at), 'expiresAt', admin.utc(a.expires_at), 'status', a.status,
    'decidedBy', a.decided_by, 'decisionReason', a.decision_reason, 'decidedAt', admin.utc(a.decided_at), 'entryId', a.entry_id,
    'registerBalance', trustee.register_balance(a.token, a.wallet)::text,
    'chainBalance', coalesce((SELECT h.balance::text FROM chain.holdings h WHERE h.token = a.token AND h.holder = a.wallet), '0'),
    'pinned', admin.pinned_json(a.token),
    'digest', encode(trustee.adjustment_digest(a.id), 'hex'),
    'blockers', to_jsonb(v),
    'approveBlockers', to_jsonb(CASE WHEN trustee.register_balance(a.token, a.wallet) + a.units < 0
                                     THEN ARRAY['The register balance of this wallet would go below zero.'] ELSE '{}'::text[] END));
END $$;

/** Work waiting for the trustee: signing requests and S-02 requests that need a trustee vote. */
CREATE FUNCTION admin.trustee_cosign_queue(p_session bytea) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'trustee.read');
  v_handle text := admin.handle_of(v_me);
BEGIN
  RETURN jsonb_build_object(
    'at', admin.utc(clock_timestamp()),
    'signer', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'id', r.id, 'kind', r.kind, 'amount', r.amount::text, 'requestedBy', r.requested_by, 'createdAt', admin.utc(r.created_at),
        'expiresAt', admin.utc(r.expires_at), 'expired', r.expires_at <= now(), 'approvalsNeeded', r.approvals_needed,
        'platformApprovals', (SELECT platform FROM signer.approval_counts(r.id)), 'trusteeApprovals', (SELECT trustee FROM signer.approval_counts(r.id)),
        'to', r.payload->>'to', 'mine', EXISTS (SELECT 1 FROM signer.approvals a WHERE a.request_id = r.id AND a.operator = v_handle)) ORDER BY r.created_at)
      FROM signer.requests r WHERE r.status = 'pending_approval' AND r.trustee_approvals_needed > 0), '[]'::jsonb),
    'offering', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'id', q.id, 'code', q.code, 'offering', q.offering_id, 'offeringState', q.offering_state, 'requestedBy', q.requested_by,
        'requestedAt', admin.utc(q.requested_at), 'expiresAt', admin.utc(q.expires_at),
        'note', (SELECT rr.note FROM offering.request_rules rr WHERE rr.code = q.code),
        'token', (SELECT o.token FROM offering.offerings o WHERE o.id = q.offering_id)) ORDER BY q.id)
      FROM offering.requests q WHERE admin.offering_needs_trustee(q)), '[]'::jsonb),
    'charges', coalesce((SELECT jsonb_agg(jsonb_build_object('id', c.id, 'token', c.token, 'period', c.period, 'kind', c.kind, 'payee', c.payee,
        'amount', c.amount_paisa::text, 'proposedBy', c.proposed_by, 'proposedAt', admin.utc(c.proposed_at)) ORDER BY c.id)
      FROM ops.charges c WHERE c.status = 'proposed' AND trustee.charge_above_limit(c)
        AND NOT EXISTS (SELECT 1 FROM trustee.charge_decisions x WHERE x.charge_id = c.id)), '[]'::jsonb),
    'calculations', coalesce((SELECT jsonb_agg(jsonb_build_object('id', d.id, 'token', d.token, 'period', d.period, 'net', d.sum_net::text,
        'holders', d.holders, 'calculatedBy', d.calculated_by, 'attachedAt', admin.utc(d.attached_at)) ORDER BY d.id)
      FROM ops.distributions d WHERE d.status = 'attached'
        AND NOT EXISTS (SELECT 1 FROM trustee.calculation_checks x WHERE x.distribution_id = d.id)), '[]'::jsonb),
    'recent', coalesce((SELECT jsonb_agg(jsonb_build_object('id', x.id, 'action', x.action, 'actor', x.actor, 'at', admin.utc(x.at),
                                                            'ref', coalesce(x.detail->>'request', x.detail->>'review', x.detail->>'charge', x.detail->>'distribution'), 'decision', x.detail->>'decision',
                                                            'result', x.detail->>'result') ORDER BY x.id DESC)
                        FROM (SELECT * FROM trustee.audit WHERE action IN ('cosign.signer', 'cosign.offering', 'charge.decided', 'calculation.checked') ORDER BY id DESC LIMIT 15) x), '[]'::jsonb));
END $$;

CREATE FUNCTION admin.trustee_signer_request(p_session bytea, p_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'trustee.read');
BEGIN
  RETURN admin.signer_request_json(v_me, p_id, true);
END $$;

/** Distributions (newest first) with their window and the trustee's decision. */
CREATE FUNCTION admin.trustee_distributions(p_session bytea) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'trustee.read');
BEGIN
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object(
      'registry', d.registry, 'id', d.id::text, 'token', d.token, 'status', d.status, 'recordBlock', d.record_block,
      'totalPaisa', d.total_paisa::text, 'publishedBlock', d.published_block,
      'windowCloses', admin.utc(trustee.window_closes(d.registry, d.id)),
      'windowOpen', d.status = 'published' AND coalesce(trustee.window_closes(d.registry, d.id) > clock_timestamp(), false),
      'review', (SELECT jsonb_build_object('decision', x.decision, 'by', x.decided_by, 'at', admin.utc(x.decided_at))
                 FROM trustee.distribution_reviews x WHERE x.registry = d.registry AND x.distribution_id = d.id)) ORDER BY d.published_block DESC, d.id DESC)
    FROM (SELECT * FROM chain.distributions ORDER BY published_block DESC, id DESC LIMIT 200) d), '[]'::jsonb);
END $$;

CREATE FUNCTION admin.trustee_distribution(p_session bytea, p_registry text, p_id numeric) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'trustee.read');
  d chain.distributions;
  x trustee.distribution_reviews;
  v_closes timestamptz;
  v text[] := '{}';
BEGIN
  SELECT * INTO d FROM chain.distributions WHERE registry = lower(p_registry) AND id = p_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO x FROM trustee.distribution_reviews WHERE registry = d.registry AND distribution_id = d.id;
  v_closes := trustee.window_closes(d.registry, d.id);
  IF NOT admin.has_permission(p_session, 'trustee.decide') THEN v := v || 'Only a trustee officer reviews distributions; your role reads.'::text; END IF;
  IF x.id IS NOT NULL THEN v := v || format('The trustee already decided: %s by %s.', x.decision, x.decided_by); END IF;
  IF d.status <> 'published' THEN v := v || format('The distribution is %s on chain: the review window is for published distributions.', d.status); END IF;
  IF v_closes IS NULL THEN v := v || 'The publish time is not in the read model yet.'::text;
  ELSIF v_closes <= clock_timestamp() THEN v := v || format('The 48-hour review window closed at %s UTC.', admin.utc(v_closes)); END IF;
  RETURN jsonb_build_object(
    'registry', d.registry, 'id', d.id::text, 'token', d.token, 'status', d.status, 'recordBlock', d.record_block, 'merkleRoot', d.merkle_root,
    'totalPaisa', d.total_paisa::text, 'statementHash', d.statement_hash, 'rejectReason', d.reject_reason, 'payoutBatchHash', d.payout_batch_hash,
    'publishedBlock', d.published_block, 'publishedAt', (SELECT admin.utc(b.block_time) FROM chain.blocks b WHERE b.number = d.published_block),
    'windowCloses', admin.utc(v_closes), 'pinned', admin.pinned_json(d.token),
    'ledgerBooked', EXISTS (SELECT 1 FROM ledger.journal j WHERE j.idempotency_key = format('rent:distribution:%s:%s', d.token, d.id)),
    'payoutBatches', coalesce((SELECT jsonb_agg(jsonb_build_object('id', b.id, 'reference', b.reference, 'status', b.status, 'kind', b.kind) ORDER BY b.id)
                               FROM bank.payout_batches b WHERE b.token = d.token AND b.distribution_id = d.id), '[]'::jsonb),
    'review', CASE WHEN x.id IS NOT NULL THEN jsonb_build_object('decision', x.decision, 'reason', x.reason, 'by', x.decided_by, 'at', admin.utc(x.decided_at),
                                                                 'recomputedRoot', x.recomputed_root, 'digest', encode(x.digest, 'hex')) END,
    'blocked', trustee.distribution_blocked(d.token, d.id),
    'digest', encode(trustee.distribution_digest(d.registry, d.id), 'hex'),
    'blockers', to_jsonb(v));
END $$;

/** Reconciliation for the trustee: runs per day (Pakistan time) and the latest runs; read-only. */
CREATE FUNCTION admin.trustee_recon(p_session bytea, p_days integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'trustee.read');
  v_days integer := least(greatest(coalesce(p_days, 14), 1), 92);
BEGIN
  RETURN jsonb_build_object(
    'gate', admin.gate_json(),
    'days', coalesce((SELECT jsonb_agg(x ORDER BY x->>'day' DESC) FROM (
        SELECT jsonb_build_object('day', to_char(r.started_at AT TIME ZONE 'Asia/Karachi', 'YYYY-MM-DD'), 'runs', count(*),
               'passed', count(*) FILTER (WHERE r.status = 'passed'), 'failed', count(*) FILTER (WHERE r.status = 'failed'),
               'error', count(*) FILTER (WHERE r.status = 'error'), 'blocking', coalesce(sum(r.blocking), 0), 'warnings', coalesce(sum(r.warnings), 0),
               'last', (array_agg(r.id ORDER BY r.id DESC))[1]) AS x
        FROM recon.runs r WHERE r.started_at >= clock_timestamp() - make_interval(days => v_days)
        GROUP BY to_char(r.started_at AT TIME ZONE 'Asia/Karachi', 'YYYY-MM-DD')) q), '[]'::jsonb),
    'runs', coalesce((SELECT jsonb_agg(jsonb_build_object('id', r.id, 'status', r.status, 'startedAt', admin.utc(r.started_at), 'finishedAt', admin.utc(r.finished_at),
                                                          'startedBy', r.started_by, 'pinnedBlock', r.pinned_block, 'blocking', r.blocking, 'warnings', r.warnings) ORDER BY r.id DESC)
                      FROM (SELECT * FROM recon.runs ORDER BY id DESC LIMIT 50) r), '[]'::jsonb));
END $$;

CREATE FUNCTION admin.trustee_recon_run(p_session bytea, p_id bigint) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'trustee.read');
  r recon.runs;
BEGIN
  SELECT * INTO r FROM recon.runs WHERE id = p_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN jsonb_build_object(
    'id', r.id, 'status', r.status, 'startedAt', admin.utc(r.started_at), 'finishedAt', admin.utc(r.finished_at), 'startedBy', r.started_by,
    'deployment', r.deployment, 'pinnedBlock', r.pinned_block, 'blocking', r.blocking, 'warnings', r.warnings, 'summary', r.summary, 'error', r.error,
    'digest', CASE WHEN r.status <> 'running' THEN recon.run_digest(r.id) END,
    'findings', coalesce((SELECT jsonb_agg(jsonb_build_object('id', f.id, 'check', f.check_name, 'severity', f.severity, 'subject', f.subject,
                                                              'expected', f.expected, 'actual', f.actual) ORDER BY (f.severity = 'warning'), f.id)
                          FROM (SELECT * FROM recon.findings WHERE run_id = r.id ORDER BY id LIMIT 1000) f), '[]'::jsonb),
    'findingCount', (SELECT count(*) FROM recon.findings WHERE run_id = r.id));
END $$;

/** Recovery and inheritance: on-chain RecoveryGuard requests now; S-06 case files through the hook. */
CREATE FUNCTION admin.trustee_recoveries(p_session bytea) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'trustee.read');
BEGIN
  RETURN jsonb_build_object(
    'onChain', coalesce((SELECT jsonb_agg(jsonb_build_object('guard', x.guard, 'id', x.id::text, 'kind', x.kind, 'from', x.from_addr, 'to', x.to_addr,
                                                             'amount', x.amount::text, 'evidenceHash', x.evidence_hash, 'status', x.status,
                                                             'eta', admin.utc(to_timestamp(x.eta)), 'executable', x.status = 'pending' AND to_timestamp(x.eta) <= clock_timestamp(),
                                                             'cancelledBy', x.cancelled_by, 'proposedBlock', x.proposed_block) ORDER BY x.proposed_block DESC, x.id DESC)
                         FROM (SELECT * FROM chain.recoveries ORDER BY proposed_block DESC, id DESC LIMIT 200) x), '[]'::jsonb),
    'cases', trustee.recovery_cases_json());
END $$;

-- ================================================================== portal decisions (trustee.decide), step-up on each
CREATE FUNCTION admin.review_distribution(p_session bytea, p_registry text, p_id numeric, p_decision text, p_reason text, p_digest bytea, p_root text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'trustee.decide');
  v_handle text := admin.handle_of(v_me);
  v_id bigint;
BEGIN
  PERFORM admin.require_step_up(p_session);
  PERFORM admin.check_decision(p_decision, p_reason);
  BEGIN
    PERFORM admin.bind_officer(v_handle);
    v_id := trustee.review_distribution(p_registry, p_id, v_handle, p_decision, btrim(p_reason), p_digest, p_root);
    PERFORM admin.unbind_officer(v_handle);
  EXCEPTION WHEN SQLSTATE '23514' OR SQLSTATE '23505' OR SQLSTATE '42501' OR SQLSTATE '22023' OR SQLSTATE 'P0002' THEN
    RETURN admin.refuse(v_me, 'trustee.distribution', coalesce(p_registry, '?') || ':' || coalesce(p_id::text, '?'), p_decision, SQLERRM);
  END;
  PERFORM admin.audit_append(v_me::text, 'approval.decided', jsonb_build_object('kind', 'trustee.distribution', 'ref', lower(p_registry) || ':' || p_id::text,
    'decision', p_decision, 'result', CASE p_decision WHEN 'approve' THEN 'approved' ELSE 'rejected' END, 'digest', encode(p_digest, 'hex')));
  RETURN jsonb_build_object('ok', true, 'id', v_id, 'status', CASE p_decision WHEN 'approve' THEN 'approved' ELSE 'rejected' END);
END $$;

CREATE FUNCTION admin.propose_register_adjustment(p_session bytea, p_token text, p_wallet text, p_units bigint, p_evidence text, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'trustee.decide');
  v_handle text := admin.handle_of(v_me);
  v_id bigint;
BEGIN
  PERFORM admin.require_step_up(p_session);
  IF p_evidence IS NULL OR p_evidence !~ '^[0-9a-f]{64}$' THEN
    RETURN admin.refuse(v_me, 'trustee.adjustment', 'new', 'propose', 'the SHA-256 of the evidence (64 lower-case hex) is required');
  END IF;
  BEGIN
    PERFORM admin.bind_officer(v_handle);
    v_id := trustee.propose_adjustment(lower(p_token), lower(p_wallet), p_units, decode(p_evidence, 'hex'), p_reason, v_handle);
    PERFORM admin.unbind_officer(v_handle);
  EXCEPTION WHEN SQLSTATE '23514' OR SQLSTATE '23505' OR SQLSTATE '42501' OR SQLSTATE '22023' OR SQLSTATE 'P0002' THEN
    RETURN admin.refuse(v_me, 'trustee.adjustment', 'new', 'propose', SQLERRM);
  END;
  PERFORM admin.audit_append(v_me::text, 'approval.requested', jsonb_build_object('kind', 'trustee.adjustment', 'ref', v_id));
  RETURN jsonb_build_object('ok', true, 'id', v_id, 'status', 'open');
END $$;

CREATE FUNCTION admin.decide_register_adjustment(p_session bytea, p_id bigint, p_decision text, p_reason text, p_digest bytea)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'trustee.decide');
  v_handle text := admin.handle_of(v_me);
  v_status text;
BEGIN
  PERFORM admin.require_step_up(p_session);
  PERFORM admin.check_decision(p_decision, p_reason);
  IF NOT EXISTS (SELECT 1 FROM trustee.adjustments WHERE id = p_id) THEN
    RETURN admin.refuse(v_me, 'trustee.adjustment', p_id::text, p_decision, 'unknown adjustment');
  END IF;
  IF trustee.adjustment_digest(p_id) IS DISTINCT FROM p_digest THEN
    RETURN admin.refuse(v_me, 'trustee.adjustment', p_id::text, p_decision, 'the adjustment differs from what you reviewed: reload and check again');
  END IF;
  BEGIN
    PERFORM admin.bind_officer(v_handle);
    v_status := trustee.decide_adjustment(p_id, v_handle, p_decision, btrim(p_reason));
    PERFORM admin.unbind_officer(v_handle);
  EXCEPTION WHEN SQLSTATE '23514' OR SQLSTATE '23505' OR SQLSTATE '42501' OR SQLSTATE '22023' OR SQLSTATE 'P0002' THEN
    RETURN admin.refuse(v_me, 'trustee.adjustment', p_id::text, p_decision, SQLERRM);
  END;
  PERFORM admin.audit_append(v_me::text, 'approval.decided', jsonb_build_object('kind', 'trustee.adjustment', 'ref', p_id, 'decision', p_decision,
    'result', v_status, 'digest', encode(p_digest, 'hex')));
  RETURN jsonb_build_object('ok', true, 'status', v_status);
END $$;

/** Records a register export (trustee.export) in the trustee and admin audits BEFORE the file is handed out. */
CREATE FUNCTION admin.record_register_export(p_session bytea, p_token text, p_block bigint, p_rows integer, p_sha256 text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'trustee.export');
  v_handle text := admin.handle_of(v_me);
  v_trustee bigint;
  v_audit bigint;
BEGIN
  IF p_sha256 IS NULL OR p_sha256 !~ '^[0-9a-f]{64}$' OR p_rows IS NULL OR p_rows < 0
     OR p_token IS NULL OR NOT EXISTS (SELECT 1 FROM chain.tokens WHERE token = lower(p_token)) THEN
    RAISE EXCEPTION 'invalid export description' USING ERRCODE = 'check_violation';
  END IF;
  v_trustee := trustee.audit_append(v_handle, 'register.exported', jsonb_build_object('token', lower(p_token), 'block', p_block, 'rows', p_rows, 'sha256', p_sha256));
  v_audit := admin.audit_append(v_me::text, 'trustee.exported', jsonb_build_object('kind', 'register', 'token', lower(p_token), 'block', p_block,
    'rows', p_rows, 'sha256', p_sha256, 'trusteeAudit', v_trustee));
  RETURN (SELECT jsonb_build_object('ok', true, 'trusteeAuditId', v_trustee, 'auditId', a.id, 'auditHash', encode(a.hash, 'hex'), 'at', admin.utc(a.at))
          FROM admin.audit a WHERE a.id = v_audit);
END $$;

-- ------------------------------------------------------------------ the trustee audit chain in the audit viewer
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
BEGIN
  PERFORM admin.require(p_session, NULL);
  v_ops := admin.has_permission(p_session, 'audit.read.ops');
  v_admin := admin.has_permission(p_session, 'audit.read.admin');
  v_comp := admin.has_permission(p_session, 'compliance.read');
  v_rec := admin.has_permission(p_session, 'recovery.read');
  v_trustee := admin.has_permission(p_session, 'trustee.read');
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
END $$;

CREATE OR REPLACE FUNCTION admin.record_export(p_session bytea, p_source text, p_filters jsonb, p_rows integer, p_format text, p_sha256 text)
RETURNS TABLE (audit_id bigint, audit_hash text, at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
#variable_conflict use_column
DECLARE
  v_me uuid := admin.require(p_session, 'audit.export');
  v_id bigint;
BEGIN
  IF p_source NOT IN ('admin', 'signer', 'recon', 'ledger', 'compliance', 'recovery', 'trustee') OR p_format NOT IN ('csv', 'json') OR p_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid export description' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM admin.require(p_session, CASE p_source WHEN 'admin' THEN 'audit.read.admin' WHEN 'compliance' THEN 'compliance.read'
                                                 WHEN 'recovery' THEN 'recovery.read' WHEN 'trustee' THEN 'trustee.read' ELSE 'audit.read.ops' END);
  v_id := admin.audit_append(v_me::text, 'audit.exported', jsonb_build_object('source', p_source, 'format', p_format, 'rows', p_rows,
                                                                             'filters', coalesce(p_filters, '{}'::jsonb), 'sha256', p_sha256));
  RETURN QUERY SELECT a.id, encode(a.hash, 'hex'), a.at FROM admin.audit a WHERE a.id = v_id;
END $$;

-- ================================================================== T-8 S-03 trustee duties on the operations path (0021)
-- OP-21 / E1: an expense or fee above the operations limit is approved by the operations checker AND
-- the trustee. The trustee decides first (or at any time before the checker); a trustee rejection is
-- final for the charge (the checker can then only reject it).
CREATE TABLE trustee.charge_decisions (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  charge_id  bigint NOT NULL UNIQUE REFERENCES ops.charges (id),
  decision   text NOT NULL CHECK (decision IN ('approve', 'reject')),
  reason     text NOT NULL CHECK (length(reason) BETWEEN 10 AND 500),
  digest     bytea NOT NULL CHECK (length(digest) = 32),
  decided_by text NOT NULL CHECK (length(decided_by) BETWEEN 2 AND 100),
  decided_at timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp())
);

-- D4: the trustee's pre-check of a distribution calculation: an independent recomputation of the
-- Merkle root from the record block and the statement, equal to the attached root.
CREATE TABLE trustee.calculation_checks (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  distribution_id bigint NOT NULL UNIQUE REFERENCES ops.distributions (id),
  decision        text NOT NULL CHECK (decision IN ('approve', 'reject')),
  reason          text NOT NULL CHECK (length(reason) BETWEEN 10 AND 500),
  recomputed_root text CHECK (length(recomputed_root) = 66 AND recomputed_root ~ '^0x[0-9a-f]+$'),
  statement_hash  text NOT NULL CHECK (length(statement_hash) = 66 AND statement_hash ~ '^0x[0-9a-f]+$'),
  digest          bytea NOT NULL CHECK (length(digest) = 32),
  decided_by      text NOT NULL CHECK (length(decided_by) BETWEEN 2 AND 100),
  decided_at      timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  CHECK ((decision = 'approve') = (recomputed_root IS NOT NULL))
);

CREATE FUNCTION trustee.charge_above_limit(c ops.charges) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trustee AS $$
  SELECT c.kind IN ('expense', 'fee') AND c.amount_paisa > (ops.setting('expense_ops_limit_paisa'))::text::bigint
$$;

/** Why the operations checker may not approve this charge for want of the trustee (NULL = no trustee needed or approved). */
CREATE FUNCTION trustee.charge_problem(p_charge bigint) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, trustee AS $$
DECLARE
  c ops.charges;
  x trustee.charge_decisions;
BEGIN
  SELECT * INTO c FROM ops.charges WHERE id = p_charge;
  IF NOT FOUND OR NOT trustee.charge_above_limit(c) THEN RETURN NULL; END IF;
  SELECT * INTO x FROM trustee.charge_decisions WHERE charge_id = p_charge;
  IF NOT FOUND THEN RETURN format('above the operations limit (%s paisa): the trustee approves it first (trustee portal, OP-21)', (ops.setting('expense_ops_limit_paisa'))::text); END IF;
  IF x.decision = 'reject' THEN RETURN format('the trustee rejected it (%s): it can only be rejected', x.decided_by); END IF;
  RETURN NULL;
END $$;

/** Why the operations checker may not approve this calculation for want of the trustee's pre-check (NULL = pre-checked). */
CREATE FUNCTION trustee.calculation_problem(p_distribution bigint) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, trustee AS $$
DECLARE
  d ops.distributions;
  x trustee.calculation_checks;
BEGIN
  SELECT * INTO d FROM ops.distributions WHERE id = p_distribution;
  IF NOT FOUND THEN RETURN 'unknown distribution calculation'; END IF;
  SELECT * INTO x FROM trustee.calculation_checks WHERE distribution_id = p_distribution;
  IF NOT FOUND THEN RETURN 'the trustee has not pre-checked it yet (D4: independent recomputation in the trustee portal)'; END IF;
  IF x.decision = 'reject' THEN RETURN format('the trustee''s pre-check rejected it (%s): return it and recalculate', x.decided_by); END IF;
  IF x.recomputed_root IS DISTINCT FROM d.merkle_root OR x.statement_hash IS DISTINCT FROM d.statement_hash THEN
    RETURN 'the statement changed since the trustee''s pre-check';
  END IF;
  RETURN NULL;
END $$;

CREATE FUNCTION trustee.decide_charge(p_charge bigint, p_actor text, p_decision text, p_reason text, p_digest bytea) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trustee AS $$
DECLARE
  c ops.charges;
  v_id bigint;
BEGIN
  PERFORM trustee.need_trustee(p_actor, 'approve a charge above the operations limit');
  PERFORM trustee.check_reason(p_reason);
  IF p_decision IS NULL OR p_decision NOT IN ('approve', 'reject') THEN PERFORM trustee.fail('22023', 'decision must be approve or reject'); END IF;
  SELECT * INTO c FROM ops.charges WHERE id = p_charge FOR UPDATE;
  IF NOT FOUND THEN PERFORM trustee.fail('P0002', 'unknown charge'); END IF;
  IF ops.charge_digest(c.id) IS DISTINCT FROM p_digest THEN PERFORM trustee.fail('23514', 'the charge differs from what you reviewed: reload and check again'); END IF;
  IF c.status <> 'proposed' THEN PERFORM trustee.fail('23514', format('the charge is already %s', c.status)); END IF;
  IF NOT trustee.charge_above_limit(c) THEN PERFORM trustee.fail('23514', 'this charge is within the operations limit: it needs no trustee approval'); END IF;
  IF EXISTS (SELECT 1 FROM trustee.charge_decisions WHERE charge_id = c.id) THEN PERFORM trustee.fail('23505', 'the trustee already decided this charge'); END IF;
  INSERT INTO trustee.charge_decisions (charge_id, decision, reason, digest, decided_by) VALUES (c.id, p_decision, btrim(p_reason), p_digest, p_actor)
  RETURNING id INTO v_id;
  PERFORM trustee.audit_append(p_actor, 'charge.decided', jsonb_build_object('decision_id', v_id, 'charge', c.id, 'decision', p_decision,
    'amount', c.amount_paisa::text, 'reason', btrim(p_reason), 'digest', encode(p_digest, 'hex')));
  RETURN CASE p_decision WHEN 'approve' THEN 'approved' ELSE 'rejected' END;
END $$;

CREATE FUNCTION trustee.precheck_distribution(p_distribution bigint, p_actor text, p_decision text, p_reason text, p_digest bytea, p_root text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trustee AS $$
DECLARE
  d ops.distributions;
  v_id bigint;
BEGIN
  PERFORM trustee.need_trustee(p_actor, 'pre-check a distribution');
  PERFORM trustee.check_reason(p_reason);
  IF p_decision IS NULL OR p_decision NOT IN ('approve', 'reject') THEN PERFORM trustee.fail('22023', 'decision must be approve or reject'); END IF;
  SELECT * INTO d FROM ops.distributions WHERE id = p_distribution FOR UPDATE;
  IF NOT FOUND THEN PERFORM trustee.fail('P0002', 'unknown distribution calculation'); END IF;
  IF ops.distribution_digest(d.id) IS DISTINCT FROM p_digest THEN PERFORM trustee.fail('23514', 'the calculation differs from what you reviewed: reload and check again'); END IF;
  IF d.status <> 'attached' THEN PERFORM trustee.fail('23514', format('the calculation is %s: the trustee pre-checks an attached statement before approval', d.status)); END IF;
  IF EXISTS (SELECT 1 FROM trustee.calculation_checks WHERE distribution_id = d.id) THEN PERFORM trustee.fail('23505', 'the trustee already pre-checked this calculation'); END IF;
  IF p_decision = 'approve' AND (p_root IS NULL OR lower(p_root) IS DISTINCT FROM d.merkle_root) THEN
    PERFORM trustee.fail('23514', 'your recomputed Merkle root differs from the attached root: reject the calculation instead');
  END IF;
  INSERT INTO trustee.calculation_checks (distribution_id, decision, reason, recomputed_root, statement_hash, digest, decided_by)
  VALUES (d.id, p_decision, btrim(p_reason), CASE WHEN p_decision = 'approve' THEN lower(p_root) END, d.statement_hash, p_digest, p_actor)
  RETURNING id INTO v_id;
  PERFORM trustee.audit_append(p_actor, 'calculation.checked', jsonb_build_object('check', v_id, 'distribution', d.id, 'decision', p_decision,
    'merkleRoot', d.merkle_root, 'statementHash', d.statement_hash, 'reason', btrim(p_reason), 'digest', encode(p_digest, 'hex')));
  RETURN CASE p_decision WHEN 'approve' THEN 'approved' ELSE 'rejected' END;
END $$;

/** T-8: the approved state of a charge above the limit, and of a calculation, needs the trustee (also against a direct UPDATE). */
CREATE FUNCTION trustee.guard_charge() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trustee AS $$
DECLARE
  v text;
BEGIN
  IF OLD.status = 'proposed' AND NEW.status = 'approved' THEN
    v := trustee.charge_problem(NEW.id);
    IF v IS NOT NULL THEN RAISE EXCEPTION '%', v USING ERRCODE = 'check_violation'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER charges_trustee BEFORE UPDATE ON ops.charges FOR EACH ROW EXECUTE FUNCTION trustee.guard_charge();

CREATE FUNCTION trustee.guard_calculation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trustee AS $$
DECLARE
  v text;
BEGIN
  IF OLD.status = 'attached' AND NEW.status = 'approved' THEN
    v := trustee.calculation_problem(NEW.id);
    IF v IS NOT NULL THEN RAISE EXCEPTION 'approval refused: %', v USING ERRCODE = 'check_violation'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER distributions_trustee_precheck BEFORE UPDATE ON ops.distributions FOR EACH ROW EXECUTE FUNCTION trustee.guard_calculation();

/** 0021 OT-2 with OP-21 routed to the trustee: above the limit the trustee's approval is needed instead of a refusal. */
CREATE OR REPLACE FUNCTION ops.decide_charge(p_id bigint, p_actor text, p_decision text, p_reason text)
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
  v_trustee text;
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
    v_trustee := trustee.charge_problem(r.id);
    IF v_trustee IS NOT NULL THEN RAISE EXCEPTION '%', v_trustee USING ERRCODE = 'check_violation'; END IF;
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

/** 0021 read of one charge for the operations checker, with the trustee's part (OP-21). */
CREATE OR REPLACE FUNCTION admin.operations_charge(p_session bytea, p_id bigint) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'operations.read');
  v_handle text := admin.handle_of(v_me);
  c ops.charges;
  v_base text[] := '{}';
  v_limit bigint := (ops.setting('expense_ops_limit_paisa'))::text::bigint;
  v_trustee text;
BEGIN
  SELECT * INTO c FROM ops.charges WHERE id = p_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF NOT admin.has_permission(p_session, 'operations.decide') THEN v_base := v_base || 'Only an operations checker decides charges.'::text; END IF;
  IF c.status <> 'proposed' THEN v_base := v_base || format('The charge is %s.', c.status); END IF;
  IF c.proposed_by = v_handle THEN v_base := v_base || 'You proposed it: a different officer decides (maker-checker).'::text; END IF;
  IF EXISTS (SELECT 1 FROM ops.distributions d WHERE d.token = c.token AND d.period = c.period AND d.status <> 'returned') THEN
    v_base := v_base || 'The period is locked by a distribution calculation.'::text;
  END IF;
  v_trustee := trustee.charge_problem(c.id);
  RETURN jsonb_build_object('id', c.id, 'token', c.token, 'period', c.period, 'kind', c.kind, 'feeType', c.fee_type, 'payee', c.payee,
    'description', c.description, 'amount', c.amount_paisa::text, 'evidence', encode(c.evidence_sha256, 'hex'), 'status', c.status,
    'proposedBy', c.proposed_by, 'proposedAt', admin.utc(c.proposed_at), 'decidedBy', c.decided_by, 'decisionReason', c.decision_reason,
    'decidedAt', admin.utc(c.decided_at), 'journal', c.journal_id, 'digest', encode(ops.charge_digest(c.id), 'hex'),
    'aboveLimit', c.kind IN ('expense', 'fee') AND c.amount_paisa > v_limit, 'limit', v_limit::text,
    'trustee', (SELECT jsonb_build_object('decision', x.decision, 'by', x.decided_by, 'at', admin.utc(x.decided_at), 'reason', x.reason)
                FROM trustee.charge_decisions x WHERE x.charge_id = c.id),
    'blockers', jsonb_build_object('approve', to_jsonb(v_base || CASE WHEN v_trustee IS NOT NULL THEN ARRAY[upper(left(v_trustee, 1)) || substr(v_trustee, 2) || '.'] ELSE '{}'::text[] END),
                                   'reject', to_jsonb(v_base)));
END $$;

/** 0021 read of one calculation for the operations checker, with the trustee's pre-check (D4). */
CREATE OR REPLACE FUNCTION admin.operations_distribution(p_session bytea, p_id bigint) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'operations.read');
  v_handle text := admin.handle_of(v_me);
  d ops.distributions;
  v_base text[] := '{}';
  v_approve text[] := '{}';
  v_trustee text;
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
  IF d.status = 'attached' THEN
    v_trustee := trustee.calculation_problem(d.id);
    IF v_trustee IS NOT NULL THEN v_approve := v_approve || (upper(left(v_trustee, 1)) || substr(v_trustee, 2) || '.'); END IF;
  END IF;
  RETURN jsonb_build_object('id', d.id, 'token', d.token, 'period', d.period, 'recordDate', d.record_date, 'recordBlock', d.record_block,
    'incomeType', d.income_type, 'collected', d.collected::text, 'expenses', d.expenses::text, 'fees', d.fees::text,
    'reserveContribution', d.reserve_contribution::text, 'reserveRelease', d.reserve_release::text,
    'gross', d.sum_gross::text, 'wht', d.sum_wht::text, 'net', d.sum_net::text, 'holders', d.holders, 'units', d.total_units::text,
    'flagged', d.flagged_lines, 'placeholder', d.placeholder_lines, 'status', d.status, 'root', d.merkle_root, 'statementHash', d.statement_hash,
    'taxScheduleHash', d.tax_schedule_hash, 'calculatedBy', d.calculated_by, 'calculatedAt', admin.utc(d.calculated_at), 'attachedBy', d.attached_by,
    'decidedBy', d.decided_by, 'decisionReason', d.decision_reason, 'decidedAt', admin.utc(d.decided_at), 'onchainId', d.onchain_id::text,
    'bookedAt', admin.utc(d.booked_at), 'digest', encode(ops.distribution_digest(d.id), 'hex'),
    'trustee', (SELECT jsonb_build_object('decision', x.decision, 'by', x.decided_by, 'at', admin.utc(x.decided_at), 'reason', x.reason,
                                          'recomputedRoot', x.recomputed_root) FROM trustee.calculation_checks x WHERE x.distribution_id = d.id),
    'blockers', jsonb_build_object('approve', to_jsonb(v_base || v_approve), 'reject', to_jsonb(v_base)),
    'lines', coalesce((SELECT jsonb_agg(jsonb_build_object('wallet', l.wallet,
                 'subject', CASE WHEN l.subject_id IS NULL THEN NULL ELSE left(replace(l.subject_id::text, '-', ''), 8) END,
                 'units', l.units::text, 'gross', l.gross::text, 'status', l.filer_status, 'asOf', l.filer_as_of, 'flag', l.flag_reason,
                 'ratePpm', l.rate_ppm, 'placeholder', l.placeholder_rate, 'wht', l.wht::text, 'net', l.net::text) ORDER BY l.wallet)
               FROM (SELECT * FROM ops.distribution_lines WHERE distribution_id = d.id ORDER BY wallet LIMIT 2000) l), '[]'::jsonb));
END $$;

-- ------------------------------------------------------------------ portal (trustee.read / trustee.decide)
CREATE FUNCTION admin.trustee_charge(p_session bytea, p_id bigint) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'trustee.read');
  c ops.charges;
  v text[] := '{}';
BEGIN
  SELECT * INTO c FROM ops.charges WHERE id = p_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF NOT admin.has_permission(p_session, 'trustee.decide') THEN v := v || 'Only a trustee officer decides for the trustee; your role reads.'::text; END IF;
  IF c.status <> 'proposed' THEN v := v || format('The charge is %s.', c.status); END IF;
  IF NOT trustee.charge_above_limit(c) THEN v := v || 'Within the operations limit: no trustee approval is needed.'::text; END IF;
  IF EXISTS (SELECT 1 FROM trustee.charge_decisions WHERE charge_id = c.id) THEN v := v || 'The trustee already decided this charge.'::text; END IF;
  RETURN jsonb_build_object('id', c.id, 'token', c.token, 'period', c.period, 'kind', c.kind, 'feeType', c.fee_type, 'payee', c.payee,
    'description', c.description, 'amount', c.amount_paisa::text, 'limit', (ops.setting('expense_ops_limit_paisa'))::text,
    'evidence', encode(c.evidence_sha256, 'hex'), 'status', c.status, 'proposedBy', c.proposed_by, 'proposedAt', admin.utc(c.proposed_at),
    'decidedBy', c.decided_by, 'decidedAt', admin.utc(c.decided_at),
    'trustee', (SELECT jsonb_build_object('decision', x.decision, 'by', x.decided_by, 'at', admin.utc(x.decided_at), 'reason', x.reason)
                FROM trustee.charge_decisions x WHERE x.charge_id = c.id),
    'digest', encode(ops.charge_digest(c.id), 'hex'), 'blockers', to_jsonb(v));
END $$;

CREATE FUNCTION admin.trustee_calculation(p_session bytea, p_id bigint) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'trustee.read');
  d ops.distributions;
  v text[] := '{}';
BEGIN
  SELECT * INTO d FROM ops.distributions WHERE id = p_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF NOT admin.has_permission(p_session, 'trustee.decide') THEN v := v || 'Only a trustee officer pre-checks for the trustee; your role reads.'::text; END IF;
  IF d.status <> 'attached' THEN v := v || format('The calculation is %s: the pre-check is for an attached statement before approval.', d.status); END IF;
  IF EXISTS (SELECT 1 FROM trustee.calculation_checks WHERE distribution_id = d.id) THEN v := v || 'The trustee already pre-checked this calculation.'::text; END IF;
  RETURN jsonb_build_object('id', d.id, 'token', d.token, 'period', d.period, 'recordDate', d.record_date, 'recordBlock', d.record_block,
    'incomeType', d.income_type, 'collected', d.collected::text, 'expenses', d.expenses::text, 'fees', d.fees::text,
    'gross', d.sum_gross::text, 'wht', d.sum_wht::text, 'net', d.sum_net::text, 'holders', d.holders, 'units', d.total_units::text,
    'status', d.status, 'root', d.merkle_root, 'statementHash', d.statement_hash, 'taxScheduleHash', d.tax_schedule_hash,
    'calculatedBy', d.calculated_by, 'attachedBy', d.attached_by, 'decidedBy', d.decided_by,
    'trustee', (SELECT jsonb_build_object('decision', x.decision, 'by', x.decided_by, 'at', admin.utc(x.decided_at), 'reason', x.reason,
                                          'recomputedRoot', x.recomputed_root) FROM trustee.calculation_checks x WHERE x.distribution_id = d.id),
    'lines', coalesce((SELECT jsonb_agg(jsonb_build_object('wallet', l.wallet, 'units', l.units::text, 'gross', l.gross::text, 'wht', l.wht::text,
                                                           'net', l.net::text) ORDER BY l.wallet)
                       FROM (SELECT * FROM ops.distribution_lines WHERE distribution_id = d.id ORDER BY wallet LIMIT 2000) l), '[]'::jsonb),
    'digest', encode(ops.distribution_digest(d.id), 'hex'), 'blockers', to_jsonb(v));
END $$;

CREATE FUNCTION admin.decide_trustee_charge(p_session bytea, p_id bigint, p_decision text, p_reason text, p_digest bytea) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'trustee.decide');
  v_handle text := admin.handle_of(v_me);
  v_status text;
BEGIN
  PERFORM admin.require_step_up(p_session);
  PERFORM admin.check_decision(p_decision, p_reason);
  BEGIN
    PERFORM admin.bind_officer(v_handle);
    v_status := trustee.decide_charge(p_id, v_handle, p_decision, btrim(p_reason), p_digest);
    PERFORM admin.unbind_officer(v_handle);
  EXCEPTION WHEN SQLSTATE '23514' OR SQLSTATE '23505' OR SQLSTATE '42501' OR SQLSTATE '22023' OR SQLSTATE 'P0002' THEN
    RETURN admin.refuse(v_me, 'trustee.charge', coalesce(p_id::text, '?'), p_decision, SQLERRM);
  END;
  PERFORM admin.audit_append(v_me::text, 'approval.decided', jsonb_build_object('kind', 'trustee.charge', 'ref', p_id, 'decision', p_decision,
    'result', v_status, 'digest', encode(p_digest, 'hex')));
  RETURN jsonb_build_object('ok', true, 'status', v_status);
END $$;

CREATE FUNCTION admin.precheck_distribution(p_session bytea, p_id bigint, p_decision text, p_reason text, p_digest bytea, p_root text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'trustee.decide');
  v_handle text := admin.handle_of(v_me);
  v_status text;
BEGIN
  PERFORM admin.require_step_up(p_session);
  PERFORM admin.check_decision(p_decision, p_reason);
  BEGIN
    PERFORM admin.bind_officer(v_handle);
    v_status := trustee.precheck_distribution(p_id, v_handle, p_decision, btrim(p_reason), p_digest, p_root);
    PERFORM admin.unbind_officer(v_handle);
  EXCEPTION WHEN SQLSTATE '23514' OR SQLSTATE '23505' OR SQLSTATE '42501' OR SQLSTATE '22023' OR SQLSTATE 'P0002' THEN
    RETURN admin.refuse(v_me, 'trustee.calculation', coalesce(p_id::text, '?'), p_decision, SQLERRM);
  END;
  PERFORM admin.audit_append(v_me::text, 'approval.decided', jsonb_build_object('kind', 'trustee.calculation', 'ref', p_id, 'decision', p_decision,
    'result', v_status, 'digest', encode(p_digest, 'hex')));
  RETURN jsonb_build_object('ok', true, 'status', v_status);
END $$;

CREATE TRIGGER charge_decisions_officer_binding BEFORE INSERT ON trustee.charge_decisions FOR EACH ROW EXECUTE FUNCTION trustee.bind_actor('decided_by');
CREATE TRIGGER calculation_checks_officer_binding BEFORE INSERT ON trustee.calculation_checks FOR EACH ROW EXECUTE FUNCTION trustee.bind_actor('decided_by');
CREATE TRIGGER charge_decisions_append_only BEFORE UPDATE OR DELETE ON trustee.charge_decisions FOR EACH ROW EXECUTE FUNCTION trustee.forbid_change();
CREATE TRIGGER calculation_checks_append_only BEFORE UPDATE OR DELETE ON trustee.calculation_checks FOR EACH ROW EXECUTE FUNCTION trustee.forbid_change();
CREATE TRIGGER charge_decisions_no_truncate BEFORE TRUNCATE ON trustee.charge_decisions FOR EACH STATEMENT EXECUTE FUNCTION trustee.forbid_change();
CREATE TRIGGER calculation_checks_no_truncate BEFORE TRUNCATE ON trustee.calculation_checks FOR EACH STATEMENT EXECUTE FUNCTION trustee.forbid_change();

-- ================================================================== privileges
REVOKE ALL ON ALL TABLES IN SCHEMA trustee FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA trustee FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA admin FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA admin FROM PUBLIC;
REVOKE ALL ON FUNCTION signer.approval_counts(uuid), signer.set_trustee_requirement(), signer.guard_trustee_requirement(), signer.set_approval_capacity() FROM PUBLIC;
-- REVOKE ... FROM PUBLIC leaves the earlier grants to pt_admin_portal in place, and CREATE OR REPLACE keeps the
-- grants of signer.decide (0004), offering.has_duty (0015) and the replaced 0016/0019 admin functions.

GRANT EXECUTE ON FUNCTION
  admin.trustee_dashboard(bytea),
  admin.trustee_register(bytea, text, integer),
  admin.register_adjustment(bytea, bigint),
  admin.trustee_cosign_queue(bytea),
  admin.trustee_signer_request(bytea, uuid),
  admin.trustee_offering_request(bytea, bigint),
  admin.trustee_distributions(bytea),
  admin.trustee_distribution(bytea, text, numeric),
  admin.trustee_recon(bytea, integer),
  admin.trustee_recon_run(bytea, bigint),
  admin.trustee_recoveries(bytea),
  admin.issue_trustee_ticket(bytea, uuid, text, text, bytea, bytea, bytea),
  admin.decide_offering_request(bytea, bigint, text, text, bytea),
  admin.review_distribution(bytea, text, numeric, text, text, bytea, text),
  admin.propose_register_adjustment(bytea, text, text, bigint, text, text),
  admin.decide_register_adjustment(bytea, bigint, text, text, bytea),
  admin.record_register_export(bytea, text, bigint, integer, text),
  admin.trustee_charge(bytea, bigint),
  admin.trustee_calculation(bytea, bigint),
  admin.decide_trustee_charge(bytea, bigint, text, text, bytea),
  admin.precheck_distribution(bytea, bigint, text, text, bytea, text)
TO pt_admin_portal;

GRANT USAGE ON SCHEMA trustee TO pt_admin_auditor;
GRANT EXECUTE ON FUNCTION trustee.verify_audit() TO pt_admin_auditor;

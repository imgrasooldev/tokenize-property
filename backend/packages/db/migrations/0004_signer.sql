-- Signing service (Step 5d): policies, maker-checker approvals, nonce reservations and an audit trail.
--
-- Safety properties enforced by the database itself:
--   S-1  Private keys are never stored here (only key references and addresses). Key material lives
--        in the signer's keystore (local: encrypted file; production: HSM/MPC).
--   S-2  Policies are versioned and append-only. A policy becomes active only when approved by an
--        operator who is not its proposer (maker-checker). Exactly one active version per kind.
--   S-3  A signing request that needs approval is approved only by the required number of distinct
--        operators, none of whom requested it; approvals expire with the request.
--   S-4  Nonces are reserved per address under a lock: never two live reservations for one nonce.
--        A reservation that was never broadcast is released and the lowest free nonce is reused,
--        so no gaps are left behind.
--   S-5  Every request, decision, approval, signature and policy change is written to an
--        append-only, hash-chained audit log; signer.verify_audit() detects any later change.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pt_signer') THEN CREATE ROLE pt_signer NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pt_signer_operator') THEN CREATE ROLE pt_signer_operator NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pt_signer_auditor') THEN CREATE ROLE pt_signer_auditor NOLOGIN; END IF;
END $$;

-- ------------------------------------------------------------------ audit (S-5)
CREATE TABLE signer.audit (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at         timestamptz NOT NULL,
  actor      text NOT NULL CHECK (length(actor) BETWEEN 1 AND 100),
  action     text NOT NULL CHECK (action ~ '^[a-z][a-z_.]{2,63}$'),
  request_id uuid,
  detail     jsonb NOT NULL CHECK (jsonb_typeof(detail) = 'object' AND octet_length(detail::text) <= 8192),
  prev_hash  bytea NOT NULL CHECK (length(prev_hash) = 32),
  hash       bytea NOT NULL UNIQUE CHECK (length(hash) = 32)
);

CREATE FUNCTION signer.forbid_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'signer % is append-only: % is not allowed', TG_TABLE_NAME, TG_OP USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON signer.audit FOR EACH ROW EXECUTE FUNCTION signer.forbid_change();
CREATE TRIGGER audit_no_truncate BEFORE TRUNCATE ON signer.audit FOR EACH STATEMENT EXECUTE FUNCTION signer.forbid_change();

CREATE FUNCTION signer.audit_digest(p_prev bytea, p_id bigint, p_at timestamptz, p_actor text, p_action text, p_request uuid, p_detail jsonb)
RETURNS bytea LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT sha256(p_prev || convert_to(jsonb_build_array(p_id, p_at, p_actor, p_action, p_request, p_detail)::text, 'UTF8'))
$$;

CREATE FUNCTION signer.audit_append(p_actor text, p_action text, p_request uuid, p_detail jsonb)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, signer AS $$
DECLARE
  v_prev bytea;
  v_id bigint;
  v_at timestamptz := date_trunc('microseconds', clock_timestamp());
BEGIN
  PERFORM pg_advisory_xact_lock(586586050);
  SELECT hash INTO v_prev FROM signer.audit ORDER BY id DESC LIMIT 1;
  v_prev := coalesce(v_prev, decode(repeat('00', 32), 'hex'));
  v_id := nextval(pg_get_serial_sequence('signer.audit', 'id'));
  INSERT INTO signer.audit (id, at, actor, action, request_id, detail, prev_hash, hash)
  OVERRIDING SYSTEM VALUE
  VALUES (v_id, v_at, p_actor, p_action, p_request, coalesce(p_detail, '{}'::jsonb), v_prev,
          signer.audit_digest(v_prev, v_id, v_at, p_actor, p_action, p_request, coalesce(p_detail, '{}'::jsonb)));
  RETURN v_id;
END $$;

CREATE FUNCTION signer.verify_audit() RETURNS TABLE (audit_id bigint, problem text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, signer AS $$
DECLARE
  a signer.audit;
  v_prev bytea := decode(repeat('00', 32), 'hex');
BEGIN
  FOR a IN SELECT * FROM signer.audit ORDER BY id LOOP
    IF a.prev_hash <> v_prev THEN audit_id := a.id; problem := 'prev_hash does not match'; RETURN NEXT; END IF;
    IF a.hash <> signer.audit_digest(a.prev_hash, a.id, a.at, a.actor, a.action, a.request_id, a.detail) THEN
      audit_id := a.id; problem := 'content does not match its hash'; RETURN NEXT;
    END IF;
    v_prev := a.hash;
  END LOOP;
END $$;

-- ------------------------------------------------------------------ keys (S-1)
CREATE TABLE signer.keys (
  key_ref    text PRIMARY KEY CHECK (key_ref ~ '^[a-z][a-z0-9_]{2,40}$'),
  address    text NOT NULL UNIQUE CHECK (address ~ '^0x[0-9a-f]{40}$'),
  purpose    text NOT NULL CHECK (length(purpose) BETWEEN 3 AND 200),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER keys_append_only BEFORE UPDATE OR DELETE ON signer.keys FOR EACH ROW EXECUTE FUNCTION signer.forbid_change();

-- ------------------------------------------------------------------ policies (S-2)
CREATE TABLE signer.policies (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind        text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'),
  version     integer NOT NULL CHECK (version > 0),
  rule        jsonb NOT NULL CHECK (jsonb_typeof(rule) = 'object' AND octet_length(rule::text) <= 8192),
  proposed_by text NOT NULL,
  proposed_at timestamptz NOT NULL DEFAULT now(),
  approved_by text,
  approved_at timestamptz,
  retired_at  timestamptz,
  UNIQUE (kind, version),
  CHECK (approved_by IS NULL OR approved_by <> proposed_by)
);
CREATE UNIQUE INDEX policies_one_active ON signer.policies (kind) WHERE approved_at IS NOT NULL AND retired_at IS NULL;

CREATE FUNCTION signer.guard_policy() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'policies are never deleted' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF NEW.kind <> OLD.kind OR NEW.version <> OLD.version OR NEW.rule <> OLD.rule OR NEW.proposed_by <> OLD.proposed_by
     OR NEW.proposed_at <> OLD.proposed_at
     OR (OLD.approved_by IS NOT NULL AND NEW.approved_by IS DISTINCT FROM OLD.approved_by)
     OR (OLD.retired_at IS NOT NULL AND NEW.retired_at IS DISTINCT FROM OLD.retired_at) THEN
    RAISE EXCEPTION 'policy % can only be approved once and retired once', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER policies_guard BEFORE UPDATE OR DELETE ON signer.policies FOR EACH ROW EXECUTE FUNCTION signer.guard_policy();

CREATE FUNCTION signer.propose_policy(p_kind text, p_rule jsonb, p_operator text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, signer AS $$
DECLARE
  v_id bigint;
BEGIN
  INSERT INTO signer.policies (kind, version, rule, proposed_by)
  VALUES (p_kind, coalesce((SELECT max(version) FROM signer.policies WHERE kind = p_kind), 0) + 1, p_rule, p_operator)
  RETURNING id INTO v_id;
  PERFORM signer.audit_append(p_operator, 'policy.proposed', NULL, jsonb_build_object('policy', v_id, 'kind', p_kind, 'rule', p_rule));
  RETURN v_id;
END $$;

/** A different operator activates a proposed policy; the previous active version is retired. */
CREATE FUNCTION signer.approve_policy(p_id bigint, p_operator text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, signer AS $$
DECLARE
  p signer.policies;
BEGIN
  SELECT * INTO p FROM signer.policies WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR p.approved_by IS NOT NULL OR p.retired_at IS NOT NULL THEN RETURN false; END IF;
  IF p.proposed_by = p_operator THEN
    RAISE EXCEPTION 'maker-checker: the proposer cannot approve their own policy' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE signer.policies SET retired_at = now() WHERE kind = p.kind AND approved_at IS NOT NULL AND retired_at IS NULL;
  UPDATE signer.policies SET approved_by = p_operator, approved_at = now() WHERE id = p_id;
  PERFORM signer.audit_append(p_operator, 'policy.approved', NULL, jsonb_build_object('policy', p_id, 'kind', p.kind, 'version', p.version));
  RETURN true;
END $$;

-- ------------------------------------------------------------------ requests and approvals (S-3)
CREATE TABLE signer.requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  command_ref   text NOT NULL UNIQUE CHECK (length(command_ref) BETWEEN 8 AND 200),
  kind          text NOT NULL,
  key_ref       text NOT NULL REFERENCES signer.keys (key_ref),
  payload       jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 8192),
  payload_hash  bytea NOT NULL CHECK (length(payload_hash) = 32),
  policy_id     bigint REFERENCES signer.policies (id),
  amount        numeric(78, 0) CHECK (amount >= 0),
  requested_by  text NOT NULL,
  status        text NOT NULL CHECK (status IN ('denied', 'pending_approval', 'approved', 'signed', 'broadcast', 'released', 'rejected', 'expired')),
  approvals_needed integer NOT NULL DEFAULT 0 CHECK (approvals_needed BETWEEN 0 AND 5),
  reason        text CHECK (length(reason) <= 500),
  tx_hash       text CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
  nonce         bigint CHECK (nonce >= 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX requests_daily ON signer.requests (key_ref, kind, created_at) WHERE status IN ('signed', 'broadcast');

CREATE TABLE signer.approvals (
  request_id uuid NOT NULL REFERENCES signer.requests (id),
  operator   text NOT NULL CHECK (length(operator) BETWEEN 2 AND 100),
  decision   text NOT NULL CHECK (decision IN ('approve', 'reject')),
  reason     text CHECK (length(reason) <= 500),
  at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (request_id, operator)
);
CREATE TRIGGER approvals_append_only BEFORE UPDATE OR DELETE ON signer.approvals FOR EACH ROW EXECUTE FUNCTION signer.forbid_change();

CREATE FUNCTION signer.guard_request() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  edge text := OLD.status || '>' || NEW.status;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'signing requests are never deleted' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF NEW.command_ref <> OLD.command_ref OR NEW.kind <> OLD.kind OR NEW.key_ref <> OLD.key_ref OR NEW.payload <> OLD.payload
     OR NEW.payload_hash <> OLD.payload_hash OR NEW.requested_by <> OLD.requested_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'signing request % is immutable except for its state', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> NEW.status AND edge NOT IN (
       'pending_approval>approved', 'pending_approval>rejected', 'pending_approval>expired',
       'approved>signed', 'approved>expired',
       'signed>broadcast', 'signed>released', 'released>signed', 'broadcast>released') THEN
    RAISE EXCEPTION 'signing request %: transition % is not allowed', OLD.id, edge USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER requests_guard BEFORE UPDATE OR DELETE ON signer.requests FOR EACH ROW EXECUTE FUNCTION signer.guard_request();

/** S-3: records one operator's decision; the request is approved when enough distinct operators agree. */
CREATE FUNCTION signer.decide(p_request uuid, p_operator text, p_decision text, p_reason text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, signer AS $$
DECLARE
  r signer.requests;
  n integer;
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
  INSERT INTO signer.approvals (request_id, operator, decision, reason) VALUES (r.id, p_operator, p_decision, p_reason);
  PERFORM signer.audit_append(p_operator, 'request.' || p_decision, r.id, jsonb_build_object('reason', p_reason));
  IF p_decision = 'reject' THEN
    UPDATE signer.requests SET status = 'rejected', reason = left('rejected by ' || p_operator || ': ' || coalesce(p_reason, ''), 500) WHERE id = r.id;
    RETURN 'rejected';
  END IF;
  SELECT count(*) INTO n FROM signer.approvals WHERE request_id = r.id AND decision = 'approve';
  IF n >= r.approvals_needed THEN
    UPDATE signer.requests SET status = 'approved' WHERE id = r.id;
    PERFORM signer.audit_append('signer', 'request.approved', r.id, jsonb_build_object('approvals', n));
    RETURN 'approved';
  END IF;
  RETURN 'pending_approval';
END $$;

-- ------------------------------------------------------------------ nonces (S-4)
CREATE TABLE signer.nonces (
  address    text NOT NULL CHECK (address ~ '^0x[0-9a-f]{40}$'),
  nonce      bigint NOT NULL CHECK (nonce >= 0),
  status     text NOT NULL CHECK (status IN ('reserved', 'broadcast', 'released')),
  request_id uuid REFERENCES signer.requests (id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (address, nonce)
);

/**
 * Reserves the next nonce for an address, never handing out a nonce that is reserved or broadcast.
 * p_chain_next is the account's pending nonce from the node. The lowest released nonce at or above
 * it is reused first, so an abandoned signature never leaves a gap.
 */
CREATE FUNCTION signer.reserve_nonce(p_address text, p_chain_next bigint, p_request uuid)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, signer AS $$
DECLARE
  v bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(586586060, hashtext(p_address));
  -- Anything below the node's next nonce is settled on chain (mined or in the pool); forget it.
  DELETE FROM signer.nonces WHERE address = p_address AND nonce < p_chain_next;
  -- Stale entries at or above it are known to the node neither as mined nor as pending: whatever
  -- was signed with them was never delivered (or was dropped), so the nonce is free again. The
  -- delay keeps a reservation that is still being signed and broadcast out of reach.
  UPDATE signer.nonces SET status = 'released', updated_at = now()
  WHERE address = p_address AND nonce >= p_chain_next AND status IN ('reserved', 'broadcast')
    AND updated_at < now() - interval '2 minutes';
  SELECT nonce INTO v FROM signer.nonces WHERE address = p_address AND status = 'released' ORDER BY nonce LIMIT 1;
  IF v IS NOT NULL THEN
    UPDATE signer.nonces SET status = 'reserved', request_id = p_request, updated_at = now() WHERE address = p_address AND nonce = v;
    RETURN v;
  END IF;
  SELECT greatest(p_chain_next, coalesce(max(nonce) + 1, 0)) INTO v FROM signer.nonces WHERE address = p_address;
  INSERT INTO signer.nonces (address, nonce, status, request_id) VALUES (p_address, v, 'reserved', p_request);
  RETURN v;
END $$;

CREATE FUNCTION signer.settle_nonce(p_address text, p_nonce bigint, p_status text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, signer AS $$
DECLARE
  n integer;
BEGIN
  IF p_status NOT IN ('broadcast', 'released') THEN RAISE EXCEPTION 'invalid nonce status' USING ERRCODE = 'check_violation'; END IF;
  UPDATE signer.nonces SET status = p_status, updated_at = now()
  WHERE address = p_address AND nonce = p_nonce AND status = 'reserved';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n = 1;
END $$;

-- ------------------------------------------------------------------ outbox: waiting is not an attempt
/**
 * A command waiting for maker-checker approval goes back to pending without using up an attempt,
 * to be retried after p_seconds. Nothing was sent.
 */
CREATE FUNCTION outbox.defer(p_id bigint, p_worker text, p_reason text, p_seconds integer)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, outbox AS $$
DECLARE
  n integer;
BEGIN
  PERFORM set_config('outbox.actor', p_worker, true);
  UPDATE outbox.commands
  SET status = 'pending', lease_owner = NULL, lease_until = NULL, attempts = greatest(attempts - 1, 0),
      last_error = left(p_reason, 500), available_at = now() + make_interval(secs => least(greatest(p_seconds, 1), 3600))
  WHERE id = p_id AND status = 'claimed' AND lease_owner = p_worker;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n = 1;
END $$;

-- ------------------------------------------------------------------ privileges
REVOKE ALL ON ALL TABLES IN SCHEMA signer FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA signer FROM PUBLIC;
REVOKE ALL ON FUNCTION outbox.defer(bigint, text, text, integer) FROM PUBLIC;

GRANT USAGE ON SCHEMA signer TO pt_signer, pt_signer_operator, pt_signer_auditor;
GRANT SELECT, INSERT ON signer.keys TO pt_signer;
GRANT SELECT, INSERT, UPDATE ON signer.requests TO pt_signer;
GRANT SELECT ON signer.policies, signer.approvals, signer.nonces TO pt_signer;
GRANT EXECUTE ON FUNCTION signer.audit_append(text, text, uuid, jsonb), signer.reserve_nonce(text, bigint, uuid),
  signer.settle_nonce(text, bigint, text) TO pt_signer;
GRANT EXECUTE ON FUNCTION signer.propose_policy(text, jsonb, text), signer.approve_policy(bigint, text),
  signer.decide(uuid, text, text, text) TO pt_signer_operator;
GRANT SELECT ON signer.requests, signer.policies, signer.approvals TO pt_signer_operator;
GRANT SELECT ON ALL TABLES IN SCHEMA signer TO pt_signer_auditor;
GRANT EXECUTE ON FUNCTION signer.verify_audit() TO pt_signer_auditor;
GRANT EXECUTE ON FUNCTION outbox.defer(bigint, text, text, integer) TO pt_outbox_worker;

-- PT Control: partial freezes (roadmap 2026-11-03; ADR 0011 amendment "Partial freeze"; spec S-06
-- RC-22 and C1). Applies on top of 0053; nothing in 0019 changes except compliance.verify_audit().
--
--   PF-1  A compliance officer proposes to freeze an AMOUNT of one token in an investor wallet
--         (FreezeGuard.freezePartial), or to release one partial hold (unfreezePartial). Same
--         two-officer path as the full freeze (0019 C-3): a reason code of the right kind, a reason,
--         24 hours to decide, maker <> checker (CHECK and function), request digest and step-up in
--         the portal, officer handles bound to sessions, every row audited in compliance.audit.
--   PF-2  The amount must fit the wallet's free units in the read model (balance minus frozen units
--         minus approved partial freezes not yet on chain), when proposed and again when approved.
--         The token is the one the active compliance.freeze_partial policy targets.
--   PF-3  A partial hold never changes the KYC status: the investor stays verified, keeps the rest
--         of the balance and receives rent. A release lifts exactly one partial hold and its whole
--         amount, and only once its freeze is on chain (a release before would revert).
--   PF-4  Approval enqueues compliance.freeze_partial / compliance.unfreeze_partial in the same
--         transaction (outbox O-1). The signing service signs only when
--         compliance.partial_command_allowed(kind, payload) finds the approved request that enqueued
--         exactly this payload and no PartialFreezeSet with its caseId is on chain yet (no replay).
--   PF-5  Reconciliation (recon.compliance_partial(token)): every partial PartialFreezeSet on chain
--         matches an approved request (caseId, wallet, amount, direction) and each caseId is used
--         once (compliance.partial_unmatched, blocking); an approved request that is not on chain
--         an hour after the decision is a warning (compliance.partial_pending).

-- ================================================================== reason codes (append-only)
INSERT INTO compliance.reason_codes (code, applies_to, label) VALUES
  ('reversal_review', 'freeze', 'Units of a subscription that may have to be reversed (S-06 RC-22)'),
  ('reversal_settled', 'unfreeze', 'Reversal question settled or the units dealt with');

-- ================================================================== requests and holds (PF-1, PF-3)
CREATE TABLE compliance.partial_freeze_requests (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind              text NOT NULL CHECK (kind IN ('freeze', 'unfreeze')),
  subject_id        uuid NOT NULL REFERENCES kyc.subjects (id),
  wallet            text NOT NULL CHECK (length(wallet) = 42 AND wallet ~ '^0x[0-9a-f]+$'),
  token             text NOT NULL CHECK (length(token) = 42 AND token ~ '^0x[0-9a-f]+$'),
  amount            numeric(78,0) NOT NULL CHECK (amount > 0),
  reason_code       text NOT NULL,
  reason            text NOT NULL CHECK (compliance.free_text_ok(reason, 10, 500)),
  kyc_case_id       bigint REFERENCES compliance.kyc_cases (id),
  str_case_id       bigint REFERENCES compliance.str_cases (id),
  -- For a release: the partial freeze whose hold it lifts.
  lifts_request_id  bigint REFERENCES compliance.partial_freeze_requests (id),
  -- bytes32 caseId sent to FreezeGuard: SHA-256 of its own domain and the id (never equal to a full freeze's).
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
  CHECK (decided_by IS NULL OR decided_by <> requested_by),
  CHECK ((status = 'open') = (decided_at IS NULL)),
  CHECK ((status IN ('approved', 'rejected')) = (decided_by IS NOT NULL AND decision_reason IS NOT NULL)),
  CHECK ((status = 'approved') = (command_key IS NOT NULL))
);
CREATE UNIQUE INDEX partial_freeze_requests_one_open ON compliance.partial_freeze_requests (wallet) WHERE status = 'open';

CREATE FUNCTION compliance.guard_partial_freeze_request() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'partial freeze requests are never deleted' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF OLD.status <> 'open'
     OR (NEW.id, NEW.kind, NEW.subject_id, NEW.wallet, NEW.token, NEW.amount, NEW.reason_code, NEW.reason, NEW.kyc_case_id, NEW.str_case_id,
         NEW.lifts_request_id, NEW.case_ref, NEW.requested_by, NEW.requested_at, NEW.expires_at)
        IS DISTINCT FROM (OLD.id, OLD.kind, OLD.subject_id, OLD.wallet, OLD.token, OLD.amount, OLD.reason_code, OLD.reason, OLD.kyc_case_id,
         OLD.str_case_id, OLD.lifts_request_id, OLD.case_ref, OLD.requested_by, OLD.requested_at, OLD.expires_at) THEN
    RAISE EXCEPTION 'partial freeze request % can only be decided once', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER partial_freeze_requests_guard BEFORE UPDATE OR DELETE ON compliance.partial_freeze_requests
  FOR EACH ROW EXECUTE FUNCTION compliance.guard_partial_freeze_request();

CREATE TABLE compliance.partial_holds (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subject_id        uuid NOT NULL REFERENCES kyc.subjects (id),
  wallet            text NOT NULL,
  token             text NOT NULL,
  amount            numeric(78,0) NOT NULL CHECK (amount > 0),
  freeze_request_id bigint NOT NULL UNIQUE REFERENCES compliance.partial_freeze_requests (id),
  placed_at         timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  lifted_at         timestamptz,
  lifted_by_request bigint UNIQUE REFERENCES compliance.partial_freeze_requests (id),
  CHECK ((lifted_at IS NULL) = (lifted_by_request IS NULL))
);
CREATE INDEX partial_holds_active_idx ON compliance.partial_holds (wallet, token) WHERE lifted_at IS NULL;

CREATE FUNCTION compliance.guard_partial_hold() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'partial holds are never deleted' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF OLD.lifted_at IS NOT NULL OR NEW.lifted_at IS NULL
     OR (NEW.id, NEW.subject_id, NEW.wallet, NEW.token, NEW.amount, NEW.freeze_request_id, NEW.placed_at)
        IS DISTINCT FROM (OLD.id, OLD.subject_id, OLD.wallet, OLD.token, OLD.amount, OLD.freeze_request_id, OLD.placed_at) THEN
    RAISE EXCEPTION 'partial hold % can only be lifted, once', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER partial_holds_guard BEFORE UPDATE OR DELETE ON compliance.partial_holds FOR EACH ROW EXECUTE FUNCTION compliance.guard_partial_hold();
CREATE TRIGGER partial_freeze_requests_no_truncate BEFORE TRUNCATE ON compliance.partial_freeze_requests
  FOR EACH STATEMENT EXECUTE FUNCTION compliance.forbid_change();
CREATE TRIGGER partial_holds_no_truncate BEFORE TRUNCATE ON compliance.partial_holds FOR EACH STATEMENT EXECUTE FUNCTION compliance.forbid_change();
CREATE TRIGGER partial_freeze_requests_officer_binding BEFORE INSERT OR UPDATE ON compliance.partial_freeze_requests
  FOR EACH ROW EXECUTE FUNCTION compliance.bind_actor('requested_by', 'decided_by');

-- ================================================================== helpers (PF-2)
/** The token the active signing policy of a kind targets (NULL without an active policy). */
CREATE FUNCTION compliance.policy_token(p_kind text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, compliance AS $$
  SELECT lower(p.rule->>'token') FROM signer.policies p
  WHERE p.kind = p_kind AND p.approved_at IS NOT NULL AND p.retired_at IS NULL
$$;

/** Is a partial freeze or release with this caseId in the read model (FreezeGuard PartialFreezeSet)? */
CREATE FUNCTION compliance.partial_on_chain(p_case_ref bytea) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, compliance AS $$
  SELECT EXISTS (SELECT 1 FROM chain.freeze_actions a WHERE a.scope = 'partial' AND a.case_id = '0x' || encode(p_case_ref, 'hex'))
$$;

/** Free units of a wallet in the read model: balance - frozen units - approved partial freezes not yet on chain. */
CREATE FUNCTION compliance.partial_free_units(p_token text, p_wallet text) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, compliance AS $$
  SELECT coalesce((SELECT h.balance FROM chain.holdings h WHERE h.token = lower(p_token) AND h.holder = lower(p_wallet)), 0)
       - coalesce((SELECT f.frozen_amount FROM chain.freezes f WHERE f.token = lower(p_token) AND f.holder = lower(p_wallet)), 0)
       - coalesce((SELECT sum(q.amount) FROM compliance.partial_freeze_requests q
                   WHERE q.kind = 'freeze' AND q.status = 'approved' AND q.token = lower(p_token) AND q.wallet = lower(p_wallet)
                     AND NOT compliance.partial_on_chain(q.case_ref)), 0)
$$;

/** Internal: marks open partial requests older than 24 hours as expired (audited). */
CREATE FUNCTION compliance.expire_partial_freeze_requests(p_actor text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, compliance AS $$
DECLARE
  r compliance.partial_freeze_requests;
  n integer := 0;
BEGIN
  FOR r IN SELECT * FROM compliance.partial_freeze_requests WHERE status = 'open' AND expires_at < clock_timestamp() ORDER BY id FOR UPDATE LOOP
    UPDATE compliance.partial_freeze_requests SET status = 'expired', decided_at = clock_timestamp() WHERE id = r.id;
    PERFORM compliance.audit_append(p_actor, 'partial_freeze.expired', jsonb_build_object('request', r.id, 'kind', r.kind, 'wallet', r.wallet));
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;

-- ================================================================== maker and checker (PF-1 .. PF-4)
/** PF-1 maker: proposes a partial freeze (p_amount units) or the release of the partial hold placed by p_lifts. */
CREATE FUNCTION compliance.request_partial_freeze(p_kind text, p_wallet text, p_amount numeric, p_lifts bigint, p_reason_code text, p_reason text,
                                                  p_actor text, p_kyc_case bigint, p_str_case bigint)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, compliance AS $$
DECLARE
  v_wallet text := lower(btrim(p_wallet));
  v_subject uuid;
  v_token text;
  v_amount numeric;
  v_free numeric;
  h compliance.partial_holds;
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
  PERFORM compliance.expire_partial_freeze_requests(p_actor);
  SELECT subject_id INTO v_subject FROM kyc.wallets WHERE wallet = v_wallet;
  IF NOT FOUND THEN RAISE EXCEPTION 'no investor wallet is bound to this address' USING ERRCODE = 'no_data_found'; END IF;
  IF p_kyc_case IS NOT NULL AND NOT EXISTS (SELECT 1 FROM compliance.kyc_cases WHERE id = p_kyc_case AND subject_id = v_subject) THEN
    RAISE EXCEPTION 'KYC case % is not a case of this investor', p_kyc_case USING ERRCODE = 'check_violation';
  END IF;
  IF p_str_case IS NOT NULL AND NOT EXISTS (SELECT 1 FROM compliance.str_cases WHERE id = p_str_case) THEN
    RAISE EXCEPTION 'unknown STR case %', p_str_case USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM compliance.partial_freeze_requests WHERE wallet = v_wallet AND status = 'open') THEN
    RAISE EXCEPTION 'an open partial freeze or release request exists for this wallet: decide it first' USING ERRCODE = 'unique_violation';
  END IF;
  IF p_kind = 'freeze' THEN
    IF p_lifts IS NOT NULL THEN RAISE EXCEPTION 'a partial freeze lifts nothing' USING ERRCODE = 'check_violation'; END IF;
    IF p_amount IS NULL OR p_amount <= 0 OR p_amount <> trunc(p_amount) THEN
      RAISE EXCEPTION 'the amount must be a whole number of token units above 0' USING ERRCODE = 'check_violation';
    END IF;
    v_token := compliance.policy_token('compliance.freeze_partial');
    IF v_token IS NULL OR compliance.freeze_guard('compliance.freeze_partial') IS NULL THEN
      RAISE EXCEPTION 'no active compliance.freeze_partial signing policy: a partial freeze could not be executed' USING ERRCODE = 'check_violation';
    END IF;
    v_free := compliance.partial_free_units(v_token, v_wallet);
    IF p_amount > v_free THEN
      RAISE EXCEPTION 'only % units of this wallet are free to freeze (read model)', greatest(v_free, 0) USING ERRCODE = 'check_violation';
    END IF;
    v_amount := p_amount;
  ELSE
    SELECT * INTO h FROM compliance.partial_holds WHERE freeze_request_id = p_lifts AND lifted_at IS NULL;
    IF NOT FOUND OR h.wallet <> v_wallet THEN
      RAISE EXCEPTION 'partial freeze % holds nothing in this wallet to release', coalesce(p_lifts::text, '(none)') USING ERRCODE = 'check_violation';
    END IF;
    IF p_amount IS NOT NULL AND p_amount <> h.amount THEN
      RAISE EXCEPTION 'a release lifts the whole partial hold (% units)', h.amount USING ERRCODE = 'check_violation';
    END IF;
    IF NOT compliance.partial_on_chain((SELECT q.case_ref FROM compliance.partial_freeze_requests q WHERE q.id = h.freeze_request_id)) THEN
      RAISE EXCEPTION 'partial freeze % is not on chain yet: release it once it is', p_lifts USING ERRCODE = 'check_violation';
    END IF;
    v_token := h.token;
    v_amount := h.amount;
  END IF;
  v_id := nextval(pg_get_serial_sequence('compliance.partial_freeze_requests', 'id'));
  INSERT INTO compliance.partial_freeze_requests (id, kind, subject_id, wallet, token, amount, reason_code, reason, kyc_case_id, str_case_id,
                                                  lifts_request_id, case_ref, requested_by, requested_at, expires_at)
  OVERRIDING SYSTEM VALUE
  VALUES (v_id, p_kind, v_subject, v_wallet, v_token, v_amount, p_reason_code, btrim(p_reason), p_kyc_case, p_str_case,
          CASE WHEN p_kind = 'unfreeze' THEN h.freeze_request_id END,
          sha256(convert_to('pt-compliance-partial-freeze-v1:' || v_id || ':' || p_kind, 'UTF8')),
          p_actor, v_now, v_now + interval '24 hours');
  PERFORM compliance.audit_append(p_actor, 'partial_freeze.requested', jsonb_build_object('request', v_id, 'kind', p_kind, 'subject', v_subject,
    'wallet', v_wallet, 'token', v_token, 'amount', v_amount::text, 'reasonCode', p_reason_code, 'reason', btrim(p_reason),
    'kycCase', p_kyc_case, 'strCase', p_str_case, 'lifts', CASE WHEN p_kind = 'unfreeze' THEN h.freeze_request_id END));
  RETURN v_id;
END $$;

/**
 * PF-1 checker: a different officer approves or rejects. An approved partial freeze places the
 * partial hold and enqueues compliance.freeze_partial; an approved release lifts it and enqueues
 * compliance.unfreeze_partial; both in this transaction (outbox O-1).
 */
CREATE FUNCTION compliance.decide_partial_freeze(p_request bigint, p_actor text, p_decision text, p_reason text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, compliance AS $$
DECLARE
  q compliance.partial_freeze_requests;
  h compliance.partial_holds;
  v_kind text;
  v_guard text;
  v_free numeric;
  v_key text;
BEGIN
  IF p_decision IS NULL OR p_decision NOT IN ('approve', 'reject') THEN
    RAISE EXCEPTION 'decision must be approve or reject' USING ERRCODE = 'check_violation';
  END IF;
  IF p_actor IS NULL OR length(p_actor) NOT BETWEEN 2 AND 100 OR NOT compliance.free_text_ok(p_reason, 10, 500) THEN
    RAISE EXCEPTION 'a reason of 10 to 500 characters is required (never a CNIC, IBAN or phone number)' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(586586191);
  SELECT * INTO q FROM compliance.partial_freeze_requests WHERE id = p_request FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown partial freeze request' USING ERRCODE = 'no_data_found'; END IF;
  IF q.status <> 'open' THEN RAISE EXCEPTION 'the request is already %', q.status USING ERRCODE = 'check_violation'; END IF;
  IF q.requested_by = p_actor THEN
    RAISE EXCEPTION 'maker-checker: the officer who proposed the partial % cannot decide it', q.kind USING ERRCODE = 'check_violation';
  END IF;
  IF q.expires_at < clock_timestamp() THEN
    PERFORM compliance.expire_partial_freeze_requests(p_actor);
    RETURN 'expired';
  END IF;
  IF p_decision = 'reject' THEN
    UPDATE compliance.partial_freeze_requests SET status = 'rejected', decided_by = p_actor, decision_reason = btrim(p_reason), decided_at = clock_timestamp()
    WHERE id = q.id;
    PERFORM compliance.audit_append(p_actor, 'partial_freeze.decided', jsonb_build_object('request', q.id, 'kind', q.kind, 'decision', 'reject',
      'requestedBy', q.requested_by, 'reason', btrim(p_reason)));
    RETURN 'rejected';
  END IF;

  v_kind := 'compliance.' || q.kind || '_partial';
  v_guard := compliance.freeze_guard(v_kind);
  IF v_guard IS NULL OR compliance.policy_token(v_kind) IS DISTINCT FROM q.token THEN
    RAISE EXCEPTION 'no active % signing policy for token %: the request could not be executed', v_kind, q.token USING ERRCODE = 'check_violation';
  END IF;
  IF q.kind = 'freeze' THEN
    v_free := compliance.partial_free_units(q.token, q.wallet);
    IF q.amount > v_free THEN
      RAISE EXCEPTION 'only % units of this wallet are free to freeze now (read model)', greatest(v_free, 0) USING ERRCODE = 'check_violation';
    END IF;
    INSERT INTO compliance.partial_holds (subject_id, wallet, token, amount, freeze_request_id) VALUES (q.subject_id, q.wallet, q.token, q.amount, q.id);
  ELSE
    SELECT * INTO h FROM compliance.partial_holds WHERE freeze_request_id = q.lifts_request_id AND lifted_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'the partial freeze was already released' USING ERRCODE = 'check_violation'; END IF;
    UPDATE compliance.partial_holds SET lifted_at = clock_timestamp(), lifted_by_request = q.id WHERE id = h.id;
  END IF;
  v_key := format('%s:request:%s', v_kind, q.id);
  PERFORM outbox.enqueue(v_key, v_kind,
    jsonb_build_object('freezeGuard', v_guard, 'account', q.wallet, 'amount', q.amount::text, 'caseId', '0x' || encode(q.case_ref, 'hex')),
    q.subject_id::text, p_actor);
  UPDATE compliance.partial_freeze_requests SET status = 'approved', decided_by = p_actor, decision_reason = btrim(p_reason), decided_at = clock_timestamp(),
         command_key = v_key
  WHERE id = q.id;
  PERFORM compliance.audit_append(p_actor, 'partial_freeze.decided', jsonb_build_object('request', q.id, 'kind', q.kind, 'decision', 'approve',
    'requestedBy', q.requested_by, 'reason', btrim(p_reason), 'command', v_key, 'wallet', q.wallet, 'amount', q.amount::text,
    'caseId', '0x' || encode(q.case_ref, 'hex')));
  RETURN 'approved';
END $$;

/** PF-4, for the signing service: did an approved two-officer request enqueue exactly this command, and is it not on chain yet? */
CREATE FUNCTION compliance.partial_command_allowed(p_kind text, p_payload jsonb) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, compliance AS $$
  SELECT p_kind IN ('compliance.freeze_partial', 'compliance.unfreeze_partial') AND EXISTS (
    SELECT 1 FROM compliance.partial_freeze_requests q JOIN outbox.commands o ON o.idempotency_key = q.command_key
    WHERE q.status = 'approved' AND 'compliance.' || q.kind || '_partial' = p_kind AND o.kind = p_kind AND o.payload = p_payload
      AND NOT compliance.partial_on_chain(q.case_ref)
      AND (q.kind = 'unfreeze' OR EXISTS (SELECT 1 FROM compliance.partial_holds h WHERE h.freeze_request_id = q.id AND h.lifted_at IS NULL)))
$$;

-- ================================================================== reconciliation (PF-5)
CREATE FUNCTION recon.compliance_partial(p_token text)
RETURNS TABLE (check_name text, subject text, expected text, actual text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, recon AS $$
#variable_conflict use_column
DECLARE
  v_token text := lower(p_token);
  r record;
BEGIN
  FOR r IN
    SELECT a.block_number, a.log_index, a.holder, a.frozen, a.amount, a.case_id,
           row_number() OVER (PARTITION BY a.case_id ORDER BY a.block_number, a.log_index) AS n,
           EXISTS (SELECT 1 FROM compliance.partial_freeze_requests q
                   WHERE q.status = 'approved' AND '0x' || encode(q.case_ref, 'hex') = a.case_id AND q.wallet = a.holder AND q.token = v_token
                     AND q.amount = a.amount AND (q.kind = 'freeze') = a.frozen) AS matched
    FROM chain.freeze_actions a
    WHERE a.scope = 'partial' AND a.deployment IN (SELECT t.deployment FROM chain.tokens t WHERE t.token = v_token)
    ORDER BY a.block_number, a.log_index
  LOOP
    IF NOT r.matched OR r.n > 1 THEN
      check_name := 'compliance.partial_unmatched';
      subject := format('partial freeze action at block %s log %s', r.block_number, r.log_index);
      expected := CASE WHEN r.matched THEN 'each caseId used once' ELSE 'an approved two-officer partial freeze request (caseId, wallet, amount, direction)' END;
      actual := format('%s %s units of %s, caseId %s', CASE WHEN r.frozen THEN 'freeze' ELSE 'release' END, r.amount, r.holder, r.case_id);
      RETURN NEXT;
    END IF;
  END LOOP;
  FOR r IN
    SELECT q.id, q.kind, q.wallet, q.amount, q.decided_at FROM compliance.partial_freeze_requests q
    WHERE q.status = 'approved' AND q.token = v_token AND q.decided_at < clock_timestamp() - interval '1 hour'
      AND NOT compliance.partial_on_chain(q.case_ref)
    ORDER BY q.id
  LOOP
    check_name := 'compliance.partial_pending';
    subject := format('partial %s request %s', r.kind, r.id);
    expected := 'on chain within an hour of the decision';
    actual := format('%s units of %s, approved %s, not on chain', r.amount, r.wallet, to_char(r.decided_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'));
    RETURN NEXT;
  END LOOP;
END $$;

-- ================================================================== audit verification (0019 C-7, extended)
CREATE OR REPLACE FUNCTION compliance.verify_audit() RETURNS TABLE (audit_id bigint, problem text)
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
    UNION ALL
    SELECT format('partial freeze request %s', q.id) FROM compliance.partial_freeze_requests q WHERE NOT EXISTS (
      SELECT 1 FROM compliance.audit x WHERE x.action = 'partial_freeze.requested' AND (x.detail->>'request')::bigint = q.id
        AND x.detail->>'wallet' = q.wallet AND x.detail->>'amount' = q.amount::text)
      OR (q.status IN ('approved', 'rejected') AND NOT EXISTS (
      SELECT 1 FROM compliance.audit x WHERE x.action = 'partial_freeze.decided' AND (x.detail->>'request')::bigint = q.id
        AND x.detail->>'decision' = CASE q.status WHEN 'approved' THEN 'approve' ELSE 'reject' END))
    UNION ALL
    SELECT format('partial hold %s', h.id) FROM compliance.partial_holds h WHERE NOT EXISTS (
      SELECT 1 FROM compliance.partial_freeze_requests q WHERE q.id = h.freeze_request_id AND q.kind = 'freeze' AND q.status = 'approved'
        AND q.wallet = h.wallet AND q.token = h.token AND q.amount = h.amount)
      OR (h.lifted_at IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM compliance.partial_freeze_requests q WHERE q.id = h.lifted_by_request AND q.kind = 'unfreeze' AND q.status = 'approved'
        AND q.wallet = h.wallet AND q.amount = h.amount))
  LOOP
    audit_id := NULL; problem := r.what || ' has no matching audit entry or event'; RETURN NEXT;
  END LOOP;
END $$;

-- ================================================================== portal (admin.*)
CREATE FUNCTION admin.partial_freeze_digest(p_id bigint) RETURNS bytea
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
  SELECT sha256(convert_to('pt-partial-freeze-request-v1' || jsonb_build_array(q.id, q.kind, q.wallet, q.token, q.amount::text, q.reason_code, q.reason,
           q.requested_by, q.status, q.lifts_request_id, admin.utc(q.requested_at))::text, 'UTF8'))
  FROM compliance.partial_freeze_requests q WHERE q.id = p_id
$$;

CREATE FUNCTION admin.partial_freezes(p_session bytea) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'compliance.read');
BEGIN
  RETURN jsonb_build_object(
    'policies', jsonb_build_object('freeze', compliance.freeze_guard('compliance.freeze_partial') IS NOT NULL,
                                   'unfreeze', compliance.freeze_guard('compliance.unfreeze_partial') IS NOT NULL),
    'token', compliance.policy_token('compliance.freeze_partial'),
    'holds', coalesce((SELECT jsonb_agg(jsonb_build_object('id', h.id, 'wallet', h.wallet, 'token', h.token, 'amount', h.amount::text,
                                                           'subject', left(replace(h.subject_id::text, '-', ''), 8), 'freezeRequest', h.freeze_request_id,
                                                           'onChain', compliance.partial_on_chain(q.case_ref), 'placedAt', admin.utc(h.placed_at)) ORDER BY h.id)
                       FROM compliance.partial_holds h JOIN compliance.partial_freeze_requests q ON q.id = h.freeze_request_id
                       WHERE h.lifted_at IS NULL), '[]'::jsonb),
    'requests', coalesce((SELECT jsonb_agg(jsonb_build_object('id', q.id, 'kind', q.kind, 'wallet', q.wallet, 'amount', q.amount::text,
        'reasonCode', q.reason_code, 'status', CASE WHEN q.status = 'open' AND q.expires_at < clock_timestamp() THEN 'expired' ELSE q.status END,
        'requestedBy', q.requested_by, 'requestedAt', admin.utc(q.requested_at), 'decidedBy', q.decided_by, 'decidedAt', admin.utc(q.decided_at),
        'command', admin.command_json(q.command_key)) ORDER BY q.id DESC)
      FROM (SELECT * FROM compliance.partial_freeze_requests ORDER BY id DESC LIMIT 200) q), '[]'::jsonb));
END $$;

CREATE FUNCTION admin.partial_freeze(p_session bytea, p_id bigint) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'compliance.read');
  v_handle text := admin.handle_of(v_me);
  q compliance.partial_freeze_requests;
  v text[] := '{}';
  a text[] := '{}';
  v_kind text;
  v_free numeric;
BEGIN
  SELECT * INTO q FROM compliance.partial_freeze_requests WHERE id = p_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  v_kind := 'compliance.' || q.kind || '_partial';
  v_free := compliance.partial_free_units(q.token, q.wallet);
  IF NOT admin.has_permission(p_session, 'compliance.decide') THEN v := v || 'Only a compliance officer decides partial freezes; your role reads them.'::text; END IF;
  IF q.status <> 'open' THEN v := v || format('The request is %s.', q.status); END IF;
  IF q.status = 'open' AND q.expires_at < clock_timestamp() THEN v := v || 'The request is older than 24 hours: ask again.'::text; END IF;
  IF q.requested_by = v_handle THEN v := v || format('You proposed this partial %s: a different compliance officer decides (maker-checker).', q.kind); END IF;
  IF compliance.freeze_guard(v_kind) IS NULL OR compliance.policy_token(v_kind) IS DISTINCT FROM q.token THEN
    a := a || format('No active %s signing policy for this token.', v_kind);
  END IF;
  IF q.kind = 'freeze' AND q.status = 'open' AND q.amount > v_free THEN
    a := a || format('Only %s units of the wallet are free now (read model).', greatest(v_free, 0));
  END IF;
  RETURN jsonb_build_object(
    'id', q.id, 'kind', q.kind, 'wallet', q.wallet, 'token', q.token, 'amount', q.amount::text, 'freeUnits', greatest(v_free, 0)::text,
    'reasonCode', q.reason_code, 'reasonLabel', (SELECT label FROM compliance.reason_codes WHERE code = q.reason_code AND applies_to = q.kind),
    'reason', q.reason, 'kycCase', q.kyc_case_id, 'strCase', q.str_case_id, 'lifts', q.lifts_request_id,
    'caseId', '0x' || encode(q.case_ref, 'hex'), 'onChain', compliance.partial_on_chain(q.case_ref),
    'requestedBy', q.requested_by, 'requestedAt', admin.utc(q.requested_at), 'expiresAt', admin.utc(q.expires_at), 'status', q.status,
    'decidedBy', q.decided_by, 'decisionReason', q.decision_reason, 'decidedAt', admin.utc(q.decided_at),
    'commandKey', q.command_key, 'command', admin.command_json(q.command_key),
    'released', (SELECT h.lifted_by_request FROM compliance.partial_holds h WHERE h.freeze_request_id = q.id),
    'subject', admin.subject_json(q.subject_id),
    'digest', encode(admin.partial_freeze_digest(q.id), 'hex'),
    'blockers', to_jsonb(v), 'approveBlockers', to_jsonb(a));
END $$;

CREATE FUNCTION admin.request_partial_freeze(p_session bytea, p_kind text, p_wallet text, p_amount numeric, p_lifts bigint, p_reason_code text,
                                             p_reason text, p_kyc_case bigint, p_str_case bigint)
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
    v_id := compliance.request_partial_freeze(p_kind, p_wallet, p_amount, p_lifts, p_reason_code, p_reason, v_handle, p_kyc_case, p_str_case);
    PERFORM admin.unbind_officer(v_handle);
  EXCEPTION WHEN SQLSTATE '23514' OR SQLSTATE '23505' OR SQLSTATE '42501' OR SQLSTATE '22023' OR SQLSTATE 'P0002' OR SQLSTATE '23503'
              OR SQLSTATE '22003' THEN
    RETURN admin.refuse(v_me, 'partial_freeze', 'new', coalesce(p_kind, '?'), SQLERRM);
  END;
  PERFORM admin.audit_append(v_me::text, 'compliance.requested', jsonb_build_object('kind', 'partial_' || p_kind, 'ref', v_id, 'action', 'request'));
  RETURN jsonb_build_object('ok', true, 'id', v_id, 'status', 'open');
END $$;

CREATE FUNCTION admin.decide_partial_freeze(p_session bytea, p_request bigint, p_decision text, p_reason text, p_digest bytea) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'compliance.decide');
  v_handle text := admin.handle_of(v_me);
  v_status text;
BEGIN
  PERFORM admin.require_step_up(p_session);
  PERFORM admin.check_decision(p_decision, p_reason);
  IF NOT EXISTS (SELECT 1 FROM compliance.partial_freeze_requests WHERE id = p_request) THEN
    RETURN admin.refuse(v_me, 'partial_freeze', p_request::text, p_decision, 'unknown partial freeze request');
  END IF;
  IF admin.partial_freeze_digest(p_request) IS DISTINCT FROM p_digest THEN
    RETURN admin.refuse(v_me, 'partial_freeze', p_request::text, p_decision, 'the request differs from what you reviewed: reload and check again');
  END IF;
  BEGIN
    PERFORM admin.bind_officer(v_handle);
    v_status := compliance.decide_partial_freeze(p_request, v_handle, p_decision, p_reason);
    PERFORM admin.unbind_officer(v_handle);
  EXCEPTION WHEN SQLSTATE '23514' OR SQLSTATE '23505' OR SQLSTATE '42501' OR SQLSTATE '22023' OR SQLSTATE 'P0002' THEN
    RETURN admin.refuse(v_me, 'partial_freeze', p_request::text, p_decision, SQLERRM);
  END;
  PERFORM admin.audit_append(v_me::text, 'compliance.decided', jsonb_build_object('kind', 'partial_freeze', 'ref', p_request, 'action', p_decision,
    'result', v_status, 'digest', encode(p_digest, 'hex')));
  RETURN jsonb_build_object('ok', true, 'status', v_status);
END $$;

-- ================================================================== privileges
REVOKE ALL ON compliance.partial_freeze_requests, compliance.partial_holds FROM PUBLIC;
REVOKE ALL ON FUNCTION
  compliance.guard_partial_freeze_request(), compliance.guard_partial_hold(), compliance.policy_token(text), compliance.partial_on_chain(bytea),
  compliance.partial_free_units(text, text), compliance.expire_partial_freeze_requests(text),
  compliance.request_partial_freeze(text, text, numeric, bigint, text, text, text, bigint, bigint),
  compliance.decide_partial_freeze(bigint, text, text, text), compliance.partial_command_allowed(text, jsonb),
  recon.compliance_partial(text),
  admin.partial_freeze_digest(bigint), admin.partial_freezes(bytea), admin.partial_freeze(bytea, bigint),
  admin.request_partial_freeze(bytea, text, text, numeric, bigint, text, text, bigint, bigint),
  admin.decide_partial_freeze(bytea, bigint, text, text, bytea)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  admin.partial_freezes(bytea),
  admin.partial_freeze(bytea, bigint),
  admin.request_partial_freeze(bytea, text, text, numeric, bigint, text, text, bigint, bigint),
  admin.decide_partial_freeze(bytea, bigint, text, text, bytea)
TO pt_admin_portal;
GRANT EXECUTE ON FUNCTION compliance.partial_command_allowed(text, jsonb) TO pt_signer;
GRANT EXECUTE ON FUNCTION recon.compliance_partial(text) TO pt_recon_writer, pt_recon_reader;

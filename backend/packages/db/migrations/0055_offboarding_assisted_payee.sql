-- PT Control: offboarding steps 2 and 3, and assisted payout-account changes (ADR 0011 amendments
-- of 2026-11-04, owner approval 2026-11-04). Applies on top of 0054.
--
--   OB-1  admin.offboarding(session): every investor who is not verified and has a bound wallet,
--         with the freeze on chain, the units still held (every token, read model), open S-06
--         recovery and S-04 transfer cases and the identity registration. Step 2 (moving or
--         redeeming units) stays with those cases: nothing here moves a unit.
--   OB-2  Step 3, identity deletion: one compliance officer requests it, a different one approves it
--         within 24 hours (reason, digest, step-up). Both need: the wallet bound to an investor who
--         is not verified, an identity registered in the read model, and ZERO units in every token
--         (findings F-01/F-02: never delete or update the identity of a wallet that holds units).
--   OB-3  No key of the platform can delete an identity: an approved request carries the exact
--         timelock call (IdentityRegistry.deleteIdentity(wallet), salt = case_ref) for the Admin
--         Safe; it reads "done" once the read model shows the identity removed.
--   AP-1  Assisted payout-account change, maker: admin.assisted_payee_ticket(session, ref, reason,
--         ticket hash) (operations.request, step-up, a verified investor, no open request) issues a
--         one-time ticket (2 minutes) bound to the officer and the investor.
--   AP-2  The bank service redeems it (bank.assist_ticket_subject, bank.request_assisted_payee):
--         title inquiry, keyed hash and sealed IBAN made by the service; the title must match the
--         verified name already; the request is PENDING. The portal never sees the sealed IBAN.
--   AP-3  Checker: a different officer with operations.decide approves (after a call-back) or
--         rejects within 24 hours; approval runs bank.register_payee unchanged (72-hour cooling-off,
--         bank_alert, notification and monitoring producers as for the website).
--   AP-4  Every row is audited (compliance.audit for OB, bank.audit for AP, admin.audit for both);
--         requests change only along their state machine and are never deleted.

-- ================================================================== OB: identity deletion requests
CREATE TABLE compliance.identity_deletions (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subject_id       uuid NOT NULL REFERENCES kyc.subjects (id),
  wallet           text NOT NULL CHECK (length(wallet) = 42 AND wallet ~ '^0x[0-9a-f]+$'),
  registry         text NOT NULL CHECK (length(registry) = 42 AND registry ~ '^0x[0-9a-f]+$'),
  reason           text NOT NULL CHECK (compliance.free_text_ok(reason, 10, 500)),
  -- Salt of the timelock operation: SHA-256 of the domain and the id.
  case_ref         bytea NOT NULL UNIQUE CHECK (length(case_ref) = 32),
  requested_by     text NOT NULL CHECK (length(requested_by) BETWEEN 2 AND 100),
  requested_at     timestamptz NOT NULL,
  expires_at       timestamptz NOT NULL,
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'approved', 'rejected', 'expired')),
  decided_by       text CHECK (length(decided_by) BETWEEN 2 AND 100),
  decision_reason  text CHECK (decision_reason IS NULL OR compliance.free_text_ok(decision_reason, 10, 500)),
  decided_at       timestamptz,
  CHECK (expires_at = requested_at + interval '24 hours'),
  CHECK (decided_by IS NULL OR decided_by <> requested_by),
  CHECK ((status = 'open') = (decided_at IS NULL)),
  CHECK ((status IN ('approved', 'rejected')) = (decided_by IS NOT NULL AND decision_reason IS NOT NULL))
);
CREATE UNIQUE INDEX identity_deletions_one_live ON compliance.identity_deletions (wallet, registry) WHERE status IN ('open', 'approved');

CREATE FUNCTION compliance.guard_identity_deletion() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'identity deletion requests are never deleted' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF OLD.status <> 'open'
     OR (NEW.id, NEW.subject_id, NEW.wallet, NEW.registry, NEW.reason, NEW.case_ref, NEW.requested_by, NEW.requested_at, NEW.expires_at)
        IS DISTINCT FROM (OLD.id, OLD.subject_id, OLD.wallet, OLD.registry, OLD.reason, OLD.case_ref, OLD.requested_by, OLD.requested_at, OLD.expires_at) THEN
    RAISE EXCEPTION 'identity deletion request % can only be decided once', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER identity_deletions_guard BEFORE UPDATE OR DELETE ON compliance.identity_deletions FOR EACH ROW EXECUTE FUNCTION compliance.guard_identity_deletion();
CREATE TRIGGER identity_deletions_no_truncate BEFORE TRUNCATE ON compliance.identity_deletions FOR EACH STATEMENT EXECUTE FUNCTION compliance.forbid_change();
CREATE TRIGGER identity_deletions_officer_binding BEFORE INSERT OR UPDATE ON compliance.identity_deletions
  FOR EACH ROW EXECUTE FUNCTION compliance.bind_actor('requested_by', 'decided_by');

/** Units a wallet holds in every token of the read model. */
CREATE FUNCTION compliance.units_held(p_wallet text) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, compliance AS $$
  SELECT coalesce(sum(h.balance), 0) FROM chain.holdings h WHERE h.holder = lower(p_wallet)
$$;

/** OB-2: why the identity of this wallet cannot be deleted now (NULL = it can). */
CREATE FUNCTION compliance.deletion_problem(p_wallet text, p_registry text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, compliance AS $$
  SELECT CASE
    WHEN w.subject_id IS NULL THEN 'no investor wallet is bound to this address'
    WHEN kyc.subject_status(w.subject_id) = 'verified' THEN 'the investor is KYC-verified: identities of verified investors are never deleted'
    WHEN NOT EXISTS (SELECT 1 FROM chain.investors i WHERE i.registry = lower(p_registry) AND i.wallet = lower(p_wallet) AND i.registered)
      THEN 'no identity of this wallet is registered in that registry (read model)'
    WHEN compliance.units_held(p_wallet) > 0
      THEN format('the wallet still holds %s units: move or redeem them first through an S-06 case or an S-04 transfer (step 2)', compliance.units_held(p_wallet))
  END
  FROM (SELECT (SELECT x.subject_id FROM kyc.wallets x WHERE x.wallet = lower(p_wallet)) AS subject_id) w
$$;

CREATE FUNCTION compliance.expire_identity_deletions(p_actor text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, compliance AS $$
DECLARE
  r compliance.identity_deletions;
  n integer := 0;
BEGIN
  FOR r IN SELECT * FROM compliance.identity_deletions WHERE status = 'open' AND expires_at < clock_timestamp() ORDER BY id FOR UPDATE LOOP
    UPDATE compliance.identity_deletions SET status = 'expired', decided_at = clock_timestamp() WHERE id = r.id;
    PERFORM compliance.audit_append(p_actor, 'identity_deletion.expired', jsonb_build_object('request', r.id, 'wallet', r.wallet));
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;

/** OB-2 maker. The registry is the identity registry the wallet is registered in (read model). */
CREATE FUNCTION compliance.request_identity_deletion(p_wallet text, p_reason text, p_actor text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, compliance AS $$
DECLARE
  v_wallet text := lower(btrim(coalesce(p_wallet, '')));
  v_registry text;
  v_problem text;
  v_subject uuid;
  v_id bigint;
  v_now timestamptz := date_trunc('microseconds', clock_timestamp());
BEGIN
  IF length(v_wallet) <> 42 OR v_wallet !~ '^0x[0-9a-f]+$' THEN
    RAISE EXCEPTION 'a wallet address (0x + 40 hex digits) is required' USING ERRCODE = 'check_violation';
  END IF;
  IF p_actor IS NULL OR length(p_actor) NOT BETWEEN 2 AND 100 OR NOT compliance.free_text_ok(p_reason, 10, 500) THEN
    RAISE EXCEPTION 'a reason of 10 to 500 characters is required (never a CNIC, IBAN or phone number)' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(586586192);
  PERFORM compliance.expire_identity_deletions(p_actor);
  SELECT i.registry INTO v_registry FROM chain.investors i WHERE i.wallet = v_wallet AND i.registered ORDER BY i.registry LIMIT 1;
  v_problem := compliance.deletion_problem(v_wallet, coalesce(v_registry, '0x' || repeat('0', 40)));
  IF v_problem IS NOT NULL THEN RAISE EXCEPTION '%', v_problem USING ERRCODE = 'check_violation'; END IF;
  IF EXISTS (SELECT 1 FROM compliance.identity_deletions WHERE wallet = v_wallet AND registry = v_registry AND status IN ('open', 'approved')) THEN
    RAISE EXCEPTION 'an open or approved identity deletion exists for this wallet' USING ERRCODE = 'unique_violation';
  END IF;
  SELECT subject_id INTO v_subject FROM kyc.wallets WHERE wallet = v_wallet;
  v_id := nextval(pg_get_serial_sequence('compliance.identity_deletions', 'id'));
  INSERT INTO compliance.identity_deletions (id, subject_id, wallet, registry, reason, case_ref, requested_by, requested_at, expires_at)
  OVERRIDING SYSTEM VALUE
  VALUES (v_id, v_subject, v_wallet, v_registry, btrim(p_reason), sha256(convert_to('pt-identity-deletion-v1:' || v_id, 'UTF8')), p_actor, v_now, v_now + interval '24 hours');
  PERFORM compliance.audit_append(p_actor, 'identity_deletion.requested', jsonb_build_object('request', v_id, 'subject', v_subject, 'wallet', v_wallet,
    'registry', v_registry, 'reason', btrim(p_reason)));
  RETURN v_id;
END $$;

/** OB-2 checker: a different officer; the conditions are checked again. */
CREATE FUNCTION compliance.decide_identity_deletion(p_request bigint, p_actor text, p_decision text, p_reason text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, compliance AS $$
DECLARE
  q compliance.identity_deletions;
  v_problem text;
BEGIN
  IF p_decision IS NULL OR p_decision NOT IN ('approve', 'reject') THEN
    RAISE EXCEPTION 'decision must be approve or reject' USING ERRCODE = 'check_violation';
  END IF;
  IF p_actor IS NULL OR length(p_actor) NOT BETWEEN 2 AND 100 OR NOT compliance.free_text_ok(p_reason, 10, 500) THEN
    RAISE EXCEPTION 'a reason of 10 to 500 characters is required (never a CNIC, IBAN or phone number)' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(586586192);
  SELECT * INTO q FROM compliance.identity_deletions WHERE id = p_request FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown identity deletion request' USING ERRCODE = 'no_data_found'; END IF;
  IF q.status <> 'open' THEN RAISE EXCEPTION 'the request is already %', q.status USING ERRCODE = 'check_violation'; END IF;
  IF q.requested_by = p_actor THEN
    RAISE EXCEPTION 'maker-checker: the officer who requested the deletion cannot decide it' USING ERRCODE = 'check_violation';
  END IF;
  IF q.expires_at < clock_timestamp() THEN
    PERFORM compliance.expire_identity_deletions(p_actor);
    RETURN 'expired';
  END IF;
  IF p_decision = 'approve' THEN
    v_problem := compliance.deletion_problem(q.wallet, q.registry);
    IF v_problem IS NOT NULL THEN RAISE EXCEPTION '%', v_problem USING ERRCODE = 'check_violation'; END IF;
  END IF;
  UPDATE compliance.identity_deletions SET status = CASE p_decision WHEN 'approve' THEN 'approved' ELSE 'rejected' END,
         decided_by = p_actor, decision_reason = btrim(p_reason), decided_at = clock_timestamp()
  WHERE id = q.id;
  PERFORM compliance.audit_append(p_actor, 'identity_deletion.decided', jsonb_build_object('request', q.id, 'decision', p_decision,
    'requestedBy', q.requested_by, 'reason', btrim(p_reason), 'wallet', q.wallet, 'registry', q.registry));
  RETURN CASE p_decision WHEN 'approve' THEN 'approved' ELSE 'rejected' END;
END $$;

-- ================================================================== AP: assisted payout-account changes
CREATE TABLE bank.assist_tickets (
  token_hash  bytea PRIMARY KEY CHECK (length(token_hash) = 32),
  subject_id  uuid NOT NULL REFERENCES kyc.subjects (id),
  handle      text NOT NULL CHECK (length(handle) BETWEEN 2 AND 100),
  reason      text NOT NULL CHECK (compliance.free_text_ok(reason, 10, 500)),
  created_at  timestamptz NOT NULL,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  CHECK (expires_at = created_at + interval '2 minutes')
);

CREATE FUNCTION bank.guard_assist_ticket() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'assist tickets are never deleted' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF OLD.used_at IS NOT NULL OR NEW.used_at IS NULL
     OR (NEW.token_hash, NEW.subject_id, NEW.handle, NEW.reason, NEW.created_at, NEW.expires_at)
        IS DISTINCT FROM (OLD.token_hash, OLD.subject_id, OLD.handle, OLD.reason, OLD.created_at, OLD.expires_at) THEN
    RAISE EXCEPTION 'an assist ticket is used once and never changed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER assist_tickets_guard BEFORE UPDATE OR DELETE ON bank.assist_tickets FOR EACH ROW EXECUTE FUNCTION bank.guard_assist_ticket();
CREATE TRIGGER assist_tickets_officer_binding BEFORE INSERT ON bank.assist_tickets FOR EACH ROW EXECUTE FUNCTION compliance.bind_actor('handle');

CREATE TABLE bank.assisted_payee_requests (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subject_id       uuid NOT NULL REFERENCES kyc.subjects (id),
  ticket_hash      bytea NOT NULL UNIQUE REFERENCES bank.assist_tickets (token_hash),
  iban_hash        bytea NOT NULL CHECK (length(iban_hash) = 32),
  iban_enc         bytea NOT NULL CHECK (length(iban_enc) BETWEEN 40 AND 200),
  iban_last4       text NOT NULL CHECK (iban_last4 ~ '^[0-9]{4}$'),
  bank_code        text NOT NULL CHECK (bank_code ~ '^[A-Z]{4}$'),
  title_hash       bytea NOT NULL CHECK (length(title_hash) = 32),
  reason           text NOT NULL,
  -- The officer of the ticket: the admin database checked that officer's session when it issued it.
  requested_by     text NOT NULL CHECK (length(requested_by) BETWEEN 2 AND 100),
  requested_at     timestamptz NOT NULL,
  expires_at       timestamptz NOT NULL,
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'approved', 'rejected', 'expired')),
  decided_by       text CHECK (length(decided_by) BETWEEN 2 AND 100),
  decision_reason  text CHECK (decision_reason IS NULL OR compliance.free_text_ok(decision_reason, 10, 500)),
  decided_at       timestamptz,
  payee_id         bigint REFERENCES bank.payees (id),
  CHECK (expires_at = requested_at + interval '24 hours'),
  CHECK (decided_by IS NULL OR decided_by <> requested_by),
  CHECK ((status = 'open') = (decided_at IS NULL)),
  CHECK ((status IN ('approved', 'rejected')) = (decided_by IS NOT NULL AND decision_reason IS NOT NULL)),
  CHECK ((status = 'approved') = (payee_id IS NOT NULL))
);
CREATE UNIQUE INDEX assisted_payee_requests_one_open ON bank.assisted_payee_requests (subject_id) WHERE status = 'open';

CREATE FUNCTION bank.guard_assisted_payee_request() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'assisted payee requests are never deleted' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF OLD.status <> 'open'
     OR (NEW.id, NEW.subject_id, NEW.ticket_hash, NEW.iban_hash, NEW.iban_enc, NEW.iban_last4, NEW.bank_code, NEW.title_hash, NEW.reason,
         NEW.requested_by, NEW.requested_at, NEW.expires_at)
        IS DISTINCT FROM (OLD.id, OLD.subject_id, OLD.ticket_hash, OLD.iban_hash, OLD.iban_enc, OLD.iban_last4, OLD.bank_code, OLD.title_hash,
         OLD.reason, OLD.requested_by, OLD.requested_at, OLD.expires_at) THEN
    RAISE EXCEPTION 'assisted payee request % can only be decided once', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER assisted_payee_requests_guard BEFORE UPDATE OR DELETE ON bank.assisted_payee_requests
  FOR EACH ROW EXECUTE FUNCTION bank.guard_assisted_payee_request();
CREATE TRIGGER assisted_payee_requests_officer_binding BEFORE UPDATE ON bank.assisted_payee_requests
  FOR EACH ROW EXECUTE FUNCTION compliance.bind_actor('requested_by', 'decided_by');
CREATE TRIGGER assisted_no_truncate BEFORE TRUNCATE ON bank.assisted_payee_requests FOR EACH STATEMENT EXECUTE FUNCTION compliance.forbid_change();
CREATE TRIGGER assist_tickets_no_truncate BEFORE TRUNCATE ON bank.assist_tickets FOR EACH STATEMENT EXECUTE FUNCTION compliance.forbid_change();

CREATE FUNCTION bank.expire_assisted_payees(p_actor text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, bank AS $$
DECLARE
  r bank.assisted_payee_requests;
  n integer := 0;
BEGIN
  FOR r IN SELECT * FROM bank.assisted_payee_requests WHERE status = 'open' AND expires_at < clock_timestamp() ORDER BY id FOR UPDATE LOOP
    UPDATE bank.assisted_payee_requests SET status = 'expired', decided_at = clock_timestamp() WHERE id = r.id;
    PERFORM bank.audit_append(p_actor, 'assisted_payee.expired', jsonb_build_object('request', r.id, 'subject', r.subject_id));
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;

/** AP-2, for the bank service: the investor of a valid, unused ticket (it seals the IBAN for that investor). */
CREATE FUNCTION bank.assist_ticket_subject(p_token_hash bytea) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, bank AS $$
  SELECT t.subject_id FROM bank.assist_tickets t WHERE t.token_hash = p_token_hash AND t.used_at IS NULL AND t.expires_at > clock_timestamp()
$$;

/** AP-2, for the bank service: uses the ticket once and stores the pending request. */
CREATE FUNCTION bank.request_assisted_payee(p_token_hash bytea, p_iban_hash bytea, p_iban_enc bytea, p_last4 text, p_bank_code text, p_title_hash bytea)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, bank AS $$
DECLARE
  t bank.assist_tickets;
  v_id bigint;
  v_now timestamptz := date_trunc('microseconds', clock_timestamp());
BEGIN
  PERFORM bank.expire_assisted_payees('bank-payees');
  SELECT * INTO t FROM bank.assist_tickets WHERE token_hash = p_token_hash FOR UPDATE;
  IF NOT FOUND OR t.used_at IS NOT NULL OR t.expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'assist ticket is not valid (unknown, used or expired)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE bank.assist_tickets SET used_at = clock_timestamp() WHERE token_hash = p_token_hash;
  IF p_title_hash IS DISTINCT FROM (SELECT name_hash FROM kyc.subjects WHERE id = t.subject_id) THEN
    RAISE EXCEPTION 'the bank account title does not match the verified name' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM bank.payees WHERE iban_hash = p_iban_hash AND superseded_at IS NULL AND subject_id <> t.subject_id) THEN
    RAISE EXCEPTION 'this account is already the payout account of another investor' USING ERRCODE = 'unique_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM bank.payees WHERE iban_hash = p_iban_hash AND superseded_at IS NULL AND subject_id = t.subject_id) THEN
    RAISE EXCEPTION 'this account is already the investor''s payout account' USING ERRCODE = 'unique_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM bank.assisted_payee_requests WHERE subject_id = t.subject_id AND status = 'open') THEN
    RAISE EXCEPTION 'an assisted change for this investor is already waiting for a decision' USING ERRCODE = 'unique_violation';
  END IF;
  INSERT INTO bank.assisted_payee_requests (subject_id, ticket_hash, iban_hash, iban_enc, iban_last4, bank_code, title_hash, reason, requested_by,
                                            requested_at, expires_at)
  VALUES (t.subject_id, t.token_hash, p_iban_hash, p_iban_enc, p_last4, p_bank_code, p_title_hash, t.reason, t.handle, v_now, v_now + interval '24 hours')
  RETURNING id INTO v_id;
  PERFORM bank.audit_append(t.handle, 'assisted_payee.requested', jsonb_build_object('request', v_id, 'subject', t.subject_id, 'last4', p_last4,
    'bankCode', p_bank_code, 'reason', t.reason));
  RETURN v_id;
END $$;

/** AP-3 checker: a different officer; approval registers the account exactly as the website does. */
CREATE FUNCTION bank.decide_assisted_payee(p_request bigint, p_actor text, p_decision text, p_reason text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, bank AS $$
DECLARE
  q bank.assisted_payee_requests;
  v_payee bigint;
BEGIN
  IF p_decision IS NULL OR p_decision NOT IN ('approve', 'reject') THEN
    RAISE EXCEPTION 'decision must be approve or reject' USING ERRCODE = 'check_violation';
  END IF;
  IF p_actor IS NULL OR length(p_actor) NOT BETWEEN 2 AND 100 OR NOT compliance.free_text_ok(p_reason, 10, 500) THEN
    RAISE EXCEPTION 'a reason of 10 to 500 characters is required (never a CNIC, IBAN or phone number)' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO q FROM bank.assisted_payee_requests WHERE id = p_request FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown assisted payee request' USING ERRCODE = 'no_data_found'; END IF;
  IF q.status <> 'open' THEN RAISE EXCEPTION 'the request is already %', q.status USING ERRCODE = 'check_violation'; END IF;
  IF q.requested_by = p_actor THEN
    RAISE EXCEPTION 'maker-checker: the officer who entered the account cannot approve it' USING ERRCODE = 'check_violation';
  END IF;
  IF q.expires_at < clock_timestamp() THEN
    PERFORM bank.expire_assisted_payees(p_actor);
    RETURN 'expired';
  END IF;
  IF p_decision = 'approve' THEN
    v_payee := bank.register_payee(q.subject_id, q.iban_hash, q.iban_enc, q.iban_last4, q.bank_code, q.title_hash, p_actor);
  END IF;
  UPDATE bank.assisted_payee_requests SET status = CASE p_decision WHEN 'approve' THEN 'approved' ELSE 'rejected' END,
         decided_by = p_actor, decision_reason = btrim(p_reason), decided_at = clock_timestamp(), payee_id = v_payee
  WHERE id = q.id;
  PERFORM bank.audit_append(p_actor, 'assisted_payee.decided', jsonb_build_object('request', q.id, 'decision', p_decision, 'requestedBy', q.requested_by,
    'reason', btrim(p_reason), 'payee', v_payee));
  RETURN CASE p_decision WHEN 'approve' THEN 'approved' ELSE 'rejected' END;
END $$;

-- ================================================================== portal (admin.*)
/** OB-1: investors who are not verified, with a bound wallet. */
CREATE FUNCTION admin.offboarding(p_session bytea) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'compliance.read');
BEGIN
  RETURN jsonb_build_object(
    'investors', coalesce((SELECT jsonb_agg(x ORDER BY x->>'since' DESC) FROM (
      SELECT jsonb_build_object(
        'ref', left(replace(s.id::text, '-', ''), 8), 'status', kyc.subject_status(s.id), 'wallet', w.wallet,
        'since', admin.utc(s.created_at),
        'frozen', EXISTS (SELECT 1 FROM chain.freezes f WHERE f.holder = w.wallet AND f.address_frozen),
        'units', compliance.units_held(w.wallet)::text,
        'registered', EXISTS (SELECT 1 FROM chain.investors i WHERE i.wallet = w.wallet AND i.registered),
        'recoveryCases', (SELECT count(*) FROM recovery.cases c WHERE c.subject_id = s.id AND c.status NOT IN ('rejected', 'cancelled', 'closed')),
        'transferCases', (SELECT count(*) FROM transfer.cases t WHERE t.seller_subject = s.id
                            AND t.status NOT IN ('rejected', 'settled', 'failed', 'cancelled')),
        'deletion', (SELECT jsonb_build_object('id', d.id, 'status', CASE WHEN d.status = 'approved' AND NOT EXISTS (
                        SELECT 1 FROM chain.investors i WHERE i.registry = d.registry AND i.wallet = d.wallet AND i.registered) THEN 'done' ELSE d.status END)
                     FROM compliance.identity_deletions d WHERE d.wallet = w.wallet ORDER BY d.id DESC LIMIT 1)) AS x
      FROM kyc.subjects s JOIN kyc.wallets w ON w.subject_id = s.id
      WHERE kyc.subject_status(s.id) <> 'verified'
      ORDER BY s.created_at DESC LIMIT 200) q), '[]'::jsonb));
END $$;

CREATE FUNCTION admin.identity_deletion_digest(p_id bigint) RETURNS bytea
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
  SELECT sha256(convert_to('pt-identity-deletion-v1' || jsonb_build_array(d.id, d.wallet, d.registry, d.reason, d.requested_by, d.status,
           admin.utc(d.requested_at))::text, 'UTF8'))
  FROM compliance.identity_deletions d WHERE d.id = p_id
$$;

CREATE FUNCTION admin.identity_deletion(p_session bytea, p_id bigint) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'compliance.read');
  v_handle text := admin.handle_of(v_me);
  d compliance.identity_deletions;
  v text[] := '{}';
  a text[] := '{}';
  v_problem text;
  v_done boolean;
BEGIN
  SELECT * INTO d FROM compliance.identity_deletions WHERE id = p_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  v_problem := compliance.deletion_problem(d.wallet, d.registry);
  v_done := d.status = 'approved' AND NOT EXISTS (SELECT 1 FROM chain.investors i WHERE i.registry = d.registry AND i.wallet = d.wallet AND i.registered);
  IF NOT admin.has_permission(p_session, 'compliance.decide') THEN v := v || 'Only a compliance officer decides identity deletions; your role reads them.'::text; END IF;
  IF d.status <> 'open' THEN v := v || format('The request is %s.', d.status); END IF;
  IF d.status = 'open' AND d.expires_at < clock_timestamp() THEN v := v || 'The request is older than 24 hours: ask again.'::text; END IF;
  IF d.requested_by = v_handle THEN v := v || 'You requested this deletion: a different compliance officer decides (maker-checker).'::text; END IF;
  IF d.status = 'open' AND v_problem IS NOT NULL THEN a := a || v_problem; END IF;
  RETURN jsonb_build_object(
    'id', d.id, 'wallet', d.wallet, 'registry', d.registry, 'reason', d.reason, 'caseRef', '0x' || encode(d.case_ref, 'hex'),
    'requestedBy', d.requested_by, 'requestedAt', admin.utc(d.requested_at), 'expiresAt', admin.utc(d.expires_at),
    'status', CASE WHEN v_done THEN 'done' ELSE d.status END,
    'decidedBy', d.decided_by, 'decisionReason', d.decision_reason, 'decidedAt', admin.utc(d.decided_at),
    'units', compliance.units_held(d.wallet)::text,
    'timelock', (SELECT c.address FROM chain.contracts c JOIN chain.contracts r ON r.deployment = c.deployment AND r.role = 'identityRegistry' AND r.address = d.registry
                 WHERE c.role = 'timelock' LIMIT 1),
    -- IdentityRegistry.deleteIdentity(address): selector 0xa8d29d1d, then the wallet as a 32-byte word.
    'callData', CASE WHEN d.status = 'approved' THEN '0xa8d29d1d' || lpad(substr(d.wallet, 3), 64, '0') END,
    'subject', admin.subject_json(d.subject_id),
    'digest', encode(admin.identity_deletion_digest(d.id), 'hex'),
    'blockers', to_jsonb(v), 'approveBlockers', to_jsonb(a));
END $$;

CREATE FUNCTION admin.request_identity_deletion(p_session bytea, p_wallet text, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'compliance.decide');
  v_handle text := admin.handle_of(v_me);
  v_id bigint;
BEGIN
  PERFORM admin.require_step_up(p_session);
  PERFORM admin.check_text(p_reason, 10, 500);
  BEGIN
    PERFORM admin.bind_officer(v_handle);
    v_id := compliance.request_identity_deletion(p_wallet, p_reason, v_handle);
    PERFORM admin.unbind_officer(v_handle);
  EXCEPTION WHEN SQLSTATE '23514' OR SQLSTATE '23505' OR SQLSTATE '42501' OR SQLSTATE '22023' OR SQLSTATE 'P0002' THEN
    RETURN admin.refuse(v_me, 'identity_deletion', 'new', 'request', SQLERRM);
  END;
  PERFORM admin.audit_append(v_me::text, 'compliance.requested', jsonb_build_object('kind', 'identity_deletion', 'ref', v_id, 'action', 'request'));
  RETURN jsonb_build_object('ok', true, 'id', v_id, 'status', 'open');
END $$;

CREATE FUNCTION admin.decide_identity_deletion(p_session bytea, p_request bigint, p_decision text, p_reason text, p_digest bytea) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'compliance.decide');
  v_handle text := admin.handle_of(v_me);
  v_status text;
BEGIN
  PERFORM admin.require_step_up(p_session);
  PERFORM admin.check_decision(p_decision, p_reason);
  IF NOT EXISTS (SELECT 1 FROM compliance.identity_deletions WHERE id = p_request) THEN
    RETURN admin.refuse(v_me, 'identity_deletion', p_request::text, p_decision, 'unknown identity deletion request');
  END IF;
  IF admin.identity_deletion_digest(p_request) IS DISTINCT FROM p_digest THEN
    RETURN admin.refuse(v_me, 'identity_deletion', p_request::text, p_decision, 'the request differs from what you reviewed: reload and check again');
  END IF;
  BEGIN
    PERFORM admin.bind_officer(v_handle);
    v_status := compliance.decide_identity_deletion(p_request, v_handle, p_decision, p_reason);
    PERFORM admin.unbind_officer(v_handle);
  EXCEPTION WHEN SQLSTATE '23514' OR SQLSTATE '23505' OR SQLSTATE '42501' OR SQLSTATE '22023' OR SQLSTATE 'P0002' THEN
    RETURN admin.refuse(v_me, 'identity_deletion', p_request::text, p_decision, SQLERRM);
  END;
  PERFORM admin.audit_append(v_me::text, 'compliance.decided', jsonb_build_object('kind', 'identity_deletion', 'ref', p_request, 'action', p_decision,
    'result', v_status, 'digest', encode(p_digest, 'hex')));
  RETURN jsonb_build_object('ok', true, 'status', v_status);
END $$;

/** Makers and checkers of operations only (property managers, trustee and tax officers read operations but not payout accounts). */
CREATE FUNCTION admin.require_payee_desk(p_session bytea) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'operations.read');
BEGIN
  IF NOT (admin.has_permission(p_session, 'operations.request') OR admin.has_permission(p_session, 'operations.decide')) THEN
    RAISE EXCEPTION 'operations makers and checkers only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN v_me;
END $$;

CREATE FUNCTION admin.assisted_payee_digest(p_id bigint) RETURNS bytea
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
  SELECT sha256(convert_to('pt-assisted-payee-v1' || jsonb_build_array(q.id, q.subject_id, encode(q.iban_hash, 'hex'), q.iban_last4, q.bank_code,
           q.reason, q.requested_by, q.status, admin.utc(q.requested_at))::text, 'UTF8'))
  FROM bank.assisted_payee_requests q WHERE q.id = p_id
$$;

CREATE FUNCTION admin.assisted_payees(p_session bytea) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require_payee_desk(p_session);
BEGIN
  RETURN jsonb_build_object(
    'canRequest', admin.has_permission(p_session, 'operations.request'),
    'requests', coalesce((SELECT jsonb_agg(jsonb_build_object('id', q.id, 'ref', left(replace(q.subject_id::text, '-', ''), 8),
        'last4', q.iban_last4, 'bankCode', q.bank_code,
        'status', CASE WHEN q.status = 'open' AND q.expires_at < clock_timestamp() THEN 'expired' ELSE q.status END,
        'requestedBy', q.requested_by, 'requestedAt', admin.utc(q.requested_at), 'decidedBy', q.decided_by, 'decidedAt', admin.utc(q.decided_at)) ORDER BY q.id DESC)
      FROM (SELECT * FROM bank.assisted_payee_requests ORDER BY id DESC LIMIT 200) q), '[]'::jsonb));
END $$;

CREATE FUNCTION admin.assisted_payee(p_session bytea, p_id bigint) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require_payee_desk(p_session);
  v_handle text := admin.handle_of(v_me);
  q bank.assisted_payee_requests;
  cur bank.payees;
  v text[] := '{}';
  a text[] := '{}';
BEGIN
  SELECT * INTO q FROM bank.assisted_payee_requests WHERE id = p_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO cur FROM bank.payees WHERE subject_id = q.subject_id AND superseded_at IS NULL;
  IF NOT admin.has_permission(p_session, 'operations.decide') THEN v := v || 'Only an operations checker approves payout-account changes.'::text; END IF;
  IF q.status <> 'open' THEN v := v || format('The request is %s.', q.status); END IF;
  IF q.status = 'open' AND q.expires_at < clock_timestamp() THEN v := v || 'The request is older than 24 hours: enter it again.'::text; END IF;
  IF q.requested_by = v_handle THEN v := v || 'You entered this account: a different operations checker approves it (maker-checker).'::text; END IF;
  IF kyc.subject_status(q.subject_id) <> 'verified' THEN
    a := a || format('The investor is not KYC-verified (%s): no payout account can be registered.', kyc.subject_status(q.subject_id));
  END IF;
  RETURN jsonb_build_object(
    'id', q.id, 'last4', q.iban_last4, 'bankCode', q.bank_code, 'reason', q.reason,
    'requestedBy', q.requested_by, 'requestedAt', admin.utc(q.requested_at), 'expiresAt', admin.utc(q.expires_at), 'status', q.status,
    'decidedBy', q.decided_by, 'decisionReason', q.decision_reason, 'decidedAt', admin.utc(q.decided_at),
    'payee', (SELECT jsonb_build_object('id', p.id, 'activeFrom', admin.utc(p.active_from)) FROM bank.payees p WHERE p.id = q.payee_id),
    'current', CASE WHEN cur.id IS NULL THEN NULL ELSE jsonb_build_object('last4', cur.iban_last4, 'bankCode', cur.bank_code, 'since', admin.utc(cur.registered_at)) END,
    'subject', admin.subject_json(q.subject_id),
    'digest', encode(admin.assisted_payee_digest(q.id), 'hex'),
    'blockers', to_jsonb(v), 'approveBlockers', to_jsonb(a));
END $$;

/** AP-1 maker: a one-time ticket for the bank service (the portal keeps only its hash for the call). */
CREATE FUNCTION admin.assisted_payee_ticket(p_session bytea, p_ref text, p_reason text, p_token_hash bytea) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'operations.request');
  v_handle text := admin.handle_of(v_me);
  v_ref text := lower(btrim(coalesce(p_ref, '')));
  v_subjects uuid[];
  v_now timestamptz := date_trunc('microseconds', clock_timestamp());
BEGIN
  PERFORM admin.require_step_up(p_session);
  PERFORM admin.check_text(p_reason, 10, 500);
  IF p_token_hash IS NULL OR length(p_token_hash) <> 32 THEN
    RETURN admin.refuse(v_me, 'assisted_payee', 'new', 'request', 'ticket hash must be 32 bytes');
  END IF;
  IF v_ref !~ '^[0-9a-f]{8}$' THEN
    RETURN admin.refuse(v_me, 'assisted_payee', 'new', 'request', 'the investor reference is 8 characters, 0-9 and a-f');
  END IF;
  SELECT array_agg(x.id) INTO v_subjects FROM kyc.subjects x WHERE left(replace(x.id::text, '-', ''), 8) = v_ref;
  IF coalesce(cardinality(v_subjects), 0) <> 1 THEN
    RETURN admin.refuse(v_me, 'assisted_payee', v_ref, 'request', 'no single investor has this reference');
  END IF;
  IF kyc.subject_status(v_subjects[1]) <> 'verified' THEN
    RETURN admin.refuse(v_me, 'assisted_payee', v_ref, 'request', 'only a KYC-verified investor can register a payout account');
  END IF;
  IF EXISTS (SELECT 1 FROM bank.assisted_payee_requests WHERE subject_id = v_subjects[1] AND status = 'open' AND expires_at > clock_timestamp()) THEN
    RETURN admin.refuse(v_me, 'assisted_payee', v_ref, 'request', 'an assisted change for this investor is already waiting for a decision');
  END IF;
  BEGIN
    PERFORM admin.bind_officer(v_handle);
    INSERT INTO bank.assist_tickets (token_hash, subject_id, handle, reason, created_at, expires_at)
    VALUES (p_token_hash, v_subjects[1], v_handle, btrim(p_reason), v_now, v_now + interval '2 minutes');
    PERFORM admin.unbind_officer(v_handle);
  EXCEPTION WHEN SQLSTATE '23514' OR SQLSTATE '23505' THEN
    RETURN admin.refuse(v_me, 'assisted_payee', v_ref, 'request', SQLERRM);
  END;
  PERFORM admin.audit_append(v_me::text, 'operations.requested', jsonb_build_object('kind', 'assisted_payee', 'ref', v_ref, 'action', 'ticket'));
  RETURN jsonb_build_object('ok', true, 'ref', v_ref);
END $$;

CREATE FUNCTION admin.decide_assisted_payee(p_session bytea, p_request bigint, p_decision text, p_reason text, p_digest bytea) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'operations.decide');
  v_handle text := admin.handle_of(v_me);
  v_status text;
BEGIN
  PERFORM admin.require_step_up(p_session);
  PERFORM admin.check_decision(p_decision, p_reason);
  IF NOT EXISTS (SELECT 1 FROM bank.assisted_payee_requests WHERE id = p_request) THEN
    RETURN admin.refuse(v_me, 'assisted_payee', p_request::text, p_decision, 'unknown assisted payee request');
  END IF;
  IF admin.assisted_payee_digest(p_request) IS DISTINCT FROM p_digest THEN
    RETURN admin.refuse(v_me, 'assisted_payee', p_request::text, p_decision, 'the request differs from what you reviewed: reload and check again');
  END IF;
  BEGIN
    PERFORM admin.bind_officer(v_handle);
    v_status := bank.decide_assisted_payee(p_request, v_handle, p_decision, p_reason);
    PERFORM admin.unbind_officer(v_handle);
  EXCEPTION WHEN SQLSTATE '23514' OR SQLSTATE '23505' OR SQLSTATE '42501' OR SQLSTATE '22023' OR SQLSTATE 'P0002' THEN
    RETURN admin.refuse(v_me, 'assisted_payee', p_request::text, p_decision, SQLERRM);
  END;
  PERFORM admin.audit_append(v_me::text, 'operations.decided', jsonb_build_object('kind', 'assisted_payee', 'ref', p_request, 'action', p_decision,
    'result', v_status, 'digest', encode(p_digest, 'hex')));
  RETURN jsonb_build_object('ok', true, 'status', v_status);
END $$;

-- ================================================================== privileges
REVOKE ALL ON compliance.identity_deletions, bank.assist_tickets, bank.assisted_payee_requests FROM PUBLIC;
REVOKE ALL ON FUNCTION
  compliance.guard_identity_deletion(), compliance.units_held(text), compliance.deletion_problem(text, text), compliance.expire_identity_deletions(text),
  compliance.request_identity_deletion(text, text, text), compliance.decide_identity_deletion(bigint, text, text, text),
  bank.guard_assist_ticket(), bank.guard_assisted_payee_request(), bank.expire_assisted_payees(text), bank.assist_ticket_subject(bytea),
  bank.request_assisted_payee(bytea, bytea, bytea, text, text, bytea), bank.decide_assisted_payee(bigint, text, text, text),
  admin.offboarding(bytea), admin.identity_deletion_digest(bigint), admin.identity_deletion(bytea, bigint),
  admin.request_identity_deletion(bytea, text, text), admin.decide_identity_deletion(bytea, bigint, text, text, bytea),
  admin.require_payee_desk(bytea), admin.assisted_payee_digest(bigint), admin.assisted_payees(bytea), admin.assisted_payee(bytea, bigint),
  admin.assisted_payee_ticket(bytea, text, text, bytea), admin.decide_assisted_payee(bytea, bigint, text, text, bytea)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  admin.offboarding(bytea),
  admin.identity_deletion(bytea, bigint),
  admin.request_identity_deletion(bytea, text, text),
  admin.decide_identity_deletion(bytea, bigint, text, text, bytea),
  admin.assisted_payees(bytea),
  admin.assisted_payee(bytea, bigint),
  admin.assisted_payee_ticket(bytea, text, text, bytea),
  admin.decide_assisted_payee(bytea, bigint, text, text, bytea)
TO pt_admin_portal;
-- The bank service's payout-account API redeems the tickets (AP-2).
GRANT EXECUTE ON FUNCTION bank.assist_ticket_subject(bytea), bank.request_assisted_payee(bytea, bytea, bytea, text, text, bytea) TO pt_bank_service;

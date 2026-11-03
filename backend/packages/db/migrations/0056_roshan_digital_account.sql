-- Roshan Digital Account investors (spec S-08, owner approval 2026-11-04). Applies on top of 0055.
--
--   RD-1  kyc.residency: append-only residency of an investor (resident with a CNIC, or
--         non-resident with a NICOP or a POC and the country of residence, never 586). The latest
--         row counts. Recorded by the KYC service (kyc.record_residency).
--   RD-2  A non-resident is high risk: kyc.subject_status() reads 'review' for a verified
--         non-resident until two different compliance officers approved the review of their latest
--         residency (compliance.residency_reviews; propose -> confirm, or reject = kyc.revoke).
--   RD-3  bank.book_credit: a credit for a non-resident from anything but their own registered RDA
--         goes to suspense ("a non-resident investor pays from their Roshan Digital Account").
--   RD-4  bank.active_payee(): for a non-resident only an active RDA account counts, so every
--         payout path (batches, held lines, follow-ups, transfers, exit) holds the line instead.
--   RD-5  bank.payees.account_kind ('domestic' | 'rda', from the bank's account inquiry): a
--         non-resident can only register an RDA (bank.register_payee with the kind; the old
--         7-argument form registers a domestic account). Assisted changes carry the kind too.
--   RD-9  A change of residency to non-resident opens a new review; history is append-only.

-- ================================================================== RD-1 residency
CREATE TABLE kyc.residency (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subject_id   uuid NOT NULL REFERENCES kyc.subjects (id),
  status       text NOT NULL CHECK (status IN ('resident', 'non_resident')),
  document     text NOT NULL CHECK (document IN ('cnic', 'nicop', 'poc')),
  -- ISO 3166-1 numeric country of residence; NULL for a resident.
  country      smallint CHECK (country BETWEEN 1 AND 999 AND country <> 586),
  recorded_by  text NOT NULL CHECK (length(recorded_by) BETWEEN 1 AND 100),
  recorded_at  timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  CHECK ((status = 'resident') = (document = 'cnic')),
  CHECK ((status = 'non_resident') = (country IS NOT NULL))
);
CREATE INDEX residency_subject_idx ON kyc.residency (subject_id, id DESC);
CREATE TRIGGER residency_append_only BEFORE UPDATE OR DELETE ON kyc.residency FOR EACH ROW EXECUTE FUNCTION compliance.forbid_change();
CREATE TRIGGER residency_no_truncate BEFORE TRUNCATE ON kyc.residency FOR EACH STATEMENT EXECUTE FUNCTION compliance.forbid_change();

/** The latest residency of an investor (NULL = never recorded: a resident with a CNIC). */
CREATE FUNCTION kyc.current_residency(p_subject uuid) RETURNS kyc.residency
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, kyc AS $$
  SELECT r.* FROM kyc.residency r WHERE r.subject_id = p_subject ORDER BY r.id DESC LIMIT 1
$$;

CREATE FUNCTION kyc.is_non_resident(p_subject uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, kyc AS $$
  SELECT coalesce((SELECT r.status = 'non_resident' FROM kyc.residency r WHERE r.subject_id = p_subject ORDER BY r.id DESC LIMIT 1), false)
$$;

-- ================================================================== RD-2 residency reviews
CREATE TABLE compliance.residency_reviews (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subject_id       uuid NOT NULL REFERENCES kyc.subjects (id),
  residency_id     bigint NOT NULL UNIQUE REFERENCES kyc.residency (id),
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'proposed', 'approved', 'rejected', 'superseded')),
  opened_at        timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  proposed_by      text CHECK (length(proposed_by) BETWEEN 2 AND 100),
  proposal_reason  text CHECK (proposal_reason IS NULL OR compliance.free_text_ok(proposal_reason, 10, 500)),
  decided_by       text CHECK (length(decided_by) BETWEEN 2 AND 100),
  decision_reason  text CHECK (decision_reason IS NULL OR compliance.free_text_ok(decision_reason, 10, 500)),
  decided_at       timestamptz,
  -- Maker-checker in the table: an approval names a proposer and a different decider.
  CHECK (status <> 'approved' OR (proposed_by IS NOT NULL AND decided_by IS NOT NULL AND decided_by <> proposed_by)),
  CHECK ((status = 'proposed') = (proposed_by IS NOT NULL AND decided_by IS NULL)),
  CHECK ((status IN ('approved', 'rejected')) = (decided_by IS NOT NULL AND decision_reason IS NOT NULL AND decided_at IS NOT NULL))
);
CREATE UNIQUE INDEX residency_reviews_one_live ON compliance.residency_reviews (subject_id) WHERE status IN ('open', 'proposed');

CREATE FUNCTION compliance.guard_residency_review() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'residency reviews are never deleted' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF OLD.status IN ('approved', 'rejected', 'superseded')
     OR (NEW.id, NEW.subject_id, NEW.residency_id, NEW.opened_at) IS DISTINCT FROM (OLD.id, OLD.subject_id, OLD.residency_id, OLD.opened_at) THEN
    RAISE EXCEPTION 'residency review % is closed or its identity cannot change', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER residency_reviews_guard BEFORE UPDATE OR DELETE ON compliance.residency_reviews FOR EACH ROW EXECUTE FUNCTION compliance.guard_residency_review();
CREATE TRIGGER residency_reviews_no_truncate BEFORE TRUNCATE ON compliance.residency_reviews FOR EACH STATEMENT EXECUTE FUNCTION compliance.forbid_change();
CREATE TRIGGER residency_reviews_officer_binding BEFORE UPDATE ON compliance.residency_reviews
  FOR EACH ROW EXECUTE FUNCTION compliance.bind_actor('proposed_by', 'proposed_by', 'decided_by');

/** RD-2: two officers approved the review of the investor's latest residency (true for a resident). */
CREATE FUNCTION kyc.residency_cleared(p_subject uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, kyc AS $$
  SELECT CASE WHEN NOT kyc.is_non_resident(p_subject) THEN true
              ELSE EXISTS (SELECT 1 FROM compliance.residency_reviews v
                           WHERE v.residency_id = (kyc.current_residency(p_subject)).id AND v.status = 'approved') END
$$;

-- 0019 derivation (suspended under a compliance hold) plus RD-2.
CREATE OR REPLACE FUNCTION kyc.subject_status(p_subject uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, kyc AS $$
  SELECT CASE WHEN u.st IN ('verified', 'expired')
                   AND EXISTS (SELECT 1 FROM compliance.holds h WHERE h.subject_id = p_subject AND h.lifted_at IS NULL)
              THEN 'suspended'
              WHEN u.st = 'verified' AND NOT kyc.residency_cleared(p_subject) THEN 'review'
              ELSE u.st END
  FROM (SELECT kyc.underlying_status(p_subject) AS st) u
$$;

/** RD-1, RD-9 (KYC service): records a residency when it differs from the latest; a move abroad opens a review. */
CREATE FUNCTION kyc.record_residency(p_subject uuid, p_status text, p_document text, p_country smallint, p_actor text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, kyc AS $$
DECLARE
  cur kyc.residency;
  v_id bigint;
BEGIN
  IF p_subject IS NULL OR NOT EXISTS (SELECT 1 FROM kyc.subjects WHERE id = p_subject) THEN
    RAISE EXCEPTION 'unknown subject' USING ERRCODE = 'no_data_found';
  END IF;
  IF p_actor IS NULL OR length(p_actor) NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'actor is required' USING ERRCODE = 'check_violation'; END IF;
  PERFORM pg_advisory_xact_lock(586586092, hashtext(p_subject::text));
  cur := kyc.current_residency(p_subject);
  IF cur.id IS NOT NULL AND (cur.status, cur.document, cur.country) IS NOT DISTINCT FROM (p_status, p_document, p_country) THEN RETURN cur.id; END IF;
  IF cur.id IS NULL AND p_status = 'resident' THEN RETURN NULL; END IF;  -- nothing to record: a resident by default
  INSERT INTO kyc.residency (subject_id, status, document, country, recorded_by) VALUES (p_subject, p_status, p_document, p_country, p_actor)
  RETURNING id INTO v_id;
  UPDATE compliance.residency_reviews SET status = 'superseded' WHERE subject_id = p_subject AND status IN ('open', 'proposed');
  IF p_status = 'non_resident' THEN
    INSERT INTO compliance.residency_reviews (subject_id, residency_id) VALUES (p_subject, v_id);
    PERFORM compliance.audit_append(p_actor, 'residency.review_opened', jsonb_build_object('subject', p_subject, 'residency', v_id,
      'document', p_document, 'country', p_country));
  END IF;
  PERFORM kyc.audit_append(p_actor, 'residency.recorded', jsonb_build_object('subject', p_subject, 'residency', v_id, 'status', p_status,
    'document', p_document, 'country', p_country));
  RETURN v_id;
END $$;

/** RD-2: propose (open -> proposed), confirm (proposed -> approved, a different officer), decline (proposed -> open), reject (revokes). */
CREATE FUNCTION compliance.residency_act(p_review bigint, p_actor text, p_action text, p_reason text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, compliance AS $$
DECLARE
  v compliance.residency_reviews;
  v_to text;
BEGIN
  IF p_action IS NULL OR p_action NOT IN ('propose', 'confirm', 'decline', 'reject') THEN
    RAISE EXCEPTION 'action must be propose, confirm, decline or reject' USING ERRCODE = 'check_violation';
  END IF;
  IF p_actor IS NULL OR length(p_actor) NOT BETWEEN 2 AND 100 OR NOT compliance.free_text_ok(p_reason, 10, 500) THEN
    RAISE EXCEPTION 'a reason of 10 to 500 characters is required (never a CNIC, IBAN or phone number)' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v FROM compliance.residency_reviews WHERE id = p_review FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown residency review' USING ERRCODE = 'no_data_found'; END IF;
  IF p_action = 'propose' AND v.status = 'open' THEN
    UPDATE compliance.residency_reviews SET status = 'proposed', proposed_by = p_actor, proposal_reason = btrim(p_reason) WHERE id = v.id;
    v_to := 'proposed';
  ELSIF p_action IN ('confirm', 'decline') AND v.status = 'proposed' THEN
    IF v.proposed_by = p_actor THEN
      RAISE EXCEPTION 'maker-checker: the officer who proposed the approval cannot % it', p_action USING ERRCODE = 'check_violation';
    END IF;
    IF p_action = 'confirm' THEN
      UPDATE compliance.residency_reviews SET status = 'approved', decided_by = p_actor, decision_reason = btrim(p_reason), decided_at = clock_timestamp()
      WHERE id = v.id;
      v_to := 'approved';
    ELSE
      UPDATE compliance.residency_reviews SET status = 'open', proposed_by = NULL, proposal_reason = NULL WHERE id = v.id;
      v_to := 'open';
    END IF;
  ELSIF p_action = 'reject' AND v.status IN ('open', 'proposed') THEN
    UPDATE compliance.residency_reviews SET status = 'rejected', decided_by = p_actor, decision_reason = btrim(p_reason), decided_at = clock_timestamp()
    WHERE id = v.id;
    PERFORM kyc.revoke(v.subject_id, p_actor, 'non-resident review rejected: ' || btrim(p_reason));
    v_to := 'rejected';
  ELSE
    RAISE EXCEPTION 'cannot % a review that is %', p_action, v.status USING ERRCODE = 'check_violation';
  END IF;
  PERFORM compliance.audit_append(p_actor, 'residency.' || p_action, jsonb_build_object('review', v.id, 'subject', v.subject_id, 'from', v.status,
    'to', v_to, 'reason', btrim(p_reason)));
  RETURN v_to;
END $$;

-- ================================================================== RD-5 payout account kind
ALTER TABLE bank.payees ADD COLUMN account_kind text NOT NULL DEFAULT 'domestic' CHECK (account_kind IN ('domestic', 'rda'));
ALTER TABLE bank.assisted_payee_requests ADD COLUMN account_kind text NOT NULL DEFAULT 'domestic' CHECK (account_kind IN ('domestic', 'rda'));

CREATE OR REPLACE FUNCTION bank.guard_payee() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payout accounts are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.superseded_at IS NOT NULL OR NEW.superseded_at IS NULL
     OR (NEW.id, NEW.subject_id, NEW.iban_hash, NEW.iban_enc, NEW.iban_last4, NEW.bank_code, NEW.registered_at, NEW.active_from, NEW.registered_by, NEW.account_kind)
        IS DISTINCT FROM (OLD.id, OLD.subject_id, OLD.iban_hash, OLD.iban_enc, OLD.iban_last4, OLD.bank_code, OLD.registered_at, OLD.active_from, OLD.registered_by,
                          OLD.account_kind) THEN
    RAISE EXCEPTION 'payout account % can only be superseded, once', OLD.id USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION bank.guard_assisted_payee_request() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'assisted payee requests are never deleted' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF OLD.status <> 'open'
     OR (NEW.id, NEW.subject_id, NEW.ticket_hash, NEW.iban_hash, NEW.iban_enc, NEW.iban_last4, NEW.bank_code, NEW.title_hash, NEW.reason,
         NEW.requested_by, NEW.requested_at, NEW.expires_at, NEW.account_kind)
        IS DISTINCT FROM (OLD.id, OLD.subject_id, OLD.ticket_hash, OLD.iban_hash, OLD.iban_enc, OLD.iban_last4, OLD.bank_code, OLD.title_hash,
         OLD.reason, OLD.requested_by, OLD.requested_at, OLD.expires_at, OLD.account_kind) THEN
    RAISE EXCEPTION 'assisted payee request % can only be decided once', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

/** RD-5: the website and the bank service register with the account kind from the bank's inquiry. */
CREATE FUNCTION bank.register_payee(
  p_subject uuid, p_iban_hash bytea, p_iban_enc bytea, p_last4 text, p_bank_code text, p_title_hash bytea, p_actor text, p_kind text
) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, bank AS $$
DECLARE
  cur bank.payees;
  v_name bytea;
  v_id bigint;
  v_now timestamptz := date_trunc('microseconds', clock_timestamp());
BEGIN
  IF p_subject IS NULL OR p_iban_hash IS NULL OR p_iban_enc IS NULL OR p_last4 IS NULL OR p_bank_code IS NULL OR p_actor IS NULL THEN
    RAISE EXCEPTION 'subject, account hash, encrypted account, last four digits, bank code and actor are required' USING ERRCODE = 'check_violation';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('domestic', 'rda') THEN
    RAISE EXCEPTION 'account kind must be domestic or rda' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(586586096, hashtext(p_subject::text));
  IF kyc.subject_status(p_subject) <> 'verified' THEN
    RAISE EXCEPTION 'only a KYC-verified investor can register a payout account' USING ERRCODE = 'check_violation';
  END IF;
  IF kyc.is_non_resident(p_subject) AND p_kind <> 'rda' THEN
    RAISE EXCEPTION 'a non-resident investor registers a Roshan Digital Account as payout account' USING ERRCODE = 'check_violation';
  END IF;
  SELECT name_hash INTO v_name FROM kyc.subjects WHERE id = p_subject;
  IF p_title_hash IS DISTINCT FROM v_name THEN
    RAISE EXCEPTION 'the bank account title does not match the verified name' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO cur FROM bank.payees WHERE subject_id = p_subject AND superseded_at IS NULL;
  IF FOUND AND cur.iban_hash = p_iban_hash THEN RETURN cur.id; END IF;
  IF EXISTS (SELECT 1 FROM bank.payees WHERE iban_hash = p_iban_hash AND superseded_at IS NULL AND subject_id <> p_subject) THEN
    RAISE EXCEPTION 'this account is already the payout account of another investor' USING ERRCODE = 'unique_violation';
  END IF;
  IF cur.id IS NOT NULL THEN
    UPDATE bank.payees SET superseded_at = v_now WHERE id = cur.id;
  END IF;
  INSERT INTO bank.payees (subject_id, iban_hash, iban_enc, iban_last4, bank_code, registered_at, active_from, registered_by, account_kind)
  VALUES (p_subject, p_iban_hash, p_iban_enc, p_last4, p_bank_code, v_now, v_now + interval '72 hours', p_actor, p_kind)
  RETURNING id INTO v_id;
  PERFORM bank.audit_append(p_actor, 'payee.registered', jsonb_build_object('payee', v_id, 'subject', p_subject, 'last4', p_last4,
    'bankCode', p_bank_code, 'kind', p_kind, 'previous', cur.id, 'activeFrom', kyc.utc(v_now + interval '72 hours')));
  -- The investor must hear about every change on all channels (threat M-1).
  PERFORM pg_notify('bank_alert', json_build_object('kind', 'payee_changed', 'subject', p_subject, 'payee', v_id, 'previous', cur.id)::text);
  RETURN v_id;
END $$;

/** The 0009 form registers a domestic account (refused for a non-resident). */
CREATE OR REPLACE FUNCTION bank.register_payee(
  p_subject uuid, p_iban_hash bytea, p_iban_enc bytea, p_last4 text, p_bank_code text, p_title_hash bytea, p_actor text
) RETURNS bigint LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, bank AS $$
  SELECT bank.register_payee(p_subject, p_iban_hash, p_iban_enc, p_last4, p_bank_code, p_title_hash, p_actor, 'domestic')
$$;

/** RD-4: for a non-resident only an active RDA account counts. */
CREATE OR REPLACE FUNCTION bank.active_payee(p_subject uuid) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, bank AS $$
  SELECT id FROM bank.payees WHERE subject_id = p_subject AND superseded_at IS NULL AND active_from <= now()
    AND (account_kind = 'rda' OR NOT kyc.is_non_resident(p_subject))
$$;

/** Assisted change with the account kind (0055 AP-2, RD-5). */
CREATE FUNCTION bank.request_assisted_payee(p_token_hash bytea, p_iban_hash bytea, p_iban_enc bytea, p_last4 text, p_bank_code text, p_title_hash bytea,
                                            p_kind text)
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
  IF p_kind IS NULL OR p_kind NOT IN ('domestic', 'rda') THEN
    RAISE EXCEPTION 'account kind must be domestic or rda' USING ERRCODE = 'check_violation';
  END IF;
  IF kyc.is_non_resident(t.subject_id) AND p_kind <> 'rda' THEN
    RAISE EXCEPTION 'a non-resident investor registers a Roshan Digital Account as payout account' USING ERRCODE = 'check_violation';
  END IF;
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
                                            requested_at, expires_at, account_kind)
  VALUES (t.subject_id, t.token_hash, p_iban_hash, p_iban_enc, p_last4, p_bank_code, p_title_hash, t.reason, t.handle, v_now, v_now + interval '24 hours', p_kind)
  RETURNING id INTO v_id;
  PERFORM bank.audit_append(t.handle, 'assisted_payee.requested', jsonb_build_object('request', v_id, 'subject', t.subject_id, 'last4', p_last4,
    'bankCode', p_bank_code, 'kind', p_kind, 'reason', t.reason));
  RETURN v_id;
END $$;

/** The 0055 form stores a domestic account (refused for a non-resident). */
CREATE OR REPLACE FUNCTION bank.request_assisted_payee(p_token_hash bytea, p_iban_hash bytea, p_iban_enc bytea, p_last4 text, p_bank_code text, p_title_hash bytea)
RETURNS bigint LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, bank AS $$
  SELECT bank.request_assisted_payee(p_token_hash, p_iban_hash, p_iban_enc, p_last4, p_bank_code, p_title_hash, 'domestic')
$$;

/** 0055 AP-3 with the account kind of the request. */
CREATE OR REPLACE FUNCTION bank.decide_assisted_payee(p_request bigint, p_actor text, p_decision text, p_reason text) RETURNS text
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
    v_payee := bank.register_payee(q.subject_id, q.iban_hash, q.iban_enc, q.iban_last4, q.bank_code, q.title_hash, p_actor, q.account_kind);
  END IF;
  UPDATE bank.assisted_payee_requests SET status = CASE p_decision WHEN 'approve' THEN 'approved' ELSE 'rejected' END,
         decided_by = p_actor, decision_reason = btrim(p_reason), decided_at = clock_timestamp(), payee_id = v_payee
  WHERE id = q.id;
  PERFORM bank.audit_append(p_actor, 'assisted_payee.decided', jsonb_build_object('request', q.id, 'decision', p_decision, 'requestedBy', q.requested_by,
    'reason', btrim(p_reason), 'payee', v_payee));
  RETURN CASE p_decision WHEN 'approve' THEN 'approved' ELSE 'rejected' END;
END $$;

-- ================================================================== RD-3 money in (0015 body plus the RDA rule)
CREATE OR REPLACE FUNCTION bank.book_credit(p_event text, p jsonb, p_actor text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, bank AS $$
DECLARE
  v_ref text;
  v_amount bigint;
  v_payer bytea;
  v_code text;
  c bank.credits;
  i bank.payment_intents;
  v_status text := 'suspense';
  v_reason text;
  v_key text;
  v_account text;
  v_journal bigint;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object'
     OR jsonb_typeof(p->'raastRef') IS DISTINCT FROM 'string' OR (p->>'raastRef') !~ '^[A-Z0-9][A-Z0-9-]{3,63}$'
     OR jsonb_typeof(p->'amountPaisa') IS DISTINCT FROM 'string' OR (p->>'amountPaisa') !~ '^[1-9][0-9]{0,14}$'
     OR jsonb_typeof(p->'valueDate') IS DISTINCT FROM 'string' OR (p->>'valueDate') !~ '^\d{4}-\d{2}-\d{2}$'
     OR jsonb_typeof(p->'payerHash') IS DISTINCT FROM 'string' OR (p->>'payerHash') !~ '^[0-9a-f]{64}$'
     OR jsonb_typeof(p->'payerLast4') IS DISTINCT FROM 'string' OR (p->>'payerLast4') !~ '^[0-9]{4}$'
     OR jsonb_typeof(p->'intentCode') IS NULL
     OR (jsonb_typeof(p->'intentCode') <> 'null' AND (jsonb_typeof(p->'intentCode') <> 'string' OR (p->>'intentCode') !~ '^PT-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$')) THEN
    RAISE EXCEPTION 'malformed credit event %', p_event USING ERRCODE = 'check_violation';
  END IF;
  v_ref := p->>'raastRef';
  v_amount := (p->>'amountPaisa')::bigint;
  v_payer := decode(p->>'payerHash', 'hex');
  v_code := p->>'intentCode';

  PERFORM pg_advisory_xact_lock(586586097, hashtext(v_ref));
  SELECT * INTO c FROM bank.credits WHERE raast_ref = v_ref;
  IF FOUND THEN
    -- The bank re-sent the same transfer under a new event id.
    IF c.amount_paisa = v_amount AND c.payer_hash = v_payer THEN RETURN 'duplicate_reference'; END IF;
    PERFORM bank.audit_append(p_actor, 'credit.reference_conflict', jsonb_build_object('ref', v_ref, 'event', p_event));
    PERFORM pg_notify('bank_alert', json_build_object('kind', 'reference_conflict', 'ref', v_ref, 'event', p_event)::text);
    RETURN 'reference_conflict';
  END IF;

  IF v_code IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(586586098, hashtext(v_code));
    SELECT * INTO i FROM bank.payment_intents WHERE code = v_code;
  END IF;
  IF i.code IS NULL THEN
    v_reason := 'no valid payment code';
  ELSIF clock_timestamp() > i.expires_at THEN
    v_reason := 'payment code expired';
  ELSIF EXISTS (SELECT 1 FROM bank.intent_cancellations WHERE code = i.code) THEN
    v_reason := 'payment code cancelled';
  ELSIF v_amount <> i.amount_paisa THEN
    v_reason := 'amount differs from the payment code';
  ELSIF EXISTS (SELECT 1 FROM bank.credits WHERE intent_code = i.code AND status = 'matched') THEN
    v_reason := 'payment code already paid';
  ELSIF i.subject_id IS NOT NULL AND kyc.subject_status(i.subject_id) <> 'verified' THEN
    v_reason := 'investor is not KYC-verified';
  ELSIF i.subject_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM bank.payees WHERE subject_id = i.subject_id AND iban_hash = v_payer) THEN
    v_reason := 'paid from an account not registered to the investor';
  ELSIF i.subject_id IS NOT NULL AND kyc.is_non_resident(i.subject_id)
        AND NOT EXISTS (SELECT 1 FROM bank.payees WHERE subject_id = i.subject_id AND iban_hash = v_payer AND account_kind = 'rda') THEN
    v_reason := 'a non-resident investor pays from their Roshan Digital Account';
  ELSE
    v_status := 'matched';
    v_reason := 'matched ' || i.code;
  END IF;

  IF v_status = 'matched' THEN
    v_key := i.ledger_key;
    v_account := i.credit_account;
  ELSE
    v_key := 'bank:suspense:' || v_ref;
    v_account := 'bank:suspense';
  END IF;
  v_journal := ledger.post_journal(v_key, 'payment_in', v_reason, v_ref, p_actor, jsonb_build_array(
    jsonb_build_object('account', 'bank:trustee-escrow', 'amount', v_amount::text),
    jsonb_build_object('account', v_account, 'amount', (-v_amount)::text)));
  INSERT INTO bank.credits (raast_ref, event_id, amount_paisa, value_date, payer_hash, payer_last4, intent_code, status, reason, journal_id)
  VALUES (v_ref, p_event, v_amount, (p->>'valueDate')::date, v_payer, p->>'payerLast4', i.code, v_status, v_reason, v_journal);
  PERFORM bank.audit_append(p_actor, 'credit.booked', jsonb_build_object('ref', v_ref, 'event', p_event, 'amount', v_amount::text,
                                                                        'status', v_status, 'intent', i.code, 'journal', v_journal));
  IF v_status = 'suspense' THEN
    PERFORM pg_notify('bank_alert', json_build_object('kind', 'suspense', 'ref', v_ref, 'reason', v_reason)::text);
  END IF;
  RETURN v_status;
END $$;

-- ================================================================== portal (admin.*): residency reviews (compliance)
CREATE FUNCTION admin.residency_digest(p_id bigint) RETURNS bytea
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
  SELECT sha256(convert_to('pt-residency-review-v1' || jsonb_build_array(v.id, v.subject_id, v.residency_id, v.status, v.proposed_by, v.proposal_reason,
           r.document, r.country, admin.utc(v.opened_at))::text, 'UTF8'))
  FROM compliance.residency_reviews v JOIN kyc.residency r ON r.id = v.residency_id WHERE v.id = p_id
$$;

CREATE FUNCTION admin.residency_reviews(p_session bytea) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'compliance.read');
BEGIN
  RETURN jsonb_build_object(
    'reviews', coalesce((SELECT jsonb_agg(jsonb_build_object('id', v.id, 'ref', left(replace(v.subject_id::text, '-', ''), 8), 'status', v.status,
        'document', r.document, 'country', r.country, 'openedAt', admin.utc(v.opened_at), 'proposedBy', v.proposed_by, 'decidedBy', v.decided_by)
        ORDER BY (v.status IN ('open', 'proposed')) DESC, v.id DESC)
      FROM (SELECT * FROM compliance.residency_reviews ORDER BY id DESC LIMIT 200) v JOIN kyc.residency r ON r.id = v.residency_id), '[]'::jsonb),
    'investors', coalesce((SELECT jsonb_agg(jsonb_build_object('ref', left(replace(s.id::text, '-', ''), 8), 'status', kyc.subject_status(s.id),
        'document', (kyc.current_residency(s.id)).document, 'country', (kyc.current_residency(s.id)).country,
        'payoutKind', (SELECT p.account_kind FROM bank.payees p WHERE p.subject_id = s.id AND p.superseded_at IS NULL),
        'payoutActive', bank.active_payee(s.id) IS NOT NULL,
        'suspense', (SELECT count(*) FROM bank.credits c JOIN bank.payment_intents i ON i.code = c.intent_code
                     WHERE i.subject_id = s.id AND c.reason = 'a non-resident investor pays from their Roshan Digital Account')) ORDER BY s.created_at DESC)
      FROM kyc.subjects s WHERE kyc.is_non_resident(s.id)), '[]'::jsonb));
END $$;

CREATE FUNCTION admin.residency_review(p_session bytea, p_id bigint) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'compliance.read');
  v_handle text := admin.handle_of(v_me);
  v_decide boolean := admin.has_permission(p_session, 'compliance.decide');
  v compliance.residency_reviews;
  r kyc.residency;
  b jsonb;
  ro text[] := '{}';
BEGIN
  SELECT * INTO v FROM compliance.residency_reviews WHERE id = p_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO r FROM kyc.residency WHERE id = v.residency_id;
  IF NOT v_decide THEN ro := ro || 'Only a compliance officer decides residency reviews; your role reads them.'::text; END IF;
  b := jsonb_build_object(
    'propose', to_jsonb(ro || CASE WHEN v.status <> 'open' THEN ARRAY[format('The review is %s.', v.status)] ELSE '{}'::text[] END),
    'confirm', to_jsonb(ro || CASE WHEN v.status <> 'proposed' THEN ARRAY['Nothing is proposed yet.'] WHEN v.proposed_by = v_handle
                                   THEN ARRAY['You proposed the approval: a different compliance officer confirms (maker-checker).'] ELSE '{}'::text[] END),
    'decline', to_jsonb(ro || CASE WHEN v.status <> 'proposed' THEN ARRAY['Nothing is proposed yet.'] WHEN v.proposed_by = v_handle
                                   THEN ARRAY['You proposed the approval: a different compliance officer declines it.'] ELSE '{}'::text[] END),
    'reject', to_jsonb(ro || CASE WHEN v.status NOT IN ('open', 'proposed') THEN ARRAY[format('The review is %s.', v.status)] ELSE '{}'::text[] END));
  RETURN jsonb_build_object(
    'id', v.id, 'status', v.status, 'document', r.document, 'country', r.country, 'recordedAt', admin.utc(r.recorded_at),
    'openedAt', admin.utc(v.opened_at), 'proposedBy', v.proposed_by, 'proposalReason', v.proposal_reason,
    'decidedBy', v.decided_by, 'decisionReason', v.decision_reason, 'decidedAt', admin.utc(v.decided_at),
    'payoutKind', (SELECT p.account_kind FROM bank.payees p WHERE p.subject_id = v.subject_id AND p.superseded_at IS NULL),
    'subject', admin.subject_json(v.subject_id),
    'digest', encode(admin.residency_digest(v.id), 'hex'),
    'blockers', b);
END $$;

CREATE FUNCTION admin.residency_act(p_session bytea, p_review bigint, p_action text, p_reason text, p_digest bytea) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'compliance.decide');
  v_handle text := admin.handle_of(v_me);
  v_status text;
BEGIN
  PERFORM admin.require_step_up(p_session);
  PERFORM admin.check_text(p_reason, 10, 500);
  IF NOT EXISTS (SELECT 1 FROM compliance.residency_reviews WHERE id = p_review) THEN
    RETURN admin.refuse(v_me, 'residency', p_review::text, coalesce(p_action, '?'), 'unknown residency review');
  END IF;
  IF admin.residency_digest(p_review) IS DISTINCT FROM p_digest THEN
    RETURN admin.refuse(v_me, 'residency', p_review::text, coalesce(p_action, '?'), 'the review differs from what you reviewed: reload and check again');
  END IF;
  BEGIN
    PERFORM admin.bind_officer(v_handle);
    v_status := compliance.residency_act(p_review, v_handle, p_action, p_reason);
    PERFORM admin.unbind_officer(v_handle);
  EXCEPTION WHEN SQLSTATE '23514' OR SQLSTATE '23505' OR SQLSTATE '42501' OR SQLSTATE '22023' OR SQLSTATE 'P0002' THEN
    RETURN admin.refuse(v_me, 'residency', p_review::text, coalesce(p_action, '?'), SQLERRM);
  END;
  PERFORM admin.audit_append(v_me::text, 'compliance.decided', jsonb_build_object('kind', 'residency', 'ref', p_review, 'action', p_action,
    'result', v_status, 'digest', encode(p_digest, 'hex')));
  RETURN jsonb_build_object('ok', true, 'status', v_status);
END $$;

-- ================================================================== website: the signed-in investor's own residency
CREATE FUNCTION webnotice.residency(p_session bytea) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, webnotice AS $$
DECLARE
  s webauth.sessions := webauth.live_session(p_session);
  v_subject uuid;
  r kyc.residency;
BEGIN
  IF s.token_hash IS NULL THEN RETURN NULL; END IF;
  SELECT kyc_subject INTO v_subject FROM webdemo.investors WHERE id = s.investor_id;
  IF v_subject IS NULL THEN RETURN NULL; END IF;
  r := kyc.current_residency(v_subject);
  RETURN jsonb_build_object('status', coalesce(r.status, 'resident'), 'document', coalesce(r.document, 'cnic'), 'country', r.country,
    'payoutKind', (SELECT p.account_kind FROM bank.payees p WHERE p.subject_id = v_subject AND p.superseded_at IS NULL));
END $$;

-- ================================================================== privileges
REVOKE ALL ON kyc.residency, compliance.residency_reviews FROM PUBLIC;
REVOKE ALL ON FUNCTION
  kyc.current_residency(uuid), kyc.is_non_resident(uuid), kyc.residency_cleared(uuid),
  kyc.record_residency(uuid, text, text, smallint, text), compliance.guard_residency_review(), compliance.residency_act(bigint, text, text, text),
  bank.register_payee(uuid, bytea, bytea, text, text, bytea, text, text), bank.request_assisted_payee(bytea, bytea, bytea, text, text, bytea, text),
  admin.residency_digest(bigint), admin.residency_reviews(bytea), admin.residency_review(bytea, bigint),
  admin.residency_act(bytea, bigint, text, text, bytea), webnotice.residency(bytea)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kyc.record_residency(uuid, text, text, smallint, text) TO pt_kyc_service;
GRANT EXECUTE ON FUNCTION
  bank.register_payee(uuid, bytea, bytea, text, text, bytea, text, text),
  bank.request_assisted_payee(bytea, bytea, bytea, text, text, bytea, text)
TO pt_bank_service;
GRANT EXECUTE ON FUNCTION
  admin.residency_reviews(bytea),
  admin.residency_review(bytea, bigint),
  admin.residency_act(bytea, bigint, text, text, bytea)
TO pt_admin_portal;
GRANT EXECUTE ON FUNCTION webnotice.residency(bytea) TO pt_web;

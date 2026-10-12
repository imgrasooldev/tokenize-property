-- KYC and bank (Step 5g): identity checks, Raast payments, payout accounts and payout batches (ADR 0009).
--
-- KYC (schema kyc). Safety properties enforced by the database itself:
--   Y-1  No raw personal data. A subject is stored as HMAC-SHA256 hashes of the CNIC and of the
--        name (keys = secret peppers held by the KYC service, never by the database), the last four
--        CNIC digits, and the name encrypted by the service (AES-256-GCM, key outside the database)
--        for periodic sanctions re-screening. Provider responses are kept as SHA-256 hashes only.
--   Y-2  One subject per CNIC, whatever pepper version it was registered under (after a pepper
--        rotation the service sends the hash under every active version).
--   Y-3  The status is derived here, never taken from the caller. Verified needs a NADRA match, a
--        liveness pass with a score of at least 80 and a clear sanctions screening; for a new
--        verification all three must be less than 30 days old, and it lasts 365 days. A provider
--        error never verifies anyone and never removes a verification. A sanctions match is final.
--   Y-4  A possible sanctions match puts the subject in review. Only two different compliance
--        officers (maker-checker) can clear it as a false positive or confirm it.
--   Y-5  Subjects, hashes, wallets, checks, decisions and clearances are append-only (a clearance is
--        decided once). Every action is in a hash-chained audit log; kyc.verify_audit() re-checks it
--        and finds rows written around the API.
--   Y-6  Roles: pt_kyc_service registers subjects and records checks; pt_kyc_officer decides reviews
--        and revokes; pt_kyc_reader, the signer and the bank see the status only, never hashes.
--
-- Bank (schema bank):
--   B-1  Webhook events are recorded once by the bank's event id: the same event again is a no-op,
--        the same id with a different body is refused and raises an alarm. (Signatures, timestamps
--        and sizes are checked by the service before anything reaches the database.)
--   B-2  Every credit is booked in the ledger in the same transaction, on the trustee escrow
--        account with the Raast reference, so the bank statement reconciles line by line. A credit
--        that does not match an open payment code exactly (amount, expiry, a verified investor
--        paying from an account registered to them) goes to suspense, never to an investor.
--   B-3  A payment code is paid at most once; a Raast reference is booked at most once.
--   B-4  Payout accounts: the account title must match the verified name; an account can be the
--        current payout account of one investor only; a new or changed account becomes usable
--        72 hours after registration, and every change raises an alert. The IBAN is stored only
--        encrypted (by the service) and as a keyed hash.
--   B-5  Payout batches are maker-checker (creator <> approver), need the reconciliation gate
--        (recon.payouts_allowed()) at approval AND at submission, pay only verified investors with
--        active, unchanged accounts, must equal a finalized on-chain distribution's total, and are
--        booked in the ledger in the same transaction as their submission (the ledger refuses
--        paying an investor more than they are owed). Money back from suspense needs the gate too.
--   B-6  One live payout batch per distribution; the bank file's SHA-256 is recorded at submission.
--   B-7  Append-only records and a hash-chained audit log; bank.verify_audit() as for KYC.
--        Roles: pt_bank_service, pt_bank_operator, pt_bank_reader.
-- Amounts: bigint paisa. Timestamps inside digests are formatted in UTC (finding F-04).

CREATE SCHEMA IF NOT EXISTS kyc;
CREATE SCHEMA IF NOT EXISTS bank;
REVOKE ALL ON SCHEMA kyc, bank FROM PUBLIC;

DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['pt_kyc_service', 'pt_kyc_officer', 'pt_kyc_reader', 'pt_bank_service', 'pt_bank_operator', 'pt_bank_reader'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN', r);
    END IF;
  END LOOP;
END $$;

-- ================================================================== KYC
CREATE FUNCTION kyc.forbid_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'kyc records are append-only: % on %.% is not allowed', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE FUNCTION kyc.utc(p timestamptz) RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT to_char(p AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
$$;

-- ------------------------------------------------------------------ audit (Y-5)
CREATE TABLE kyc.audit (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at        timestamptz NOT NULL,
  actor     text NOT NULL CHECK (length(actor) BETWEEN 1 AND 100),
  action    text NOT NULL CHECK (action ~ '^[a-z][a-z_.]{2,63}$'),
  detail    jsonb NOT NULL CHECK (jsonb_typeof(detail) = 'object' AND octet_length(detail::text) <= 8192),
  prev_hash bytea NOT NULL CHECK (length(prev_hash) = 32),
  hash      bytea NOT NULL UNIQUE CHECK (length(hash) = 32)
);

CREATE FUNCTION kyc.audit_digest(p_prev bytea, p_id bigint, p_at timestamptz, p_actor text, p_action text, p_detail jsonb)
RETURNS bytea LANGUAGE sql STABLE SET search_path = pg_catalog, kyc AS $$
  SELECT sha256(p_prev || convert_to('pt-kyc-audit-v1' || jsonb_build_array(p_id, kyc.utc(p_at), p_actor, p_action, p_detail)::text, 'UTF8'))
$$;

CREATE FUNCTION kyc.audit_append(p_actor text, p_action text, p_detail jsonb)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, kyc AS $$
DECLARE
  v_prev bytea;
  v_id bigint;
  v_at timestamptz := date_trunc('microseconds', clock_timestamp());
BEGIN
  PERFORM pg_advisory_xact_lock(586586090);
  SELECT hash INTO v_prev FROM kyc.audit ORDER BY id DESC LIMIT 1;
  v_prev := coalesce(v_prev, decode(repeat('00', 32), 'hex'));
  v_id := nextval(pg_get_serial_sequence('kyc.audit', 'id'));
  INSERT INTO kyc.audit (id, at, actor, action, detail, prev_hash, hash)
  OVERRIDING SYSTEM VALUE
  VALUES (v_id, v_at, p_actor, p_action, coalesce(p_detail, '{}'::jsonb), v_prev,
          kyc.audit_digest(v_prev, v_id, v_at, p_actor, p_action, coalesce(p_detail, '{}'::jsonb)));
  RETURN v_id;
END $$;

-- ------------------------------------------------------------------ subjects (Y-1, Y-2)
CREATE TABLE kyc.subjects (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- HMAC-SHA256(pepper, normalised full name): lets the bank compare an account title without
  -- the database ever holding the name.
  name_hash      bytea NOT NULL CHECK (length(name_hash) = 32),
  -- AES-256-GCM ciphertext of the name, made by the KYC service and bound to the CNIC hash.
  name_enc       bytea NOT NULL CHECK (length(name_enc) BETWEEN 30 AND 1200),
  pepper_version smallint NOT NULL CHECK (pepper_version BETWEEN 1 AND 999),
  cnic_last4     text NOT NULL CHECK (cnic_last4 ~ '^[0-9]{4}$'),
  created_at     timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  created_by     text NOT NULL CHECK (length(created_by) BETWEEN 1 AND 100)
);

CREATE TABLE kyc.cnic_hashes (
  cnic_hash      bytea PRIMARY KEY CHECK (length(cnic_hash) = 32),
  pepper_version smallint NOT NULL CHECK (pepper_version BETWEEN 1 AND 999),
  subject_id     uuid NOT NULL REFERENCES kyc.subjects (id),
  UNIQUE (subject_id, pepper_version)
);

CREATE TABLE kyc.wallets (
  wallet     text PRIMARY KEY CHECK (length(wallet) = 42 AND wallet ~ '^0x[0-9a-f]+$'),
  subject_id uuid NOT NULL UNIQUE REFERENCES kyc.subjects (id),
  bound_at   timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  bound_by   text NOT NULL CHECK (length(bound_by) BETWEEN 1 AND 100)
);

-- ------------------------------------------------------------------ provider checks (Y-1, Y-3)
CREATE TABLE kyc.checks (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subject_id      uuid NOT NULL REFERENCES kyc.subjects (id),
  kind            text NOT NULL CHECK (kind IN ('nadra', 'liveness', 'sanctions')),
  outcome         text NOT NULL CHECK (outcome IN ('pass', 'fail', 'review', 'error')),
  provider        text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9-]{2,39}$'),
  provider_ref    text NOT NULL CHECK (provider_ref ~ '^[A-Za-z0-9][A-Za-z0-9:._-]{3,79}$'),
  -- A short code, never free text (no personal data): e.g. match, not_found, low_score, list_hit.
  reason          text NOT NULL CHECK (reason ~ '^[a-z][a-z0-9_]{1,39}$'),
  score           smallint CHECK (score BETWEEN 0 AND 100),
  list_version    text CHECK (list_version ~ '^[A-Za-z0-9._-]{1,40}$'),
  evidence_sha256 bytea NOT NULL CHECK (length(evidence_sha256) = 32),
  at              timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  recorded_by     text NOT NULL CHECK (length(recorded_by) BETWEEN 1 AND 100),
  UNIQUE (provider, provider_ref),
  -- Y-3: a liveness pass below 80 is impossible, whatever the caller claims.
  CHECK (kind <> 'liveness' OR outcome = 'error' OR score IS NOT NULL),
  CHECK (kind <> 'liveness' OR outcome <> 'pass' OR score >= 80),
  CHECK (kind <> 'sanctions' OR outcome = 'error' OR list_version IS NOT NULL),
  -- Only a sanctions screening can end in review (a possible match).
  CHECK (kind = 'sanctions' OR outcome <> 'review')
);
CREATE INDEX checks_subject_idx ON kyc.checks (subject_id, kind, id DESC);

CREATE TABLE kyc.decisions (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subject_id  uuid NOT NULL REFERENCES kyc.subjects (id),
  status      text NOT NULL CHECK (status IN ('pending', 'verified', 'review', 'rejected', 'revoked')),
  reason      text NOT NULL CHECK (length(reason) BETWEEN 2 AND 300),
  basis       jsonb NOT NULL CHECK (jsonb_typeof(basis) = 'object' AND octet_length(basis::text) <= 1024),
  valid_until timestamptz,
  decided_by  text NOT NULL CHECK (length(decided_by) BETWEEN 1 AND 100),
  at          timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  CHECK ((status = 'verified') = (valid_until IS NOT NULL))
);
CREATE INDEX decisions_subject_idx ON kyc.decisions (subject_id, id DESC);

-- ------------------------------------------------------------------ sanctions review, maker-checker (Y-4)
CREATE TABLE kyc.clearances (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subject_id      uuid NOT NULL REFERENCES kyc.subjects (id),
  check_id        bigint NOT NULL REFERENCES kyc.checks (id),
  proposal        text NOT NULL CHECK (proposal IN ('false_positive', 'true_match')),
  requested_by    text NOT NULL CHECK (length(requested_by) BETWEEN 2 AND 100),
  reason          text NOT NULL CHECK (length(reason) BETWEEN 10 AND 500),
  requested_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at      timestamptz NOT NULL DEFAULT clock_timestamp() + interval '72 hours',
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'approved', 'rejected', 'expired')),
  decided_by      text CHECK (length(decided_by) BETWEEN 2 AND 100),
  decision_reason text CHECK (length(decision_reason) BETWEEN 10 AND 500),
  decided_at      timestamptz,
  CHECK (decided_by IS NULL OR decided_by <> requested_by),
  CHECK ((status = 'open') = (decided_at IS NULL)),
  CHECK ((status IN ('approved', 'rejected')) = (decided_by IS NOT NULL AND decision_reason IS NOT NULL))
);
CREATE UNIQUE INDEX clearances_one_open ON kyc.clearances (check_id) WHERE status = 'open';

CREATE FUNCTION kyc.guard_clearance() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'clearances are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status <> 'open' OR (NEW.id, NEW.subject_id, NEW.check_id, NEW.proposal, NEW.requested_by, NEW.reason, NEW.requested_at, NEW.expires_at)
                             IS DISTINCT FROM (OLD.id, OLD.subject_id, OLD.check_id, OLD.proposal, OLD.requested_by, OLD.reason, OLD.requested_at, OLD.expires_at) THEN
    RAISE EXCEPTION 'clearance % can only be decided once', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER clearances_guard BEFORE UPDATE OR DELETE ON kyc.clearances FOR EACH ROW EXECUTE FUNCTION kyc.guard_clearance();

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['audit', 'subjects', 'cnic_hashes', 'wallets', 'checks', 'decisions'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON kyc.%I FOR EACH ROW EXECUTE FUNCTION kyc.forbid_change()', t || '_append_only', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['audit', 'subjects', 'cnic_hashes', 'wallets', 'checks', 'decisions', 'clearances'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON kyc.%I FOR EACH STATEMENT EXECUTE FUNCTION kyc.forbid_change()', t || '_no_truncate', t);
  END LOOP;
END $$;

-- ------------------------------------------------------------------ API
/** Y-2: registers a subject; refuses a CNIC already registered under any pepper version. p_versions[1] is the current one. */
CREATE FUNCTION kyc.register_subject(p_hashes bytea[], p_versions smallint[], p_name_hash bytea, p_name_enc bytea, p_last4 text, p_actor text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, kyc AS $$
DECLARE
  v_id uuid;
  i integer;
BEGIN
  IF p_hashes IS NULL OR p_versions IS NULL OR cardinality(p_hashes) = 0 OR cardinality(p_hashes) > 10
     OR cardinality(p_hashes) <> cardinality(p_versions)
     OR array_position(p_hashes, NULL) IS NOT NULL OR array_position(p_versions, NULL) IS NOT NULL
     OR p_name_hash IS NULL OR p_name_enc IS NULL OR p_last4 IS NULL OR p_actor IS NULL THEN
    RAISE EXCEPTION 'CNIC hashes with their pepper versions, a name hash, the sealed name, the last four digits and an actor are required'
      USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(586586091);
  IF EXISTS (SELECT 1 FROM kyc.cnic_hashes WHERE cnic_hash = ANY (p_hashes)) THEN
    RAISE EXCEPTION 'this CNIC is already registered' USING ERRCODE = 'unique_violation';
  END IF;
  INSERT INTO kyc.subjects (name_hash, name_enc, pepper_version, cnic_last4, created_by)
  VALUES (p_name_hash, p_name_enc, p_versions[1], p_last4, p_actor) RETURNING id INTO v_id;
  FOR i IN 1 .. cardinality(p_hashes) LOOP
    INSERT INTO kyc.cnic_hashes (cnic_hash, pepper_version, subject_id) VALUES (p_hashes[i], p_versions[i], v_id);
  END LOOP;
  PERFORM kyc.audit_append(p_actor, 'subject.registered', jsonb_build_object('subject', v_id, 'last4', p_last4, 'pepperVersion', p_versions[1]));
  RETURN v_id;
END $$;

CREATE FUNCTION kyc.find_subject(p_hashes bytea[]) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, kyc AS $$
  SELECT subject_id FROM kyc.cnic_hashes WHERE cnic_hash = ANY (p_hashes) ORDER BY pepper_version DESC LIMIT 1
$$;

/** The sealed name and the CNIC hash it is bound to, for re-screening (KYC service only). */
CREATE FUNCTION kyc.sealed_name(p_subject uuid) RETURNS TABLE (name_enc bytea, cnic_hash bytea)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, kyc AS $$
  SELECT s.name_enc, h.cnic_hash FROM kyc.subjects s
  JOIN kyc.cnic_hashes h ON h.subject_id = s.id AND h.pepper_version = s.pepper_version
  WHERE s.id = p_subject
$$;

/** Records one provider result. The same provider reference again with the same content is a no-op. */
CREATE FUNCTION kyc.record_check(
  p_subject uuid, p_kind text, p_outcome text, p_provider text, p_ref text, p_reason text,
  p_score smallint, p_list_version text, p_evidence bytea, p_actor text
) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, kyc AS $$
DECLARE
  c kyc.checks;
  v_id bigint;
BEGIN
  IF p_subject IS NULL OR p_actor IS NULL OR p_provider IS NULL OR p_ref IS NULL THEN
    RAISE EXCEPTION 'subject, provider, provider reference and actor are required' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO c FROM kyc.checks WHERE provider = p_provider AND provider_ref = p_ref;
  IF FOUND THEN
    IF (c.subject_id, c.kind, c.outcome, c.reason, c.score, c.list_version, c.evidence_sha256)
       IS NOT DISTINCT FROM (p_subject, p_kind, p_outcome, p_reason, p_score, p_list_version, p_evidence) THEN
      RETURN c.id;
    END IF;
    RAISE EXCEPTION 'provider reference %/% was already recorded with different content', p_provider, p_ref USING ERRCODE = 'unique_violation';
  END IF;
  INSERT INTO kyc.checks (subject_id, kind, outcome, provider, provider_ref, reason, score, list_version, evidence_sha256, recorded_by)
  VALUES (p_subject, p_kind, p_outcome, p_provider, p_ref, p_reason, p_score, p_list_version, p_evidence, p_actor)
  RETURNING id INTO v_id;
  PERFORM kyc.audit_append(p_actor, 'check.recorded', jsonb_build_object('check', v_id, 'subject', p_subject, 'kind', p_kind,
                                                                        'outcome', p_outcome, 'reason', p_reason, 'score', p_score));
  RETURN v_id;
END $$;

/** Y-3: derives the subject's status from its checks and clearances. Writes a decision only when something changed. */
CREATE FUNCTION kyc.evaluate(p_subject uuid, p_actor text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, kyc AS $$
DECLARE
  cur kyc.decisions;
  n kyc.checks;
  l kyc.checks;
  s kyc.checks;
  v_clear text;
  v_status text;
  v_reason text;
  v_valid timestamptz;
  v_was_verified boolean;
  v_basis jsonb;
  v_id bigint;
BEGIN
  IF p_subject IS NULL OR p_actor IS NULL THEN
    RAISE EXCEPTION 'subject and actor are required' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(586586092, hashtext(p_subject::text));
  IF NOT EXISTS (SELECT 1 FROM kyc.subjects WHERE id = p_subject) THEN
    RAISE EXCEPTION 'unknown subject %', p_subject USING ERRCODE = 'no_data_found';
  END IF;
  SELECT * INTO cur FROM kyc.decisions WHERE subject_id = p_subject ORDER BY id DESC LIMIT 1;
  IF cur.status = 'revoked' THEN RETURN 'revoked'; END IF;
  v_was_verified := coalesce(cur.status = 'verified' AND cur.valid_until > now(), false);

  -- The latest result of each kind; provider errors are recorded but never decide anything.
  SELECT * INTO n FROM kyc.checks WHERE subject_id = p_subject AND kind = 'nadra' AND outcome <> 'error' ORDER BY id DESC LIMIT 1;
  SELECT * INTO l FROM kyc.checks WHERE subject_id = p_subject AND kind = 'liveness' AND outcome <> 'error' ORDER BY id DESC LIMIT 1;
  SELECT * INTO s FROM kyc.checks WHERE subject_id = p_subject AND kind = 'sanctions' AND outcome <> 'error' ORDER BY id DESC LIMIT 1;
  IF s.outcome = 'review' THEN
    SELECT proposal INTO v_clear FROM kyc.clearances WHERE check_id = s.id AND status = 'approved';
  END IF;
  v_basis := jsonb_build_object('nadra', n.id, 'liveness', l.id, 'sanctions', s.id, 'clearance', v_clear);

  IF EXISTS (SELECT 1 FROM kyc.checks WHERE subject_id = p_subject AND kind = 'sanctions' AND outcome = 'fail')
     OR EXISTS (SELECT 1 FROM kyc.clearances WHERE subject_id = p_subject AND status = 'approved' AND proposal = 'true_match') THEN
    v_status := 'rejected';
    v_reason := 'sanctions match (final)';
  ELSIF s.outcome = 'review' AND v_clear IS NULL THEN
    v_status := 'review';
    v_reason := 'possible sanctions match: two compliance officers must decide';
  ELSIF n.outcome = 'fail' THEN
    v_status := 'rejected';
    v_reason := format('NADRA did not confirm the identity (%s)', n.reason);
  ELSIF l.outcome = 'fail' THEN
    v_status := 'rejected';
    v_reason := format('liveness check failed (%s)', l.reason);
  ELSIF n.id IS NULL OR l.id IS NULL OR s.id IS NULL THEN
    v_status := 'pending';
    v_reason := 'waiting for: ' || concat_ws(', ', CASE WHEN n.id IS NULL THEN 'NADRA' END, CASE WHEN l.id IS NULL THEN 'liveness' END,
                                             CASE WHEN s.id IS NULL THEN 'sanctions screening' END);
  ELSIF NOT v_was_verified AND least(n.at, l.at, s.at) < now() - interval '30 days' THEN
    v_status := 'pending';
    v_reason := 'checks are older than 30 days: repeat them';
  ELSE
    v_status := 'verified';
    v_valid := CASE WHEN v_was_verified THEN cur.valid_until ELSE least(n.at, l.at, s.at) + interval '365 days' END;
    v_reason := format('NADRA match, liveness %s, sanctions clear%s', l.score,
                       CASE WHEN v_clear = 'false_positive' THEN ' (possible match cleared by two officers)' ELSE '' END);
  END IF;

  IF cur.id IS NOT NULL AND (cur.status, cur.reason, cur.valid_until) IS NOT DISTINCT FROM (v_status, v_reason, v_valid) THEN
    RETURN v_status;
  END IF;
  INSERT INTO kyc.decisions (subject_id, status, reason, basis, valid_until, decided_by)
  VALUES (p_subject, v_status, v_reason, v_basis, v_valid, p_actor) RETURNING id INTO v_id;
  PERFORM kyc.audit_append(p_actor, 'decision', jsonb_build_object('decision', v_id, 'subject', p_subject, 'status', v_status,
                                                                  'validUntil', kyc.utc(v_valid), 'basis', v_basis));
  IF cur.status = 'verified' AND v_status <> 'verified' THEN
    -- The chain side (freeze, then offboarding) must follow: see ADR 0009 and finding F-01.
    PERFORM pg_notify('kyc_alert', json_build_object('subject', p_subject, 'from', cur.status, 'to', v_status)::text);
  END IF;
  RETURN v_status;
END $$;

/** A protective action, so one officer is enough (like pausing). Final. */
CREATE FUNCTION kyc.revoke(p_subject uuid, p_officer text, p_reason text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, kyc AS $$
DECLARE
  cur kyc.decisions;
  v_id bigint;
BEGIN
  IF p_subject IS NULL OR p_officer IS NULL OR length(p_officer) NOT BETWEEN 2 AND 100 OR p_reason IS NULL OR length(p_reason) NOT BETWEEN 10 AND 300 THEN
    RAISE EXCEPTION 'a subject, an officer and a reason of 10 to 300 characters are required' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(586586092, hashtext(p_subject::text));
  IF NOT EXISTS (SELECT 1 FROM kyc.subjects WHERE id = p_subject) THEN
    RAISE EXCEPTION 'unknown subject %', p_subject USING ERRCODE = 'no_data_found';
  END IF;
  SELECT * INTO cur FROM kyc.decisions WHERE subject_id = p_subject ORDER BY id DESC LIMIT 1;
  IF cur.status = 'revoked' THEN RETURN false; END IF;
  INSERT INTO kyc.decisions (subject_id, status, reason, basis, decided_by)
  VALUES (p_subject, 'revoked', p_reason, '{}'::jsonb, p_officer) RETURNING id INTO v_id;
  PERFORM kyc.audit_append(p_officer, 'decision', jsonb_build_object('decision', v_id, 'subject', p_subject, 'status', 'revoked',
                                                                    'validUntil', NULL, 'basis', '{}'::jsonb));
  PERFORM pg_notify('kyc_alert', json_build_object('subject', p_subject, 'from', cur.status, 'to', 'revoked')::text);
  RETURN true;
END $$;

/** Y-4 maker: proposes how to settle a possible sanctions match. */
CREATE FUNCTION kyc.request_clearance(p_check bigint, p_officer text, p_proposal text, p_reason text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, kyc AS $$
DECLARE
  c kyc.checks;
  v_id bigint;
BEGIN
  IF p_proposal IS NULL OR p_proposal NOT IN ('false_positive', 'true_match') THEN
    RAISE EXCEPTION 'proposal must be false_positive or true_match' USING ERRCODE = 'check_violation';
  END IF;
  IF p_officer IS NULL OR length(p_officer) NOT BETWEEN 2 AND 100 OR p_reason IS NULL OR length(p_reason) NOT BETWEEN 10 AND 500 THEN
    RAISE EXCEPTION 'an officer and a reason of 10 to 500 characters are required' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO c FROM kyc.checks WHERE id = p_check;
  IF NOT FOUND OR c.kind <> 'sanctions' OR c.outcome <> 'review' THEN
    RAISE EXCEPTION 'check % is not a sanctions screening in review', p_check USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM kyc.checks WHERE subject_id = c.subject_id AND kind = 'sanctions' AND outcome <> 'error' AND id > c.id) THEN
    RAISE EXCEPTION 'check % is no longer the latest sanctions screening of its subject', p_check USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(586586093);
  UPDATE kyc.clearances SET status = 'expired', decided_at = clock_timestamp() WHERE status = 'open' AND expires_at < now();
  IF EXISTS (SELECT 1 FROM kyc.clearances WHERE check_id = p_check AND status IN ('open', 'approved')) THEN
    RAISE EXCEPTION 'check % already has an open or approved clearance', p_check USING ERRCODE = 'unique_violation';
  END IF;
  INSERT INTO kyc.clearances (subject_id, check_id, proposal, requested_by, reason)
  VALUES (c.subject_id, p_check, p_proposal, p_officer, p_reason) RETURNING id INTO v_id;
  PERFORM kyc.audit_append(p_officer, 'clearance.requested', jsonb_build_object('clearance', v_id, 'check', p_check, 'subject', c.subject_id,
                                                                               'proposal', p_proposal, 'reason', p_reason));
  RETURN v_id;
END $$;

/** Y-4 checker: a different officer approves or rejects. Approval re-evaluates the subject. */
CREATE FUNCTION kyc.decide_clearance(p_request bigint, p_officer text, p_decision text, p_reason text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, kyc AS $$
DECLARE
  q kyc.clearances;
BEGIN
  IF p_decision IS NULL OR p_decision NOT IN ('approve', 'reject') THEN
    RAISE EXCEPTION 'decision must be approve or reject' USING ERRCODE = 'check_violation';
  END IF;
  IF p_officer IS NULL OR length(p_officer) NOT BETWEEN 2 AND 100 OR p_reason IS NULL OR length(p_reason) NOT BETWEEN 10 AND 500 THEN
    RAISE EXCEPTION 'an officer and a reason of 10 to 500 characters are required' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(586586093);
  SELECT * INTO q FROM kyc.clearances WHERE id = p_request FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown clearance %', p_request USING ERRCODE = 'no_data_found'; END IF;
  IF q.status <> 'open' THEN RETURN q.status; END IF;
  IF q.requested_by = p_officer THEN
    RAISE EXCEPTION 'maker-checker: the requester cannot decide their own clearance' USING ERRCODE = 'check_violation';
  END IF;
  IF q.expires_at < now() OR EXISTS (SELECT 1 FROM kyc.checks WHERE subject_id = q.subject_id AND kind = 'sanctions' AND outcome <> 'error' AND id > q.check_id) THEN
    UPDATE kyc.clearances SET status = 'expired', decided_at = clock_timestamp() WHERE id = q.id;
    PERFORM kyc.audit_append(p_officer, 'clearance.expired', jsonb_build_object('clearance', q.id));
    RETURN 'expired';
  END IF;
  UPDATE kyc.clearances SET status = CASE WHEN p_decision = 'approve' THEN 'approved' ELSE 'rejected' END,
         decided_by = p_officer, decision_reason = p_reason, decided_at = clock_timestamp()
  WHERE id = q.id;
  PERFORM kyc.audit_append(p_officer, 'clearance.' || CASE WHEN p_decision = 'approve' THEN 'approved' ELSE 'rejected' END,
                           jsonb_build_object('clearance', q.id, 'requestedBy', q.requested_by, 'proposal', q.proposal, 'reason', p_reason));
  IF p_decision = 'approve' THEN
    PERFORM kyc.evaluate(q.subject_id, p_officer);
    RETURN 'approved';
  END IF;
  RETURN 'rejected';
END $$;

/** The status a gate may rely on. A verification past its validity reads as expired. */
CREATE FUNCTION kyc.subject_status(p_subject uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, kyc AS $$
  SELECT CASE
    WHEN NOT EXISTS (SELECT 1 FROM kyc.subjects WHERE id = p_subject) THEN 'unknown'
    ELSE coalesce((SELECT CASE WHEN d.status = 'verified' AND d.valid_until <= now() THEN 'expired' ELSE d.status END
                   FROM kyc.decisions d WHERE d.subject_id = p_subject ORDER BY d.id DESC LIMIT 1), 'pending')
  END
$$;

/** Gate for the registrar and other services: is this wallet's owner verified now? */
CREATE FUNCTION kyc.is_verified(p_wallet text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, kyc AS $$
  SELECT coalesce((SELECT kyc.subject_status(w.subject_id) = 'verified' FROM kyc.wallets w WHERE w.wallet = lower(p_wallet)), false)
$$;

/** Binds the investor's wallet (once). Only a verified subject can bind one. */
CREATE FUNCTION kyc.bind_wallet(p_subject uuid, p_wallet text, p_actor text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, kyc AS $$
DECLARE
  w kyc.wallets;
  v_wallet text := lower(p_wallet);
BEGIN
  IF p_subject IS NULL OR p_wallet IS NULL OR p_actor IS NULL THEN
    RAISE EXCEPTION 'subject, wallet and actor are required' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(586586092, hashtext(p_subject::text));
  SELECT * INTO w FROM kyc.wallets WHERE subject_id = p_subject OR wallet = v_wallet LIMIT 1;
  IF FOUND THEN
    IF w.subject_id = p_subject AND w.wallet = v_wallet THEN RETURN false; END IF;
    RAISE EXCEPTION 'the subject or the wallet is already bound (wallet changes go through recovery)' USING ERRCODE = 'unique_violation';
  END IF;
  IF kyc.subject_status(p_subject) <> 'verified' THEN
    RAISE EXCEPTION 'only a verified subject can bind a wallet' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO kyc.wallets (wallet, subject_id, bound_by) VALUES (v_wallet, p_subject, p_actor);
  PERFORM kyc.audit_append(p_actor, 'wallet.bound', jsonb_build_object('wallet', v_wallet, 'subject', p_subject));
  RETURN true;
END $$;

/** Status without hashes: what readers and dashboards may see. */
CREATE VIEW kyc.status AS
SELECT s.id AS subject_id, s.cnic_last4, w.wallet, kyc.subject_status(s.id) AS status, d.reason, d.valid_until, d.at AS decided_at
FROM kyc.subjects s
LEFT JOIN kyc.wallets w ON w.subject_id = s.id
LEFT JOIN LATERAL (SELECT x.reason, x.valid_until, x.at FROM kyc.decisions x WHERE x.subject_id = s.id ORDER BY x.id DESC LIMIT 1) d ON true;

CREATE FUNCTION kyc.verify_audit() RETURNS TABLE (audit_id bigint, problem text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, kyc AS $$
DECLARE
  a kyc.audit;
  v_prev bytea := decode(repeat('00', 32), 'hex');
  d kyc.decisions;
  r record;
BEGIN
  FOR a IN SELECT * FROM kyc.audit ORDER BY id LOOP
    IF a.prev_hash <> v_prev THEN audit_id := a.id; problem := 'prev_hash does not match'; RETURN NEXT; END IF;
    IF a.hash <> kyc.audit_digest(a.prev_hash, a.id, a.at, a.actor, a.action, a.detail) THEN
      audit_id := a.id; problem := 'content does not match its hash'; RETURN NEXT;
    END IF;
    IF a.action = 'decision' THEN
      SELECT * INTO d FROM kyc.decisions WHERE id = (a.detail->>'decision')::bigint;
      IF NOT FOUND OR d.subject_id::text <> a.detail->>'subject' OR d.status <> a.detail->>'status'
         OR kyc.utc(d.valid_until) IS DISTINCT FROM a.detail->>'validUntil' THEN
        audit_id := a.id; problem := format('decision %s changed after it was made', a.detail->>'decision'); RETURN NEXT;
      END IF;
    END IF;
    v_prev := a.hash;
  END LOOP;
  -- Rows that exist without the audit entry their API function always writes: written directly.
  FOR r IN SELECT x.id::text AS id, 'subject' AS what FROM kyc.subjects x
             WHERE NOT EXISTS (SELECT 1 FROM kyc.audit y WHERE y.action = 'subject.registered' AND y.detail->>'subject' = x.id::text)
           UNION ALL
           SELECT x.id::text, 'check' FROM kyc.checks x
             WHERE NOT EXISTS (SELECT 1 FROM kyc.audit y WHERE y.action = 'check.recorded' AND (y.detail->>'check')::bigint = x.id)
           UNION ALL
           SELECT x.id::text, 'decision' FROM kyc.decisions x
             WHERE NOT EXISTS (SELECT 1 FROM kyc.audit y WHERE y.action = 'decision' AND (y.detail->>'decision')::bigint = x.id)
           UNION ALL
           SELECT x.wallet, 'wallet' FROM kyc.wallets x
             WHERE NOT EXISTS (SELECT 1 FROM kyc.audit y WHERE y.action = 'wallet.bound' AND y.detail->>'wallet' = x.wallet)
           UNION ALL
           SELECT x.id::text, 'clearance' FROM kyc.clearances x
             WHERE NOT EXISTS (SELECT 1 FROM kyc.audit y WHERE y.action = 'clearance.requested' AND (y.detail->>'clearance')::bigint = x.id)
             OR (x.status IN ('approved', 'rejected') AND NOT EXISTS (
                   SELECT 1 FROM kyc.audit y WHERE y.action = 'clearance.' || x.status AND (y.detail->>'clearance')::bigint = x.id)) LOOP
    audit_id := NULL; problem := format('%s %s has no audit entry', r.what, r.id); RETURN NEXT;
  END LOOP;
END $$;

-- ================================================================== bank
CREATE FUNCTION bank.forbid_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'bank records are append-only: % on %.% is not allowed', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END $$;

-- The trustee's escrow account at the bank (asset) and the suspense account for money that cannot
-- be attributed (liability: it is owed back to whoever sent it).
SELECT ledger.open_account('bank:trustee-escrow', 'asset', 'PKR', false);
SELECT ledger.open_account('bank:suspense', 'liability', 'PKR', false);

-- ------------------------------------------------------------------ audit (B-7)
CREATE TABLE bank.audit (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at        timestamptz NOT NULL,
  actor     text NOT NULL CHECK (length(actor) BETWEEN 1 AND 100),
  action    text NOT NULL CHECK (action ~ '^[a-z][a-z_.]{2,63}$'),
  detail    jsonb NOT NULL CHECK (jsonb_typeof(detail) = 'object' AND octet_length(detail::text) <= 8192),
  prev_hash bytea NOT NULL CHECK (length(prev_hash) = 32),
  hash      bytea NOT NULL UNIQUE CHECK (length(hash) = 32)
);

CREATE FUNCTION bank.audit_digest(p_prev bytea, p_id bigint, p_at timestamptz, p_actor text, p_action text, p_detail jsonb)
RETURNS bytea LANGUAGE sql STABLE SET search_path = pg_catalog, kyc AS $$
  SELECT sha256(p_prev || convert_to('pt-bank-audit-v1' || jsonb_build_array(p_id, kyc.utc(p_at), p_actor, p_action, p_detail)::text, 'UTF8'))
$$;

CREATE FUNCTION bank.audit_append(p_actor text, p_action text, p_detail jsonb)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, bank AS $$
DECLARE
  v_prev bytea;
  v_id bigint;
  v_at timestamptz := date_trunc('microseconds', clock_timestamp());
BEGIN
  PERFORM pg_advisory_xact_lock(586586095);
  SELECT hash INTO v_prev FROM bank.audit ORDER BY id DESC LIMIT 1;
  v_prev := coalesce(v_prev, decode(repeat('00', 32), 'hex'));
  v_id := nextval(pg_get_serial_sequence('bank.audit', 'id'));
  INSERT INTO bank.audit (id, at, actor, action, detail, prev_hash, hash)
  OVERRIDING SYSTEM VALUE
  VALUES (v_id, v_at, p_actor, p_action, coalesce(p_detail, '{}'::jsonb), v_prev,
          bank.audit_digest(v_prev, v_id, v_at, p_actor, p_action, coalesce(p_detail, '{}'::jsonb)));
  RETURN v_id;
END $$;

-- ------------------------------------------------------------------ webhook events (B-1)
CREATE TABLE bank.events (
  event_id    text PRIMARY KEY CHECK (event_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$'),
  type        text NOT NULL CHECK (type IN ('credit.received', 'payout.returned')),
  body_sha256 bytea NOT NULL CHECK (length(body_sha256) = 32),
  key_id      text NOT NULL CHECK (key_id ~ '^[a-z0-9][a-z0-9-]{0,31}$'),
  received_at timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp())
);

-- ------------------------------------------------------------------ payment codes and credits (B-2, B-3)
CREATE TABLE bank.payment_intents (
  -- What the payer enters in the Raast narration. Crockford base-32 (no I, L, O, U).
  code           text PRIMARY KEY CHECK (code ~ '^PT-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$'),
  purpose        text NOT NULL CHECK (purpose IN ('subscription', 'rent_collection')),
  subject_id     uuid REFERENCES kyc.subjects (id),
  amount_paisa   bigint NOT NULL CHECK (amount_paisa > 0 AND amount_paisa <= 1000000000000000),
  ledger_key     text NOT NULL UNIQUE CHECK (length(ledger_key) BETWEEN 8 AND 200),
  credit_account text NOT NULL REFERENCES ledger.accounts (code),
  created_at     timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  expires_at     timestamptz NOT NULL,
  created_by     text NOT NULL CHECK (length(created_by) BETWEEN 1 AND 100),
  CHECK ((purpose = 'subscription') = (subject_id IS NOT NULL)),
  CHECK (purpose <> 'subscription' OR ledger_key ~ '^sub:0x[0-9a-f]{64}:paid$'),
  CHECK (purpose <> 'rent_collection' OR ledger_key ~ '^rent:collected:0x[0-9a-f]{40}:[a-z0-9-]{1,40}$'),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '7 days')
);

CREATE TABLE bank.credits (
  raast_ref    text PRIMARY KEY CHECK (raast_ref ~ '^[A-Z0-9][A-Z0-9-]{3,63}$'),
  event_id     text NOT NULL UNIQUE REFERENCES bank.events (event_id),
  amount_paisa bigint NOT NULL CHECK (amount_paisa > 0),
  value_date   date NOT NULL,
  -- HMAC of the payer's IBAN (the IBAN itself is not kept) and its last four digits for support.
  payer_hash   bytea NOT NULL CHECK (length(payer_hash) = 32),
  payer_last4  text NOT NULL CHECK (payer_last4 ~ '^[0-9]{4}$'),
  intent_code  text REFERENCES bank.payment_intents (code),
  status       text NOT NULL CHECK (status IN ('matched', 'suspense')),
  reason       text NOT NULL CHECK (length(reason) BETWEEN 2 AND 200),
  journal_id   bigint NOT NULL UNIQUE REFERENCES ledger.journal (id),
  booked_at    timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  CHECK (status <> 'matched' OR intent_code IS NOT NULL)
);
CREATE UNIQUE INDEX credits_intent_paid_once ON bank.credits (intent_code) WHERE status = 'matched';

CREATE TABLE bank.credit_returns (
  raast_ref   text PRIMARY KEY REFERENCES bank.credits (raast_ref),
  journal_id  bigint NOT NULL UNIQUE REFERENCES ledger.journal (id),
  returned_by text NOT NULL CHECK (length(returned_by) BETWEEN 2 AND 100),
  reason      text NOT NULL CHECK (length(reason) BETWEEN 10 AND 300),
  at          timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp())
);

-- ------------------------------------------------------------------ payout accounts (B-4)
CREATE TABLE bank.payees (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subject_id    uuid NOT NULL REFERENCES kyc.subjects (id),
  iban_hash     bytea NOT NULL CHECK (length(iban_hash) = 32),
  -- AES-256-GCM ciphertext made by the bank service (key outside the database), bound to the subject.
  iban_enc      bytea NOT NULL CHECK (length(iban_enc) BETWEEN 40 AND 200),
  iban_last4    text NOT NULL CHECK (iban_last4 ~ '^[0-9]{4}$'),
  bank_code     text NOT NULL CHECK (bank_code ~ '^[A-Z]{4}$'),
  registered_at timestamptz NOT NULL,
  active_from   timestamptz NOT NULL,
  registered_by text NOT NULL CHECK (length(registered_by) BETWEEN 1 AND 100),
  superseded_at timestamptz,
  CHECK (active_from >= registered_at + interval '72 hours'),
  CHECK (superseded_at IS NULL OR superseded_at >= registered_at)
);
CREATE UNIQUE INDEX payees_one_current ON bank.payees (subject_id) WHERE superseded_at IS NULL;
CREATE UNIQUE INDEX payees_account_one_investor ON bank.payees (iban_hash) WHERE superseded_at IS NULL;
CREATE INDEX payees_subject_idx ON bank.payees (subject_id, iban_hash);

CREATE FUNCTION bank.guard_payee() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payout accounts are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.superseded_at IS NOT NULL OR NEW.superseded_at IS NULL
     OR (NEW.id, NEW.subject_id, NEW.iban_hash, NEW.iban_enc, NEW.iban_last4, NEW.bank_code, NEW.registered_at, NEW.active_from, NEW.registered_by)
        IS DISTINCT FROM (OLD.id, OLD.subject_id, OLD.iban_hash, OLD.iban_enc, OLD.iban_last4, OLD.bank_code, OLD.registered_at, OLD.active_from, OLD.registered_by) THEN
    RAISE EXCEPTION 'payout account % can only be superseded, once', OLD.id USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payees_guard BEFORE UPDATE OR DELETE ON bank.payees FOR EACH ROW EXECUTE FUNCTION bank.guard_payee();

-- ------------------------------------------------------------------ payout batches (B-5, B-6)
CREATE TABLE bank.payout_batches (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  reference       text NOT NULL UNIQUE CHECK (reference ~ '^PTPAY-[0-9A-Z-]{4,40}$'),
  token           text NOT NULL CHECK (length(token) = 42 AND token ~ '^0x[0-9a-f]+$'),
  distribution_id numeric(78,0) NOT NULL CHECK (distribution_id > 0),
  total_paisa     bigint NOT NULL CHECK (total_paisa > 0),
  item_count      integer NOT NULL CHECK (item_count BETWEEN 1 AND 50000),
  -- sha256 over the resolved items (line, subject, payee, IBAN hash, amount): what was approved.
  items_digest    bytea NOT NULL CHECK (length(items_digest) = 32),
  status          text NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'approved', 'rejected', 'submitted')),
  created_by      text NOT NULL CHECK (length(created_by) BETWEEN 2 AND 100),
  created_at      timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  decided_by      text CHECK (length(decided_by) BETWEEN 2 AND 100),
  decision_reason text CHECK (length(decision_reason) BETWEEN 10 AND 500),
  decided_at      timestamptz,
  file_sha256     bytea CHECK (length(file_sha256) = 32),
  journal_id      bigint UNIQUE REFERENCES ledger.journal (id),
  submitted_by    text CHECK (length(submitted_by) BETWEEN 1 AND 100),
  submitted_at    timestamptz,
  CHECK (decided_by IS NULL OR decided_by <> created_by),
  CHECK ((status = 'created') = (decided_by IS NULL)),
  CHECK ((status = 'submitted') = (journal_id IS NOT NULL AND file_sha256 IS NOT NULL AND submitted_at IS NOT NULL))
);
CREATE UNIQUE INDEX payout_batches_one_live ON bank.payout_batches (token, distribution_id) WHERE status <> 'rejected';

CREATE FUNCTION bank.guard_batch() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payout batches are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (NEW.id, NEW.reference, NEW.token, NEW.distribution_id, NEW.total_paisa, NEW.item_count, NEW.items_digest, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.reference, OLD.token, OLD.distribution_id, OLD.total_paisa, OLD.item_count, OLD.items_digest, OLD.created_by, OLD.created_at)
     OR NOT ((OLD.status = 'created' AND NEW.status IN ('approved', 'rejected')) OR (OLD.status = 'approved' AND NEW.status = 'submitted'))
     OR (OLD.status = 'approved' AND (NEW.decided_by, NEW.decision_reason, NEW.decided_at) IS DISTINCT FROM (OLD.decided_by, OLD.decision_reason, OLD.decided_at)) THEN
    RAISE EXCEPTION 'payout batch % cannot change from % that way', OLD.id, OLD.status USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payout_batches_guard BEFORE UPDATE OR DELETE ON bank.payout_batches FOR EACH ROW EXECUTE FUNCTION bank.guard_batch();

CREATE TABLE bank.payout_items (
  batch_id     bigint NOT NULL REFERENCES bank.payout_batches (id),
  line_no      integer NOT NULL CHECK (line_no >= 1),
  subject_id   uuid NOT NULL REFERENCES kyc.subjects (id),
  payee_id     bigint NOT NULL REFERENCES bank.payees (id),
  amount_paisa bigint NOT NULL CHECK (amount_paisa > 0),
  PRIMARY KEY (batch_id, line_no),
  UNIQUE (batch_id, subject_id)
);

CREATE TABLE bank.payout_returns (
  batch_id   bigint NOT NULL,
  line_no    integer NOT NULL,
  event_id   text NOT NULL UNIQUE REFERENCES bank.events (event_id),
  return_ref text NOT NULL UNIQUE CHECK (return_ref ~ '^[A-Z0-9][A-Z0-9-]{3,63}$'),
  reason     text NOT NULL CHECK (reason ~ '^[a-z][a-z0-9_]{1,39}$'),
  journal_id bigint NOT NULL UNIQUE REFERENCES ledger.journal (id),
  at         timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  PRIMARY KEY (batch_id, line_no),
  FOREIGN KEY (batch_id, line_no) REFERENCES bank.payout_items (batch_id, line_no)
);

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['audit', 'events', 'payment_intents', 'credits', 'credit_returns', 'payout_items', 'payout_returns'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON bank.%I FOR EACH ROW EXECUTE FUNCTION bank.forbid_change()', t || '_append_only', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['audit', 'events', 'payment_intents', 'credits', 'credit_returns', 'payees', 'payout_batches', 'payout_items', 'payout_returns'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON bank.%I FOR EACH STATEMENT EXECUTE FUNCTION bank.forbid_change()', t || '_no_truncate', t);
  END LOOP;
END $$;

-- ------------------------------------------------------------------ internal helpers
/** Refuses money out of escrow unless the reconciliation gate (ADR 0007) allows payouts right now. */
CREATE FUNCTION bank.require_gate() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, bank AS $$
DECLARE
  g record;
BEGIN
  SELECT * INTO g FROM recon.payout_gate();
  IF NOT coalesce(g.allowed, false) THEN
    RAISE EXCEPTION 'payouts are blocked by reconciliation: %', coalesce(g.reason, 'no gate answer') USING ERRCODE = 'check_violation';
  END IF;
END $$;

/** The subject's payout account that may be paid now (registered, not superseded, cooling-off over), or NULL. */
CREATE FUNCTION bank.active_payee(p_subject uuid) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, bank AS $$
  SELECT id FROM bank.payees WHERE subject_id = p_subject AND superseded_at IS NULL AND active_from <= now()
$$;

/** Why a batch's items could not be paid as approved (NULL = all fine). */
CREATE FUNCTION bank.batch_problems(p_batch bigint) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, bank AS $$
  SELECT left(string_agg(format('line %s: %s', i.line_no,
           CASE WHEN kyc.subject_status(i.subject_id) <> 'verified' THEN 'investor is ' || kyc.subject_status(i.subject_id)
                ELSE 'payout account changed or not active' END), '; ' ORDER BY i.line_no), 500)
  FROM bank.payout_items i
  WHERE i.batch_id = p_batch
    AND (kyc.subject_status(i.subject_id) <> 'verified' OR bank.active_payee(i.subject_id) IS DISTINCT FROM i.payee_id)
$$;

-- ------------------------------------------------------------------ API: payment codes, payees
CREATE FUNCTION bank.create_intent(
  p_code text, p_purpose text, p_subject uuid, p_amount bigint, p_ledger_key text, p_credit_account text, p_ttl_minutes integer, p_actor text
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, bank AS $$
DECLARE
  i bank.payment_intents;
BEGIN
  IF p_code IS NULL OR p_purpose IS NULL OR p_amount IS NULL OR p_ledger_key IS NULL OR p_credit_account IS NULL OR p_actor IS NULL
     OR p_ttl_minutes IS NULL OR p_ttl_minutes NOT BETWEEN 5 AND 10080 THEN
    RAISE EXCEPTION 'code, purpose, amount, ledger key, credit account, a lifetime of 5 minutes to 7 days and an actor are required'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO i FROM bank.payment_intents WHERE code = p_code;
  IF FOUND THEN
    IF (i.purpose, i.subject_id, i.amount_paisa, i.ledger_key, i.credit_account) IS NOT DISTINCT FROM (p_purpose, p_subject, p_amount, p_ledger_key, p_credit_account) THEN
      RETURN i.code;
    END IF;
    RAISE EXCEPTION 'payment code % already exists with different content', p_code USING ERRCODE = 'unique_violation';
  END IF;
  IF p_purpose = 'subscription' AND kyc.subject_status(p_subject) <> 'verified' THEN
    RAISE EXCEPTION 'subscription payments need a KYC-verified investor' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM ledger.accounts WHERE code = p_credit_account AND kind = 'liability' AND asset = 'PKR')
     OR p_credit_account = 'bank:suspense' THEN
    RAISE EXCEPTION 'the credit account must be an existing PKR liability account other than suspense' USING ERRCODE = 'foreign_key_violation';
  END IF;
  INSERT INTO bank.payment_intents (code, purpose, subject_id, amount_paisa, ledger_key, credit_account, expires_at, created_by)
  VALUES (p_code, p_purpose, p_subject, p_amount, p_ledger_key, p_credit_account,
          date_trunc('microseconds', clock_timestamp()) + make_interval(mins => p_ttl_minutes), p_actor);
  PERFORM bank.audit_append(p_actor, 'intent.created', jsonb_build_object('code', p_code, 'purpose', p_purpose, 'subject', p_subject,
                                                                         'amount', p_amount::text, 'ledgerKey', p_ledger_key));
  RETURN p_code;
END $$;

/** B-4: registers or changes the investor's payout account. Usable after 72 hours; every change alerts. */
CREATE FUNCTION bank.register_payee(
  p_subject uuid, p_iban_hash bytea, p_iban_enc bytea, p_last4 text, p_bank_code text, p_title_hash bytea, p_actor text
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
  PERFORM pg_advisory_xact_lock(586586096, hashtext(p_subject::text));
  IF kyc.subject_status(p_subject) <> 'verified' THEN
    RAISE EXCEPTION 'only a KYC-verified investor can register a payout account' USING ERRCODE = 'check_violation';
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
  INSERT INTO bank.payees (subject_id, iban_hash, iban_enc, iban_last4, bank_code, registered_at, active_from, registered_by)
  VALUES (p_subject, p_iban_hash, p_iban_enc, p_last4, p_bank_code, v_now, v_now + interval '72 hours', p_actor)
  RETURNING id INTO v_id;
  PERFORM bank.audit_append(p_actor, 'payee.registered', jsonb_build_object('payee', v_id, 'subject', p_subject, 'last4', p_last4,
    'bankCode', p_bank_code, 'previous', cur.id, 'activeFrom', kyc.utc(v_now + interval '72 hours')));
  -- The investor must hear about every change on all channels (threat M-1).
  PERFORM pg_notify('bank_alert', json_build_object('kind', 'payee_changed', 'subject', p_subject, 'payee', v_id, 'previous', cur.id)::text);
  RETURN v_id;
END $$;

-- ------------------------------------------------------------------ API: webhook events (B-1, B-2, B-3)
/** Books one credit. Called by bank.ingest_event only. */
CREATE FUNCTION bank.book_credit(p_event text, p jsonb, p_actor text) RETURNS text
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
  ELSIF v_amount <> i.amount_paisa THEN
    v_reason := 'amount differs from the payment code';
  ELSIF EXISTS (SELECT 1 FROM bank.credits WHERE intent_code = i.code AND status = 'matched') THEN
    v_reason := 'payment code already paid';
  ELSIF i.subject_id IS NOT NULL AND kyc.subject_status(i.subject_id) <> 'verified' THEN
    v_reason := 'investor is not KYC-verified';
  ELSIF i.subject_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM bank.payees WHERE subject_id = i.subject_id AND iban_hash = v_payer) THEN
    v_reason := 'paid from an account not registered to the investor';
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

/** A payout line the beneficiary bank sent back (account closed, ...). Called by bank.ingest_event only. */
CREATE FUNCTION bank.book_payout_return(p_event text, p jsonb, p_actor text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, bank AS $$
DECLARE
  b bank.payout_batches;
  it bank.payout_items;
  v_line integer;
  v_amount bigint;
  v_journal bigint;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object'
     OR jsonb_typeof(p->'batchReference') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p->'lineNo') IS DISTINCT FROM 'number' OR (p->>'lineNo') !~ '^[1-9][0-9]{0,4}$'
     OR jsonb_typeof(p->'returnRef') IS DISTINCT FROM 'string' OR (p->>'returnRef') !~ '^[A-Z0-9][A-Z0-9-]{3,63}$'
     OR jsonb_typeof(p->'amountPaisa') IS DISTINCT FROM 'string' OR (p->>'amountPaisa') !~ '^[1-9][0-9]{0,14}$'
     OR jsonb_typeof(p->'reason') IS DISTINCT FROM 'string' OR (p->>'reason') !~ '^[a-z][a-z0-9_]{1,39}$' THEN
    RAISE EXCEPTION 'malformed payout return event %', p_event USING ERRCODE = 'check_violation';
  END IF;
  v_line := (p->>'lineNo')::integer;
  v_amount := (p->>'amountPaisa')::bigint;
  PERFORM pg_advisory_xact_lock(586586096);
  SELECT * INTO b FROM bank.payout_batches WHERE reference = p->>'batchReference';
  IF NOT FOUND OR b.status <> 'submitted' THEN
    RAISE EXCEPTION 'payout return for unknown or unsubmitted batch %', p->>'batchReference' USING ERRCODE = 'no_data_found';
  END IF;
  SELECT * INTO it FROM bank.payout_items WHERE batch_id = b.id AND line_no = v_line;
  IF NOT FOUND OR it.amount_paisa <> v_amount THEN
    RAISE EXCEPTION 'payout return does not match line % of batch %', v_line, b.reference USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM bank.payout_returns WHERE batch_id = b.id AND line_no = v_line) THEN
    RETURN 'duplicate_return';
  END IF;
  -- The money is back in escrow and owed to the investor again.
  v_journal := ledger.post_journal(format('bank:payout-return:%s:%s', b.reference, v_line), 'payout_return', p->>'reason', p->>'returnRef', p_actor,
    jsonb_build_array(jsonb_build_object('account', 'bank:trustee-escrow', 'amount', v_amount::text),
                      jsonb_build_object('account', 'rent:payable:' || it.subject_id, 'amount', (-v_amount)::text)));
  INSERT INTO bank.payout_returns (batch_id, line_no, event_id, return_ref, reason, journal_id)
  VALUES (b.id, v_line, p_event, p->>'returnRef', p->>'reason', v_journal);
  -- The account does not take money: it stops being the payout account until the investor registers one.
  UPDATE bank.payees SET superseded_at = clock_timestamp() WHERE id = it.payee_id AND superseded_at IS NULL;
  PERFORM bank.audit_append(p_actor, 'payout.returned', jsonb_build_object('batch', b.id, 'line', v_line, 'ref', p->>'returnRef',
                                                                          'amount', v_amount::text, 'journal', v_journal));
  PERFORM pg_notify('bank_alert', json_build_object('kind', 'payout_returned', 'batch', b.id, 'line', v_line, 'subject', it.subject_id)::text);
  RETURN 'returned';
END $$;

/**
 * B-1: the entry point for a verified webhook. Returns {status: processed | duplicate | conflict, outcome}.
 * p_payload is the service's normalised form (no IBAN in clear).
 */
CREATE FUNCTION bank.ingest_event(p_event_id text, p_type text, p_body_sha256 bytea, p_key_id text, p_payload jsonb, p_actor text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, bank AS $$
DECLARE
  e bank.events;
  v_outcome text;
BEGIN
  IF p_event_id IS NULL OR p_type IS NULL OR p_body_sha256 IS NULL OR p_key_id IS NULL OR p_payload IS NULL OR p_actor IS NULL THEN
    RAISE EXCEPTION 'event id, type, body hash, key id, payload and actor are required' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(586586094, hashtext(p_event_id));
  SELECT * INTO e FROM bank.events WHERE event_id = p_event_id;
  IF FOUND THEN
    IF e.body_sha256 = p_body_sha256 AND e.type = p_type THEN
      SELECT coalesce((SELECT status FROM bank.credits WHERE event_id = p_event_id),
                      (SELECT 'returned' FROM bank.payout_returns WHERE event_id = p_event_id), 'recorded') INTO v_outcome;
      RETURN jsonb_build_object('status', 'duplicate', 'outcome', v_outcome);
    END IF;
    PERFORM bank.audit_append(p_actor, 'event.conflict', jsonb_build_object('event', p_event_id, 'type', p_type));
    PERFORM pg_notify('bank_alert', json_build_object('kind', 'event_conflict', 'event', p_event_id)::text);
    RETURN jsonb_build_object('status', 'conflict');
  END IF;
  INSERT INTO bank.events (event_id, type, body_sha256, key_id) VALUES (p_event_id, p_type, p_body_sha256, p_key_id);
  IF p_type = 'credit.received' THEN
    v_outcome := bank.book_credit(p_event_id, p_payload, p_actor);
  ELSE
    v_outcome := bank.book_payout_return(p_event_id, p_payload, p_actor);
  END IF;
  RETURN jsonb_build_object('status', 'processed', 'outcome', v_outcome);
END $$;

/** Sends a suspense credit back to its sender (same reference, other direction). Needs the gate. */
CREATE FUNCTION bank.return_credit(p_ref text, p_operator text, p_reason text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, bank AS $$
DECLARE
  c bank.credits;
  v_journal bigint;
BEGIN
  IF p_ref IS NULL OR p_operator IS NULL OR length(p_operator) NOT BETWEEN 2 AND 100 OR p_reason IS NULL OR length(p_reason) NOT BETWEEN 10 AND 300 THEN
    RAISE EXCEPTION 'a reference, an operator and a reason of 10 to 300 characters are required' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(586586097, hashtext(p_ref));
  SELECT * INTO c FROM bank.credits WHERE raast_ref = p_ref;
  IF NOT FOUND OR c.status <> 'suspense' THEN
    RAISE EXCEPTION 'credit % is not in suspense', p_ref USING ERRCODE = 'check_violation';
  END IF;
  SELECT journal_id INTO v_journal FROM bank.credit_returns WHERE raast_ref = p_ref;
  IF FOUND THEN RETURN v_journal; END IF;
  PERFORM bank.require_gate();
  v_journal := ledger.post_journal('bank:return:' || p_ref, 'payment_return', left(p_reason, 200), p_ref, p_operator, jsonb_build_array(
    jsonb_build_object('account', 'bank:suspense', 'amount', c.amount_paisa::text),
    jsonb_build_object('account', 'bank:trustee-escrow', 'amount', (-c.amount_paisa)::text)));
  INSERT INTO bank.credit_returns (raast_ref, journal_id, returned_by, reason) VALUES (p_ref, v_journal, p_operator, p_reason);
  PERFORM bank.audit_append(p_operator, 'credit.returned', jsonb_build_object('ref', p_ref, 'amount', c.amount_paisa::text, 'journal', v_journal));
  RETURN v_journal;
END $$;

-- ------------------------------------------------------------------ API: payout batches (B-5, B-6)
/**
 * Creates a rent payout batch for a finalized on-chain distribution. p_items: [{subject, amountPaisa}],
 * in file order. Every investor must be verified and have an active payout account, and the total
 * must equal the distribution's total in the read model.
 */
CREATE FUNCTION bank.create_payout_batch(p_reference text, p_token text, p_distribution numeric, p_items jsonb, p_actor text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, bank AS $$
DECLARE
  v_token text := lower(p_token);
  v_bad text;
  v_total bigint;
  v_dist record;
  v_resolved jsonb;
  v_problems text;
  v_digest bytea;
  v_id bigint;
BEGIN
  IF p_reference IS NULL OR p_token IS NULL OR p_distribution IS NULL OR p_actor IS NULL OR length(p_actor) NOT BETWEEN 2 AND 100
     OR jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items) NOT BETWEEN 1 AND 50000 THEN
    RAISE EXCEPTION 'reference, token, distribution, 1 to 50,000 items and an actor are required' USING ERRCODE = 'check_violation';
  END IF;
  SELECT string_agg(ord::text, ',') INTO v_bad
  FROM jsonb_array_elements(p_items) WITH ORDINALITY AS t(e, ord)
  WHERE jsonb_typeof(e) IS DISTINCT FROM 'object'
     OR jsonb_typeof(e->'subject') IS DISTINCT FROM 'string'
     OR (e->>'subject') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR jsonb_typeof(e->'amountPaisa') IS DISTINCT FROM 'string' OR (e->>'amountPaisa') !~ '^[1-9][0-9]{0,14}$';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'malformed payout item(s) at position %', left(v_bad, 200) USING ERRCODE = 'check_violation';
  END IF;
  IF (SELECT count(DISTINCT e->>'subject') FROM jsonb_array_elements(p_items) e) <> jsonb_array_length(p_items) THEN
    RAISE EXCEPTION 'an investor may appear only once per batch' USING ERRCODE = 'check_violation';
  END IF;
  SELECT sum((e->>'amountPaisa')::bigint) INTO v_total FROM jsonb_array_elements(p_items) e;

  PERFORM pg_advisory_xact_lock(586586096);
  IF EXISTS (SELECT 1 FROM bank.payout_batches WHERE token = v_token AND distribution_id = p_distribution AND status <> 'rejected') THEN
    RAISE EXCEPTION 'distribution % of % already has a payout batch', p_distribution, v_token USING ERRCODE = 'unique_violation';
  END IF;
  SELECT status, total_paisa INTO v_dist FROM chain.distributions
  WHERE lower(token) = v_token AND id = p_distribution ORDER BY updated_block DESC LIMIT 1;
  IF NOT FOUND OR v_dist.status <> 'finalized' THEN
    RAISE EXCEPTION 'distribution % of % is not finalized on chain (read model: %)', p_distribution, v_token, coalesce(v_dist.status, 'not found')
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_dist.total_paisa <> v_total THEN
    RAISE EXCEPTION 'batch total % does not equal the on-chain distribution total %', v_total, v_dist.total_paisa USING ERRCODE = 'check_violation';
  END IF;

  SELECT jsonb_agg(jsonb_build_array(ord, e->>'subject', bank.active_payee((e->>'subject')::uuid), e->>'amountPaisa',
                                     kyc.subject_status((e->>'subject')::uuid),
                                     EXISTS (SELECT 1 FROM ledger.accounts a WHERE a.code = 'rent:payable:' || (e->>'subject'))) ORDER BY ord)
    INTO v_resolved
  FROM jsonb_array_elements(p_items) WITH ORDINALITY AS t(e, ord);
  SELECT left(string_agg(format('line %s: %s', r->>0,
           CASE WHEN r->>4 <> 'verified' THEN 'investor is ' || (r->>4)
                WHEN jsonb_typeof(r->2) = 'null' THEN 'no active payout account (none registered, or within the 72-hour cooling-off)'
                ELSE 'no rent payable account' END), '; '), 500)
    INTO v_problems
  FROM jsonb_array_elements(v_resolved) r
  WHERE r->>4 <> 'verified' OR jsonb_typeof(r->2) = 'null' OR NOT (r->>5)::boolean;
  IF v_problems IS NOT NULL THEN
    RAISE EXCEPTION 'payout batch refused: %', v_problems USING ERRCODE = 'check_violation';
  END IF;

  v_digest := sha256(convert_to('pt-payout-items-v1' || (
    SELECT jsonb_agg(jsonb_build_array(r->0, r->1, r->2, encode(p.iban_hash, 'hex'), r->3) ORDER BY (r->>0)::int)
    FROM jsonb_array_elements(v_resolved) r JOIN bank.payees p ON p.id = (r->>2)::bigint)::text, 'UTF8'));
  INSERT INTO bank.payout_batches (reference, token, distribution_id, total_paisa, item_count, items_digest, created_by)
  VALUES (p_reference, v_token, p_distribution, v_total, jsonb_array_length(p_items), v_digest, p_actor)
  RETURNING id INTO v_id;
  INSERT INTO bank.payout_items (batch_id, line_no, subject_id, payee_id, amount_paisa)
  SELECT v_id, (r->>0)::int, (r->>1)::uuid, (r->>2)::bigint, (r->>3)::bigint FROM jsonb_array_elements(v_resolved) r;
  PERFORM bank.audit_append(p_actor, 'batch.created', jsonb_build_object('batch', v_id, 'reference', p_reference, 'token', v_token,
    'distribution', p_distribution::text, 'total', v_total::text, 'items', jsonb_array_length(p_items), 'itemsDigest', encode(v_digest, 'hex')));
  RETURN v_id;
END $$;

/** B-5 checker: a different operator approves (with the gate open) or rejects. */
CREATE FUNCTION bank.decide_payout_batch(p_batch bigint, p_operator text, p_decision text, p_reason text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, bank AS $$
DECLARE
  b bank.payout_batches;
  v_problems text;
BEGIN
  IF p_decision IS NULL OR p_decision NOT IN ('approve', 'reject') THEN
    RAISE EXCEPTION 'decision must be approve or reject' USING ERRCODE = 'check_violation';
  END IF;
  IF p_operator IS NULL OR length(p_operator) NOT BETWEEN 2 AND 100 OR p_reason IS NULL OR length(p_reason) NOT BETWEEN 10 AND 500 THEN
    RAISE EXCEPTION 'an operator and a reason of 10 to 500 characters are required' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(586586096);
  SELECT * INTO b FROM bank.payout_batches WHERE id = p_batch FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown payout batch %', p_batch USING ERRCODE = 'no_data_found'; END IF;
  IF b.status <> 'created' THEN RETURN b.status; END IF;
  IF b.created_by = p_operator THEN
    RAISE EXCEPTION 'maker-checker: the creator cannot decide their own payout batch' USING ERRCODE = 'check_violation';
  END IF;
  IF p_decision = 'approve' THEN
    PERFORM bank.require_gate();
    v_problems := bank.batch_problems(b.id);
    IF v_problems IS NOT NULL THEN
      RAISE EXCEPTION 'payout batch % can no longer be paid as created: %', b.id, v_problems USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  UPDATE bank.payout_batches SET status = CASE WHEN p_decision = 'approve' THEN 'approved' ELSE 'rejected' END,
         decided_by = p_operator, decision_reason = p_reason, decided_at = clock_timestamp()
  WHERE id = b.id;
  PERFORM bank.audit_append(p_operator, 'batch.' || CASE WHEN p_decision = 'approve' THEN 'approved' ELSE 'rejected' END,
                            jsonb_build_object('batch', b.id, 'createdBy', b.created_by, 'reason', p_reason));
  RETURN CASE WHEN p_decision = 'approve' THEN 'approved' ELSE 'rejected' END;
END $$;

/** What the service needs to write the bank file of an approved batch (encrypted IBANs only). */
CREATE FUNCTION bank.payout_file_rows(p_batch bigint)
RETURNS TABLE (reference text, line_no integer, subject_id uuid, iban_enc bytea, iban_hash bytea, bank_code text, amount_paisa bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, bank AS $$
  SELECT b.reference, i.line_no, i.subject_id, p.iban_enc, p.iban_hash, p.bank_code, i.amount_paisa
  FROM bank.payout_batches b
  JOIN bank.payout_items i ON i.batch_id = b.id
  JOIN bank.payees p ON p.id = i.payee_id
  WHERE b.id = p_batch AND b.status IN ('approved', 'submitted')
  ORDER BY i.line_no
$$;

/**
 * B-5/B-6: records the submission of an approved batch with its bank file hash and books the payout in
 * the ledger, in one transaction. The service sends the file to the bank only after this commits
 * (record before send); a retry with the same file hash returns the same journal.
 */
CREATE FUNCTION bank.submit_payout_batch(p_batch bigint, p_actor text, p_file_sha256 bytea) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, bank AS $$
DECLARE
  b bank.payout_batches;
  v_problems text;
  v_postings jsonb;
  v_journal bigint;
BEGIN
  IF p_batch IS NULL OR p_actor IS NULL OR p_file_sha256 IS NULL OR length(p_file_sha256) <> 32 THEN
    RAISE EXCEPTION 'batch, actor and a 32-byte file hash are required' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(586586096);
  SELECT * INTO b FROM bank.payout_batches WHERE id = p_batch FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown payout batch %', p_batch USING ERRCODE = 'no_data_found'; END IF;
  IF b.status = 'submitted' THEN
    IF b.file_sha256 = p_file_sha256 THEN RETURN b.journal_id; END IF;
    RAISE EXCEPTION 'payout batch % was already submitted with a different file', b.id USING ERRCODE = 'unique_violation';
  END IF;
  IF b.status <> 'approved' THEN
    RAISE EXCEPTION 'payout batch % is %, not approved', b.id, b.status USING ERRCODE = 'check_violation';
  END IF;
  PERFORM bank.require_gate();
  v_problems := bank.batch_problems(b.id);
  IF v_problems IS NOT NULL THEN
    RAISE EXCEPTION 'payout batch % can no longer be paid as approved: %', b.id, v_problems USING ERRCODE = 'check_violation';
  END IF;
  SELECT jsonb_agg(jsonb_build_object('account', 'rent:payable:' || subject_id, 'amount', amount_paisa::text) ORDER BY line_no)
           || jsonb_build_array(jsonb_build_object('account', 'bank:trustee-escrow', 'amount', (-b.total_paisa)::text))
    INTO v_postings
  FROM bank.payout_items WHERE batch_id = b.id;
  -- Ledger rules apply: the escrow cannot go negative and no investor is paid more than owed.
  v_journal := ledger.post_journal(format('rent:payout:%s:%s', b.token, b.distribution_id), 'rent_payout',
                                   'payout batch ' || b.reference, b.reference, p_actor, v_postings);
  UPDATE bank.payout_batches SET status = 'submitted', file_sha256 = p_file_sha256, journal_id = v_journal,
         submitted_by = p_actor, submitted_at = clock_timestamp()
  WHERE id = b.id;
  PERFORM bank.audit_append(p_actor, 'batch.submitted', jsonb_build_object('batch', b.id, 'journal', v_journal, 'fileSha256', encode(p_file_sha256, 'hex')));
  RETURN v_journal;
END $$;

/** Account details without hashes or ciphertext: what readers and dashboards may see. */
CREATE VIEW bank.payee_status AS
SELECT id, subject_id, iban_last4, bank_code, registered_at, active_from, superseded_at,
       superseded_at IS NULL AND active_from <= now() AS active
FROM bank.payees;

CREATE FUNCTION bank.verify_audit() RETURNS TABLE (audit_id bigint, problem text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, bank AS $$
DECLARE
  a bank.audit;
  v_prev bytea := decode(repeat('00', 32), 'hex');
  c bank.credits;
  b bank.payout_batches;
  r record;
BEGIN
  FOR a IN SELECT * FROM bank.audit ORDER BY id LOOP
    IF a.prev_hash <> v_prev THEN audit_id := a.id; problem := 'prev_hash does not match'; RETURN NEXT; END IF;
    IF a.hash <> bank.audit_digest(a.prev_hash, a.id, a.at, a.actor, a.action, a.detail) THEN
      audit_id := a.id; problem := 'content does not match its hash'; RETURN NEXT;
    END IF;
    IF a.action = 'credit.booked' THEN
      SELECT * INTO c FROM bank.credits WHERE raast_ref = a.detail->>'ref';
      IF NOT FOUND OR c.amount_paisa::text <> a.detail->>'amount' OR c.status <> a.detail->>'status'
         OR c.journal_id::text <> a.detail->>'journal' OR c.intent_code IS DISTINCT FROM a.detail->>'intent' THEN
        audit_id := a.id; problem := format('credit %s changed after it was booked', a.detail->>'ref'); RETURN NEXT;
      END IF;
    END IF;
    IF a.action = 'batch.created' THEN
      SELECT * INTO b FROM bank.payout_batches WHERE id = (a.detail->>'batch')::bigint;
      IF NOT FOUND OR b.total_paisa::text <> a.detail->>'total' OR encode(b.items_digest, 'hex') <> a.detail->>'itemsDigest'
         OR encode(b.items_digest, 'hex') <> encode(sha256(convert_to('pt-payout-items-v1' || (
              SELECT jsonb_agg(jsonb_build_array(i.line_no, i.subject_id::text, i.payee_id, encode(p.iban_hash, 'hex'), i.amount_paisa::text) ORDER BY i.line_no)
              FROM bank.payout_items i JOIN bank.payees p ON p.id = i.payee_id WHERE i.batch_id = b.id)::text, 'UTF8')), 'hex') THEN
        audit_id := a.id; problem := format('payout batch %s or its items changed after creation', a.detail->>'batch'); RETURN NEXT;
      END IF;
    END IF;
    v_prev := a.hash;
  END LOOP;
  FOR r IN SELECT x.raast_ref AS id, 'credit' AS what FROM bank.credits x
             WHERE NOT EXISTS (SELECT 1 FROM bank.audit y WHERE y.action = 'credit.booked' AND y.detail->>'ref' = x.raast_ref)
           UNION ALL
           SELECT x.id::text, 'payout batch' FROM bank.payout_batches x
             WHERE NOT EXISTS (SELECT 1 FROM bank.audit y WHERE y.action = 'batch.created' AND (y.detail->>'batch')::bigint = x.id)
             OR (x.status <> 'created' AND NOT EXISTS (
                   SELECT 1 FROM bank.audit y WHERE y.action = 'batch.' || CASE WHEN x.status = 'submitted' THEN 'approved' ELSE x.status END
                     AND (y.detail->>'batch')::bigint = x.id))
             OR (x.status = 'submitted' AND NOT EXISTS (
                   SELECT 1 FROM bank.audit y WHERE y.action = 'batch.submitted' AND (y.detail->>'batch')::bigint = x.id
                     AND y.detail->>'fileSha256' = encode(x.file_sha256, 'hex') AND (y.detail->>'journal')::bigint = x.journal_id))
           UNION ALL
           SELECT x.id::text, 'payout account' FROM bank.payees x
             WHERE NOT EXISTS (SELECT 1 FROM bank.audit y WHERE y.action = 'payee.registered' AND (y.detail->>'payee')::bigint = x.id)
           UNION ALL
           SELECT x.raast_ref, 'credit return' FROM bank.credit_returns x
             WHERE NOT EXISTS (SELECT 1 FROM bank.audit y WHERE y.action = 'credit.returned' AND y.detail->>'ref' = x.raast_ref)
           UNION ALL
           SELECT x.batch_id || '/' || x.line_no, 'payout return' FROM bank.payout_returns x
             WHERE NOT EXISTS (SELECT 1 FROM bank.audit y WHERE y.action = 'payout.returned' AND (y.detail->>'batch')::bigint = x.batch_id
                                 AND (y.detail->>'line')::int = x.line_no) LOOP
    audit_id := NULL; problem := format('%s %s has no audit entry', r.what, r.id); RETURN NEXT;
  END LOOP;
END $$;

-- ================================================================== privileges (Y-6, B-7)
REVOKE ALL ON ALL TABLES IN SCHEMA kyc, bank FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA kyc, bank FROM PUBLIC;

GRANT USAGE ON SCHEMA kyc TO pt_kyc_service, pt_kyc_officer, pt_kyc_reader, pt_signer, pt_bank_service, pt_bank_operator;
GRANT EXECUTE ON FUNCTION
  kyc.register_subject(bytea[], smallint[], bytea, bytea, text, text),
  kyc.find_subject(bytea[]),
  kyc.sealed_name(uuid),
  kyc.record_check(uuid, text, text, text, text, text, smallint, text, bytea, text),
  kyc.bind_wallet(uuid, text, text)
  TO pt_kyc_service;
GRANT EXECUTE ON FUNCTION kyc.evaluate(uuid, text) TO pt_kyc_service, pt_kyc_officer;
GRANT EXECUTE ON FUNCTION
  kyc.request_clearance(bigint, text, text, text),
  kyc.decide_clearance(bigint, text, text, text),
  kyc.revoke(uuid, text, text)
  TO pt_kyc_officer;
GRANT EXECUTE ON FUNCTION kyc.subject_status(uuid), kyc.is_verified(text)
  TO pt_kyc_service, pt_kyc_officer, pt_kyc_reader, pt_signer, pt_bank_service, pt_bank_operator;
GRANT EXECUTE ON FUNCTION kyc.verify_audit() TO pt_kyc_officer, pt_kyc_reader;
GRANT SELECT ON kyc.status TO pt_kyc_service, pt_kyc_officer, pt_kyc_reader;
GRANT SELECT ON kyc.checks, kyc.decisions, kyc.clearances TO pt_kyc_officer;

GRANT USAGE ON SCHEMA bank TO pt_bank_service, pt_bank_operator, pt_bank_reader;
GRANT EXECUTE ON FUNCTION
  bank.ingest_event(text, text, bytea, text, jsonb, text),
  bank.create_intent(text, text, uuid, bigint, text, text, integer, text),
  bank.register_payee(uuid, bytea, bytea, text, text, bytea, text),
  bank.create_payout_batch(text, text, numeric, jsonb, text),
  bank.payout_file_rows(bigint),
  bank.submit_payout_batch(bigint, text, bytea)
  TO pt_bank_service;
GRANT EXECUTE ON FUNCTION bank.decide_payout_batch(bigint, text, text, text), bank.return_credit(text, text, text) TO pt_bank_operator;
GRANT EXECUTE ON FUNCTION bank.active_payee(uuid) TO pt_bank_service, pt_bank_operator, pt_bank_reader;
GRANT EXECUTE ON FUNCTION bank.verify_audit() TO pt_bank_operator, pt_bank_reader;
GRANT SELECT ON bank.events, bank.payment_intents, bank.credits, bank.credit_returns, bank.payout_batches, bank.payout_items,
  bank.payout_returns, bank.payee_status, bank.audit TO pt_bank_operator, pt_bank_reader;
GRANT SELECT ON bank.payee_status TO pt_bank_service;

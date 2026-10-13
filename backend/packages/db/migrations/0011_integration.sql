-- Integration (Step 5h): what the signing service may read from the bank and KYC schemas.
--
--   I-1  The signer may record a payout on chain (rent.record_payout) only with the SHA-256 of the
--        bank file of the distribution's SUBMITTED distribution batch. It reads that hash through
--        bank.distribution_file_hash, never the bank tables.
--   I-2  The signer may freeze a wallet (compliance.freeze) only if its owner is not KYC-verified;
--        it already reads kyc.is_verified (granted in 0009).
--   I-3  Offboarding starts by itself: kyc.enqueue_offboarding() puts one compliance.freeze command
--        in the outbox for every bound wallet whose owner was verified and no longer is (review,
--        rejected, revoked, expired). One command per (subject, decision, status), so a repeated
--        call or a missed notification never doubles a freeze and never skips one. Unfreezing stays
--        a manual, two-officer decision (Step 6).

/** 0x SHA-256 of the bank file of a distribution's submitted batch, or NULL. */
CREATE FUNCTION bank.distribution_file_hash(p_token text, p_distribution numeric) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, bank AS $$
  SELECT '0x' || encode(file_sha256, 'hex') FROM bank.payout_batches
  WHERE token = lower(p_token) AND distribution_id = p_distribution AND kind = 'distribution' AND status = 'submitted'
$$;

REVOKE ALL ON FUNCTION bank.distribution_file_hash(text, numeric) FROM PUBLIC;
GRANT USAGE ON SCHEMA bank TO pt_signer;
GRANT EXECUTE ON FUNCTION bank.distribution_file_hash(text, numeric) TO pt_signer, pt_bank_operator, pt_bank_reader;

/** I-3: enqueues the freeze of every wallet whose owner lost the verification. Returns how many were new. */
CREATE FUNCTION kyc.enqueue_offboarding(p_freeze_guard text, p_actor text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, kyc AS $$
DECLARE
  r record;
  v_new integer := 0;
  v_key text;
  v_existing bigint;
BEGIN
  IF p_freeze_guard IS NULL OR lower(p_freeze_guard) !~ '^0x[0-9a-f]{40}$' OR p_actor IS NULL THEN
    RAISE EXCEPTION 'a FreezeGuard address and an actor are required' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(586586099);  -- one caller at a time: no double audit entries
  FOR r IN
    SELECT w.subject_id, w.wallet, d.id AS decision_id, kyc.subject_status(w.subject_id) AS status
    FROM kyc.wallets w
    JOIN LATERAL (SELECT x.id FROM kyc.decisions x WHERE x.subject_id = w.subject_id ORDER BY x.id DESC LIMIT 1) d ON true
    WHERE kyc.subject_status(w.subject_id) IN ('review', 'rejected', 'revoked', 'expired')
      AND EXISTS (SELECT 1 FROM kyc.decisions v WHERE v.subject_id = w.subject_id AND v.status = 'verified')
    ORDER BY d.id
  LOOP
    v_key := format('compliance.freeze:%s:%s:%s', r.subject_id, r.decision_id, r.status);
    SELECT id INTO v_existing FROM outbox.commands WHERE idempotency_key = v_key;
    CONTINUE WHEN FOUND;
    PERFORM outbox.enqueue(v_key, 'compliance.freeze',
      jsonb_build_object('freezeGuard', lower(p_freeze_guard), 'account', r.wallet,
                         'caseId', '0x' || encode(sha256(convert_to('pt-kyc-case-v1:' || r.decision_id || ':' || r.status, 'UTF8')), 'hex')),
      r.subject_id::text, p_actor);
    PERFORM kyc.audit_append(p_actor, 'offboarding.enqueued', jsonb_build_object('subject', r.subject_id, 'wallet', r.wallet,
                                                                                'decision', r.decision_id, 'status', r.status));
    v_new := v_new + 1;
  END LOOP;
  RETURN v_new;
END $$;

REVOKE ALL ON FUNCTION kyc.enqueue_offboarding(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kyc.enqueue_offboarding(text, text) TO pt_kyc_service, pt_kyc_officer;

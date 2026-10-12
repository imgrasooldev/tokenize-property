-- Held payouts (Step 5h, ADR 0009 decision 2): pay the rest, hold the share.
--
-- Before: one investor without an active payout account (none registered, in the 72-hour
-- cooling-off, returned, KYC not verified) blocked the whole distribution's batch.
-- Now:
--   H-1  Such a line is HELD: it stays in the batch (so paid + held = the on-chain distribution
--        total), is not sent to the bank and stays owed in rent:payable:<subject>.
--   H-2  A batch must pay something; a structural problem (no payable account) still refuses it.
--   H-3  A held share is paid later by a FOLLOW-UP batch of the same distribution: only lines held
--        in the parent, each once (a rejected follow-up frees them again), only to verified
--        investors with an active account, same maker-checker, gate and record-before-send.
--        Its ledger journal is rent:payout:<token>:<id>:followup:<batch>; nothing changes on chain
--        (the distribution is already recorded as paid with the parent's file hash).
--   H-4  The batch's item digest (v2) covers the held flag, so a line cannot be moved between paid
--        and held after creation without bank.verify_audit() noticing.
-- 0009 is unchanged (it is applied on the demo server); its functions are replaced here.

ALTER TABLE bank.payout_batches
  ADD COLUMN kind text NOT NULL DEFAULT 'distribution' CHECK (kind IN ('distribution', 'follow_up')),
  ADD COLUMN parent_id bigint REFERENCES bank.payout_batches (id),
  ADD COLUMN paid_paisa bigint,
  ADD COLUMN items_digest_version smallint NOT NULL DEFAULT 1 CHECK (items_digest_version IN (1, 2));
ALTER TABLE bank.payout_batches DISABLE TRIGGER payout_batches_guard;
UPDATE bank.payout_batches SET paid_paisa = total_paisa;
ALTER TABLE bank.payout_batches ENABLE TRIGGER payout_batches_guard;
ALTER TABLE bank.payout_batches
  ALTER COLUMN paid_paisa SET NOT NULL,
  ADD CHECK (paid_paisa > 0 AND paid_paisa <= total_paisa),
  ADD CHECK ((kind = 'follow_up') = (parent_id IS NOT NULL)),
  ADD CHECK (kind = 'distribution' OR paid_paisa = total_paisa);

DROP INDEX bank.payout_batches_one_live;
CREATE UNIQUE INDEX payout_batches_one_live ON bank.payout_batches (token, distribution_id) WHERE status <> 'rejected' AND kind = 'distribution';
CREATE INDEX payout_batches_parent_idx ON bank.payout_batches (parent_id) WHERE parent_id IS NOT NULL;

ALTER TABLE bank.payout_items
  ADD COLUMN held boolean NOT NULL DEFAULT false,
  ADD COLUMN held_reason text CHECK (length(held_reason) BETWEEN 2 AND 200),
  ALTER COLUMN payee_id DROP NOT NULL,
  ADD CHECK (held = (payee_id IS NULL)),
  ADD CHECK (held = (held_reason IS NOT NULL));

CREATE OR REPLACE FUNCTION bank.guard_batch() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payout batches are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (NEW.id, NEW.reference, NEW.token, NEW.distribution_id, NEW.total_paisa, NEW.item_count, NEW.items_digest, NEW.created_by, NEW.created_at,
      NEW.kind, NEW.parent_id, NEW.paid_paisa, NEW.items_digest_version)
     IS DISTINCT FROM (OLD.id, OLD.reference, OLD.token, OLD.distribution_id, OLD.total_paisa, OLD.item_count, OLD.items_digest, OLD.created_by, OLD.created_at,
      OLD.kind, OLD.parent_id, OLD.paid_paisa, OLD.items_digest_version)
     OR NOT ((OLD.status = 'created' AND NEW.status IN ('approved', 'rejected')) OR (OLD.status = 'approved' AND NEW.status = 'submitted'))
     OR (OLD.status = 'approved' AND (NEW.decided_by, NEW.decision_reason, NEW.decided_at) IS DISTINCT FROM (OLD.decided_by, OLD.decision_reason, OLD.decided_at)) THEN
    RAISE EXCEPTION 'payout batch % cannot change from % that way', OLD.id, OLD.status USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

/** H-4: digest v2 over [line, subject, payee, IBAN hash, amount, held] rows in line order. */
CREATE FUNCTION bank.items_digest_v2_of(p_rows jsonb) RETURNS bytea
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT sha256(convert_to('pt-payout-items-v2' || coalesce(p_rows, '[]'::jsonb)::text, 'UTF8'))
$$;

/** The same digest recomputed from a batch's stored items (bank.verify_audit). */
CREATE FUNCTION bank.items_digest_v2(p_batch bigint) RETURNS bytea
LANGUAGE sql STABLE SET search_path = pg_catalog, bank AS $$
  SELECT bank.items_digest_v2_of((
    SELECT jsonb_agg(jsonb_build_array(i.line_no, i.subject_id::text, i.payee_id, encode(p.iban_hash, 'hex'), i.amount_paisa::text, i.held) ORDER BY i.line_no)
    FROM bank.payout_items i LEFT JOIN bank.payees p ON p.id = i.payee_id WHERE i.batch_id = p_batch))
$$;

/** Only lines that will be paid can make a batch unpayable; held lines wait for a follow-up. */
CREATE OR REPLACE FUNCTION bank.batch_problems(p_batch bigint) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, bank AS $$
  SELECT left(string_agg(format('line %s: %s', i.line_no,
           CASE WHEN kyc.subject_status(i.subject_id) <> 'verified' THEN 'investor is ' || kyc.subject_status(i.subject_id)
                ELSE 'payout account changed or not active' END), '; ' ORDER BY i.line_no), 500)
  FROM bank.payout_items i
  WHERE i.batch_id = p_batch AND NOT i.held
    AND (kyc.subject_status(i.subject_id) <> 'verified' OR bank.active_payee(i.subject_id) IS DISTINCT FROM i.payee_id)
$$;

/** H-1, H-2: creates a distribution's batch; lines that cannot be paid now are held, not refused. */
CREATE OR REPLACE FUNCTION bank.create_payout_batch(p_reference text, p_token text, p_distribution numeric, p_items jsonb, p_actor text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, bank AS $$
DECLARE
  v_token text := lower(p_token);
  v_bad text;
  v_total bigint;
  v_paid bigint;
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
  IF EXISTS (SELECT 1 FROM bank.payout_batches WHERE token = v_token AND distribution_id = p_distribution AND status <> 'rejected' AND kind = 'distribution') THEN
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

  -- [line, subject, payee or null, amount, held reason or null, payable account exists]
  SELECT jsonb_agg(jsonb_build_array(ord, e->>'subject', CASE WHEN st = 'verified' THEN payee END, e->>'amountPaisa',
                                     CASE WHEN st <> 'verified' THEN 'investor is ' || st
                                          WHEN payee IS NULL THEN 'no active payout account' END,
                                     EXISTS (SELECT 1 FROM ledger.accounts a WHERE a.code = 'rent:payable:' || (e->>'subject'))) ORDER BY ord)
    INTO v_resolved
  FROM jsonb_array_elements(p_items) WITH ORDINALITY AS t(e, ord),
       LATERAL (SELECT kyc.subject_status((e->>'subject')::uuid) AS st, bank.active_payee((e->>'subject')::uuid) AS payee) x;
  SELECT left(string_agg(format('line %s: no rent payable account', r->>0), '; '), 500) INTO v_problems
  FROM jsonb_array_elements(v_resolved) r WHERE NOT (r->>5)::boolean;
  IF v_problems IS NOT NULL THEN
    RAISE EXCEPTION 'payout batch refused: %', v_problems USING ERRCODE = 'check_violation';
  END IF;
  SELECT coalesce(sum((r->>3)::bigint), 0) INTO v_paid FROM jsonb_array_elements(v_resolved) r WHERE jsonb_typeof(r->4) = 'null';
  IF v_paid = 0 THEN
    RAISE EXCEPTION 'nothing to pay: every line would be held' USING ERRCODE = 'check_violation';
  END IF;

  SELECT bank.items_digest_v2_of(jsonb_agg(jsonb_build_array((r->>0)::int, r->>1, (r->>2)::bigint, encode(p.iban_hash, 'hex'), r->>3,
                                                              jsonb_typeof(r->4) <> 'null') ORDER BY (r->>0)::int))
    INTO v_digest
  FROM jsonb_array_elements(v_resolved) r LEFT JOIN bank.payees p ON p.id = (r->>2)::bigint;
  INSERT INTO bank.payout_batches (reference, token, distribution_id, total_paisa, paid_paisa, item_count, items_digest, items_digest_version, created_by)
  VALUES (p_reference, v_token, p_distribution, v_total, v_paid, jsonb_array_length(p_items), v_digest, 2, p_actor)
  RETURNING id INTO v_id;
  INSERT INTO bank.payout_items (batch_id, line_no, subject_id, payee_id, amount_paisa, held, held_reason)
  SELECT v_id, (r->>0)::int, (r->>1)::uuid, (r->>2)::bigint, (r->>3)::bigint, jsonb_typeof(r->4) <> 'null', r->>4
  FROM jsonb_array_elements(v_resolved) r;
  IF bank.items_digest_v2(v_id) <> v_digest THEN
    RAISE EXCEPTION 'internal: item digest differs from the stored items' USING ERRCODE = 'internal_error';
  END IF;
  PERFORM bank.audit_append(p_actor, 'batch.created', jsonb_build_object('batch', v_id, 'reference', p_reference, 'token', v_token,
    'distribution', p_distribution::text, 'total', v_total::text, 'paid', v_paid::text, 'held', (v_total - v_paid)::text,
    'items', jsonb_array_length(p_items), 'itemsDigest', encode(v_digest, 'hex')));
  IF v_paid < v_total THEN
    PERFORM pg_notify('bank_alert', json_build_object('kind', 'payout_held', 'batch', v_id, 'heldPaisa', (v_total - v_paid)::text)::text);
  END IF;
  RETURN v_id;
END $$;

/** H-3: pays shares held in a submitted distribution batch, once each, to investors who can now be paid. p_subjects: ["<uuid>", ...]. */
CREATE FUNCTION bank.create_followup_batch(p_reference text, p_parent bigint, p_subjects jsonb, p_actor text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, bank AS $$
DECLARE
  par bank.payout_batches;
  v_rows jsonb;
  v_problems text;
  v_total bigint;
  v_digest bytea;
  v_id bigint;
BEGIN
  IF p_reference IS NULL OR p_parent IS NULL OR p_actor IS NULL OR length(p_actor) NOT BETWEEN 2 AND 100
     OR jsonb_typeof(p_subjects) IS DISTINCT FROM 'array' OR jsonb_array_length(p_subjects) NOT BETWEEN 1 AND 50000 THEN
    RAISE EXCEPTION 'reference, parent batch, 1 to 50,000 investors and an actor are required' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_subjects) e
             WHERE jsonb_typeof(e) IS DISTINCT FROM 'string' OR (e #>> '{}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
     OR (SELECT count(DISTINCT e #>> '{}') FROM jsonb_array_elements(p_subjects) e) <> jsonb_array_length(p_subjects) THEN
    RAISE EXCEPTION 'investors must be distinct subject ids' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(586586096);
  SELECT * INTO par FROM bank.payout_batches WHERE id = p_parent;
  IF NOT FOUND OR par.kind <> 'distribution' OR par.status <> 'submitted' THEN
    RAISE EXCEPTION 'batch % is not a submitted distribution batch', p_parent USING ERRCODE = 'check_violation';
  END IF;

  -- [ord, subject, held line found, already in a live follow-up, status, active payee, amount]
  SELECT jsonb_agg(jsonb_build_array(ord, s, i.line_no IS NOT NULL,
           EXISTS (SELECT 1 FROM bank.payout_items fi JOIN bank.payout_batches fb ON fb.id = fi.batch_id
                   WHERE fb.parent_id = p_parent AND fb.status <> 'rejected' AND fi.subject_id = s::uuid),
           kyc.subject_status(s::uuid), bank.active_payee(s::uuid), i.amount_paisa::text) ORDER BY ord)
    INTO v_rows
  FROM jsonb_array_elements_text(p_subjects) WITH ORDINALITY AS t(s, ord)
  LEFT JOIN bank.payout_items i ON i.batch_id = p_parent AND i.subject_id = s::uuid AND i.held;
  SELECT left(string_agg(format('investor %s: %s', r->>1,
           CASE WHEN NOT (r->>2)::boolean THEN 'no held share in batch ' || p_parent
                WHEN (r->>3)::boolean THEN 'already in a follow-up batch'
                WHEN r->>4 <> 'verified' THEN 'investor is ' || (r->>4)
                ELSE 'no active payout account' END), '; '), 500)
    INTO v_problems
  FROM jsonb_array_elements(v_rows) r
  WHERE NOT (r->>2)::boolean OR (r->>3)::boolean OR r->>4 <> 'verified' OR jsonb_typeof(r->5) = 'null';
  IF v_problems IS NOT NULL THEN
    RAISE EXCEPTION 'follow-up batch refused: %', v_problems USING ERRCODE = 'check_violation';
  END IF;

  SELECT sum((r->>6)::bigint),
         bank.items_digest_v2_of(jsonb_agg(jsonb_build_array((r->>0)::int, r->>1, (r->>5)::bigint, encode(p.iban_hash, 'hex'), r->>6, false) ORDER BY (r->>0)::int))
    INTO v_total, v_digest
  FROM jsonb_array_elements(v_rows) r JOIN bank.payees p ON p.id = (r->>5)::bigint;
  INSERT INTO bank.payout_batches (reference, token, distribution_id, total_paisa, paid_paisa, item_count, items_digest, items_digest_version, created_by, kind, parent_id)
  VALUES (p_reference, par.token, par.distribution_id, v_total, v_total, jsonb_array_length(p_subjects), v_digest, 2, p_actor, 'follow_up', p_parent)
  RETURNING id INTO v_id;
  INSERT INTO bank.payout_items (batch_id, line_no, subject_id, payee_id, amount_paisa)
  SELECT v_id, (r->>0)::int, (r->>1)::uuid, (r->>5)::bigint, (r->>6)::bigint FROM jsonb_array_elements(v_rows) r;
  IF bank.items_digest_v2(v_id) <> v_digest THEN
    RAISE EXCEPTION 'internal: item digest differs from the stored items' USING ERRCODE = 'internal_error';
  END IF;
  PERFORM bank.audit_append(p_actor, 'batch.created', jsonb_build_object('batch', v_id, 'reference', p_reference, 'parent', p_parent,
    'token', par.token, 'distribution', par.distribution_id::text, 'total', v_total::text, 'paid', v_total::text, 'held', '0',
    'items', jsonb_array_length(p_subjects), 'itemsDigest', encode(v_digest, 'hex')));
  RETURN v_id;
END $$;

/** The bank file of an approved batch: paid lines only (held lines are never sent). */
CREATE OR REPLACE FUNCTION bank.payout_file_rows(p_batch bigint)
RETURNS TABLE (reference text, line_no integer, subject_id uuid, iban_enc bytea, iban_hash bytea, bank_code text, amount_paisa bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, bank AS $$
  SELECT b.reference, i.line_no, i.subject_id, p.iban_enc, p.iban_hash, p.bank_code, i.amount_paisa
  FROM bank.payout_batches b
  JOIN bank.payout_items i ON i.batch_id = b.id AND NOT i.held
  JOIN bank.payees p ON p.id = i.payee_id
  WHERE b.id = p_batch AND b.status IN ('approved', 'submitted')
  ORDER BY i.line_no
$$;

/** As in 0009, with held lines left owed and a separate journal key per follow-up batch. */
CREATE OR REPLACE FUNCTION bank.submit_payout_batch(p_batch bigint, p_actor text, p_file_sha256 bytea) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, bank AS $$
DECLARE
  b bank.payout_batches;
  v_problems text;
  v_postings jsonb;
  v_key text;
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
           || jsonb_build_array(jsonb_build_object('account', 'bank:trustee-escrow', 'amount', (-b.paid_paisa)::text))
    INTO v_postings
  FROM bank.payout_items WHERE batch_id = b.id AND NOT held;
  v_key := CASE WHEN b.kind = 'distribution' THEN format('rent:payout:%s:%s', b.token, b.distribution_id)
                ELSE format('rent:payout:%s:%s:followup:%s', b.token, b.distribution_id, b.id) END;
  v_journal := ledger.post_journal(v_key, 'rent_payout', 'payout batch ' || b.reference, b.reference, p_actor, v_postings);
  UPDATE bank.payout_batches SET status = 'submitted', file_sha256 = p_file_sha256, journal_id = v_journal,
         submitted_by = p_actor, submitted_at = clock_timestamp()
  WHERE id = b.id;
  PERFORM bank.audit_append(p_actor, 'batch.submitted', jsonb_build_object('batch', b.id, 'journal', v_journal, 'fileSha256', encode(p_file_sha256, 'hex')));
  RETURN v_journal;
END $$;

/** As in 0009; a held line was never sent, so it cannot come back. */
CREATE OR REPLACE FUNCTION bank.book_payout_return(p_event text, p jsonb, p_actor text) RETURNS text
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
  IF NOT FOUND OR it.held OR it.amount_paisa <> v_amount THEN
    RAISE EXCEPTION 'payout return does not match a paid line % of batch %', v_line, b.reference USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM bank.payout_returns WHERE batch_id = b.id AND line_no = v_line) THEN
    RETURN 'duplicate_return';
  END IF;
  v_journal := ledger.post_journal(format('bank:payout-return:%s:%s', b.reference, v_line), 'payout_return', p->>'reason', p->>'returnRef', p_actor,
    jsonb_build_array(jsonb_build_object('account', 'bank:trustee-escrow', 'amount', v_amount::text),
                      jsonb_build_object('account', 'rent:payable:' || it.subject_id, 'amount', (-v_amount)::text)));
  INSERT INTO bank.payout_returns (batch_id, line_no, event_id, return_ref, reason, journal_id)
  VALUES (b.id, v_line, p_event, p->>'returnRef', p->>'reason', v_journal);
  UPDATE bank.payees SET superseded_at = clock_timestamp() WHERE id = it.payee_id AND superseded_at IS NULL;
  PERFORM bank.audit_append(p_actor, 'payout.returned', jsonb_build_object('batch', b.id, 'line', v_line, 'ref', p->>'returnRef',
                                                                          'amount', v_amount::text, 'journal', v_journal));
  PERFORM pg_notify('bank_alert', json_build_object('kind', 'payout_returned', 'batch', b.id, 'line', v_line, 'subject', it.subject_id)::text);
  RETURN 'returned';
END $$;

/** As in 0009, with item digests checked per version (v2 covers the held flag). */
CREATE OR REPLACE FUNCTION bank.verify_audit() RETURNS TABLE (audit_id bigint, problem text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, bank AS $$
DECLARE
  a bank.audit;
  v_prev bytea := decode(repeat('00', 32), 'hex');
  c bank.credits;
  b bank.payout_batches;
  v_recomputed bytea;
  v_found boolean;
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
      v_found := FOUND;
      v_recomputed := NULL;
      IF v_found THEN
        v_recomputed := CASE WHEN b.items_digest_version = 2 THEN bank.items_digest_v2(b.id) ELSE sha256(convert_to('pt-payout-items-v1' || (
              SELECT jsonb_agg(jsonb_build_array(i.line_no, i.subject_id::text, i.payee_id, encode(p.iban_hash, 'hex'), i.amount_paisa::text) ORDER BY i.line_no)
              FROM bank.payout_items i JOIN bank.payees p ON p.id = i.payee_id WHERE i.batch_id = b.id)::text, 'UTF8')) END;
      END IF;
      IF NOT v_found OR b.total_paisa::text <> a.detail->>'total' OR encode(b.items_digest, 'hex') <> a.detail->>'itemsDigest'
         OR b.items_digest IS DISTINCT FROM v_recomputed
         OR (a.detail ? 'paid' AND b.paid_paisa::text <> a.detail->>'paid') THEN
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

REVOKE ALL ON FUNCTION bank.items_digest_v2_of(jsonb), bank.items_digest_v2(bigint), bank.create_followup_batch(text, bigint, jsonb, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION bank.create_followup_batch(text, bigint, jsonb, text) TO pt_bank_service;

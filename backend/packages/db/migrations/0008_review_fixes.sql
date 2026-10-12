-- Fixes for three findings from the Step 5f review (2026-10-12). Earlier migrations are never edited:
-- they are applied on the demo server. Everything here is additive or CREATE OR REPLACE.
--
--   RF-1  signer.verify_audit() depended on the session TimeZone: audit_digest put a raw timestamptz
--         into jsonb, whose text carries the session's UTC offset. A verifier in another TimeZone saw
--         every row as "content does not match its hash", which would wrongly freeze payouts.
--         Fix: new rows use digest v2 (UTC text, domain-separated). Existing rows are NOT re-hashed
--         (that would break the append-only record); they are verified by recomputing the legacy
--         digest under every real-world UTC offset. A match under any offset proves the content is
--         unchanged (SHA-256), so detection strength is kept and the TimeZone dependence is gone.
--   RF-2  ledger.post_journal's overdraft check (L-6) summed every posting of each touched account,
--         so writes slowed down as history grew (~14 ms per journal at 20,000 journals).
--         Fix: a running balance per account, updated in the same transaction, verified against the
--         postings by ledger.verify_balances() (wired into reconciliation as a blocking check).
--   RF-3  Validations of the form jsonb_typeof(x) <> 'string' are NULL (not true) for a missing
--         field, so the row slipped through. In chain.apply_batch a NULL p_events made the batch
--         valid and advanced the cursor past events that were never recorded (silent loss in the
--         read model). Fix: IS DISTINCT FROM, explicit NULL checks.

-- ================================================================== RF-1 signer audit
-- The legacy digest's result depends on the TimeZone setting: it was never IMMUTABLE.
ALTER FUNCTION signer.audit_digest(bytea, bigint, timestamptz, text, text, uuid, jsonb) STABLE;

-- Adding a column with a constant default rewrites no rows and fires no row triggers; existing rows
-- read as version 1. New rows are written as version 2 by audit_append below.
ALTER TABLE signer.audit ADD COLUMN digest_version smallint NOT NULL DEFAULT 1 CHECK (digest_version IN (1, 2));

CREATE FUNCTION signer.utc_text(p timestamptz) RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT to_char(p AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
$$;

CREATE FUNCTION signer.audit_digest_v2(p_prev bytea, p_id bigint, p_at timestamptz, p_actor text, p_action text, p_request uuid, p_detail jsonb)
RETURNS bytea LANGUAGE sql STABLE SET search_path = pg_catalog, signer AS $$
  SELECT sha256(p_prev || convert_to('pt-signer-audit-v2' || jsonb_build_array(p_id, signer.utc_text(p_at), p_actor, p_action, p_request, p_detail)::text, 'UTF8'))
$$;

CREATE OR REPLACE FUNCTION signer.audit_append(p_actor text, p_action text, p_request uuid, p_detail jsonb)
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
  INSERT INTO signer.audit (id, at, actor, action, request_id, detail, prev_hash, hash, digest_version)
  OVERRIDING SYSTEM VALUE
  VALUES (v_id, v_at, p_actor, p_action, p_request, coalesce(p_detail, '{}'::jsonb), v_prev,
          signer.audit_digest_v2(v_prev, v_id, v_at, p_actor, p_action, p_request, coalesce(p_detail, '{}'::jsonb)), 2);
  RETURN v_id;
END $$;

/**
 * True when a version-1 row's stored hash matches the legacy digest under some UTC offset.
 * Tries the session TimeZone and the cluster default first (the usual case), then every offset from
 * -12:00 to +14:00 in 15-minute steps. TimeZone changes are transaction-local and restored before
 * returning.
 */
CREATE FUNCTION signer.legacy_row_matches(a signer.audit) RETURNS boolean
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, signer AS $$
DECLARE
  v_saved text := current_setting('TimeZone');
  v_default text;
  m integer;
  v_ok boolean := false;
BEGIN
  IF a.hash = signer.audit_digest(a.prev_hash, a.id, a.at, a.actor, a.action, a.request_id, a.detail) THEN
    RETURN true;
  END IF;
  SELECT reset_val INTO v_default FROM pg_settings WHERE name = 'TimeZone';
  PERFORM set_config('TimeZone', v_default, true);
  v_ok := a.hash = signer.audit_digest(a.prev_hash, a.id, a.at, a.actor, a.action, a.request_id, a.detail);
  m := -720;
  WHILE NOT v_ok AND m <= 840 LOOP
    -- POSIX zone: '<+0530>-05:30' is UTC+05:30 (POSIX signs are inverted).
    PERFORM set_config('TimeZone',
      format('<%s%s%s>%s%s:%s',
        CASE WHEN m >= 0 THEN '+' ELSE '-' END, lpad((abs(m) / 60)::text, 2, '0'), lpad((abs(m) % 60)::text, 2, '0'),
        CASE WHEN m >= 0 THEN '-' ELSE '+' END, lpad((abs(m) / 60)::text, 2, '0'), lpad((abs(m) % 60)::text, 2, '0')),
      true);
    v_ok := a.hash = signer.audit_digest(a.prev_hash, a.id, a.at, a.actor, a.action, a.request_id, a.detail);
    m := m + 15;
  END LOOP;
  PERFORM set_config('TimeZone', v_saved, true);
  RETURN v_ok;
END $$;

CREATE OR REPLACE FUNCTION signer.verify_audit() RETURNS TABLE (audit_id bigint, problem text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, signer AS $$
DECLARE
  a signer.audit;
  v_prev bytea := decode(repeat('00', 32), 'hex');
  v_ok boolean;
BEGIN
  FOR a IN SELECT * FROM signer.audit ORDER BY id LOOP
    IF a.prev_hash <> v_prev THEN audit_id := a.id; problem := 'prev_hash does not match'; RETURN NEXT; END IF;
    IF a.digest_version = 2 THEN
      v_ok := a.hash = signer.audit_digest_v2(a.prev_hash, a.id, a.at, a.actor, a.action, a.request_id, a.detail);
    ELSE
      v_ok := signer.legacy_row_matches(a);
    END IF;
    IF NOT v_ok THEN audit_id := a.id; problem := 'content does not match its hash'; RETURN NEXT; END IF;
    v_prev := a.hash;
  END LOOP;
END $$;

REVOKE ALL ON FUNCTION signer.utc_text(timestamptz), signer.audit_digest_v2(bytea, bigint, timestamptz, text, text, uuid, jsonb),
  signer.legacy_row_matches(signer.audit) FROM PUBLIC;

-- ================================================================== RF-2 ledger running balances
CREATE TABLE ledger.account_balances (
  account_id      bigint PRIMARY KEY REFERENCES ledger.accounts (id),
  balance         bigint NOT NULL,
  last_journal_id bigint NOT NULL REFERENCES ledger.journal (id)
);

-- Backfill from the postings. Done under the writer lock, so no journal can land half-counted.
SELECT pg_advisory_xact_lock(586586002);
INSERT INTO ledger.account_balances (account_id, balance, last_journal_id)
SELECT account_id, sum(amount), max(journal_id) FROM ledger.postings GROUP BY account_id;

-- Rows are only ever moved forward by post_journal; never deleted.
CREATE FUNCTION ledger.balance_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.account_id = OLD.account_id AND NEW.last_journal_id > OLD.last_journal_id THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ledger.account_balances: % is not allowed (rows only move forward with a journal)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER account_balances_forward_only BEFORE UPDATE OR DELETE ON ledger.account_balances
  FOR EACH ROW EXECUTE FUNCTION ledger.balance_guard();
CREATE TRIGGER account_balances_no_truncate BEFORE TRUNCATE ON ledger.account_balances
  FOR EACH STATEMENT EXECUTE FUNCTION ledger.balance_guard();

CREATE OR REPLACE FUNCTION ledger.post_journal(
  p_key text, p_kind text, p_memo text, p_ref text, p_created_by text, p_postings jsonb
) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, ledger AS $$
DECLARE
  v_payload  bytea := sha256(convert_to(jsonb_build_array(p_kind, p_memo, p_ref, p_created_by, p_postings)::text, 'UTF8'));
  v_existing ledger.journal;
  v_rows     jsonb;
  v_count    int;
  v_prev     bytea;
  v_id       bigint;
  v_now      timestamptz := date_trunc('microseconds', clock_timestamp());
  v_bad      text;
  r          record;
BEGIN
  -- One writer at a time keeps the hash chain strictly linear (and the running balances exact).
  PERFORM pg_advisory_xact_lock(586586002);

  -- L-5 idempotency
  SELECT * INTO v_existing FROM ledger.journal WHERE idempotency_key = p_key;
  IF FOUND THEN
    IF v_existing.payload_hash = v_payload THEN
      RETURN v_existing.id;
    END IF;
    RAISE EXCEPTION 'idempotency key % was already used for a different journal', p_key USING ERRCODE = 'unique_violation';
  END IF;

  -- Shape: an array of at least two {"account": code, "amount": "<non-zero integer as string>"}.
  -- RF-3: IS DISTINCT FROM so that a missing field counts as malformed (NULL is not "not equal").
  IF jsonb_typeof(p_postings) IS DISTINCT FROM 'array' OR jsonb_array_length(p_postings) < 2 THEN
    RAISE EXCEPTION 'a journal needs at least two postings' USING ERRCODE = 'check_violation';
  END IF;
  SELECT string_agg(ord::text, ',') INTO v_bad
  FROM jsonb_array_elements(p_postings) WITH ORDINALITY AS t(e, ord)
  WHERE jsonb_typeof(e) IS DISTINCT FROM 'object'
     OR jsonb_typeof(e -> 'account') IS DISTINCT FROM 'string'
     OR jsonb_typeof(e -> 'amount') IS DISTINCT FROM 'string'
     OR (e ->> 'amount') !~ '^-?[1-9][0-9]{0,17}$';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'malformed posting(s) at position %: amount must be a non-zero integer string', v_bad
      USING ERRCODE = 'check_violation';
  END IF;

  -- Resolve accounts; reject unknown or repeated accounts.
  SELECT jsonb_agg(jsonb_build_array(a.id, a.asset, (t.e ->> 'amount')) ORDER BY t.ord),
         count(*) FILTER (WHERE a.id IS NULL)
    INTO v_rows, v_count
  FROM jsonb_array_elements(p_postings) WITH ORDINALITY AS t(e, ord)
  LEFT JOIN ledger.accounts a ON a.code = t.e ->> 'account';
  IF v_count > 0 THEN
    RAISE EXCEPTION 'unknown account in postings' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF (SELECT count(DISTINCT e ->> 'account') FROM jsonb_array_elements(p_postings) e) <> jsonb_array_length(p_postings) THEN
    RAISE EXCEPTION 'an account may appear only once per journal' USING ERRCODE = 'check_violation';
  END IF;

  -- L-1 balance per asset
  SELECT string_agg(asset || '=' || total::text, ', ') INTO v_bad
  FROM (
    SELECT p ->> 1 AS asset, sum((p ->> 2)::bigint) AS total
    FROM jsonb_array_elements(v_rows) p
    GROUP BY p ->> 1
  ) s
  WHERE total <> 0;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'journal does not balance: %', v_bad USING ERRCODE = 'check_violation';
  END IF;

  -- L-4 chain
  SELECT hash INTO v_prev FROM ledger.journal ORDER BY id DESC LIMIT 1;
  v_prev := coalesce(v_prev, decode(repeat('00', 32), 'hex'));
  v_id := nextval(pg_get_serial_sequence('ledger.journal', 'id'));

  INSERT INTO ledger.journal (id, idempotency_key, kind, memo, external_ref, created_by, created_at, payload_hash, prev_hash, hash)
  OVERRIDING SYSTEM VALUE
  VALUES (v_id, p_key, p_kind, p_memo, p_ref, p_created_by, v_now, v_payload, v_prev,
          ledger.digest(v_prev, v_id, p_key, p_kind, p_memo, p_ref, p_created_by, v_now, v_rows));

  -- Insert postings one by one so their ids follow the hashed order exactly; move each running
  -- balance forward in the same statement order.
  FOR r IN SELECT p, ord FROM jsonb_array_elements(v_rows) WITH ORDINALITY AS t(p, ord) ORDER BY ord LOOP
    INSERT INTO ledger.postings (journal_id, account_id, asset, amount)
    VALUES (v_id, (r.p ->> 0)::bigint, r.p ->> 1, (r.p ->> 2)::bigint);
    INSERT INTO ledger.account_balances (account_id, balance, last_journal_id)
    VALUES ((r.p ->> 0)::bigint, (r.p ->> 2)::bigint, v_id)
    ON CONFLICT (account_id) DO UPDATE
      SET balance = ledger.account_balances.balance + EXCLUDED.balance, last_journal_id = EXCLUDED.last_journal_id;
  END LOOP;

  -- L-6 no overdraft on protected accounts touched by this journal: O(accounts in this journal),
  -- independent of history length (RF-2).
  SELECT string_agg(a.code, ', ') INTO v_bad
  FROM ledger.accounts a
  JOIN ledger.account_balances b ON b.account_id = a.id
  WHERE b.account_id IN (SELECT (p ->> 0)::bigint FROM jsonb_array_elements(v_rows) p)
    AND NOT a.allow_overdraft
    AND ((a.normal_side = 'debit' AND b.balance < 0) OR (a.normal_side = 'credit' AND b.balance > 0));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'insufficient balance on: %', v_bad USING ERRCODE = 'check_violation';
  END IF;

  RETURN v_id;
END $$;

/** Accounts whose running balance differs from the sum of their postings. Empty = consistent. */
CREATE FUNCTION ledger.verify_balances()
RETURNS TABLE (account_id bigint, code text, cached bigint, actual bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, ledger AS $$
  SELECT a.id, a.code, b.balance, coalesce(p.total, 0)::bigint
  FROM ledger.accounts a
  LEFT JOIN ledger.account_balances b ON b.account_id = a.id
  LEFT JOIN (SELECT account_id, sum(amount) AS total FROM ledger.postings GROUP BY account_id) p ON p.account_id = a.id
  WHERE b.balance IS DISTINCT FROM p.total
  ORDER BY a.id
$$;

-- Reads now come from the running balance (no GROUP BY over all postings).
CREATE OR REPLACE VIEW ledger.balances AS
SELECT a.id AS account_id, a.code, a.kind, a.asset, a.normal_side,
       coalesce(b.balance, 0)::bigint AS balance
FROM ledger.accounts a
LEFT JOIN ledger.account_balances b ON b.account_id = a.id;

REVOKE ALL ON ledger.account_balances FROM PUBLIC;
REVOKE ALL ON FUNCTION ledger.verify_balances() FROM PUBLIC;
GRANT SELECT ON ledger.account_balances TO pt_ledger_reader;
GRANT EXECUTE ON FUNCTION ledger.verify_balances() TO pt_ledger_reader;

-- ================================================================== RF-3 indexer batch validation
-- Same function as 0005 except the NULL-safe checks marked RF-3; CREATE OR REPLACE keeps its grants.
CREATE OR REPLACE FUNCTION chain.apply_batch(
  p_deployment text, p_expected_block bigint, p_to_block bigint, p_to_hash text, p_blocks jsonb, p_events jsonb
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, chain AS $$
DECLARE
  c chain.cursors;
  b jsonb;
  e jsonb;
  v_first boolean := true;
  v_prev_number bigint;
  v_prev_hash text;
  v_number bigint;
  v_hash text;
  v_parent text;
  v_stored text;
  v_role text;
  v_address text;
  v_last_block bigint := -1;
  v_last_log integer := -1;
  v_log integer;
  v_n integer := 0;
BEGIN
  SELECT * INTO c FROM chain.cursors WHERE deployment = p_deployment FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown deployment %', p_deployment USING ERRCODE = 'check_violation';
  END IF;
  IF c.halted_at IS NOT NULL THEN
    RAISE EXCEPTION 'deployment % is halted: %', p_deployment, c.halt_reason USING ERRCODE = 'PTC04';
  END IF;
  IF c.block_number IS DISTINCT FROM p_expected_block THEN
    RAISE EXCEPTION 'cursor of % is at %, not %', p_deployment, c.block_number, p_expected_block USING ERRCODE = 'PTC01';
  END IF;
  -- IS DISTINCT FROM, not <>: a NULL argument must count as invalid. With <> a NULL p_events made
  -- this whole condition NULL, the batch was accepted and the cursor advanced past events never
  -- recorded (fixed in 0008).
  IF p_to_block IS NULL OR p_to_block <= c.block_number
     OR jsonb_typeof(p_blocks) IS DISTINCT FROM 'array' OR jsonb_typeof(p_events) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_blocks) = 0 OR p_to_hash IS NULL THEN
    RAISE EXCEPTION 'invalid batch' USING ERRCODE = 'check_violation';
  END IF;

  -- C-2: blocks.
  FOR b IN SELECT value FROM jsonb_array_elements(p_blocks) LOOP
    v_number := (b->>'number')::bigint;
    v_hash := lower(b->>'hash');
    v_parent := lower(b->>'parentHash');
    IF jsonb_typeof(b) IS DISTINCT FROM 'object' OR v_number IS NULL OR v_hash IS NULL OR v_parent IS NULL
       OR jsonb_typeof(b->'timestamp') IS NULL THEN
      RAISE EXCEPTION 'malformed block in batch' USING ERRCODE = 'check_violation';
    END IF;
    IF v_first THEN
      IF v_number <> c.block_number + 1 THEN
        RAISE EXCEPTION 'batch must start at block %, not %', c.block_number + 1, v_number USING ERRCODE = 'check_violation';
      END IF;
      IF c.block_hash IS NOT NULL AND v_parent IS DISTINCT FROM c.block_hash THEN
        RAISE EXCEPTION 'chain mismatch: block % names parent %, but block % was recorded as %',
          v_number, v_parent, c.block_number, c.block_hash USING ERRCODE = 'PTC02';
      END IF;
    ELSE
      IF v_number <= v_prev_number OR v_number > p_to_block THEN
        RAISE EXCEPTION 'batch blocks must ascend within the batch' USING ERRCODE = 'check_violation';
      END IF;
      IF v_number = v_prev_number + 1 AND v_parent IS DISTINCT FROM v_prev_hash THEN
        RAISE EXCEPTION 'chain mismatch: block % does not link to block %', v_number, v_prev_number USING ERRCODE = 'PTC02';
      END IF;
    END IF;
    INSERT INTO chain.blocks (number, hash, parent_hash, block_time)
    VALUES (v_number, v_hash, v_parent, to_timestamp((b->>'timestamp')::bigint))
    ON CONFLICT (number) DO NOTHING;
    SELECT hash INTO v_stored FROM chain.blocks WHERE number = v_number;
    IF v_stored IS DISTINCT FROM v_hash THEN
      RAISE EXCEPTION 'chain mismatch: block % was recorded as %, now %', v_number, v_stored, v_hash USING ERRCODE = 'PTC02';
    END IF;
    v_first := false;
    v_prev_number := v_number;
    v_prev_hash := v_hash;
  END LOOP;
  IF v_prev_number <> p_to_block OR v_prev_hash IS DISTINCT FROM lower(p_to_hash) THEN
    RAISE EXCEPTION 'the last batch block must be % with hash %', p_to_block, p_to_hash USING ERRCODE = 'check_violation';
  END IF;

  -- Events, strictly ordered, each on a recorded block of this batch.
  FOR e IN SELECT value FROM jsonb_array_elements(p_events) LOOP
    v_number := (e->>'blockNumber')::bigint;
    v_log := (e->>'logIndex')::integer;
    IF jsonb_typeof(e) IS DISTINCT FROM 'object' OR v_number IS NULL OR v_log IS NULL
       OR e->>'blockHash' IS NULL OR e->>'address' IS NULL OR e->>'txHash' IS NULL THEN
      RAISE EXCEPTION 'malformed event in batch' USING ERRCODE = 'check_violation';
    END IF;
    IF v_number <= c.block_number OR v_number > p_to_block
       OR v_number < v_last_block OR (v_number = v_last_block AND v_log <= v_last_log) THEN
      RAISE EXCEPTION 'events must be ordered and inside the batch (block %, log %)', v_number, v_log USING ERRCODE = 'check_violation';
    END IF;
    SELECT hash INTO v_stored FROM chain.blocks WHERE number = v_number;
    IF v_stored IS DISTINCT FROM lower(e->>'blockHash') THEN
      RAISE EXCEPTION 'chain mismatch: event at block % log % has block hash %, recorded %',
        v_number, v_log, e->>'blockHash', v_stored USING ERRCODE = 'PTC02';
    END IF;
    v_address := lower(e->>'address');
    SELECT role INTO v_role FROM chain.contracts WHERE deployment = p_deployment AND address = v_address;
    IF v_role IS NULL THEN
      RAISE EXCEPTION 'event from % is not from a contract of %', v_address, p_deployment USING ERRCODE = 'check_violation';
    END IF;
    INSERT INTO chain.events (deployment, block_number, log_index, block_hash, tx_hash, tx_index, address, contract, name, args, topics, data)
    VALUES (p_deployment, v_number, v_log, lower(e->>'blockHash'), lower(e->>'txHash'), (e->>'txIndex')::integer, v_address, v_role,
            e->>'name', CASE WHEN e->>'name' IS NULL THEN NULL ELSE e->'args' END,
            ARRAY(SELECT lower(t) FROM jsonb_array_elements_text(e->'topics') AS t), lower(e->>'data'));
    PERFORM chain.derive(p_deployment, v_role, v_address, e->>'name', e->'args', v_number, v_log, lower(e->>'txHash'));
    v_last_block := v_number;
    v_last_log := v_log;
    v_n := v_n + 1;
  END LOOP;

  UPDATE chain.cursors
  SET block_number = p_to_block, block_hash = lower(p_to_hash), batches = batches + 1, events = events + v_n, updated_at = now()
  WHERE deployment = p_deployment;

  IF v_n > 0 THEN
    PERFORM pg_notify('chain_events', json_build_object('deployment', p_deployment, 'toBlock', p_to_block, 'events', v_n)::text);
  END IF;
  RETURN v_n;
END $$;

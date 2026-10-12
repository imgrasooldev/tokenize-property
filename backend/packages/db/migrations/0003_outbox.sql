-- Outbox (Step 5c): commands for the chain, written in the same transaction as the business change.
--
-- Safety properties enforced by the database itself:
--   O-1  A command is written atomically with the business change that needs it (same transaction);
--        rolling back the business change removes the command.
--   O-2  Idempotent enqueue: the same key with the same kind and payload returns the original
--        command; the same key with anything different is refused.
--   O-3  Kind, payload, key and reference never change after enqueue; rows are never deleted.
--   O-4  Status moves only along allowed edges; confirmed and failed are final.
--   O-5  A worker owns a command only through an unexpired lease. A transaction is recorded
--        (hash, nonce, sender) BEFORE it is broadcast, and only by the current lease owner of a
--        claimed command. So at most one transaction per attempt can ever be broadcast, and after a
--        lease is lost the old worker can no longer record (and therefore must not broadcast).
--   O-6  A recorded transaction is cleared only when it is proven dropped (submitted -> pending).
--   O-7  Every change is written to outbox.command_events (append-only).
-- Execution is at-least-once per attempt; exactly-once on chain follows from O-5/O-6 plus the
-- resolution rules in @pt/outbox (see ADR 0004).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pt_outbox_writer') THEN CREATE ROLE pt_outbox_writer NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pt_outbox_worker') THEN CREATE ROLE pt_outbox_worker NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pt_outbox_operator') THEN CREATE ROLE pt_outbox_operator NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pt_outbox_reader') THEN CREATE ROLE pt_outbox_reader NOLOGIN; END IF;
END $$;

-- ------------------------------------------------------------------ tables
CREATE TABLE outbox.commands (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  kind            text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$' AND length(kind) <= 64),
  payload         jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 16384),
  payload_hash    bytea NOT NULL CHECK (length(payload_hash) = 32),
  ref             text CHECK (length(ref) <= 200),
  created_by      text NOT NULL CHECK (length(created_by) BETWEEN 1 AND 100),
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'claimed', 'submitted', 'confirmed', 'failed', 'review')),
  attempts        integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts    integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
  available_at    timestamptz NOT NULL DEFAULT now(),
  lease_owner     text CHECK (length(lease_owner) <= 100),
  lease_until     timestamptz,
  tx_hash         text CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
  tx_nonce        bigint CHECK (tx_nonce >= 0),
  tx_from         text CHECK (tx_from ~ '^0x[0-9a-f]{40}$'),
  submitted_at    timestamptz,
  result          jsonb CHECK (result IS NULL OR octet_length(result::text) <= 4096),
  last_error      text CHECK (length(last_error) <= 500),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- A recorded transaction is complete or absent, never partial.
  CHECK ((tx_hash IS NULL) = (tx_nonce IS NULL) AND (tx_hash IS NULL) = (tx_from IS NULL)),
  -- Submitted and confirmed commands always carry their transaction.
  CHECK (status NOT IN ('submitted', 'confirmed') OR tx_hash IS NOT NULL),
  -- Claimed and submitted commands are always leased.
  CHECK (status NOT IN ('claimed', 'submitted') OR (lease_owner IS NOT NULL AND lease_until IS NOT NULL))
);

CREATE INDEX commands_ready_idx ON outbox.commands (available_at, id) WHERE status = 'pending';
CREATE INDEX commands_leased_idx ON outbox.commands (lease_until) WHERE status IN ('claimed', 'submitted');
CREATE INDEX commands_ref_idx ON outbox.commands (ref) WHERE ref IS NOT NULL;

CREATE TABLE outbox.command_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  command_id  bigint NOT NULL REFERENCES outbox.commands (id),
  at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  from_status text,
  to_status   text NOT NULL,
  actor       text NOT NULL,
  tx_hash     text,
  detail      text CHECK (length(detail) <= 500)
);
CREATE INDEX command_events_command_idx ON outbox.command_events (command_id, id);

-- ------------------------------------------------------------------ O-3/O-4/O-6/O-7 triggers
CREATE FUNCTION outbox.forbid_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'outbox is append-only: % on %.% is not allowed', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE TRIGGER commands_no_delete BEFORE DELETE ON outbox.commands FOR EACH ROW EXECUTE FUNCTION outbox.forbid_delete();
CREATE TRIGGER commands_no_truncate BEFORE TRUNCATE ON outbox.commands FOR EACH STATEMENT EXECUTE FUNCTION outbox.forbid_delete();
CREATE TRIGGER events_no_change BEFORE UPDATE OR DELETE ON outbox.command_events FOR EACH ROW EXECUTE FUNCTION outbox.forbid_delete();
CREATE TRIGGER events_no_truncate BEFORE TRUNCATE ON outbox.command_events FOR EACH STATEMENT EXECUTE FUNCTION outbox.forbid_delete();

CREATE FUNCTION outbox.guard_update() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  edge text := OLD.status || '>' || NEW.status;
BEGIN
  IF NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.payload IS DISTINCT FROM OLD.payload OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash
     OR NEW.ref IS DISTINCT FROM OLD.ref OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'outbox command % is immutable except for its processing state', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status IN ('confirmed', 'failed') THEN
    RAISE EXCEPTION 'outbox command % is final (%)', OLD.id, OLD.status USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> NEW.status AND edge NOT IN (
       'pending>claimed',
       'claimed>pending', 'claimed>submitted', 'claimed>failed', 'claimed>review',
       'submitted>confirmed', 'submitted>failed', 'submitted>pending', 'submitted>review',
       'review>pending', 'review>failed', 'review>confirmed') THEN
    RAISE EXCEPTION 'outbox command %: transition % is not allowed', OLD.id, edge USING ERRCODE = 'check_violation';
  END IF;
  -- O-5/O-6: the transaction may be set only on claimed -> submitted, and cleared only on
  -- submitted -> pending (proven dropped). Nothing else may touch it.
  IF NEW.tx_hash IS DISTINCT FROM OLD.tx_hash OR NEW.tx_nonce IS DISTINCT FROM OLD.tx_nonce
     OR NEW.tx_from IS DISTINCT FROM OLD.tx_from THEN
    IF NOT ((edge = 'claimed>submitted' AND OLD.tx_hash IS NULL)
            OR (edge = 'submitted>pending' AND NEW.tx_hash IS NULL)) THEN
      RAISE EXCEPTION 'outbox command %: transaction fields can change only when submitting or after a proven drop', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$;

CREATE TRIGGER commands_guard BEFORE UPDATE ON outbox.commands FOR EACH ROW EXECUTE FUNCTION outbox.guard_update();

CREATE FUNCTION outbox.log_event() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status OR OLD.tx_hash IS DISTINCT FROM NEW.tx_hash THEN
    INSERT INTO outbox.command_events (command_id, from_status, to_status, actor, tx_hash, detail)
    VALUES (NEW.id, CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.status END, NEW.status,
            coalesce(nullif(current_setting('outbox.actor', true), ''), NEW.lease_owner, NEW.created_by),
            NEW.tx_hash, NEW.last_error);
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER commands_log AFTER INSERT OR UPDATE ON outbox.commands FOR EACH ROW EXECUTE FUNCTION outbox.log_event();

-- ------------------------------------------------------------------ API (SECURITY DEFINER)
-- Canonical hash of what a command does, for the idempotency comparison.
CREATE FUNCTION outbox.command_hash(p_kind text, p_payload jsonb, p_ref text) RETURNS bytea
-- Not STRICT: p_ref may be NULL, and STRICT would turn the whole hash into NULL.
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT sha256(convert_to(jsonb_build_array(p_kind, p_payload, coalesce(p_ref, ''))::text, 'UTF8'))
$$;

/** O-1/O-2: call inside the business transaction. */
CREATE FUNCTION outbox.enqueue(
  p_key text, p_kind text, p_payload jsonb, p_ref text, p_created_by text, p_max_attempts integer DEFAULT 5
) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, outbox AS $$
DECLARE
  v_hash bytea := outbox.command_hash(p_kind, coalesce(p_payload, 'null'::jsonb), p_ref);
  v_existing outbox.commands;
  v_id bigint;
BEGIN
  IF p_kind IS NULL OR p_payload IS NULL OR p_created_by IS NULL THEN
    RAISE EXCEPTION 'kind, payload and created_by are required' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO outbox.commands (idempotency_key, kind, payload, payload_hash, ref, created_by, max_attempts)
  VALUES (p_key, p_kind, p_payload, v_hash, p_ref, p_created_by, coalesce(p_max_attempts, 5))
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    SELECT * INTO v_existing FROM outbox.commands WHERE idempotency_key = p_key;
    IF v_existing.payload_hash <> v_hash THEN
      RAISE EXCEPTION 'idempotency key % was already used for a different command', p_key USING ERRCODE = 'unique_violation';
    END IF;
    RETURN v_existing.id;
  END IF;
  -- Wakes workers at commit (NOTIFY is transactional), so an aborted business change never wakes anyone.
  PERFORM pg_notify('outbox', v_id::text);
  RETURN v_id;
END $$;

/**
 * Leases up to p_batch commands to p_worker:
 *  - pending commands that are due (attempts + 1);
 *  - claimed commands whose lease expired go back to pending first (nothing was recorded, so
 *    nothing was broadcast by them);
 *  - submitted commands whose lease expired are re-leased as-is, for resolution from the chain.
 * Uses SKIP LOCKED, so concurrent workers never receive the same command.
 */
CREATE FUNCTION outbox.claim(p_worker text, p_batch integer, p_lease_seconds integer)
RETURNS SETOF outbox.commands
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, outbox AS $$
BEGIN
  IF p_worker IS NULL OR length(p_worker) NOT BETWEEN 1 AND 100 OR p_batch NOT BETWEEN 1 AND 100
     OR p_lease_seconds NOT BETWEEN 5 AND 3600 THEN
    RAISE EXCEPTION 'invalid claim arguments' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM set_config('outbox.actor', p_worker, true);

  UPDATE outbox.commands c SET status = 'pending', lease_owner = NULL, lease_until = NULL,
         last_error = 'lease expired before submission'
  WHERE c.id IN (SELECT id FROM outbox.commands WHERE status = 'claimed' AND lease_until < now()
                 FOR UPDATE SKIP LOCKED);

  RETURN QUERY
  WITH due AS (
    SELECT id FROM outbox.commands
    WHERE (status = 'pending' AND available_at <= now())
       OR (status = 'submitted' AND lease_until < now())
    ORDER BY id
    FOR UPDATE SKIP LOCKED
    LIMIT p_batch
  )
  UPDATE outbox.commands c
  SET status = CASE WHEN c.status = 'pending' THEN 'claimed' ELSE c.status END,
      attempts = CASE WHEN c.status = 'pending' THEN c.attempts + 1 ELSE c.attempts END,
      lease_owner = p_worker,
      lease_until = now() + make_interval(secs => p_lease_seconds)
  FROM due WHERE c.id = due.id
  RETURNING c.*;
END $$;

/** O-5: records the signed transaction BEFORE broadcast. False = lease lost: do not broadcast. */
CREATE FUNCTION outbox.record_submission(p_id bigint, p_worker text, p_hash text, p_nonce bigint, p_from text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, outbox AS $$
DECLARE
  n integer;
BEGIN
  PERFORM set_config('outbox.actor', p_worker, true);
  UPDATE outbox.commands
  SET status = 'submitted', tx_hash = lower(p_hash), tx_nonce = p_nonce, tx_from = lower(p_from),
      submitted_at = now(), last_error = NULL
  WHERE id = p_id AND status = 'claimed' AND lease_owner = p_worker AND lease_until > now();
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n = 1;
END $$;

/** The recorded transaction succeeded. */
CREATE FUNCTION outbox.complete(p_id bigint, p_worker text, p_result jsonb)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, outbox AS $$
DECLARE
  n integer;
BEGIN
  PERFORM set_config('outbox.actor', p_worker, true);
  UPDATE outbox.commands SET status = 'confirmed', result = p_result, lease_owner = NULL, lease_until = NULL, last_error = NULL
  WHERE id = p_id AND status = 'submitted' AND lease_owner = p_worker;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n = 1;
END $$;

/**
 * Nothing was broadcast in this attempt (refused or transient error before sending).
 * Retryable and attempts left: back to pending with exponential backoff (2^attempts s, max 5 min).
 * Not retryable: failed. Out of attempts: review.
 */
CREATE FUNCTION outbox.release(p_id bigint, p_worker text, p_error text, p_retryable boolean)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, outbox AS $$
DECLARE
  c outbox.commands;
  v_next text;
BEGIN
  PERFORM set_config('outbox.actor', p_worker, true);
  SELECT * INTO c FROM outbox.commands WHERE id = p_id AND status = 'claimed' AND lease_owner = p_worker FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  v_next := CASE WHEN NOT p_retryable THEN 'failed' WHEN c.attempts >= c.max_attempts THEN 'review' ELSE 'pending' END;
  UPDATE outbox.commands
  SET status = v_next, lease_owner = NULL, lease_until = NULL, last_error = left(p_error, 500),
      available_at = CASE WHEN v_next = 'pending' THEN now() + make_interval(secs => least(300, power(2, c.attempts)::int)) ELSE available_at END
  WHERE id = p_id;
  RETURN v_next;
END $$;

/**
 * Resolution of a submitted command from the chain:
 *   'reverted' -> failed (final);  'dropped' -> pending (transaction cleared, retried);
 *   'review'   -> review (operations decide).
 */
CREATE FUNCTION outbox.resolve(p_id bigint, p_worker text, p_outcome text, p_detail text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, outbox AS $$
DECLARE
  v_next text := CASE p_outcome WHEN 'reverted' THEN 'failed' WHEN 'dropped' THEN 'pending' WHEN 'review' THEN 'review' END;
  n integer;
BEGIN
  IF v_next IS NULL THEN RAISE EXCEPTION 'unknown outcome %', p_outcome USING ERRCODE = 'check_violation'; END IF;
  PERFORM set_config('outbox.actor', p_worker, true);
  UPDATE outbox.commands
  SET status = v_next, last_error = left(p_detail, 500), lease_owner = NULL, lease_until = NULL,
      tx_hash = CASE WHEN v_next = 'pending' THEN NULL ELSE tx_hash END,
      tx_nonce = CASE WHEN v_next = 'pending' THEN NULL ELSE tx_nonce END,
      tx_from = CASE WHEN v_next = 'pending' THEN NULL ELSE tx_from END,
      submitted_at = CASE WHEN v_next = 'pending' THEN NULL ELSE submitted_at END,
      available_at = now()
  WHERE id = p_id AND status = 'submitted' AND lease_owner = p_worker;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN CASE WHEN n = 1 THEN v_next END;
END $$;

/** Keeps a submitted command leased a little longer while its transaction is still pending. */
CREATE FUNCTION outbox.extend_lease(p_id bigint, p_worker text, p_seconds integer)
RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, outbox AS $$
  WITH u AS (
    UPDATE outbox.commands SET lease_until = now() + make_interval(secs => least(greatest(p_seconds, 5), 3600))
    WHERE id = p_id AND status IN ('claimed', 'submitted') AND lease_owner = p_worker AND lease_until > now()
    RETURNING 1)
  SELECT count(*) = 1 FROM u
$$;

/** Operations decision on a command in review: retry it, fail it, or confirm it with evidence. */
CREATE FUNCTION outbox.operator_decide(p_id bigint, p_operator text, p_decision text, p_reason text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, outbox AS $$
DECLARE
  n integer;
BEGIN
  IF p_decision NOT IN ('retry', 'fail', 'confirm') OR p_reason IS NULL OR length(p_reason) < 10 THEN
    RAISE EXCEPTION 'decision must be retry, fail or confirm, with a reason of at least 10 characters'
      USING ERRCODE = 'check_violation';
  END IF;
  PERFORM set_config('outbox.actor', 'operator:' || p_operator, true);
  UPDATE outbox.commands
  SET status = CASE p_decision WHEN 'retry' THEN 'pending' WHEN 'fail' THEN 'failed' ELSE 'confirmed' END,
      last_error = left(p_reason, 500), attempts = CASE WHEN p_decision = 'retry' THEN 0 ELSE attempts END,
      available_at = now()
  -- Retrying a command that has a recorded transaction is refused: that transaction might still
  -- be mined. Confirming needs one (the evidence).
  WHERE id = p_id AND status = 'review'
    AND (p_decision <> 'retry' OR tx_hash IS NULL)
    AND (p_decision <> 'confirm' OR tx_hash IS NOT NULL);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n = 1;
END $$;

/** Queue health for monitoring. */
CREATE FUNCTION outbox.stats()
RETURNS TABLE (status text, commands bigint, oldest_seconds double precision)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, outbox AS $$
  SELECT status, count(*), extract(epoch FROM now() - min(updated_at))
  FROM outbox.commands GROUP BY status
$$;

-- ------------------------------------------------------------------ privileges
REVOKE ALL ON ALL TABLES IN SCHEMA outbox FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA outbox FROM PUBLIC;

GRANT USAGE ON SCHEMA outbox TO pt_outbox_writer, pt_outbox_worker, pt_outbox_operator, pt_outbox_reader;
GRANT EXECUTE ON FUNCTION outbox.enqueue(text, text, jsonb, text, text, integer) TO pt_outbox_writer;
GRANT EXECUTE ON FUNCTION
  outbox.claim(text, integer, integer),
  outbox.record_submission(bigint, text, text, bigint, text),
  outbox.complete(bigint, text, jsonb),
  outbox.release(bigint, text, text, boolean),
  outbox.resolve(bigint, text, text, text),
  outbox.extend_lease(bigint, text, integer)
  TO pt_outbox_worker;
GRANT EXECUTE ON FUNCTION outbox.operator_decide(bigint, text, text, text) TO pt_outbox_operator;
GRANT EXECUTE ON FUNCTION outbox.stats() TO pt_outbox_reader, pt_outbox_operator;
GRANT SELECT ON outbox.commands, outbox.command_events TO pt_outbox_reader, pt_outbox_operator;

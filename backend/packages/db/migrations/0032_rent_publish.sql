-- Rent publication and finalisation through the backend (T-022, ADR 0005 amendment 2026-10-29).
-- Applies on top of 0031 (platform roles).
--
-- Until now an approved S-03 distribution was published on chain by hand (chain/rent.py with the
-- Ops Safe key). Two signer kinds replace that path:
--
--   RP-1  rent.publish: DistributionRegistry.publish(token, recordBlock, root, total, statementHash)
--         with the Ops key. The operator enqueues it with ops.request_publish(calculation, actor),
--         which builds the payload from the APPROVED calculation itself (record block, Merkle root,
--         statement hash, total = sum of net entitlements) and the token's own registry, so nobody
--         types the numbers. The signer allows it only if ops.publish_allowed(payload) confirms that
--         this exact command was enqueued and the calculation is still approved and unpublished.
--   RP-2  At most one live publication per calculation: a non-rejected on-chain distribution with the
--         same registry and statement hash, or another enqueued publish command, is refused. A
--         distribution the trustee rejected on chain may be recalculated and published again.
--   RP-3  rent.finalize: DistributionRegistry.finalize(id). Enqueued with
--         ops.request_finalize(registry, id, actor); the signer allows it only if
--         ops.finalize_allowed(payload) confirms the command, the distribution is published (read
--         model), its 48-hour challenge window has closed, the trustee has not rejected it
--         (trustee.distribution_blocked) and it matches an approved or booked calculation.
--   RP-4  Both kinds start with "rent.", so the reconciliation payout gate applies on top of their
--         policies (ADR 0007): nothing is published or finalised while payouts are frozen.
--   RP-5  Every request is in the ops audit chain (distribution.publish_requested,
--         distribution.finalize_requested).

-- ================================================================== RP-1 publication
/** The publish payload of an approved calculation, from its own data; NULL if it cannot be built. */
CREATE FUNCTION ops.publish_payload(p_id bigint) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, ops AS $$
  SELECT jsonb_build_object('registry', k.address, 'token', d.token, 'recordBlock', d.record_block::text, 'merkleRoot', d.merkle_root,
                            'totalPaisa', d.sum_net::text, 'statementHash', d.statement_hash, 'calculation', d.id::text)
  FROM ops.distributions d
  JOIN chain.tokens t ON t.token = d.token
  JOIN chain.contracts k ON k.deployment = t.deployment AND k.role = 'distributions'
  WHERE d.id = p_id AND d.merkle_root IS NOT NULL AND d.statement_hash IS NOT NULL
$$;

/** Why calculation p_id cannot be published now (NULL = it can); p_payload is the command to check, or NULL. */
CREATE FUNCTION ops.publish_problem(p_id bigint, p_payload jsonb) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, ops AS $$
DECLARE
  d ops.distributions;
  v_payload jsonb := ops.publish_payload(p_id);
BEGIN
  SELECT * INTO d FROM ops.distributions WHERE id = p_id;
  IF NOT FOUND THEN RETURN 'unknown distribution calculation'; END IF;
  IF d.status <> 'approved' THEN RETURN format('the calculation is %s, not approved', d.status); END IF;
  IF v_payload IS NULL THEN RETURN 'no DistributionRegistry is known for the token, or the statement is not attached'; END IF;
  IF d.sum_net <= 0 THEN RETURN 'nothing to distribute after withholding'; END IF;
  IF p_payload IS NOT NULL AND p_payload <> v_payload THEN RETURN 'the payload differs from the approved calculation'; END IF;
  IF EXISTS (SELECT 1 FROM chain.distributions c WHERE c.registry = v_payload->>'registry' AND c.statement_hash = d.statement_hash
             AND c.status <> 'rejected') THEN
    RETURN 'this statement is already published on chain';
  END IF;
  RETURN NULL;
END $$;

/** Operator: enqueue the on-chain publication of an approved calculation (RP-1, RP-2). Returns the outbox command. */
CREATE FUNCTION ops.request_publish(p_id bigint, p_actor text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, ops AS $$
DECLARE
  v_problem text;
  v_payload jsonb;
  v_key text;
  v_cmd bigint;
BEGIN
  PERFORM ops.check_actor(p_actor);
  PERFORM 1 FROM ops.distributions WHERE id = p_id FOR UPDATE;
  v_problem := ops.publish_problem(p_id, NULL);
  IF v_problem IS NOT NULL THEN RAISE EXCEPTION 'cannot publish calculation %: %', p_id, v_problem USING ERRCODE = 'check_violation'; END IF;
  v_payload := ops.publish_payload(p_id);
  -- A new key after an on-chain rejection, so the outbox never dedupes a republication into the rejected one.
  v_key := format('rent.publish:%s:%s', p_id, (SELECT count(*) FROM chain.distributions c
                                               WHERE c.registry = v_payload->>'registry' AND c.statement_hash = v_payload->>'statementHash'));
  IF EXISTS (SELECT 1 FROM outbox.commands o WHERE o.kind = 'rent.publish' AND o.payload->>'calculation' = p_id::text
             AND o.idempotency_key <> v_key AND o.status <> 'failed') THEN
    RAISE EXCEPTION 'cannot publish calculation %: a publish command for it is already in the outbox', p_id USING ERRCODE = 'check_violation';
  END IF;
  v_cmd := outbox.enqueue(v_key, 'rent.publish', v_payload, v_payload->>'token', p_actor);
  PERFORM ops.audit_append(p_actor, 'distribution.publish_requested', jsonb_build_object('distribution', p_id, 'command', v_cmd, 'key', v_key,
    'statementHash', v_payload->>'statementHash', 'totalPaisa', v_payload->>'totalPaisa'));
  RETURN v_cmd;
END $$;

/** Signer: why this rent.publish payload must not be signed (NULL = allowed). */
CREATE FUNCTION ops.publish_allowed(p_payload jsonb) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, ops AS $$
DECLARE
  v_id bigint;
BEGIN
  IF p_payload IS NULL OR coalesce(p_payload->>'calculation', '') !~ '^[1-9][0-9]{0,17}$' THEN RETURN 'malformed publish payload'; END IF;
  v_id := (p_payload->>'calculation')::bigint;
  IF NOT EXISTS (SELECT 1 FROM outbox.commands o WHERE o.kind = 'rent.publish' AND o.idempotency_key LIKE format('rent.publish:%s:%%', v_id)
                 AND o.payload = p_payload) THEN
    RETURN 'not the publish command ops.request_publish enqueued';
  END IF;
  RETURN ops.publish_problem(v_id, p_payload);
END $$;

-- ================================================================== RP-3 finalisation
/** Why on-chain distribution (registry, id) cannot be finalised now (NULL = it can). */
CREATE FUNCTION ops.finalize_problem(p_registry text, p_id numeric) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, ops AS $$
DECLARE
  c chain.distributions;
  v_closes timestamptz;
BEGIN
  SELECT * INTO c FROM chain.distributions WHERE registry = lower(p_registry) AND id = p_id;
  IF NOT FOUND THEN RETURN 'the distribution is not in the read model'; END IF;
  IF c.status <> 'published' THEN RETURN format('the distribution is %s, not published', c.status); END IF;
  v_closes := trustee.window_closes(c.registry, c.id);
  IF v_closes IS NULL THEN RETURN 'the publish block time is unknown'; END IF;
  IF clock_timestamp() < v_closes THEN RETURN format('the 48-hour challenge window closes at %s', ops.utc(v_closes)); END IF;
  IF trustee.distribution_blocked(c.token, c.id) IS NOT NULL THEN RETURN trustee.distribution_blocked(c.token, c.id); END IF;
  IF NOT EXISTS (SELECT 1 FROM ops.distributions d WHERE d.status IN ('approved', 'booked') AND d.token = c.token AND d.record_block = c.record_block
                 AND d.merkle_root = c.merkle_root AND d.statement_hash = c.statement_hash AND d.sum_net = c.total_paisa) THEN
    RETURN 'no approved calculation matches the on-chain distribution';
  END IF;
  RETURN NULL;
END $$;

/** Operator: enqueue the finalisation of a published distribution once its window has closed (RP-3). */
CREATE FUNCTION ops.request_finalize(p_registry text, p_id numeric, p_actor text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, ops AS $$
DECLARE
  v_problem text;
  v_payload jsonb;
  v_cmd bigint;
BEGIN
  PERFORM ops.check_actor(p_actor);
  IF NOT ops.is_address(lower(p_registry)) OR p_id IS NULL OR p_id <= 0 THEN
    RAISE EXCEPTION 'a registry address and a distribution id are required' USING ERRCODE = 'check_violation';
  END IF;
  v_problem := ops.finalize_problem(p_registry, p_id);
  IF v_problem IS NOT NULL THEN RAISE EXCEPTION 'cannot finalise distribution %: %', p_id, v_problem USING ERRCODE = 'check_violation'; END IF;
  v_payload := jsonb_build_object('registry', lower(p_registry), 'distributionId', p_id::text);
  v_cmd := outbox.enqueue(format('rent.finalize:%s:%s', lower(p_registry), p_id), 'rent.finalize', v_payload, lower(p_registry), p_actor);
  PERFORM ops.audit_append(p_actor, 'distribution.finalize_requested', jsonb_build_object('registry', lower(p_registry), 'onchainId', p_id::text, 'command', v_cmd));
  RETURN v_cmd;
END $$;

/** Signer: why this rent.finalize payload must not be signed (NULL = allowed). */
CREATE FUNCTION ops.finalize_allowed(p_payload jsonb) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, ops AS $$
BEGIN
  IF p_payload IS NULL OR NOT ops.is_address(coalesce(p_payload->>'registry', '')) OR coalesce(p_payload->>'distributionId', '') !~ '^[1-9][0-9]{0,30}$' THEN
    RETURN 'malformed finalize payload';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM outbox.commands o WHERE o.kind = 'rent.finalize'
                 AND o.idempotency_key = format('rent.finalize:%s:%s', p_payload->>'registry', p_payload->>'distributionId') AND o.payload = p_payload) THEN
    RETURN 'not the finalize command ops.request_finalize enqueued';
  END IF;
  RETURN ops.finalize_problem(p_payload->>'registry', (p_payload->>'distributionId')::numeric);
END $$;

-- ================================================================== privileges
REVOKE ALL ON FUNCTION ops.publish_payload(bigint), ops.publish_problem(bigint, jsonb), ops.request_publish(bigint, text), ops.publish_allowed(jsonb),
  ops.finalize_problem(text, numeric), ops.request_finalize(text, numeric, text), ops.finalize_allowed(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.publish_problem(bigint, jsonb), ops.request_publish(bigint, text), ops.finalize_problem(text, numeric),
  ops.request_finalize(text, numeric, text) TO pt_ops_operator;
GRANT USAGE ON SCHEMA ops TO pt_signer;
GRANT EXECUTE ON FUNCTION ops.publish_allowed(jsonb), ops.finalize_allowed(jsonb) TO pt_signer;

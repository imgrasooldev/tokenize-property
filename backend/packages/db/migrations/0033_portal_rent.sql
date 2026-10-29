-- PT Control buttons for rent publication, finalisation and booking (T-022 follow-up). Applies on top
-- of 0032 (rent.publish / rent.finalize signer kinds).
--
--   PRT-1  admin.rent_onchain(session, calculation): what the distribution page needs to show where an
--          approved calculation stands on chain: the publish command and its outbox status, the
--          matching on-chain distribution (registry, id, status, window close), the finalize command,
--          and why each next step is refused right now (the same ops.*_problem answers the signer
--          uses). Read permission: operations.read.
--   PRT-2  admin.rent_step(session, calculation, publish | finalize | book): an operations
--          maker (operations.request) with a fresh step-up asks for the next step under their own
--          handle (bound for the call, as every portal action). They only call ops.request_publish,
--          ops.request_finalize and ops.book_distribution, so every rule of 0021/0032 still applies
--          (approved calculation, one live publication, 48-hour window, trustee rejection, payout
--          gate in the signer, finalized before booking). The finalize and book steps find the
--          on-chain distribution from the calculation itself: nobody types a registry or an id.
--   PRT-3  Refusals are audited (approval.refused); successes as operations.requested.
--   PRT-4  ops.finalize_due(actor): the finalisation scheduler (T-034). Enqueues ops.request_finalize
--          for every published distribution of an approved calculation whose 48-hour window has
--          closed and that has no live finalize command yet. Granted to the tax service's group
--          (pt_svc_tax) only; it can only enqueue what an operator could, and the signer re-checks
--          everything (finalize_allowed, payout gate). Returns how many it enqueued.

/** The non-rejected on-chain distribution of an approved/booked calculation (registry + id), or nothing. */
CREATE FUNCTION ops.calculation_onchain(p_id bigint) RETURNS TABLE (registry text, id numeric, status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, ops AS $$
  SELECT c.registry, c.id, c.status
  FROM ops.distributions d
  JOIN chain.distributions c ON c.token = d.token AND c.statement_hash = d.statement_hash AND c.record_block = d.record_block
                             AND c.merkle_root = d.merkle_root AND c.total_paisa = d.sum_net
  WHERE d.id = p_id AND c.status <> 'rejected'
  ORDER BY c.id DESC LIMIT 1
$$;
REVOKE ALL ON FUNCTION ops.calculation_onchain(bigint) FROM PUBLIC;

-- ================================================================== PRT-1 read
CREATE FUNCTION admin.rent_onchain(p_session bytea, p_id bigint) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_can boolean := admin.has_permission(p_session, 'operations.request');
  d ops.distributions;
  c record;
  v_publish jsonb;
  v_finalize jsonb;
  v_publish_problem text;
  v_finalize_problem text;
  v_book_problem text;
BEGIN
  PERFORM admin.require(p_session, 'operations.read');
  SELECT * INTO d FROM ops.distributions WHERE id = p_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO c FROM ops.calculation_onchain(p_id);
  SELECT jsonb_build_object('id', o.id, 'status', o.status, 'lastError', left(o.last_error, 300), 'txHash', o.tx_hash, 'by', o.created_by,
                            'at', admin.utc(o.created_at))
    INTO v_publish FROM outbox.commands o WHERE o.kind = 'rent.publish' AND o.payload->>'calculation' = p_id::text ORDER BY o.id DESC LIMIT 1;
  IF c.id IS NOT NULL THEN
    SELECT jsonb_build_object('id', o.id, 'status', o.status, 'lastError', left(o.last_error, 300), 'txHash', o.tx_hash, 'by', o.created_by,
                              'at', admin.utc(o.created_at))
      INTO v_finalize FROM outbox.commands o
      WHERE o.kind = 'rent.finalize' AND o.idempotency_key = format('rent.finalize:%s:%s', c.registry, c.id) ORDER BY o.id DESC LIMIT 1;
  END IF;

  IF c.id IS NOT NULL THEN v_publish_problem := 'Already published on chain.';
  ELSIF v_publish IS NOT NULL AND v_publish->>'status' <> 'failed' THEN v_publish_problem := 'A publish command is already in the outbox.';
  ELSE v_publish_problem := ops.publish_problem(p_id, NULL);
  END IF;
  IF c.id IS NULL THEN v_finalize_problem := 'Not published on chain yet.';
  ELSIF c.status <> 'published' THEN v_finalize_problem := format('The distribution is %s on chain.', c.status);
  ELSIF v_finalize IS NOT NULL AND v_finalize->>'status' <> 'failed' THEN v_finalize_problem := 'A finalize command is already in the outbox.';
  ELSE v_finalize_problem := ops.finalize_problem(c.registry, c.id);
  END IF;
  IF d.status = 'booked' THEN v_book_problem := 'Already booked.';
  ELSIF d.status <> 'approved' THEN v_book_problem := format('The calculation is %s, not approved.', d.status);
  ELSIF c.id IS NULL OR c.status NOT IN ('finalized', 'paid') THEN v_book_problem := 'Booking needs the on-chain distribution finalized (D9).';
  END IF;
  IF NOT v_can THEN
    v_publish_problem := coalesce(v_publish_problem, 'Only an operations maker requests this.');
    v_finalize_problem := coalesce(v_finalize_problem, 'Only an operations maker requests this.');
    v_book_problem := coalesce(v_book_problem, 'Only an operations maker requests this.');
  END IF;
  RETURN jsonb_build_object(
    'status', d.status,
    'onchain', CASE WHEN c.id IS NULL THEN NULL ELSE jsonb_build_object('registry', c.registry, 'id', c.id::text, 'status', c.status,
                    'closesAt', admin.utc(trustee.window_closes(c.registry, c.id))) END,
    'publishCommand', v_publish, 'finalizeCommand', v_finalize,
    'blockers', jsonb_build_object('publish', v_publish_problem, 'finalize', v_finalize_problem, 'book', v_book_problem));
END $$;

-- ================================================================== PRT-2 actions
/** Runs one ops step under the officer's bound handle; refusals are audited and returned, never raised. */
CREATE FUNCTION admin.rent_step(p_session bytea, p_id bigint, p_step text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'operations.request');
  v_handle text := admin.handle_of(v_me);
  c record;
  v_ref bigint;
BEGIN
  PERFORM admin.require_step_up(p_session);
  IF p_step NOT IN ('publish', 'finalize', 'book') THEN RETURN admin.refuse(v_me, 'distribution', p_id::text, p_step, 'unknown step'); END IF;
  IF NOT EXISTS (SELECT 1 FROM ops.distributions WHERE id = p_id) THEN RETURN admin.refuse(v_me, 'distribution', p_id::text, p_step, 'unknown distribution'); END IF;
  SELECT * INTO c FROM ops.calculation_onchain(p_id);
  IF p_step <> 'publish' AND c.id IS NULL THEN
    RETURN admin.refuse(v_me, 'distribution', p_id::text, p_step, 'the calculation is not published on chain yet');
  END IF;
  BEGIN
    PERFORM admin.bind_officer(v_handle);
    v_ref := CASE p_step
      WHEN 'publish' THEN ops.request_publish(p_id, v_handle)
      WHEN 'finalize' THEN ops.request_finalize(c.registry, c.id, v_handle)
      ELSE ops.book_distribution(p_id, c.registry, c.id, v_handle) END;
    PERFORM admin.unbind_officer(v_handle);
  EXCEPTION WHEN SQLSTATE '23514' OR SQLSTATE '23505' OR SQLSTATE '42501' OR SQLSTATE '22023' OR SQLSTATE 'P0002' THEN
    RETURN admin.refuse(v_me, 'distribution', p_id::text, p_step, SQLERRM);
  END;
  PERFORM admin.audit_append(v_me::text, 'operations.requested', jsonb_build_object('kind', 'distribution', 'ref', p_id, 'action', p_step,
    CASE WHEN p_step = 'book' THEN 'journal' ELSE 'command' END, v_ref));
  RETURN jsonb_build_object('ok', true, 'status', CASE p_step WHEN 'publish' THEN 'publish requested' WHEN 'finalize' THEN 'finalize requested' ELSE 'booked' END,
                            'id', v_ref);
END $$;

REVOKE ALL ON FUNCTION admin.rent_onchain(bytea, bigint), admin.rent_step(bytea, bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.rent_onchain(bytea, bigint), admin.rent_step(bytea, bigint, text) TO pt_admin_portal;

-- ================================================================== PRT-4 finalisation scheduler
CREATE FUNCTION ops.finalize_due(p_actor text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, ops AS $$
DECLARE
  r record;
  n integer := 0;
BEGIN
  PERFORM ops.check_actor(p_actor);
  FOR r IN SELECT DISTINCT c.registry, c.id
           FROM ops.distributions d
           JOIN chain.distributions c ON c.token = d.token AND c.statement_hash = d.statement_hash AND c.record_block = d.record_block
                                      AND c.merkle_root = d.merkle_root AND c.total_paisa = d.sum_net
           WHERE d.status = 'approved' AND c.status = 'published'
             AND NOT EXISTS (SELECT 1 FROM outbox.commands o WHERE o.kind = 'rent.finalize'
                             AND o.idempotency_key = format('rent.finalize:%s:%s', c.registry, c.id))
           ORDER BY c.registry, c.id LOOP
    IF ops.finalize_problem(r.registry, r.id) IS NULL THEN
      PERFORM ops.request_finalize(r.registry, r.id, p_actor);
      n := n + 1;
    END IF;
  END LOOP;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION ops.finalize_due(text) FROM PUBLIC;
GRANT USAGE ON SCHEMA ops TO pt_svc_tax;
GRANT EXECUTE ON FUNCTION ops.finalize_due(text) TO pt_svc_tax;

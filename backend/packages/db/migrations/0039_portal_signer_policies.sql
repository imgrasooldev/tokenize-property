-- PT Control: signing policy changes (until now `signer.propose_policy` / `signer.approve_policy`
-- from the command line with the admin login). Applies on top of 0038.
--
--   SP-1  admin.signer_policies(session) (operations.read): per kind, the active version and any
--         proposals waiting for approval (rule, who, when).
--   SP-2  admin.propose_signer_policy(session, kind, rule): an operations maker with a fresh step-up
--         proposes a new version of an EXISTING kind only, and the rule must have exactly the same
--         keys as the active version (values may change, the shape may not): a new kind or a new
--         field stays a code change with review. One open proposal per kind.
--   SP-3  admin.approve_signer_policy(session, id): a different operations checker with a fresh
--         step-up activates it (signer.approve_policy: the previous version is retired). The signing
--         service validates every rule again when it loads its policies (deny by default), and it
--         loads them on start: the page says a restart of pt-signer is needed.
--   SP-4  admin.withdraw_signer_policy(session, id): the proposer (or any operations checker) drops
--         an open proposal; it is retired unapproved and stays in the history.
--   SP-5  Refusals are audited (approval.refused); proposals and decisions as operations.requested /
--         operations.decided; the signer audit chain records policy.proposed / policy.approved.

CREATE FUNCTION admin.signer_policies(p_session bytea) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
BEGIN
  PERFORM admin.require(p_session, 'operations.read');
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object(
      'kind', k.kind,
      'active', (SELECT jsonb_build_object('id', p.id, 'version', p.version, 'rule', p.rule, 'proposedBy', p.proposed_by, 'approvedBy', p.approved_by,
                                           'approvedAt', admin.utc(p.approved_at))
                 FROM signer.policies p WHERE p.kind = k.kind AND p.approved_at IS NOT NULL AND p.retired_at IS NULL ORDER BY p.version DESC LIMIT 1),
      'proposals', coalesce((SELECT jsonb_agg(jsonb_build_object('id', p.id, 'version', p.version, 'rule', p.rule, 'proposedBy', p.proposed_by,
                                                                 'proposedAt', admin.utc(p.proposed_at)) ORDER BY p.version)
                             FROM signer.policies p WHERE p.kind = k.kind AND p.approved_at IS NULL AND p.retired_at IS NULL), '[]'::jsonb))
      ORDER BY k.kind)
    FROM (SELECT DISTINCT kind FROM signer.policies) k), '[]'::jsonb);
END $$;

/** The keys of a JSON object, sorted (for the same-shape rule of SP-2). */
CREATE FUNCTION admin.json_keys(p jsonb) RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT coalesce(array_agg(k ORDER BY k), '{}') FROM jsonb_object_keys(p) k
$$;

CREATE FUNCTION admin.propose_signer_policy(p_session bytea, p_kind text, p_rule jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'operations.request');
  v_handle text := admin.handle_of(v_me);
  v_active jsonb;
  v_id bigint;
BEGIN
  PERFORM admin.require_step_up(p_session);
  IF p_rule IS NULL OR jsonb_typeof(p_rule) <> 'object' OR octet_length(p_rule::text) > 8192 THEN
    RETURN admin.refuse(v_me, 'signer_policy', coalesce(p_kind, '-'), 'propose', 'the rule must be a JSON object of at most 8 KB');
  END IF;
  SELECT rule INTO v_active FROM signer.policies WHERE kind = p_kind AND approved_at IS NOT NULL AND retired_at IS NULL ORDER BY version DESC LIMIT 1;
  IF v_active IS NULL THEN
    RETURN admin.refuse(v_me, 'signer_policy', coalesce(p_kind, '-'), 'propose', 'only an existing kind with an active policy can be changed here');
  END IF;
  IF admin.json_keys(p_rule) <> admin.json_keys(v_active) THEN
    RETURN admin.refuse(v_me, 'signer_policy', p_kind, 'propose', 'the rule must have exactly the fields of the active version (values may change, fields may not)');
  END IF;
  IF p_rule = v_active THEN RETURN admin.refuse(v_me, 'signer_policy', p_kind, 'propose', 'the rule is the same as the active version'); END IF;
  IF EXISTS (SELECT 1 FROM signer.policies WHERE kind = p_kind AND approved_at IS NULL AND retired_at IS NULL) THEN
    RETURN admin.refuse(v_me, 'signer_policy', p_kind, 'propose', 'a proposal for this kind is already waiting');
  END IF;
  PERFORM admin.bind_officer(v_handle);
  v_id := signer.propose_policy(p_kind, p_rule, v_handle);
  PERFORM admin.unbind_officer(v_handle);
  PERFORM admin.audit_append(v_me::text, 'operations.requested', jsonb_build_object('kind', 'signer_policy', 'ref', v_id, 'action', 'propose', 'policyKind', p_kind));
  RETURN jsonb_build_object('ok', true, 'id', v_id, 'status', 'proposed');
END $$;

CREATE FUNCTION admin.approve_signer_policy(p_session bytea, p_id bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'operations.decide');
  v_handle text := admin.handle_of(v_me);
  p signer.policies;
BEGIN
  PERFORM admin.require_step_up(p_session);
  SELECT * INTO p FROM signer.policies WHERE id = p_id;
  IF NOT FOUND OR p.approved_at IS NOT NULL OR p.retired_at IS NOT NULL THEN
    RETURN admin.refuse(v_me, 'signer_policy', coalesce(p_id::text, '-'), 'approve', 'no open proposal with this id');
  END IF;
  IF p.proposed_by = v_handle THEN RETURN admin.refuse(v_me, 'signer_policy', p_id::text, 'approve', 'you proposed it: a different officer approves'); END IF;
  BEGIN
    PERFORM admin.bind_officer(v_handle);
    PERFORM signer.approve_policy(p_id, v_handle);
    PERFORM admin.unbind_officer(v_handle);
  EXCEPTION WHEN SQLSTATE '23514' THEN
    RETURN admin.refuse(v_me, 'signer_policy', p_id::text, 'approve', SQLERRM);
  END;
  PERFORM admin.audit_append(v_me::text, 'operations.decided', jsonb_build_object('kind', 'signer_policy', 'ref', p_id, 'action', 'approve', 'policyKind', p.kind));
  RETURN jsonb_build_object('ok', true, 'id', p_id, 'status', 'active');
END $$;

CREATE FUNCTION admin.withdraw_signer_policy(p_session bytea, p_id bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'operations.read');
  v_handle text := admin.handle_of(v_me);
  p signer.policies;
BEGIN
  PERFORM admin.require_step_up(p_session);
  SELECT * INTO p FROM signer.policies WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR p.approved_at IS NOT NULL OR p.retired_at IS NOT NULL THEN
    RETURN admin.refuse(v_me, 'signer_policy', coalesce(p_id::text, '-'), 'withdraw', 'no open proposal with this id');
  END IF;
  IF p.proposed_by <> v_handle AND NOT admin.has_permission(p_session, 'operations.decide') THEN
    RETURN admin.refuse(v_me, 'signer_policy', p_id::text, 'withdraw', 'only the proposer or an operations checker withdraws a proposal');
  END IF;
  UPDATE signer.policies SET retired_at = now() WHERE id = p_id;
  PERFORM signer.audit_append(v_handle, 'policy.withdrawn', NULL, jsonb_build_object('policy', p_id, 'kind', p.kind, 'version', p.version));
  PERFORM admin.audit_append(v_me::text, 'operations.decided', jsonb_build_object('kind', 'signer_policy', 'ref', p_id, 'action', 'withdraw', 'policyKind', p.kind));
  RETURN jsonb_build_object('ok', true, 'id', p_id, 'status', 'withdrawn');
END $$;

REVOKE ALL ON FUNCTION admin.signer_policies(bytea), admin.json_keys(jsonb), admin.propose_signer_policy(bytea, text, jsonb),
  admin.approve_signer_policy(bytea, bigint), admin.withdraw_signer_policy(bytea, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.signer_policies(bytea), admin.propose_signer_policy(bytea, text, jsonb), admin.approve_signer_policy(bytea, bigint),
  admin.withdraw_signer_policy(bytea, bigint) TO pt_admin_portal;

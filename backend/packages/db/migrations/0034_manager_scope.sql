-- Property managers see only their own properties (T-049 follow-up). Applies on top of 0033.
--
--   MS-1  A property manager (role property_manager, which conflicts with every other role but
--         nothing it reads) is scoped to the properties assigned to them; every other officer is
--         unscoped (admin.property_scope returns NULL for them). A manager with no assignment sees
--         no property and no operations data at all (deny by default).
--   MS-2  Assignments are maker-checker between two administrators (officers.manage, fresh step-up,
--         reason 10..500): one asks to grant or revoke, a different one decides. Only an officer who
--         currently holds property_manager can be granted a property. Requests and decisions are in
--         the admin audit chain; refusals as approval.refused.
--   MS-3  The read functions a manager reaches (property.read, operations.read) are wrapped: the
--         original is renamed to <name>_all (the portal loses EXECUTE on it) and the new function
--         checks the scope first. A token belongs to a property through its offering
--         (offering.offerings.token). Lists are filtered; a single item outside the scope reads as
--         "not found" (NULL), never as "forbidden", so ids of other properties are not confirmed.
--         Sponsor (KYB) requests are not property-specific and stay hidden from managers.

-- ================================================================== MS-2 assignments
CREATE TABLE admin.manager_scope_changes (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  officer_id      uuid NOT NULL REFERENCES admin.officers (id),
  property_id     uuid NOT NULL REFERENCES property.properties (id),
  action          text NOT NULL CHECK (action IN ('grant', 'revoke')),
  reason          text NOT NULL CHECK (length(reason) BETWEEN 10 AND 500),
  requested_by    uuid NOT NULL REFERENCES admin.officers (id),
  requested_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'approved', 'rejected')),
  decided_by      uuid REFERENCES admin.officers (id),
  decided_at      timestamptz,
  decision_reason text CHECK (decision_reason IS NULL OR length(decision_reason) BETWEEN 10 AND 500),
  CHECK ((status = 'open') = (decided_by IS NULL)),
  CHECK (decided_by IS NULL OR decided_by <> requested_by)
);
CREATE UNIQUE INDEX manager_scope_one_open ON admin.manager_scope_changes (officer_id, property_id) WHERE status = 'open';

CREATE TABLE admin.manager_properties (
  officer_id  uuid NOT NULL REFERENCES admin.officers (id),
  property_id uuid NOT NULL REFERENCES property.properties (id),
  change_id   bigint NOT NULL REFERENCES admin.manager_scope_changes (id),
  PRIMARY KEY (officer_id, property_id)
);

/** Decided changes are final: only open -> approved | rejected, and no delete. */
CREATE FUNCTION admin.manager_scope_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, admin AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status <> 'open' OR NEW.status = 'open'
     OR (NEW.officer_id, NEW.property_id, NEW.action, NEW.reason, NEW.requested_by, NEW.requested_at)
        IS DISTINCT FROM (OLD.officer_id, OLD.property_id, OLD.action, OLD.reason, OLD.requested_by, OLD.requested_at) THEN
    RAISE EXCEPTION 'manager scope changes are append-only once decided' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER manager_scope_guard BEFORE UPDATE OR DELETE ON admin.manager_scope_changes
  FOR EACH ROW EXECUTE FUNCTION admin.manager_scope_guard();

/** Administrator: ask to grant or revoke one property for a property manager (MS-2). */
CREATE FUNCTION admin.request_manager_scope(p_session bytea, p_officer uuid, p_property uuid, p_action text, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'officers.manage');
  v_handle text;
  v_id bigint;
BEGIN
  PERFORM admin.require_step_up(p_session);
  IF p_action IS DISTINCT FROM 'grant' AND p_action IS DISTINCT FROM 'revoke' THEN
    RETURN admin.refuse(v_me, 'manager_scope', coalesce(p_officer::text, '-'), coalesce(p_action, '-'), 'choose grant or revoke');
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 10 AND 500 THEN
    RETURN admin.refuse(v_me, 'manager_scope', coalesce(p_officer::text, '-'), p_action, 'give a reason of 10 to 500 characters');
  END IF;
  SELECT handle INTO v_handle FROM admin.officers WHERE id = p_officer;
  IF v_handle IS NULL OR NOT admin.officer_holds(v_handle, ARRAY['property_manager'], false) THEN
    RETURN admin.refuse(v_me, 'manager_scope', coalesce(p_officer::text, '-'), p_action, 'the officer does not hold the property_manager role');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM property.properties WHERE id = p_property) THEN
    RETURN admin.refuse(v_me, 'manager_scope', p_officer::text, p_action, 'unknown property');
  END IF;
  IF (p_action = 'grant') = EXISTS (SELECT 1 FROM admin.manager_properties WHERE officer_id = p_officer AND property_id = p_property) THEN
    RETURN admin.refuse(v_me, 'manager_scope', p_officer::text, p_action,
      CASE p_action WHEN 'grant' THEN 'the property is already assigned' ELSE 'the property is not assigned' END);
  END IF;
  IF EXISTS (SELECT 1 FROM admin.manager_scope_changes WHERE officer_id = p_officer AND property_id = p_property AND status = 'open') THEN
    RETURN admin.refuse(v_me, 'manager_scope', p_officer::text, p_action, 'a change for this property is already waiting for a decision');
  END IF;
  INSERT INTO admin.manager_scope_changes (officer_id, property_id, action, reason, requested_by)
  VALUES (p_officer, p_property, p_action, btrim(p_reason), v_me) RETURNING id INTO v_id;
  PERFORM admin.audit_append(v_me::text, 'manager_scope.requested', jsonb_build_object('change', v_id, 'officer', p_officer, 'property', p_property,
    'action', p_action));
  RETURN jsonb_build_object('ok', true, 'id', v_id, 'status', 'open');
END $$;

/** A different administrator decides (MS-2); an approval takes effect at once. */
CREATE FUNCTION admin.decide_manager_scope(p_session bytea, p_id bigint, p_decision text, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'officers.manage');
  c admin.manager_scope_changes;
  v_handle text;
BEGIN
  PERFORM admin.require_step_up(p_session);
  SELECT * INTO c FROM admin.manager_scope_changes WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR c.status <> 'open' THEN RETURN admin.refuse(v_me, 'manager_scope', p_id::text, coalesce(p_decision, '-'), 'no open change with this id'); END IF;
  IF p_decision IS DISTINCT FROM 'approve' AND p_decision IS DISTINCT FROM 'reject' THEN
    RETURN admin.refuse(v_me, 'manager_scope', p_id::text, coalesce(p_decision, '-'), 'choose approve or reject');
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 10 AND 500 THEN
    RETURN admin.refuse(v_me, 'manager_scope', p_id::text, p_decision, 'give a reason of 10 to 500 characters');
  END IF;
  IF c.requested_by = v_me THEN RETURN admin.refuse(v_me, 'manager_scope', p_id::text, p_decision, 'you asked for it: a different administrator decides'); END IF;
  SELECT handle INTO v_handle FROM admin.officers WHERE id = c.officer_id;
  IF p_decision = 'approve' AND c.action = 'grant' AND NOT admin.officer_holds(v_handle, ARRAY['property_manager'], false) THEN
    RETURN admin.refuse(v_me, 'manager_scope', p_id::text, p_decision, 'the officer no longer holds the property_manager role');
  END IF;
  UPDATE admin.manager_scope_changes SET status = CASE p_decision WHEN 'approve' THEN 'approved' ELSE 'rejected' END,
         decided_by = v_me, decided_at = clock_timestamp(), decision_reason = btrim(p_reason)
  WHERE id = p_id;
  IF p_decision = 'approve' THEN
    IF c.action = 'grant' THEN
      INSERT INTO admin.manager_properties (officer_id, property_id, change_id) VALUES (c.officer_id, c.property_id, c.id) ON CONFLICT DO NOTHING;
    ELSE
      DELETE FROM admin.manager_properties WHERE officer_id = c.officer_id AND property_id = c.property_id;
    END IF;
  END IF;
  PERFORM admin.audit_append(v_me::text, 'manager_scope.decided', jsonb_build_object('change', p_id, 'officer', c.officer_id, 'property', c.property_id,
    'action', c.action, 'decision', p_decision));
  RETURN jsonb_build_object('ok', true, 'id', p_id, 'status', CASE p_decision WHEN 'approve' THEN 'approved' ELSE 'rejected' END);
END $$;

/** Administrators and auditors: the managers, their properties and the open changes (for the officers page). */
CREATE FUNCTION admin.manager_scopes(p_session bytea) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
BEGIN
  PERFORM admin.require(p_session, 'officers.read');
  RETURN jsonb_build_object(
    'managers', coalesce((SELECT jsonb_agg(jsonb_build_object('id', o.id, 'handle', o.handle, 'status', o.status,
                  'properties', coalesce((SELECT jsonb_agg(admin.property_json(mp.property_id) ORDER BY mp.property_id)
                                          FROM admin.manager_properties mp WHERE mp.officer_id = o.id), '[]'::jsonb)) ORDER BY o.handle)
                FROM admin.officers o
                WHERE EXISTS (SELECT 1 FROM admin.role_grants g WHERE g.officer_id = o.id AND g.role = 'property_manager' AND g.revoked_at IS NULL)), '[]'::jsonb),
    'open', coalesce((SELECT jsonb_agg(jsonb_build_object('id', c.id, 'officer', (SELECT handle FROM admin.officers WHERE id = c.officer_id),
                  'property', admin.property_json(c.property_id), 'action', c.action, 'reason', c.reason,
                  'requestedBy', (SELECT handle FROM admin.officers WHERE id = c.requested_by), 'requestedAt', admin.utc(c.requested_at)) ORDER BY c.id)
                FROM admin.manager_scope_changes c WHERE c.status = 'open'), '[]'::jsonb),
    'properties', coalesce((SELECT jsonb_agg(admin.property_json(p.id) ORDER BY p.created_at) FROM property.properties p
                            WHERE p.state NOT IN ('rejected', 'withdrawn')), '[]'::jsonb));
END $$;

-- ================================================================== MS-1 scope
/** NULL = unscoped officer; otherwise the property ids this property manager may see (possibly none). */
CREATE FUNCTION admin.property_scope(p_session bytea) RETURNS uuid[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, NULL);
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admin.role_grants g WHERE g.officer_id = v_me AND g.role = 'property_manager' AND g.revoked_at IS NULL) THEN
    RETURN NULL;
  END IF;
  RETURN coalesce((SELECT array_agg(property_id) FROM admin.manager_properties WHERE officer_id = v_me), '{}'::uuid[]);
END $$;

CREATE FUNCTION admin.property_in_scope(p_scope uuid[], p_property uuid) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT p_scope IS NULL OR (p_property IS NOT NULL AND p_property = ANY (p_scope))
$$;

CREATE FUNCTION admin.token_in_scope(p_scope uuid[], p_token text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
  SELECT p_scope IS NULL OR EXISTS (SELECT 1 FROM offering.offerings o WHERE o.token = lower(p_token) AND o.property_id = ANY (p_scope))
$$;

-- ================================================================== MS-3 wrapped reads
ALTER FUNCTION admin.operations_periods(bytea) RENAME TO operations_periods_all;
ALTER FUNCTION admin.operations_statement(bytea, text, text) RENAME TO operations_statement_all;
ALTER FUNCTION admin.operations_charge(bytea, bigint) RENAME TO operations_charge_all;
ALTER FUNCTION admin.operations_distribution(bytea, bigint) RENAME TO operations_distribution_all;
ALTER FUNCTION admin.rent_onchain(bytea, bigint) RENAME TO rent_onchain_all;
ALTER FUNCTION admin.property_request(bytea, bigint) RENAME TO property_request_all;
ALTER FUNCTION admin.approvals_inbox(bytea) RENAME TO approvals_inbox_all;
ALTER FUNCTION admin.committees(bytea) RENAME TO committees_all;
ALTER FUNCTION admin.committee(bytea, bigint) RENAME TO committee_all;
REVOKE ALL ON FUNCTION admin.operations_periods_all(bytea), admin.operations_statement_all(bytea, text, text), admin.operations_charge_all(bytea, bigint),
  admin.operations_distribution_all(bytea, bigint), admin.rent_onchain_all(bytea, bigint), admin.property_request_all(bytea, bigint),
  admin.approvals_inbox_all(bytea), admin.committees_all(bytea), admin.committee_all(bytea, bigint) FROM PUBLIC, pt_admin_portal;

CREATE FUNCTION admin.operations_periods(p_session bytea) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_scope uuid[] := admin.property_scope(p_session);
  v jsonb := admin.operations_periods_all(p_session);
BEGIN
  IF v_scope IS NULL THEN RETURN v; END IF;
  RETURN coalesce((SELECT jsonb_agg(e ORDER BY n) FROM jsonb_array_elements(v) WITH ORDINALITY x(e, n) WHERE admin.token_in_scope(v_scope, e->>'token')), '[]'::jsonb);
END $$;

CREATE FUNCTION admin.operations_statement(p_session bytea, p_token text, p_period text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
BEGIN
  IF NOT admin.token_in_scope(admin.property_scope(p_session), p_token) THEN RETURN NULL; END IF;
  RETURN admin.operations_statement_all(p_session, p_token, p_period);
END $$;

CREATE FUNCTION admin.operations_charge(p_session bytea, p_id bigint) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
BEGIN
  IF NOT admin.token_in_scope(admin.property_scope(p_session), (SELECT token FROM ops.charges WHERE id = p_id)) THEN RETURN NULL; END IF;
  RETURN admin.operations_charge_all(p_session, p_id);
END $$;

CREATE FUNCTION admin.operations_distribution(p_session bytea, p_id bigint) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
BEGIN
  IF NOT admin.token_in_scope(admin.property_scope(p_session), (SELECT token FROM ops.distributions WHERE id = p_id)) THEN RETURN NULL; END IF;
  RETURN admin.operations_distribution_all(p_session, p_id);
END $$;

CREATE FUNCTION admin.rent_onchain(p_session bytea, p_id bigint) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
BEGIN
  IF NOT admin.token_in_scope(admin.property_scope(p_session), (SELECT token FROM ops.distributions WHERE id = p_id)) THEN RETURN NULL; END IF;
  RETURN admin.rent_onchain_all(p_session, p_id);
END $$;

CREATE FUNCTION admin.property_request(p_session bytea, p_id bigint) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_scope uuid[] := admin.property_scope(p_session);
BEGIN
  IF v_scope IS NOT NULL AND NOT EXISTS (SELECT 1 FROM property.requests q WHERE q.id = p_id AND q.entity = 'property' AND q.entity_id = ANY (v_scope)) THEN
    RETURN NULL;
  END IF;
  RETURN admin.property_request_all(p_session, p_id);
END $$;

CREATE FUNCTION admin.approvals_inbox(p_session bytea) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_scope uuid[] := admin.property_scope(p_session);
  v jsonb := admin.approvals_inbox_all(p_session);
BEGIN
  IF v_scope IS NULL OR jsonb_typeof(v->'property') IS DISTINCT FROM 'array' THEN RETURN v; END IF;
  RETURN jsonb_set(v, '{property}', coalesce((SELECT jsonb_agg(e ORDER BY n) FROM jsonb_array_elements(v->'property') WITH ORDINALITY x(e, n)
                                             WHERE e->>'entity' = 'property' AND (e->>'entityId')::uuid = ANY (v_scope)), '[]'::jsonb));
END $$;

CREATE FUNCTION admin.committees(p_session bytea) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_scope uuid[] := admin.property_scope(p_session);
  v jsonb := admin.committees_all(p_session);
  k text;
BEGIN
  IF v_scope IS NULL THEN RETURN v; END IF;
  FOREACH k IN ARRAY ARRAY['open', 'ready', 'recent'] LOOP
    v := jsonb_set(v, ARRAY[k], coalesce((SELECT jsonb_agg(e ORDER BY n) FROM jsonb_array_elements(v->k) WITH ORDINALITY x(e, n)
                                         WHERE (e->'property'->>'id')::uuid = ANY (v_scope)), '[]'::jsonb));
  END LOOP;
  RETURN v;
END $$;

CREATE FUNCTION admin.committee(p_session bytea, p_meeting bigint) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
BEGIN
  IF NOT admin.property_in_scope(admin.property_scope(p_session), (SELECT property_id FROM property.ic_meetings WHERE id = p_meeting)) THEN RETURN NULL; END IF;
  RETURN admin.committee_all(p_session, p_meeting);
END $$;

-- ================================================================== privileges
REVOKE ALL ON TABLE admin.manager_scope_changes, admin.manager_properties FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.manager_scope_guard(), admin.request_manager_scope(bytea, uuid, uuid, text, text), admin.decide_manager_scope(bytea, bigint, text, text),
  admin.manager_scopes(bytea), admin.property_scope(bytea), admin.property_in_scope(uuid[], uuid), admin.token_in_scope(uuid[], text),
  admin.operations_periods(bytea), admin.operations_statement(bytea, text, text), admin.operations_charge(bytea, bigint),
  admin.operations_distribution(bytea, bigint), admin.rent_onchain(bytea, bigint), admin.property_request(bytea, bigint),
  admin.approvals_inbox(bytea), admin.committees(bytea), admin.committee(bytea, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.request_manager_scope(bytea, uuid, uuid, text, text), admin.decide_manager_scope(bytea, bigint, text, text),
  admin.manager_scopes(bytea), admin.operations_periods(bytea), admin.operations_statement(bytea, text, text), admin.operations_charge(bytea, bigint),
  admin.operations_distribution(bytea, bigint), admin.rent_onchain(bytea, bigint), admin.property_request(bytea, bigint),
  admin.approvals_inbox(bytea), admin.committees(bytea), admin.committee(bytea, bigint) TO pt_admin_portal;

-- S-01 maker requests bound to PT Control sessions (T-046 follow-up; lead recommendation 2026-10-22:
-- bind K4 and the other maker-checker requests before the pilot). Applies on top of 0044.
--
--   PB-1  A maker-checker request (property.requests: K4, K5, K10, K11, SC, P6, P13, P14) asked under
--         an officer's handle must come from PT Control: a trigger refuses it unless the handle is
--         bound to the current transaction by an admin.* function (session + security-key step-up),
--         as officer votes and decisions already are (0016, 0026).
--   PB-2  admin.request_property_transition(session, entity, id, code, reason, detail): the portal's
--         way to ask. The officer needs property.read and a fresh step-up; the duty rules of
--         property.request_transition still decide (compliance duty for KYB, legal for P13/P14,
--         the assigned reviewer for P6, OB-SOD-1). Refusals come back with the backend SQLSTATE
--         (admin.vote_refused), audited.
--   PB-3  admin.property_request_options(session): what the officer may ask now: sponsors in KYB
--         review and properties under review or on hold, with the codes allowed from their state.

CREATE FUNCTION admin.bind_property_request() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
BEGIN
  PERFORM admin.guard_officer_name(NEW.requested_by, 'S-01 request by');
  RETURN NEW;
END $$;
CREATE TRIGGER requests_officer_binding BEFORE INSERT ON property.requests FOR EACH ROW EXECUTE FUNCTION admin.bind_property_request();

CREATE FUNCTION admin.request_property_transition(p_session bytea, p_entity text, p_id uuid, p_code text, p_reason text, p_detail jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'property.read');
  v_handle text := admin.handle_of(v_me);
  v_id bigint;
BEGIN
  PERFORM admin.require_step_up(p_session);
  BEGIN
    PERFORM admin.bind_officer(v_handle);
    v_id := property.request_transition(p_entity, p_id, p_code, v_handle, p_reason, coalesce(p_detail, '{}'::jsonb));
    PERFORM admin.unbind_officer(v_handle);
  EXCEPTION WHEN SQLSTATE '23514' OR SQLSTATE '23505' OR SQLSTATE '42501' OR SQLSTATE '22023' OR SQLSTATE 'P0002' OR SQLSTATE '23503' THEN
    RETURN admin.vote_refused(v_me, 'property_request', coalesce(p_id::text, '-'), coalesce(p_code, '-'), SQLERRM, SQLSTATE);
  END;
  PERFORM admin.audit_append(v_me::text, 'property.requested', jsonb_build_object('request', v_id, 'entity', p_entity, 'id', p_id, 'code', p_code));
  RETURN jsonb_build_object('ok', true, 'id', v_id, 'status', 'open');
END $$;

CREATE FUNCTION admin.property_request_options(p_session bytea) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_scope uuid[] := admin.property_scope(p_session);
BEGIN
  PERFORM admin.require(p_session, 'property.read');
  RETURN jsonb_build_object(
    -- Sponsor (KYB) requests are not property-specific: never offered to a scoped property manager.
    'sponsors', CASE WHEN v_scope IS NOT NULL THEN '[]'::jsonb ELSE coalesce((SELECT jsonb_agg(jsonb_build_object('id', s.id, 'state', property.sponsor_state(s.id),
                   'codes', (SELECT jsonb_agg(c ORDER BY c) FROM unnest(ARRAY['K4', 'K5', 'K10', 'K11']) c
                             WHERE EXISTS (SELECT 1 FROM property.transitions t WHERE t.entity = 'sponsor' AND t.code = c AND t.from_state = property.sponsor_state(s.id)))))
                 FROM property.sponsors s WHERE property.sponsor_state(s.id) IN ('kyb_review', 'kyb_suspended')), '[]'::jsonb) END,
    'properties', coalesce((SELECT jsonb_agg(admin.property_json(p.id) || jsonb_build_object('codes',
                     (SELECT jsonb_agg(c ORDER BY c) FROM unnest(ARRAY['P6', 'P13', 'P14']) c
                      WHERE EXISTS (SELECT 1 FROM property.transitions t WHERE t.entity = 'property' AND t.code = c AND t.from_state = p.state))))
                   FROM property.properties p WHERE p.state IN ('under_review', 'on_hold') AND admin.property_in_scope(v_scope, p.id)), '[]'::jsonb));
END $$;

REVOKE ALL ON FUNCTION admin.bind_property_request(), admin.request_property_transition(bytea, text, uuid, text, text, jsonb), admin.property_request_options(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.request_property_transition(bytea, text, uuid, text, text, jsonb), admin.property_request_options(bytea) TO pt_admin_portal;

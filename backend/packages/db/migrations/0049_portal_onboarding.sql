-- PT Control onboarding desk: the S-01 maker screens (T-046 follow-up). Applies on top of 0048.
-- Until now officers ran these S-01 operations from the command line (npm run property:run).
--
--   PO-1  admin.property_act(session, action, args): one portal call per S-01 maker action:
--         KYB evidence (registration check, screening, risk rating, FMU assessment), sponsor people,
--         KYB submit / screen / query / suspend, property create / update / submit / withdraw /
--         return / hold / reopen, duplicate decisions, reviews and reviewer assignment, documents
--         from the vault, title chain, encumbrances, valuations, the structure. The officer needs
--         property.read and a fresh security-key step-up; the handle is bound to the transaction
--         (admin.bind_officer) and passed as the S-01 actor, so the duty and state rules of S-01
--         decide exactly as before. A property manager acts only on assigned properties and never
--         on sponsor files. Refusals come back with the backend SQLSTATE (admin.vote_refused),
--         audited; every success is in the admin audit trail.
--   PO-2  Duties and the valuer panel (request / decide / revoke a duty, add / approve a valuer)
--         need officers.manage (administrators); the S-01 maker-checker rules still apply.
--   PO-3  Reads: admin.onboarding (work queue, sponsors, properties, duties, valuers), admin.property_duties (/officers),
--         admin.onboarding_sponsor and admin.onboarding_property (one file with its evidence,
--         people, documents, reviews, valuations, title chain, encumbrances and history). No sealed
--         names or addresses: those stay with the CLI that holds the sealing key.
-- Creating a sponsor stays on the command line: it seals the legal name and address and hashes
-- the registration numbers with keys the portal does not hold (PR-1).

-- ================================================================== PO-1 / PO-2
CREATE FUNCTION admin.property_act(p_session bytea, p_action text, p_args jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_manage boolean := p_action IN ('request_duty', 'decide_duty', 'revoke_duty', 'add_valuer', 'approve_valuer');
  v_me uuid := admin.require(p_session, CASE WHEN v_manage THEN 'officers.manage' ELSE 'property.read' END);
  v_handle text := admin.handle_of(v_me);
  v_scope uuid[];
  a jsonb := coalesce(p_args, '{}'::jsonb);
  v_ref text := coalesce(a->>'property', a->>'sponsor', a->>'id', '-');
  v_property uuid;
  v_r jsonb;
BEGIN
  PERFORM admin.require_step_up(p_session);
  IF p_action IS NULL OR p_action NOT IN (
      'add_person', 'end_person', 'registration_check', 'screening', 'risk', 'fmu', 'submit_kyb', 'screen_kyb', 'query_kyb', 'suspend_sponsor',
      'create_property', 'update_property', 'submit_property', 'withdraw_property', 'return_property', 'decide_duplicate', 'start_review',
      'reassign_reviewer', 'query_property', 'hold_property', 'reopen', 'add_document', 'verify_document', 'add_title_link',
      'record_encumbrance', 'resolve_encumbrance', 'record_valuation', 'record_review', 'record_structure',
      'request_duty', 'decide_duty', 'revoke_duty', 'add_valuer', 'approve_valuer') THEN
    RETURN admin.vote_refused(v_me, 'property_act', v_ref, coalesce(p_action, '-'), 'unknown onboarding action', '22023');
  END IF;
  v_scope := admin.property_scope(p_session);
  BEGIN
    -- The property the action touches (for the manager scope), also through a document or an encumbrance.
    -- Taken from the object itself where there is one, never from what the form claims.
    v_property := CASE
      WHEN p_action = 'verify_document' THEN (SELECT d.property_id FROM property.documents d WHERE d.id = (a->>'document')::uuid)
      WHEN p_action = 'resolve_encumbrance' THEN (SELECT e.property_id FROM property.encumbrances e WHERE e.id = (a->>'encumbrance')::bigint)
      WHEN p_action = 'decide_duplicate' THEN (SELECT k.property_id FROM property.duplicate_candidates c JOIN property.duplicate_checks k ON k.id = c.check_id
                                               WHERE c.id = (a->>'candidate')::bigint)
      WHEN a ? 'property' THEN (a->>'property')::uuid END;
    IF v_scope IS NOT NULL AND (v_property IS NULL OR NOT admin.property_in_scope(v_scope, v_property)) THEN
      RAISE EXCEPTION 'outside the properties assigned to you' USING ERRCODE = 'insufficient_privilege';
    END IF;
    PERFORM admin.bind_officer(v_handle);
    v_r := CASE p_action
      -- ---- sponsor KYB
      WHEN 'add_person' THEN to_jsonb(property.add_sponsor_person((a->>'sponsor')::uuid, (a->>'subject')::uuid, a->>'role', (a->>'ownershipBp')::integer,
             a->>'control', (a->>'chainDepth')::smallint,
             CASE WHEN jsonb_typeof(a->'powers') = 'array' THEN ARRAY(SELECT jsonb_array_elements_text(a->'powers')) END, v_handle))
      WHEN 'end_person' THEN to_jsonb(property.end_sponsor_person((a->>'person')::bigint, v_handle, a->>'reason'))
      WHEN 'registration_check' THEN to_jsonb(property.record_registration_check((a->>'sponsor')::uuid, a->>'method', a->>'outcome', decode(a->>'evidence', 'hex'), v_handle))
      WHEN 'screening' THEN to_jsonb(property.record_screening((a->>'sponsor')::uuid, a->>'provider', a->>'listVersion', a->>'outcome', decode(a->>'evidence', 'hex'), v_handle))
      WHEN 'risk' THEN to_jsonb(property.record_risk((a->>'sponsor')::uuid, a->>'rating', a->>'reasons', decode(nullif(a->>'edd', ''), 'hex'), v_handle))
      WHEN 'fmu' THEN to_jsonb(property.record_fmu((a->>'sponsor')::uuid, a->>'outcome', decode(a->>'evidence', 'hex'), v_handle))
      WHEN 'submit_kyb' THEN to_jsonb(property.submit_kyb((a->>'sponsor')::uuid, v_handle, (a->>'actingFor')::bigint))
      WHEN 'screen_kyb' THEN to_jsonb(property.screen_kyb((a->>'sponsor')::uuid, v_handle, (a->>'accept')::boolean, a->>'reason'))
      WHEN 'query_kyb' THEN to_jsonb(property.query_kyb((a->>'sponsor')::uuid, v_handle, a->>'reason'))
      WHEN 'suspend_sponsor' THEN to_jsonb(property.suspend_sponsor((a->>'sponsor')::uuid, v_handle, a->>'reason'))
      -- ---- property file
      WHEN 'create_property' THEN to_jsonb(property.create_property((a->>'sponsor')::uuid, v_handle, (a->>'actingFor')::bigint, (a->>'previous')::uuid, coalesce(a->'ids', '{}'::jsonb)))
      WHEN 'update_property' THEN to_jsonb(property.update_property(v_property, v_handle, (a->>'actingFor')::bigint, coalesce(a->'ids', '{}'::jsonb)))
      WHEN 'submit_property' THEN property.submit_property(v_property, v_handle, (a->>'actingFor')::bigint)
      WHEN 'withdraw_property' THEN to_jsonb(property.withdraw_property(v_property, v_handle, (a->>'actingFor')::bigint, a->>'reason'))
      WHEN 'return_property' THEN to_jsonb(property.return_property(v_property, v_handle, a->>'reason'))
      WHEN 'decide_duplicate' THEN to_jsonb(property.decide_duplicate((a->>'candidate')::bigint, v_handle, a->>'capacity', a->>'decision', a->>'reason'))
      WHEN 'start_review' THEN to_jsonb(property.start_review(v_property, v_handle, a->>'legal', a->>'valuation', a->>'technical'))
      WHEN 'reassign_reviewer' THEN to_jsonb(property.reassign_reviewer(v_property, v_handle, a->>'group', a->>'reviewer'))
      WHEN 'query_property' THEN to_jsonb(property.query_property(v_property, v_handle, a->>'reason'))
      WHEN 'hold_property' THEN to_jsonb(property.hold_property(v_property, v_handle, a->>'reason'))
      WHEN 'reopen' THEN to_jsonb(property.reopen(v_property, v_handle, ARRAY(SELECT jsonb_array_elements_text(coalesce(a->'disciplines', '[]'::jsonb))), a->>'reason'))
      -- ---- documents (the file is already in the vault: PT Control /documents or the sponsor portal)
      WHEN 'add_document' THEN to_jsonb((SELECT property.add_document((a->>'sponsor')::uuid, v_property, a->>'type', o.sha256, o.size_bytes, o.media_type,
                                                                     'vault://' || encode(o.sha256, 'hex'), v_handle, (a->>'actingFor')::bigint, (a->>'supersedes')::uuid)
                                         FROM vault.objects o WHERE o.sha256 = decode(a->>'sha256', 'hex')))
      WHEN 'verify_document' THEN to_jsonb(property.verify_document((a->>'document')::uuid, v_handle, a->>'method', a->>'office', (a->>'on')::date, a->>'outcome', decode(a->>'evidence', 'hex')))
      -- ---- due diligence
      WHEN 'add_title_link' THEN to_jsonb(property.add_title_link(v_property, v_handle, (a->>'position')::smallint, a->>'kind', a->>'ref', (a->>'on')::date, (a->>'document')::uuid))
      WHEN 'record_encumbrance' THEN to_jsonb(property.record_encumbrance(v_property, v_handle, a->>'kind', a->>'description', decode(a->>'evidence', 'hex')))
      WHEN 'resolve_encumbrance' THEN to_jsonb(property.resolve_encumbrance((a->>'encumbrance')::bigint, v_handle, a->>'resolution', a->>'note', decode(a->>'evidence', 'hex')))
      WHEN 'record_valuation' THEN to_jsonb(property.record_valuation(v_property, v_handle, (a->>'valuer')::bigint, (a->>'valuePaisa')::bigint, (a->>'on')::date,
                                                                      (a->>'report')::uuid, decode(a->>'independence', 'hex')))
      WHEN 'record_review' THEN to_jsonb(property.record_review(v_property, v_handle, a->>'discipline', a->>'scope', a->>'method', a->>'findings',
                                                                coalesce(a->'conditions', '[]'::jsonb), a->>'decision',
                                                                ARRAY(SELECT x::uuid FROM jsonb_array_elements_text(coalesce(a->'documents', '[]'::jsonb)) x)))
      WHEN 'record_structure' THEN to_jsonb(property.record_structure(v_property, v_handle, a->>'kind', (a->>'shariah')::boolean, a->'rights',
                                                                      (a->>'plannedUnits')::numeric, (a->>'trustDeed')::uuid))
      -- ---- PO-2 duties and the valuer panel
      WHEN 'request_duty' THEN to_jsonb(property.request_duty(a->>'officer', a->>'duty', v_handle, a->>'reason'))
      WHEN 'decide_duty' THEN to_jsonb(property.decide_duty((a->>'id')::bigint, v_handle, (a->>'approve')::boolean, a->>'reason'))
      WHEN 'revoke_duty' THEN to_jsonb(property.revoke_duty((a->>'id')::bigint, v_handle, a->>'reason'))
      WHEN 'add_valuer' THEN to_jsonb(property.add_valuer(a->>'licence', a->>'panel', (a->>'subject')::uuid, v_handle))
      WHEN 'approve_valuer' THEN to_jsonb(property.approve_valuer((a->>'id')::bigint, v_handle))
    END;
    IF p_action = 'add_document' AND v_r IS NULL THEN
      RAISE EXCEPTION 'that file is not in the vault: store it on /documents first' USING ERRCODE = 'no_data_found';
    END IF;
    PERFORM admin.unbind_officer(v_handle);
  EXCEPTION WHEN data_exception OR integrity_constraint_violation OR insufficient_privilege OR no_data_found THEN
    RETURN admin.vote_refused(v_me, 'property_act', v_ref, p_action, SQLERRM, SQLSTATE);
  END;
  PERFORM admin.audit_append(v_me::text, 'property.act', jsonb_build_object('action', p_action, 'sponsor', a->>'sponsor', 'property', v_property, 'result', v_r));
  RETURN jsonb_build_object('ok', true, 'result', v_r);
END $$;

-- ================================================================== PO-3 reads
CREATE FUNCTION admin.onboarding(p_session bytea) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'property.read');
  v_handle text := admin.handle_of(v_me);
  v_scope uuid[] := admin.property_scope(p_session);
BEGIN
  RETURN jsonb_build_object(
    'me', jsonb_build_object('handle', v_handle,
            'duties', coalesce((SELECT jsonb_agg(d.duty ORDER BY d.duty) FROM property.staff_duties d WHERE d.actor = v_handle AND d.status = 'active'), '[]'::jsonb)),
    'queue', coalesce((SELECT jsonb_agg(q ORDER BY q->>'since') FROM (
        SELECT jsonb_build_object('kind', 'request', 'id', r.id, 'entity', r.entity, 'entityId', r.entity_id, 'what', r.code || ' requested by ' || r.requested_by, 'since', r.requested_at) AS q
          FROM property.requests r
         WHERE r.status = 'open' AND r.expires_at > now()
           AND (v_scope IS NULL OR (r.entity = 'property' AND admin.property_in_scope(v_scope, r.entity_id)))
        UNION ALL
        SELECT jsonb_build_object('kind', 'possible_duplicate', 'id', c.id, 'entity', 'property', 'entityId', k.property_id,
                                  'what', array_to_string(c.reasons, ', ') || ' vs ' || c.candidate_id, 'since', k.at)
          FROM property.duplicate_candidates c JOIN property.duplicate_checks k ON k.id = c.check_id
          JOIN property.properties p ON p.id = k.property_id AND p.state = 'submitted'
         WHERE c.kind = 'possible' AND k.id = (SELECT max(x.id) FROM property.duplicate_checks x WHERE x.property_id = k.property_id)
           AND property.candidate_status(c.id) = 'open' AND admin.property_in_scope(v_scope, k.property_id)
        UNION ALL
        SELECT jsonb_build_object('kind', 'blocked_submission', 'id', k.id, 'entity', 'property', 'entityId', k.property_id,
                                  'what', CASE WHEN k.fraud THEN 'exact duplicate of a tokenized property (fraud indicator)' ELSE 'exact duplicate' END, 'since', k.at)
          FROM property.duplicate_checks k WHERE k.outcome = 'blocked' AND admin.property_in_scope(v_scope, k.property_id)) x), '[]'::jsonb),
    'sponsors', CASE WHEN v_scope IS NOT NULL THEN '[]'::jsonb ELSE coalesce((SELECT jsonb_agg(jsonb_build_object(
        'id', s.sponsor_id, 'kind', s.kind, 'state', s.state, 'cuinLast4', s.cuin_last4, 'ntnLast4', s.ntn_last4, 'kybValidUntil', s.kyb_valid_until,
        'properties', (SELECT count(*) FROM property.properties p WHERE p.sponsor_id = s.sponsor_id), 'createdAt', s.created_at) ORDER BY s.created_at DESC)
      FROM property.sponsor_overview s), '[]'::jsonb) END,
    'properties', coalesce((SELECT jsonb_agg(admin.property_json(o.property_id) || jsonb_build_object('sponsorId', o.sponsor_id, 'stateSince', o.state_since) ORDER BY o.created_at DESC)
      FROM property.property_overview o WHERE admin.property_in_scope(v_scope, o.property_id)), '[]'::jsonb),
    'duties', CASE WHEN v_scope IS NOT NULL THEN '[]'::jsonb ELSE coalesce((SELECT jsonb_agg(jsonb_build_object(
        'id', d.id, 'officer', d.actor, 'duty', d.duty, 'status', d.status, 'requestedBy', d.requested_by, 'requestedAt', d.requested_at,
        'reason', d.reason, 'decidedBy', d.decided_by) ORDER BY d.status, d.actor, d.duty)
      FROM property.staff_duties d WHERE d.status IN ('pending', 'active')), '[]'::jsonb) END,
    'valuers', coalesce((SELECT jsonb_agg(jsonb_build_object('id', v.id, 'licence', v.licence_no, 'panel', v.panel, 'addedBy', v.added_by, 'approvedBy', v.approved_by) ORDER BY v.id)
      FROM property.valuers v), '[]'::jsonb));
END $$;

/** PO-2 for administrators (/officers): S-01 duties of every officer and the valuer panel. */
CREATE FUNCTION admin.property_duties(p_session bytea) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
BEGIN
  PERFORM admin.require(p_session, 'officers.read');
  RETURN jsonb_build_object(
    'duties', coalesce((SELECT jsonb_agg(jsonb_build_object('id', d.id, 'officer', d.actor, 'duty', d.duty, 'status', d.status, 'requestedBy', d.requested_by,
                                                            'requestedAt', d.requested_at, 'reason', d.reason, 'decidedBy', d.decided_by) ORDER BY d.status DESC, d.actor, d.duty)
                        FROM property.staff_duties d WHERE d.status IN ('pending', 'active')), '[]'::jsonb),
    'valuers', coalesce((SELECT jsonb_agg(jsonb_build_object('id', v.id, 'licence', v.licence_no, 'panel', v.panel, 'addedBy', v.added_by, 'approvedBy', v.approved_by) ORDER BY v.id)
                         FROM property.valuers v), '[]'::jsonb),
    'dutyRoles', (SELECT jsonb_object_agg(d, to_jsonb(admin.duty_roles(d)))
                  FROM unnest(ARRAY['onboarding', 'compliance', 'compliance_senior', 'legal', 'legal_head', 'valuation', 'technical', 'ic_member', 'ic_independent', 'trustee']) d));
END $$;

CREATE FUNCTION admin.onboarding_events(p_entity text, p_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
  SELECT coalesce(jsonb_agg(e ORDER BY e->>'at' DESC), '[]'::jsonb) FROM (
    SELECT jsonb_build_object('code', x.code, 'from', x.from_state, 'to', x.to_state, 'actor', x.actor, 'actingFor', x.acting_for, 'reason', x.reason,
                              'checker', x.checker, 'at', x.at) AS e
      FROM property.sponsor_events x WHERE p_entity = 'sponsor' AND x.sponsor_id = p_id
    UNION ALL
    SELECT jsonb_build_object('code', x.code, 'from', x.from_state, 'to', x.to_state, 'actor', x.actor, 'actingFor', x.acting_for, 'reason', x.reason,
                              'checker', x.checker, 'at', x.at)
      FROM property.property_events x WHERE p_entity = 'property' AND x.property_id = p_id) y
$$;

CREATE FUNCTION admin.onboarding_documents(p_sponsor uuid, p_property uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', d.document_id, 'type', d.doc_type, 'sha256', d.sha256, 'sizeBytes', d.size_bytes, 'mediaType', d.media_type,
                                               'uploadedAt', d.uploaded_at,
                                               'verifications', (SELECT count(*) FROM property.document_verifications v WHERE v.document_id = d.document_id))
                            ORDER BY d.uploaded_at DESC), '[]'::jsonb)
  FROM property.document_list d
  WHERE d.current AND d.sponsor_id = p_sponsor AND d.property_id IS NOT DISTINCT FROM p_property
$$;

CREATE FUNCTION admin.onboarding_sponsor(p_session bytea, p_sponsor uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_scope uuid[];
BEGIN
  PERFORM admin.require(p_session, 'property.read');
  v_scope := admin.property_scope(p_session);
  IF v_scope IS NOT NULL OR NOT EXISTS (SELECT 1 FROM property.sponsors WHERE id = p_sponsor) THEN RETURN NULL; END IF;
  RETURN (SELECT jsonb_build_object(
    'id', s.sponsor_id, 'kind', s.kind, 'state', s.state, 'cuinLast4', s.cuin_last4, 'ntnLast4', s.ntn_last4, 'kybValidUntil', s.kyb_valid_until, 'createdAt', s.created_at,
    'people', coalesce((SELECT jsonb_agg(jsonb_build_object('id', p.id, 'subject', left(p.subject_id::text, 8), 'role', p.role, 'ownershipBp', p.ownership_bp,
                                                            'control', p.control_basis, 'chainDepth', p.chain_depth, 'powers', p.powers, 'addedBy', p.added_by, 'addedAt', p.added_at)
                                         ORDER BY p.id)
                        FROM property.sponsor_persons p WHERE p.sponsor_id = s.sponsor_id AND p.ended_at IS NULL), '[]'::jsonb),
    'registrationChecks', coalesce((SELECT jsonb_agg(jsonb_build_object('method', r.method, 'outcome', r.outcome, 'by', r.checked_by, 'at', r.at) ORDER BY r.id DESC)
                                    FROM property.registration_checks r WHERE r.sponsor_id = s.sponsor_id), '[]'::jsonb),
    'screenings', coalesce((SELECT jsonb_agg(jsonb_build_object('provider', r.provider, 'listVersion', r.list_version, 'outcome', r.outcome, 'basis', r.basis,
                                                                'by', r.recorded_by, 'at', r.at) ORDER BY r.id DESC)
                            FROM property.sponsor_screenings r WHERE r.sponsor_id = s.sponsor_id), '[]'::jsonb),
    'risk', coalesce((SELECT jsonb_agg(jsonb_build_object('rating', r.rating, 'reasons', r.reasons, 'edd', r.edd_sha256 IS NOT NULL, 'by', r.rated_by, 'at', r.at) ORDER BY r.id DESC)
                      FROM property.risk_ratings r WHERE r.sponsor_id = s.sponsor_id), '[]'::jsonb),
    'fmu', coalesce((SELECT jsonb_agg(jsonb_build_object('outcome', r.outcome, 'by', r.assessed_by, 'at', r.at) ORDER BY r.id DESC)
                     FROM property.fmu_assessments r WHERE r.sponsor_id = s.sponsor_id), '[]'::jsonb),
    'documents', admin.onboarding_documents(s.sponsor_id, NULL),
    'properties', coalesce((SELECT jsonb_agg(admin.property_json(p.id) ORDER BY p.created_at DESC) FROM property.properties p WHERE p.sponsor_id = s.sponsor_id), '[]'::jsonb),
    'events', admin.onboarding_events('sponsor', s.sponsor_id),
    'vault', admin.onboarding_vault())
  FROM property.sponsor_overview s WHERE s.sponsor_id = p_sponsor);
END $$;

/** Vault files not yet recorded as an S-01 document (newest first), to pick from when adding one. */
CREATE FUNCTION admin.onboarding_vault() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('sha256', encode(o.sha256, 'hex'), 'sizeBytes', o.size_bytes, 'mediaType', o.media_type, 'by', o.created_by, 'at', o.created_at)
                            ORDER BY o.created_at DESC), '[]'::jsonb)
  FROM (SELECT * FROM vault.objects o
         WHERE NOT EXISTS (SELECT 1 FROM property.documents d WHERE d.store_ref = 'vault://' || encode(o.sha256, 'hex'))
         ORDER BY o.created_at DESC LIMIT 50) o
$$;

CREATE FUNCTION admin.onboarding_property(p_session bytea, p_property uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_scope uuid[];
BEGIN
  PERFORM admin.require(p_session, 'property.read');
  v_scope := admin.property_scope(p_session);
  IF NOT EXISTS (SELECT 1 FROM property.properties WHERE id = p_property) OR NOT admin.property_in_scope(v_scope, p_property) THEN RETURN NULL; END IF;
  RETURN (SELECT admin.property_json(o.property_id) || jsonb_build_object(
    'sponsorId', o.sponsor_id, 'previousId', o.previous_id, 'occupancy', o.occupancy, 'built', o.built, 'submittedAt', o.submitted_at, 'stateSince', o.state_since,
    'sponsorPeople', CASE WHEN v_scope IS NULL THEN coalesce((SELECT jsonb_agg(jsonb_build_object('id', p.id, 'role', p.role, 'powers', p.powers) ORDER BY p.id)
                       FROM property.sponsor_persons p WHERE p.sponsor_id = o.sponsor_id AND p.ended_at IS NULL AND p.powers IS NOT NULL), '[]'::jsonb) ELSE '[]'::jsonb END,
    'reviews', coalesce((SELECT jsonb_agg(jsonb_build_object('discipline', r.discipline, 'reviewId', r.review_id, 'reviewer', r.reviewer, 'decision', r.decision, 'fresh', r.fresh))
                         FROM property.review_status(o.property_id) r), '[]'::jsonb),
    'assignments', coalesce((SELECT jsonb_agg(jsonb_build_object('group', x.grp, 'reviewer', x.reviewer, 'by', x.assigned_by, 'at', x.at) ORDER BY x.grp)
                             FROM (SELECT DISTINCT ON (grp) * FROM property.assignments WHERE property_id = o.property_id ORDER BY grp, id DESC) x), '[]'::jsonb),
    'valuation', (SELECT jsonb_build_object('ok', v.ok, 'problem', v.problem, 'valuations', v.valuations, 'lowestPaisa', v.lowest_paisa::text)
                  FROM property.valuation_status(o.property_id) v),
    'valuations', coalesce((SELECT jsonb_agg(jsonb_build_object('id', v.id, 'valuer', u.licence_no, 'valuePaisa', v.value_paisa::text, 'on', v.valued_on, 'by', v.recorded_by) ORDER BY v.id DESC)
                            FROM property.valuations v JOIN property.valuers u ON u.id = v.valuer_id WHERE v.property_id = o.property_id), '[]'::jsonb),
    'candidates', coalesce((SELECT jsonb_agg(jsonb_build_object('id', c.id, 'candidate', c.candidate_id, 'kind', c.kind, 'reasons', c.reasons, 'status', property.candidate_status(c.id)))
                            FROM property.duplicate_candidates c JOIN property.duplicate_checks k ON k.id = c.check_id
                            WHERE k.property_id = o.property_id AND k.id = (SELECT max(x.id) FROM property.duplicate_checks x WHERE x.property_id = o.property_id)), '[]'::jsonb),
    'documents', admin.onboarding_documents(o.sponsor_id, o.property_id),
    'titleLinks', coalesce((SELECT jsonb_agg(jsonb_build_object('position', t.position, 'kind', t.kind, 'ref', t.instrument_ref, 'on', t.registered_on, 'document', t.document_id,
                                                                'by', t.recorded_by) ORDER BY t.position, t.id)
                            FROM property.title_links t WHERE t.property_id = o.property_id), '[]'::jsonb),
    'encumbrances', coalesce((SELECT jsonb_agg(jsonb_build_object('id', e.id, 'kind', e.kind, 'description', e.description, 'by', e.found_by, 'at', e.at,
                                                                  'resolution', r.resolution, 'resolvedBy', r.resolved_by) ORDER BY e.id)
                              FROM property.encumbrances e LEFT JOIN property.encumbrance_resolutions r ON r.encumbrance_id = e.id WHERE e.property_id = o.property_id), '[]'::jsonb),
    'structure', (SELECT jsonb_build_object('id', s.id, 'kind', s.kind, 'shariah', s.shariah, 'rights', s.unit_rights, 'plannedUnits', s.planned_units::text,
                                            'maxHoldingUnits', s.max_holding_units::text, 'by', s.decided_by, 'at', s.at)
                  FROM property.structures s WHERE s.property_id = o.property_id ORDER BY s.id DESC LIMIT 1),
    'valuers', coalesce((SELECT jsonb_agg(jsonb_build_object('id', v.id, 'licence', v.licence_no, 'panel', v.panel) ORDER BY v.id)
                         FROM property.valuers v WHERE v.approved_by IS NOT NULL), '[]'::jsonb),
    'events', admin.onboarding_events('property', o.property_id),
    'vault', admin.onboarding_vault())
  FROM property.property_overview o WHERE o.property_id = p_property);
END $$;

-- ================================================================== privileges
REVOKE ALL ON FUNCTION admin.property_act(bytea, text, jsonb), admin.onboarding(bytea), admin.onboarding_events(text, uuid),
  admin.onboarding_documents(uuid, uuid), admin.onboarding_sponsor(bytea, uuid), admin.onboarding_vault(), admin.onboarding_property(bytea, uuid), admin.property_duties(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.property_act(bytea, text, jsonb), admin.onboarding(bytea), admin.onboarding_sponsor(bytea, uuid), admin.onboarding_property(bytea, uuid),
  admin.property_duties(bytea) TO pt_admin_portal;

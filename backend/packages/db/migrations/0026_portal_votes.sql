-- Internal portals: the remaining officer votes in PT Control (task T-046, ADR 0011 section 13).
--
-- Numbered 0026 on top of 0024 (T-030); 0025 is reserved for parallel work and must be merged
-- first (the backend runner refuses the gap; tests use contiguousMigrations()).
--
-- Every vote and decision the S-01 / S-02 workflows need from an officer can now be cast in the
-- portal, with the officer's session, a security-key step-up younger than five minutes and the
-- digest of what the officer saw. The rules stay in the backend functions of 0014 / 0015 (quorum,
-- independence, segregation of duties, maker-checker, expiry); the admin.* functions below only
-- check the session, the permission, the step-up and the digest, then run the backend function
-- under the officer's handle in the same transaction (pattern of 0016 A-2).
--
--   V-1  Permissions: committee.vote (operations makers and checkers, compliance officers: the
--        roles admin.duty_roles allows for the committee duties); offering.read (operations makers
--        and checkers, compliance officers, auditors); offering.decide (operations checkers and
--        compliance officers: platform votes on S-02 requests). Committees are read with
--        property.read (0016); the trustee's P8 acceptance uses trustee.read / trustee.decide (0023).
--        The role matrix digest is fixed again.
--   V-2  Officer names bound to sessions (closes ADR 0011 open item 3 for these records): an
--        investment-committee vote, the close of a committee meeting and the trustee's decision on
--        a property (P8) under a portal officer's handle are refused unless the admin function that
--        checked that officer's session is on the stack (admin.decision_context, as 0016 A-3). The
--        command line can no longer cast them under an officer's handle, and S-01 duties are held
--        by portal officers only (0016 A-7), so these decisions are portal-only.
--   V-3  Investment committee (S-01 P7, OB-33): list of open meetings and files ready for one;
--        the chair opens a meeting; each member votes approve, reject or abstain with a reason, or
--        records a conflict (the reason is the conflict note); the chair closes with the SHA-256 of
--        the minutes. Quorum, independence, the majority rule and OB-SOD-1 are property.cast_vote /
--        property.close_ic's own (0014). A vote is bound to the digest of the file as shown (state,
--        reviews, valuations, current documents); the close to the same digest plus the votes. The
--        vote's reason is recorded in the property audit chain next to the vote.
--   V-4  Trustee acceptance (S-01 P8, OB-37): a trustee officer accepts or declines the latest
--        structure of a Legal Approved property (property.trustee_decide), bound to the digest of
--        the structure, the committee's outcome and the current documents. New rule: the trustee's
--        decision on a structure is final (a declined structure is never accepted later; the legal
--        head records a new structure decision instead).
--   V-5  Platform votes on S-02 requests (L3 terms by the offering checker, documents by the legal
--        head, eligibility and disclosures by compliance; and L7, L8, L10, L13, L16, IB, SD, V17,
--        V20 where a platform duty is needed): offering.decide under the officer's handle, bound
--        to admin.offering_request_digest (0023). The trustee's own votes stay in Trustee >
--        Co-signing. An offering pending approval may be returned to draft (L2, e.g. after its L3
--        request expired) through offering.return_offering.
--   V-6  Every view (page.view), decision and refusal is in the admin audit; the backend functions
--        write their own audit (property, offering, trustee) as before.

-- ================================================================== V-1 permissions
INSERT INTO admin.role_permissions (role, permission) VALUES
  ('ops_maker', 'committee.vote'), ('ops_checker', 'committee.vote'), ('compliance_officer', 'committee.vote'),
  ('ops_maker', 'offering.read'), ('ops_checker', 'offering.read'), ('compliance_officer', 'offering.read'), ('auditor', 'offering.read'),
  ('ops_checker', 'offering.decide'), ('compliance_officer', 'offering.decide');

DO $$
BEGIN
  EXECUTE format('CREATE OR REPLACE FUNCTION admin.expected_role_matrix_digest() RETURNS text LANGUAGE sql IMMUTABLE AS %L',
                 format('SELECT %L::text', admin.role_matrix_digest()));
END $$;

-- ================================================================== V-2 officer names bound to sessions
CREATE FUNCTION admin.bind_ic_vote() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
BEGIN
  PERFORM admin.guard_officer_name(NEW.member, 'investment committee vote by');
  RETURN NEW;
END $$;
CREATE TRIGGER ic_votes_officer_binding BEFORE INSERT ON property.ic_votes FOR EACH ROW EXECUTE FUNCTION admin.bind_ic_vote();

CREATE FUNCTION admin.bind_ic_close() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    PERFORM admin.guard_officer_name(NEW.chair, 'investment committee close by');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ic_meetings_officer_binding BEFORE UPDATE ON property.ic_meetings FOR EACH ROW EXECUTE FUNCTION admin.bind_ic_close();

CREATE FUNCTION admin.bind_trustee_decision() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
BEGIN
  PERFORM admin.guard_officer_name(NEW.trustee, 'trustee acceptance by');
  RETURN NEW;
END $$;
CREATE TRIGGER trustee_decisions_officer_binding BEFORE INSERT ON property.trustee_decisions FOR EACH ROW EXECUTE FUNCTION admin.bind_trustee_decision();

-- ================================================================== helpers
/** A refused vote: audited (returned, not raised, so the entry stays), with the SQLSTATE of the backend's refusal. */
CREATE FUNCTION admin.vote_refused(p_officer uuid, p_kind text, p_ref text, p_decision text, p_error text, p_state text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
BEGIN
  RETURN admin.refuse(p_officer, p_kind, p_ref, p_decision, p_error) || jsonb_build_object('state', coalesce(p_state, '42501'));
END $$;

/** A reason of 10 to 500 characters (recorded in the audit chains). */
CREATE FUNCTION admin.reason_ok(p_reason text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT p_reason IS NOT NULL AND length(btrim(p_reason)) BETWEEN 10 AND 500
$$;

/** Whether the officer behind this id holds a permission through an unrevoked role. */
CREATE FUNCTION admin.officer_has(p_officer uuid, p_permission text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
  SELECT EXISTS (SELECT 1 FROM admin.role_grants g JOIN admin.role_permissions p ON p.role = g.role
                 WHERE g.officer_id = p_officer AND g.revoked_at IS NULL AND p.permission = p_permission)
$$;

/** A property as the portal shows it: identifiers of the building (no sponsor names or sealed values). */
CREATE FUNCTION admin.property_json(p_property uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
  SELECT jsonb_build_object('id', p.id, 'state', p.state, 'province', p.province, 'district', p.district, 'building', p.building,
                            'use', p.use, 'propertyKey', p.property_key,
                            'sponsorState', property.sponsor_state(p.sponsor_id))
  FROM property.properties p WHERE p.id = p_property
$$;

/** Current documents of a property: type and SHA-256 (the store reference stays in the database). */
CREATE FUNCTION admin.property_documents_json(p_property uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', d.document_id, 'type', d.doc_type, 'sha256', d.sha256, 'uploadedAt', admin.utc(d.uploaded_at))
                            ORDER BY d.doc_type, d.uploaded_at), '[]'::jsonb)
  FROM property.document_list d WHERE d.property_id = p_property AND d.current
$$;

-- ================================================================== V-3 investment committee
/**
 * What a committee member reviews: the meeting, the property's state, the latest review of every
 * discipline, the valuations and the current documents; with p_votes also the votes so far (what
 * the chair closes on).
 */
CREATE FUNCTION admin.committee_digest(p_meeting bigint, p_votes boolean) RETURNS bytea
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
  SELECT sha256(convert_to('pt-committee-v1' || jsonb_build_array(
           m.id, m.property_id, m.chair, admin.utc(m.opened_at), m.status, p.state,
           (SELECT jsonb_agg(jsonb_build_array(r.discipline, r.review_id, r.decision, r.fresh) ORDER BY r.discipline) FROM property.review_status(m.property_id) r),
           (SELECT jsonb_agg(jsonb_build_array(v.id, v.value_paisa::text, v.valuer_id, v.report_document_id) ORDER BY v.id) FROM property.valuations v WHERE v.property_id = m.property_id),
           (SELECT jsonb_agg(jsonb_build_array(d.document_id, d.sha256) ORDER BY d.document_id) FROM property.document_list d WHERE d.property_id = m.property_id AND d.current),
           CASE WHEN p_votes THEN coalesce((SELECT jsonb_agg(jsonb_build_array(x.id, x.member, x.vote, x.conflict, x.independent) ORDER BY x.id)
                                            FROM property.ic_votes x WHERE x.meeting_id = m.id), '[]'::jsonb) END)::text, 'UTF8'))
  FROM property.ic_meetings m JOIN property.properties p ON p.id = m.property_id WHERE m.id = p_meeting
$$;

/** Why this officer cannot vote (or record a conflict) in this meeting now (empty = they can). */
CREATE FUNCTION admin.committee_vote_blockers(p_officer uuid, m property.ic_meetings) RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_handle text := admin.handle_of(p_officer);
  v text[] := '{}';
BEGIN
  IF NOT admin.officer_has(p_officer, 'committee.vote') THEN
    v := v || 'Only operations officers and compliance officers with a committee duty vote; your role reviews.'::text;
  END IF;
  IF m.status <> 'open' THEN v := v || format('The meeting is closed (%s).', m.status); END IF;
  IF NOT property.has_duty(v_handle, ARRAY['ic_member', 'ic_independent']) THEN
    v := v || 'Voting needs an active investment committee duty (ic_member or ic_independent, granted in S-01 duties).'::text;
  END IF;
  IF v_handle = ANY (coalesce(property.parties(m.property_id), '{}')) THEN
    v := v || 'You are a party to this file (entered, submitted or reviewed it): you take no part in its committee (OB-SOD-1).'::text;
  END IF;
  IF EXISTS (SELECT 1 FROM property.ic_votes WHERE meeting_id = m.id AND member = v_handle) THEN
    v := v || 'You already voted in this meeting.'::text;
  END IF;
  RETURN v;
END $$;

/** Why this officer cannot close this meeting now (empty = they can). */
CREATE FUNCTION admin.committee_close_blockers(p_officer uuid, m property.ic_meetings) RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v text[] := '{}';
  o record;
BEGIN
  IF NOT admin.officer_has(p_officer, 'committee.vote') THEN
    v := v || 'Only the chair closes the meeting; your role reviews.'::text;
  END IF;
  IF m.status <> 'open' THEN v := v || format('The meeting is closed (%s).', m.status); END IF;
  IF m.chair <> admin.handle_of(p_officer) THEN v := v || format('Only the chair (%s) closes the meeting.', m.chair); END IF;
  SELECT * INTO o FROM property.ic_outcome(m.id);
  IF m.status = 'open' AND NOT coalesce(o.quorum, false) THEN
    v := v || format('No quorum yet: %s non-conflicted vote(s); %s are needed, including an independent member (OB-33).',
                     coalesce(o.voters, 0), property.setting('ic_quorum')::int);
  END IF;
  RETURN v;
END $$;

/** Why this officer cannot open a committee for this property now (empty = they can). */
CREATE FUNCTION admin.committee_open_blockers(p_officer uuid, p_property uuid) RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_handle text := admin.handle_of(p_officer);
  v text[] := '{}';
  v_state text := (SELECT state FROM property.properties WHERE id = p_property);
  v_problem text;
BEGIN
  IF NOT admin.officer_has(p_officer, 'committee.vote') THEN
    v := v || 'Only a committee member chairs a meeting; your role reviews.'::text;
  END IF;
  IF v_state IS DISTINCT FROM 'under_review' THEN v := v || format('The property is %s, not under review.', coalesce(v_state, 'unknown')); END IF;
  IF EXISTS (SELECT 1 FROM property.ic_meetings WHERE property_id = p_property AND status = 'open') THEN
    v := v || 'A meeting is already open for this property.'::text;
  END IF;
  IF NOT property.has_duty(v_handle, ARRAY['ic_member', 'ic_independent']) THEN
    v := v || 'Chairing needs an active investment committee duty.'::text;
  END IF;
  IF v_handle = ANY (coalesce(property.parties(p_property), '{}')) THEN
    v := v || 'You are a party to this file: you cannot chair its committee (OB-SOD-1).'::text;
  END IF;
  IF v_state = 'under_review' THEN
    v_problem := property.p7_problem(p_property);
    IF v_problem IS NOT NULL THEN v := v || ('Not ready for the committee: ' || v_problem); END IF;
  END IF;
  RETURN v;
END $$;

CREATE FUNCTION admin.committee_row(m property.ic_meetings, p_handle text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
  SELECT jsonb_build_object(
    'id', m.id, 'status', m.status, 'chair', m.chair, 'openedAt', admin.utc(m.opened_at), 'closedAt', admin.utc(m.closed_at),
    'property', admin.property_json(m.property_id),
    'votes', (SELECT count(*) FROM property.ic_votes v WHERE v.meeting_id = m.id),
    'quorum', (SELECT o.quorum FROM property.ic_outcome(m.id) o),
    'mine', EXISTS (SELECT 1 FROM property.ic_votes v WHERE v.meeting_id = m.id AND v.member = p_handle),
    'chairIsMe', m.chair = p_handle)
$$;

/** Committee overview: open meetings, files ready for a committee, the latest closed meetings. */
CREATE FUNCTION admin.committees(p_session bytea) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'property.read');
  v_handle text := admin.handle_of(v_me);
BEGIN
  RETURN jsonb_build_object(
    'at', admin.utc(clock_timestamp()),
    'quorum', property.setting('ic_quorum')::int,
    'open', coalesce((SELECT jsonb_agg(admin.committee_row(m, v_handle) ORDER BY m.id) FROM property.ic_meetings m WHERE m.status = 'open'), '[]'::jsonb),
    'ready', coalesce((SELECT jsonb_agg(jsonb_build_object('property', admin.property_json(p.id), 'openBlockers', to_jsonb(admin.committee_open_blockers(v_me, p.id)))
                                        ORDER BY p.created_at)
                       FROM property.properties p
                       WHERE p.state = 'under_review' AND property.p7_problem(p.id) IS NULL
                         AND NOT EXISTS (SELECT 1 FROM property.ic_meetings m WHERE m.property_id = p.id AND m.status = 'open')), '[]'::jsonb),
    'recent', coalesce((SELECT jsonb_agg(admin.committee_row(m, v_handle) ORDER BY m.closed_at DESC)
                        FROM (SELECT * FROM property.ic_meetings WHERE status <> 'open' ORDER BY closed_at DESC LIMIT 10) m), '[]'::jsonb));
END $$;

/** One meeting with the file the members decide on, the votes, the outcome so far and the digests. */
CREATE FUNCTION admin.committee(p_session bytea, p_meeting bigint) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'property.read');
  v_handle text := admin.handle_of(v_me);
  m property.ic_meetings;
  o record;
  val record;
BEGIN
  SELECT * INTO m FROM property.ic_meetings WHERE id = p_meeting;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO o FROM property.ic_outcome(m.id);
  SELECT * INTO val FROM property.valuation_status(m.property_id);
  RETURN jsonb_build_object(
    'id', m.id, 'status', m.status, 'chair', m.chair, 'openedAt', admin.utc(m.opened_at), 'closedAt', admin.utc(m.closed_at),
    'minutesSha256', encode(m.minutes_sha256, 'hex'), 'acceptedQualifications', m.accepted_qualifications,
    'property', admin.property_json(m.property_id),
    'reviews', coalesce((SELECT jsonb_agg(jsonb_build_object('discipline', r.discipline, 'review', r.review_id, 'reviewer', r.reviewer,
                                                             'decision', r.decision, 'fresh', r.fresh) ORDER BY r.discipline)
                         FROM property.review_status(m.property_id) r), '[]'::jsonb),
    'qualifications', (SELECT r.conditions FROM property.reviews r WHERE r.property_id = m.property_id AND r.discipline = 'legal_opinion' ORDER BY r.seq DESC LIMIT 1),
    'valuation', jsonb_build_object('ok', val.ok, 'problem', val.problem, 'count', val.valuations, 'lowestPaisa', val.lowest_paisa::text),
    'documents', admin.property_documents_json(m.property_id),
    'p7Problem', CASE WHEN m.status = 'open' THEN property.p7_problem(m.property_id) END,
    'votes', coalesce((SELECT jsonb_agg(jsonb_build_object('member', v.member, 'independent', v.independent, 'conflict', v.conflict,
                                                           'conflictNote', v.conflict_note, 'vote', v.vote, 'at', admin.utc(v.at),
                                                           'reason', (SELECT a.detail->>'reason' FROM property.audit a WHERE a.detail->>'ref' = 'ic_votes:' || v.id || ':reason' LIMIT 1))
                                        ORDER BY v.id)
                       FROM property.ic_votes v WHERE v.meeting_id = m.id), '[]'::jsonb),
    'outcome', jsonb_build_object('quorum', coalesce(o.quorum, false), 'approved', coalesce(o.approved, false), 'voters', coalesce(o.voters, 0),
                                  'approvals', coalesce(o.approvals, 0), 'needed', property.setting('ic_quorum')::int),
    'digest', encode(admin.committee_digest(m.id, false), 'hex'),
    'closeDigest', encode(admin.committee_digest(m.id, true), 'hex'),
    'chairIsMe', m.chair = v_handle,
    'blockers', to_jsonb(admin.committee_vote_blockers(v_me, m)),
    'closeBlockers', to_jsonb(admin.committee_close_blockers(v_me, m)));
END $$;

/** The chair opens a committee meeting for a property (property.open_ic under the officer's handle). */
CREATE FUNCTION admin.open_committee(p_session bytea, p_property uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'committee.vote');
  v_handle text := admin.handle_of(v_me);
  v_id bigint;
BEGIN
  PERFORM admin.require_step_up(p_session);
  IF NOT admin.reason_ok(p_reason) THEN
    RETURN admin.vote_refused(v_me, 'committee.open', coalesce(p_property::text, ''), 'open', 'a reason of 10 to 500 characters is required', '22023');
  END IF;
  BEGIN
    PERFORM admin.bind_officer(v_handle);
    v_id := property.open_ic(p_property, v_handle);
    PERFORM admin.unbind_officer(v_handle);
  EXCEPTION WHEN SQLSTATE '23514' OR SQLSTATE '23505' OR SQLSTATE '42501' OR SQLSTATE '22023' OR SQLSTATE 'P0002' THEN
    RETURN admin.vote_refused(v_me, 'committee.open', coalesce(p_property::text, ''), 'open', SQLERRM, SQLSTATE);
  END;
  PERFORM admin.audit_append(v_me::text, 'approval.decided', jsonb_build_object('kind', 'committee.open', 'ref', v_id, 'property', p_property,
    'decision', 'open', 'result', 'open', 'reason', btrim(p_reason)));
  RETURN jsonb_build_object('ok', true, 'status', 'open', 'meeting', v_id);
END $$;

/**
 * A member's vote (approve | reject | abstain) with a reason, or a conflict (the reason is the
 * conflict note), bound to the digest of the file as shown. property.cast_vote enforces the duty,
 * the open meeting, OB-SOD-1 and one vote per member.
 */
CREATE FUNCTION admin.committee_vote(p_session bytea, p_meeting bigint, p_vote text, p_reason text, p_digest bytea) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'committee.vote');
  v_handle text := admin.handle_of(v_me);
  v_conflict boolean := p_vote = 'conflict';
  v_id bigint;
BEGIN
  PERFORM admin.require_step_up(p_session);
  IF p_vote IS NULL OR p_vote NOT IN ('approve', 'reject', 'abstain', 'conflict') THEN
    RETURN admin.vote_refused(v_me, 'committee.vote', p_meeting::text, coalesce(p_vote, ''), 'vote approve, reject or abstain, or record a conflict', '22023');
  END IF;
  IF NOT admin.reason_ok(p_reason) THEN
    RETURN admin.vote_refused(v_me, 'committee.vote', p_meeting::text, p_vote, 'a reason of 10 to 500 characters is required', '22023');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM property.ic_meetings WHERE id = p_meeting) THEN
    RETURN admin.vote_refused(v_me, 'committee.vote', p_meeting::text, p_vote, 'unknown meeting', 'P0002');
  END IF;
  IF admin.committee_digest(p_meeting, false) IS DISTINCT FROM p_digest THEN
    RETURN admin.vote_refused(v_me, 'committee.vote', p_meeting::text, p_vote, 'the file differs from what you reviewed: reload and check again', '23514');
  END IF;
  BEGIN
    PERFORM admin.bind_officer(v_handle);
    v_id := property.cast_vote(p_meeting, v_handle, CASE WHEN v_conflict THEN NULL ELSE p_vote END, CASE WHEN v_conflict THEN btrim(p_reason) END);
    PERFORM property.audit_append(v_handle, 'ic.vote_reason', jsonb_build_object('ref', 'ic_votes:' || v_id || ':reason', 'meeting', p_meeting,
      'reason', btrim(p_reason), 'digest', encode(p_digest, 'hex')));
    PERFORM admin.unbind_officer(v_handle);
  EXCEPTION WHEN SQLSTATE '23514' OR SQLSTATE '23505' OR SQLSTATE '42501' OR SQLSTATE '22023' OR SQLSTATE 'P0002' THEN
    RETURN admin.vote_refused(v_me, 'committee.vote', p_meeting::text, p_vote, SQLERRM, SQLSTATE);
  END;
  PERFORM admin.audit_append(v_me::text, 'approval.decided', jsonb_build_object('kind', 'committee.vote', 'ref', p_meeting, 'vote', v_id,
    'decision', p_vote, 'result', 'recorded', 'digest', encode(p_digest, 'hex')));
  RETURN jsonb_build_object('ok', true, 'status', p_vote, 'vote', v_id);
END $$;

/** The chair closes the meeting with the SHA-256 of the minutes, bound to the digest including the votes. */
CREATE FUNCTION admin.close_committee(p_session bytea, p_meeting bigint, p_minutes text, p_reason text, p_digest bytea) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'committee.vote');
  v_handle text := admin.handle_of(v_me);
  v_status text;
BEGIN
  PERFORM admin.require_step_up(p_session);
  IF NOT admin.reason_ok(p_reason) THEN
    RETURN admin.vote_refused(v_me, 'committee.close', p_meeting::text, 'close', 'a reason of 10 to 500 characters is required', '22023');
  END IF;
  IF p_minutes IS NULL OR length(p_minutes) <> 64 OR p_minutes !~ '^[0-9a-f]+$' THEN
    RETURN admin.vote_refused(v_me, 'committee.close', p_meeting::text, 'close', 'the minutes are given as their SHA-256 (64 lowercase hex characters)', '22023');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM property.ic_meetings WHERE id = p_meeting) THEN
    RETURN admin.vote_refused(v_me, 'committee.close', p_meeting::text, 'close', 'unknown meeting', 'P0002');
  END IF;
  IF admin.committee_digest(p_meeting, true) IS DISTINCT FROM p_digest THEN
    RETURN admin.vote_refused(v_me, 'committee.close', p_meeting::text, 'close', 'the file or the votes changed since you reviewed them: reload and check again', '23514');
  END IF;
  BEGIN
    PERFORM admin.bind_officer(v_handle);
    v_status := property.close_ic(p_meeting, v_handle, decode(p_minutes, 'hex'));
    PERFORM property.audit_append(v_handle, 'ic.close_note', jsonb_build_object('ref', 'ic_meetings:' || p_meeting || ':note', 'reason', btrim(p_reason),
      'digest', encode(p_digest, 'hex')));
    PERFORM admin.unbind_officer(v_handle);
  EXCEPTION WHEN SQLSTATE '23514' OR SQLSTATE '23505' OR SQLSTATE '42501' OR SQLSTATE '22023' OR SQLSTATE 'P0002' THEN
    RETURN admin.vote_refused(v_me, 'committee.close', p_meeting::text, 'close', SQLERRM, SQLSTATE);
  END;
  PERFORM admin.audit_append(v_me::text, 'approval.decided', jsonb_build_object('kind', 'committee.close', 'ref', p_meeting, 'decision', 'close',
    'result', v_status, 'minutes', p_minutes, 'digest', encode(p_digest, 'hex')));
  RETURN jsonb_build_object('ok', true, 'status', v_status);
END $$;

-- ================================================================== V-4 trustee acceptance (P8)
/** What the trustee reviews: the property, its latest structure, the committee's outcome and the current documents. */
CREATE FUNCTION admin.property_trustee_digest(p_property uuid) RETURNS bytea
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
  SELECT sha256(convert_to('pt-property-trustee-v1' || jsonb_build_array(
           p.id, p.state,
           (SELECT jsonb_build_array(s.id, s.kind, s.shariah, s.unit_rights, s.planned_units::text, s.max_holding_units::text,
                                     s.trust_deed_document_id, s.decided_by, admin.utc(s.at))
            FROM property.structures s WHERE s.property_id = p.id ORDER BY s.id DESC LIMIT 1),
           (SELECT jsonb_build_array(m.id, m.status, encode(m.minutes_sha256, 'hex'), m.accepted_qualifications)
            FROM property.ic_meetings m WHERE m.property_id = p.id AND m.status = 'approved' ORDER BY m.id DESC LIMIT 1),
           (SELECT jsonb_agg(jsonb_build_array(d.document_id, d.sha256) ORDER BY d.document_id) FROM property.document_list d WHERE d.property_id = p.id AND d.current))::text, 'UTF8'))
  FROM property.properties p WHERE p.id = p_property
$$;

/** Why this officer cannot decide on this property's acceptance now (empty = they can). */
CREATE FUNCTION admin.trustee_property_blockers(p_officer uuid, p_property uuid) RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_handle text := admin.handle_of(p_officer);
  v text[] := '{}';
  v_state text := (SELECT state FROM property.properties WHERE id = p_property);
  s property.structures;
BEGIN
  IF NOT admin.officer_has(p_officer, 'trustee.decide') THEN
    v := v || 'Only a trustee officer accepts a property for the trust; your role reviews.'::text;
  END IF;
  IF v_state IS DISTINCT FROM 'legal_approved' THEN v := v || format('The property is %s, not Legal Approved.', coalesce(v_state, 'unknown')); END IF;
  SELECT * INTO s FROM property.structures WHERE property_id = p_property ORDER BY id DESC LIMIT 1;
  IF NOT FOUND THEN
    v := v || 'The legal head has not recorded the structure yet (OB-35).'::text;
  ELSIF EXISTS (SELECT 1 FROM property.trustee_decisions d WHERE d.structure_id = s.id) THEN
    v := v || format('The trustee already decided on structure #%s: a declined structure needs a new structure decision by the legal head.', s.id);
  END IF;
  IF NOT property.has_duty(v_handle, ARRAY['trustee']) THEN
    v := v || 'Deciding needs an active trustee duty (granted in S-01 duties).'::text;
  END IF;
  RETURN v;
END $$;

/** Why an acceptance (not a decline) would be refused now. */
CREATE FUNCTION admin.trustee_property_accept_blockers(p_property uuid) RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v text[] := '{}';
  s property.structures;
  v_problem text;
BEGIN
  SELECT * INTO s FROM property.structures WHERE property_id = p_property ORDER BY id DESC LIMIT 1;
  IF FOUND THEN
    IF NOT property.is_current(s.trust_deed_document_id) THEN v := v || 'The trust deed was superseded after the structure decision.'::text; END IF;
    IF s.shariah AND NOT EXISTS (SELECT 1 FROM property.documents WHERE property_id = p_property AND doc_type = 'shariah_certificate' AND property.is_current(id)) THEN
      v := v || 'A Shariah-compliant structure needs the Shariah certificate (OB-35).'::text;
    END IF;
  END IF;
  IF (SELECT state FROM property.properties WHERE id = p_property) = 'legal_approved' THEN
    v_problem := property.p7_problem(p_property);
    IF v_problem IS NOT NULL THEN v := v || ('The file changed since the committee approved it: ' || v_problem); END IF;
  END IF;
  RETURN v;
END $$;

/** Properties waiting for the trustee (Legal Approved) and the latest trustee decisions. */
CREATE FUNCTION admin.trustee_properties(p_session bytea) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'trustee.read');
BEGIN
  RETURN jsonb_build_object(
    'at', admin.utc(clock_timestamp()),
    'waiting', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'property', admin.property_json(p.id),
        'structure', (SELECT jsonb_build_object('id', s.id, 'kind', s.kind, 'shariah', s.shariah, 'plannedUnits', s.planned_units::text,
                                                'decidedBy', s.decided_by, 'at', admin.utc(s.at),
                                                'decided', EXISTS (SELECT 1 FROM property.trustee_decisions d WHERE d.structure_id = s.id))
                      FROM property.structures s WHERE s.property_id = p.id ORDER BY s.id DESC LIMIT 1),
        'since', (SELECT admin.utc(e.at) FROM property.property_events e WHERE e.property_id = p.id ORDER BY e.id DESC LIMIT 1),
        'blockers', to_jsonb(admin.trustee_property_blockers(v_me, p.id))) ORDER BY p.created_at)
      FROM property.properties p WHERE p.state = 'legal_approved'), '[]'::jsonb),
    'recent', coalesce((SELECT jsonb_agg(jsonb_build_object('id', d.id, 'property', admin.property_json(d.property_id), 'structure', d.structure_id,
                                                            'trustee', d.trustee, 'decision', d.decision, 'reason', d.reason, 'at', admin.utc(d.at)) ORDER BY d.id DESC)
                        FROM (SELECT * FROM property.trustee_decisions ORDER BY id DESC LIMIT 10) d), '[]'::jsonb));
END $$;

/** One property as the trustee decides on it: structure, committee, documents, valuations, earlier decisions, digest. */
CREATE FUNCTION admin.trustee_property(p_session bytea, p_property uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'trustee.read');
  s property.structures;
  val record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM property.properties WHERE id = p_property) THEN RETURN NULL; END IF;
  SELECT * INTO s FROM property.structures WHERE property_id = p_property ORDER BY id DESC LIMIT 1;
  SELECT * INTO val FROM property.valuation_status(p_property);
  RETURN jsonb_build_object(
    'property', admin.property_json(p_property),
    'structure', CASE WHEN s.id IS NOT NULL THEN jsonb_build_object(
        'id', s.id, 'kind', s.kind, 'shariah', s.shariah, 'unitRights', s.unit_rights, 'plannedUnits', s.planned_units::text,
        'maxBalanceBp', s.max_balance_bp, 'maxHoldingUnits', s.max_holding_units::text, 'decidedBy', s.decided_by, 'at', admin.utc(s.at),
        'trustDeed', (SELECT jsonb_build_object('id', d.document_id, 'type', d.doc_type, 'sha256', d.sha256, 'current', d.current)
                      FROM property.document_list d WHERE d.document_id = s.trust_deed_document_id)) END,
    'committee', (SELECT jsonb_build_object('id', m.id, 'chair', m.chair, 'closedAt', admin.utc(m.closed_at), 'minutesSha256', encode(m.minutes_sha256, 'hex'),
                                            'acceptedQualifications', m.accepted_qualifications,
                                            'votes', (SELECT count(*) FROM property.ic_votes v WHERE v.meeting_id = m.id AND NOT v.conflict),
                                            'approvals', (SELECT count(*) FROM property.ic_votes v WHERE v.meeting_id = m.id AND v.vote = 'approve'))
                  FROM property.ic_meetings m WHERE m.property_id = p_property AND m.status = 'approved' ORDER BY m.id DESC LIMIT 1),
    'valuation', jsonb_build_object('ok', val.ok, 'problem', val.problem, 'count', val.valuations, 'lowestPaisa', val.lowest_paisa::text),
    'documents', admin.property_documents_json(p_property),
    'decisions', coalesce((SELECT jsonb_agg(jsonb_build_object('id', d.id, 'structure', d.structure_id, 'trustee', d.trustee, 'decision', d.decision,
                                                               'conditions', d.conditions, 'reason', d.reason, 'at', admin.utc(d.at)) ORDER BY d.id)
                           FROM property.trustee_decisions d WHERE d.property_id = p_property), '[]'::jsonb),
    'digest', encode(admin.property_trustee_digest(p_property), 'hex'),
    'blockers', to_jsonb(admin.trustee_property_blockers(v_me, p_property)),
    'acceptBlockers', to_jsonb(admin.trustee_property_accept_blockers(p_property)));
END $$;

/**
 * Trustee officer: accept or decline the latest structure of a Legal Approved property
 * (property.trustee_decide under the officer's handle), bound to the digest; a structure is decided once.
 */
CREATE FUNCTION admin.decide_property_trustee(p_session bytea, p_property uuid, p_structure bigint, p_decision text, p_conditions text, p_reason text, p_digest bytea)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'trustee.decide');
  v_handle text := admin.handle_of(v_me);
  v_ref text := coalesce(p_property::text, '');
  v_conditions text := nullif(btrim(coalesce(p_conditions, '')), '');
  v_status text;
BEGIN
  PERFORM admin.require_step_up(p_session);
  IF p_decision IS NULL OR p_decision NOT IN ('accept', 'decline') THEN
    RETURN admin.vote_refused(v_me, 'trustee.property', v_ref, coalesce(p_decision, ''), 'decision must be accept or decline', '22023');
  END IF;
  IF NOT admin.reason_ok(p_reason) THEN
    RETURN admin.vote_refused(v_me, 'trustee.property', v_ref, p_decision, 'a reason of 10 to 500 characters is required', '22023');
  END IF;
  IF v_conditions IS NOT NULL AND length(v_conditions) NOT BETWEEN 10 AND 1000 THEN
    RETURN admin.vote_refused(v_me, 'trustee.property', v_ref, p_decision, 'conditions are 10 to 1000 characters (or none)', '22023');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM property.properties WHERE id = p_property) THEN
    RETURN admin.vote_refused(v_me, 'trustee.property', v_ref, p_decision, 'unknown property', 'P0002');
  END IF;
  IF admin.property_trustee_digest(p_property) IS DISTINCT FROM p_digest THEN
    RETURN admin.vote_refused(v_me, 'trustee.property', v_ref, p_decision, 'the file differs from what you reviewed: reload and check again', '23514');
  END IF;
  -- V-4: the trustee's decision on a structure is final.
  IF EXISTS (SELECT 1 FROM property.trustee_decisions WHERE structure_id = p_structure) THEN
    RETURN admin.vote_refused(v_me, 'trustee.property', v_ref, p_decision, format('the trustee already decided on structure %s', p_structure), '23514');
  END IF;
  BEGIN
    PERFORM admin.bind_officer(v_handle);
    v_status := property.trustee_decide(p_property, v_handle, p_structure, p_decision = 'accept', v_conditions, btrim(p_reason));
    PERFORM admin.unbind_officer(v_handle);
  EXCEPTION WHEN SQLSTATE '23514' OR SQLSTATE '23505' OR SQLSTATE '42501' OR SQLSTATE '22023' OR SQLSTATE 'P0002' THEN
    RETURN admin.vote_refused(v_me, 'trustee.property', v_ref, p_decision, SQLERRM, SQLSTATE);
  END;
  PERFORM trustee.audit_append(v_handle, 'property.' || p_decision || 'ed', jsonb_build_object('property', p_property, 'structure', p_structure,
    'decision', p_decision, 'result', v_status, 'reason', btrim(p_reason), 'conditions', v_conditions, 'digest', encode(p_digest, 'hex')));
  PERFORM admin.audit_append(v_me::text, 'approval.decided', jsonb_build_object('kind', 'trustee.property', 'ref', p_property, 'structure', p_structure,
    'decision', p_decision, 'result', v_status, 'digest', encode(p_digest, 'hex')));
  RETURN jsonb_build_object('ok', true, 'status', v_status);
END $$;

-- ================================================================== V-5 platform votes on S-02 requests
/** The platform duties (not the trustee's) an open request still lacks, one entry per missing approval. */
CREATE FUNCTION admin.offering_missing_duties(q offering.requests) RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
  SELECT coalesce(array_agg(n.duty ORDER BY n.duty), '{}') FROM (
    SELECT x AS duty, count(*) AS needed FROM offering.request_rules rr, unnest(rr.needs) x WHERE rr.code = q.code AND x <> 'trustee' GROUP BY x
  ) n, generate_series(1, (n.needed - (SELECT count(*) FROM offering.request_votes v WHERE v.request_id = q.id AND v.duty = n.duty AND v.approve))::int)
  WHERE q.status = 'open'
$$;

/** Why this officer cannot cast a platform vote on this request now (empty = they can). */
CREATE FUNCTION admin.offering_vote_blockers(p_officer uuid, q offering.requests) RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_handle text := admin.handle_of(p_officer);
  v text[] := '{}';
  rr offering.request_rules;
  o offering.offerings;
  v_missing text[] := admin.offering_missing_duties(q);
BEGIN
  SELECT * INTO rr FROM offering.request_rules WHERE code = q.code;
  SELECT * INTO o FROM offering.offerings WHERE id = q.offering_id;
  IF NOT admin.officer_has(p_officer, 'offering.decide') THEN
    v := v || 'Only an operations checker or a compliance officer votes on offering requests here; trustee votes are in Trustee > Co-signing.'::text;
  END IF;
  IF q.status <> 'open' THEN v := v || format('The request is %s.', q.status); END IF;
  IF q.status = 'open' AND rr.expires AND q.expires_at < now() THEN v := v || 'The request has expired (72 hours).'::text; END IF;
  IF q.status = 'open' AND rr.stale_on_state AND o.state IS DISTINCT FROM q.offering_state THEN
    v := v || format('The offering moved from %s to %s since the request: it is stale.', q.offering_state, o.state);
  END IF;
  IF q.requested_by = v_handle THEN v := v || 'You requested it: a different officer decides (maker-checker).'::text; END IF;
  IF EXISTS (SELECT 1 FROM offering.request_votes WHERE request_id = q.id AND officer = v_handle) THEN
    v := v || 'You already voted on this request.'::text;
  ELSIF q.status = 'open' AND cardinality(v_missing) = 0 THEN
    v := v || 'No platform vote is missing: only the trustee''s vote remains.'::text;
  ELSIF q.status = 'open' AND NOT EXISTS (SELECT 1 FROM unnest(v_missing) d WHERE offering.has_duty(v_handle, d)) THEN
    v := v || format('Voting needs an active offering duty that is still missing here: %s.', array_to_string(ARRAY(SELECT DISTINCT unnest(v_missing)), ' or '));
  END IF;
  IF q.code = 'L3' AND v_handle = ANY (coalesce(property.parties(o.property_id), '{}')) THEN
    v := v || 'You took part in the property''s S-01 file: you cannot approve its offering (OF-SOD-1).'::text;
  END IF;
  IF q.code IN ('L13', 'V17') AND v_handle IN (SELECT b.prepared_by FROM offering.issuance_batches b WHERE b.offering_id = q.offering_id) THEN
    v := v || 'You prepared the issuance batch: you cannot approve its minting (OF-SOD-2).'::text;
  END IF;
  RETURN v;
END $$;

/** Why this officer cannot return the request's offering to draft (L2) now (empty = they can). */
CREATE FUNCTION admin.offering_return_blockers(p_officer uuid, q offering.requests) RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_handle text := admin.handle_of(p_officer);
  v text[] := '{}';
BEGIN
  IF NOT admin.officer_has(p_officer, 'offering.decide') THEN v := v || 'Only an operations checker or a compliance officer returns an offering.'::text; END IF;
  IF q.code <> 'L3' THEN v := v || 'Only the approval request (L3) of an offering pending approval leads back to draft.'::text; END IF;
  IF (SELECT state FROM offering.offerings WHERE id = q.offering_id) IS DISTINCT FROM 'pending_approval' THEN
    v := v || 'The offering is no longer pending approval.'::text;
  END IF;
  IF NOT (offering.has_duty(v_handle, 'offering') OR offering.has_duty(v_handle, 'legal_head') OR offering.has_duty(v_handle, 'compliance')) THEN
    v := v || 'Returning needs an active offering, legal head or compliance duty.'::text;
  END IF;
  IF v_handle = (SELECT e.actor FROM offering.offering_events e WHERE e.offering_id = q.offering_id AND e.code = 'L1' ORDER BY e.id DESC LIMIT 1) THEN
    v := v || 'You submitted it: the maker cannot return their own submission.'::text;
  END IF;
  RETURN v;
END $$;

CREATE FUNCTION admin.offering_terms_json(o offering.offerings) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
  SELECT jsonb_build_object('id', o.id, 'state', o.state, 'token', o.token, 'createdBy', o.created_by,
    'priceRupees', CASE WHEN o.price_paisa IS NOT NULL THEN (o.price_paisa / 100.0)::text END, 'pricePaisa', o.price_paisa::text,
    'minRaiseUnits', o.min_raise_units::text, 'targetUnits', o.target_units::text, 'hardCapUnits', o.hard_cap_units::text,
    'minUnits', o.min_units::text, 'maxUnits', o.max_units::text, 'opensAt', admin.utc(o.opens_at), 'closesAt', admin.utc(o.closes_at),
    'paymentGraceMinutes', o.payment_grace_minutes, 'reservationMinutes', o.reservation_minutes, 'completionDays', o.completion_days,
    'categories', to_jsonb(o.categories), 'useOfProceeds', o.use_of_proceeds,
    'docEnSha256', encode(o.doc_en_sha, 'hex'), 'docUrSha256', encode(o.doc_ur_sha, 'hex'), 'riskSha256', encode(o.risk_sha, 'hex'),
    'registerUnits', o.register_units::text, 'maxHoldingUnits', o.max_holding_units::text,
    'trusteeCap', (SELECT t.trustee_cap::text FROM chain.tokens t WHERE t.token = o.token),
    'supply', (SELECT t.total_supply::text FROM chain.tokens t WHERE t.token = o.token))
$$;

/** Open S-02 requests that still need a platform vote, and offerings pending approval whose L3 request lapsed. */
CREATE FUNCTION admin.offering_votes(p_session bytea) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'offering.read');
  v_handle text := admin.handle_of(v_me);
BEGIN
  RETURN jsonb_build_object(
    'at', admin.utc(clock_timestamp()),
    'open', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'id', q.id, 'code', q.code, 'offering', q.offering_id, 'offeringState', q.offering_state, 'requestedBy', q.requested_by,
        'requestedAt', admin.utc(q.requested_at), 'expiresAt', admin.utc(q.expires_at),
        'expired', (SELECT rr.expires FROM offering.request_rules rr WHERE rr.code = q.code) AND q.expires_at < now(),
        'note', (SELECT rr.note FROM offering.request_rules rr WHERE rr.code = q.code),
        'property', (SELECT admin.property_json(o.property_id) FROM offering.offerings o WHERE o.id = q.offering_id),
        'missing', to_jsonb(admin.offering_missing_duties(q)),
        'votes', (SELECT count(*) FROM offering.request_votes v WHERE v.request_id = q.id),
        'mine', EXISTS (SELECT 1 FROM offering.request_votes v WHERE v.request_id = q.id AND v.officer = v_handle)) ORDER BY q.id)
      FROM offering.requests q WHERE q.status = 'open' AND cardinality(admin.offering_missing_duties(q)) > 0), '[]'::jsonb),
    'lapsed', coalesce((SELECT jsonb_agg(jsonb_build_object('request', q.id, 'offering', o.id, 'status', q.status,
                                                            'property', admin.property_json(o.property_id)) ORDER BY q.id)
      FROM offering.offerings o
      JOIN LATERAL (SELECT x.* FROM offering.requests x WHERE x.offering_id = o.id AND x.code = 'L3' ORDER BY x.id DESC LIMIT 1) q ON true
      WHERE o.state = 'pending_approval' AND (q.status <> 'open' OR q.expires_at < now())), '[]'::jsonb),
    'recent', coalesce((SELECT jsonb_agg(jsonb_build_object('request', v.request_id, 'officer', v.officer, 'duty', v.duty, 'approve', v.approve,
                                                            'at', admin.utc(v.at)) ORDER BY v.at DESC)
                        FROM (SELECT * FROM offering.request_votes WHERE duty <> 'trustee' ORDER BY at DESC LIMIT 15) v), '[]'::jsonb));
END $$;

/** One S-02 request as a platform officer votes on it: terms, property, votes, missing duties, digest and blockers. */
CREATE FUNCTION admin.offering_vote_request(p_session bytea, p_id bigint) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'offering.read');
  q offering.requests;
  o offering.offerings;
  rr offering.request_rules;
  v_problem text;
BEGIN
  SELECT * INTO q FROM offering.requests WHERE id = p_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO o FROM offering.offerings WHERE id = q.offering_id;
  SELECT * INTO rr FROM offering.request_rules WHERE code = q.code;
  IF q.status = 'open' THEN v_problem := offering.request_problem(q.offering_id, q.code, q.subscription_id, q.detail); END IF;
  RETURN jsonb_build_object(
    'id', q.id, 'code', q.code, 'note', rr.note, 'needs', to_jsonb(rr.needs), 'status', q.status, 'offeringState', q.offering_state,
    'subscription', q.subscription_id, 'requestedBy', q.requested_by, 'reason', q.reason, 'detail', q.detail,
    'requestedAt', admin.utc(q.requested_at), 'expiresAt', admin.utc(q.expires_at), 'decidedAt', admin.utc(q.decided_at),
    'expired', rr.expires AND q.status = 'open' AND q.expires_at < now(),
    'offering', admin.offering_terms_json(o),
    'property', admin.property_json(o.property_id),
    'missing', to_jsonb(admin.offering_missing_duties(q)),
    'votes', coalesce((SELECT jsonb_agg(jsonb_build_object('officer', v.officer, 'duty', v.duty, 'approve', v.approve, 'reason', v.reason, 'at', admin.utc(v.at)) ORDER BY v.at)
                       FROM offering.request_votes v WHERE v.request_id = q.id), '[]'::jsonb),
    'problem', v_problem,
    'digest', encode(admin.offering_request_digest(q.id), 'hex'),
    'blockers', to_jsonb(admin.offering_vote_blockers(v_me, q)),
    'approveBlockers', to_jsonb(CASE WHEN v_problem IS NOT NULL THEN ARRAY['The request no longer holds: ' || v_problem] ELSE '{}'::text[] END),
    'returnBlockers', to_jsonb(admin.offering_return_blockers(v_me, q)));
END $$;

/** Platform officer: vote on an S-02 request (offering.decide under the officer's handle), bound to the digest. */
CREATE FUNCTION admin.vote_offering_request(p_session bytea, p_request bigint, p_decision text, p_reason text, p_digest bytea)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'offering.decide');
  v_handle text := admin.handle_of(v_me);
  q offering.requests;
  v_blockers text[];
  v_status text;
BEGIN
  PERFORM admin.require_step_up(p_session);
  PERFORM admin.check_decision(p_decision, p_reason);
  SELECT * INTO q FROM offering.requests WHERE id = p_request;
  IF NOT FOUND THEN RETURN admin.vote_refused(v_me, 'offering', p_request::text, p_decision, 'unknown request', 'P0002'); END IF;
  IF admin.offering_request_digest(q.id) IS DISTINCT FROM p_digest THEN
    RETURN admin.vote_refused(v_me, 'offering', q.id::text, p_decision, 'the request differs from what you reviewed: reload and check again', '23514');
  END IF;
  v_blockers := admin.offering_vote_blockers(v_me, q);
  IF cardinality(v_blockers) > 0 THEN RETURN admin.vote_refused(v_me, 'offering', q.id::text, p_decision, v_blockers[1], '42501'); END IF;
  BEGIN
    PERFORM admin.bind_officer(v_handle);
    v_status := offering.decide(q.id, v_handle, p_decision = 'approve', btrim(p_reason));
    PERFORM admin.unbind_officer(v_handle);
  EXCEPTION WHEN SQLSTATE '23514' OR SQLSTATE '23505' OR SQLSTATE '42501' OR SQLSTATE '22023' OR SQLSTATE 'P0002' THEN
    RETURN admin.vote_refused(v_me, 'offering', q.id::text, p_decision, SQLERRM, SQLSTATE);
  END;
  PERFORM admin.audit_append(v_me::text, 'approval.decided', jsonb_build_object('kind', 'offering', 'ref', q.id, 'code', q.code, 'offering', q.offering_id,
    'decision', p_decision, 'result', v_status, 'digest', encode(p_digest, 'hex')));
  RETURN jsonb_build_object('ok', true, 'status', v_status);
END $$;

/** Return the offering of an L3 request to draft (L2, offering.return_offering under the officer's handle). */
CREATE FUNCTION admin.return_offering(p_session bytea, p_request bigint, p_reason text, p_digest bytea)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'offering.decide');
  v_handle text := admin.handle_of(v_me);
  q offering.requests;
  v_blockers text[];
  v_status text;
BEGIN
  PERFORM admin.require_step_up(p_session);
  IF NOT admin.reason_ok(p_reason) THEN
    RETURN admin.vote_refused(v_me, 'offering.return', p_request::text, 'return', 'a reason of 10 to 500 characters is required', '22023');
  END IF;
  SELECT * INTO q FROM offering.requests WHERE id = p_request;
  IF NOT FOUND THEN RETURN admin.vote_refused(v_me, 'offering.return', p_request::text, 'return', 'unknown request', 'P0002'); END IF;
  IF admin.offering_request_digest(q.id) IS DISTINCT FROM p_digest THEN
    RETURN admin.vote_refused(v_me, 'offering.return', q.id::text, 'return', 'the request differs from what you reviewed: reload and check again', '23514');
  END IF;
  v_blockers := admin.offering_return_blockers(v_me, q);
  IF cardinality(v_blockers) > 0 THEN RETURN admin.vote_refused(v_me, 'offering.return', q.id::text, 'return', v_blockers[1], '42501'); END IF;
  BEGIN
    PERFORM admin.bind_officer(v_handle);
    v_status := offering.return_offering(q.offering_id, v_handle, btrim(p_reason));
    PERFORM admin.unbind_officer(v_handle);
  EXCEPTION WHEN SQLSTATE '23514' OR SQLSTATE '23505' OR SQLSTATE '42501' OR SQLSTATE '22023' OR SQLSTATE 'P0002' THEN
    RETURN admin.vote_refused(v_me, 'offering.return', q.id::text, 'return', SQLERRM, SQLSTATE);
  END;
  PERFORM admin.audit_append(v_me::text, 'approval.decided', jsonb_build_object('kind', 'offering.return', 'ref', q.id, 'offering', q.offering_id,
    'decision', 'return', 'result', v_status, 'digest', encode(p_digest, 'hex')));
  RETURN jsonb_build_object('ok', true, 'status', v_status);
END $$;

-- ================================================================== privileges
REVOKE ALL ON ALL TABLES IN SCHEMA admin FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA admin FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
  admin.committees(bytea),
  admin.committee(bytea, bigint),
  admin.open_committee(bytea, uuid, text),
  admin.committee_vote(bytea, bigint, text, text, bytea),
  admin.close_committee(bytea, bigint, text, text, bytea),
  admin.trustee_properties(bytea),
  admin.trustee_property(bytea, uuid),
  admin.decide_property_trustee(bytea, uuid, bigint, text, text, text, bytea),
  admin.offering_votes(bytea),
  admin.offering_vote_request(bytea, bigint),
  admin.vote_offering_request(bytea, bigint, text, text, bytea),
  admin.return_offering(bytea, bigint, text, bytea)
TO pt_admin_portal;

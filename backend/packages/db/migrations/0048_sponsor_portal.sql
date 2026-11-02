-- Property sponsor portal on the website (product map #9: submit a property, upload title
-- documents, track due diligence). Applies on top of 0047.
--
--   SP-1  A signed-in website user acts for a sponsor only as one of its current, KYC-verified
--         representatives or owners (property.sponsor_persons, by their KYC subject). Every action
--         goes through the S-01 functions with that person as acting_for, so the board-resolution
--         powers (submit, upload, respond, withdraw), KYC and every state rule still decide
--         (property.check_representative, OB-8). Actions are recorded under web:<investor id>.
--         S-01 let only onboarding staff act on the sponsor's behalf (need_duty 'onboarding'); here the
--         representative acts in person: inside a sponsorweb.* call (and only there: a transaction-
--         local marker set and cleared around the S-01 call) the actor web:<investor id> counts as
--         holding the onboarding duty for that call. Every later step (screening, review, committee,
--         trustee) stays with staff and officers.
--   SP-2  What a sponsor sees (sponsorweb.overview): the KYB state and the reason of the last query
--         or return addressed to them, their properties with state, missing identifiers (OB-10) and
--         the reason of the last query or return, and their documents (type, SHA-256, verified).
--         Never: screening or risk results, duplicate or fraud flags, reviewers, committee votes or
--         internal notes (no tipping-off).
--   SP-3  Uploads go to the document vault without a key on the website: sponsorweb.upload_ticket
--         checks the upload power and issues a one-time ticket for exactly that file (hash, size,
--         media type, document type, 10 minutes); the vault stores the file only against an unused
--         ticket (vault.redeem_upload_ticket); sponsorweb.add_document then records it through
--         property.add_document with store_ref vault://<sha256>.

CREATE SCHEMA sponsorweb;
REVOKE ALL ON SCHEMA sponsorweb FROM PUBLIC;

CREATE TABLE sponsorweb.upload_tickets (
  ticket_hash bytea PRIMARY KEY CHECK (length(ticket_hash) = 32),
  investor_id uuid NOT NULL REFERENCES webdemo.investors (id),
  sponsor_id  uuid NOT NULL REFERENCES property.sponsors (id),
  property_id uuid REFERENCES property.properties (id),
  person_id   bigint NOT NULL REFERENCES property.sponsor_persons (id),
  doc_type    text NOT NULL REFERENCES property.doc_types (code),
  sha256      bytea NOT NULL CHECK (length(sha256) = 32),
  size_bytes  bigint NOT NULL CHECK (size_bytes BETWEEN 1 AND 26214400),
  media_type  text NOT NULL CHECK (media_type IN ('application/pdf', 'image/jpeg', 'image/png', 'image/tiff')),
  expires_at  timestamptz NOT NULL,
  stored_at   timestamptz,
  recorded_at timestamptz,
  document_id uuid
);

/** The session's investor and KYC subject (SP-1). */
CREATE FUNCTION sponsorweb.me(p_session bytea, OUT investor_id uuid, OUT subject_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, sponsorweb AS $$
DECLARE
  s webauth.sessions := webauth.live_session(p_session);
BEGIN
  IF s.token_hash IS NULL THEN RETURN; END IF;
  PERFORM webauth.touch(s);
  investor_id := s.investor_id;
  subject_id := (SELECT kyc_subject FROM webdemo.investors WHERE id = s.investor_id);
END $$;

/** The current representative or owner row through which this subject acts for the sponsor (NULL = none). */
CREATE FUNCTION sponsorweb.person(p_subject uuid, p_sponsor uuid) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, sponsorweb AS $$
  SELECT id FROM property.sponsor_persons
  WHERE subject_id = p_subject AND sponsor_id = p_sponsor AND ended_at IS NULL AND role IN ('representative', 'owner')
  ORDER BY (role = 'representative') DESC, id LIMIT 1
$$;

/** The last reason addressed to the sponsor: a query or a return (SP-2). */
CREATE FUNCTION sponsorweb.last_sponsor_note(p_sponsor uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, sponsorweb AS $$
  SELECT jsonb_build_object('code', e.code, 'reason', e.reason, 'at', e.at) FROM property.sponsor_events e
  WHERE e.sponsor_id = p_sponsor AND e.code IN ('K3', 'K6') ORDER BY e.id DESC LIMIT 1
$$;

CREATE FUNCTION sponsorweb.last_property_note(p_property uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, sponsorweb AS $$
  SELECT jsonb_build_object('code', e.code, 'reason', e.reason, 'at', e.at) FROM property.property_events e
  WHERE e.property_id = p_property AND e.code IN ('P2', 'P5') ORDER BY e.id DESC LIMIT 1
$$;

/** SP-1: the representative acting in person inside a sponsorweb.* call counts as onboarding for that call. */
CREATE OR REPLACE FUNCTION property.need_duty(p_actor text, p_duties text[], p_what text) RETURNS void
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, property AS $$
BEGIN
  PERFORM property.check_actor(p_actor);
  IF p_duties = ARRAY['onboarding'] AND p_actor LIKE 'web:%' AND current_setting('sponsorweb.actor', true) = p_actor THEN
    RETURN;
  END IF;
  IF NOT property.has_duty(p_actor, p_duties) THEN
    PERFORM property.fail('42501', format('%s needs an active %s duty to %s', p_actor, array_to_string(p_duties, ' or '), p_what));
  END IF;
END $$;

-- ================================================================== SP-2 reads
CREATE FUNCTION sponsorweb.overview(p_session bytea) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, sponsorweb AS $$
DECLARE
  me record;
BEGIN
  SELECT * INTO me FROM sponsorweb.me(p_session);
  IF me.subject_id IS NULL THEN RETURN NULL; END IF;
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object(
      'id', s.id, 'kind', s.kind, 'cuinLast', s.cuin_last4, 'state', property.sponsor_state(s.id), 'role', p.role, 'powers', to_jsonb(p.powers),
      'note', sponsorweb.last_sponsor_note(s.id),
      'documents', coalesce((SELECT jsonb_agg(jsonb_build_object('type', d.doc_type, 'sha256', encode(d.sha256, 'hex'), 'at', d.uploaded_at,
                        'verified', EXISTS (SELECT 1 FROM property.document_verifications v WHERE v.document_id = d.id AND v.outcome = 'verified'))
                        ORDER BY d.uploaded_at DESC)
                      FROM property.documents d WHERE d.sponsor_id = s.id AND d.property_id IS NULL AND property.is_current(d.id)), '[]'::jsonb),
      'properties', coalesce((SELECT jsonb_agg(jsonb_build_object('id', x.id, 'state', x.state, 'building', x.building, 'district', x.district,
                        'province', x.province, 'missing', CASE WHEN x.state = 'draft' THEN property.identifier_problem(x.id) END,
                        'note', sponsorweb.last_property_note(x.id),
                        'documents', coalesce((SELECT jsonb_agg(jsonb_build_object('type', d.doc_type, 'sha256', encode(d.sha256, 'hex'), 'at', d.uploaded_at,
                              'verified', EXISTS (SELECT 1 FROM property.document_verifications v WHERE v.document_id = d.id AND v.outcome = 'verified'))
                              ORDER BY d.uploaded_at DESC)
                            FROM property.documents d WHERE d.property_id = x.id AND property.is_current(d.id)), '[]'::jsonb))
                        ORDER BY x.created_at DESC)
                      FROM property.properties x WHERE x.sponsor_id = s.id AND x.state <> 'withdrawn'), '[]'::jsonb))
      ORDER BY s.created_at)
    FROM property.sponsors s JOIN property.sponsor_persons p ON p.id = sponsorweb.person(me.subject_id, s.id)), '[]'::jsonb);
END $$;

-- ================================================================== SP-1 actions
/** One S-01 action for the sponsor, as the session's representative (SP-1). Errors keep their SQLSTATE. */
CREATE FUNCTION sponsorweb.act(p_session bytea, p_sponsor uuid, p_property uuid, p_action text, p_ids jsonb, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, sponsorweb AS $$
DECLARE
  me record;
  v_person bigint;
  v_sponsor uuid := p_sponsor;
  v_actor text;
  v_id uuid;
  v_out jsonb;
BEGIN
  SELECT * INTO me FROM sponsorweb.me(p_session);
  IF me.subject_id IS NULL THEN RETURN jsonb_build_object('error', 'session'); END IF;
  IF p_property IS NOT NULL THEN
    SELECT sponsor_id INTO v_sponsor FROM property.properties WHERE id = p_property;
    IF v_sponsor IS NULL OR (p_sponsor IS NOT NULL AND v_sponsor <> p_sponsor) THEN RAISE EXCEPTION 'unknown property' USING ERRCODE = 'P0002'; END IF;
  END IF;
  v_person := sponsorweb.person(me.subject_id, v_sponsor);
  IF v_person IS NULL THEN RAISE EXCEPTION 'you do not act for this sponsor' USING ERRCODE = '42501'; END IF;
  v_actor := 'web:' || me.investor_id::text;
  PERFORM set_config('sponsorweb.actor', v_actor, true);
  CASE p_action
    WHEN 'submit_kyb' THEN v_out := jsonb_build_object('state', property.submit_kyb(v_sponsor, v_actor, v_person));
    WHEN 'create_property' THEN
      v_id := property.create_property(v_sponsor, v_actor, v_person, NULL, coalesce(p_ids, '{}'::jsonb));
      v_out := jsonb_build_object('property', v_id);
    WHEN 'update_property' THEN v_out := jsonb_build_object('fields', to_jsonb(property.update_property(p_property, v_actor, v_person, coalesce(p_ids, '{}'::jsonb))));
    WHEN 'submit_property' THEN v_out := property.submit_property(p_property, v_actor, v_person);
    WHEN 'withdraw_property' THEN v_out := jsonb_build_object('state', property.withdraw_property(p_property, v_actor, v_person, p_reason));
    ELSE RAISE EXCEPTION 'unknown action' USING ERRCODE = '22023';
  END CASE;
  PERFORM set_config('sponsorweb.actor', '', true);
  RETURN jsonb_build_object('ok', true) || coalesce(v_out, '{}'::jsonb);
END $$;

-- ================================================================== SP-3 uploads
CREATE FUNCTION sponsorweb.upload_ticket(p_session bytea, p_sponsor uuid, p_property uuid, p_type text, p_sha bytea, p_size bigint, p_media text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, sponsorweb AS $$
DECLARE
  me record;
  v_person bigint;
  v_sponsor uuid := p_sponsor;
  v_ticket text := replace(replace(rtrim(encode(decode(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'hex'), 'base64'), '='), '+', '-'), '/', '_');
BEGIN
  SELECT * INTO me FROM sponsorweb.me(p_session);
  IF me.subject_id IS NULL THEN RAISE EXCEPTION 'no session' USING ERRCODE = '42501'; END IF;
  IF p_property IS NOT NULL THEN
    SELECT sponsor_id INTO v_sponsor FROM property.properties WHERE id = p_property;
    IF v_sponsor IS NULL OR v_sponsor <> p_sponsor THEN RAISE EXCEPTION 'unknown property' USING ERRCODE = 'P0002'; END IF;
  END IF;
  v_person := sponsorweb.person(me.subject_id, v_sponsor);
  IF v_person IS NULL THEN RAISE EXCEPTION 'you do not act for this sponsor' USING ERRCODE = '42501'; END IF;
  PERFORM property.check_representative(v_sponsor, v_person, 'upload');
  IF NOT EXISTS (SELECT 1 FROM property.doc_types WHERE code = p_type AND owner_kind = CASE WHEN p_property IS NULL THEN 'sponsor' ELSE 'property' END) THEN
    RAISE EXCEPTION 'this document type does not belong here' USING ERRCODE = '22023';
  END IF;
  IF (SELECT count(*) FROM sponsorweb.upload_tickets WHERE investor_id = me.investor_id AND expires_at > clock_timestamp() - interval '1 hour') >= 30 THEN
    RAISE EXCEPTION 'too many uploads; try again later' USING ERRCODE = '23514';
  END IF;
  INSERT INTO sponsorweb.upload_tickets (ticket_hash, investor_id, sponsor_id, property_id, person_id, doc_type, sha256, size_bytes, media_type, expires_at)
  VALUES (sha256(convert_to(v_ticket, 'UTF8')), me.investor_id, v_sponsor, p_property, v_person, p_type, p_sha, p_size, p_media, clock_timestamp() + interval '10 minutes');
  RETURN v_ticket;
END $$;

/** The vault service: may this exact file be stored against this ticket? (once) */
CREATE FUNCTION vault.redeem_upload_ticket(p_ticket text, p_sha bytea, p_size bigint, p_media text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, vault AS $$
BEGIN
  UPDATE sponsorweb.upload_tickets SET stored_at = clock_timestamp()
  WHERE ticket_hash = sha256(convert_to(coalesce(p_ticket, ''), 'UTF8')) AND stored_at IS NULL AND expires_at > clock_timestamp()
    AND sha256 = p_sha AND size_bytes = p_size AND media_type = p_media;
  RETURN FOUND;
END $$;

CREATE FUNCTION sponsorweb.add_document(p_session bytea, p_ticket text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, sponsorweb AS $$
DECLARE
  me record;
  t sponsorweb.upload_tickets;
  v_id uuid;
BEGIN
  SELECT * INTO me FROM sponsorweb.me(p_session);
  IF me.subject_id IS NULL THEN RETURN jsonb_build_object('error', 'session'); END IF;
  SELECT * INTO t FROM sponsorweb.upload_tickets WHERE ticket_hash = sha256(convert_to(coalesce(p_ticket, ''), 'UTF8')) FOR UPDATE;
  IF NOT FOUND OR t.investor_id <> me.investor_id OR t.stored_at IS NULL OR t.recorded_at IS NOT NULL THEN
    RAISE EXCEPTION 'no stored upload for this ticket' USING ERRCODE = 'P0002';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM vault.objects WHERE sha256 = t.sha256) THEN RAISE EXCEPTION 'the vault does not hold this file' USING ERRCODE = 'P0002'; END IF;
  PERFORM set_config('sponsorweb.actor', 'web:' || me.investor_id::text, true);
  v_id := property.add_document(t.sponsor_id, t.property_id, t.doc_type, t.sha256, t.size_bytes, t.media_type, 'vault://' || encode(t.sha256, 'hex'),
                                'web:' || me.investor_id::text, t.person_id, NULL);
  PERFORM set_config('sponsorweb.actor', '', true);
  UPDATE sponsorweb.upload_tickets SET recorded_at = clock_timestamp(), document_id = v_id WHERE ticket_hash = t.ticket_hash;
  RETURN jsonb_build_object('ok', true, 'document', v_id);
END $$;

-- ================================================================== privileges
REVOKE ALL ON ALL TABLES IN SCHEMA sponsorweb FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA sponsorweb FROM PUBLIC;
REVOKE ALL ON FUNCTION vault.redeem_upload_ticket(text, bytea, bigint, text) FROM PUBLIC;
GRANT USAGE ON SCHEMA sponsorweb TO pt_web;
GRANT EXECUTE ON FUNCTION sponsorweb.overview(bytea), sponsorweb.act(bytea, uuid, uuid, text, jsonb, text),
  sponsorweb.upload_ticket(bytea, uuid, uuid, text, bytea, bigint, text), sponsorweb.add_document(bytea, text) TO pt_web;
GRANT EXECUTE ON FUNCTION vault.redeem_upload_ticket(text, bytea, bigint, text) TO pt_svc_vault;

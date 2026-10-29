-- Investors download their annual withholding tax certificates on the website (S-03 OP-51 follow-up).
-- Applies on top of 0034.
--
--   TC-1  tax.web_certificates(session): the signed-in investor's certificates (current and
--         superseded), newest first: id, fiscal year, issue time, SHA-256 of the content, and which
--         one supersedes it. Nothing for a session without a live investor or without a KYC subject.
--   TC-2  tax.web_certificate(session, id): one certificate's content, the exact text that was hashed
--         when it was issued, and its SHA-256, only if it belongs to the session's investor; NULL
--         otherwise (another investor's id reads as not found). Every download is recorded in the ops audit chain
--         (certificate.downloaded: certificate id, never content).
--   TC-3  pt_web may EXECUTE these two only; it still has no access to tax.certificates itself.

CREATE FUNCTION tax.web_subject(p_session bytea) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, tax AS $$
DECLARE
  s webauth.sessions := webauth.live_session(p_session);
BEGIN
  IF s.token_hash IS NULL THEN RETURN NULL; END IF;
  PERFORM webauth.touch(s);
  RETURN (SELECT kyc_subject FROM webdemo.investors WHERE id = s.investor_id);
END $$;

CREATE FUNCTION tax.web_certificates(p_session bytea)
RETURNS TABLE (id bigint, fiscal_year integer, issued_at timestamptz, sha256 text, superseded_by bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, tax AS $$
#variable_conflict use_column
DECLARE
  v_subject uuid := tax.web_subject(p_session);
BEGIN
  IF v_subject IS NULL THEN RETURN; END IF;
  RETURN QUERY
    SELECT c.id, c.fiscal_year, c.issued_at, encode(c.content_sha256, 'hex'), (SELECT n.id FROM tax.certificates n WHERE n.supersedes = c.id)
    FROM tax.certificates c WHERE c.subject_id = v_subject
    ORDER BY c.fiscal_year DESC, c.id DESC LIMIT 100;
END $$;

CREATE FUNCTION tax.web_certificate(p_session bytea, p_id bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, tax AS $$
DECLARE
  v_subject uuid := tax.web_subject(p_session);
  c tax.certificates;
BEGIN
  IF v_subject IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO c FROM tax.certificates WHERE id = p_id AND subject_id = v_subject;
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM ops.audit_append('web:' || v_subject::text, 'certificate.downloaded', jsonb_build_object('certificate', c.id, 'fiscalYear', c.fiscal_year));
  RETURN jsonb_build_object('id', c.id, 'fiscalYear', c.fiscal_year, 'issuedAt', c.issued_at, 'sha256', encode(c.content_sha256, 'hex'),
    'superseded', EXISTS (SELECT 1 FROM tax.certificates n WHERE n.supersedes = c.id), 'content', c.content,
    -- The exact text that was hashed (content_sha256 = sha256 of content::text), so a downloaded file verifies byte for byte.
    'contentText', c.content::text);
END $$;

REVOKE ALL ON FUNCTION tax.web_subject(bytea), tax.web_certificates(bytea), tax.web_certificate(bytea, bigint) FROM PUBLIC;
GRANT USAGE ON SCHEMA tax TO pt_web;
GRANT EXECUTE ON FUNCTION tax.web_certificates(bytea), tax.web_certificate(bytea, bigint) TO pt_web;

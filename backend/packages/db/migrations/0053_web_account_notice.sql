-- What the website may say about an investor's own review state (tipping-off, AML Act 2010 s.34;
-- roadmap 2026-11-03 "investor wording for suspended / PEP"). Applies on top of 0052.
--
--   AN-1  webnotice.account_notice(session): for the signed-in investor only, one neutral word:
--         'review'  the KYC status is suspended (a compliance hold) or review (a possible screening
--                   match, a PEP waiting for enhanced due diligence): the website shows the same
--                   neutral "being reviewed" text for both and never a reason, a case, a list or a
--                   freeze;
--         'expired' the verification has lapsed: the investor is asked to verify again;
--         NULL      nothing to say (verified, pending, rejected keep their existing texts).
--   AN-2  A schema of its own for the website (gotcha of 2026-10-30): pt_web gets USAGE on webnotice
--         and EXECUTE on this one function, never on kyc or compliance.

CREATE SCHEMA IF NOT EXISTS webnotice;
REVOKE ALL ON SCHEMA webnotice FROM PUBLIC;

CREATE FUNCTION webnotice.account_notice(p_session bytea) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, webnotice AS $$
DECLARE
  s webauth.sessions := webauth.live_session(p_session);
  v_subject uuid;
  v_status text;
BEGIN
  IF s.token_hash IS NULL THEN RETURN NULL; END IF;
  SELECT kyc_subject INTO v_subject FROM webdemo.investors WHERE id = s.investor_id;
  IF v_subject IS NULL THEN RETURN NULL; END IF;
  v_status := kyc.subject_status(v_subject);
  RETURN CASE WHEN v_status IN ('suspended', 'review') THEN 'review' WHEN v_status = 'expired' THEN 'expired' END;
END $$;

REVOKE ALL ON FUNCTION webnotice.account_notice(bytea) FROM PUBLIC;
GRANT USAGE ON SCHEMA webnotice TO pt_web;
GRANT EXECUTE ON FUNCTION webnotice.account_notice(bytea) TO pt_web;

-- The website's offering follow-ups (S-02 OF-22/OF-23): withdrawing a paid subscription within the
-- withdrawal window, and the supplementary disclosures that open it. Applies on top of 0035.
--
--   WW-1  webauth.web_withdraw(session, subscription): the investor withdraws a paid, not yet
--         allocated subscription while the offering's withdrawal window is open; the session gives
--         the investor and their KYC subject (never a parameter), the step-up rule
--         'offering.withdraw' applies (passkey when one is enrolled), and offering.withdraw decides
--         (V13 -> refund_pending, a refund is opened). Recorded under web:<investor id>.
--   WW-2  offering.web_disclosures(offering): the disclosures that opened a withdrawal window for an
--         offering the website may show (approved SD supplementary disclosures and L10 extensions,
--         each with its disclosure, OF-21/OF-23): kind, SHA-256 and publication time only.
--   WW-3  pt_web may EXECUTE these two (and not offering.withdraw itself).

INSERT INTO webauth.step_up_actions (action, min_amount_paisa, note) VALUES
  ('offering.withdraw', 0, 'Withdrawing a paid subscription within the withdrawal window (OF-22/OF-23)');

CREATE FUNCTION offering.web_withdraw(p_sub uuid, p_subject uuid, p_actor text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, offering AS $$
BEGIN
  PERFORM offering.web_check_actor(p_actor);
  RETURN offering.withdraw(p_sub, p_subject, p_actor);
END $$;

CREATE FUNCTION webauth.web_withdraw(p_session bytea, p_sub uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, webauth AS $$
DECLARE
  v_subject uuid;
  g record;
BEGIN
  SELECT * INTO g FROM webauth.gate(p_session, 'offering.withdraw', 0);
  IF g.decision NOT IN ('ok', 'waived') THEN RETURN jsonb_build_object('error', g.decision); END IF;
  SELECT i.kyc_subject INTO v_subject FROM webdemo.investors i WHERE i.id = g.investor_id;
  IF v_subject IS NULL THEN RAISE EXCEPTION 'subscription not found' USING ERRCODE = 'P0002'; END IF;
  RETURN offering.web_withdraw(p_sub, v_subject, webauth.actor(g.investor_id));
END $$;

CREATE FUNCTION offering.web_disclosures(p_offering uuid) RETURNS TABLE (kind text, sha256 text, published_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, offering AS $$
  SELECT CASE q.code WHEN 'SD' THEN 'supplementary' ELSE 'extension' END, q.detail->>'disclosureSha', q.decided_at
  FROM offering.requests q JOIN offering.offerings o ON o.id = q.offering_id
  WHERE q.offering_id = p_offering AND q.code IN ('SD', 'L10') AND q.status = 'approved' AND q.detail ? 'disclosureSha'
    AND o.state IN ('ready', 'live', 'suspended', 'closing', 'funded', 'completing', 'completed', 'failed', 'refunding', 'cancelled')
  ORDER BY q.decided_at
  LIMIT 50
$$;

REVOKE ALL ON FUNCTION offering.web_withdraw(uuid, uuid, text), webauth.web_withdraw(bytea, uuid), offering.web_disclosures(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION webauth.web_withdraw(bytea, uuid), offering.web_disclosures(uuid) TO pt_web;

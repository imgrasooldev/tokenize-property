-- Public API phase 2b: cancel and withdraw from the app, confirmed on the website (ADR 0018
-- amendment 2, docs/api/openapi.json /me/subscriptions/{id}/change-requests). Applies on top of 0060.
--
--   PC-1  papi.requests gains the kinds 'cancel' and 'withdraw' with the subscription they act on
--         (target_subscription). The app asks with an Idempotency-Key (same rules as PR-3); only the
--         investor's own subscription, and only in a state where the website could do it: cancel a
--         reservation not yet paid (kyc_pending, payment_pending, waitlisted; S-02 V11), withdraw a
--         paid, not yet allocated subscription while the withdrawal window is open (OF-22/OF-23).
--   PC-2  The website confirms with its own cancel / withdraw (webauth.web_cancel / web_withdraw,
--         passkey step-up, the offering functions decide again), then papi.web_request_finish marks
--         the request confirmed only when the subscription really is cancelled, or has a withdrawal
--         refund. papi.web_request_decline (0060) declines any kind.
--   PC-3  A confirmed change request names its subscription in subscription_id (the target).

DO $$
DECLARE
  c text;
BEGIN
  SELECT conname INTO c FROM pg_constraint
  WHERE conrelid = 'papi.requests'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%kind = ''reserve''%';
  IF c IS NULL THEN RAISE EXCEPTION 'the 0060 kind check of papi.requests was not found'; END IF;
  EXECUTE format('ALTER TABLE papi.requests DROP CONSTRAINT %I', c);
END $$;

ALTER TABLE papi.requests ADD COLUMN target_subscription uuid REFERENCES offering.subscriptions (id);
ALTER TABLE papi.requests ADD CONSTRAINT requests_kind_check CHECK (kind IN ('reserve', 'cancel', 'withdraw'));
ALTER TABLE papi.requests ADD CONSTRAINT requests_target_check CHECK ((kind = 'reserve') = (target_subscription IS NULL));
ALTER TABLE papi.requests ADD CONSTRAINT requests_bound_target CHECK (kind = 'reserve' OR subscription_id IS NULL OR subscription_id = target_subscription);

/** The public view of a request: for cancel / withdraw, subscription_id is always the subscription it acts on. */
CREATE OR REPLACE FUNCTION papi.request_json(r papi.requests) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, papi AS $$
  SELECT jsonb_build_object(
    'id', r.id, 'kind', r.kind, 'offering_id', r.offering_id, 'units', r.units::text,
    'amount_paisa', (SELECT (o.price_paisa * r.units)::text FROM offering.offerings o WHERE o.id = r.offering_id),
    'status', CASE WHEN r.status = 'pending' AND r.expires_at <= clock_timestamp() THEN 'expired' ELSE r.status END,
    'code', r.code, 'created_at', r.created_at, 'expires_at', r.expires_at, 'subscription_id', coalesce(r.subscription_id, r.target_subscription))
$$;

/** PC-1: a cancel or withdraw request (or the existing one for the same Idempotency-Key). Errors come back as {error}. */
CREATE FUNCTION papi.request_change(p_access_hash bytea, p_subscription uuid, p_kind text, p_key text, p_code text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, papi AS $$
DECLARE
  v_investor uuid := papi.token_investor(p_access_hash);
  s record;
  r papi.requests;
  v_now timestamptz := date_trunc('microseconds', clock_timestamp());
BEGIN
  IF v_investor IS NULL THEN RETURN jsonb_build_object('error', 'token'); END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('cancel', 'withdraw') THEN RETURN jsonb_build_object('error', 'input'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_investor::text || '/' || coalesce(p_key, ''), 60));
  SELECT * INTO r FROM papi.requests WHERE investor_id = v_investor AND idempotency_key = p_key;
  IF FOUND THEN
    IF r.kind IS DISTINCT FROM p_kind OR r.target_subscription IS DISTINCT FROM p_subscription THEN RETURN jsonb_build_object('error', 'conflict'); END IF;
    RETURN papi.request_json(r) || jsonb_build_object('replayed', true);
  END IF;
  SELECT x.* INTO s FROM offering.web_subscriptions(papi.subject(p_access_hash)) x WHERE x.subscription_id = p_subscription;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'unknown'); END IF;
  IF p_kind = 'cancel' AND s.state NOT IN ('kyc_pending', 'payment_pending', 'waitlisted') THEN RETURN jsonb_build_object('error', 'state'); END IF;
  IF p_kind = 'withdraw' AND (s.state <> 'payment_confirmed' OR s.withdrawal_until IS NULL OR s.withdrawal_until <= v_now
                              OR s.offering_state NOT IN ('live', 'closing')) THEN
    RETURN jsonb_build_object('error', 'state');
  END IF;
  IF (SELECT count(*) FROM papi.requests WHERE investor_id = v_investor AND status = 'pending' AND expires_at > v_now) >= 5 THEN
    RETURN jsonb_build_object('error', 'limit');
  END IF;
  INSERT INTO papi.requests (investor_id, kind, offering_id, units, idempotency_key, code, created_at, expires_at, target_subscription)
  VALUES (v_investor, p_kind, s.offering_id, s.units, p_key, p_code, v_now, v_now + interval '15 minutes', p_subscription)
  RETURNING * INTO r;
  PERFORM papi.audit(v_investor, 'app.request', jsonb_build_object('request', r.id, 'kind', r.kind, 'subscription', p_subscription));
  RETURN papi.request_json(r) || jsonb_build_object('replayed', false);
EXCEPTION WHEN unique_violation THEN
  RETURN jsonb_build_object('error', 'code');
END $$;

/** PC-2: after the website's own cancel / withdraw, binds the request only if the subscription really changed. */
CREATE FUNCTION papi.web_request_finish(p_session bytea, p_code text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, papi AS $$
DECLARE
  w webauth.sessions := webauth.live_session(p_session);
  r papi.requests;
  s record;
BEGIN
  IF w.token_hash IS NULL THEN RETURN jsonb_build_object('error', 'session'); END IF;
  SELECT * INTO r FROM papi.requests
  WHERE code = upper(replace(coalesce(p_code, ''), '-', '')) AND investor_id = w.investor_id AND status = 'pending' AND kind IN ('cancel', 'withdraw')
  FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'code'); END IF;
  SELECT x.* INTO s FROM webdemo.investors i CROSS JOIN LATERAL offering.web_subscriptions(i.kyc_subject) x
  WHERE i.id = w.investor_id AND x.subscription_id = r.target_subscription;
  IF NOT FOUND OR NOT ((r.kind = 'cancel' AND s.state = 'cancelled')
                       OR (r.kind = 'withdraw' AND s.state IN ('refund_pending', 'refunded') AND s.refund_cause = 'withdrawal')) THEN
    RETURN jsonb_build_object('error', 'mismatch');
  END IF;
  UPDATE papi.requests SET status = 'confirmed', subscription_id = r.target_subscription, decided_at = clock_timestamp() WHERE id = r.id;
  PERFORM papi.audit(w.investor_id, 'app.request.confirmed', jsonb_build_object('request', r.id, 'kind', r.kind, 'subscription', r.target_subscription));
  RETURN jsonb_build_object('ok', true);
END $$;

REVOKE ALL ON FUNCTION papi.request_change(bytea, uuid, text, text, text), papi.web_request_finish(bytea, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION papi.request_change(bytea, uuid, text, text, text) TO pt_svc_public_api;
GRANT EXECUTE ON FUNCTION papi.web_request_finish(bytea, text) TO pt_web;

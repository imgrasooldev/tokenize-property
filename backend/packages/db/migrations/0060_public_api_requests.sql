-- Public API phase 2a: investing from the app, confirmed on the website (ADR 0018 amendment 1,
-- docs/api/openapi.json). Applies on top of 0059.
--
--   PR-1  The app asks for a reservation (offering, units) with an Idempotency-Key: a pending
--         request with an 8-letter confirmation code, valid 15 minutes. A request moves no money and
--         reserves nothing: it waits for the investor.
--   PR-2  The investor confirms on the website, signed in, through the website's own reservation
--         path (documents accepted there, webauth.web_reserve with its passkey step-up
--         'offering.reserve', KYC gate, limits); the website then binds the new subscription to
--         the request (papi.web_request_done) or the investor declines it. The app never confirms
--         its own request; passkeys move into the app once the platform has a domain and TLS.
--   PR-3  Idempotency (IETF draft "The Idempotency-Key HTTP Header Field"): the same key with the
--         same body returns the same request; the same key with another body is a conflict. Keys
--         are scoped to the investor. At most 5 pending requests per investor.
--   PR-4  The app reads one of its subscriptions with the payment instructions (payment code, the
--         trustee collection account, the deadline) exactly as the website shows them.

CREATE TABLE papi.requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  investor_id     uuid NOT NULL REFERENCES webdemo.investors (id),
  kind            text NOT NULL CHECK (kind = 'reserve'),
  offering_id     uuid NOT NULL REFERENCES offering.offerings (id),
  units           bigint NOT NULL CHECK (units BETWEEN 1 AND 9999999999999),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{8,64}$'),
  code            text NOT NULL CHECK (code ~ '^[BCDFGHJKLMNPQRSTVWXZ]{8}$'),
  created_at      timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  expires_at      timestamptz NOT NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'declined')),
  subscription_id uuid REFERENCES offering.subscriptions (id),
  decided_at      timestamptz,
  UNIQUE (investor_id, idempotency_key),
  CHECK (expires_at = created_at + interval '15 minutes'),
  CHECK ((status = 'pending') = (decided_at IS NULL)),
  CHECK ((status = 'confirmed') = (subscription_id IS NOT NULL))
);
CREATE UNIQUE INDEX requests_open_code ON papi.requests (code) WHERE status = 'pending';
CREATE INDEX requests_investor_idx ON papi.requests (investor_id, created_at DESC);
CREATE TRIGGER requests_no_delete BEFORE DELETE ON papi.requests FOR EACH ROW EXECUTE FUNCTION papi.forbid_delete();
CREATE TRIGGER requests_no_truncate BEFORE TRUNCATE ON papi.requests FOR EACH STATEMENT EXECUTE FUNCTION compliance.forbid_change();

CREATE FUNCTION papi.guard_request() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'pending' OR (to_jsonb(NEW) - 'status' - 'subscription_id' - 'decided_at') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'subscription_id' - 'decided_at') THEN
    RAISE EXCEPTION 'an app request is decided once and never changed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER requests_guard BEFORE UPDATE ON papi.requests FOR EACH ROW EXECUTE FUNCTION papi.guard_request();

/** The public view of a request (the app's resource). */
CREATE FUNCTION papi.request_json(r papi.requests) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, papi AS $$
  SELECT jsonb_build_object(
    'id', r.id, 'kind', r.kind, 'offering_id', r.offering_id, 'units', r.units::text,
    'amount_paisa', (SELECT (o.price_paisa * r.units)::text FROM offering.offerings o WHERE o.id = r.offering_id),
    'status', CASE WHEN r.status = 'pending' AND r.expires_at <= clock_timestamp() THEN 'expired' ELSE r.status END,
    'code', r.code, 'created_at', r.created_at, 'expires_at', r.expires_at, 'subscription_id', r.subscription_id)
$$;

-- ================================================================== PR-1 / PR-3 the app asks
/**
 * A new reservation request, or the existing one for the same Idempotency-Key. Errors come back as
 * {error}: token, offering (unknown or not open), conflict (same key, other body), limit (5 pending).
 */
CREATE FUNCTION papi.request_reserve(p_access_hash bytea, p_offering uuid, p_units bigint, p_key text, p_code text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, papi AS $$
DECLARE
  v_investor uuid := papi.token_investor(p_access_hash);
  r papi.requests;
  v_now timestamptz := date_trunc('microseconds', clock_timestamp());
BEGIN
  IF v_investor IS NULL THEN RETURN jsonb_build_object('error', 'token'); END IF;
  -- One request per key at a time, also when two calls with the same key race.
  PERFORM pg_advisory_xact_lock(hashtextextended(v_investor::text || '/' || coalesce(p_key, ''), 60));
  SELECT * INTO r FROM papi.requests WHERE investor_id = v_investor AND idempotency_key = p_key;
  IF FOUND THEN
    IF r.offering_id IS DISTINCT FROM p_offering OR r.units IS DISTINCT FROM p_units THEN RETURN jsonb_build_object('error', 'conflict'); END IF;
    RETURN papi.request_json(r) || jsonb_build_object('replayed', true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM papi.offerings(p_offering) o WHERE o.state = 'live') THEN RETURN jsonb_build_object('error', 'offering'); END IF;
  IF (SELECT count(*) FROM papi.requests WHERE investor_id = v_investor AND status = 'pending' AND expires_at > v_now) >= 5 THEN
    RETURN jsonb_build_object('error', 'limit');
  END IF;
  INSERT INTO papi.requests (investor_id, kind, offering_id, units, idempotency_key, code, created_at, expires_at)
  VALUES (v_investor, 'reserve', p_offering, p_units, p_key, p_code, v_now, v_now + interval '15 minutes')
  RETURNING * INTO r;
  PERFORM papi.audit(v_investor, 'app.request', jsonb_build_object('request', r.id, 'kind', r.kind, 'offering', p_offering, 'units', p_units));
  RETURN papi.request_json(r) || jsonb_build_object('replayed', false);
EXCEPTION WHEN unique_violation THEN
  RETURN jsonb_build_object('error', 'code');
END $$;

/** The token owner's request (NULL for another investor's or an unknown id). */
CREATE FUNCTION papi.request(p_access_hash bytea, p_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, papi AS $$
  SELECT papi.request_json(r) FROM papi.requests r WHERE r.id = p_id AND r.investor_id = papi.token_investor(p_access_hash)
$$;

-- ================================================================== PR-4 one subscription with payment instructions
CREATE FUNCTION papi.subscription(p_access_hash bytea, p_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, papi AS $$
  SELECT jsonb_build_object(
    'id', s.subscription_id, 'offering_id', s.offering_id, 'units', s.units::text, 'amount_paisa', s.amount_paisa::text, 'status', s.state,
    'created_at', s.created_at, 'expires_at', s.expires_at, 'paid_at', s.paid_at, 'withdrawal_until', s.withdrawal_until,
    'payment', CASE WHEN s.payment_code IS NOT NULL THEN jsonb_build_object('code', s.payment_code, 'pay_to_account', s.pay_to_account, 'expires_at', s.expires_at) END)
  FROM offering.web_subscriptions(papi.subject(p_access_hash)) s
  WHERE s.subscription_id = p_id
$$;

-- ================================================================== PR-2 the website confirms or declines
/** The signed-in investor's own pending request behind a code (for /confirm). */
CREATE FUNCTION papi.web_request_lookup(p_session bytea, p_code text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, papi AS $$
DECLARE
  s webauth.sessions := webauth.live_session(p_session);
  r papi.requests;
BEGIN
  IF s.token_hash IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO r FROM papi.requests
  WHERE code = upper(replace(coalesce(p_code, ''), '-', '')) AND investor_id = s.investor_id AND status = 'pending' AND expires_at > clock_timestamp();
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN papi.request_json(r);
END $$;

/**
 * Binds the subscription the website just reserved to the request: same investor, same offering,
 * same units, made after the request. Anything else is refused and the request stays pending.
 */
CREATE FUNCTION papi.web_request_done(p_session bytea, p_code text, p_subscription uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, papi AS $$
DECLARE
  s webauth.sessions := webauth.live_session(p_session);
  r papi.requests;
BEGIN
  IF s.token_hash IS NULL THEN RETURN jsonb_build_object('error', 'session'); END IF;
  SELECT * INTO r FROM papi.requests
  WHERE code = upper(replace(coalesce(p_code, ''), '-', '')) AND investor_id = s.investor_id AND status = 'pending' AND expires_at > clock_timestamp()
  FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'code'); END IF;
  IF NOT EXISTS (SELECT 1 FROM offering.subscriptions x JOIN webdemo.investors i ON i.kyc_subject = x.subject_id
                 WHERE x.id = p_subscription AND i.id = s.investor_id AND x.offering_id = r.offering_id AND x.units = r.units AND x.created_at >= r.created_at) THEN
    RETURN jsonb_build_object('error', 'mismatch');
  END IF;
  UPDATE papi.requests SET status = 'confirmed', subscription_id = p_subscription, decided_at = clock_timestamp() WHERE id = r.id;
  PERFORM papi.audit(s.investor_id, 'app.request.confirmed', jsonb_build_object('request', r.id, 'subscription', p_subscription));
  RETURN jsonb_build_object('ok', true);
END $$;

CREATE FUNCTION papi.web_request_decline(p_session bytea, p_code text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, papi AS $$
DECLARE
  s webauth.sessions := webauth.live_session(p_session);
  r papi.requests;
BEGIN
  IF s.token_hash IS NULL THEN RETURN jsonb_build_object('error', 'session'); END IF;
  SELECT * INTO r FROM papi.requests
  WHERE code = upper(replace(coalesce(p_code, ''), '-', '')) AND investor_id = s.investor_id AND status = 'pending'
  FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'code'); END IF;
  UPDATE papi.requests SET status = 'declined', decided_at = clock_timestamp() WHERE id = r.id;
  PERFORM papi.audit(s.investor_id, 'app.request.declined', jsonb_build_object('request', r.id));
  RETURN jsonb_build_object('ok', true);
END $$;

-- ================================================================== privileges
REVOKE ALL ON TABLE papi.requests FROM PUBLIC;
REVOKE ALL ON FUNCTION papi.guard_request(), papi.request_json(papi.requests), papi.request_reserve(bytea, uuid, bigint, text, text), papi.request(bytea, uuid),
  papi.subscription(bytea, uuid), papi.web_request_lookup(bytea, text), papi.web_request_done(bytea, text, uuid), papi.web_request_decline(bytea, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION papi.request_reserve(bytea, uuid, bigint, text, text), papi.request(bytea, uuid), papi.subscription(bytea, uuid) TO pt_svc_public_api;
GRANT EXECUTE ON FUNCTION papi.web_request_lookup(bytea, text), papi.web_request_done(bytea, text, uuid), papi.web_request_decline(bytea, text) TO pt_web;

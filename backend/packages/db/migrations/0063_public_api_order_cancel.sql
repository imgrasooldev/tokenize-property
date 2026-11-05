-- Public API phase 2b part 3: cancel an open market order from the app, confirmed on the website
-- (ADR 0018 amendment 4, docs/api/openapi.json POST /me/orders/{orderId}/cancel-requests).
-- Applies on top of 0062.
--
--   OC-1  papi.requests gains the kind 'order_cancel' with the order it acts on (target_order). The
--         app asks with an Idempotency-Key (same rules as PR-3); only the investor's own order, and
--         only while it is open and not fully filled. The request copies the order's symbol, side,
--         price and tokens, so the website shows exactly what is cancelled.
--   OC-2  The website cancels through its own path (the matcher lock, releasing the buy escrow),
--         then papi.web_request_order_cancel_done marks the request confirmed only when the target
--         order really is cancelled; order_id then names it. papi.web_request_decline (0060)
--         declines any kind.
--   OC-3  The order views (papi.order_json, papi.order_request, papi.web_request_lookup) cover both
--         order kinds and say which; papi.request (subscription requests) never returns either.

-- ================================================================== OC-1 the table
ALTER TABLE papi.requests ADD COLUMN target_order uuid REFERENCES webdemo.orders (id);
ALTER TABLE papi.requests DROP CONSTRAINT requests_kind_check;
ALTER TABLE papi.requests DROP CONSTRAINT requests_order_check;
ALTER TABLE papi.requests ADD CONSTRAINT requests_kind_check CHECK (kind IN ('reserve', 'cancel', 'withdraw', 'order', 'order_cancel'));
ALTER TABLE papi.requests ADD CONSTRAINT requests_order_check CHECK (
  (kind IN ('order', 'order_cancel')) = (offering_id IS NULL)
  AND (kind IN ('order', 'order_cancel')) = (symbol IS NOT NULL AND side IS NOT NULL AND price_paisa IS NOT NULL)
  AND (kind IN ('order', 'order_cancel') OR order_id IS NULL)
  AND (kind NOT IN ('order', 'order_cancel') OR (units <= 999999 AND subscription_id IS NULL)));
ALTER TABLE papi.requests ADD CONSTRAINT requests_target_order_check CHECK ((kind = 'order_cancel') = (target_order IS NOT NULL));
ALTER TABLE papi.requests ADD CONSTRAINT requests_bound_order CHECK (kind <> 'order_cancel' OR order_id IS NULL OR order_id = target_order);

-- ================================================================== OC-3 views
CREATE OR REPLACE FUNCTION papi.order_json(r papi.requests) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, papi AS $$
  SELECT jsonb_build_object(
    'id', r.id, 'kind', r.kind, 'symbol', r.symbol, 'side', r.side, 'price_paisa', r.price_paisa::text, 'tokens', r.units::text,
    'total_paisa', (r.price_paisa * r.units)::text,
    'status', CASE WHEN r.status = 'pending' AND r.expires_at <= clock_timestamp() THEN 'expired' ELSE r.status END,
    'code', r.code, 'created_at', r.created_at, 'expires_at', r.expires_at, 'order_id', r.order_id, 'target_order_id', r.target_order)
$$;

CREATE OR REPLACE FUNCTION papi.request(p_access_hash bytea, p_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, papi AS $$
  SELECT papi.request_json(r) FROM papi.requests r
  WHERE r.id = p_id AND r.kind NOT IN ('order', 'order_cancel') AND r.investor_id = papi.token_investor(p_access_hash)
$$;

CREATE OR REPLACE FUNCTION papi.order_request(p_access_hash bytea, p_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, papi AS $$
  SELECT papi.order_json(r) FROM papi.requests r
  WHERE r.id = p_id AND r.kind IN ('order', 'order_cancel') AND r.investor_id = papi.token_investor(p_access_hash)
$$;

CREATE OR REPLACE FUNCTION papi.web_request_lookup(p_session bytea, p_code text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, papi AS $$
DECLARE
  s webauth.sessions := webauth.live_session(p_session);
  r papi.requests;
BEGIN
  IF s.token_hash IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO r FROM papi.requests
  WHERE code = upper(replace(coalesce(p_code, ''), '-', '')) AND investor_id = s.investor_id AND status = 'pending' AND expires_at > clock_timestamp();
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN CASE WHEN r.kind IN ('order', 'order_cancel') THEN papi.order_json(r) ELSE papi.request_json(r) END;
END $$;

-- ================================================================== OC-1 the app asks
/** A new cancellation request for one of the investor's open orders, or the one already made with this key. */
CREATE FUNCTION papi.request_order_cancel(p_access_hash bytea, p_order uuid, p_key text, p_code text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, papi AS $$
DECLARE
  v_investor uuid := papi.token_investor(p_access_hash);
  o webdemo.orders;
  r papi.requests;
  v_now timestamptz := date_trunc('microseconds', clock_timestamp());
BEGIN
  IF v_investor IS NULL THEN RETURN jsonb_build_object('error', 'token'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_investor::text || '/' || coalesce(p_key, ''), 60));
  SELECT * INTO r FROM papi.requests WHERE investor_id = v_investor AND idempotency_key = p_key;
  IF FOUND THEN
    IF r.kind <> 'order_cancel' OR r.target_order IS DISTINCT FROM p_order THEN RETURN jsonb_build_object('error', 'conflict'); END IF;
    RETURN papi.order_json(r) || jsonb_build_object('replayed', true);
  END IF;
  SELECT * INTO o FROM webdemo.orders WHERE id = p_order AND investor_id = v_investor AND status = 'open' AND filled < tokens;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'order'); END IF;
  IF (SELECT count(*) FROM papi.requests WHERE investor_id = v_investor AND status = 'pending' AND expires_at > v_now) >= 5 THEN
    RETURN jsonb_build_object('error', 'limit');
  END IF;
  INSERT INTO papi.requests (investor_id, kind, units, idempotency_key, code, created_at, expires_at, symbol, side, price_paisa, target_order)
  VALUES (v_investor, 'order_cancel', least(o.tokens, 999999), p_key, p_code, v_now, v_now + interval '15 minutes', o.symbol, o.side, o.price_paisa, o.id)
  RETURNING * INTO r;
  PERFORM papi.audit(v_investor, 'app.request', jsonb_build_object('request', r.id, 'kind', 'order_cancel', 'order', o.id));
  RETURN papi.order_json(r) || jsonb_build_object('replayed', false);
EXCEPTION WHEN unique_violation THEN
  RETURN jsonb_build_object('error', 'code');
END $$;

-- ================================================================== OC-2 the website finishes
CREATE FUNCTION papi.web_request_order_cancel_done(p_session bytea, p_code text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, papi AS $$
DECLARE
  w webauth.sessions := webauth.live_session(p_session);
  r papi.requests;
BEGIN
  IF w.token_hash IS NULL THEN RETURN jsonb_build_object('error', 'session'); END IF;
  SELECT * INTO r FROM papi.requests
  WHERE code = upper(replace(coalesce(p_code, ''), '-', '')) AND investor_id = w.investor_id AND status = 'pending' AND kind = 'order_cancel'
  FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'code'); END IF;
  IF NOT EXISTS (SELECT 1 FROM webdemo.orders o WHERE o.id = r.target_order AND o.investor_id = w.investor_id AND o.status = 'cancelled') THEN
    RETURN jsonb_build_object('error', 'mismatch');
  END IF;
  UPDATE papi.requests SET status = 'confirmed', order_id = r.target_order, decided_at = clock_timestamp() WHERE id = r.id;
  PERFORM papi.audit(w.investor_id, 'app.request.confirmed', jsonb_build_object('request', r.id, 'kind', 'order_cancel', 'order', r.target_order));
  RETURN jsonb_build_object('ok', true);
END $$;

-- ================================================================== privileges
REVOKE ALL ON FUNCTION papi.request_order_cancel(bytea, uuid, text, text), papi.web_request_order_cancel_done(bytea, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION papi.request_order_cancel(bytea, uuid, text, text) TO pt_svc_public_api;
GRANT EXECUTE ON FUNCTION papi.web_request_order_cancel_done(bytea, text) TO pt_web;

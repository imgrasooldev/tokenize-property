-- Public API phase 2b part 2: market orders from the app, confirmed on the website (ADR 0018
-- amendment 3, docs/api/openapi.json /markets, /me/orders, /me/order-requests). Applies on top of 0061.
--
--   PO-1  Reads of the demo market (website W4, webdemo.orders / webdemo.trades): the order book by
--         price level (best 10 a side, no investors) and the last settled trade, public; the token
--         owner's own orders.
--   PO-2  papi.requests gains the kind 'order' (symbol, side, price in paisa, tokens in units). The
--         app asks with an Idempotency-Key (same rules as PR-3); the API checks the format only.
--   PO-3  The website places exactly the requested order through its own path (KYC, on-chain
--         registration, price band, cash or free tokens, limits, matcher) with the request id as the
--         order's request id, then papi.web_request_order_done binds it only for the same investor,
--         symbol, side, price and tokens, placed after the request.
--   PO-4  papi.request (the subscription-request resource) no longer returns order requests;
--         papi.order_request does. papi.web_request_lookup returns either view, with its kind.

-- ================================================================== PO-2 the table
ALTER TABLE papi.requests DROP CONSTRAINT requests_kind_check;
ALTER TABLE papi.requests DROP CONSTRAINT requests_target_check;
DO $$
DECLARE
  c text;
BEGIN
  SELECT conname INTO c FROM pg_constraint
  WHERE conrelid = 'papi.requests'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%status = ''confirmed''%subscription_id IS NOT NULL%';
  IF c IS NULL THEN RAISE EXCEPTION 'the 0060 confirmed check of papi.requests was not found'; END IF;
  EXECUTE format('ALTER TABLE papi.requests DROP CONSTRAINT %I', c);
END $$;

ALTER TABLE papi.requests ALTER COLUMN offering_id DROP NOT NULL;
ALTER TABLE papi.requests ADD COLUMN symbol text CHECK (symbol ~ '^[A-Z][A-Z0-9]{2,11}$');
ALTER TABLE papi.requests ADD COLUMN side text CHECK (side IN ('buy', 'sell'));
ALTER TABLE papi.requests ADD COLUMN price_paisa bigint CHECK (price_paisa BETWEEN 1 AND 999999999);
ALTER TABLE papi.requests ADD COLUMN order_id uuid REFERENCES webdemo.orders (id);
ALTER TABLE papi.requests ADD CONSTRAINT requests_kind_check CHECK (kind IN ('reserve', 'cancel', 'withdraw', 'order'));
ALTER TABLE papi.requests ADD CONSTRAINT requests_target_check CHECK ((kind IN ('cancel', 'withdraw')) = (target_subscription IS NOT NULL));
ALTER TABLE papi.requests ADD CONSTRAINT requests_order_check CHECK (
  (kind = 'order') = (offering_id IS NULL)
  AND (kind = 'order') = (symbol IS NOT NULL AND side IS NOT NULL AND price_paisa IS NOT NULL)
  AND (kind = 'order' OR order_id IS NULL)
  AND (kind <> 'order' OR (units <= 999999 AND subscription_id IS NULL)));
ALTER TABLE papi.requests ADD CONSTRAINT requests_confirmed_check CHECK ((status = 'confirmed') = (coalesce(subscription_id, order_id) IS NOT NULL));

/** Decided once: only status, the bound subscription or order and decided_at change, and only while pending. */
CREATE OR REPLACE FUNCTION papi.guard_request() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'pending'
     OR (to_jsonb(NEW) - 'status' - 'subscription_id' - 'order_id' - 'decided_at') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'subscription_id' - 'order_id' - 'decided_at') THEN
    RAISE EXCEPTION 'an app request is decided once and never changed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

/** The public view of an order request (resource OrderRequest). */
CREATE FUNCTION papi.order_json(r papi.requests) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, papi AS $$
  SELECT jsonb_build_object(
    'id', r.id, 'kind', r.kind, 'symbol', r.symbol, 'side', r.side, 'price_paisa', r.price_paisa::text, 'tokens', r.units::text,
    'total_paisa', (r.price_paisa * r.units)::text,
    'status', CASE WHEN r.status = 'pending' AND r.expires_at <= clock_timestamp() THEN 'expired' ELSE r.status END,
    'code', r.code, 'created_at', r.created_at, 'expires_at', r.expires_at, 'order_id', r.order_id)
$$;

/** PO-2: a new order request, or the existing one for the same Idempotency-Key. Errors come back as {error}. */
CREATE FUNCTION papi.request_order(p_access_hash bytea, p_symbol text, p_side text, p_price bigint, p_tokens bigint, p_key text, p_code text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, papi AS $$
DECLARE
  v_investor uuid := papi.token_investor(p_access_hash);
  r papi.requests;
  v_now timestamptz := date_trunc('microseconds', clock_timestamp());
BEGIN
  IF v_investor IS NULL THEN RETURN jsonb_build_object('error', 'token'); END IF;
  IF p_symbol IS NULL OR p_symbol !~ '^[A-Z][A-Z0-9]{2,11}$' OR p_side IS NULL OR p_side NOT IN ('buy', 'sell')
     OR p_price IS NULL OR p_price NOT BETWEEN 1 AND 999999999 OR p_tokens IS NULL OR p_tokens NOT BETWEEN 1 AND 999999 THEN
    RETURN jsonb_build_object('error', 'input');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_investor::text || '/' || coalesce(p_key, ''), 60));
  SELECT * INTO r FROM papi.requests WHERE investor_id = v_investor AND idempotency_key = p_key;
  IF FOUND THEN
    IF r.kind <> 'order' OR r.symbol IS DISTINCT FROM p_symbol OR r.side IS DISTINCT FROM p_side OR r.price_paisa IS DISTINCT FROM p_price OR r.units IS DISTINCT FROM p_tokens THEN
      RETURN jsonb_build_object('error', 'conflict');
    END IF;
    RETURN papi.order_json(r) || jsonb_build_object('replayed', true);
  END IF;
  IF (SELECT count(*) FROM papi.requests WHERE investor_id = v_investor AND status = 'pending' AND expires_at > v_now) >= 5 THEN
    RETURN jsonb_build_object('error', 'limit');
  END IF;
  INSERT INTO papi.requests (investor_id, kind, units, idempotency_key, code, created_at, expires_at, symbol, side, price_paisa)
  VALUES (v_investor, 'order', p_tokens, p_key, p_code, v_now, v_now + interval '15 minutes', p_symbol, p_side, p_price)
  RETURNING * INTO r;
  PERFORM papi.audit(v_investor, 'app.request', jsonb_build_object('request', r.id, 'kind', 'order', 'symbol', p_symbol, 'side', p_side, 'price', p_price, 'tokens', p_tokens));
  RETURN papi.order_json(r) || jsonb_build_object('replayed', false);
EXCEPTION WHEN unique_violation THEN
  RETURN jsonb_build_object('error', 'code');
END $$;

-- ================================================================== PO-4 views by kind
CREATE OR REPLACE FUNCTION papi.request(p_access_hash bytea, p_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, papi AS $$
  SELECT papi.request_json(r) FROM papi.requests r WHERE r.id = p_id AND r.kind <> 'order' AND r.investor_id = papi.token_investor(p_access_hash)
$$;

CREATE FUNCTION papi.order_request(p_access_hash bytea, p_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, papi AS $$
  SELECT papi.order_json(r) FROM papi.requests r WHERE r.id = p_id AND r.kind = 'order' AND r.investor_id = papi.token_investor(p_access_hash)
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
  RETURN CASE WHEN r.kind = 'order' THEN papi.order_json(r) ELSE papi.request_json(r) END;
END $$;

-- ================================================================== PO-3 the website binds the order
CREATE FUNCTION papi.web_request_order_done(p_session bytea, p_code text, p_order uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, papi AS $$
DECLARE
  w webauth.sessions := webauth.live_session(p_session);
  r papi.requests;
BEGIN
  IF w.token_hash IS NULL THEN RETURN jsonb_build_object('error', 'session'); END IF;
  SELECT * INTO r FROM papi.requests
  WHERE code = upper(replace(coalesce(p_code, ''), '-', '')) AND investor_id = w.investor_id AND status = 'pending' AND kind = 'order'
  FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'code'); END IF;
  IF NOT EXISTS (SELECT 1 FROM webdemo.orders o
                 WHERE o.id = p_order AND o.investor_id = w.investor_id AND o.symbol = r.symbol AND o.side = r.side
                   AND o.price_paisa = r.price_paisa AND o.tokens = r.units AND o.created_at >= r.created_at) THEN
    RETURN jsonb_build_object('error', 'mismatch');
  END IF;
  UPDATE papi.requests SET status = 'confirmed', order_id = p_order, decided_at = clock_timestamp() WHERE id = r.id;
  PERFORM papi.audit(w.investor_id, 'app.request.confirmed', jsonb_build_object('request', r.id, 'kind', 'order', 'order', p_order));
  RETURN jsonb_build_object('ok', true);
END $$;

-- ================================================================== PO-1 market reads
/** The order book (best 10 levels a side) and the last settled trade of one symbol, or of every symbol with a market. */
CREATE FUNCTION papi.markets(p_symbol text DEFAULT NULL) RETURNS TABLE (symbol text, book jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, papi AS $$
  WITH syms AS (
    SELECT DISTINCT x.symbol FROM (SELECT s.symbol FROM webdemo.subscriptions s UNION SELECT o.symbol FROM webdemo.orders o) x
    WHERE p_symbol IS NULL OR x.symbol = p_symbol
  )
  SELECT m.symbol, jsonb_build_object(
    'symbol', m.symbol,
    'bids', coalesce((SELECT jsonb_agg(jsonb_build_object('price_paisa', l.price_paisa::text, 'tokens', l.tokens::text) ORDER BY l.price_paisa DESC)
                      FROM (SELECT o.price_paisa, sum(o.tokens - o.filled) AS tokens FROM webdemo.orders o
                            WHERE o.symbol = m.symbol AND o.side = 'buy' AND o.status = 'open' AND o.filled < o.tokens
                            GROUP BY o.price_paisa ORDER BY o.price_paisa DESC LIMIT 10) l), '[]'::jsonb),
    'asks', coalesce((SELECT jsonb_agg(jsonb_build_object('price_paisa', l.price_paisa::text, 'tokens', l.tokens::text) ORDER BY l.price_paisa)
                      FROM (SELECT o.price_paisa, sum(o.tokens - o.filled) AS tokens FROM webdemo.orders o
                            WHERE o.symbol = m.symbol AND o.side = 'sell' AND o.status = 'open' AND o.filled < o.tokens
                            GROUP BY o.price_paisa ORDER BY o.price_paisa LIMIT 10) l), '[]'::jsonb),
    'last_price_paisa', (SELECT t.price_paisa::text FROM webdemo.trades t WHERE t.symbol = m.symbol AND t.status = 'settled' ORDER BY t.created_at DESC LIMIT 1),
    'last_trade_at', (SELECT t.created_at FROM webdemo.trades t WHERE t.symbol = m.symbol AND t.status = 'settled' ORDER BY t.created_at DESC LIMIT 1))
  FROM syms m
  ORDER BY m.symbol
$$;

/** The token owner's own demo-market orders, newest first. */
CREATE FUNCTION papi.orders(p_access_hash bytea)
RETURNS TABLE (id uuid, symbol text, side text, price_paisa bigint, tokens bigint, filled bigint, status text, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, papi AS $$
  SELECT o.id, o.symbol, o.side, o.price_paisa, o.tokens, o.filled, o.status, o.created_at
  FROM webdemo.orders o
  WHERE o.investor_id = papi.token_investor(p_access_hash)
  ORDER BY o.created_at DESC, o.id
  LIMIT 500
$$;

-- ================================================================== privileges
REVOKE ALL ON FUNCTION papi.order_json(papi.requests), papi.request_order(bytea, text, text, bigint, bigint, text, text), papi.order_request(bytea, uuid),
  papi.web_request_order_done(bytea, text, uuid), papi.markets(text), papi.orders(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION papi.request_order(bytea, text, text, bigint, bigint, text, text), papi.order_request(bytea, uuid), papi.markets(text), papi.orders(bytea) TO pt_svc_public_api;
GRANT EXECUTE ON FUNCTION papi.web_request_order_done(bytea, text, uuid) TO pt_web;

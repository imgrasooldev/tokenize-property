-- Public API phase 2b part 4: the demo market cash from the app (ADR 0018 amendment 5,
-- docs/api/openapi.json GET /me/cash, POST /me/topup-requests). Applies on top of 0063.
--
--   CT-1  papi.cash(token): the investor's demo cash as the ledger has it: available (the cash
--         account) and held in open buy orders (their escrow accounts). Read only.
--   CT-2  papi.requests gains the kind 'topup' (amount in topup_paisa, at most Rs 10,000,000 as on
--         the website). The app asks with an Idempotency-Key (same rules as PR-3); a request moves
--         no money.
--   CT-3  The website adds the cash through its own demo top-up (webdemo.topups with the request id
--         as the top-up's request id, one ledger journal), then papi.web_request_topup_done marks the
--         request confirmed only when that top-up exists for the same investor and amount; topup_id
--         then names it. papi.web_request_decline (0060) declines any kind.
--   The demo top-up stands in for a Raast payment into the investor's cash account; it exists only
--   on the demo market (website W4) and is labelled as such everywhere.

-- ================================================================== CT-2 the table
ALTER TABLE papi.requests ADD COLUMN topup_paisa bigint CHECK (topup_paisa BETWEEN 100 AND 1000000000);
ALTER TABLE papi.requests ADD COLUMN topup_id uuid REFERENCES webdemo.topups (id);
ALTER TABLE papi.requests DROP CONSTRAINT requests_kind_check;
ALTER TABLE papi.requests DROP CONSTRAINT requests_order_check;
ALTER TABLE papi.requests DROP CONSTRAINT requests_confirmed_check;
ALTER TABLE papi.requests ADD CONSTRAINT requests_kind_check CHECK (kind IN ('reserve', 'cancel', 'withdraw', 'order', 'order_cancel', 'topup'));
ALTER TABLE papi.requests ADD CONSTRAINT requests_order_check CHECK (
  (kind IN ('order', 'order_cancel', 'topup')) = (offering_id IS NULL)
  AND (kind IN ('order', 'order_cancel')) = (symbol IS NOT NULL AND side IS NOT NULL AND price_paisa IS NOT NULL)
  AND (kind IN ('order', 'order_cancel') OR order_id IS NULL)
  AND (kind NOT IN ('order', 'order_cancel') OR (units <= 999999 AND subscription_id IS NULL)));
ALTER TABLE papi.requests ADD CONSTRAINT requests_topup_check CHECK (
  (kind = 'topup') = (topup_paisa IS NOT NULL)
  AND (kind = 'topup' OR topup_id IS NULL)
  AND (kind <> 'topup' OR (units = 1 AND subscription_id IS NULL)));
ALTER TABLE papi.requests ADD CONSTRAINT requests_confirmed_check CHECK ((status = 'confirmed') = (coalesce(subscription_id, order_id, topup_id) IS NOT NULL));
CREATE UNIQUE INDEX requests_topup_once ON papi.requests (topup_id) WHERE topup_id IS NOT NULL;

/** Decided once: only status, the bound subscription, order or top-up and decided_at change, and only while pending. */
CREATE OR REPLACE FUNCTION papi.guard_request() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'pending'
     OR (to_jsonb(NEW) - 'status' - 'subscription_id' - 'order_id' - 'topup_id' - 'decided_at')
        IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'subscription_id' - 'order_id' - 'topup_id' - 'decided_at') THEN
    RAISE EXCEPTION 'an app request is decided once and never changed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

/** The public view of a top-up request (resource TopUpRequest). */
CREATE FUNCTION papi.topup_json(r papi.requests) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, papi AS $$
  SELECT jsonb_build_object(
    'id', r.id, 'kind', r.kind, 'amount_paisa', r.topup_paisa::text,
    'status', CASE WHEN r.status = 'pending' AND r.expires_at <= clock_timestamp() THEN 'expired' ELSE r.status END,
    'code', r.code, 'created_at', r.created_at, 'expires_at', r.expires_at, 'topup_id', r.topup_id)
$$;

-- ================================================================== CT-1 the cash read
CREATE FUNCTION papi.cash(p_access_hash bytea) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, papi AS $$
  SELECT jsonb_build_object(
    'available_paisa', coalesce((SELECT -b.balance FROM ledger.balances b WHERE b.code = 'web:investor:' || i.id || ':cash'), 0)::text,
    'in_orders_paisa', coalesce((SELECT sum(-b.balance) FROM webdemo.orders o JOIN ledger.balances b ON b.code = 'web:order:' || o.id || ':escrow'
                                 WHERE o.investor_id = i.id AND o.status = 'open'), 0)::text)
  FROM webdemo.investors i WHERE i.id = papi.token_investor(p_access_hash)
$$;

-- ================================================================== CT-2 the app asks
CREATE FUNCTION papi.request_topup(p_access_hash bytea, p_amount bigint, p_key text, p_code text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, papi AS $$
DECLARE
  v_investor uuid := papi.token_investor(p_access_hash);
  r papi.requests;
  v_now timestamptz := date_trunc('microseconds', clock_timestamp());
BEGIN
  IF v_investor IS NULL THEN RETURN jsonb_build_object('error', 'token'); END IF;
  IF p_amount IS NULL OR p_amount NOT BETWEEN 100 AND 1000000000 OR p_amount % 100 <> 0 THEN RETURN jsonb_build_object('error', 'input'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_investor::text || '/' || coalesce(p_key, ''), 60));
  SELECT * INTO r FROM papi.requests WHERE investor_id = v_investor AND idempotency_key = p_key;
  IF FOUND THEN
    IF r.kind <> 'topup' OR r.topup_paisa IS DISTINCT FROM p_amount THEN RETURN jsonb_build_object('error', 'conflict'); END IF;
    RETURN papi.topup_json(r) || jsonb_build_object('replayed', true);
  END IF;
  IF (SELECT count(*) FROM papi.requests WHERE investor_id = v_investor AND status = 'pending' AND expires_at > v_now) >= 5 THEN
    RETURN jsonb_build_object('error', 'limit');
  END IF;
  INSERT INTO papi.requests (investor_id, kind, units, idempotency_key, code, created_at, expires_at, topup_paisa)
  VALUES (v_investor, 'topup', 1, p_key, p_code, v_now, v_now + interval '15 minutes', p_amount)
  RETURNING * INTO r;
  PERFORM papi.audit(v_investor, 'app.request', jsonb_build_object('request', r.id, 'kind', 'topup', 'amount', p_amount));
  RETURN papi.topup_json(r) || jsonb_build_object('replayed', false);
EXCEPTION WHEN unique_violation THEN
  RETURN jsonb_build_object('error', 'code');
END $$;

CREATE FUNCTION papi.topup_request(p_access_hash bytea, p_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, papi AS $$
  SELECT papi.topup_json(r) FROM papi.requests r WHERE r.id = p_id AND r.kind = 'topup' AND r.investor_id = papi.token_investor(p_access_hash)
$$;

-- Subscription and order views never return a top-up request.
CREATE OR REPLACE FUNCTION papi.request(p_access_hash bytea, p_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, papi AS $$
  SELECT papi.request_json(r) FROM papi.requests r
  WHERE r.id = p_id AND r.kind IN ('reserve', 'cancel', 'withdraw') AND r.investor_id = papi.token_investor(p_access_hash)
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
  RETURN CASE WHEN r.kind IN ('order', 'order_cancel') THEN papi.order_json(r) WHEN r.kind = 'topup' THEN papi.topup_json(r) ELSE papi.request_json(r) END;
END $$;

-- ================================================================== CT-3 the website finishes
CREATE FUNCTION papi.web_request_topup_done(p_session bytea, p_code text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, papi AS $$
DECLARE
  w webauth.sessions := webauth.live_session(p_session);
  r papi.requests;
  v_topup uuid;
BEGIN
  IF w.token_hash IS NULL THEN RETURN jsonb_build_object('error', 'session'); END IF;
  SELECT * INTO r FROM papi.requests
  WHERE code = upper(replace(coalesce(p_code, ''), '-', '')) AND investor_id = w.investor_id AND status = 'pending' AND kind = 'topup'
  FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'code'); END IF;
  SELECT t.id INTO v_topup FROM webdemo.topups t
  WHERE t.request_id = r.id AND t.investor_id = w.investor_id AND t.amount_paisa = r.topup_paisa AND t.created_at >= r.created_at;
  IF v_topup IS NULL THEN RETURN jsonb_build_object('error', 'mismatch'); END IF;
  UPDATE papi.requests SET status = 'confirmed', topup_id = v_topup, decided_at = clock_timestamp() WHERE id = r.id;
  PERFORM papi.audit(w.investor_id, 'app.request.confirmed', jsonb_build_object('request', r.id, 'kind', 'topup', 'topup', v_topup));
  RETURN jsonb_build_object('ok', true);
END $$;

-- ================================================================== privileges
REVOKE ALL ON FUNCTION papi.topup_json(papi.requests), papi.cash(bytea), papi.request_topup(bytea, bigint, text, text), papi.topup_request(bytea, uuid),
  papi.web_request_topup_done(bytea, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION papi.cash(bytea), papi.request_topup(bytea, bigint, text, text), papi.topup_request(bytea, uuid) TO pt_svc_public_api;
GRANT EXECUTE ON FUNCTION papi.web_request_topup_done(bytea, text) TO pt_web;

-- Sender-constrained app tokens: DPoP, RFC 9449 (ADR 0018 amendment 7). Applies on top of 0065.
--
--   DP-1  A token family can be bound to the app's key: papi.tokens.dpop_jkt is the JWK SHA-256
--         thumbprint (RFC 7638) of the public key whose DPoP proof came with the token request.
--         It never changes on a row (guard), and every row of a family made later keeps it.
--   DP-2  Device grant: the first token of the family is bound when the app sent a DPoP proof.
--   DP-3  Refresh: a bound family refreshes only with a proof of the same key (else invalid_grant,
--         without revoking the family: a stolen refresh token alone is useless). An unbound family
--         refreshed with a proof becomes bound from that token on (existing installations upgrade).
--   DP-4  Every API call with a bound access token must carry a proof of that key (checked by the
--         service: signature, method, URL, time, one use, access token hash); papi.token_jkt tells
--         the service whether a live token is bound.
--   The proof itself (a signed JWT) is checked by the service, never stored; replays are refused in
--   the service's memory for the proof's lifetime.

ALTER TABLE papi.tokens ADD COLUMN dpop_jkt text CHECK (dpop_jkt ~ '^[A-Za-z0-9_-]{43}$');

CREATE OR REPLACE FUNCTION papi.guard_token() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.family, NEW.investor_id, NEW.device_name, NEW.access_hash, NEW.refresh_hash, NEW.issued_at, NEW.access_expires_at, NEW.refresh_expires_at, NEW.dpop_jkt)
     IS DISTINCT FROM (OLD.id, OLD.family, OLD.investor_id, OLD.device_name, OLD.access_hash, OLD.refresh_hash, OLD.issued_at, OLD.access_expires_at,
                       OLD.refresh_expires_at, OLD.dpop_jkt)
     OR (OLD.refreshed_at IS NOT NULL AND NEW.refreshed_at IS DISTINCT FROM OLD.refreshed_at)
     OR (OLD.revoked_at IS NOT NULL AND (NEW.revoked_at, NEW.revoke_reason) IS DISTINCT FROM (OLD.revoked_at, OLD.revoke_reason)) THEN
    RAISE EXCEPTION 'token % can only be spent or revoked, once', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- ================================================================== DP-2 device grant
DROP FUNCTION papi.device_token(bytea, bytea, bytea);
/** PA-1/PA-3 (0058): the device polls; on an approved grant the first poll gets the token family, bound to p_jkt when given (DP-2). */
CREATE FUNCTION papi.device_token(p_device_hash bytea, p_access_hash bytea, p_refresh_hash bytea, p_jkt text DEFAULT NULL) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, papi AS $$
DECLARE
  g papi.device_grants;
  v_now timestamptz := date_trunc('microseconds', clock_timestamp());
BEGIN
  SELECT * INTO g FROM papi.device_grants WHERE device_code_hash = p_device_hash FOR UPDATE;
  IF NOT FOUND OR g.consumed_at IS NOT NULL THEN RETURN 'invalid_grant'; END IF;
  IF g.expires_at <= v_now THEN RETURN 'expired_token'; END IF;
  IF g.decision = 'denied' THEN RETURN 'access_denied'; END IF;
  IF g.decision IS NULL THEN
    IF g.last_poll_at IS NOT NULL AND v_now < g.last_poll_at + interval '5 seconds' THEN
      UPDATE papi.device_grants SET last_poll_at = v_now WHERE id = g.id;
      RETURN 'slow_down';
    END IF;
    UPDATE papi.device_grants SET last_poll_at = v_now WHERE id = g.id;
    RETURN 'authorization_pending';
  END IF;
  UPDATE papi.device_grants SET consumed_at = v_now, last_poll_at = v_now WHERE id = g.id;
  INSERT INTO papi.tokens (family, investor_id, device_name, access_hash, refresh_hash, issued_at, access_expires_at, refresh_expires_at, dpop_jkt)
  VALUES (gen_random_uuid(), g.investor_id, g.device_name, p_access_hash, p_refresh_hash, v_now, v_now + interval '15 minutes', v_now + interval '30 days', p_jkt);
  PERFORM papi.audit(g.investor_id, 'device.linked', jsonb_build_object('grant', g.id, 'device', g.device_name, 'dpop', p_jkt IS NOT NULL));
  RETURN 'ok';
END $$;

-- ================================================================== DP-3 refresh
DROP FUNCTION papi.refresh(bytea, bytea, bytea);
/** PA-3 (0058): refresh-token rotation with reuse detection; DP-3: a bound family needs a proof of its key. */
CREATE FUNCTION papi.refresh(p_refresh_hash bytea, p_access_hash bytea, p_new_refresh_hash bytea, p_jkt text DEFAULT NULL) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, papi AS $$
DECLARE
  t papi.tokens;
  v_now timestamptz := date_trunc('microseconds', clock_timestamp());
BEGIN
  SELECT * INTO t FROM papi.tokens WHERE refresh_hash = p_refresh_hash FOR UPDATE;
  IF NOT FOUND THEN RETURN 'invalid_grant'; END IF;
  IF t.revoked_at IS NOT NULL OR t.refresh_expires_at <= v_now THEN RETURN 'invalid_grant'; END IF;
  IF t.dpop_jkt IS NOT NULL AND p_jkt IS DISTINCT FROM t.dpop_jkt THEN
    -- Without the app's key a copied refresh token is useless; the family stays as it is.
    PERFORM papi.audit(t.investor_id, 'device.dpop_mismatch', jsonb_build_object('family', t.family, 'device', t.device_name));
    RETURN 'invalid_grant';
  END IF;
  IF t.refreshed_at IS NOT NULL THEN
    -- A spent refresh token presented again: somebody copied it. Revoke the whole family.
    UPDATE papi.tokens SET revoked_at = v_now, revoke_reason = 'reuse' WHERE family = t.family AND revoked_at IS NULL;
    PERFORM papi.audit(t.investor_id, 'device.token_reuse', jsonb_build_object('family', t.family, 'device', t.device_name));
    RETURN 'invalid_grant';
  END IF;
  IF kyc.subject_status((SELECT i.kyc_subject FROM webdemo.investors i WHERE i.id = t.investor_id)) IN ('rejected', 'revoked') THEN
    UPDATE papi.tokens SET revoked_at = v_now, revoke_reason = 'revoked' WHERE family = t.family AND revoked_at IS NULL;
    RETURN 'invalid_grant';
  END IF;
  UPDATE papi.tokens SET refreshed_at = v_now WHERE id = t.id;
  INSERT INTO papi.tokens (family, investor_id, device_name, access_hash, refresh_hash, issued_at, access_expires_at, refresh_expires_at, dpop_jkt)
  VALUES (t.family, t.investor_id, t.device_name, p_access_hash, p_new_refresh_hash, v_now, v_now + interval '15 minutes', t.refresh_expires_at,
          coalesce(t.dpop_jkt, p_jkt));
  IF t.dpop_jkt IS NULL AND p_jkt IS NOT NULL THEN
    PERFORM papi.audit(t.investor_id, 'device.dpop_bound', jsonb_build_object('family', t.family, 'device', t.device_name));
  END IF;
  RETURN 'ok';
END $$;

-- ================================================================== DP-4 calls
/** The key thumbprint a live access token is bound to; NULL for an unbound, unknown, expired or revoked token. */
CREATE FUNCTION papi.token_jkt(p_access_hash bytea) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, papi AS $$
  SELECT t.dpop_jkt FROM papi.tokens t
  WHERE t.access_hash = p_access_hash AND t.revoked_at IS NULL AND t.access_expires_at > clock_timestamp()
$$;

-- ================================================================== privileges
REVOKE ALL ON FUNCTION papi.device_token(bytea, bytea, bytea, text), papi.refresh(bytea, bytea, bytea, text), papi.token_jkt(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION papi.device_token(bytea, bytea, bytea, text), papi.refresh(bytea, bytea, bytea, text), papi.token_jkt(bytea) TO pt_svc_public_api;

-- Public API for the investor mobile app, phase 1 read-only (ADR 0018, docs/api/openapi.json).
-- Applies on top of 0057.
--
--   PA-1  OAuth 2.0 Device Authorization Grant (RFC 8628). The API stores only SHA-256 hashes of the
--         device code and of the tokens; the user code (8 letters, no vowels) is shown to the
--         investor. A grant lives 10 minutes; the device polls at most every 5 seconds (slow_down).
--   PA-2  The investor approves or denies a user code on the website (papi.web_device_decide, as
--         pt_web) with a passkey step-up where they have a passkey (webauth.gate 'device.link').
--   PA-3  Tokens: access 15 minutes, refresh 30 days, one family per approved device. A refresh
--         token is spent on use (rotation, RFC 9700); presenting a spent refresh token revokes the
--         whole family (reuse detection). Revocation (RFC 7009) and the website's linked-devices
--         list revoke a family. Every read checks the access token in the database.
--   PA-4  Reads return only the token owner's data, through the same SQL the website uses
--         (offering.web_offerings / web_subscriptions, tax certificates, notify inbox), and never
--         a reason, a case or another investor's state (tipping-off: 'review' only).
--   PA-5  Role pt_svc_public_api (login pt_public_api_app, ADR 0016): EXECUTE on papi.* API
--         functions only; no table access, no other schema.

CREATE SCHEMA papi;
REVOKE ALL ON SCHEMA papi FROM PUBLIC;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pt_svc_public_api') THEN
    CREATE ROLE pt_svc_public_api NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END $$;

-- ================================================================== PA-1 device grants
CREATE TABLE papi.device_grants (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  device_code_hash bytea NOT NULL UNIQUE CHECK (length(device_code_hash) = 32),
  user_code        text NOT NULL CHECK (user_code ~ '^[BCDFGHJKLMNPQRSTVWXZ]{8}$'),
  client_id        text NOT NULL CHECK (client_id = 'pt-mobile'),
  device_name      text NOT NULL CHECK (length(device_name) BETWEEN 1 AND 60),
  created_at       timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  expires_at       timestamptz NOT NULL,
  last_poll_at     timestamptz,
  investor_id      uuid REFERENCES webdemo.investors (id),
  decided_at       timestamptz,
  decision         text CHECK (decision IN ('approved', 'denied')),
  consumed_at      timestamptz,
  CHECK (expires_at = created_at + interval '10 minutes'),
  CHECK ((decision IS NULL) = (decided_at IS NULL)),
  CHECK ((decision = 'approved') = (investor_id IS NOT NULL)),
  CHECK (consumed_at IS NULL OR decision = 'approved')
);
CREATE UNIQUE INDEX device_grants_open_code ON papi.device_grants (user_code) WHERE decision IS NULL AND consumed_at IS NULL;

CREATE TABLE papi.tokens (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  family             uuid NOT NULL,
  investor_id        uuid NOT NULL REFERENCES webdemo.investors (id),
  device_name        text NOT NULL,
  access_hash        bytea NOT NULL UNIQUE CHECK (length(access_hash) = 32),
  refresh_hash       bytea NOT NULL UNIQUE CHECK (length(refresh_hash) = 32),
  issued_at          timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  access_expires_at  timestamptz NOT NULL,
  refresh_expires_at timestamptz NOT NULL,
  refreshed_at       timestamptz,
  revoked_at         timestamptz,
  revoke_reason      text CHECK (revoke_reason IN ('revoked', 'reuse', 'device_removed')),
  CHECK (access_expires_at = issued_at + interval '15 minutes'),
  CHECK (refresh_expires_at <= issued_at + interval '30 days'),
  CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL))
);
CREATE INDEX tokens_family_idx ON papi.tokens (family);
CREATE INDEX tokens_investor_idx ON papi.tokens (investor_id) WHERE revoked_at IS NULL;

CREATE FUNCTION papi.forbid_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'papi.% rows are never deleted', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER device_grants_no_delete BEFORE DELETE ON papi.device_grants FOR EACH ROW EXECUTE FUNCTION papi.forbid_delete();
CREATE TRIGGER tokens_no_delete BEFORE DELETE ON papi.tokens FOR EACH ROW EXECUTE FUNCTION papi.forbid_delete();
CREATE TRIGGER device_grants_no_truncate BEFORE TRUNCATE ON papi.device_grants FOR EACH STATEMENT EXECUTE FUNCTION compliance.forbid_change();
CREATE TRIGGER tokens_no_truncate BEFORE TRUNCATE ON papi.tokens FOR EACH STATEMENT EXECUTE FUNCTION compliance.forbid_change();

CREATE FUNCTION papi.guard_token() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.family, NEW.investor_id, NEW.device_name, NEW.access_hash, NEW.refresh_hash, NEW.issued_at, NEW.access_expires_at, NEW.refresh_expires_at)
     IS DISTINCT FROM (OLD.id, OLD.family, OLD.investor_id, OLD.device_name, OLD.access_hash, OLD.refresh_hash, OLD.issued_at, OLD.access_expires_at,
                       OLD.refresh_expires_at)
     OR (OLD.refreshed_at IS NOT NULL AND NEW.refreshed_at IS DISTINCT FROM OLD.refreshed_at)
     OR (OLD.revoked_at IS NOT NULL AND (NEW.revoked_at, NEW.revoke_reason) IS DISTINCT FROM (OLD.revoked_at, OLD.revoke_reason)) THEN
    RAISE EXCEPTION 'token % can only be spent or revoked, once', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tokens_guard BEFORE UPDATE ON papi.tokens FOR EACH ROW EXECUTE FUNCTION papi.guard_token();

/** Writes one line to the website's audit chain (the investor's own actions and the API's security events). */
CREATE FUNCTION papi.audit(p_investor uuid, p_action text, p_detail jsonb) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, papi AS $$
  SELECT webauth.audit_append(CASE WHEN p_investor IS NULL THEN 'papi' ELSE webauth.actor(p_investor) END, p_action, p_detail)
$$;

/** PA-1: a new grant. The API makes the codes (device code: 256-bit random; only its hash comes here). */
CREATE FUNCTION papi.device_authorize(p_device_hash bytea, p_user_code text, p_client text, p_device_name text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, papi AS $$
DECLARE
  v_now timestamptz := date_trunc('microseconds', clock_timestamp());
BEGIN
  IF p_client IS DISTINCT FROM 'pt-mobile' THEN RAISE EXCEPTION 'invalid_client' USING ERRCODE = 'check_violation'; END IF;
  INSERT INTO papi.device_grants (device_code_hash, user_code, client_id, device_name, created_at, expires_at)
  VALUES (p_device_hash, p_user_code, p_client, left(btrim(coalesce(nullif(btrim(p_device_name), ''), 'Mobile device')), 60), v_now, v_now + interval '10 minutes');
  RETURN 600;
END $$;

/** PA-1/PA-3: the device polls; on an approved grant the first poll gets the token family. */
CREATE FUNCTION papi.device_token(p_device_hash bytea, p_access_hash bytea, p_refresh_hash bytea) RETURNS text
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
  INSERT INTO papi.tokens (family, investor_id, device_name, access_hash, refresh_hash, issued_at, access_expires_at, refresh_expires_at)
  VALUES (gen_random_uuid(), g.investor_id, g.device_name, p_access_hash, p_refresh_hash, v_now, v_now + interval '15 minutes', v_now + interval '30 days');
  PERFORM papi.audit(g.investor_id, 'device.linked', jsonb_build_object('grant', g.id, 'device', g.device_name));
  RETURN 'ok';
END $$;

/** PA-3: refresh-token rotation with reuse detection. The family keeps its 30-day end. */
CREATE FUNCTION papi.refresh(p_refresh_hash bytea, p_access_hash bytea, p_new_refresh_hash bytea) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, papi AS $$
DECLARE
  t papi.tokens;
  v_now timestamptz := date_trunc('microseconds', clock_timestamp());
BEGIN
  SELECT * INTO t FROM papi.tokens WHERE refresh_hash = p_refresh_hash FOR UPDATE;
  IF NOT FOUND THEN RETURN 'invalid_grant'; END IF;
  IF t.revoked_at IS NOT NULL OR t.refresh_expires_at <= v_now THEN RETURN 'invalid_grant'; END IF;
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
  INSERT INTO papi.tokens (family, investor_id, device_name, access_hash, refresh_hash, issued_at, access_expires_at, refresh_expires_at)
  VALUES (t.family, t.investor_id, t.device_name, p_access_hash, p_new_refresh_hash, v_now, v_now + interval '15 minutes', t.refresh_expires_at);
  RETURN 'ok';
END $$;

/** RFC 7009: an access or refresh token revokes its family; unknown tokens are not an error. */
CREATE FUNCTION papi.revoke(p_hash bytea) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, papi AS $$
DECLARE
  t papi.tokens;
BEGIN
  SELECT * INTO t FROM papi.tokens WHERE access_hash = p_hash OR refresh_hash = p_hash LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;
  UPDATE papi.tokens SET revoked_at = clock_timestamp(), revoke_reason = 'revoked' WHERE family = t.family AND revoked_at IS NULL;
  PERFORM papi.audit(t.investor_id, 'device.revoked', jsonb_build_object('family', t.family, 'device', t.device_name));
END $$;

/** PA-3: the investor of a live access token (NULL for an unknown, expired or revoked one). */
CREATE FUNCTION papi.token_investor(p_access_hash bytea) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, papi AS $$
  SELECT t.investor_id FROM papi.tokens t
  WHERE t.access_hash = p_access_hash AND t.revoked_at IS NULL AND t.access_expires_at > clock_timestamp()
$$;

-- ================================================================== PA-2 the website approves a device
/** The open grant behind a user code, for the confirmation screen (device name and expiry only). */
CREATE FUNCTION papi.web_device_lookup(p_session bytea, p_user_code text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, papi AS $$
DECLARE
  s webauth.sessions := webauth.live_session(p_session);
  g papi.device_grants;
BEGIN
  IF s.token_hash IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO g FROM papi.device_grants
  WHERE user_code = upper(replace(coalesce(p_user_code, ''), '-', '')) AND decision IS NULL AND consumed_at IS NULL AND expires_at > clock_timestamp();
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('deviceName', g.device_name, 'expiresAt', g.expires_at);
END $$;

/** PA-2: approve (passkey step-up where the investor has a passkey) or deny a user code. */
CREATE FUNCTION papi.web_device_decide(p_session bytea, p_user_code text, p_decision text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, papi AS $$
DECLARE
  gt record;
  g papi.device_grants;
BEGIN
  IF p_decision IS NULL OR p_decision NOT IN ('approve', 'deny') THEN RETURN jsonb_build_object('error', 'input'); END IF;
  IF p_decision = 'approve' THEN
    SELECT * INTO gt FROM webauth.gate(p_session, 'device.link', 0);
    IF gt.decision NOT IN ('ok', 'waived') THEN RETURN jsonb_build_object('error', gt.decision); END IF;
  ELSE
    SELECT (webauth.live_session(p_session)).investor_id AS investor_id INTO gt;
    IF gt.investor_id IS NULL THEN RETURN jsonb_build_object('error', 'session'); END IF;
  END IF;
  SELECT * INTO g FROM papi.device_grants
  WHERE user_code = upper(replace(coalesce(p_user_code, ''), '-', '')) AND decision IS NULL AND consumed_at IS NULL AND expires_at > clock_timestamp()
  FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'code'); END IF;
  UPDATE papi.device_grants SET decision = CASE p_decision WHEN 'approve' THEN 'approved' ELSE 'denied' END, decided_at = clock_timestamp(),
         investor_id = CASE p_decision WHEN 'approve' THEN gt.investor_id END
  WHERE id = g.id;
  PERFORM papi.audit(gt.investor_id, 'device.' || CASE p_decision WHEN 'approve' THEN 'approved' ELSE 'denied' END,
    jsonb_build_object('grant', g.id, 'device', g.device_name));
  RETURN jsonb_build_object('ok', true, 'deviceName', g.device_name);
END $$;

/** The investor's linked devices (one line per token family that is still usable). */
CREATE FUNCTION papi.web_devices(p_session bytea) RETURNS TABLE (family uuid, device_name text, linked_at timestamptz, last_used_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, papi AS $$
#variable_conflict use_column
DECLARE
  s webauth.sessions := webauth.live_session(p_session);
BEGIN
  IF s.token_hash IS NULL THEN RETURN; END IF;
  RETURN QUERY
    SELECT t.family, min(t.device_name), min(t.issued_at), max(t.issued_at)
    FROM papi.tokens t
    WHERE t.investor_id = s.investor_id
    GROUP BY t.family
    HAVING bool_or(t.revoked_at IS NULL AND t.refreshed_at IS NULL AND t.refresh_expires_at > clock_timestamp())
    ORDER BY max(t.issued_at) DESC;
END $$;

CREATE FUNCTION papi.web_device_remove(p_session bytea, p_family uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, papi AS $$
DECLARE
  s webauth.sessions := webauth.live_session(p_session);
  n integer;
BEGIN
  IF s.token_hash IS NULL THEN RETURN false; END IF;
  UPDATE papi.tokens SET revoked_at = clock_timestamp(), revoke_reason = 'device_removed'
  WHERE family = p_family AND investor_id = s.investor_id AND revoked_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN PERFORM papi.audit(s.investor_id, 'device.removed', jsonb_build_object('family', p_family)); END IF;
  RETURN n > 0;
END $$;

INSERT INTO webauth.step_up_actions (action, min_amount_paisa, note) VALUES
  ('device.link', 0, 'Linking a mobile device to the account (ADR 0018, OAuth device grant)');

-- ================================================================== PA-4 reads (scope read)
/** The token owner's KYC subject (NULL without a live token). */
CREATE FUNCTION papi.subject(p_access_hash bytea) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, papi AS $$
  SELECT i.kyc_subject FROM webdemo.investors i WHERE i.id = papi.token_investor(p_access_hash)
$$;

CREATE FUNCTION papi.me(p_access_hash bytea) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, papi AS $$
DECLARE
  i webdemo.investors;
  v_status text;
  r kyc.residency;
BEGIN
  SELECT * INTO i FROM webdemo.investors WHERE id = papi.token_investor(p_access_hash);
  IF NOT FOUND THEN RETURN NULL; END IF;
  v_status := CASE WHEN i.kyc_subject IS NULL THEN i.kyc_status ELSE kyc.subject_status(i.kyc_subject) END;
  IF i.kyc_subject IS NOT NULL THEN r := kyc.current_residency(i.kyc_subject); END IF;
  RETURN jsonb_build_object(
    'id', i.id, 'display_name', i.display_name, 'wallet', lower(i.wallet_address),
    -- Tipping-off (0053): one neutral word for every review state.
    'kyc', CASE WHEN v_status IN ('suspended', 'review') THEN 'review' WHEN v_status IN ('verified', 'pending', 'expired', 'rejected') THEN v_status
                WHEN v_status = 'revoked' THEN 'rejected' ELSE 'pending' END,
    'residency', jsonb_build_object('status', coalesce(r.status, 'resident'), 'document', coalesce(r.document, 'cnic'), 'country', r.country),
    'support_reference', CASE WHEN i.kyc_subject IS NULL THEN NULL ELSE left(replace(i.kyc_subject::text, '-', ''), 8) END);
END $$;

CREATE FUNCTION papi.holdings(p_access_hash bytea) RETURNS TABLE (token text, units text, frozen_units text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, papi AS $$
  SELECT h.token, h.balance::text, coalesce(f.frozen_amount, 0)::text
  FROM webdemo.investors i
  JOIN chain.holdings h ON h.holder = lower(i.wallet_address) AND h.balance > 0
  LEFT JOIN chain.freezes f ON f.token = h.token AND f.holder = h.holder
  WHERE i.id = papi.token_investor(p_access_hash)
  ORDER BY h.token
$$;

/** The read-model head the figures are from. */
CREATE FUNCTION papi.status() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, papi AS $$
  SELECT jsonb_build_object(
    'as_of_block', (SELECT max(c.block_number)::text FROM chain.cursors c),
    'indexed_at', (SELECT max(b.block_time) FROM chain.blocks b WHERE b.number = (SELECT max(c.block_number) FROM chain.cursors c)),
    'reconciliation', (SELECT jsonb_build_object('status', r.status, 'finished_at', r.finished_at)
                       FROM recon.runs r WHERE r.status IN ('passed', 'failed') ORDER BY r.id DESC LIMIT 1))
$$;

CREATE FUNCTION papi.offerings(p_offering uuid) RETURNS TABLE (
  id uuid, state text, token text, building text, province text, district text, property_use text, price_paisa bigint,
  hard_cap_units bigint, min_raise_units bigint, min_units bigint, max_units bigint, paid_units bigint, available_units bigint,
  opens_at timestamptz, closes_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, papi AS $$
  SELECT w.offering_id, w.state, w.token, p.building, w.province, w.district, w.property_use, w.price_paisa,
         w.hard_cap_units, w.min_raise_units, w.min_units, w.max_units, w.paid_units, w.available_units, w.opens_at, w.closes_at
  FROM offering.web_offerings(p_offering) w
  JOIN offering.offerings o ON o.id = w.offering_id
  JOIN property.properties p ON p.id = o.property_id
$$;

CREATE FUNCTION papi.subscriptions(p_access_hash bytea) RETURNS TABLE (id uuid, offering_id uuid, units bigint, amount_paisa bigint, status text, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, papi AS $$
  SELECT s.subscription_id, s.offering_id, s.units, s.amount_paisa, s.state, s.created_at
  FROM offering.web_subscriptions(papi.subject(p_access_hash)) s
$$;

CREATE FUNCTION papi.tax_certificates(p_access_hash bytea) RETURNS TABLE (id bigint, fiscal_year integer, issued_at timestamptz, sha256 text, superseded_by bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, papi AS $$
  SELECT c.id, c.fiscal_year, c.issued_at, encode(c.content_sha256, 'hex'), (SELECT n.id FROM tax.certificates n WHERE n.supersedes = c.id)
  FROM tax.certificates c WHERE c.subject_id = papi.subject(p_access_hash)
  ORDER BY c.fiscal_year DESC, c.id DESC LIMIT 100
$$;

/** The inbox with the e-mail template in the locale (the API renders it with @pt/notify), newest first, keyset by id. */
CREATE FUNCTION papi.notifications(p_access_hash bytea, p_locale text, p_before bigint, p_limit integer)
RETURNS TABLE (id bigint, kind text, params jsonb, created_at timestamptz, read boolean, subject text, body text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, papi AS $$
  SELECT n.id, n.kind, n.params, n.created_at, x.read_at IS NOT NULL, t.subject, t.body
  FROM notify.recipients rc
  JOIN notify.notifications n ON n.recipient_id = rc.id
  LEFT JOIN notify.inbox_reads x ON x.notification_id = n.id
  LEFT JOIN notify.templates t ON t.id = notify.current_template(n.kind, 'email', CASE WHEN p_locale = 'ur' THEN 'ur' ELSE 'en' END)
  WHERE rc.subject_type = 'investor' AND rc.subject_id = papi.subject(p_access_hash)::text
    AND NOT (n.category = 'marketing' AND n.status = 'suppressed')
    AND (p_before IS NULL OR n.id < p_before)
  ORDER BY n.id DESC
  LIMIT least(greatest(coalesce(p_limit, 20), 1), 100)
$$;

-- ================================================================== PA-5 privileges
REVOKE ALL ON ALL TABLES IN SCHEMA papi FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA papi FROM PUBLIC;
GRANT USAGE ON SCHEMA papi TO pt_svc_public_api, pt_web;
GRANT EXECUTE ON FUNCTION
  papi.device_authorize(bytea, text, text, text), papi.device_token(bytea, bytea, bytea), papi.refresh(bytea, bytea, bytea), papi.revoke(bytea),
  papi.token_investor(bytea), papi.me(bytea), papi.holdings(bytea), papi.status(), papi.offerings(uuid), papi.subscriptions(bytea),
  papi.tax_certificates(bytea), papi.notifications(bytea, text, bigint, integer)
TO pt_svc_public_api;
GRANT EXECUTE ON FUNCTION papi.web_device_lookup(bytea, text), papi.web_device_decide(bytea, text, text), papi.web_devices(bytea), papi.web_device_remove(bytea, uuid)
TO pt_web;

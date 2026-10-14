-- Investor passkeys and database-enforced website sessions (task T-030, ADR 0010 section 8).
--
-- Numbered 0024: 0020-0023 are reserved for parallel branches. Merge those first; until then the
-- runner refuses the gap (tests use contiguousMigrations()).
--
-- Safety properties enforced by the database itself (rule IDs IP-n):
--   IP-1  Sessions. The cookie holds a random 256-bit token; only its SHA-256 is stored here. 30
--         minutes idle and 12 hours absolute (NIST SP 800-63B AAL2 reauthentication limits), checked
--         here on every use; at most 10 live sessions per investor (the oldest is superseded);
--         logout ends a session; revoking a passkey ends the other sessions signed in with it.
--         Sessions are never deleted; only last use and passkey time move forward, ending happens once.
--   IP-2  A session starts only through a function: by passkey (webauth.web_login, after a consumed
--         login challenge and a verified assertion with user verification and a counter that moved
--         forward), or through the two demo paths the website still offers: `persona` (only for the
--         shared demo investors, which have a persona) and `signup` (only within 30 minutes of the
--         investor record's creation).
--   IP-3  WebAuthn challenges: single use, at most 5 minutes, bound to their purpose and (registration,
--         step-up) to the session. Consumed BEFORE the response is verified, so a failed attempt
--         cannot be retried with it; a session, passkey or step-up is recorded only against a
--         challenge consumed less than 5 minutes earlier and only once (completed_at). At most 5
--         open challenges per session and 10,000 open sign-in challenges overall.
--   IP-4  Passkeys. User verification is required at registration and at every use. A credential
--         ID belongs to one investor only; at most 10 active passkeys per investor; never deleted,
--         only revoked (once); the signature counter only moves forward. Clone detection (WebAuthn
--         6.1.1): a counter that does not increase (other than both zero, as synced passkeys report)
--         revokes the passkey (`clone_suspected`), ends its sessions, is audited and raised on
--         pg_notify channel `webauth_alert`.
--   IP-5  Re-authentication to manage passkeys. Registering a passkey needs, for an investor who
--         already has one, a passkey assertion on this session within 5 minutes; for an investor
--         without one, a session at most 10 minutes old. Revoking needs a passkey within 5 minutes.
--   IP-6  Step-up for sensitive actions (`requireRecentPasskey`): webauth.step_up_actions lists the
--         actions and their amount thresholds (offering.cancel always, offering.reserve from
--         PKR 100,000, bank.payout_account always); an action not in the list always needs a step-up
--         (deny by default). An investor with a passkey needs an assertion on this session within 5
--         minutes. An investor without one is refused when webauth.settings.require_passkey is on;
--         while it is off (plain-HTTP demo server: passkeys cannot work there), the action is
--         allowed and audited as `stepup.waived`.
--   IP-7  Rate limits. After 10 failed passkey ceremonies of one investor within 15 minutes, further
--         sign-in, registration and step-up for that investor are refused until the window passes
--         (audited). The website adds per-address and per-investor token buckets in front.
--   IP-8  Audit. Every session start/end, passkey registration/revocation, success, failure,
--         counter regression, refusal, waiver and settings change is written to an append-only,
--         hash-chained webauth.audit (UTC timestamps inside the digest, finding F-04).
--         webauth.verify_audit() re-checks the chain and finds passkeys and sessions written around
--         the API.
--   IP-9  Least privilege. pt_web (the website) may EXECUTE the webauth.web_* functions and nothing
--         else in this schema (no table, no internal function). It LOSES EXECUTE on
--         offering.web_reserve and offering.web_cancel (migration 0018): the website reserves and
--         cancels through webauth.web_reserve / webauth.web_cancel, which take the session, derive
--         the investor and its KYC subject from it (binding the `web:<id>` actor to the subject, a
--         T-044 follow-up) and apply IP-6 before calling the S-02 functions.

CREATE SCHEMA IF NOT EXISTS webauth;
REVOKE ALL ON SCHEMA webauth FROM PUBLIC;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pt_web') THEN CREATE ROLE pt_web NOLOGIN; END IF;
END $$;

-- ================================================================== helpers and limits
CREATE FUNCTION webauth.forbid_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'webauth.% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE FUNCTION webauth.utc(p timestamptz) RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT to_char(p AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
$$;

/** First 16 hex characters of a token hash: enough to correlate audit rows, useless as a credential. */
CREATE FUNCTION webauth.short(p bytea) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$ SELECT left(encode(p, 'hex'), 16) $$;

CREATE FUNCTION webauth.idle_limit() RETURNS interval LANGUAGE sql IMMUTABLE AS $$ SELECT interval '30 minutes' $$;
CREATE FUNCTION webauth.absolute_limit() RETURNS interval LANGUAGE sql IMMUTABLE AS $$ SELECT interval '12 hours' $$;
CREATE FUNCTION webauth.step_up_window() RETURNS interval LANGUAGE sql IMMUTABLE AS $$ SELECT interval '5 minutes' $$;
CREATE FUNCTION webauth.fresh_session_window() RETURNS interval LANGUAGE sql IMMUTABLE AS $$ SELECT interval '10 minutes' $$;
CREATE FUNCTION webauth.signup_window() RETURNS interval LANGUAGE sql IMMUTABLE AS $$ SELECT interval '30 minutes' $$;
CREATE FUNCTION webauth.challenge_lifetime() RETURNS interval LANGUAGE sql IMMUTABLE AS $$ SELECT interval '5 minutes' $$;
CREATE FUNCTION webauth.failure_window() RETURNS interval LANGUAGE sql IMMUTABLE AS $$ SELECT interval '15 minutes' $$;
CREATE FUNCTION webauth.max_failures() RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT 10 $$;
CREATE FUNCTION webauth.max_live_sessions() RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT 10 $$;
CREATE FUNCTION webauth.max_passkeys() RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT 10 $$;

/**
 * A passkey's label as the investor typed it: 1-40 characters, no control or markup characters, no
 * run of 6 or more digits (keeps CNIC and phone numbers out), no leading or trailing space.
 */
CREATE FUNCTION webauth.name_ok(p text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT p IS NOT NULL AND char_length(p) BETWEEN 1 AND 40 AND p = btrim(p)
     AND p !~ '[[:cntrl:]<>"`\\{}]' AND p !~ '[0-9]{6}'
$$;

-- ================================================================== audit (IP-8)
CREATE TABLE webauth.audit (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at        timestamptz NOT NULL,
  actor     text NOT NULL CHECK (length(actor) BETWEEN 1 AND 100),
  action    text NOT NULL CHECK (action ~ '^[a-z][a-z_.]{2,63}$'),
  detail    jsonb NOT NULL CHECK (jsonb_typeof(detail) = 'object' AND octet_length(detail::text) <= 4096),
  prev_hash bytea NOT NULL CHECK (length(prev_hash) = 32),
  hash      bytea NOT NULL UNIQUE CHECK (length(hash) = 32)
);
-- Failure counting per investor (IP-7) reads the newest rows of one actor.
CREATE INDEX audit_actor_at_idx ON webauth.audit (actor, at);
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON webauth.audit FOR EACH ROW EXECUTE FUNCTION webauth.forbid_change();
CREATE TRIGGER audit_no_truncate BEFORE TRUNCATE ON webauth.audit FOR EACH STATEMENT EXECUTE FUNCTION webauth.forbid_change();

CREATE FUNCTION webauth.audit_digest(p_prev bytea, p_id bigint, p_at timestamptz, p_actor text, p_action text, p_detail jsonb)
RETURNS bytea LANGUAGE sql STABLE SET search_path = pg_catalog, webauth AS $$
  SELECT sha256(p_prev || convert_to('pt-webauth-audit-v1' || jsonb_build_array(p_id, webauth.utc(p_at), p_actor, p_action, p_detail)::text, 'UTF8'))
$$;

/** Internal: appends one entry. Granted to nobody; the API functions call it. */
CREATE FUNCTION webauth.audit_append(p_actor text, p_action text, p_detail jsonb)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, webauth AS $$
DECLARE
  v_prev bytea;
  v_id bigint;
  v_at timestamptz := date_trunc('microseconds', clock_timestamp());
  v_actor text := left(coalesce(p_actor, 'anonymous'), 100);
  v_detail jsonb := coalesce(p_detail, '{}'::jsonb);
BEGIN
  PERFORM pg_advisory_xact_lock(586586240);
  SELECT hash INTO v_prev FROM webauth.audit ORDER BY id DESC LIMIT 1;
  v_prev := coalesce(v_prev, decode(repeat('00', 32), 'hex'));
  v_id := nextval(pg_get_serial_sequence('webauth.audit', 'id'));
  INSERT INTO webauth.audit (id, at, actor, action, detail, prev_hash, hash)
  OVERRIDING SYSTEM VALUE
  VALUES (v_id, v_at, v_actor, p_action, v_detail, v_prev, webauth.audit_digest(v_prev, v_id, v_at, v_actor, p_action, v_detail));
  RETURN v_id;
END $$;

CREATE FUNCTION webauth.actor(p_investor uuid) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$ SELECT CASE WHEN p_investor IS NULL THEN 'anonymous' ELSE 'web:' || p_investor::text END $$;

-- ================================================================== settings and step-up actions (IP-6)
/**
 * One row. Changed only by the database administrator (owner action), never by the website; every
 * change is audited. require_passkey stays off while the demo server runs on plain HTTP by IP
 * address (passkeys cannot work there); turn it on once the domain and TLS are live.
 */
CREATE TABLE webauth.settings (
  id              boolean PRIMARY KEY DEFAULT true CHECK (id),
  require_passkey boolean NOT NULL DEFAULT false,
  updated_at      timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp())
);
INSERT INTO webauth.settings DEFAULT VALUES;

/** Sensitive investor actions and the amount (paisa) from which each needs a passkey step-up. */
CREATE TABLE webauth.step_up_actions (
  action           text PRIMARY KEY CHECK (action ~ '^[a-z][a-z_]{1,30}\.[a-z][a-z_]{1,30}$'),
  min_amount_paisa numeric(30, 0) NOT NULL DEFAULT 0 CHECK (min_amount_paisa >= 0),
  note             text NOT NULL CHECK (length(note) BETWEEN 1 AND 200)
);
INSERT INTO webauth.step_up_actions (action, min_amount_paisa, note) VALUES
  ('offering.reserve', 10000000, 'Reserving units worth PKR 100,000 or more (owner to confirm the threshold)'),
  ('offering.cancel', 0, 'Cancelling a reservation or a queue place'),
  ('bank.payout_account', 0, 'Adding or changing the payout bank account (no website screen yet)');

CREATE FUNCTION webauth.audit_settings() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, webauth AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'webauth.%: rows are never deleted (set them instead)', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM webauth.audit_append('db:' || session_user, 'settings.changed',
    jsonb_build_object('table', TG_TABLE_NAME, 'op', TG_OP, 'old', CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) END, 'new', to_jsonb(NEW)));
  RETURN NEW;
END $$;
CREATE TRIGGER settings_audit BEFORE INSERT OR UPDATE OR DELETE ON webauth.settings FOR EACH ROW EXECUTE FUNCTION webauth.audit_settings();
CREATE TRIGGER step_up_actions_audit BEFORE INSERT OR UPDATE OR DELETE ON webauth.step_up_actions FOR EACH ROW EXECUTE FUNCTION webauth.audit_settings();
CREATE TRIGGER settings_no_truncate BEFORE TRUNCATE ON webauth.settings FOR EACH STATEMENT EXECUTE FUNCTION webauth.forbid_change();
CREATE TRIGGER step_up_actions_no_truncate BEFORE TRUNCATE ON webauth.step_up_actions FOR EACH STATEMENT EXECUTE FUNCTION webauth.forbid_change();

-- ================================================================== passkeys (IP-4)
CREATE TABLE webauth.passkeys (
  id             text PRIMARY KEY CHECK (length(id) BETWEEN 16 AND 1366 AND id ~ '^[A-Za-z0-9_-]+$'),
  -- The handle the website shows and revokes by: the credential ID itself never leaves the server in a listing.
  ref            uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  investor_id    uuid NOT NULL REFERENCES webdemo.investors (id),
  name           text NOT NULL CHECK (webauth.name_ok(name)),
  public_key     bytea NOT NULL CHECK (length(public_key) BETWEEN 16 AND 2048),
  counter        bigint NOT NULL CHECK (counter >= 0),
  transports     text[] NOT NULL DEFAULT '{}' CHECK (cardinality(transports) <= 8),
  aaguid         uuid NOT NULL,
  fmt            text NOT NULL CHECK (fmt ~ '^[a-z][a-z0-9-]{1,31}$'),
  -- NIST SP 800-63B (2024 supplement): synced passkeys are acceptable at AAL2 for investors.
  device_type    text NOT NULL CHECK (device_type IN ('singleDevice', 'multiDevice')),
  backed_up      boolean NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  last_used_at   timestamptz,
  revoked_at     timestamptz,
  revoked_reason text CHECK (revoked_reason IN ('investor', 'clone_suspected')),
  CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL)),
  CHECK (device_type = 'multiDevice' OR NOT backed_up)
);
CREATE INDEX passkeys_investor_idx ON webauth.passkeys (investor_id) WHERE revoked_at IS NULL;

CREATE FUNCTION webauth.guard_passkey() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'passkeys are never deleted (revoke them)' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF (NEW.id, NEW.ref, NEW.investor_id, NEW.name, NEW.public_key, NEW.transports, NEW.aaguid, NEW.fmt, NEW.device_type, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.ref, OLD.investor_id, OLD.name, OLD.public_key, OLD.transports, OLD.aaguid, OLD.fmt, OLD.device_type, OLD.created_at)
     OR NEW.counter < OLD.counter
     OR (OLD.revoked_at IS NOT NULL AND (NEW.revoked_at, NEW.revoked_reason) IS DISTINCT FROM (OLD.revoked_at, OLD.revoked_reason)) THEN
    RAISE EXCEPTION 'passkey %: only the counter (forward), backup state, last use and revoking (once) may change', left(OLD.id, 12)
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER passkeys_guard BEFORE UPDATE OR DELETE ON webauth.passkeys FOR EACH ROW EXECUTE FUNCTION webauth.guard_passkey();
CREATE TRIGGER passkeys_no_truncate BEFORE TRUNCATE ON webauth.passkeys FOR EACH STATEMENT EXECUTE FUNCTION webauth.forbid_change();

-- ================================================================== sessions (IP-1, IP-2)
CREATE TABLE webauth.sessions (
  token_hash         bytea PRIMARY KEY CHECK (length(token_hash) = 32),
  investor_id        uuid NOT NULL REFERENCES webdemo.investors (id),
  method             text NOT NULL CHECK (method IN ('passkey', 'persona', 'signup')),
  credential_id      text REFERENCES webauth.passkeys (id),
  -- Set from one clock reading by webauth.start_session (two defaults would differ by microseconds).
  created_at         timestamptz NOT NULL,
  last_seen_at       timestamptz NOT NULL,
  expires_at         timestamptz NOT NULL,
  passkey_at         timestamptz,
  passkey_credential text REFERENCES webauth.passkeys (id),
  ended_at           timestamptz,
  end_reason         text CHECK (end_reason IN ('logout', 'idle', 'absolute', 'superseded', 'passkey_revoked')),
  CHECK (expires_at = created_at + interval '12 hours'),
  CHECK (last_seen_at >= created_at),
  CHECK ((method = 'passkey') = (credential_id IS NOT NULL)),
  CHECK ((ended_at IS NULL) = (end_reason IS NULL)),
  CHECK ((passkey_at IS NULL) = (passkey_credential IS NULL))
);
CREATE INDEX sessions_investor_live_idx ON webauth.sessions (investor_id, created_at) WHERE ended_at IS NULL;

CREATE FUNCTION webauth.guard_session() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'sessions are never deleted' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF OLD.ended_at IS NOT NULL
     OR (NEW.token_hash, NEW.investor_id, NEW.method, NEW.credential_id, NEW.created_at, NEW.expires_at)
        IS DISTINCT FROM (OLD.token_hash, OLD.investor_id, OLD.method, OLD.credential_id, OLD.created_at, OLD.expires_at)
     OR NEW.last_seen_at < OLD.last_seen_at
     OR (OLD.passkey_at IS NOT NULL AND (NEW.passkey_at IS NULL OR NEW.passkey_at < OLD.passkey_at)) THEN
    RAISE EXCEPTION 'session: only last use, passkey time (forward) and ending (once) may change' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sessions_guard BEFORE UPDATE OR DELETE ON webauth.sessions FOR EACH ROW EXECUTE FUNCTION webauth.guard_session();
CREATE TRIGGER sessions_no_truncate BEFORE TRUNCATE ON webauth.sessions FOR EACH STATEMENT EXECUTE FUNCTION webauth.forbid_change();

-- ================================================================== WebAuthn challenges (IP-3)
CREATE TABLE webauth.challenges (
  id_hash      bytea PRIMARY KEY CHECK (length(id_hash) = 32),
  purpose      text NOT NULL CHECK (purpose IN ('register', 'login', 'step_up')),
  challenge    text NOT NULL CHECK (challenge ~ '^[A-Za-z0-9_-]{32,128}$'),
  session_hash bytea REFERENCES webauth.sessions (token_hash),
  created_at   timestamptz NOT NULL,
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz,
  completed_at timestamptz,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '5 minutes'),
  CHECK ((purpose = 'login') = (session_hash IS NULL)),
  CHECK (completed_at IS NULL OR (used_at IS NOT NULL AND completed_at >= used_at))
);
CREATE INDEX challenges_expiry_idx ON webauth.challenges (expires_at);
CREATE INDEX challenges_session_idx ON webauth.challenges (session_hash) WHERE session_hash IS NOT NULL;

-- ================================================================== internal checks
/** Internal: failed passkey ceremonies of an investor in the current window (IP-7). */
CREATE FUNCTION webauth.recent_failures(p_investor uuid) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, webauth AS $$
  SELECT count(*) FROM webauth.audit
  WHERE actor = webauth.actor(p_investor) AND at > clock_timestamp() - webauth.failure_window()
    AND action IN ('login.failed', 'register.failed', 'stepup.failed', 'login.counter_regression', 'stepup.counter_regression')
$$;

CREATE FUNCTION webauth.locked(p_investor uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, webauth AS $$
  SELECT p_investor IS NOT NULL AND webauth.recent_failures(p_investor) >= webauth.max_failures()
$$;

CREATE FUNCTION webauth.has_passkey(p_investor uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, webauth AS $$
  SELECT EXISTS (SELECT 1 FROM webauth.passkeys WHERE investor_id = p_investor AND revoked_at IS NULL)
$$;

/**
 * Internal: the live session for a token hash, locked for this transaction, or NULL. Ends (and
 * audits) a session that passed its idle or absolute limit (IP-1).
 */
CREATE FUNCTION webauth.live_session(p_session bytea) RETURNS webauth.sessions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, webauth AS $$
DECLARE
  s webauth.sessions;
  v_now timestamptz := date_trunc('microseconds', clock_timestamp());
  v_reason text;
BEGIN
  IF p_session IS NULL OR length(p_session) <> 32 THEN RETURN NULL; END IF;
  SELECT * INTO s FROM webauth.sessions WHERE token_hash = p_session FOR UPDATE;
  IF NOT FOUND OR s.ended_at IS NOT NULL THEN RETURN NULL; END IF;
  IF v_now >= s.expires_at THEN v_reason := 'absolute';
  ELSIF v_now >= s.last_seen_at + webauth.idle_limit() THEN v_reason := 'idle';
  END IF;
  IF v_reason IS NOT NULL THEN
    UPDATE webauth.sessions SET ended_at = v_now, end_reason = v_reason WHERE token_hash = p_session;
    PERFORM webauth.audit_append(webauth.actor(s.investor_id), 'session.expired', jsonb_build_object('session', webauth.short(p_session), 'reason', v_reason));
    RETURN NULL;
  END IF;
  RETURN s;
END $$;

/** Internal: records activity (at most every 15 seconds, to keep page views cheap). */
CREATE FUNCTION webauth.touch(s webauth.sessions) RETURNS webauth.sessions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, webauth AS $$
DECLARE
  v_now timestamptz := date_trunc('microseconds', clock_timestamp());
  r webauth.sessions;
BEGIN
  IF s.last_seen_at > v_now - interval '15 seconds' THEN RETURN s; END IF;
  UPDATE webauth.sessions SET last_seen_at = greatest(last_seen_at, v_now) WHERE token_hash = s.token_hash RETURNING * INTO r;
  RETURN r;
END $$;

/** Internal: ends live sessions of an investor beyond the cap, oldest first, so one more fits. */
CREATE FUNCTION webauth.make_room(p_investor uuid, p_at timestamptz) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, webauth AS $$
DECLARE
  n integer;
BEGIN
  WITH old AS (
    SELECT token_hash FROM webauth.sessions WHERE investor_id = p_investor AND ended_at IS NULL
    ORDER BY created_at DESC OFFSET webauth.max_live_sessions() - 1
  )
  UPDATE webauth.sessions s SET ended_at = p_at, end_reason = 'superseded' FROM old WHERE s.token_hash = old.token_hash;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

/** Internal: inserts a session (callers checked everything) and audits it. */
CREATE FUNCTION webauth.start_session(p_token_hash bytea, p_investor uuid, p_method text, p_credential text)
RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, webauth AS $$
DECLARE
  v_now timestamptz := date_trunc('microseconds', clock_timestamp());
  n integer;
BEGIN
  -- Serialise starts per investor so the live-session cap holds under concurrency.
  PERFORM 1 FROM webdemo.investors WHERE id = p_investor FOR UPDATE;
  n := webauth.make_room(p_investor, v_now);
  INSERT INTO webauth.sessions (token_hash, investor_id, method, credential_id, created_at, last_seen_at, expires_at, passkey_at, passkey_credential)
  VALUES (p_token_hash, p_investor, p_method, p_credential, v_now, v_now, v_now + webauth.absolute_limit(),
          CASE WHEN p_method = 'passkey' THEN v_now END, p_credential);
  PERFORM webauth.audit_append(webauth.actor(p_investor), 'session.started', jsonb_build_object(
    'session', webauth.short(p_token_hash), 'method', p_method, 'passkey', (SELECT ref FROM webauth.passkeys WHERE id = p_credential), 'superseded', n));
  RETURN v_now + webauth.absolute_limit();
END $$;

/**
 * Internal: marks a challenge consumed less than 5 minutes ago as completed (once). Every function
 * that records a WebAuthn result calls this first, so nothing is recorded without a real ceremony.
 */
CREATE FUNCTION webauth.complete_challenge(p_id_hash bytea, p_purpose text, p_session bytea) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, webauth AS $$
DECLARE
  n integer;
BEGIN
  UPDATE webauth.challenges SET completed_at = clock_timestamp()
  WHERE id_hash = p_id_hash AND purpose = p_purpose AND used_at IS NOT NULL AND completed_at IS NULL
    AND used_at > clock_timestamp() - webauth.challenge_lifetime()
    AND session_hash IS NOT DISTINCT FROM CASE WHEN p_purpose = 'login' THEN NULL ELSE p_session END;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n = 1;
END $$;

/**
 * Internal: moves a passkey's signature counter forward (IP-4) and records its use. Returns the
 * investor, or NULL (audited) for a revoked or unknown passkey or a counter that did not increase,
 * which revokes the passkey as possibly cloned, ends its sessions and raises an alert.
 */
CREATE FUNCTION webauth.use_passkey(p_credential_id text, p_new_counter bigint, p_backed_up boolean, p_kind text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, webauth AS $$
DECLARE
  c webauth.passkeys;
  v_now timestamptz := date_trunc('microseconds', clock_timestamp());
BEGIN
  SELECT * INTO c FROM webauth.passkeys WHERE id = p_credential_id FOR UPDATE;
  IF NOT FOUND OR c.revoked_at IS NOT NULL THEN
    PERFORM webauth.audit_append(webauth.actor(c.investor_id), p_kind || '.failed', jsonb_build_object('reason', 'passkey unknown or revoked'));
    RETURN NULL;
  END IF;
  IF p_new_counter IS NULL OR NOT (p_new_counter > c.counter OR (p_new_counter = 0 AND c.counter = 0)) THEN
    UPDATE webauth.passkeys SET revoked_at = v_now, revoked_reason = 'clone_suspected' WHERE id = c.id;
    UPDATE webauth.sessions SET ended_at = v_now, end_reason = 'passkey_revoked'
    WHERE ended_at IS NULL AND (credential_id = c.id OR passkey_credential = c.id);
    PERFORM webauth.audit_append(webauth.actor(c.investor_id), p_kind || '.counter_regression',
      jsonb_build_object('passkey', c.ref, 'stored', c.counter, 'presented', p_new_counter));
    PERFORM pg_notify('webauth_alert', json_build_object('alert', 'counter_regression', 'investor', c.investor_id, 'passkey', c.ref)::text);
    RETURN NULL;
  END IF;
  UPDATE webauth.passkeys SET counter = p_new_counter, last_used_at = v_now, backed_up = backed_up OR coalesce(p_backed_up, false) AND device_type = 'multiDevice'
  WHERE id = c.id;
  RETURN c.investor_id;
END $$;

/**
 * Internal (IP-6): whether p_action for p_amount_paisa may run on this live session now. Returns
 * 'ok', 'waived' (sensitive, investor has no passkey, passkeys not yet required), 'step_up' (a
 * passkey assertion within 5 minutes is needed) or 'enrol' (a passkey is required but none exists).
 */
CREATE FUNCTION webauth.step_up_decision(s webauth.sessions, p_action text, p_amount_paisa numeric) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, webauth AS $$
DECLARE
  v_min numeric;
BEGIN
  SELECT min_amount_paisa INTO v_min FROM webauth.step_up_actions WHERE action = p_action;
  -- Deny by default: an action not in the list always needs a step-up.
  IF FOUND AND coalesce(p_amount_paisa, 0) < v_min THEN RETURN 'ok'; END IF;
  IF webauth.has_passkey(s.investor_id) THEN
    IF s.passkey_at IS NOT NULL AND clock_timestamp() < s.passkey_at + webauth.step_up_window()
       AND EXISTS (SELECT 1 FROM webauth.passkeys WHERE id = s.passkey_credential AND revoked_at IS NULL) THEN
      RETURN 'ok';
    END IF;
    RETURN 'step_up';
  END IF;
  IF (SELECT require_passkey FROM webauth.settings) THEN RETURN 'enrol'; END IF;
  RETURN 'waived';
END $$;

/**
 * Internal (IP-6), for the SQL wrappers of sensitive actions: the decision for a session (or
 * 'session' without a valid one), audited when the action is refused or waived.
 */
CREATE FUNCTION webauth.gate(p_session bytea, p_action text, p_amount_paisa numeric, OUT investor_id uuid, OUT decision text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, webauth AS $$
DECLARE
  s webauth.sessions := webauth.live_session(p_session);
BEGIN
  IF s.token_hash IS NULL THEN decision := 'session'; RETURN; END IF;
  s := webauth.touch(s);
  investor_id := s.investor_id;
  decision := webauth.step_up_decision(s, p_action, p_amount_paisa);
  IF decision IN ('step_up', 'enrol') THEN
    PERFORM webauth.audit_append(webauth.actor(s.investor_id), 'stepup.required',
      jsonb_build_object('session', webauth.short(p_session), 'action', p_action, 'amountPaisa', p_amount_paisa, 'decision', decision));
  ELSIF decision = 'waived' THEN
    PERFORM webauth.audit_append(webauth.actor(s.investor_id), 'stepup.waived',
      jsonb_build_object('session', webauth.short(p_session), 'action', p_action, 'amountPaisa', p_amount_paisa, 'reason', 'no passkey; passkeys not yet required'));
  END IF;
END $$;

-- ================================================================== website API: sessions (IP-1, IP-2)
/**
 * The website calls this once per request: validates the session (ending it at a limit), records
 * activity, and returns who is signed in. No row = not signed in.
 */
CREATE FUNCTION webauth.web_session(p_session bytea)
RETURNS TABLE (investor_id uuid, method text, created_at timestamptz, expires_at timestamptz, idle_until timestamptz,
               passkey_at timestamptz, has_passkey boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, webauth AS $$
DECLARE
  s webauth.sessions := webauth.live_session(p_session);
BEGIN
  IF s.token_hash IS NULL THEN RETURN; END IF;
  s := webauth.touch(s);
  RETURN QUERY SELECT s.investor_id, s.method, s.created_at, s.expires_at, s.last_seen_at + webauth.idle_limit(), s.passkey_at, webauth.has_passkey(s.investor_id);
END $$;

/**
 * Starts a session through the demo paths (IP-2): `persona` only for an investor with a persona,
 * `signup` only within 30 minutes of the investor's creation. Returns the absolute expiry, or NULL
 * (audited) when refused.
 */
CREATE FUNCTION webauth.web_start_session(p_token_hash bytea, p_investor uuid, p_method text) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, webauth AS $$
DECLARE
  i webdemo.investors;
BEGIN
  IF p_token_hash IS NULL OR length(p_token_hash) <> 32 THEN RAISE EXCEPTION 'session token hash must be 32 bytes' USING ERRCODE = '22023'; END IF;
  SELECT * INTO i FROM webdemo.investors WHERE id = p_investor;
  IF NOT FOUND
     OR p_method IS NULL
     OR (p_method = 'persona' AND i.persona IS NULL)
     OR (p_method = 'signup' AND i.created_at <= clock_timestamp() - webauth.signup_window())
     OR p_method NOT IN ('persona', 'signup') THEN
    PERFORM webauth.audit_append(webauth.actor(i.id), 'session.refused', jsonb_build_object('method', left(coalesce(p_method, ''), 20)));
    RETURN NULL;
  END IF;
  RETURN webauth.start_session(p_token_hash, i.id, p_method, NULL);
END $$;

CREATE FUNCTION webauth.web_end_session(p_session bytea) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, webauth AS $$
DECLARE
  s webauth.sessions;
BEGIN
  SELECT * INTO s FROM webauth.sessions WHERE token_hash = p_session FOR UPDATE;
  IF NOT FOUND OR s.ended_at IS NOT NULL THEN RETURN false; END IF;
  UPDATE webauth.sessions SET ended_at = date_trunc('microseconds', clock_timestamp()), end_reason = 'logout' WHERE token_hash = p_session;
  PERFORM webauth.audit_append(webauth.actor(s.investor_id), 'logout', jsonb_build_object('session', webauth.short(p_session)));
  RETURN true;
END $$;

-- ================================================================== website API: ceremonies (IP-3, IP-5, IP-7)
/**
 * Stores a challenge. Returns 'ok', or why not: 'session' (no valid session), 'reauth' (IP-5),
 * 'limit' (10 passkeys), 'none' (step-up without a passkey), 'locked' (IP-7), 'busy' (IP-3 caps).
 */
CREATE FUNCTION webauth.web_create_challenge(p_id_hash bytea, p_purpose text, p_challenge text, p_session bytea) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, webauth AS $$
DECLARE
  v_now timestamptz := date_trunc('microseconds', clock_timestamp());
  s webauth.sessions;
  v_has boolean;
BEGIN
  IF p_purpose IS NULL OR p_purpose NOT IN ('register', 'login', 'step_up') THEN RAISE EXCEPTION 'unknown ceremony' USING ERRCODE = '22023'; END IF;
  -- Housekeeping: challenges are short-lived and carry nothing worth keeping.
  DELETE FROM webauth.challenges WHERE expires_at < v_now - interval '1 day';
  IF p_purpose = 'login' THEN
    IF (SELECT count(*) FROM webauth.challenges WHERE purpose = 'login' AND used_at IS NULL AND expires_at > v_now) >= 10000 THEN
      RETURN 'busy';
    END IF;
  ELSE
    s := webauth.live_session(p_session);
    IF s.token_hash IS NULL THEN RETURN 'session'; END IF;
    IF webauth.locked(s.investor_id) THEN
      PERFORM webauth.audit_append(webauth.actor(s.investor_id), 'ceremony.locked', jsonb_build_object('purpose', p_purpose));
      RETURN 'locked';
    END IF;
    IF (SELECT count(*) FROM webauth.challenges WHERE session_hash = p_session AND used_at IS NULL AND expires_at > v_now) >= 5 THEN
      RETURN 'busy';
    END IF;
    v_has := webauth.has_passkey(s.investor_id);
    IF p_purpose = 'step_up' AND NOT v_has THEN RETURN 'none'; END IF;
    IF p_purpose = 'register' THEN
      IF (SELECT count(*) FROM webauth.passkeys WHERE investor_id = s.investor_id AND revoked_at IS NULL) >= webauth.max_passkeys() THEN
        RETURN 'limit';
      END IF;
      IF (v_has AND (s.passkey_at IS NULL OR v_now >= s.passkey_at + webauth.step_up_window()))
         OR (NOT v_has AND v_now >= greatest(s.created_at, coalesce(s.passkey_at, s.created_at)) + webauth.fresh_session_window()) THEN
        PERFORM webauth.audit_append(webauth.actor(s.investor_id), 'register.reauth_required', jsonb_build_object('session', webauth.short(p_session)));
        RETURN 'reauth';
      END IF;
    END IF;
  END IF;
  INSERT INTO webauth.challenges (id_hash, purpose, challenge, session_hash, created_at, expires_at)
  VALUES (p_id_hash, p_purpose, p_challenge, CASE WHEN p_purpose = 'login' THEN NULL ELSE p_session END, v_now, v_now + webauth.challenge_lifetime());
  RETURN 'ok';
END $$;

/** Uses a challenge once: returns it only if it exists, is unused, unexpired and of this purpose and session. */
CREATE FUNCTION webauth.web_consume_challenge(p_id_hash bytea, p_purpose text, p_session bytea) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, webauth AS $$
DECLARE
  v text;
BEGIN
  UPDATE webauth.challenges SET used_at = clock_timestamp()
  WHERE id_hash = p_id_hash AND purpose = p_purpose AND used_at IS NULL AND expires_at > clock_timestamp()
    AND session_hash IS NOT DISTINCT FROM CASE WHEN p_purpose = 'login' THEN NULL ELSE p_session END
  RETURNING challenge INTO v;
  RETURN v;
END $$;

/** Records a failed ceremony (bad signature, wrong origin, unknown passkey...) without personal data. */
CREATE FUNCTION webauth.web_auth_failed(p_kind text, p_reason text, p_credential_id text, p_session bytea) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, webauth AS $$
DECLARE
  v_investor uuid;
  v_ref uuid;
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('login', 'register', 'stepup') THEN RAISE EXCEPTION 'unknown ceremony' USING ERRCODE = '22023'; END IF;
  SELECT investor_id, ref INTO v_investor, v_ref FROM webauth.passkeys WHERE id = p_credential_id;
  IF v_investor IS NULL AND p_session IS NOT NULL THEN
    SELECT investor_id INTO v_investor FROM webauth.sessions WHERE token_hash = p_session;
  END IF;
  PERFORM webauth.audit_append(webauth.actor(v_investor), p_kind || '.failed',
    jsonb_build_object('reason', left(coalesce(p_reason, ''), 200), 'passkey', v_ref));
END $$;

/** The stored public key for an assertion (sign-in or step-up); nothing for a revoked or unknown passkey. */
CREATE FUNCTION webauth.web_credential(p_credential_id text)
RETURNS TABLE (investor_id uuid, public_key bytea, counter bigint, transports text[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, webauth AS $$
  SELECT c.investor_id, c.public_key, c.counter, c.transports FROM webauth.passkeys c WHERE c.id = p_credential_id AND c.revoked_at IS NULL
$$;

/** The session investor's active credentials (allowCredentials for a step-up, excludeCredentials for a registration). */
CREATE FUNCTION webauth.web_session_credentials(p_session bytea)
RETURNS TABLE (id text, transports text[])
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, webauth AS $$
#variable_conflict use_column
DECLARE
  s webauth.sessions := webauth.live_session(p_session);
BEGIN
  IF s.token_hash IS NULL THEN RETURN; END IF;
  RETURN QUERY SELECT c.id, c.transports FROM webauth.passkeys c WHERE c.investor_id = s.investor_id AND c.revoked_at IS NULL ORDER BY c.created_at;
END $$;

/** For the registration options: the user handle and name the authenticator stores. */
CREATE FUNCTION webauth.web_registration_user(p_session bytea)
RETURNS TABLE (investor_id uuid, display_name text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, webauth AS $$
DECLARE
  s webauth.sessions := webauth.live_session(p_session);
BEGIN
  IF s.token_hash IS NULL THEN RETURN; END IF;
  RETURN QUERY SELECT i.id, i.display_name FROM webdemo.investors i WHERE i.id = s.investor_id;
END $$;

/**
 * Stores a verified new passkey (IP-4) after a registration challenge of this session was consumed.
 * Returns 'ok' or why not ('session', 'ceremony', 'uv', 'name', 'duplicate', 'limit'), audited.
 */
CREATE FUNCTION webauth.web_add_passkey(p_challenge bytea, p_session bytea, p_credential_id text, p_public_key bytea, p_counter bigint,
                                        p_transports text[], p_aaguid uuid, p_fmt text, p_device_type text, p_backed_up boolean,
                                        p_user_verified boolean, p_name text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, webauth AS $$
DECLARE
  s webauth.sessions := webauth.live_session(p_session);
  v_ref uuid;
  v_reason text;
BEGIN
  IF s.token_hash IS NULL THEN RETURN 'session'; END IF;
  IF NOT webauth.complete_challenge(p_challenge, 'register', p_session) THEN v_reason := 'ceremony';
  ELSIF NOT coalesce(p_user_verified, false) THEN v_reason := 'uv';
  ELSIF NOT webauth.name_ok(p_name) THEN v_reason := 'name';
  ELSIF EXISTS (SELECT 1 FROM webauth.passkeys WHERE id = p_credential_id) THEN v_reason := 'duplicate';
  ELSIF (SELECT count(*) FROM webauth.passkeys WHERE investor_id = s.investor_id AND revoked_at IS NULL) >= webauth.max_passkeys() THEN v_reason := 'limit';
  END IF;
  IF v_reason IS NOT NULL THEN
    PERFORM webauth.audit_append(webauth.actor(s.investor_id), 'register.failed', jsonb_build_object('reason', v_reason));
    RETURN v_reason;
  END IF;
  INSERT INTO webauth.passkeys (id, investor_id, name, public_key, counter, transports, aaguid, fmt, device_type, backed_up)
  VALUES (p_credential_id, s.investor_id, p_name, p_public_key, p_counter, coalesce(p_transports, '{}'), p_aaguid, p_fmt, p_device_type, p_backed_up)
  RETURNING ref INTO v_ref;
  PERFORM webauth.audit_append(webauth.actor(s.investor_id), 'passkey.registered', jsonb_build_object(
    'passkey', v_ref, 'credentialSha256', encode(sha256(convert_to(p_credential_id, 'UTF8')), 'hex'),
    'publicKeySha256', encode(sha256(p_public_key), 'hex'), 'aaguid', p_aaguid, 'fmt', p_fmt, 'synced', p_device_type = 'multiDevice',
    'session', webauth.short(p_session)));
  RETURN 'ok';
END $$;

/**
 * Starts a session from a verified sign-in assertion (IP-2, IP-4, IP-7). Returns the investor, or
 * NULL (audited) when the ceremony, the passkey, user verification or the counter is not right.
 */
CREATE FUNCTION webauth.web_login(p_challenge bytea, p_token_hash bytea, p_credential_id text, p_new_counter bigint,
                                  p_user_verified boolean, p_backed_up boolean) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, webauth AS $$
DECLARE
  v_investor uuid;
  v_ref uuid;
BEGIN
  IF p_token_hash IS NULL OR length(p_token_hash) <> 32 THEN RAISE EXCEPTION 'session token hash must be 32 bytes' USING ERRCODE = '22023'; END IF;
  SELECT investor_id, ref INTO v_investor, v_ref FROM webauth.passkeys WHERE id = p_credential_id;
  IF NOT webauth.complete_challenge(p_challenge, 'login', NULL) THEN
    PERFORM webauth.audit_append(webauth.actor(v_investor), 'login.failed', jsonb_build_object('reason', 'no matching sign-in ceremony', 'passkey', v_ref));
    RETURN NULL;
  END IF;
  IF NOT coalesce(p_user_verified, false) THEN
    PERFORM webauth.audit_append(webauth.actor(v_investor), 'login.failed', jsonb_build_object('reason', 'user not verified', 'passkey', v_ref));
    RETURN NULL;
  END IF;
  IF webauth.locked(v_investor) THEN
    PERFORM webauth.audit_append(webauth.actor(v_investor), 'login.locked', jsonb_build_object('passkey', v_ref));
    RETURN NULL;
  END IF;
  v_investor := webauth.use_passkey(p_credential_id, p_new_counter, p_backed_up, 'login');
  IF v_investor IS NULL THEN RETURN NULL; END IF;
  PERFORM webauth.start_session(p_token_hash, v_investor, 'passkey', p_credential_id);
  PERFORM webauth.audit_append(webauth.actor(v_investor), 'login.success', jsonb_build_object('session', webauth.short(p_token_hash), 'passkey', v_ref));
  RETURN v_investor;
END $$;

/** Records a verified step-up assertion on the session (the passkey must be the investor's own). Returns its time or NULL (audited). */
CREATE FUNCTION webauth.web_step_up(p_challenge bytea, p_session bytea, p_credential_id text, p_new_counter bigint,
                                    p_user_verified boolean, p_backed_up boolean) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, webauth AS $$
DECLARE
  s webauth.sessions := webauth.live_session(p_session);
  v_now timestamptz := date_trunc('microseconds', clock_timestamp());
  v_reason text;
BEGIN
  IF s.token_hash IS NULL THEN RETURN NULL; END IF;
  IF NOT webauth.complete_challenge(p_challenge, 'step_up', p_session) THEN v_reason := 'no matching step-up ceremony';
  ELSIF NOT coalesce(p_user_verified, false) THEN v_reason := 'user not verified';
  ELSIF NOT EXISTS (SELECT 1 FROM webauth.passkeys WHERE id = p_credential_id AND investor_id = s.investor_id AND revoked_at IS NULL) THEN
    v_reason := 'passkey of another investor, revoked or unknown';
  ELSIF webauth.locked(s.investor_id) THEN
    PERFORM webauth.audit_append(webauth.actor(s.investor_id), 'stepup.locked', jsonb_build_object('session', webauth.short(p_session)));
    RETURN NULL;
  END IF;
  IF v_reason IS NOT NULL THEN
    PERFORM webauth.audit_append(webauth.actor(s.investor_id), 'stepup.failed', jsonb_build_object('reason', v_reason));
    RETURN NULL;
  END IF;
  IF webauth.use_passkey(p_credential_id, p_new_counter, p_backed_up, 'stepup') IS NULL THEN RETURN NULL; END IF;
  UPDATE webauth.sessions SET passkey_at = v_now, passkey_credential = p_credential_id, last_seen_at = greatest(last_seen_at, v_now)
  WHERE token_hash = p_session;
  PERFORM webauth.audit_append(webauth.actor(s.investor_id), 'stepup.success', jsonb_build_object(
    'session', webauth.short(p_session), 'passkey', (SELECT ref FROM webauth.passkeys WHERE id = p_credential_id)));
  RETURN v_now;
END $$;

-- ================================================================== website API: passkey management (IP-4, IP-5)
/** The signed-in investor's active passkeys: label, kind and times only (no credential data). */
CREATE FUNCTION webauth.web_passkeys(p_session bytea)
RETURNS TABLE (ref uuid, name text, synced boolean, created_at timestamptz, last_used_at timestamptz, this_session boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, webauth AS $$
#variable_conflict use_column
DECLARE
  s webauth.sessions := webauth.live_session(p_session);
BEGIN
  IF s.token_hash IS NULL THEN RETURN; END IF;
  RETURN QUERY SELECT c.ref, c.name, c.device_type = 'multiDevice', c.created_at, c.last_used_at,
                      c.id IS NOT DISTINCT FROM s.credential_id OR c.id IS NOT DISTINCT FROM s.passkey_credential
               FROM webauth.passkeys c WHERE c.investor_id = s.investor_id AND c.revoked_at IS NULL ORDER BY c.created_at;
END $$;

/**
 * Revokes one of the investor's passkeys after a passkey step-up within 5 minutes (IP-5) and ends
 * the other sessions signed in or stepped up with it. Returns 'ok', 'session', 'unknown' or 'step_up'.
 */
CREATE FUNCTION webauth.web_revoke_passkey(p_session bytea, p_ref uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, webauth AS $$
DECLARE
  s webauth.sessions := webauth.live_session(p_session);
  c webauth.passkeys;
  v_now timestamptz := date_trunc('microseconds', clock_timestamp());
  n integer;
BEGIN
  IF s.token_hash IS NULL THEN RETURN 'session'; END IF;
  SELECT * INTO c FROM webauth.passkeys WHERE ref = p_ref AND investor_id = s.investor_id AND revoked_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RETURN 'unknown'; END IF;
  IF s.passkey_at IS NULL OR v_now >= s.passkey_at + webauth.step_up_window() THEN
    PERFORM webauth.audit_append(webauth.actor(s.investor_id), 'stepup.required',
      jsonb_build_object('session', webauth.short(p_session), 'action', 'passkey.revoke', 'decision', 'step_up'));
    RETURN 'step_up';
  END IF;
  UPDATE webauth.passkeys SET revoked_at = v_now, revoked_reason = 'investor' WHERE id = c.id;
  UPDATE webauth.sessions SET ended_at = v_now, end_reason = 'passkey_revoked'
  WHERE ended_at IS NULL AND token_hash <> p_session AND (credential_id = c.id OR passkey_credential = c.id);
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM webauth.audit_append(webauth.actor(s.investor_id), 'passkey.revoked', jsonb_build_object(
    'passkey', c.ref, 'session', webauth.short(p_session), 'sessionsEnded', n));
  RETURN 'ok';
END $$;

/**
 * requireRecentPasskey (IP-6) for the website's own message and for actions whose enforcement is
 * still only in the website: 'ok', 'waived', 'step_up', 'enrol' or 'session'. Read-only (no audit).
 */
CREATE FUNCTION webauth.web_step_up_status(p_session bytea, p_action text, p_amount_paisa numeric) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, webauth AS $$
DECLARE
  s webauth.sessions := webauth.live_session(p_session);
BEGIN
  IF s.token_hash IS NULL THEN RETURN 'session'; END IF;
  RETURN webauth.step_up_decision(s, p_action, p_amount_paisa);
END $$;

/**
 * Sensitive actions with their own audited gate (IP-6). An action that adopts the step-up calls
 * this inside its SQL wrapper (see webauth.web_reserve) and continues only on 'ok' or 'waived'.
 */
CREATE FUNCTION webauth.web_require_recent_passkey(p_session bytea, p_action text, p_amount_paisa numeric) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, webauth AS $$
DECLARE
  g record;
BEGIN
  SELECT * INTO g FROM webauth.gate(p_session, p_action, p_amount_paisa);
  RETURN g.decision;
END $$;

-- ================================================================== website API: offering actions behind the gate (IP-6, IP-9)
/**
 * S-02 V2/V3 for the signed-in investor: the investor and KYC subject come from the session (the
 * website can no longer reserve for a subject of its choosing); offering.reserve from PKR 100,000
 * (webauth.step_up_actions) needs a passkey step-up. Returns {"error": "session"|"step_up"|"enrol"}
 * when the gate refuses; otherwise the result of offering.web_reserve (migration 0018), whose
 * errors (KYC gate, limits, documents) are raised unchanged.
 */
CREATE FUNCTION webauth.web_reserve(p_session bytea, p_offering uuid, p_sub uuid, p_ref_id text, p_units bigint, p_idempotency text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, webauth AS $$
DECLARE
  v_price bigint;
  v_subject uuid;
  g record;
BEGIN
  SELECT o.price_paisa INTO v_price FROM offering.offerings o WHERE o.id = p_offering;
  SELECT * INTO g FROM webauth.gate(p_session, 'offering.reserve', coalesce(v_price, 0)::numeric * greatest(coalesce(p_units, 0), 0)::numeric);
  IF g.decision NOT IN ('ok', 'waived') THEN RETURN jsonb_build_object('error', g.decision); END IF;
  SELECT i.kyc_subject INTO v_subject FROM webdemo.investors i WHERE i.id = g.investor_id;
  IF v_subject IS NULL THEN RAISE EXCEPTION 'only a KYC-verified investor can reserve units' USING ERRCODE = '42501'; END IF;
  RETURN offering.web_reserve(p_offering, p_sub, p_ref_id, v_subject, p_units, p_idempotency, webauth.actor(g.investor_id));
END $$;

/** S-02 V11 for the signed-in investor, after a passkey step-up (offering.cancel is always sensitive). */
CREATE FUNCTION webauth.web_cancel(p_session bytea, p_sub uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, webauth AS $$
DECLARE
  v_subject uuid;
  g record;
BEGIN
  SELECT * INTO g FROM webauth.gate(p_session, 'offering.cancel', 0);
  IF g.decision NOT IN ('ok', 'waived') THEN RETURN jsonb_build_object('error', g.decision); END IF;
  SELECT i.kyc_subject INTO v_subject FROM webdemo.investors i WHERE i.id = g.investor_id;
  IF v_subject IS NULL THEN RAISE EXCEPTION 'subscription not found' USING ERRCODE = 'P0002'; END IF;
  RETURN offering.web_cancel(p_sub, v_subject, webauth.actor(g.investor_id));
END $$;

-- ================================================================== verification (IP-8)
CREATE FUNCTION webauth.verify_audit() RETURNS TABLE (audit_id bigint, problem text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, webauth AS $$
DECLARE
  a webauth.audit;
  v_prev bytea := decode(repeat('00', 32), 'hex');
  r record;
BEGIN
  FOR a IN SELECT * FROM webauth.audit ORDER BY id LOOP
    IF a.prev_hash <> v_prev THEN audit_id := a.id; problem := 'prev_hash does not match'; RETURN NEXT; END IF;
    IF a.hash <> webauth.audit_digest(a.prev_hash, a.id, a.at, a.actor, a.action, a.detail) THEN
      audit_id := a.id; problem := 'content does not match its hash'; RETURN NEXT;
    END IF;
    v_prev := a.hash;
  END LOOP;
  -- Rows that exist without the audit entry their API function always writes: written around the API.
  FOR r IN
    SELECT 'passkey ' || c.ref::text AS what FROM webauth.passkeys c WHERE NOT EXISTS (
      SELECT 1 FROM webauth.audit x WHERE x.action = 'passkey.registered' AND x.detail->>'passkey' = c.ref::text
        AND x.actor = webauth.actor(c.investor_id)
        AND x.detail->>'credentialSha256' = encode(sha256(convert_to(c.id, 'UTF8')), 'hex')
        AND x.detail->>'publicKeySha256' = encode(sha256(c.public_key), 'hex'))
      OR (c.revoked_at IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM webauth.audit x WHERE x.action IN ('passkey.revoked', 'login.counter_regression', 'stepup.counter_regression')
        AND x.detail->>'passkey' = c.ref::text))
    UNION ALL
    SELECT 'session ' || webauth.short(s.token_hash) FROM webauth.sessions s WHERE NOT EXISTS (
      SELECT 1 FROM webauth.audit x WHERE x.action = 'session.started' AND x.detail->>'session' = webauth.short(s.token_hash)
        AND x.actor = webauth.actor(s.investor_id) AND x.detail->>'method' = s.method)
  LOOP
    audit_id := NULL; problem := r.what || ' has no matching audit entry'; RETURN NEXT;
  END LOOP;
END $$;

-- ================================================================== privileges (IP-9)
REVOKE ALL ON ALL TABLES IN SCHEMA webauth FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA webauth FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA webauth REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

GRANT USAGE ON SCHEMA webauth TO pt_web;
GRANT EXECUTE ON FUNCTION
  webauth.web_session(bytea),
  webauth.web_start_session(bytea, uuid, text),
  webauth.web_end_session(bytea),
  webauth.web_create_challenge(bytea, text, text, bytea),
  webauth.web_consume_challenge(bytea, text, bytea),
  webauth.web_auth_failed(text, text, text, bytea),
  webauth.web_credential(text),
  webauth.web_session_credentials(bytea),
  webauth.web_registration_user(bytea),
  webauth.web_add_passkey(bytea, bytea, text, bytea, bigint, text[], uuid, text, text, boolean, boolean, text),
  webauth.web_login(bytea, bytea, text, bigint, boolean, boolean),
  webauth.web_step_up(bytea, bytea, text, bigint, boolean, boolean),
  webauth.web_passkeys(bytea),
  webauth.web_revoke_passkey(bytea, uuid),
  webauth.web_step_up_status(bytea, text, numeric),
  webauth.web_require_recent_passkey(bytea, text, numeric),
  webauth.web_reserve(bytea, uuid, uuid, text, bigint, text),
  webauth.web_cancel(bytea, uuid)
TO pt_web;

-- The website reserves and cancels only through the session-bound wrappers above (IP-9).
REVOKE EXECUTE ON FUNCTION
  offering.web_reserve(uuid, uuid, text, uuid, bigint, text, text),
  offering.web_cancel(uuid, uuid, text)
FROM pt_web;

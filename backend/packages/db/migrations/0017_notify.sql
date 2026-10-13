-- Notifications (task T-028, ADR 0013): SMS and e-mail now, push later. Schema notify.
--
-- Safety properties enforced by the database itself:
--   N-1  No readable contact details. A recipient is an investor (KYC subject uuid) or an officer
--        id, nothing else. Phone numbers and e-mail addresses exist only as an HMAC-SHA256 under a
--        lookup key and an AES-256-GCM copy sealed by the service and bound to the recipient and
--        channel; both keys live outside the database (NOTIFY_LOOKUP_KEY, NOTIFY_DATA_KEY).
--   N-2  No personal data in messages. Every event kind has a fixed list of typed placeholders
--        (amount in paisa, last four digits, UTC time, short code, short label, a word from a fixed
--        list); notify.enqueue refuses any other key or any value that does not match its type,
--        including codes and labels with 7+ consecutive digits (phone, CNIC, IBAN) or an '@'.
--        Templates may use only their kind's placeholders.
--   N-3  Consent. Transactional notices follow the recipient's per-channel preference (default on).
--        Security notices (category 'security') ignore opt-outs: there is no preference for them.
--        A security notice with no deliverable contact is recorded as 'undeliverable' and raises
--        NOTIFY notify_alert; it is never silently dropped.
--   N-4  Enqueue in the business transaction. notify.enqueue is called inside the producer's
--        transaction (rollback removes it; NOTIFY fires at commit). Idempotent per key: the same
--        key with the same kind, recipient and parameters returns the original id; anything else
--        under that key is refused. The contacts and template versions are bound at enqueue, so a
--        later contact change cannot redirect an alert that was already raised.
--   N-5  Record before send. A worker owns a delivery only through an unexpired lease and must
--        record the attempt (claimed -> sending) BEFORE calling the provider, with enough lease
--        left for the provider call. A 'sending' delivery whose lease expired is re-leased for
--        resolution only (the provider is asked whether it accepted the delivery's idempotency
--        key), never sent again blindly. Hence at most one provider acceptance per delivery.
--   N-6  Retries with exponential backoff (30 s * 2^(attempt-1), at most 1 h); a permanent refusal,
--        running out of attempts or an outcome that stays unknown moves the delivery to 'dead'
--        (dead letter, NOTIFY notify_alert). Only an operator with a reason can retry or abandon it.
--   N-7  Rate limits per recipient and channel per hour (notify.rate_limits). Over the limit a
--        delivery is deferred, never dropped, and does not use up an attempt.
--   N-8  Append-only records (recipients change only their locale, contacts are superseded once,
--        deliveries only move along allowed edges); a hash-chained audit log with UTC timestamps
--        (finding F-04); notify.verify_audit() also finds rows written around the API.
--   N-9  Least privilege: pt_notify_producer (enqueue only, the narrow grant for other services),
--        pt_notify_service (recipients, contacts, preferences), pt_notify_worker (delivery API,
--        the only role that receives sealed contacts), pt_notify_operator (dead letters, templates,
--        audit), pt_notify_reader (status without hashes or ciphertext).
-- Advisory locks: 586586170 (audit), 586586171 (rate limit per recipient and channel),
-- 586586172 (contact registration per recipient).

CREATE SCHEMA IF NOT EXISTS notify;
REVOKE ALL ON SCHEMA notify FROM PUBLIC;

DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['pt_notify_producer', 'pt_notify_service', 'pt_notify_worker', 'pt_notify_operator', 'pt_notify_reader'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN', r);
    END IF;
  END LOOP;
END $$;

CREATE FUNCTION notify.forbid_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'notify records are append-only: % on %.% is not allowed', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE FUNCTION notify.utc(p timestamptz) RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT to_char(p AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
$$;

-- ------------------------------------------------------------------ audit (N-8)
CREATE TABLE notify.audit (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at        timestamptz NOT NULL,
  actor     text NOT NULL CHECK (length(actor) BETWEEN 1 AND 100),
  action    text NOT NULL CHECK (action ~ '^[a-z][a-z_.]{2,63}$'),
  detail    jsonb NOT NULL CHECK (jsonb_typeof(detail) = 'object' AND octet_length(detail::text) <= 8192),
  prev_hash bytea NOT NULL CHECK (length(prev_hash) = 32),
  hash      bytea NOT NULL UNIQUE CHECK (length(hash) = 32)
);
CREATE TRIGGER audit_no_change BEFORE UPDATE OR DELETE ON notify.audit FOR EACH ROW EXECUTE FUNCTION notify.forbid_change();
CREATE TRIGGER audit_no_truncate BEFORE TRUNCATE ON notify.audit FOR EACH STATEMENT EXECUTE FUNCTION notify.forbid_change();

CREATE FUNCTION notify.audit_digest(p_prev bytea, p_id bigint, p_at timestamptz, p_actor text, p_action text, p_detail jsonb)
RETURNS bytea LANGUAGE sql STABLE SET search_path = pg_catalog, notify AS $$
  SELECT sha256(p_prev || convert_to('pt-notify-audit-v1' || jsonb_build_array(p_id, notify.utc(p_at), p_actor, p_action, p_detail)::text, 'UTF8'))
$$;

CREATE FUNCTION notify.audit_append(p_actor text, p_action text, p_detail jsonb)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, notify AS $$
DECLARE
  v_prev bytea;
  v_id bigint;
  v_at timestamptz := date_trunc('microseconds', clock_timestamp());
BEGIN
  PERFORM pg_advisory_xact_lock(586586170);
  SELECT hash INTO v_prev FROM notify.audit ORDER BY id DESC LIMIT 1;
  v_prev := coalesce(v_prev, decode(repeat('00', 32), 'hex'));
  v_id := nextval(pg_get_serial_sequence('notify.audit', 'id'));
  INSERT INTO notify.audit (id, at, actor, action, detail, prev_hash, hash)
  OVERRIDING SYSTEM VALUE
  VALUES (v_id, v_at, p_actor, p_action, coalesce(p_detail, '{}'::jsonb), v_prev,
          notify.audit_digest(v_prev, v_id, v_at, p_actor, p_action, coalesce(p_detail, '{}'::jsonb)));
  RETURN v_id;
END $$;

-- ------------------------------------------------------------------ catalogue (N-2)
-- Event kinds and their typed placeholders. New kinds come with a new migration.
-- placeholders: {"name": {"type": "utc|paisa|last4|code|label|word", "choices": [..] (word only)}}
CREATE TABLE notify.event_kinds (
  kind         text PRIMARY KEY CHECK (kind ~ '^[a-z][a-z_]*\.[a-z][a-z_]*$' AND length(kind) <= 64),
  category     text NOT NULL CHECK (category IN ('security', 'transactional')),
  placeholders jsonb NOT NULL CHECK (jsonb_typeof(placeholders) = 'object'),
  description  text NOT NULL CHECK (length(description) BETWEEN 10 AND 300)
);
CREATE TRIGGER event_kinds_no_change BEFORE UPDATE OR DELETE ON notify.event_kinds FOR EACH ROW EXECUTE FUNCTION notify.forbid_change();
CREATE TRIGGER event_kinds_no_truncate BEFORE TRUNCATE ON notify.event_kinds FOR EACH STATEMENT EXECUTE FUNCTION notify.forbid_change();

INSERT INTO notify.event_kinds (kind, category, placeholders, description) VALUES
  ('security.new_device_sign_in', 'security',
   '{"device": {"type": "label"}, "at": {"type": "utc"}}',
   'A sign-in from a device not seen before for this account (threat API-2).'),
  ('security.contact_changed', 'security',
   '{"channel": {"type": "word", "choices": ["sms", "email"]}, "at": {"type": "utc"}}',
   'A phone number or e-mail address was replaced; also sent to the replaced contact.'),
  ('security.payout_account_added', 'security',
   '{"last4": {"type": "last4"}, "active_from": {"type": "utc"}}',
   'A first payout bank account was registered; the 72-hour cooling-off starts (threat M-1, B-4).'),
  ('security.payout_account_changed', 'security',
   '{"last4": {"type": "last4"}, "previous_last4": {"type": "last4"}, "active_from": {"type": "utc"}}',
   'The payout bank account was replaced; the 72-hour cooling-off starts (threat M-1, B-4).'),
  ('security.payout_account_active', 'security',
   '{"last4": {"type": "last4"}}',
   'The 72-hour cooling-off ended; the payout account can now receive payouts.'),
  ('security.kyc_status_changed', 'security',
   '{"status": {"type": "word", "choices": ["verified", "expired", "action_required", "closed"]}}',
   'The verification status changed. Generic words only: never a sanctions detail (no tipping-off).'),
  ('security.account_frozen', 'security',
   '{"at": {"type": "utc"}}',
   'The account or its units were frozen.'),
  ('security.account_unfrozen', 'security',
   '{"at": {"type": "utc"}}',
   'A freeze on the account or its units was lifted.'),
  ('security.large_transaction_pending', 'security',
   '{"amount_paisa": {"type": "paisa"}, "reference": {"type": "code"}}',
   'A transaction above the maker-checker threshold waits for approval.'),
  ('offering.reservation_expiring', 'transactional',
   '{"offering": {"type": "code"}, "amount_paisa": {"type": "paisa"}, "expires_at": {"type": "utc"}}',
   'An unpaid offering reservation expires soon (spec S-02 section 10: 2 h before).'),
  ('rent.paid', 'transactional',
   '{"token": {"type": "code"}, "amount_paisa": {"type": "paisa"}, "period": {"type": "code"}}',
   'A rent distribution was paid to the investor''s payout account (spec S-03 section 10).');

/** N-2: why a parameter object does not fit its kind (NULL = fine). */
CREATE FUNCTION notify.params_problem(p_kind text, p_params jsonb) RETURNS text
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, notify AS $$
DECLARE
  v_spec jsonb;
  k text;
  v jsonb;
  s text;
  t text;
BEGIN
  SELECT placeholders INTO v_spec FROM notify.event_kinds WHERE kind = p_kind;
  IF v_spec IS NULL THEN RETURN format('unknown event kind %s', p_kind); END IF;
  IF p_params IS NULL OR jsonb_typeof(p_params) IS DISTINCT FROM 'object' THEN RETURN 'parameters must be an object'; END IF;
  FOR k IN SELECT jsonb_object_keys(p_params) LOOP
    IF NOT v_spec ? k THEN RETURN format('parameter %s is not a placeholder of %s', k, p_kind); END IF;
  END LOOP;
  FOR k, v IN SELECT * FROM jsonb_each(v_spec) LOOP
    IF NOT p_params ? k THEN RETURN format('parameter %s is missing', k); END IF;
    IF jsonb_typeof(p_params -> k) IS DISTINCT FROM 'string' THEN RETURN format('parameter %s must be a string', k); END IF;
    s := p_params ->> k;
    t := v ->> 'type';
    IF t = 'utc' THEN
      IF s !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z$' THEN
        RETURN format('parameter %s must be a UTC time like 2026-10-13T09:00:00Z', k);
      END IF;
      BEGIN
        PERFORM s::timestamptz;
      EXCEPTION WHEN others THEN
        RETURN format('parameter %s is not a valid time', k);
      END;
    ELSIF t = 'paisa' THEN
      IF s !~ '^(0|[1-9][0-9]{0,17})$' THEN RETURN format('parameter %s must be a whole number of paisa', k); END IF;
    ELSIF t = 'last4' THEN
      IF s !~ '^[0-9]{4}$' THEN RETURN format('parameter %s must be exactly four digits', k); END IF;
    ELSIF t = 'code' THEN
      IF length(s) NOT BETWEEN 1 AND 40 OR s !~ '^[A-Z0-9][A-Z0-9-]*$' OR s ~ '[0-9]{7}' THEN
        RETURN format('parameter %s must be an upper-case code of up to 40 characters without long digit runs', k);
      END IF;
    ELSIF t = 'label' THEN
      IF length(s) NOT BETWEEN 1 AND 48 OR s !~ '^[A-Za-z][A-Za-z0-9 .()/,-]*$' OR s ~ '[0-9]{7}' THEN
        RETURN format('parameter %s must be a short plain label (letters, digits, spaces) without long digit runs', k);
      END IF;
    ELSIF t = 'word' THEN
      -- coalesce: a missing choices list must refuse, not compare as NULL (F-06).
      IF coalesce((v -> 'choices') ? s, false) IS NOT TRUE THEN
        RETURN format('parameter %s must be one of %s', k, coalesce(v -> 'choices', '[]'::jsonb));
      END IF;
    ELSE
      RETURN format('placeholder %s has an unknown type', k);
    END IF;
  END LOOP;
  RETURN NULL;
END $$;

-- ------------------------------------------------------------------ templates (versioned, EN + UR)
CREATE TABLE notify.templates (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind        text NOT NULL REFERENCES notify.event_kinds (kind),
  channel     text NOT NULL CHECK (channel IN ('sms', 'email', 'push')),
  locale      text NOT NULL CHECK (locale IN ('en', 'ur')),
  version     integer NOT NULL CHECK (version >= 1),
  subject     text CHECK (length(subject) BETWEEN 1 AND 150 AND subject !~ '[\r\n]'),
  body        text NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  body_sha256 bytea NOT NULL CHECK (length(body_sha256) = 32),
  created_at  timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  created_by  text NOT NULL CHECK (length(created_by) BETWEEN 1 AND 100),
  UNIQUE (kind, channel, locale, version),
  CHECK ((channel = 'email') = (subject IS NOT NULL)),
  CHECK (channel <> 'sms' OR length(body) <= 500)
);
CREATE TRIGGER templates_no_change BEFORE UPDATE OR DELETE ON notify.templates FOR EACH ROW EXECUTE FUNCTION notify.forbid_change();
CREATE TRIGGER templates_no_truncate BEFORE TRUNCATE ON notify.templates FOR EACH STATEMENT EXECUTE FUNCTION notify.forbid_change();

/** Adds a new version of a template. Placeholders must be the kind's own ({{name}}). */
CREATE FUNCTION notify.add_template(p_kind text, p_channel text, p_locale text, p_subject text, p_body text, p_actor text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, notify AS $$
DECLARE
  v_spec jsonb;
  v_text text := coalesce(p_subject, '') || ' ' || coalesce(p_body, '');
  v_name text;
  v_version integer;
  v_id bigint;
BEGIN
  IF p_kind IS NULL OR p_channel IS NULL OR p_locale IS NULL OR p_body IS NULL OR p_actor IS NULL THEN
    RAISE EXCEPTION 'kind, channel, locale, body and actor are required' USING ERRCODE = 'check_violation';
  END IF;
  SELECT placeholders INTO v_spec FROM notify.event_kinds WHERE kind = p_kind;
  IF v_spec IS NULL THEN RAISE EXCEPTION 'unknown event kind %', p_kind USING ERRCODE = 'foreign_key_violation'; END IF;
  FOR v_name IN SELECT m[1] FROM regexp_matches(v_text, '\{\{([a-z_0-9]*)\}\}', 'g') AS m LOOP
    IF NOT v_spec ? v_name THEN
      RAISE EXCEPTION 'template uses {{%}}, which is not a placeholder of %', v_name, p_kind USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  -- Every brace must belong to a known placeholder (no half-written or nested placeholders).
  IF regexp_replace(v_text, '\{\{[a-z_0-9]+\}\}', '', 'g') ~ '[{}]' THEN
    RAISE EXCEPTION 'template has a malformed placeholder' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(586586170);
  SELECT coalesce(max(version), 0) + 1 INTO v_version FROM notify.templates WHERE kind = p_kind AND channel = p_channel AND locale = p_locale;
  INSERT INTO notify.templates (kind, channel, locale, version, subject, body, body_sha256, created_by)
  VALUES (p_kind, p_channel, p_locale, v_version, p_subject, p_body, sha256(convert_to(coalesce(p_subject, '') || E'\n' || p_body, 'UTF8')), p_actor)
  RETURNING id INTO v_id;
  PERFORM notify.audit_append(p_actor, 'template.added', jsonb_build_object('template', v_id, 'kind', p_kind, 'channel', p_channel,
    'locale', p_locale, 'version', v_version, 'sha256', encode(sha256(convert_to(coalesce(p_subject, '') || E'\n' || p_body, 'UTF8')), 'hex')));
  RETURN v_id;
END $$;

/** The template used for a new delivery: the latest version in the locale, else the latest English one. */
CREATE FUNCTION notify.current_template(p_kind text, p_channel text, p_locale text) RETURNS bigint
LANGUAGE sql STABLE SET search_path = pg_catalog, notify AS $$
  SELECT id FROM notify.templates
  WHERE kind = p_kind AND channel = p_channel AND locale IN (p_locale, 'en')
  ORDER BY (locale = p_locale) DESC, version DESC
  LIMIT 1
$$;

-- ------------------------------------------------------------------ recipients and contacts (N-1)
CREATE TABLE notify.recipients (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type text NOT NULL CHECK (subject_type IN ('investor', 'officer')),
  -- Investor: the KYC subject uuid. Officer: the officer id. Never a name or a contact detail.
  subject_id   text NOT NULL CHECK (
                 (subject_type = 'investor' AND subject_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
                 OR (subject_type = 'officer' AND subject_id ~ '^[a-z0-9][a-z0-9._-]*$' AND length(subject_id) <= 64)),
  locale       text NOT NULL DEFAULT 'en' CHECK (locale IN ('en', 'ur')),
  created_at   timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  created_by   text NOT NULL CHECK (length(created_by) BETWEEN 1 AND 100),
  UNIQUE (subject_type, subject_id)
);

CREATE FUNCTION notify.guard_recipient() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'recipients are never deleted' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF (NEW.id, NEW.subject_type, NEW.subject_id, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM (OLD.id, OLD.subject_type, OLD.subject_id, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'recipient %: only the locale can change', OLD.id USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER recipients_guard BEFORE UPDATE OR DELETE ON notify.recipients FOR EACH ROW EXECUTE FUNCTION notify.guard_recipient();
CREATE TRIGGER recipients_no_truncate BEFORE TRUNCATE ON notify.recipients FOR EACH STATEMENT EXECUTE FUNCTION notify.forbid_change();

CREATE TABLE notify.contacts (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  recipient_id  uuid NOT NULL REFERENCES notify.recipients (id),
  channel       text NOT NULL CHECK (channel IN ('sms', 'email')),
  -- HMAC-SHA256(NOTIFY_LOOKUP_KEY, "pt-notify-<channel>-v1\n" || normalised value).
  lookup_hash   bytea NOT NULL CHECK (length(lookup_hash) = 32),
  -- AES-256-GCM made by the service (key outside the database), bound to recipient, channel and hash.
  sealed        bytea NOT NULL CHECK (length(sealed) BETWEEN 30 AND 400),
  key_version   smallint NOT NULL CHECK (key_version BETWEEN 1 AND 999),
  registered_at timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  registered_by text NOT NULL CHECK (length(registered_by) BETWEEN 1 AND 100),
  superseded_at timestamptz,
  CHECK (superseded_at IS NULL OR superseded_at >= registered_at)
);
CREATE UNIQUE INDEX contacts_one_current ON notify.contacts (recipient_id, channel) WHERE superseded_at IS NULL;
CREATE INDEX contacts_lookup_idx ON notify.contacts (channel, lookup_hash);

CREATE FUNCTION notify.guard_contact() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'contacts are never deleted' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF OLD.superseded_at IS NOT NULL OR NEW.superseded_at IS NULL
     OR (NEW.id, NEW.recipient_id, NEW.channel, NEW.lookup_hash, NEW.sealed, NEW.key_version, NEW.registered_at, NEW.registered_by)
        IS DISTINCT FROM (OLD.id, OLD.recipient_id, OLD.channel, OLD.lookup_hash, OLD.sealed, OLD.key_version, OLD.registered_at, OLD.registered_by) THEN
    RAISE EXCEPTION 'contact % can only be superseded, once', OLD.id USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER contacts_guard BEFORE UPDATE OR DELETE ON notify.contacts FOR EACH ROW EXECUTE FUNCTION notify.guard_contact();
CREATE TRIGGER contacts_no_truncate BEFORE TRUNCATE ON notify.contacts FOR EACH STATEMENT EXECUTE FUNCTION notify.forbid_change();

-- Preferences for transactional notices only (N-3). Append-only: the latest row per recipient and
-- channel is the current one; no row means "on".
CREATE TABLE notify.preferences (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  recipient_id uuid NOT NULL REFERENCES notify.recipients (id),
  channel      text NOT NULL CHECK (channel IN ('sms', 'email', 'push')),
  enabled      boolean NOT NULL,
  set_at       timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  set_by       text NOT NULL CHECK (length(set_by) BETWEEN 1 AND 100)
);
CREATE INDEX preferences_current_idx ON notify.preferences (recipient_id, channel, id DESC);
CREATE TRIGGER preferences_no_change BEFORE UPDATE OR DELETE ON notify.preferences FOR EACH ROW EXECUTE FUNCTION notify.forbid_change();
CREATE TRIGGER preferences_no_truncate BEFORE TRUNCATE ON notify.preferences FOR EACH STATEMENT EXECUTE FUNCTION notify.forbid_change();

-- ------------------------------------------------------------------ notifications and deliveries
CREATE TABLE notify.notifications (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  kind            text NOT NULL REFERENCES notify.event_kinds (kind),
  category        text NOT NULL CHECK (category IN ('security', 'transactional')),
  recipient_id    uuid NOT NULL REFERENCES notify.recipients (id),
  params          jsonb NOT NULL CHECK (jsonb_typeof(params) = 'object' AND octet_length(params::text) <= 2048),
  content_hash    bytea NOT NULL CHECK (length(content_hash) = 32),
  -- queued: at least one delivery; suppressed: transactional and every channel opted out or absent;
  -- undeliverable: SECURITY notice without any contact (alerted).
  status          text NOT NULL CHECK (status IN ('queued', 'suppressed', 'undeliverable')),
  created_by      text NOT NULL CHECK (length(created_by) BETWEEN 1 AND 100),
  created_at      timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  CHECK (status <> 'suppressed' OR category = 'transactional')
);
CREATE INDEX notifications_recipient_idx ON notify.notifications (recipient_id, id);
CREATE TRIGGER notifications_no_change BEFORE UPDATE OR DELETE ON notify.notifications FOR EACH ROW EXECUTE FUNCTION notify.forbid_change();
CREATE TRIGGER notifications_no_truncate BEFORE TRUNCATE ON notify.notifications FOR EACH STATEMENT EXECUTE FUNCTION notify.forbid_change();

CREATE TABLE notify.deliveries (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Sent to the provider as its idempotency key; also the key for asking whether it accepted.
  uid                 uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  notification_id     bigint NOT NULL REFERENCES notify.notifications (id),
  recipient_id        uuid NOT NULL REFERENCES notify.recipients (id),
  category            text NOT NULL CHECK (category IN ('security', 'transactional')),
  channel             text NOT NULL CHECK (channel IN ('sms', 'email', 'push')),
  contact_id          bigint NOT NULL REFERENCES notify.contacts (id),
  template_id         bigint NOT NULL REFERENCES notify.templates (id),
  status              text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'claimed', 'sending', 'sent', 'dead', 'abandoned')),
  attempts            integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts        integer NOT NULL CHECK (max_attempts BETWEEN 1 AND 20),
  available_at        timestamptz NOT NULL DEFAULT now(),
  lease_owner         text CHECK (length(lease_owner) <= 100),
  lease_until         timestamptz,
  provider            text CHECK (provider ~ '^[a-z][a-z0-9_-]{1,31}$'),
  provider_message_id text CHECK (length(provider_message_id) BETWEEN 1 AND 200),
  sent_at             timestamptz,
  last_error          text CHECK (length(last_error) <= 500),
  created_at          timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  updated_at          timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  UNIQUE (notification_id, contact_id),
  CHECK ((status = 'sent') = (provider_message_id IS NOT NULL AND sent_at IS NOT NULL AND provider IS NOT NULL)),
  CHECK (status NOT IN ('claimed', 'sending') OR (lease_owner IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX deliveries_ready_idx ON notify.deliveries (available_at, id) WHERE status = 'pending';
CREATE INDEX deliveries_leased_idx ON notify.deliveries (lease_until) WHERE status IN ('claimed', 'sending');
CREATE INDEX deliveries_rate_idx ON notify.deliveries (recipient_id, channel, status);
CREATE INDEX deliveries_dead_idx ON notify.deliveries (id) WHERE status = 'dead';

CREATE TABLE notify.attempts (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  delivery_id         bigint NOT NULL REFERENCES notify.deliveries (id),
  attempt_no          integer NOT NULL CHECK (attempt_no >= 1),
  worker              text NOT NULL CHECK (length(worker) BETWEEN 1 AND 100),
  started_at          timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  finished_at         timestamptz,
  -- accepted: provider took it; not_accepted: provably not taken (retry); rejected: permanent refusal;
  -- unknown: given up without an answer (dead letter).
  outcome             text CHECK (outcome IN ('accepted', 'not_accepted', 'rejected', 'unknown')),
  provider            text CHECK (provider ~ '^[a-z][a-z0-9_-]{1,31}$'),
  provider_message_id text CHECK (length(provider_message_id) BETWEEN 1 AND 200),
  -- SHA-256 of the rendered message (evidence of what was sent, without the text).
  body_sha256         bytea CHECK (length(body_sha256) = 32),
  error               text CHECK (length(error) <= 500),
  UNIQUE (delivery_id, attempt_no),
  CHECK ((finished_at IS NULL) = (outcome IS NULL)),
  CHECK ((outcome = 'accepted') = (provider_message_id IS NOT NULL))
);
CREATE INDEX attempts_window_idx ON notify.attempts (delivery_id, started_at);
CREATE UNIQUE INDEX attempts_one_open ON notify.attempts (delivery_id) WHERE finished_at IS NULL;

CREATE FUNCTION notify.guard_attempt() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'attempts are never deleted' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF OLD.finished_at IS NOT NULL
     OR (NEW.id, NEW.delivery_id, NEW.attempt_no, NEW.worker, NEW.started_at)
        IS DISTINCT FROM (OLD.id, OLD.delivery_id, OLD.attempt_no, OLD.worker, OLD.started_at) THEN
    RAISE EXCEPTION 'attempt % can only be finished, once', OLD.id USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER attempts_guard BEFORE UPDATE OR DELETE ON notify.attempts FOR EACH ROW EXECUTE FUNCTION notify.guard_attempt();
CREATE TRIGGER attempts_no_truncate BEFORE TRUNCATE ON notify.attempts FOR EACH STATEMENT EXECUTE FUNCTION notify.forbid_change();

CREATE FUNCTION notify.guard_delivery() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  edge text := OLD.status || '>' || NEW.status;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'deliveries are never deleted' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF (NEW.id, NEW.uid, NEW.notification_id, NEW.recipient_id, NEW.category, NEW.channel, NEW.contact_id, NEW.template_id, NEW.max_attempts, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.uid, OLD.notification_id, OLD.recipient_id, OLD.category, OLD.channel, OLD.contact_id, OLD.template_id, OLD.max_attempts, OLD.created_at) THEN
    RAISE EXCEPTION 'delivery % is immutable except for its processing state', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status IN ('sent', 'abandoned') THEN
    RAISE EXCEPTION 'delivery % is final (%)', OLD.id, OLD.status USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> NEW.status AND edge NOT IN (
       'pending>claimed',
       'claimed>pending', 'claimed>sending', 'claimed>dead',
       'sending>sent', 'sending>pending', 'sending>dead',
       'dead>pending', 'dead>abandoned') THEN
    RAISE EXCEPTION 'delivery %: transition % is not allowed', OLD.id, edge USING ERRCODE = 'check_violation';
  END IF;
  -- The provider's message id is written exactly once, when the delivery becomes sent.
  IF (NEW.provider_message_id, NEW.provider, NEW.sent_at) IS DISTINCT FROM (OLD.provider_message_id, OLD.provider, OLD.sent_at)
     AND edge <> 'sending>sent' THEN
    RAISE EXCEPTION 'delivery %: the provider result is recorded only when it is sent', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER deliveries_guard BEFORE UPDATE OR DELETE ON notify.deliveries FOR EACH ROW EXECUTE FUNCTION notify.guard_delivery();
CREATE TRIGGER deliveries_no_truncate BEFORE TRUNCATE ON notify.deliveries FOR EACH STATEMENT EXECUTE FUNCTION notify.forbid_change();

-- ------------------------------------------------------------------ rate limits (N-7)
-- Deliveries per recipient and channel in any rolling hour. Changed only by a migration or the admin.
CREATE TABLE notify.rate_limits (
  category     text NOT NULL CHECK (category IN ('security', 'transactional')),
  channel      text NOT NULL CHECK (channel IN ('sms', 'email', 'push')),
  max_per_hour integer NOT NULL CHECK (max_per_hour BETWEEN 1 AND 1000),
  PRIMARY KEY (category, channel)
);
INSERT INTO notify.rate_limits VALUES
  ('security', 'sms', 20), ('security', 'email', 30), ('security', 'push', 30),
  ('transactional', 'sms', 5), ('transactional', 'email', 10), ('transactional', 'push', 10);

-- ------------------------------------------------------------------ API: recipients, contacts, preferences
/** Registers a recipient (idempotent) and returns its id. */
CREATE FUNCTION notify.register_recipient(p_subject_type text, p_subject_id text, p_locale text, p_actor text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, notify AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_subject_type IS NULL OR p_subject_id IS NULL OR p_actor IS NULL THEN
    RAISE EXCEPTION 'subject type, subject id and actor are required' USING ERRCODE = 'check_violation';
  END IF;
  SELECT id INTO v_id FROM notify.recipients WHERE subject_type = p_subject_type AND subject_id = p_subject_id;
  IF FOUND THEN RETURN v_id; END IF;
  INSERT INTO notify.recipients (subject_type, subject_id, locale, created_by)
  VALUES (p_subject_type, p_subject_id, coalesce(p_locale, 'en'), p_actor)
  ON CONFLICT (subject_type, subject_id) DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    SELECT id INTO v_id FROM notify.recipients WHERE subject_type = p_subject_type AND subject_id = p_subject_id;
    RETURN v_id;
  END IF;
  PERFORM notify.audit_append(p_actor, 'recipient.registered', jsonb_build_object('recipient', v_id, 'subjectType', p_subject_type,
    'subject', p_subject_id, 'locale', coalesce(p_locale, 'en')));
  RETURN v_id;
END $$;

CREATE FUNCTION notify.set_locale(p_recipient uuid, p_locale text, p_actor text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, notify AS $$
BEGIN
  IF p_recipient IS NULL OR p_locale IS NULL OR p_actor IS NULL THEN
    RAISE EXCEPTION 'recipient, locale and actor are required' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE notify.recipients SET locale = p_locale WHERE id = p_recipient AND locale IS DISTINCT FROM p_locale;
  IF FOUND THEN
    PERFORM notify.audit_append(p_actor, 'recipient.locale', jsonb_build_object('recipient', p_recipient, 'locale', p_locale));
  END IF;
END $$;

/**
 * Registers or replaces the recipient's contact for a channel. The caller (the service) has
 * verified ownership (one-time code) before calling. A replacement supersedes the old contact
 * and raises security.contact_changed to every current contact AND the replaced one, so the
 * real owner hears about a takeover attempt on the old number or address.
 */
CREATE FUNCTION notify.register_contact(p_recipient uuid, p_channel text, p_lookup_hash bytea, p_sealed bytea, p_key_version smallint, p_actor text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, notify AS $$
DECLARE
  cur notify.contacts;
  r notify.recipients;
  v_id bigint;
  v_now timestamptz := date_trunc('microseconds', clock_timestamp());
BEGIN
  IF p_recipient IS NULL OR p_channel IS NULL OR p_lookup_hash IS NULL OR p_sealed IS NULL OR p_key_version IS NULL OR p_actor IS NULL THEN
    RAISE EXCEPTION 'recipient, channel, lookup hash, sealed value, key version and actor are required' USING ERRCODE = 'check_violation';
  END IF;
  IF p_channel NOT IN ('sms', 'email') THEN
    RAISE EXCEPTION 'contacts exist for sms and email only (push comes with the investor app, task T-040)' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO r FROM notify.recipients WHERE id = p_recipient;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown recipient' USING ERRCODE = 'foreign_key_violation'; END IF;
  PERFORM pg_advisory_xact_lock(586586172, hashtext(p_recipient::text));
  SELECT * INTO cur FROM notify.contacts WHERE recipient_id = p_recipient AND channel = p_channel AND superseded_at IS NULL;
  IF FOUND AND cur.lookup_hash = p_lookup_hash THEN RETURN cur.id; END IF;
  IF cur.id IS NOT NULL THEN
    UPDATE notify.contacts SET superseded_at = v_now WHERE id = cur.id;
  END IF;
  INSERT INTO notify.contacts (recipient_id, channel, lookup_hash, sealed, key_version, registered_at, registered_by)
  VALUES (p_recipient, p_channel, p_lookup_hash, p_sealed, p_key_version, v_now, p_actor)
  RETURNING id INTO v_id;
  PERFORM notify.audit_append(p_actor, 'contact.registered', jsonb_build_object('contact', v_id, 'recipient', p_recipient,
    'channel', p_channel, 'keyVersion', p_key_version, 'previous', cur.id));
  IF cur.id IS NOT NULL THEN
    PERFORM notify.enqueue_internal(format('notify:contact-changed:%s', v_id), 'security.contact_changed', p_recipient,
      jsonb_build_object('channel', p_channel, 'at', to_char(v_now AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')),
      p_actor, cur.id);
  END IF;
  RETURN v_id;
END $$;

/** N-3: turns a channel on or off for TRANSACTIONAL notices. Security notices have no switch. */
CREATE FUNCTION notify.set_preference(p_recipient uuid, p_channel text, p_enabled boolean, p_actor text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, notify AS $$
DECLARE
  v_id bigint;
BEGIN
  IF p_recipient IS NULL OR p_channel IS NULL OR p_enabled IS NULL OR p_actor IS NULL THEN
    RAISE EXCEPTION 'recipient, channel, enabled and actor are required' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO notify.preferences (recipient_id, channel, enabled, set_by) VALUES (p_recipient, p_channel, p_enabled, p_actor)
  RETURNING id INTO v_id;
  PERFORM notify.audit_append(p_actor, 'preference.set', jsonb_build_object('preference', v_id, 'recipient', p_recipient,
    'channel', p_channel, 'enabled', p_enabled));
  RETURN v_id;
END $$;

CREATE FUNCTION notify.channel_enabled(p_recipient uuid, p_channel text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, notify AS $$
  SELECT coalesce((SELECT enabled FROM notify.preferences WHERE recipient_id = p_recipient AND channel = p_channel ORDER BY id DESC LIMIT 1), true)
$$;

-- ------------------------------------------------------------------ API: enqueue (N-2, N-3, N-4)
/** Not granted to anyone: the fan-out behind notify.enqueue and the contact-change notice. */
CREATE FUNCTION notify.enqueue_internal(p_key text, p_kind text, p_recipient uuid, p_params jsonb, p_actor text, p_extra_contact bigint)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, notify AS $$
DECLARE
  k notify.event_kinds;
  r notify.recipients;
  v_problem text;
  v_hash bytea;
  v_existing notify.notifications;
  v_id bigint;
  v_status text;
  v_template bigint;
  v_deliveries jsonb := '[]'::jsonb;
  v_delivery bigint;
  c notify.contacts;
BEGIN
  IF p_key IS NULL OR p_kind IS NULL OR p_recipient IS NULL OR p_actor IS NULL THEN
    RAISE EXCEPTION 'key, kind, recipient and actor are required' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO k FROM notify.event_kinds WHERE kind = p_kind;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown event kind %', p_kind USING ERRCODE = 'check_violation'; END IF;
  v_problem := notify.params_problem(p_kind, p_params);
  IF v_problem IS NOT NULL THEN RAISE EXCEPTION '%', v_problem USING ERRCODE = 'check_violation'; END IF;
  SELECT * INTO r FROM notify.recipients WHERE id = p_recipient;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown recipient' USING ERRCODE = 'foreign_key_violation'; END IF;

  v_hash := sha256(convert_to(jsonb_build_array(p_kind, p_recipient, p_params)::text, 'UTF8'));
  SELECT * INTO v_existing FROM notify.notifications WHERE idempotency_key = p_key;
  IF FOUND THEN
    IF v_existing.content_hash <> v_hash THEN
      RAISE EXCEPTION 'idempotency key % was already used for a different notification', p_key USING ERRCODE = 'unique_violation';
    END IF;
    RETURN v_existing.id;
  END IF;

  v_id := nextval(pg_get_serial_sequence('notify.notifications', 'id'));
  -- Status first (immutable row), then the deliveries that reference it.
  v_status := CASE
    WHEN EXISTS (SELECT 1 FROM notify.contacts c2
                 WHERE ((c2.recipient_id = p_recipient AND c2.superseded_at IS NULL) OR c2.id = p_extra_contact)
                   AND (k.category = 'security' OR notify.channel_enabled(p_recipient, c2.channel))
                   AND notify.current_template(p_kind, c2.channel, r.locale) IS NOT NULL) THEN 'queued'
    WHEN k.category = 'security' THEN 'undeliverable'
    ELSE 'suppressed' END;
  INSERT INTO notify.notifications (id, idempotency_key, kind, category, recipient_id, params, content_hash, status, created_by)
  OVERRIDING SYSTEM VALUE
  VALUES (v_id, p_key, p_kind, k.category, p_recipient, p_params, v_hash, v_status, p_actor)
  ON CONFLICT (idempotency_key) DO NOTHING;
  IF NOT FOUND THEN
    -- A concurrent enqueue with the same key won: compare with it.
    SELECT * INTO v_existing FROM notify.notifications WHERE idempotency_key = p_key;
    IF v_existing.content_hash <> v_hash THEN
      RAISE EXCEPTION 'idempotency key % was already used for a different notification', p_key USING ERRCODE = 'unique_violation';
    END IF;
    RETURN v_existing.id;
  END IF;

  FOR c IN SELECT * FROM notify.contacts c2
           WHERE (c2.recipient_id = p_recipient AND c2.superseded_at IS NULL) OR c2.id = p_extra_contact
           ORDER BY c2.id LOOP
    CONTINUE WHEN k.category <> 'security' AND NOT notify.channel_enabled(p_recipient, c.channel);
    v_template := notify.current_template(p_kind, c.channel, r.locale);
    CONTINUE WHEN v_template IS NULL;
    INSERT INTO notify.deliveries (notification_id, recipient_id, category, channel, contact_id, template_id, max_attempts)
    VALUES (v_id, p_recipient, k.category, c.channel, c.id, v_template, CASE WHEN k.category = 'security' THEN 8 ELSE 5 END)
    RETURNING id INTO v_delivery;
    v_deliveries := v_deliveries || to_jsonb(v_delivery);
  END LOOP;

  PERFORM notify.audit_append(p_actor, 'notification.enqueued', jsonb_build_object('notification', v_id, 'kind', p_kind,
    'recipient', p_recipient, 'status', v_status, 'deliveries', v_deliveries));
  IF v_status = 'undeliverable' THEN
    PERFORM pg_notify('notify_alert', json_build_object('kind', 'undeliverable', 'notification', v_id, 'event', p_kind)::text);
  ELSIF v_status = 'queued' THEN
    -- Fires at commit, so an aborted business change never wakes a worker.
    PERFORM pg_notify('notify', v_id::text);
  END IF;
  RETURN v_id;
END $$;

/**
 * N-4: the producer's entry point, called INSIDE the business transaction. The recipient is named
 * by subject (investor KYC subject uuid or officer id) and registered on first use.
 */
CREATE FUNCTION notify.enqueue(p_key text, p_kind text, p_subject_type text, p_subject_id text, p_params jsonb, p_actor text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, notify AS $$
BEGIN
  RETURN notify.enqueue_internal(p_key, p_kind, notify.register_recipient(p_subject_type, p_subject_id, NULL, p_actor), p_params, p_actor, NULL);
END $$;

-- ------------------------------------------------------------------ API: worker (N-5, N-6, N-7)
/**
 * Leases up to p_batch deliveries to p_worker:
 *  - claimed deliveries whose lease expired go back to pending first (no attempt was recorded,
 *    so nothing was sent);
 *  - pending deliveries that are due, unless the recipient's channel is at its hourly limit (then
 *    the delivery is deferred to when the window frees up; no attempt is used);
 *  - sending deliveries whose lease expired are re-leased as they are, for resolution only.
 */
CREATE FUNCTION notify.claim(p_worker text, p_batch integer, p_lease_seconds integer)
RETURNS SETOF notify.deliveries
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, notify AS $$
DECLARE
  d notify.deliveries;
  v_taken integer := 0;
  v_cap integer;
  v_used integer;
  v_oldest timestamptz;
BEGIN
  IF p_worker IS NULL OR length(p_worker) NOT BETWEEN 1 AND 100 OR p_batch NOT BETWEEN 1 AND 100
     OR p_lease_seconds NOT BETWEEN 10 AND 3600 THEN
    RAISE EXCEPTION 'invalid claim arguments' USING ERRCODE = 'check_violation';
  END IF;

  UPDATE notify.deliveries SET status = 'pending', lease_owner = NULL, lease_until = NULL,
         last_error = 'lease expired before the attempt was recorded'
  WHERE id IN (SELECT id FROM notify.deliveries WHERE status = 'claimed' AND lease_until < now() FOR UPDATE SKIP LOCKED);

  FOR d IN SELECT * FROM notify.deliveries
           WHERE (status = 'pending' AND available_at <= now()) OR (status = 'sending' AND lease_until < now())
           ORDER BY id
           FOR UPDATE SKIP LOCKED
           LIMIT p_batch * 4 LOOP
    EXIT WHEN v_taken >= p_batch;
    IF d.status = 'sending' THEN
      UPDATE notify.deliveries SET lease_owner = p_worker, lease_until = now() + make_interval(secs => p_lease_seconds)
      WHERE id = d.id RETURNING * INTO d;
      v_taken := v_taken + 1;
      RETURN NEXT d;
      CONTINUE;
    END IF;
    -- N-7: serialise the count per recipient and channel across concurrent workers.
    PERFORM pg_advisory_xact_lock(586586171, hashtext(d.recipient_id::text || '/' || d.channel));
    SELECT max_per_hour INTO v_cap FROM notify.rate_limits WHERE category = d.category AND channel = d.channel;
    SELECT count(DISTINCT x.id), min(a.started_at) INTO v_used, v_oldest
    FROM notify.deliveries x
    LEFT JOIN notify.attempts a ON a.delivery_id = x.id AND a.started_at > now() - interval '1 hour'
    WHERE x.recipient_id = d.recipient_id AND x.channel = d.channel AND x.id <> d.id
      AND (x.status = 'claimed' OR a.id IS NOT NULL);
    IF v_cap IS NOT NULL AND v_used >= v_cap THEN
      UPDATE notify.deliveries
      SET available_at = greatest(now() + interval '1 second', coalesce(v_oldest + interval '1 hour', now() + interval '1 minute')),
          last_error = format('rate limit: %s per hour on %s reached; deferred', v_cap, d.channel)
      WHERE id = d.id;
      CONTINUE;
    END IF;
    UPDATE notify.deliveries SET status = 'claimed', attempts = attempts + 1, lease_owner = p_worker,
           lease_until = now() + make_interval(secs => p_lease_seconds)
    WHERE id = d.id RETURNING * INTO d;
    v_taken := v_taken + 1;
    RETURN NEXT d;
  END LOOP;
END $$;

/**
 * What the worker needs to send one claimed (or, for resolution, sending) delivery it leases:
 * the sealed contact (only this role ever receives it), the pinned template and the parameters.
 */
CREATE FUNCTION notify.delivery_material(p_id bigint, p_worker text)
RETURNS TABLE (delivery_id bigint, uid uuid, kind text, category text, channel text, locale text, recipient_id uuid,
               contact_id bigint, lookup_hash bytea, sealed bytea, key_version smallint, subject text, body text, params jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, notify AS $$
  SELECT d.id, d.uid, n.kind, d.category, d.channel, t.locale, d.recipient_id, c.id, c.lookup_hash, c.sealed, c.key_version,
         t.subject, t.body, n.params
  FROM notify.deliveries d
  JOIN notify.notifications n ON n.id = d.notification_id
  JOIN notify.contacts c ON c.id = d.contact_id
  JOIN notify.templates t ON t.id = d.template_id
  WHERE d.id = p_id AND d.status IN ('claimed', 'sending') AND d.lease_owner = p_worker AND d.lease_until > now()
$$;

/**
 * N-5: records the attempt BEFORE the provider is called. NULL = the lease is lost or too short
 * for the provider call (p_min_seconds): the worker must not call the provider.
 */
CREATE FUNCTION notify.begin_attempt(p_id bigint, p_worker text, p_min_seconds integer)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, notify AS $$
DECLARE
  d notify.deliveries;
  v_attempt bigint;
BEGIN
  SELECT * INTO d FROM notify.deliveries
  WHERE id = p_id AND status = 'claimed' AND lease_owner = p_worker
    AND lease_until > now() + make_interval(secs => greatest(coalesce(p_min_seconds, 0), 1))
  FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  UPDATE notify.deliveries SET status = 'sending', last_error = NULL WHERE id = p_id;
  -- Numbered over the delivery's whole life (an operator retry starts the attempt budget again).
  INSERT INTO notify.attempts (delivery_id, attempt_no, worker)
  VALUES (p_id, (SELECT coalesce(max(attempt_no), 0) + 1 FROM notify.attempts WHERE delivery_id = p_id), p_worker)
  RETURNING id INTO v_attempt;
  RETURN v_attempt;
END $$;

/** The provider accepted the delivery (from the send call or from asking the provider afterwards). */
CREATE FUNCTION notify.record_sent(p_id bigint, p_worker text, p_provider text, p_message_id text, p_body_sha256 bytea)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, notify AS $$
DECLARE
  v_now timestamptz := date_trunc('microseconds', clock_timestamp());
  v_attempt bigint;
BEGIN
  IF p_provider IS NULL OR p_message_id IS NULL THEN
    RAISE EXCEPTION 'provider and message id are required' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE notify.deliveries SET status = 'sent', provider = p_provider, provider_message_id = p_message_id, sent_at = v_now,
         lease_owner = NULL, lease_until = NULL, last_error = NULL
  WHERE id = p_id AND status = 'sending' AND lease_owner = p_worker;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE notify.attempts SET finished_at = v_now, outcome = 'accepted', provider = p_provider, provider_message_id = p_message_id,
         body_sha256 = coalesce(p_body_sha256, body_sha256)
  WHERE delivery_id = p_id AND finished_at IS NULL
  RETURNING id INTO v_attempt;
  PERFORM notify.audit_append(p_worker, 'delivery.sent', jsonb_build_object('delivery', p_id, 'attempt', v_attempt,
    'provider', p_provider, 'messageId', p_message_id));
  RETURN true;
END $$;

/**
 * Nothing was accepted by the provider in this attempt (or, p_outcome = 'unknown', the worker gives
 * up asking). 'not_accepted' with attempts left: back to pending with backoff (N-6). 'rejected'
 * (permanent), 'unknown' or no attempts left: dead letter. Allowed from claimed (failure before
 * the provider was called, e.g. a template that cannot be rendered) and from sending.
 */
CREATE FUNCTION notify.record_failure(p_id bigint, p_worker text, p_outcome text, p_error text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, notify AS $$
DECLARE
  d notify.deliveries;
  v_next text;
  v_now timestamptz := date_trunc('microseconds', clock_timestamp());
BEGIN
  IF p_outcome NOT IN ('not_accepted', 'rejected', 'unknown') OR p_outcome IS NULL THEN
    RAISE EXCEPTION 'outcome must be not_accepted, rejected or unknown' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO d FROM notify.deliveries WHERE id = p_id AND status IN ('claimed', 'sending') AND lease_owner = p_worker FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  v_next := CASE WHEN p_outcome <> 'not_accepted' OR d.attempts >= d.max_attempts THEN 'dead' ELSE 'pending' END;
  UPDATE notify.deliveries
  SET status = v_next, lease_owner = NULL, lease_until = NULL, last_error = left(coalesce(p_error, p_outcome), 500),
      available_at = CASE WHEN v_next = 'pending'
                          THEN now() + make_interval(secs => least(3600, 30 * power(2, greatest(d.attempts, 1) - 1)::int))
                          ELSE available_at END
  WHERE id = p_id;
  UPDATE notify.attempts SET finished_at = v_now, outcome = p_outcome, error = left(p_error, 500)
  WHERE delivery_id = p_id AND finished_at IS NULL;
  IF v_next = 'dead' THEN
    PERFORM notify.audit_append(p_worker, 'delivery.dead', jsonb_build_object('delivery', p_id, 'outcome', p_outcome,
      'attempts', d.attempts, 'error', left(p_error, 200)));
    PERFORM pg_notify('notify_alert', json_build_object('kind', 'dead', 'delivery', p_id, 'category', d.category)::text);
  END IF;
  RETURN v_next;
END $$;

/** Keeps a leased delivery a little longer (e.g. a slow provider lookup). */
CREATE FUNCTION notify.extend_lease(p_id bigint, p_worker text, p_seconds integer)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, notify AS $$
  WITH u AS (
    UPDATE notify.deliveries SET lease_until = now() + make_interval(secs => least(greatest(p_seconds, 10), 3600))
    WHERE id = p_id AND status IN ('claimed', 'sending') AND lease_owner = p_worker AND lease_until > now()
    RETURNING 1)
  SELECT count(*) = 1 FROM u
$$;

/** The open attempt's start, for the worker's "unknown for too long" rule. */
CREATE FUNCTION notify.open_attempt_started(p_id bigint) RETURNS timestamptz
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, notify AS $$
  SELECT started_at FROM notify.attempts WHERE delivery_id = p_id AND finished_at IS NULL
$$;

-- ------------------------------------------------------------------ API: operations (N-6)
/** Dead letter: retry it (attempts start again) or abandon it, with a reason. */
CREATE FUNCTION notify.operator_decide(p_id bigint, p_operator text, p_decision text, p_reason text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, notify AS $$
BEGIN
  IF p_operator IS NULL OR p_decision NOT IN ('retry', 'abandon') OR p_decision IS NULL OR p_reason IS NULL OR length(p_reason) < 10 THEN
    RAISE EXCEPTION 'decision must be retry or abandon, by a named operator with a reason of at least 10 characters'
      USING ERRCODE = 'check_violation';
  END IF;
  UPDATE notify.deliveries
  SET status = CASE p_decision WHEN 'retry' THEN 'pending' ELSE 'abandoned' END,
      attempts = CASE WHEN p_decision = 'retry' THEN 0 ELSE attempts END,
      available_at = now(), last_error = left(p_reason, 500)
  WHERE id = p_id AND status = 'dead';
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM notify.audit_append('operator:' || p_operator, 'delivery.' || p_decision, jsonb_build_object('delivery', p_id, 'reason', left(p_reason, 300)));
  IF p_decision = 'retry' THEN PERFORM pg_notify('notify', 'retry'); END IF;
  RETURN true;
END $$;

/** Queue health for monitoring (no personal data). */
CREATE FUNCTION notify.stats()
RETURNS TABLE (status text, deliveries bigint, oldest_seconds double precision)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, notify AS $$
  SELECT status, count(*), extract(epoch FROM now() - min(updated_at)) FROM notify.deliveries GROUP BY status
  UNION ALL
  SELECT 'notification:' || status, count(*), extract(epoch FROM now() - min(created_at))
  FROM notify.notifications WHERE status <> 'queued' GROUP BY status
$$;

-- Read views without hashes or ciphertext.
CREATE VIEW notify.delivery_status AS
  SELECT d.id, d.notification_id, n.kind, d.category, d.channel, d.recipient_id, r.subject_type, r.subject_id, d.status, d.attempts,
         d.max_attempts, d.available_at, d.provider, d.provider_message_id, d.sent_at, d.last_error, d.created_at, d.updated_at
  FROM notify.deliveries d
  JOIN notify.notifications n ON n.id = d.notification_id
  JOIN notify.recipients r ON r.id = d.recipient_id;

CREATE VIEW notify.notification_status AS
  SELECT n.id, n.kind, n.category, n.recipient_id, r.subject_type, r.subject_id, n.status, n.created_by, n.created_at,
         (SELECT count(*) FROM notify.deliveries d WHERE d.notification_id = n.id) AS deliveries,
         (SELECT count(*) FROM notify.deliveries d WHERE d.notification_id = n.id AND d.status = 'sent') AS sent
  FROM notify.notifications n
  JOIN notify.recipients r ON r.id = n.recipient_id;

-- ------------------------------------------------------------------ verification (N-8)
CREATE FUNCTION notify.verify_audit() RETURNS TABLE (audit_id bigint, problem text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, notify AS $$
DECLARE
  a notify.audit;
  v_prev bytea := decode(repeat('00', 32), 'hex');
  d notify.deliveries;
  r record;
BEGIN
  FOR a IN SELECT * FROM notify.audit ORDER BY id LOOP
    IF a.prev_hash <> v_prev THEN audit_id := a.id; problem := 'prev_hash does not match'; RETURN NEXT; END IF;
    IF a.hash <> notify.audit_digest(a.prev_hash, a.id, a.at, a.actor, a.action, a.detail) THEN
      audit_id := a.id; problem := 'content does not match its hash'; RETURN NEXT;
    END IF;
    IF a.action = 'delivery.sent' THEN
      SELECT * INTO d FROM notify.deliveries WHERE id = (a.detail->>'delivery')::bigint;
      IF NOT FOUND OR d.status IS DISTINCT FROM 'sent' OR d.provider_message_id IS DISTINCT FROM a.detail->>'messageId'
         OR d.provider IS DISTINCT FROM a.detail->>'provider' THEN
        audit_id := a.id; problem := format('delivery %s changed after it was sent', a.detail->>'delivery'); RETURN NEXT;
      END IF;
    END IF;
    v_prev := a.hash;
  END LOOP;
  -- Rows that exist without the audit entry their API function always writes: written directly.
  FOR r IN SELECT x.id::text AS id, 'recipient' AS what FROM notify.recipients x
             WHERE NOT EXISTS (SELECT 1 FROM notify.audit y WHERE y.action = 'recipient.registered' AND y.detail->>'recipient' = x.id::text)
           UNION ALL
           SELECT x.id::text, 'contact' FROM notify.contacts x
             WHERE NOT EXISTS (SELECT 1 FROM notify.audit y WHERE y.action = 'contact.registered' AND (y.detail->>'contact')::bigint = x.id)
           UNION ALL
           SELECT x.id::text, 'preference' FROM notify.preferences x
             WHERE NOT EXISTS (SELECT 1 FROM notify.audit y WHERE y.action = 'preference.set' AND (y.detail->>'preference')::bigint = x.id)
           UNION ALL
           SELECT x.id::text, 'template' FROM notify.templates x
             WHERE NOT EXISTS (SELECT 1 FROM notify.audit y WHERE y.action = 'template.added' AND (y.detail->>'template')::bigint = x.id
                               AND y.detail->>'sha256' = encode(x.body_sha256, 'hex'))
           UNION ALL
           SELECT x.id::text, 'notification' FROM notify.notifications x
             WHERE NOT EXISTS (SELECT 1 FROM notify.audit y WHERE y.action = 'notification.enqueued' AND (y.detail->>'notification')::bigint = x.id
                               AND y.detail->>'status' = x.status)
           UNION ALL
           SELECT x.id::text, 'delivery' FROM notify.deliveries x
             WHERE NOT EXISTS (SELECT 1 FROM notify.audit y WHERE y.action = 'notification.enqueued'
                               AND (y.detail->>'notification')::bigint = x.notification_id AND y.detail->'deliveries' @> to_jsonb(x.id))
              OR (x.status = 'sent' AND NOT EXISTS (SELECT 1 FROM notify.audit y WHERE y.action = 'delivery.sent' AND (y.detail->>'delivery')::bigint = x.id))
              OR (x.status = 'dead' AND NOT EXISTS (SELECT 1 FROM notify.audit y WHERE y.action = 'delivery.dead' AND (y.detail->>'delivery')::bigint = x.id)) LOOP
    audit_id := NULL; problem := format('%s %s has no audit entry', r.what, r.id); RETURN NEXT;
  END LOOP;
END $$;

-- ------------------------------------------------------------------ templates (seed, version 1)
-- Plain text; the renderer escapes every value for the channel and wraps Urdu for right-to-left.
-- No links in any message (phishing defence): investors are told to open the app themselves.
SELECT notify.add_template(t.kind, t.channel, t.locale, t.subject, t.body, 'migration:0017')
FROM (VALUES
  -- security.new_device_sign_in
  ('security.new_device_sign_in', 'sms', 'en', NULL,
   'Property Token: new sign-in from {{device}} at {{at}}. If this was not you, contact support in the app now. We never ask for codes.'),
  ('security.new_device_sign_in', 'sms', 'ur', NULL,
   'پراپرٹی ٹوکن: {{device}} سے {{at}} پر نیا لاگ اِن۔ اگر یہ آپ نہیں تھے تو فوراً ایپ میں سپورٹ سے رابطہ کریں۔ ہم کبھی کوڈ نہیں مانگتے۔'),
  ('security.new_device_sign_in', 'email', 'en', 'New sign-in to your Property Token account',
   E'Your account was signed in from a new device: {{device}}, at {{at}}.\n\nIf this was you, no action is needed.\nIf this was not you, open the Property Token app yourself (do not use links in messages) and contact support now. We never ask for codes or passwords.'),
  ('security.new_device_sign_in', 'email', 'ur', 'آپ کے پراپرٹی ٹوکن اکاؤنٹ میں نیا لاگ اِن',
   E'آپ کے اکاؤنٹ میں ایک نئی ڈیوائس سے لاگ اِن ہوا: {{device}}، وقت {{at}}۔\n\nاگر یہ آپ تھے تو کچھ کرنے کی ضرورت نہیں۔\nاگر یہ آپ نہیں تھے تو پراپرٹی ٹوکن ایپ خود کھولیں (پیغامات میں دیے گئے لنک استعمال نہ کریں) اور فوراً سپورٹ سے رابطہ کریں۔ ہم کبھی کوڈ یا پاس ورڈ نہیں مانگتے۔'),
  -- security.contact_changed
  ('security.contact_changed', 'sms', 'en', NULL,
   'Property Token: your {{channel}} contact was changed at {{at}}. If you did not do this, contact support in the app now.'),
  ('security.contact_changed', 'sms', 'ur', NULL,
   'پراپرٹی ٹوکن: آپ کا {{channel}} رابطہ {{at}} پر تبدیل کیا گیا۔ اگر یہ آپ نے نہیں کیا تو فوراً ایپ میں سپورٹ سے رابطہ کریں۔'),
  ('security.contact_changed', 'email', 'en', 'Your Property Token contact details changed',
   E'Your {{channel}} contact was changed at {{at}}.\n\nIf you made this change, no action is needed.\nIf you did not, open the Property Token app yourself and contact support now.'),
  ('security.contact_changed', 'email', 'ur', 'آپ کے پراپرٹی ٹوکن رابطے کی تفصیل تبدیل ہوئی',
   E'آپ کا {{channel}} رابطہ {{at}} پر تبدیل کیا گیا۔\n\nاگر یہ تبدیلی آپ نے کی ہے تو کچھ کرنے کی ضرورت نہیں۔\nاگر نہیں، تو پراپرٹی ٹوکن ایپ خود کھولیں اور فوراً سپورٹ سے رابطہ کریں۔'),
  -- security.payout_account_added
  ('security.payout_account_added', 'sms', 'en', NULL,
   'Property Token: payout bank account ending {{last4}} was added. It can receive payouts from {{active_from}}. Not you? Contact support in the app before then.'),
  ('security.payout_account_added', 'sms', 'ur', NULL,
   'پراپرٹی ٹوکن: بینک اکاؤنٹ (آخری ہندسے {{last4}}) شامل کیا گیا۔ ادائیگیاں {{active_from}} سے ہوں گی۔ اگر یہ آپ نہیں تھے تو اس سے پہلے سپورٹ سے رابطہ کریں۔'),
  ('security.payout_account_added', 'email', 'en', 'A payout bank account was added',
   E'A payout bank account ending {{last4}} was added to your account.\n\nFor your protection it can receive payouts only from {{active_from}} (72-hour waiting period).\nIf you did not add it, open the Property Token app yourself and contact support before then.'),
  ('security.payout_account_added', 'email', 'ur', 'ادائیگی کے لیے بینک اکاؤنٹ شامل کیا گیا',
   E'آپ کے اکاؤنٹ میں ادائیگی کے لیے ایک بینک اکاؤنٹ (آخری ہندسے {{last4}}) شامل کیا گیا۔\n\nآپ کی حفاظت کے لیے اس میں ادائیگیاں صرف {{active_from}} سے ہوں گی (72 گھنٹے کا انتظار)۔\nاگر یہ آپ نے شامل نہیں کیا تو پراپرٹی ٹوکن ایپ خود کھولیں اور اس سے پہلے سپورٹ سے رابطہ کریں۔'),
  -- security.payout_account_changed
  ('security.payout_account_changed', 'sms', 'en', NULL,
   'Property Token: payout account changed from ending {{previous_last4}} to ending {{last4}}. Payouts go to it from {{active_from}}. Not you? Contact support in the app now.'),
  ('security.payout_account_changed', 'sms', 'ur', NULL,
   'پراپرٹی ٹوکن: ادائیگی کا اکاؤنٹ {{previous_last4}} سے {{last4}} میں تبدیل ہوا۔ ادائیگیاں {{active_from}} سے ہوں گی۔ اگر یہ آپ نہیں تھے تو فوراً سپورٹ سے رابطہ کریں۔'),
  ('security.payout_account_changed', 'email', 'en', 'Your payout bank account was changed',
   E'Your payout bank account was changed from the account ending {{previous_last4}} to the account ending {{last4}}.\n\nFor your protection the new account can receive payouts only from {{active_from}} (72-hour waiting period).\nIf you did not make this change, open the Property Token app yourself and contact support now.'),
  ('security.payout_account_changed', 'email', 'ur', 'ادائیگی کا بینک اکاؤنٹ تبدیل ہوا',
   E'آپ کا ادائیگی کا بینک اکاؤنٹ (آخری ہندسے {{previous_last4}}) سے (آخری ہندسے {{last4}}) میں تبدیل کیا گیا۔\n\nآپ کی حفاظت کے لیے نئے اکاؤنٹ میں ادائیگیاں صرف {{active_from}} سے ہوں گی (72 گھنٹے کا انتظار)۔\nاگر یہ تبدیلی آپ نے نہیں کی تو پراپرٹی ٹوکن ایپ خود کھولیں اور فوراً سپورٹ سے رابطہ کریں۔'),
  -- security.payout_account_active
  ('security.payout_account_active', 'sms', 'en', NULL,
   'Property Token: payout account ending {{last4}} can now receive payouts (72-hour waiting period ended).'),
  ('security.payout_account_active', 'sms', 'ur', NULL,
   'پراپرٹی ٹوکن: بینک اکاؤنٹ (آخری ہندسے {{last4}}) اب ادائیگیوں کے لیے فعال ہے۔ 72 گھنٹے کا انتظار ختم ہو گیا۔'),
  ('security.payout_account_active', 'email', 'en', 'Your payout bank account is now active',
   E'The 72-hour waiting period has ended. Your payout bank account ending {{last4}} can now receive payouts.\n\nIf you do not recognise this account, open the Property Token app yourself and contact support.'),
  ('security.payout_account_active', 'email', 'ur', 'آپ کا ادائیگی کا بینک اکاؤنٹ اب فعال ہے',
   E'72 گھنٹے کا انتظار ختم ہو گیا۔ آپ کا بینک اکاؤنٹ (آخری ہندسے {{last4}}) اب ادائیگیاں وصول کر سکتا ہے۔\n\nاگر آپ یہ اکاؤنٹ نہیں پہچانتے تو پراپرٹی ٹوکن ایپ خود کھولیں اور سپورٹ سے رابطہ کریں۔'),
  -- security.kyc_status_changed
  ('security.kyc_status_changed', 'sms', 'en', NULL,
   'Property Token: your verification status is now: {{status}}. Details are in the app.'),
  ('security.kyc_status_changed', 'sms', 'ur', NULL,
   'پراپرٹی ٹوکن: آپ کی تصدیق کی حیثیت اب یہ ہے: {{status}}۔ تفصیل ایپ میں دیکھیں۔'),
  ('security.kyc_status_changed', 'email', 'en', 'Your verification status changed',
   E'Your identity verification status is now: {{status}}.\n\nOpen the Property Token app yourself to see what it means for your account and whether anything is needed from you.'),
  ('security.kyc_status_changed', 'email', 'ur', 'آپ کی تصدیق کی حیثیت تبدیل ہوئی',
   E'آپ کی شناخت کی تصدیق کی حیثیت اب یہ ہے: {{status}}۔\n\nپراپرٹی ٹوکن ایپ خود کھول کر دیکھیں کہ اس کا آپ کے اکاؤنٹ پر کیا اثر ہے اور کیا آپ سے کچھ درکار ہے۔'),
  -- security.account_frozen / unfrozen
  ('security.account_frozen', 'sms', 'en', NULL,
   'Property Token: your account was frozen at {{at}}. Contact support in the app for next steps.'),
  ('security.account_frozen', 'sms', 'ur', NULL,
   'پراپرٹی ٹوکن: آپ کا اکاؤنٹ {{at}} پر منجمد کر دیا گیا۔ مزید معلومات کے لیے ایپ میں سپورٹ سے رابطہ کریں۔'),
  ('security.account_frozen', 'email', 'en', 'Your Property Token account was frozen',
   E'Your account was frozen at {{at}}. While it is frozen, your units cannot move and payouts are held.\n\nOpen the Property Token app yourself and contact support for next steps.'),
  ('security.account_frozen', 'email', 'ur', 'آپ کا پراپرٹی ٹوکن اکاؤنٹ منجمد کر دیا گیا',
   E'آپ کا اکاؤنٹ {{at}} پر منجمد کر دیا گیا۔ اس دوران آپ کے یونٹ منتقل نہیں ہو سکتے اور ادائیگیاں روک لی جاتی ہیں۔\n\nپراپرٹی ٹوکن ایپ خود کھولیں اور مزید معلومات کے لیے سپورٹ سے رابطہ کریں۔'),
  ('security.account_unfrozen', 'sms', 'en', NULL,
   'Property Token: the freeze on your account was lifted at {{at}}.'),
  ('security.account_unfrozen', 'sms', 'ur', NULL,
   'پراپرٹی ٹوکن: آپ کے اکاؤنٹ پر پابندی {{at}} پر ختم کر دی گئی۔'),
  ('security.account_unfrozen', 'email', 'en', 'The freeze on your Property Token account was lifted',
   E'The freeze on your account was lifted at {{at}}.\n\nIf you have questions, open the Property Token app yourself and contact support.'),
  ('security.account_unfrozen', 'email', 'ur', 'آپ کے پراپرٹی ٹوکن اکاؤنٹ پر پابندی ختم',
   E'آپ کے اکاؤنٹ پر پابندی {{at}} پر ختم کر دی گئی۔\n\nکسی سوال کے لیے پراپرٹی ٹوکن ایپ خود کھولیں اور سپورٹ سے رابطہ کریں۔'),
  -- security.large_transaction_pending
  ('security.large_transaction_pending', 'sms', 'en', NULL,
   'Property Token: a transaction of {{amount_paisa}} (ref {{reference}}) is waiting for approval. Not you? Contact support in the app now.'),
  ('security.large_transaction_pending', 'sms', 'ur', NULL,
   'پراپرٹی ٹوکن: {{amount_paisa}} کی ایک لین دین (حوالہ {{reference}}) منظوری کی منتظر ہے۔ اگر یہ آپ نہیں تھے تو فوراً سپورٹ سے رابطہ کریں۔'),
  ('security.large_transaction_pending', 'email', 'en', 'A large transaction is waiting for approval',
   E'A transaction of {{amount_paisa}} on your account (reference {{reference}}) is above the approval threshold and is waiting for a second approval.\n\nIf you did not start it, open the Property Token app yourself and contact support now.'),
  ('security.large_transaction_pending', 'email', 'ur', 'ایک بڑی لین دین منظوری کی منتظر ہے',
   E'آپ کے اکاؤنٹ پر {{amount_paisa}} کی ایک لین دین (حوالہ {{reference}}) منظوری کی حد سے زیادہ ہے اور دوسری منظوری کی منتظر ہے۔\n\nاگر یہ آپ نے شروع نہیں کی تو پراپرٹی ٹوکن ایپ خود کھولیں اور فوراً سپورٹ سے رابطہ کریں۔'),
  -- offering.reservation_expiring (transactional)
  ('offering.reservation_expiring', 'sms', 'en', NULL,
   'Property Token: your reservation in {{offering}} for {{amount_paisa}} expires at {{expires_at}}. Pay with your payment code before then.'),
  ('offering.reservation_expiring', 'sms', 'ur', NULL,
   'پراپرٹی ٹوکن: {{offering}} میں آپ کی {{amount_paisa}} کی بکنگ {{expires_at}} پر ختم ہو جائے گی۔ اس سے پہلے ادائیگی کریں۔'),
  ('offering.reservation_expiring', 'email', 'en', 'Your reservation expires soon',
   E'Your reservation in {{offering}} for {{amount_paisa}} expires at {{expires_at}}.\n\nPay the exact amount with the payment code shown in the Property Token app before then, or the reservation lapses.'),
  ('offering.reservation_expiring', 'email', 'ur', 'آپ کی بکنگ جلد ختم ہو رہی ہے',
   E'{{offering}} میں آپ کی {{amount_paisa}} کی بکنگ {{expires_at}} پر ختم ہو جائے گی۔\n\nاس سے پہلے پراپرٹی ٹوکن ایپ میں دکھائے گئے ادائیگی کوڈ کے ساتھ پوری رقم ادا کریں، ورنہ بکنگ ختم ہو جائے گی۔'),
  -- rent.paid (transactional)
  ('rent.paid', 'sms', 'en', NULL,
   'Property Token: rent of {{amount_paisa}} for {{token}} ({{period}}) was paid to your bank account.'),
  ('rent.paid', 'sms', 'ur', NULL,
   'پراپرٹی ٹوکن: {{token}} کا کرایہ {{amount_paisa}} ({{period}}) آپ کے بینک اکاؤنٹ میں بھیج دیا گیا۔'),
  ('rent.paid', 'email', 'en', 'Rent paid to your bank account',
   E'Rent of {{amount_paisa}} for {{token}} (period {{period}}) was paid to your payout bank account.\n\nYour statement and the on-chain proof are in the Property Token app.'),
  ('rent.paid', 'email', 'ur', 'کرایہ آپ کے بینک اکاؤنٹ میں بھیج دیا گیا',
   E'{{token}} کا کرایہ {{amount_paisa}} (مدت {{period}}) آپ کے ادائیگی کے بینک اکاؤنٹ میں بھیج دیا گیا۔\n\nآپ کا گوشوارہ اور آن چین ثبوت پراپرٹی ٹوکن ایپ میں موجود ہیں۔')
) AS t(kind, channel, locale, subject, body);

-- ------------------------------------------------------------------ privileges (N-9)
REVOKE ALL ON ALL TABLES IN SCHEMA notify FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA notify FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA notify FROM PUBLIC;

GRANT USAGE ON SCHEMA notify TO pt_notify_producer, pt_notify_service, pt_notify_worker, pt_notify_operator, pt_notify_reader;
-- The narrow grant for other services: enqueue only (inside their own transaction).
GRANT EXECUTE ON FUNCTION notify.enqueue(text, text, text, text, jsonb, text) TO pt_notify_producer, pt_notify_service;
GRANT EXECUTE ON FUNCTION
  notify.register_recipient(text, text, text, text),
  notify.set_locale(uuid, text, text),
  notify.register_contact(uuid, text, bytea, bytea, smallint, text),
  notify.set_preference(uuid, text, boolean, text)
  TO pt_notify_service;
GRANT EXECUTE ON FUNCTION
  notify.claim(text, integer, integer),
  notify.delivery_material(bigint, text),
  notify.begin_attempt(bigint, text, integer),
  notify.record_sent(bigint, text, text, text, bytea),
  notify.record_failure(bigint, text, text, text),
  notify.extend_lease(bigint, text, integer),
  notify.open_attempt_started(bigint)
  TO pt_notify_worker;
GRANT EXECUTE ON FUNCTION notify.operator_decide(bigint, text, text, text), notify.add_template(text, text, text, text, text, text) TO pt_notify_operator;
GRANT EXECUTE ON FUNCTION notify.stats() TO pt_notify_worker, pt_notify_operator, pt_notify_reader;
GRANT EXECUTE ON FUNCTION notify.verify_audit() TO pt_notify_operator, pt_notify_reader;
GRANT SELECT ON notify.delivery_status, notify.notification_status, notify.event_kinds, notify.rate_limits TO pt_notify_operator, pt_notify_reader;
GRANT SELECT ON notify.templates, notify.audit TO pt_notify_operator;

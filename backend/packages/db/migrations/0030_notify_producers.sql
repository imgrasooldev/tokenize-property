-- Notification producers (task T-028 follow-ups, ADR 0013 amendment 1): real business events now
-- raise notifications, in the same transaction as the change that caused them.
--
-- Numbered 0030: 0027, 0028 and 0029 are reserved for branches built in parallel. Nothing here
-- depends on them. Until they are merged the backend runner refuses the gap (tests use
-- contiguousMigrations()). No earlier migration is edited; functions of 0017 are replaced here.
--
-- Safety properties enforced by the database itself (rule IDs NP-n):
--   NP-1  Outbox style, same transaction. Every producer is a DEFERRABLE INITIALLY DEFERRED
--         constraint trigger on the table where the business change is recorded (or a sweep for
--         time-based reminders). It runs at COMMIT of the business transaction: a rollback leaves
--         no notification, a commit always has it. Running at commit also takes notify's global
--         audit lock after every business lock, in every transaction (no lock-order deadlock).
--         No producer function of another module is redefined, so branches that change those
--         functions do not conflict with this one.
--   NP-2  Exactly one notification per business event and recipient. The idempotency key is
--         derived from the row that records the event (an append-only event row, a state-change
--         row, or a sweep's stable key), so a retried business call that records nothing new,
--         a re-run sweep or a trigger firing twice returns the existing notification (N-4).
--   NP-3  A notification never blocks the business change. notify.produce() runs the enqueue in
--         a subtransaction; if it fails (bug, bad value) the business change still commits, the
--         failure is kept in notify.producer_failures (append-only, audited) and raised on
--         NOTIFY notify_alert. Transaction-level errors (serialisation, deadlock, cancel,
--         resources: SQLSTATE classes 40, 53, 57) are re-raised so the caller retries.
--   NP-4  No tipping-off. Investor notices use generic words only. Nothing is sent to an investor
--         for a KYC 'review', 'rejected' or 'revoked' decision, a compliance hold, a blocked or
--         disputed subscription, a credit held because the investor is not verified, or a rent
--         line held for a KYC reason; compliance communicates those by hand (owner question 6c).
--         A KYC case's request for information reaches the investor only for a manual case, as
--         the generic "action required". A trigger refuses any new investor template (every kind
--         outside officer.*) containing sanctions, PEP, STR, suspicious, freeze/frozen, FMU,
--         laundering, terrorism, watch/black list, compliance (or their Urdu words).
--   NP-5  Consent. Security notices always go out (N-3). Transactional notices go out on every
--         channel the recipient did not switch off (N-3) and ALWAYS appear in the in-app
--         notification centre. Marketing (new category) needs an explicit opt-in per channel,
--         recorded with the version of the consent text (notify.consents, append-only, audited);
--         default off; without it a marketing notice is 'suppressed' and never shown.
--   NP-6  Rate limits per recipient and channel and hour (N-7) now also cover marketing
--         (2 SMS, 2 e-mails); over the limit a delivery is deferred, never dropped.
--   NP-7  Officer alerts (approvals waiting, reconciliation payout pause, SLA breach, copied
--         passkey) go to every ACTIVE officer holding the responsible role (or offering duty),
--         as recipient type 'officer' (the handle). The officer who made a request is not told
--         about their own request.
--   NP-8  The investor notification centre: the website (pt_web) may execute only the
--         session-bound notify.web_* functions. Each derives the investor and their KYC subject
--         from the live website session (webauth, IP-1) and reads or changes only that
--         recipient's notifications, reads and preferences. Reads are kept in notify.inbox_reads
--         (append-only: a notice is read once).
--   NP-9  New placeholder type 'count' (whole units); every new kind has SMS and e-mail
--         templates in English and Urdu. Quiet hours are not part of ADR 0013 and are not built
--         (owner question).

-- ================================================================== catalogue: marketing category, count type
DO $$
DECLARE
  r record;
BEGIN
  -- Drop the CHECK constraints of 0017 that name the categories (auto-generated names).
  FOR r IN SELECT c.conrelid::regclass AS tbl, c.conname
           FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
           WHERE n.nspname = 'notify' AND c.contype = 'c' AND pg_get_constraintdef(c.oid) LIKE '%transactional%' LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
  END LOOP;
END $$;
ALTER TABLE notify.event_kinds ADD CONSTRAINT event_kinds_category_check CHECK (category IN ('security', 'transactional', 'marketing'));
ALTER TABLE notify.notifications ADD CONSTRAINT notifications_category_check CHECK (category IN ('security', 'transactional', 'marketing'));
ALTER TABLE notify.notifications ADD CONSTRAINT notifications_suppressed_check CHECK (status <> 'suppressed' OR category IN ('transactional', 'marketing'));
ALTER TABLE notify.deliveries ADD CONSTRAINT deliveries_category_check CHECK (category IN ('security', 'transactional', 'marketing'));
ALTER TABLE notify.rate_limits ADD CONSTRAINT rate_limits_category_check CHECK (category IN ('security', 'transactional', 'marketing'));
INSERT INTO notify.rate_limits VALUES ('marketing', 'sms', 2), ('marketing', 'email', 2), ('marketing', 'push', 2);

/** N-2 with NP-9: as 0017, plus the type 'count' (a whole number of units). */
CREATE OR REPLACE FUNCTION notify.params_problem(p_kind text, p_params jsonb) RETURNS text
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
    ELSIF t = 'count' THEN
      IF s !~ '^(0|[1-9][0-9]{0,17})$' THEN RETURN format('parameter %s must be a whole number', k); END IF;
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
      IF coalesce((v -> 'choices') ? s, false) IS NOT TRUE THEN
        RETURN format('parameter %s must be one of %s', k, coalesce(v -> 'choices', '[]'::jsonb));
      END IF;
    ELSE
      RETURN format('placeholder %s has an unknown type', k);
    END IF;
  END LOOP;
  RETURN NULL;
END $$;

-- ================================================================== NP-4 tipping-off guard on templates
/** The first word of an investor text that could tip someone off, or NULL. */
CREATE FUNCTION notify.tipping_off_word(p text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT coalesce(
    (regexp_match(lower(coalesce(p, '')),
      '\m(sanction[a-z]*|peps?|str|suspicious|suspicion|unfreez[a-z]*|freez[a-z]*|frozen|fmu|launder[a-z]*|terror[a-z]*|watch ?lists?|black ?list[a-z]*|politically exposed|compliance|aml)\M'))[1],
    (regexp_match(coalesce(p, ''), '(منجمد|مشکوک|پابندی|لانڈرنگ|دہشت|کمپلائنس)'))[1])
$$;

CREATE FUNCTION notify.guard_template_words() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, notify AS $$
DECLARE
  v_word text;
BEGIN
  IF NEW.kind NOT LIKE 'officer.%' THEN
    v_word := notify.tipping_off_word(coalesce(NEW.subject, '') || ' ' || NEW.body);
    IF v_word IS NOT NULL THEN
      RAISE EXCEPTION 'investor template for % uses "%": investor notices must stay generic (no tipping-off, NP-4)', NEW.kind, v_word
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER templates_no_tipping_off BEFORE INSERT ON notify.templates FOR EACH ROW EXECUTE FUNCTION notify.guard_template_words();

-- ================================================================== NP-5 marketing consent
CREATE TABLE notify.consents (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  recipient_id uuid NOT NULL REFERENCES notify.recipients (id),
  channel      text NOT NULL CHECK (channel IN ('sms', 'email')),
  granted      boolean NOT NULL,
  -- Which consent text the investor saw (e.g. mkt-2026-10); the text itself lives in the website.
  text_version text NOT NULL CHECK (text_version ~ '^[a-z][a-z0-9.-]{2,31}$'),
  set_at       timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  set_by       text NOT NULL CHECK (length(set_by) BETWEEN 1 AND 100)
);
CREATE INDEX consents_current_idx ON notify.consents (recipient_id, channel, id DESC);
CREATE TRIGGER consents_no_change BEFORE UPDATE OR DELETE ON notify.consents FOR EACH ROW EXECUTE FUNCTION notify.forbid_change();
CREATE TRIGGER consents_no_truncate BEFORE TRUNCATE ON notify.consents FOR EACH STATEMENT EXECUTE FUNCTION notify.forbid_change();

/** Records a marketing opt-in or opt-out for one channel (the latest row counts). */
CREATE FUNCTION notify.set_marketing_consent(p_recipient uuid, p_channel text, p_granted boolean, p_text_version text, p_actor text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, notify AS $$
DECLARE
  v_id bigint;
BEGIN
  IF p_recipient IS NULL OR p_channel IS NULL OR p_granted IS NULL OR p_text_version IS NULL OR p_actor IS NULL THEN
    RAISE EXCEPTION 'recipient, channel, granted, consent text version and actor are required' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO notify.consents (recipient_id, channel, granted, text_version, set_by)
  VALUES (p_recipient, p_channel, p_granted, p_text_version, p_actor) RETURNING id INTO v_id;
  PERFORM notify.audit_append(p_actor, 'consent.set', jsonb_build_object('consent', v_id, 'recipient', p_recipient, 'channel', p_channel,
    'granted', p_granted, 'textVersion', p_text_version));
  RETURN v_id;
END $$;

/** NP-5: marketing on a channel only after an explicit, current opt-in (default off). */
CREATE FUNCTION notify.marketing_allowed(p_recipient uuid, p_channel text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, notify AS $$
  SELECT coalesce((SELECT granted FROM notify.consents WHERE recipient_id = p_recipient AND channel = p_channel ORDER BY id DESC LIMIT 1), false)
$$;

/** Whether a notice of this category may use this channel for this recipient (N-3, NP-5). */
CREATE FUNCTION notify.channel_allowed(p_category text, p_recipient uuid, p_channel text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, notify AS $$
  SELECT CASE p_category
    WHEN 'security' THEN true
    WHEN 'transactional' THEN notify.channel_enabled(p_recipient, p_channel)
    WHEN 'marketing' THEN notify.marketing_allowed(p_recipient, p_channel)
    ELSE false END
$$;

/** As 0017 (N-2..N-4), with the marketing category: opt-in channels only, 3 attempts. */
CREATE OR REPLACE FUNCTION notify.enqueue_internal(p_key text, p_kind text, p_recipient uuid, p_params jsonb, p_actor text, p_extra_contact bigint)
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
  v_status := CASE
    WHEN EXISTS (SELECT 1 FROM notify.contacts c2
                 WHERE ((c2.recipient_id = p_recipient AND c2.superseded_at IS NULL) OR c2.id = p_extra_contact)
                   AND notify.channel_allowed(k.category, p_recipient, c2.channel)
                   AND notify.current_template(p_kind, c2.channel, r.locale) IS NOT NULL) THEN 'queued'
    WHEN k.category = 'security' THEN 'undeliverable'
    ELSE 'suppressed' END;
  INSERT INTO notify.notifications (id, idempotency_key, kind, category, recipient_id, params, content_hash, status, created_by)
  OVERRIDING SYSTEM VALUE
  VALUES (v_id, p_key, p_kind, k.category, p_recipient, p_params, v_hash, v_status, p_actor)
  ON CONFLICT (idempotency_key) DO NOTHING;
  IF NOT FOUND THEN
    SELECT * INTO v_existing FROM notify.notifications WHERE idempotency_key = p_key;
    IF v_existing.content_hash <> v_hash THEN
      RAISE EXCEPTION 'idempotency key % was already used for a different notification', p_key USING ERRCODE = 'unique_violation';
    END IF;
    RETURN v_existing.id;
  END IF;

  FOR c IN SELECT * FROM notify.contacts c2
           WHERE (c2.recipient_id = p_recipient AND c2.superseded_at IS NULL) OR c2.id = p_extra_contact
           ORDER BY c2.id LOOP
    CONTINUE WHEN NOT notify.channel_allowed(k.category, p_recipient, c.channel);
    v_template := notify.current_template(p_kind, c.channel, r.locale);
    CONTINUE WHEN v_template IS NULL;
    INSERT INTO notify.deliveries (notification_id, recipient_id, category, channel, contact_id, template_id, max_attempts)
    VALUES (v_id, p_recipient, k.category, c.channel, c.id, v_template,
            CASE k.category WHEN 'security' THEN 8 WHEN 'transactional' THEN 5 ELSE 3 END)
    RETURNING id INTO v_delivery;
    v_deliveries := v_deliveries || to_jsonb(v_delivery);
  END LOOP;

  PERFORM notify.audit_append(p_actor, 'notification.enqueued', jsonb_build_object('notification', v_id, 'kind', p_kind,
    'recipient', p_recipient, 'status', v_status, 'deliveries', v_deliveries));
  IF v_status = 'undeliverable' THEN
    PERFORM pg_notify('notify_alert', json_build_object('kind', 'undeliverable', 'notification', v_id, 'event', p_kind)::text);
  ELSIF v_status = 'queued' THEN
    PERFORM pg_notify('notify', v_id::text);
  END IF;
  RETURN v_id;
END $$;

-- ================================================================== event kinds (NP-9)
INSERT INTO notify.event_kinds (kind, category, placeholders, description) VALUES
  ('offering.reserved', 'transactional',
   '{"offering": {"type": "label"}, "amount_paisa": {"type": "paisa"}, "expires_at": {"type": "utc"}}',
   'Units of an offering were reserved; the investor must pay with the payment code before the time (S-02 V2/V5/V7).'),
  ('offering.payment_received', 'transactional',
   '{"offering": {"type": "label"}, "amount_paisa": {"type": "paisa"}}',
   'The exact payment for a reservation was matched (S-02 V9).'),
  ('offering.allocated', 'transactional',
   '{"offering": {"type": "label"}, "units": {"type": "count"}}',
   'The offering was funded and the paid units are allocated to the investor (S-02 V12).'),
  ('offering.units_issued', 'transactional',
   '{"offering": {"type": "label"}, "units": {"type": "count"}}',
   'The units were minted to the investor''s wallet at completion (S-02 V14/V17).'),
  ('offering.reservation_expired', 'transactional',
   '{"offering": {"type": "label"}}',
   'An unpaid reservation or a waiting-list place ended without payment (S-02 V8/V10).'),
  ('offering.reservation_cancelled', 'transactional',
   '{"offering": {"type": "label"}}',
   'The investor cancelled an unpaid reservation or left the waiting list (S-02 V11).'),
  ('offering.waitlisted', 'transactional',
   '{"offering": {"type": "label"}}',
   'No units were free; the investor is on the waiting list (S-02 V3).'),
  ('offering.not_accepted', 'transactional',
   '{"offering": {"type": "label"}}',
   'A reservation request could not be accepted (S-02 V4/V6). Generic: the reason is shown in the app only as its public wording.'),
  ('offering.refund_pending', 'transactional',
   '{"offering": {"type": "label"}, "amount_paisa": {"type": "paisa"}}',
   'A refund of a paid subscription is being prepared (S-02 V13/V15). Generic: never the cause.'),
  ('offering.refunded', 'transactional',
   '{"offering": {"type": "label"}, "amount_paisa": {"type": "paisa"}}',
   'A refund was sent back to the paying account (S-02 V20).'),
  ('bank.payment_unmatched', 'transactional',
   '{"amount_paisa": {"type": "paisa"}, "at": {"type": "utc"}}',
   'A credit carrying the investor''s payment code could not be matched (wrong amount, late, cancelled, or not from a registered account).'),
  ('rent.distributed', 'transactional',
   '{"token": {"type": "label"}, "amount_paisa": {"type": "paisa"}, "period": {"type": "code"}}',
   'A rent distribution was booked; the investor''s net share after withholding tax is credited (S-03).'),
  ('rent.held', 'transactional',
   '{"token": {"type": "code"}, "amount_paisa": {"type": "paisa"}, "period": {"type": "code"}}',
   'The investor''s rent line was held because no payout account is active yet (0010 H-1).'),
  ('rent.payout_returned', 'transactional',
   '{"token": {"type": "code"}, "amount_paisa": {"type": "paisa"}}',
   'The investor''s bank returned a rent payout.'),
  ('tax.certificate_available', 'transactional',
   '{"fiscal_year": {"type": "code"}}',
   'The annual withholding tax certificate was issued or re-issued (S-03 OP-51).'),
  ('security.passkey_added', 'security',
   '{"at": {"type": "utc"}}',
   'A passkey was registered on the investor''s account (T-030).'),
  ('security.passkey_removed', 'security',
   '{"at": {"type": "utc"}}',
   'The investor removed a passkey (T-030).'),
  ('security.passkey_disabled', 'security',
   '{"at": {"type": "utc"}}',
   'A passkey was switched off because its signature counter went backwards (possible copy, T-030 IP-4).'),
  ('marketing.offering_open', 'marketing',
   '{"offering": {"type": "label"}}',
   'A new offering opened (S-02 L5). Marketing: only to investors who opted in on that channel.'),
  ('officer.action_waiting', 'transactional',
   '{"queue": {"type": "word", "choices": ["signing", "trustee_cosign", "offering_request", "payout_release", "kyc_review", "freeze_decision", "compliance_case", "distribution_approval", "trustee_precheck", "distribution_review"]}, "reference": {"type": "code"}}',
   'An item waits in an officer''s queue in PT Control (approvals, reviews, decisions).'),
  ('officer.alert', 'security',
   '{"topic": {"type": "word", "choices": ["payouts_paused", "payouts_resumed", "passkey_clone", "sla_breach"]}, "reference": {"type": "code"}, "at": {"type": "utc"}}',
   'An operational alert for officers: reconciliation paused or resumed payouts, a copied passkey, a missed service level.');

-- ================================================================== templates (version 1 of the new kinds; v2 of two old ones)
SELECT notify.add_template(t.kind, t.channel, t.locale, t.subject, t.body, 'migration:0030')
FROM (VALUES
  -- offering.reserved
  ('offering.reserved', 'sms', 'en', NULL,
   'Property Token: units in {{offering}} are reserved. Pay {{amount_paisa}} with the payment code shown in the app before {{expires_at}}.'),
  ('offering.reserved', 'sms', 'ur', NULL,
   'پراپرٹی ٹوکن: {{offering}} میں یونٹ بک ہو گئے۔ {{expires_at}} سے پہلے ایپ میں دیے گئے کوڈ سے {{amount_paisa}} ادا کریں۔'),
  ('offering.reserved', 'email', 'en', 'Your units are reserved',
   E'Units in {{offering}} are reserved for you.\n\nPay exactly {{amount_paisa}} by Raast with the payment code shown in the Property Token app before {{expires_at}}. After that time the reservation lapses.'),
  ('offering.reserved', 'email', 'ur', 'آپ کے یونٹ بک ہو گئے',
   E'{{offering}} میں آپ کے لیے یونٹ بک کر لیے گئے ہیں۔\n\n{{expires_at}} سے پہلے پراپرٹی ٹوکن ایپ میں دکھائے گئے ادائیگی کوڈ کے ساتھ راست کے ذریعے پوری رقم {{amount_paisa}} ادا کریں۔ اس کے بعد بکنگ ختم ہو جائے گی۔'),
  -- offering.payment_received
  ('offering.payment_received', 'sms', 'en', NULL,
   'Property Token: we received your payment of {{amount_paisa}} for {{offering}}. The trustee holds it until the offering completes.'),
  ('offering.payment_received', 'sms', 'ur', NULL,
   'پراپرٹی ٹوکن: {{offering}} کے لیے آپ کی {{amount_paisa}} کی ادائیگی موصول ہو گئی۔ آفرنگ مکمل ہونے تک رقم ٹرسٹی کے پاس رہے گی۔'),
  ('offering.payment_received', 'email', 'en', 'Payment received',
   E'We received your payment of {{amount_paisa}} for {{offering}}.\n\nThe money is held by the trustee until the offering completes. You can follow every step in the Property Token app.'),
  ('offering.payment_received', 'email', 'ur', 'ادائیگی موصول ہو گئی',
   E'{{offering}} کے لیے آپ کی {{amount_paisa}} کی ادائیگی موصول ہو گئی۔\n\nآفرنگ مکمل ہونے تک رقم ٹرسٹی کے پاس محفوظ رہے گی۔ ہر مرحلہ پراپرٹی ٹوکن ایپ میں دیکھیں۔'),
  -- offering.allocated
  ('offering.allocated', 'sms', 'en', NULL,
   'Property Token: {{units}} units in {{offering}} are allocated to you. They are issued to your wallet when the offering completes.'),
  ('offering.allocated', 'sms', 'ur', NULL,
   'پراپرٹی ٹوکن: {{offering}} میں {{units}} یونٹ آپ کے نام مختص ہو گئے۔ آفرنگ مکمل ہونے پر یہ آپ کے والیٹ میں جاری ہوں گے۔'),
  ('offering.allocated', 'email', 'en', 'Units allocated to you',
   E'{{units}} units in {{offering}} are allocated to you: the offering reached its target.\n\nThe units are issued to your wallet when the offering completes. Follow the progress in the Property Token app.'),
  ('offering.allocated', 'email', 'ur', 'یونٹ آپ کے نام مختص ہو گئے',
   E'{{offering}} میں {{units}} یونٹ آپ کے نام مختص ہو گئے: آفرنگ اپنے ہدف تک پہنچ گئی۔\n\nآفرنگ مکمل ہونے پر یونٹ آپ کے والیٹ میں جاری ہوں گے۔ پیش رفت پراپرٹی ٹوکن ایپ میں دیکھیں۔'),
  -- offering.units_issued
  ('offering.units_issued', 'sms', 'en', NULL,
   'Property Token: {{units}} units in {{offering}} were issued to your wallet.'),
  ('offering.units_issued', 'sms', 'ur', NULL,
   'پراپرٹی ٹوکن: {{offering}} کے {{units}} یونٹ آپ کے والیٹ میں جاری کر دیے گئے۔'),
  ('offering.units_issued', 'email', 'en', 'Your units were issued',
   E'{{units}} units in {{offering}} were issued to your wallet.\n\nYou can see them, and the on-chain proof, in the Property Token app.'),
  ('offering.units_issued', 'email', 'ur', 'آپ کے یونٹ جاری ہو گئے',
   E'{{offering}} کے {{units}} یونٹ آپ کے والیٹ میں جاری کر دیے گئے۔\n\nیہ یونٹ اور ان کا آن چین ثبوت پراپرٹی ٹوکن ایپ میں دیکھیں۔'),
  -- offering.reservation_expired
  ('offering.reservation_expired', 'sms', 'en', NULL,
   'Property Token: your reservation or waiting-list place in {{offering}} has ended. Nothing was charged.'),
  ('offering.reservation_expired', 'sms', 'ur', NULL,
   'پراپرٹی ٹوکن: {{offering}} میں آپ کی بکنگ یا انتظار کی فہرست میں جگہ ختم ہو گئی۔ کوئی رقم نہیں لی گئی۔'),
  ('offering.reservation_expired', 'email', 'en', 'Your reservation has ended',
   E'Your reservation or waiting-list place in {{offering}} has ended without payment. Nothing was charged.\n\nIf you did send a payment, open the Property Token app yourself and contact support.'),
  ('offering.reservation_expired', 'email', 'ur', 'آپ کی بکنگ ختم ہو گئی',
   E'{{offering}} میں آپ کی بکنگ یا انتظار کی فہرست میں جگہ ادائیگی کے بغیر ختم ہو گئی۔ کوئی رقم نہیں لی گئی۔\n\nاگر آپ نے ادائیگی بھیجی تھی تو پراپرٹی ٹوکن ایپ خود کھولیں اور سپورٹ سے رابطہ کریں۔'),
  -- offering.reservation_cancelled
  ('offering.reservation_cancelled', 'sms', 'en', NULL,
   'Property Token: your reservation in {{offering}} was cancelled. Nothing was charged. Not you? Contact support in the app.'),
  ('offering.reservation_cancelled', 'sms', 'ur', NULL,
   'پراپرٹی ٹوکن: {{offering}} میں آپ کی بکنگ منسوخ ہو گئی۔ کوئی رقم نہیں لی گئی۔ آپ نہیں تھے؟ ایپ میں سپورٹ سے رابطہ کریں۔'),
  ('offering.reservation_cancelled', 'email', 'en', 'Your reservation was cancelled',
   E'Your reservation in {{offering}} was cancelled. Nothing was charged.\n\nIf you did not cancel it, open the Property Token app yourself and contact support.'),
  ('offering.reservation_cancelled', 'email', 'ur', 'آپ کی بکنگ منسوخ ہو گئی',
   E'{{offering}} میں آپ کی بکنگ منسوخ ہو گئی۔ کوئی رقم نہیں لی گئی۔\n\nاگر یہ آپ نے نہیں کیا تو پراپرٹی ٹوکن ایپ خود کھولیں اور سپورٹ سے رابطہ کریں۔'),
  -- offering.waitlisted
  ('offering.waitlisted', 'sms', 'en', NULL,
   'Property Token: {{offering}} has no free units right now. You are on the waiting list and get units in order if some free up.'),
  ('offering.waitlisted', 'sms', 'ur', NULL,
   'پراپرٹی ٹوکن: {{offering}} میں ابھی یونٹ دستیاب نہیں۔ آپ انتظار کی فہرست میں ہیں؛ یونٹ خالی ہونے پر ترتیب سے ملیں گے۔'),
  ('offering.waitlisted', 'email', 'en', 'You are on the waiting list',
   E'{{offering}} has no free units right now, so you are on its waiting list.\n\nIf units free up, they go to the waiting list in order and you will be told. Nothing is charged until then.'),
  ('offering.waitlisted', 'email', 'ur', 'آپ انتظار کی فہرست میں ہیں',
   E'{{offering}} میں ابھی یونٹ دستیاب نہیں، اس لیے آپ انتظار کی فہرست میں ہیں۔\n\nیونٹ خالی ہونے پر ترتیب سے دیے جائیں گے اور آپ کو بتایا جائے گا۔ تب تک کوئی رقم نہیں لی جائے گی۔'),
  -- offering.not_accepted
  ('offering.not_accepted', 'sms', 'en', NULL,
   'Property Token: your reservation request in {{offering}} could not be accepted. Nothing was charged. Details are in the app.'),
  ('offering.not_accepted', 'sms', 'ur', NULL,
   'پراپرٹی ٹوکن: {{offering}} میں آپ کی بکنگ کی درخواست قبول نہیں ہو سکی۔ کوئی رقم نہیں لی گئی۔ تفصیل ایپ میں دیکھیں۔'),
  ('offering.not_accepted', 'email', 'en', 'Your reservation request was not accepted',
   E'Your reservation request in {{offering}} could not be accepted. Nothing was charged.\n\nOpen the Property Token app yourself to see what you can do next.'),
  ('offering.not_accepted', 'email', 'ur', 'آپ کی بکنگ کی درخواست قبول نہیں ہوئی',
   E'{{offering}} میں آپ کی بکنگ کی درخواست قبول نہیں ہو سکی۔ کوئی رقم نہیں لی گئی۔\n\nآگے کیا کرنا ہے، یہ دیکھنے کے لیے پراپرٹی ٹوکن ایپ خود کھولیں۔'),
  -- offering.refund_pending
  ('offering.refund_pending', 'sms', 'en', NULL,
   'Property Token: a refund of {{amount_paisa}} for {{offering}} is being prepared. It goes back to the account you paid from.'),
  ('offering.refund_pending', 'sms', 'ur', NULL,
   'پراپرٹی ٹوکن: {{offering}} کے لیے {{amount_paisa}} کی واپسی تیار ہو رہی ہے۔ رقم اسی اکاؤنٹ میں جائے گی جس سے ادائیگی ہوئی۔'),
  ('offering.refund_pending', 'email', 'en', 'A refund is being prepared',
   E'A refund of {{amount_paisa}} for {{offering}} is being prepared.\n\nIt is sent in full to the account you paid from, after two bank operators approve it. Follow it in the Property Token app.'),
  ('offering.refund_pending', 'email', 'ur', 'رقم کی واپسی تیار ہو رہی ہے',
   E'{{offering}} کے لیے {{amount_paisa}} کی واپسی تیار کی جا رہی ہے۔\n\nدو بینک آپریٹرز کی منظوری کے بعد پوری رقم اسی اکاؤنٹ میں بھیجی جائے گی جس سے ادائیگی ہوئی تھی۔ پراپرٹی ٹوکن ایپ میں دیکھیں۔'),
  -- offering.refunded
  ('offering.refunded', 'sms', 'en', NULL,
   'Property Token: {{amount_paisa}} for {{offering}} was refunded to the account you paid from.'),
  ('offering.refunded', 'sms', 'ur', NULL,
   'پراپرٹی ٹوکن: {{offering}} کے {{amount_paisa}} اسی اکاؤنٹ میں واپس بھیج دیے گئے جس سے ادائیگی ہوئی تھی۔'),
  ('offering.refunded', 'email', 'en', 'Your refund was sent',
   E'{{amount_paisa}} for {{offering}} was refunded to the account you paid from.\n\nBanks usually show it within one working day. The refund is listed in the Property Token app.'),
  ('offering.refunded', 'email', 'ur', 'آپ کی رقم واپس بھیج دی گئی',
   E'{{offering}} کے {{amount_paisa}} اسی اکاؤنٹ میں واپس بھیج دیے گئے جس سے ادائیگی ہوئی تھی۔\n\nبینک عموماً ایک کاروباری دن میں دکھا دیتے ہیں۔ تفصیل پراپرٹی ٹوکن ایپ میں ہے۔'),
  -- bank.payment_unmatched
  ('bank.payment_unmatched', 'sms', 'en', NULL,
   'Property Token: a payment of {{amount_paisa}} with your payment code at {{at}} could not be matched. Contact support in the app.'),
  ('bank.payment_unmatched', 'sms', 'ur', NULL,
   'پراپرٹی ٹوکن: {{at}} پر آپ کے کوڈ سے {{amount_paisa}} کی ادائیگی مطابقت نہیں رکھتی۔ ایپ میں سپورٹ سے رابطہ کریں۔'),
  ('bank.payment_unmatched', 'email', 'en', 'A payment could not be matched',
   E'A payment of {{amount_paisa}} carrying your payment code arrived at {{at}} but could not be matched: the amount, the time or the sending account did not fit.\n\nOpen the Property Token app yourself and contact support; the money is kept safe in the meantime.'),
  ('bank.payment_unmatched', 'email', 'ur', 'ایک ادائیگی کی مطابقت نہیں ہو سکی',
   E'{{at}} پر آپ کے ادائیگی کوڈ کے ساتھ {{amount_paisa}} کی رقم آئی مگر مطابقت نہیں ہو سکی: رقم، وقت یا بھیجنے والا اکاؤنٹ درست نہیں تھا۔\n\nپراپرٹی ٹوکن ایپ خود کھولیں اور سپورٹ سے رابطہ کریں؛ اس دوران رقم محفوظ رہے گی۔'),
  -- rent.distributed
  ('rent.distributed', 'sms', 'en', NULL,
   'Property Token: rent of {{amount_paisa}} after tax for {{token}} ({{period}}) was credited to you. It is paid out to your bank account next.'),
  ('rent.distributed', 'sms', 'ur', NULL,
   'پراپرٹی ٹوکن: {{token}} کا کرایہ {{amount_paisa}} ٹیکس کے بعد ({{period}}) آپ کے حساب میں جمع ہو گیا۔'),
  ('rent.distributed', 'email', 'en', 'Rent credited to you',
   E'Rent of {{amount_paisa}} after withholding tax for {{token}} (period {{period}}) was credited to you.\n\nIt is paid out to your payout bank account with the next payout. Your statement and the on-chain proof are in the Property Token app.'),
  ('rent.distributed', 'email', 'ur', 'کرایہ آپ کے حساب میں جمع ہو گیا',
   E'{{token}} کا کرایہ {{amount_paisa}} ودہولڈنگ ٹیکس کے بعد (مدت {{period}}) آپ کے حساب میں جمع ہو گیا۔\n\nیہ اگلی ادائیگی کے ساتھ آپ کے بینک اکاؤنٹ میں بھیجا جائے گا۔ گوشوارہ اور آن چین ثبوت پراپرٹی ٹوکن ایپ میں ہیں۔'),
  -- rent.held
  ('rent.held', 'sms', 'en', NULL,
   'Property Token: rent of {{amount_paisa}} for {{token}} ({{period}}) is waiting for an active payout bank account. Check your account in the app.'),
  ('rent.held', 'sms', 'ur', NULL,
   'پراپرٹی ٹوکن: {{token}} کا کرایہ {{amount_paisa}} ({{period}}) فعال بینک اکاؤنٹ کا منتظر ہے۔ ایپ میں اپنا اکاؤنٹ دیکھیں۔'),
  ('rent.held', 'email', 'en', 'Your rent is waiting for a payout account',
   E'Rent of {{amount_paisa}} for {{token}} (period {{period}}) could not be paid out yet: there is no active payout bank account on your account.\n\nAdd one in the Property Token app, or wait until the new one is active (72-hour waiting period). The rent stays owed to you and is paid with a later payout.'),
  ('rent.held', 'email', 'ur', 'آپ کا کرایہ بینک اکاؤنٹ کا منتظر ہے',
   E'{{token}} کا کرایہ {{amount_paisa}} (مدت {{period}}) ابھی نہیں بھیجا جا سکا: آپ کے اکاؤنٹ میں کوئی فعال بینک اکاؤنٹ نہیں۔\n\nپراپرٹی ٹوکن ایپ میں بینک اکاؤنٹ شامل کریں یا نئے اکاؤنٹ کے فعال ہونے کا انتظار کریں (72 گھنٹے)۔ کرایہ آپ کا رہے گا اور بعد کی ادائیگی میں بھیج دیا جائے گا۔'),
  -- rent.payout_returned
  ('rent.payout_returned', 'sms', 'en', NULL,
   'Property Token: your bank returned the rent payout of {{amount_paisa}} for {{token}}. Check your payout account in the app.'),
  ('rent.payout_returned', 'sms', 'ur', NULL,
   'پراپرٹی ٹوکن: آپ کے بینک نے {{token}} کے کرایے کی {{amount_paisa}} کی ادائیگی واپس کر دی۔ ایپ میں اپنا بینک اکاؤنٹ دیکھیں۔'),
  ('rent.payout_returned', 'email', 'en', 'Your bank returned a rent payout',
   E'Your bank returned the rent payout of {{amount_paisa}} for {{token}}.\n\nThe rent stays owed to you. Open the Property Token app yourself and check your payout bank account.'),
  ('rent.payout_returned', 'email', 'ur', 'آپ کے بینک نے کرایے کی ادائیگی واپس کر دی',
   E'آپ کے بینک نے {{token}} کے کرایے کی {{amount_paisa}} کی ادائیگی واپس کر دی۔\n\nکرایہ آپ کا رہے گا۔ پراپرٹی ٹوکن ایپ خود کھولیں اور اپنا بینک اکاؤنٹ چیک کریں۔'),
  -- tax.certificate_available
  ('tax.certificate_available', 'sms', 'en', NULL,
   'Property Token: your withholding tax certificate for {{fiscal_year}} is ready in the app.'),
  ('tax.certificate_available', 'sms', 'ur', NULL,
   'پراپرٹی ٹوکن: {{fiscal_year}} کا آپ کا ودہولڈنگ ٹیکس سرٹیفکیٹ ایپ میں دستیاب ہے۔'),
  ('tax.certificate_available', 'email', 'en', 'Your tax certificate is ready',
   E'Your withholding tax certificate for {{fiscal_year}} is ready.\n\nDownload it from the Property Token app for your tax return.'),
  ('tax.certificate_available', 'email', 'ur', 'آپ کا ٹیکس سرٹیفکیٹ تیار ہے',
   E'{{fiscal_year}} کا آپ کا ودہولڈنگ ٹیکس سرٹیفکیٹ تیار ہے۔\n\nاپنے ٹیکس گوشوارے کے لیے اسے پراپرٹی ٹوکن ایپ سے ڈاؤن لوڈ کریں۔'),
  -- security.passkey_added
  ('security.passkey_added', 'sms', 'en', NULL,
   'Property Token: a passkey was added to your account at {{at}}. Not you? Contact support in the app now. We never ask for codes.'),
  ('security.passkey_added', 'sms', 'ur', NULL,
   'پراپرٹی ٹوکن: {{at}} پر آپ کے اکاؤنٹ میں پاس کی شامل کی گئی۔ آپ نہیں تھے؟ فوراً ایپ میں سپورٹ سے رابطہ کریں۔'),
  ('security.passkey_added', 'email', 'en', 'A passkey was added to your account',
   E'A passkey was added to your Property Token account at {{at}}.\n\nIf this was you, no action is needed.\nIf not, open the Property Token app yourself (do not use links in messages) and contact support now.'),
  ('security.passkey_added', 'email', 'ur', 'آپ کے اکاؤنٹ میں پاس کی شامل کی گئی',
   E'{{at}} پر آپ کے پراپرٹی ٹوکن اکاؤنٹ میں ایک پاس کی شامل کی گئی۔\n\nاگر یہ آپ تھے تو کچھ کرنے کی ضرورت نہیں۔\nاگر نہیں، تو پراپرٹی ٹوکن ایپ خود کھولیں (پیغامات کے لنک استعمال نہ کریں) اور فوراً سپورٹ سے رابطہ کریں۔'),
  -- security.passkey_removed
  ('security.passkey_removed', 'sms', 'en', NULL,
   'Property Token: a passkey was removed from your account at {{at}}. Not you? Contact support in the app now.'),
  ('security.passkey_removed', 'sms', 'ur', NULL,
   'پراپرٹی ٹوکن: {{at}} پر آپ کے اکاؤنٹ سے ایک پاس کی ہٹا دی گئی۔ آپ نہیں تھے؟ فوراً ایپ میں سپورٹ سے رابطہ کریں۔'),
  ('security.passkey_removed', 'email', 'en', 'A passkey was removed from your account',
   E'A passkey was removed from your Property Token account at {{at}}, and its other sessions were signed out.\n\nIf this was you, no action is needed.\nIf not, open the Property Token app yourself and contact support now.'),
  ('security.passkey_removed', 'email', 'ur', 'آپ کے اکاؤنٹ سے پاس کی ہٹا دی گئی',
   E'{{at}} پر آپ کے پراپرٹی ٹوکن اکاؤنٹ سے ایک پاس کی ہٹا دی گئی اور اس کے دوسرے سیشن بند کر دیے گئے۔\n\nاگر یہ آپ تھے تو کچھ کرنے کی ضرورت نہیں۔\nاگر نہیں، تو پراپرٹی ٹوکن ایپ خود کھولیں اور فوراً سپورٹ سے رابطہ کریں۔'),
  -- security.passkey_disabled
  ('security.passkey_disabled', 'sms', 'en', NULL,
   'Property Token: for your protection one of your passkeys was switched off at {{at}}. Sign in with another passkey and contact support in the app.'),
  ('security.passkey_disabled', 'sms', 'ur', NULL,
   'پراپرٹی ٹوکن: آپ کی حفاظت کے لیے {{at}} پر آپ کی ایک پاس کی بند کر دی گئی۔ دوسری پاس کی سے لاگ اِن کریں اور سپورٹ سے رابطہ کریں۔'),
  ('security.passkey_disabled', 'email', 'en', 'One of your passkeys was switched off',
   E'For your protection one of your passkeys was switched off at {{at}}, and the sessions signed in with it were ended: it answered in a way that suggests it may have been copied.\n\nSign in with another passkey, then open the Property Token app yourself and contact support.'),
  ('security.passkey_disabled', 'email', 'ur', 'آپ کی ایک پاس کی بند کر دی گئی',
   E'آپ کی حفاظت کے لیے {{at}} پر آپ کی ایک پاس کی بند کر دی گئی اور اس سے کھلے سیشن ختم کر دیے گئے: اس کے جواب سے لگتا ہے کہ اس کی نقل بنائی گئی ہو۔\n\nدوسری پاس کی سے لاگ اِن کریں، پھر پراپرٹی ٹوکن ایپ خود کھولیں اور سپورٹ سے رابطہ کریں۔'),
  -- marketing.offering_open (opt-in only)
  ('marketing.offering_open', 'sms', 'en', NULL,
   'Property Token: a new offering is open: {{offering}}. Investing carries risk; read the offering document in the app. Switch offers off in the app.'),
  ('marketing.offering_open', 'sms', 'ur', NULL,
   'پراپرٹی ٹوکن: نئی آفرنگ کھل گئی: {{offering}}۔ سرمایہ کاری میں خطرہ ہے؛ ایپ میں دستاویز پڑھیں۔ پیشکشیں ایپ میں بند کریں۔'),
  ('marketing.offering_open', 'email', 'en', 'A new offering is open',
   E'A new offering is open: {{offering}}.\n\nInvesting carries risk: the value of units can fall and rent is not guaranteed. Read the offering document and the risk disclosure in the Property Token app before you decide.\n\nYou receive this because you asked for news about offerings. You can switch it off at any time under Notifications in the app.'),
  ('marketing.offering_open', 'email', 'ur', 'نئی آفرنگ کھل گئی',
   E'نئی آفرنگ کھل گئی: {{offering}}۔\n\nسرمایہ کاری میں خطرہ ہے: یونٹس کی قیمت کم ہو سکتی ہے اور کرایہ یقینی نہیں۔ فیصلے سے پہلے پراپرٹی ٹوکن ایپ میں آفرنگ دستاویز اور خطرات کا بیان پڑھیں۔\n\nیہ پیغام اس لیے ملا کہ آپ نے آفرنگز کی خبریں مانگی تھیں۔ ایپ میں اطلاعات کے حصے سے کسی بھی وقت بند کر سکتے ہیں۔'),
  -- officer.action_waiting
  ('officer.action_waiting', 'sms', 'en', NULL,
   'PT Control: {{queue}} is waiting for you (ref {{reference}}). Open PT Control to review it.'),
  ('officer.action_waiting', 'sms', 'ur', NULL,
   'پی ٹی کنٹرول: {{queue}} آپ کی منتظر ہے (حوالہ {{reference}})۔ جائزے کے لیے پی ٹی کنٹرول کھولیں۔'),
  ('officer.action_waiting', 'email', 'en', 'An item is waiting for you in PT Control',
   E'An item is waiting in your queue: {{queue}} (reference {{reference}}).\n\nOpen PT Control yourself (do not use links in messages) and review it there.'),
  ('officer.action_waiting', 'email', 'ur', 'پی ٹی کنٹرول میں ایک کام آپ کا منتظر ہے',
   E'آپ کی فہرست میں ایک کام منتظر ہے: {{queue}} (حوالہ {{reference}})۔\n\nپی ٹی کنٹرول خود کھولیں (پیغامات کے لنک استعمال نہ کریں) اور وہاں جائزہ لیں۔'),
  -- officer.alert
  ('officer.alert', 'sms', 'en', NULL,
   'PT Control alert: {{topic}} at {{at}} (ref {{reference}}). Open PT Control now.'),
  ('officer.alert', 'sms', 'ur', NULL,
   'پی ٹی کنٹرول الرٹ: {{topic}}، وقت {{at}} (حوالہ {{reference}})۔ فوراً پی ٹی کنٹرول کھولیں۔'),
  ('officer.alert', 'email', 'en', 'PT Control alert',
   E'Alert: {{topic}} at {{at}} (reference {{reference}}).\n\nOpen PT Control yourself and follow the runbook for this alert.'),
  ('officer.alert', 'email', 'ur', 'پی ٹی کنٹرول الرٹ',
   E'الرٹ: {{topic}}، وقت {{at}} (حوالہ {{reference}})۔\n\nپی ٹی کنٹرول خود کھولیں اور اس الرٹ کی رن بک پر عمل کریں۔'),
  -- Version 2 of two 0017 templates: generic wording without "freeze"/"frozen" (NP-4).
  ('security.account_frozen', 'sms', 'en', NULL,
   'Property Token: your account was put on hold at {{at}}. Contact support in the app for next steps.'),
  ('security.account_frozen', 'sms', 'ur', NULL,
   'پراپرٹی ٹوکن: آپ کا اکاؤنٹ {{at}} سے عارضی طور پر روک دیا گیا ہے۔ مزید معلومات کے لیے ایپ میں سپورٹ سے رابطہ کریں۔'),
  ('security.account_frozen', 'email', 'en', 'Your Property Token account is on hold',
   E'Your account was put on hold at {{at}}. While it is on hold, your units cannot move and payouts wait.\n\nOpen the Property Token app yourself and contact support for next steps.'),
  ('security.account_frozen', 'email', 'ur', 'آپ کا پراپرٹی ٹوکن اکاؤنٹ عارضی طور پر روک دیا گیا',
   E'آپ کا اکاؤنٹ {{at}} سے عارضی طور پر روک دیا گیا ہے۔ اس دوران آپ کے یونٹ منتقل نہیں ہو سکتے اور ادائیگیاں رکی رہیں گی۔\n\nپراپرٹی ٹوکن ایپ خود کھولیں اور مزید معلومات کے لیے سپورٹ سے رابطہ کریں۔'),
  ('security.account_unfrozen', 'sms', 'en', NULL,
   'Property Token: the hold on your account was lifted at {{at}}.'),
  ('security.account_unfrozen', 'sms', 'ur', NULL,
   'پراپرٹی ٹوکن: آپ کے اکاؤنٹ کی روک {{at}} پر ختم کر دی گئی۔'),
  ('security.account_unfrozen', 'email', 'en', 'The hold on your Property Token account was lifted',
   E'The hold on your account was lifted at {{at}}.\n\nIf you have questions, open the Property Token app yourself and contact support.'),
  ('security.account_unfrozen', 'email', 'ur', 'آپ کے پراپرٹی ٹوکن اکاؤنٹ کی روک ختم',
   E'آپ کے اکاؤنٹ کی روک {{at}} پر ختم کر دی گئی۔\n\nکسی سوال کے لیے پراپرٹی ٹوکن ایپ خود کھولیں اور سپورٹ سے رابطہ کریں۔')
) AS t(kind, channel, locale, subject, body);

-- ================================================================== NP-3 producer entry point
CREATE TABLE notify.producer_failures (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at              timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) <= 400),
  kind            text NOT NULL CHECK (length(kind) <= 64),
  subject_type    text CHECK (length(subject_type) <= 20),
  subject_id      text CHECK (length(subject_id) <= 100),
  params          jsonb CHECK (params IS NULL OR octet_length(params::text) <= 4096),
  actor           text NOT NULL CHECK (length(actor) BETWEEN 1 AND 100),
  sqlstate        text NOT NULL CHECK (sqlstate ~ '^[0-9A-Z]{5}$'),
  error           text NOT NULL CHECK (length(error) <= 500)
);
CREATE TRIGGER producer_failures_no_change BEFORE UPDATE OR DELETE ON notify.producer_failures FOR EACH ROW EXECUTE FUNCTION notify.forbid_change();
CREATE TRIGGER producer_failures_no_truncate BEFORE TRUNCATE ON notify.producer_failures FOR EACH STATEMENT EXECUTE FUNCTION notify.forbid_change();

/**
 * NP-3: enqueue for a producer trigger. A failure never aborts the business change: it is recorded,
 * audited and alerted. Transaction-level errors are re-raised (the caller retries).
 */
CREATE FUNCTION notify.produce(p_key text, p_kind text, p_subject_type text, p_subject_id text, p_params jsonb, p_actor text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, notify AS $$
DECLARE
  v_id bigint;
  v_state text;
  v_msg text;
  v_fail bigint;
BEGIN
  BEGIN
    v_id := notify.enqueue(p_key, p_kind, p_subject_type, p_subject_id, p_params, p_actor);
    RETURN v_id;
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    IF left(v_state, 2) IN ('40', '53', '57') THEN RAISE; END IF;
  END;
  INSERT INTO notify.producer_failures (idempotency_key, kind, subject_type, subject_id, params, actor, sqlstate, error)
  VALUES (left(coalesce(p_key, '?'), 400), left(coalesce(p_kind, '?'), 64), left(p_subject_type, 20), left(p_subject_id, 100),
          CASE WHEN octet_length(p_params::text) <= 4096 THEN p_params END, left(coalesce(p_actor, 'unknown'), 100), v_state, left(coalesce(v_msg, '?'), 500))
  RETURNING id INTO v_fail;
  PERFORM notify.audit_append(left(coalesce(p_actor, 'unknown'), 100), 'producer.failed', jsonb_build_object('failure', v_fail, 'key', left(p_key, 200),
    'kind', p_kind, 'sqlstate', v_state));
  PERFORM pg_notify('notify_alert', json_build_object('kind', 'producer_failed', 'failure', v_fail, 'event', p_kind)::text);
  RETURN NULL;
END $$;

-- ------------------------------------------------------------------ value helpers (always valid placeholder values)
CREATE FUNCTION notify.utc_param(p timestamptz) RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT to_char(coalesce(p, clock_timestamp()) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
$$;

/** A 'label' value from free text (a building name, a passkey name), or the fallback. */
CREATE FUNCTION notify.label_of(p text, p_fallback text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT CASE WHEN v ~ '^[A-Za-z][A-Za-z0-9 .()/,-]*$' AND v !~ '[0-9]{7}' THEN v ELSE p_fallback END
  FROM (SELECT rtrim(left(btrim(regexp_replace(regexp_replace(coalesce(p, ''), '[^A-Za-z0-9 .()/,-]+', ' ', 'g'), '\s+', ' ', 'g')), 48)) AS v) x
$$;

/** A 'code' value: PREFIX-ID, upper case; an id with a long digit run is replaced by a short hash. */
CREATE FUNCTION notify.ref_code(p_prefix text, p_id text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT CASE WHEN v ~ '[0-9]{7}' OR length(v) > 40 THEN p_prefix || '-' || upper(left(md5(coalesce(p_id, '')), 6)) ELSE v END
  FROM (SELECT p_prefix || '-' || upper(regexp_replace(coalesce(p_id, ''), '[^A-Za-z0-9]', '', 'g')) AS v) x
$$;

/** The investor-facing name of an offering: the building, else "Offering <6 hex>". */
CREATE FUNCTION notify.offering_label(p_offering uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, notify AS $$
  SELECT coalesce(
    (SELECT notify.label_of(p.building, 'Offering ' || upper(left(replace(o.id::text, '-', ''), 6)))
     FROM offering.offerings o JOIN property.properties p ON p.id = o.property_id WHERE o.id = p_offering),
    'Offering')
$$;

/** The 'code' of an offering (0017's offering.reservation_expiring uses a code). */
CREATE FUNCTION notify.offering_code(p_offering uuid) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT 'OF-' || upper(left(replace(p_offering::text, '-', ''), 6))
$$;

/** The 'code' of a token: PT- and the first six hex digits of its address. */
CREATE FUNCTION notify.token_code(p_token text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT 'PT-' || upper(substr(lower(coalesce(p_token, '0x000000')), 3, 6))
$$;

/** The investor-facing name of a token: its offering's building, else "Token <code>". */
CREATE FUNCTION notify.token_label(p_token text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, notify AS $$
  SELECT coalesce(
    (SELECT notify.offering_label(o.id) FROM offering.offerings o WHERE o.token = lower(p_token)
     ORDER BY (o.state = 'cancelled'), o.created_at DESC LIMIT 1),
    'Token ' || notify.token_code(p_token))
$$;

/** The period 'code' of an on-chain distribution: the S-03 period if booked there, else D-<id>. */
CREATE FUNCTION notify.period_code(p_token text, p_distribution numeric) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, notify AS $$
  SELECT coalesce(
    (SELECT d.period FROM ops.distributions d WHERE d.token = lower(p_token) AND d.onchain_id = p_distribution AND d.status = 'booked' LIMIT 1),
    notify.ref_code('D', p_distribution::text))
$$;

/** The KYC subject of a website investor (NULL without one). */
CREATE FUNCTION notify.web_subject(p_investor uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, notify AS $$
  SELECT kyc_subject FROM webdemo.investors WHERE id = p_investor
$$;

-- ------------------------------------------------------------------ recipients (NP-7)
/** One notice to an investor (KYC subject); nothing without a subject. */
CREATE FUNCTION notify.to_investor(p_key text, p_kind text, p_subject uuid, p_params jsonb, p_actor text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, notify AS $$
BEGIN
  IF p_subject IS NULL THEN RETURN NULL; END IF;
  RETURN notify.produce(p_key, p_kind, 'investor', p_subject::text, p_params, p_actor);
END $$;

/** One notice per listed officer handle (key + ':' + handle), except p_exclude. */
CREATE FUNCTION notify.to_handles(p_key text, p_kind text, p_handles text[], p_params jsonb, p_actor text, p_exclude text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, notify AS $$
DECLARE
  h text;
  n integer := 0;
BEGIN
  FOR h IN SELECT DISTINCT x FROM unnest(p_handles) x
           WHERE x ~ '^[a-z0-9][a-z0-9._-]*$' AND length(x) <= 64 AND x IS DISTINCT FROM p_exclude ORDER BY x LOOP
    PERFORM notify.produce(p_key || ':' || h, p_kind, 'officer', h, p_params, p_actor);
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;

/** Handles of the active officers holding one of the roles now. */
CREATE FUNCTION notify.officers_with(p_roles text[]) RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, notify AS $$
  SELECT coalesce(array_agg(DISTINCT o.handle ORDER BY o.handle), '{}'::text[])
  FROM admin.officers o JOIN admin.role_grants g ON g.officer_id = o.id AND g.revoked_at IS NULL
  WHERE o.status = 'active' AND g.role = ANY (p_roles)
$$;

CREATE FUNCTION notify.to_officers(p_key text, p_kind text, p_roles text[], p_params jsonb, p_actor text, p_exclude text) RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, notify AS $$
  SELECT notify.to_handles(p_key, p_kind, notify.officers_with(p_roles), p_params, p_actor, p_exclude)
$$;

CREATE FUNCTION notify.waiting(p_queue text, p_reference text) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT jsonb_build_object('queue', p_queue, 'reference', p_reference)
$$;

-- ================================================================== producers: offering (S-02)
/** NP-1/NP-2: one investor notice per subscription transition worth telling (never blocked/disputed/review). */
CREATE FUNCTION notify.on_subscription_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, notify AS $$
DECLARE
  s offering.subscriptions;
  v_label text;
  v_kind text;
  v_params jsonb;
BEGIN
  SELECT * INTO s FROM offering.subscriptions WHERE id = NEW.subscription_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  v_label := notify.offering_label(s.offering_id);
  CASE NEW.to_state
    WHEN 'payment_pending' THEN
      v_kind := 'offering.reserved';
      v_params := jsonb_build_object('offering', v_label, 'amount_paisa', s.amount_paisa::text, 'expires_at', notify.utc_param(s.expires_at));
    WHEN 'payment_confirmed' THEN
      v_kind := 'offering.payment_received';
      v_params := jsonb_build_object('offering', v_label, 'amount_paisa', s.amount_paisa::text);
    WHEN 'allocation_pending' THEN
      v_kind := 'offering.allocated';
      v_params := jsonb_build_object('offering', v_label, 'units', s.units::text);
    WHEN 'tokens_issued' THEN
      v_kind := 'offering.units_issued';
      v_params := jsonb_build_object('offering', v_label, 'units', s.units::text);
    WHEN 'expired' THEN
      v_kind := 'offering.reservation_expired';
      v_params := jsonb_build_object('offering', v_label);
    WHEN 'cancelled' THEN
      v_kind := 'offering.reservation_cancelled';
      v_params := jsonb_build_object('offering', v_label);
    WHEN 'waitlisted' THEN
      v_kind := 'offering.waitlisted';
      v_params := jsonb_build_object('offering', v_label);
    WHEN 'rejected' THEN
      v_kind := 'offering.not_accepted';
      v_params := jsonb_build_object('offering', v_label);
    WHEN 'refund_pending' THEN
      v_kind := 'offering.refund_pending';
      v_params := jsonb_build_object('offering', v_label, 'amount_paisa', s.amount_paisa::text);
    WHEN 'refunded' THEN
      v_kind := 'offering.refunded';
      v_params := jsonb_build_object('offering', v_label, 'amount_paisa', s.amount_paisa::text);
    ELSE
      -- kyc_pending, issuance_review, blocked, disputed, active, redeemed: nothing (NP-4).
      RETURN NULL;
  END CASE;
  PERFORM notify.to_investor(format('offering:sub-event:%s', NEW.id), v_kind, s.subject_id, v_params, 'producer:offering');
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER subscription_events_notify AFTER INSERT ON offering.subscription_events
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION notify.on_subscription_event();

/** NP-5: a new offering opened (L5): marketing notice to the investors who opted in. */
CREATE FUNCTION notify.on_offering_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, notify AS $$
DECLARE
  r record;
  v_label text;
BEGIN
  IF NEW.to_state <> 'live' OR NEW.from_state <> 'ready' THEN RETURN NULL; END IF;
  v_label := notify.offering_label(NEW.offering_id);
  FOR r IN SELECT DISTINCT x.subject_id FROM notify.recipients x
           WHERE x.subject_type = 'investor'
             AND (notify.marketing_allowed(x.id, 'sms') OR notify.marketing_allowed(x.id, 'email'))
           ORDER BY x.subject_id LOOP
    PERFORM notify.produce(format('offering:open:%s:%s', NEW.offering_id, r.subject_id), 'marketing.offering_open', 'investor', r.subject_id,
      jsonb_build_object('offering', v_label), 'producer:offering');
  END LOOP;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER offering_events_notify AFTER INSERT ON offering.offering_events
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.to_state = 'live') EXECUTE FUNCTION notify.on_offering_event();

/** NP-7: an S-02 request waits for the officers holding one of the duties it needs. */
CREATE FUNCTION notify.on_offering_request() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, notify AS $$
DECLARE
  v_needs text[];
  v_handles text[];
BEGIN
  IF (SELECT status FROM offering.requests WHERE id = NEW.id) IS DISTINCT FROM 'open' THEN RETURN NULL; END IF;
  SELECT needs INTO v_needs FROM offering.request_rules WHERE code = NEW.code;
  SELECT coalesce(array_agg(DISTINCT h), '{}'::text[]) INTO v_handles FROM (
    SELECT d.actor AS h FROM offering.duties d WHERE d.status = 'active' AND d.duty = ANY (v_needs)
    UNION
    -- For a portal officer the S-02 trustee duty IS the trustee_officer role (0023 T-2).
    SELECT unnest(notify.officers_with(ARRAY['trustee_officer'])) WHERE 'trustee' = ANY (v_needs)) x;
  PERFORM notify.to_handles(format('offering:request:%s:waiting', NEW.id), 'officer.action_waiting', v_handles,
    notify.waiting('offering_request', notify.ref_code('OR', NEW.id::text)), 'producer:offering', NEW.requested_by);
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER requests_notify AFTER INSERT ON offering.requests
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.status = 'open') EXECUTE FUNCTION notify.on_offering_request();

-- ================================================================== producers: bank (ADR 0009, 0010)
/** Payout account added or replaced (threat M-1): the 72-hour cooling-off starts. */
CREATE FUNCTION notify.on_payee() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, notify AS $$
DECLARE
  v_prev text;
BEGIN
  SELECT iban_last4 INTO v_prev FROM bank.payees WHERE subject_id = NEW.subject_id AND id < NEW.id ORDER BY id DESC LIMIT 1;
  IF v_prev IS NULL THEN
    PERFORM notify.to_investor(format('bank:payee:%s', NEW.id), 'security.payout_account_added', NEW.subject_id,
      jsonb_build_object('last4', NEW.iban_last4, 'active_from', notify.utc_param(NEW.active_from)), 'producer:bank');
  ELSE
    PERFORM notify.to_investor(format('bank:payee:%s', NEW.id), 'security.payout_account_changed', NEW.subject_id,
      jsonb_build_object('last4', NEW.iban_last4, 'previous_last4', v_prev, 'active_from', notify.utc_param(NEW.active_from)), 'producer:bank');
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER payees_notify AFTER INSERT ON bank.payees
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION notify.on_payee();

/** A credit carrying an investor's payment code went to suspense (never for a KYC reason, NP-4). */
CREATE FUNCTION notify.on_credit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, notify AS $$
DECLARE
  v_subject uuid;
BEGIN
  IF NEW.reason = 'investor is not KYC-verified' THEN RETURN NULL; END IF;
  SELECT subject_id INTO v_subject FROM bank.payment_intents WHERE code = NEW.intent_code;
  PERFORM notify.to_investor(format('bank:credit:%s:unmatched', NEW.raast_ref), 'bank.payment_unmatched', v_subject,
    jsonb_build_object('amount_paisa', NEW.amount_paisa::text, 'at', notify.utc_param(NEW.booked_at)), 'producer:bank');
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER credits_notify AFTER INSERT ON bank.credits
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.status = 'suspense' AND NEW.intent_code IS NOT NULL) EXECUTE FUNCTION notify.on_credit();

/** A payout batch went to the bank: rent.paid per paid line, rent.held per line held for the payout account. */
CREATE FUNCTION notify.on_payout_batch() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, notify AS $$
DECLARE
  i record;
  v_token text := notify.token_code(NEW.token);
  v_period text := notify.period_code(NEW.token, NEW.distribution_id);
BEGIN
  FOR i IN SELECT line_no, subject_id, amount_paisa, held, held_reason FROM bank.payout_items WHERE batch_id = NEW.id ORDER BY line_no LOOP
    IF NOT i.held THEN
      PERFORM notify.to_investor(format('bank:payout:%s:%s', NEW.id, i.line_no), 'rent.paid', i.subject_id,
        jsonb_build_object('token', v_token, 'amount_paisa', i.amount_paisa::text, 'period', v_period), 'producer:bank');
    ELSIF i.held_reason = 'no active payout account' THEN
      -- Lines held because the investor is not verified get nothing (NP-4).
      PERFORM notify.to_investor(format('bank:payout:%s:%s:held', NEW.id, i.line_no), 'rent.held', i.subject_id,
        jsonb_build_object('token', v_token, 'amount_paisa', i.amount_paisa::text, 'period', v_period), 'producer:bank');
    END IF;
  END LOOP;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER payout_batches_notify AFTER UPDATE OF status ON bank.payout_batches
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.status = 'submitted' AND OLD.status IS DISTINCT FROM 'submitted')
  EXECUTE FUNCTION notify.on_payout_batch();

CREATE FUNCTION notify.on_payout_return() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, notify AS $$
DECLARE
  i record;
BEGIN
  SELECT b.token, p.subject_id, p.amount_paisa INTO i
  FROM bank.payout_items p JOIN bank.payout_batches b ON b.id = p.batch_id WHERE p.batch_id = NEW.batch_id AND p.line_no = NEW.line_no;
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM notify.to_investor(format('bank:payout-return:%s:%s', NEW.batch_id, NEW.line_no), 'rent.payout_returned', i.subject_id,
    jsonb_build_object('token', notify.token_code(i.token), 'amount_paisa', i.amount_paisa::text), 'producer:bank');
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER payout_returns_notify AFTER INSERT ON bank.payout_returns
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION notify.on_payout_return();

-- ================================================================== producers: operations and tax (S-03)
CREATE FUNCTION notify.on_distribution() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, notify AS $$
DECLARE
  l record;
  v_label text;
BEGIN
  IF NEW.status = 'attached' THEN
    PERFORM notify.to_officers(format('ops:distribution:%s:precheck', NEW.id), 'officer.action_waiting', ARRAY['trustee_officer'],
      notify.waiting('trustee_precheck', notify.ref_code('DC', NEW.id::text)), 'producer:ops', NEW.attached_by);
    PERFORM notify.to_officers(format('ops:distribution:%s:approval', NEW.id), 'officer.action_waiting', ARRAY['ops_checker'],
      notify.waiting('distribution_approval', notify.ref_code('DC', NEW.id::text)), 'producer:ops', NEW.attached_by);
  ELSIF NEW.status = 'booked' THEN
    v_label := notify.token_label(NEW.token);
    FOR l IN SELECT subject_id, net FROM ops.distribution_lines WHERE distribution_id = NEW.id AND subject_id IS NOT NULL AND net > 0 ORDER BY wallet LOOP
      PERFORM notify.to_investor(format('ops:distribution:%s:%s', NEW.id, l.subject_id), 'rent.distributed', l.subject_id,
        jsonb_build_object('token', v_label, 'amount_paisa', l.net::text, 'period', NEW.period), 'producer:ops');
    END LOOP;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER distributions_notify AFTER UPDATE OF status ON ops.distributions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.status IN ('attached', 'booked') AND OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION notify.on_distribution();

CREATE FUNCTION notify.on_certificate() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, notify AS $$
BEGIN
  PERFORM notify.to_investor(format('tax:certificate:%s', NEW.id), 'tax.certificate_available', NEW.subject_id,
    jsonb_build_object('fiscal_year', 'FY' || NEW.fiscal_year::text), 'producer:tax');
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER certificates_notify AFTER INSERT ON tax.certificates
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION notify.on_certificate();

-- ================================================================== producers: trustee (6d)
/** A distribution was published on chain: the trustee's 48-hour review window is open. */
CREATE FUNCTION notify.on_chain_distribution() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, notify AS $$
BEGIN
  PERFORM notify.to_officers(format('chain:distribution:%s:%s:review', NEW.registry, NEW.id), 'officer.action_waiting', ARRAY['trustee_officer'],
    notify.waiting('distribution_review', notify.ref_code('DR', NEW.id::text)), 'producer:trustee', NULL);
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER distributions_chain_notify AFTER INSERT ON chain.distributions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.status = 'published') EXECUTE FUNCTION notify.on_chain_distribution();

/** A signing request waits for approval: platform checkers, and the trustee when it needs a co-signature. */
CREATE FUNCTION notify.on_signer_request() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, notify AS $$
DECLARE
  r signer.requests;
  v_ref text;
BEGIN
  SELECT * INTO r FROM signer.requests WHERE id = NEW.id;
  IF r.status IS DISTINCT FROM 'pending_approval' THEN RETURN NULL; END IF;
  v_ref := notify.ref_code('SR', left(replace(r.id::text, '-', ''), 6));
  IF r.approvals_needed > 0 THEN
    PERFORM notify.to_officers(format('signer:request:%s:waiting', r.id), 'officer.action_waiting', ARRAY['ops_checker'],
      notify.waiting('signing', v_ref), 'producer:signer', r.requested_by);
  END IF;
  IF r.trustee_approvals_needed > 0 THEN
    PERFORM notify.to_officers(format('signer:request:%s:trustee', r.id), 'officer.action_waiting', ARRAY['trustee_officer'],
      notify.waiting('trustee_cosign', v_ref), 'producer:signer', r.requested_by);
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER requests_insert_notify AFTER INSERT ON signer.requests
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.status = 'pending_approval') EXECUTE FUNCTION notify.on_signer_request();
CREATE CONSTRAINT TRIGGER requests_update_notify AFTER UPDATE OF status ON signer.requests
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.status = 'pending_approval' AND OLD.status IS DISTINCT FROM 'pending_approval')
  EXECUTE FUNCTION notify.on_signer_request();

-- ================================================================== producers: reconciliation (officers only)
CREATE FUNCTION notify.on_gate_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, notify AS $$
BEGIN
  PERFORM notify.to_officers(format('recon:gate:%s', NEW.id), 'officer.alert', ARRAY['ops_maker', 'ops_checker', 'trustee_officer'],
    jsonb_build_object('topic', CASE NEW.action WHEN 'freeze' THEN 'payouts_paused' ELSE 'payouts_resumed' END,
                       'reference', CASE WHEN NEW.run_id IS NOT NULL THEN notify.ref_code('RUN', NEW.run_id::text) ELSE notify.ref_code('UF', NEW.request_id::text) END,
                       'at', notify.utc_param(NEW.at)), 'producer:recon', NULL);
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER gate_events_notify AFTER INSERT ON recon.gate_events
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION notify.on_gate_event();

CREATE FUNCTION notify.on_unfreeze_request() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, notify AS $$
BEGIN
  IF (SELECT status FROM recon.unfreeze_requests WHERE id = NEW.id) IS DISTINCT FROM 'open' THEN RETURN NULL; END IF;
  PERFORM notify.to_officers(format('recon:unfreeze:%s:waiting', NEW.id), 'officer.action_waiting', ARRAY['ops_checker'],
    notify.waiting('payout_release', notify.ref_code('UF', NEW.id::text)), 'producer:recon', NEW.requested_by);
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER unfreeze_requests_notify AFTER INSERT ON recon.unfreeze_requests
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION notify.on_unfreeze_request();

-- ================================================================== producers: KYC and compliance (NP-4)
/**
 * Investor notice of a KYC decision, generic words only: 'verified' (became verified) and
 * 'action_required' (a verified investor must repeat checks). review / rejected / revoked: nothing.
 */
CREATE FUNCTION notify.on_kyc_decision() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, notify AS $$
DECLARE
  prev kyc.decisions;
  v_word text;
BEGIN
  SELECT * INTO prev FROM kyc.decisions WHERE subject_id = NEW.subject_id AND id < NEW.id ORDER BY id DESC LIMIT 1;
  IF NEW.status = 'verified' AND (prev.id IS NULL OR prev.status <> 'verified' OR prev.valid_until <= NEW.at) THEN
    v_word := 'verified';
  ELSIF NEW.status = 'pending' AND prev.status = 'verified' THEN
    v_word := 'action_required';
  ELSE
    RETURN NULL;
  END IF;
  PERFORM notify.to_investor(format('kyc:decision:%s', NEW.id), 'security.kyc_status_changed', NEW.subject_id,
    jsonb_build_object('status', v_word), 'producer:kyc');
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER decisions_notify AFTER INSERT ON kyc.decisions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.status IN ('verified', 'pending')) EXECUTE FUNCTION notify.on_kyc_decision();

/** A compliance officer asked for information on a MANUAL case: the investor sees "action required" only. */
CREATE FUNCTION notify.on_kyc_case_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, notify AS $$
DECLARE
  k compliance.kyc_cases;
BEGIN
  SELECT * INTO k FROM compliance.kyc_cases WHERE id = NEW.case_id;
  IF NOT FOUND OR k.kind <> 'manual' THEN RETURN NULL; END IF;
  PERFORM notify.to_investor(format('compliance:kyc-case-event:%s', NEW.id), 'security.kyc_status_changed', k.subject_id,
    jsonb_build_object('status', 'action_required'), 'producer:compliance');
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER kyc_case_events_notify AFTER INSERT ON compliance.kyc_case_events
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.action = 'request_info') EXECUTE FUNCTION notify.on_kyc_case_event();

/** Compliance queues: a new KYC case, freeze/unfreeze request or compliance case waits for the compliance officers. */
CREATE FUNCTION notify.on_compliance_item() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, notify AS $$
BEGIN
  IF TG_TABLE_NAME = 'kyc_cases' THEN
    PERFORM notify.to_officers(format('compliance:kyc-case:%s:waiting', NEW.id), 'officer.action_waiting', ARRAY['compliance_officer'],
      notify.waiting('kyc_review', notify.ref_code('KC', NEW.id::text)), 'producer:compliance', NEW.opened_by);
  ELSIF TG_TABLE_NAME = 'freeze_requests' THEN
    PERFORM notify.to_officers(format('compliance:hold-request:%s:waiting', NEW.id), 'officer.action_waiting', ARRAY['compliance_officer'],
      notify.waiting('freeze_decision', notify.ref_code('FR', NEW.id::text)), 'producer:compliance', NEW.requested_by);
  ELSE
    -- STR cases: generic wording even for officers' phones (C-4 tipping-off).
    PERFORM notify.to_officers(format('compliance:case:%s:waiting', NEW.id), 'officer.action_waiting', ARRAY['compliance_officer'],
      notify.waiting('compliance_case', notify.ref_code('CC', NEW.id::text)), 'producer:compliance', NEW.opened_by);
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER kyc_cases_notify AFTER INSERT ON compliance.kyc_cases
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION notify.on_compliance_item();
CREATE CONSTRAINT TRIGGER freeze_requests_notify AFTER INSERT ON compliance.freeze_requests
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION notify.on_compliance_item();
CREATE CONSTRAINT TRIGGER str_cases_notify AFTER INSERT ON compliance.str_cases
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION notify.on_compliance_item();

-- ================================================================== producers: website passkeys and sessions (T-030)
CREATE FUNCTION notify.on_passkey() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, notify AS $$
DECLARE
  v_subject uuid := notify.web_subject(NEW.investor_id);
  v_ref text := left(replace(NEW.ref::text, '-', ''), 12);
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM notify.to_investor(format('webauth:passkey:%s:added', v_ref), 'security.passkey_added', v_subject,
      jsonb_build_object('at', notify.utc_param(NEW.created_at)), 'producer:webauth');
  ELSIF NEW.revoked_reason = 'investor' THEN
    PERFORM notify.to_investor(format('webauth:passkey:%s:removed', v_ref), 'security.passkey_removed', v_subject,
      jsonb_build_object('at', notify.utc_param(NEW.revoked_at)), 'producer:webauth');
  ELSIF NEW.revoked_reason = 'clone_suspected' THEN
    PERFORM notify.to_investor(format('webauth:passkey:%s:disabled', v_ref), 'security.passkey_disabled', v_subject,
      jsonb_build_object('at', notify.utc_param(NEW.revoked_at)), 'producer:webauth');
    -- The webauth_alert consumer (T-030 follow-up): officers hear about it.
    PERFORM notify.to_officers(format('webauth:passkey:%s:clone', v_ref), 'officer.alert', ARRAY['compliance_officer', 'ops_checker'],
      jsonb_build_object('topic', 'passkey_clone', 'reference', notify.ref_code('PK', left(v_ref, 6)), 'at', notify.utc_param(NEW.revoked_at)),
      'producer:webauth', NULL);
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER passkeys_insert_notify AFTER INSERT ON webauth.passkeys
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION notify.on_passkey();
CREATE CONSTRAINT TRIGGER passkeys_revoke_notify AFTER UPDATE OF revoked_at ON webauth.passkeys
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL) EXECUTE FUNCTION notify.on_passkey();

/** API-2: the first sign-in with a passkey (a device not seen before for this account). */
CREATE FUNCTION notify.on_session() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, notify AS $$
DECLARE
  c webauth.passkeys;
BEGIN
  IF EXISTS (SELECT 1 FROM webauth.sessions s WHERE s.credential_id = NEW.credential_id AND s.token_hash <> NEW.token_hash
             AND s.created_at <= NEW.created_at) THEN
    RETURN NULL;
  END IF;
  SELECT * INTO c FROM webauth.passkeys WHERE id = NEW.credential_id;
  PERFORM notify.to_investor(format('webauth:session:%s:new-device', encode(sha256(NEW.token_hash), 'hex')), 'security.new_device_sign_in',
    notify.web_subject(NEW.investor_id),
    jsonb_build_object('device', notify.label_of(c.name, 'a passkey'), 'at', notify.utc_param(NEW.created_at)), 'producer:webauth');
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER sessions_notify AFTER INSERT ON webauth.sessions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.method = 'passkey') EXECUTE FUNCTION notify.on_session();

-- ================================================================== time-based reminders (sweep)
/**
 * Reminders that no business change triggers, idempotent by key (safe to run as often as wanted):
 * reservation expiring within 2 hours (S-02 §10), payout account active after the cooling-off
 * (last 7 days), KYC verification expired (last 30 days), compliance items past their service level.
 */
CREATE FUNCTION notify.sweep(p_actor text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, notify AS $$
DECLARE
  r record;
  v_now timestamptz := clock_timestamp();
  n_expiring integer := 0;
  n_active integer := 0;
  n_expired integer := 0;
  n_sla integer := 0;
  v_actor text := coalesce(p_actor, 'notify:sweep');
BEGIN
  FOR r IN SELECT s.id, s.offering_id, s.subject_id, s.amount_paisa, s.expires_at FROM offering.subscriptions s
           WHERE s.state = 'payment_pending' AND s.expires_at > v_now AND s.expires_at <= v_now + interval '2 hours'
             AND s.reserved_at <= v_now - interval '30 minutes' ORDER BY s.id LOOP
    PERFORM notify.to_investor(format('offering:reservation-expiring:%s', r.id), 'offering.reservation_expiring', r.subject_id,
      jsonb_build_object('offering', notify.offering_code(r.offering_id), 'amount_paisa', r.amount_paisa::text, 'expires_at', notify.utc_param(r.expires_at)),
      v_actor);
    n_expiring := n_expiring + 1;
  END LOOP;

  FOR r IN SELECT p.id, p.subject_id, p.iban_last4 FROM bank.payees p
           WHERE p.superseded_at IS NULL AND p.active_from <= v_now AND p.active_from > v_now - interval '7 days' ORDER BY p.id LOOP
    PERFORM notify.to_investor(format('bank:payee-active:%s', r.id), 'security.payout_account_active', r.subject_id,
      jsonb_build_object('last4', r.iban_last4), v_actor);
    n_active := n_active + 1;
  END LOOP;

  FOR r IN SELECT x.id, x.subject_id FROM (
             SELECT DISTINCT ON (d.subject_id) d.id, d.subject_id, d.status, d.valid_until FROM kyc.decisions d ORDER BY d.subject_id, d.id DESC) x
           WHERE x.status = 'verified' AND x.valid_until <= v_now AND x.valid_until > v_now - interval '30 days' ORDER BY x.id LOOP
    PERFORM notify.to_investor(format('kyc:expired:%s', r.id), 'security.kyc_status_changed', r.subject_id,
      jsonb_build_object('status', 'expired'), v_actor);
    n_expired := n_expired + 1;
  END LOOP;

  -- Compliance service levels (compliance.sla): one alert per item and state entry.
  FOR r IN SELECT 'kyc-case' AS what, 'KC' AS prefix, k.id, k.status, k.updated_at AS since FROM compliance.kyc_cases k
             WHERE k.status IN ('open', 'info_requested', 'pending_second') AND k.updated_at + compliance.sla('kyc.' || k.status) < v_now
           UNION ALL
           SELECT 'hold-request', 'FR', f.id, f.status, f.requested_at FROM compliance.freeze_requests f
             WHERE f.status = 'open' AND f.requested_at + compliance.sla('freeze.open') < v_now
           UNION ALL
           SELECT 'case', 'CC', c.id, c.status, c.updated_at FROM compliance.str_cases c
             WHERE c.status IN ('open', 'under_review', 'close_proposed') AND c.updated_at + compliance.sla('str.' || c.status) < v_now
           ORDER BY 1, 3 LOOP
    PERFORM notify.to_officers(format('sla:%s:%s:%s:%s', r.what, r.id, r.status, floor(extract(epoch FROM r.since))::bigint), 'officer.alert',
      ARRAY['compliance_officer'],
      jsonb_build_object('topic', 'sla_breach', 'reference', notify.ref_code(r.prefix, r.id::text), 'at', notify.utc_param(v_now)), v_actor, NULL);
    n_sla := n_sla + 1;
  END LOOP;
  RETURN jsonb_build_object('reservationExpiring', n_expiring, 'payoutAccountActive', n_active, 'kycExpired', n_expired, 'slaBreaches', n_sla);
END $$;

-- ================================================================== NP-8 investor notification centre
CREATE TABLE notify.inbox_reads (
  notification_id bigint PRIMARY KEY REFERENCES notify.notifications (id),
  recipient_id    uuid NOT NULL REFERENCES notify.recipients (id),
  read_at         timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp())
);
CREATE TRIGGER inbox_reads_no_change BEFORE UPDATE OR DELETE ON notify.inbox_reads FOR EACH ROW EXECUTE FUNCTION notify.forbid_change();
CREATE TRIGGER inbox_reads_no_truncate BEFORE TRUNCATE ON notify.inbox_reads FOR EACH STATEMENT EXECUTE FUNCTION notify.forbid_change();

/** Internal: the notify recipient of the investor signed in with this website session (NULL if none). */
CREATE FUNCTION notify.web_recipient(p_session bytea, p_register boolean) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, notify AS $$
DECLARE
  s webauth.sessions := webauth.live_session(p_session);
  v_subject uuid;
  v_id uuid;
BEGIN
  IF s.token_hash IS NULL THEN RETURN NULL; END IF;
  PERFORM webauth.touch(s);
  v_subject := notify.web_subject(s.investor_id);
  IF v_subject IS NULL THEN RETURN NULL; END IF;
  SELECT id INTO v_id FROM notify.recipients WHERE subject_type = 'investor' AND subject_id = v_subject::text;
  IF v_id IS NULL AND p_register THEN
    v_id := notify.register_recipient('investor', v_subject::text, NULL, webauth.actor(s.investor_id));
  END IF;
  RETURN v_id;
END $$;

/** The signed-in investor's notifications, newest first, with the e-mail template text in the requested language. */
CREATE FUNCTION notify.web_inbox(p_session bytea, p_locale text, p_limit integer)
RETURNS TABLE (id bigint, kind text, category text, params jsonb, placeholders jsonb, created_at timestamptz, read_at timestamptz, subject text, body text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, notify AS $$
#variable_conflict use_column
DECLARE
  v_r uuid := notify.web_recipient(p_session, false);
  v_locale text := CASE WHEN p_locale = 'ur' THEN 'ur' ELSE 'en' END;
BEGIN
  IF v_r IS NULL THEN RETURN; END IF;
  RETURN QUERY
    SELECT n.id, n.kind, n.category, n.params, k.placeholders, n.created_at, x.read_at, t.subject, t.body
    FROM notify.notifications n
    JOIN notify.event_kinds k ON k.kind = n.kind
    LEFT JOIN notify.inbox_reads x ON x.notification_id = n.id
    LEFT JOIN notify.templates t ON t.id = notify.current_template(n.kind, 'email', v_locale)
    WHERE n.recipient_id = v_r AND NOT (n.category = 'marketing' AND n.status = 'suppressed')
    ORDER BY n.id DESC
    LIMIT least(greatest(coalesce(p_limit, 50), 1), 100);
END $$;

CREATE FUNCTION notify.web_unread(p_session bytea) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, notify AS $$
DECLARE
  v_r uuid := notify.web_recipient(p_session, false);
BEGIN
  IF v_r IS NULL THEN RETURN 0; END IF;
  RETURN (SELECT count(*)::integer FROM notify.notifications n
          WHERE n.recipient_id = v_r AND NOT (n.category = 'marketing' AND n.status = 'suppressed')
            AND NOT EXISTS (SELECT 1 FROM notify.inbox_reads x WHERE x.notification_id = n.id));
END $$;

/** Marks the given notifications (NULL: all) of the signed-in investor as read; returns how many. Others' ids are ignored. */
CREATE FUNCTION notify.web_mark_read(p_session bytea, p_ids bigint[]) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, notify AS $$
DECLARE
  v_r uuid := notify.web_recipient(p_session, false);
  n integer;
BEGIN
  IF v_r IS NULL THEN RETURN 0; END IF;
  IF p_ids IS NOT NULL AND cardinality(p_ids) > 200 THEN RAISE EXCEPTION 'at most 200 notifications at once' USING ERRCODE = '22023'; END IF;
  INSERT INTO notify.inbox_reads (notification_id, recipient_id)
  SELECT n.id, v_r FROM notify.notifications n
  WHERE n.recipient_id = v_r AND (p_ids IS NULL OR n.id = ANY (p_ids))
    AND NOT (n.category = 'marketing' AND n.status = 'suppressed')
    AND NOT EXISTS (SELECT 1 FROM notify.inbox_reads x WHERE x.notification_id = n.id)
  ON CONFLICT (notification_id) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

/** The signed-in investor's message settings (no contact details: only whether one is on file). */
CREATE FUNCTION notify.web_settings(p_session bytea)
RETURNS TABLE (locale text, sms_on_file boolean, email_on_file boolean, sms_enabled boolean, email_enabled boolean,
               sms_marketing boolean, email_marketing boolean, marketing_version text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, notify AS $$
#variable_conflict use_column
DECLARE
  v_r uuid := notify.web_recipient(p_session, false);
  s webauth.sessions := webauth.live_session(p_session);
BEGIN
  IF s.token_hash IS NULL OR notify.web_subject(s.investor_id) IS NULL THEN RETURN; END IF;
  IF v_r IS NULL THEN
    -- Nothing chosen yet: the defaults (English, transactional on, marketing off).
    RETURN QUERY SELECT 'en'::text, false, false, true, true, false, false, NULL::text;
    RETURN;
  END IF;
  RETURN QUERY SELECT r.locale,
    EXISTS (SELECT 1 FROM notify.contacts c WHERE c.recipient_id = v_r AND c.channel = 'sms' AND c.superseded_at IS NULL),
    EXISTS (SELECT 1 FROM notify.contacts c WHERE c.recipient_id = v_r AND c.channel = 'email' AND c.superseded_at IS NULL),
    notify.channel_enabled(v_r, 'sms'), notify.channel_enabled(v_r, 'email'),
    notify.marketing_allowed(v_r, 'sms'), notify.marketing_allowed(v_r, 'email'),
    (SELECT c.text_version FROM notify.consents c WHERE c.recipient_id = v_r AND c.granted ORDER BY c.id DESC LIMIT 1)
  FROM notify.recipients r WHERE r.id = v_r;
END $$;

/**
 * Changes the signed-in investor's settings. p_what: 'transactional' (channel on/off, N-3),
 * 'marketing' (opt-in/out with the consent text version, NP-5) or 'locale' (p_value 'en'|'ur').
 * Returns 'ok', 'session' (no live session or no KYC record) or 'invalid'. Only changes are written.
 */
CREATE FUNCTION notify.web_set(p_session bytea, p_what text, p_channel text, p_enabled boolean, p_value text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, notify AS $$
DECLARE
  v_r uuid := notify.web_recipient(p_session, true);
  v_actor text;
BEGIN
  IF v_r IS NULL THEN RETURN 'session'; END IF;
  v_actor := webauth.actor((webauth.live_session(p_session)).investor_id);
  IF p_what = 'locale' THEN
    IF p_value IS NULL OR p_value NOT IN ('en', 'ur') THEN RETURN 'invalid'; END IF;
    PERFORM notify.set_locale(v_r, p_value, v_actor);
  ELSIF p_what = 'transactional' THEN
    IF p_channel IS NULL OR p_channel NOT IN ('sms', 'email') OR p_enabled IS NULL THEN RETURN 'invalid'; END IF;
    IF notify.channel_enabled(v_r, p_channel) IS DISTINCT FROM p_enabled THEN
      PERFORM notify.set_preference(v_r, p_channel, p_enabled, v_actor);
    END IF;
  ELSIF p_what = 'marketing' THEN
    IF p_channel IS NULL OR p_channel NOT IN ('sms', 'email') OR p_enabled IS NULL
       OR p_value IS NULL OR p_value !~ '^[a-z][a-z0-9.-]{2,31}$' THEN
      RETURN 'invalid';
    END IF;
    IF notify.marketing_allowed(v_r, p_channel) IS DISTINCT FROM p_enabled THEN
      PERFORM notify.set_marketing_consent(v_r, p_channel, p_enabled, p_value, v_actor);
    END IF;
  ELSE
    RETURN 'invalid';
  END IF;
  RETURN 'ok';
END $$;

-- ================================================================== verification (N-8), extended
CREATE OR REPLACE FUNCTION notify.verify_audit() RETURNS TABLE (audit_id bigint, problem text)
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
  FOR r IN SELECT x.id::text AS id, 'recipient' AS what FROM notify.recipients x
             WHERE NOT EXISTS (SELECT 1 FROM notify.audit y WHERE y.action = 'recipient.registered' AND y.detail->>'recipient' = x.id::text)
           UNION ALL
           SELECT x.id::text, 'contact' FROM notify.contacts x
             WHERE NOT EXISTS (SELECT 1 FROM notify.audit y WHERE y.action = 'contact.registered' AND (y.detail->>'contact')::bigint = x.id)
           UNION ALL
           SELECT x.id::text, 'preference' FROM notify.preferences x
             WHERE NOT EXISTS (SELECT 1 FROM notify.audit y WHERE y.action = 'preference.set' AND (y.detail->>'preference')::bigint = x.id)
           UNION ALL
           SELECT x.id::text, 'consent' FROM notify.consents x
             WHERE NOT EXISTS (SELECT 1 FROM notify.audit y WHERE y.action = 'consent.set' AND (y.detail->>'consent')::bigint = x.id
                               AND (y.detail->>'granted')::boolean = x.granted)
           UNION ALL
           SELECT x.id::text, 'producer failure' FROM notify.producer_failures x
             WHERE NOT EXISTS (SELECT 1 FROM notify.audit y WHERE y.action = 'producer.failed' AND (y.detail->>'failure')::bigint = x.id)
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

-- ================================================================== privileges
REVOKE ALL ON ALL TABLES IN SCHEMA notify FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA notify FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA notify FROM PUBLIC;

GRANT EXECUTE ON FUNCTION notify.set_marketing_consent(uuid, text, boolean, text, text) TO pt_notify_service;
GRANT EXECUTE ON FUNCTION notify.sweep(text) TO pt_notify_worker, pt_notify_operator;
GRANT SELECT ON notify.producer_failures TO pt_notify_operator, pt_notify_reader;

-- NP-8: the website reaches notify only through the session-bound functions.
GRANT USAGE ON SCHEMA notify TO pt_web;
GRANT EXECUTE ON FUNCTION
  notify.web_inbox(bytea, text, integer),
  notify.web_unread(bytea),
  notify.web_mark_read(bytea, bigint[]),
  notify.web_settings(bytea),
  notify.web_set(bytea, text, text, boolean, text)
TO pt_web;

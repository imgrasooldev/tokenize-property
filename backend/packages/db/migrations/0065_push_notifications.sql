-- Push notifications to the investor app (ADR 0018 amendment 6, ADR 0013: "push later").
-- Applies on top of 0064.
--
--   PN-1  A push contact is one app installation: notify.contacts gains the channel 'push'. A
--         recipient may have several push contacts (one per linked device, papi.push_devices), but
--         one device token belongs to one current contact only. SMS and e-mail keep one current
--         contact per recipient.
--   PN-2  No readable token in the database (rule N-1). The public API seals the token for the
--         notification worker only: X25519 + HKDF-SHA256 + AES-256-GCM to the worker's public key
--         (NOTIFY_PUSH_PUBLIC_KEY). The API can seal but never open; only the worker holds the
--         private key (NOTIFY_PUSH_PRIVATE_KEY). The sealed value is bound to the recipient and the
--         lookup hash. The lookup hash is SHA-256("pt-notify-push-v1\n" || token): a device token is
--         a long random value, so a plain hash cannot be reversed by trying values.
--   PN-3  Only a live access token registers or removes its own device (papi.register_push,
--         papi.unregister_push). Registering supersedes the device's previous token and the same
--         token on any other account (a phone signed in to another account no longer receives the
--         first account's notices).
--   PN-4  Signing a device out ends its push contact: revoking a token family (sign-out, token
--         reuse, removal on the website, a revoked KYC subject) supersedes its push contact in the
--         same transaction (trigger on papi.tokens).
--   PN-5  A token the push service reports as gone (unregistered) is superseded by the worker
--         (notify.push_contact_gone), so it is not tried again.
--   PN-6  Push templates: every event kind that has an SMS template gets a push template with the
--         same text (version 1, en and ur), so investors receive the same short notices.
--   Push messages carry no personal data beyond the template (rule N-2); the title is fixed.

-- ================================================================== PN-1 the channel
ALTER TABLE notify.contacts DROP CONSTRAINT contacts_channel_check;
ALTER TABLE notify.contacts ADD CONSTRAINT contacts_channel_check CHECK (channel IN ('sms', 'email', 'push'));
DROP INDEX notify.contacts_one_current;
CREATE UNIQUE INDEX contacts_one_current ON notify.contacts (recipient_id, channel) WHERE superseded_at IS NULL AND channel <> 'push';
CREATE UNIQUE INDEX contacts_push_token_once ON notify.contacts (lookup_hash) WHERE superseded_at IS NULL AND channel = 'push';

CREATE TABLE papi.push_devices (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  family        uuid NOT NULL,
  investor_id   uuid NOT NULL REFERENCES webdemo.investors (id),
  contact_id    bigint NOT NULL UNIQUE REFERENCES notify.contacts (id),
  platform      text NOT NULL CHECK (platform IN ('android', 'ios')),
  registered_at timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  removed_at    timestamptz,
  removed_why   text CHECK (removed_why IN ('replaced', 'unregistered', 'signed_out', 'gone', 'moved')),
  CHECK ((removed_at IS NULL) = (removed_why IS NULL))
);
CREATE UNIQUE INDEX push_devices_one_per_family ON papi.push_devices (family) WHERE removed_at IS NULL;
CREATE TRIGGER push_devices_no_delete BEFORE DELETE ON papi.push_devices FOR EACH ROW EXECUTE FUNCTION papi.forbid_delete();
CREATE TRIGGER push_devices_no_truncate BEFORE TRUNCATE ON papi.push_devices FOR EACH STATEMENT EXECUTE FUNCTION compliance.forbid_change();

CREATE FUNCTION papi.guard_push_device() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.removed_at IS NOT NULL OR NEW.removed_at IS NULL
     OR (NEW.id, NEW.family, NEW.investor_id, NEW.contact_id, NEW.platform, NEW.registered_at)
        IS DISTINCT FROM (OLD.id, OLD.family, OLD.investor_id, OLD.contact_id, OLD.platform, OLD.registered_at) THEN
    RAISE EXCEPTION 'push device % can only be removed, once', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER push_devices_guard BEFORE UPDATE ON papi.push_devices FOR EACH ROW EXECUTE FUNCTION papi.guard_push_device();

/** Not granted: ends a push contact and its device row (both append-only, superseded once). */
CREATE FUNCTION papi.push_end(p_contact bigint, p_why text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, papi AS $$
DECLARE
  v_now timestamptz := date_trunc('microseconds', clock_timestamp());
BEGIN
  UPDATE notify.contacts SET superseded_at = greatest(v_now, registered_at) WHERE id = p_contact AND superseded_at IS NULL;
  UPDATE papi.push_devices SET removed_at = v_now, removed_why = p_why WHERE contact_id = p_contact AND removed_at IS NULL;
END $$;

-- ================================================================== PN-3 the app registers its device
/**
 * The notification recipient of a live access token's investor (registered on first use), so the
 * API can bind the sealed token to it. NULL without a live token or without a KYC subject.
 */
CREATE FUNCTION papi.push_recipient(p_access_hash bytea, p_locale text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, papi AS $$
DECLARE
  v_subject uuid := papi.subject(p_access_hash);
BEGIN
  IF v_subject IS NULL THEN RETURN NULL; END IF;
  RETURN notify.register_recipient('investor', v_subject::text, CASE WHEN p_locale IN ('en', 'ur') THEN p_locale ELSE 'en' END, 'papi');
END $$;

/**
 * Registers the calling device's push token. 'ok' (also when the same token is already current
 * for this device), 'token' (no live access token), 'recipient' (the recipient is not this
 * investor's), 'input' (bad platform, hash or sealed value).
 */
CREATE FUNCTION papi.register_push(p_access_hash bytea, p_recipient uuid, p_platform text, p_lookup_hash bytea, p_sealed bytea) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, papi AS $$
DECLARE
  t papi.tokens;
  v_subject uuid;
  cur papi.push_devices;
  v_old bigint;
  v_contact bigint;
BEGIN
  SELECT * INTO t FROM papi.tokens
  WHERE access_hash = p_access_hash AND revoked_at IS NULL AND access_expires_at > clock_timestamp();
  IF NOT FOUND THEN RETURN 'token'; END IF;
  SELECT i.kyc_subject INTO v_subject FROM webdemo.investors i WHERE i.id = t.investor_id;
  IF v_subject IS NULL OR NOT EXISTS (SELECT 1 FROM notify.recipients r
                                      WHERE r.id = p_recipient AND r.subject_type = 'investor' AND r.subject_id = v_subject::text) THEN
    RETURN 'recipient';
  END IF;
  IF p_platform IS NULL OR p_platform NOT IN ('android', 'ios') OR p_lookup_hash IS NULL OR length(p_lookup_hash) <> 32
     OR p_sealed IS NULL OR length(p_sealed) NOT BETWEEN 30 AND 400 THEN
    RETURN 'input';
  END IF;
  -- One registration per device at a time (concurrent calls from the same app).
  PERFORM pg_advisory_xact_lock(586586173, hashtext(t.family::text));

  SELECT d.* INTO cur FROM papi.push_devices d WHERE d.family = t.family AND d.removed_at IS NULL;
  IF FOUND THEN
    IF (SELECT c.lookup_hash FROM notify.contacts c WHERE c.id = cur.contact_id) = p_lookup_hash
       AND (SELECT c.recipient_id FROM notify.contacts c WHERE c.id = cur.contact_id) = p_recipient AND cur.platform = p_platform THEN
      RETURN 'ok';
    END IF;
    PERFORM papi.push_end(cur.contact_id, 'replaced');
  END IF;
  -- The same token current anywhere else (another account signed in on this phone before).
  SELECT c.id INTO v_old FROM notify.contacts c WHERE c.channel = 'push' AND c.lookup_hash = p_lookup_hash AND c.superseded_at IS NULL;
  IF v_old IS NOT NULL THEN PERFORM papi.push_end(v_old, 'moved'); END IF;

  INSERT INTO notify.contacts (recipient_id, channel, lookup_hash, sealed, key_version, registered_by)
  VALUES (p_recipient, 'push', p_lookup_hash, p_sealed, 1, 'papi')
  RETURNING id INTO v_contact;
  INSERT INTO papi.push_devices (family, investor_id, contact_id, platform) VALUES (t.family, t.investor_id, v_contact, p_platform);
  PERFORM notify.audit_append('papi', 'contact.registered', jsonb_build_object('contact', v_contact, 'recipient', p_recipient,
    'channel', 'push', 'keyVersion', 1, 'previous', cur.contact_id));
  PERFORM papi.audit(t.investor_id, 'device.push_registered', jsonb_build_object('family', t.family, 'platform', p_platform));
  RETURN 'ok';
END $$;

/** The calling device stops receiving notifications. false without a live access token. */
CREATE FUNCTION papi.unregister_push(p_access_hash bytea) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, papi AS $$
DECLARE
  t papi.tokens;
  v_contact bigint;
BEGIN
  SELECT * INTO t FROM papi.tokens
  WHERE access_hash = p_access_hash AND revoked_at IS NULL AND access_expires_at > clock_timestamp();
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT d.contact_id INTO v_contact FROM papi.push_devices d WHERE d.family = t.family AND d.removed_at IS NULL;
  IF v_contact IS NOT NULL THEN
    PERFORM papi.push_end(v_contact, 'unregistered');
    PERFORM papi.audit(t.investor_id, 'device.push_removed', jsonb_build_object('family', t.family));
  END IF;
  RETURN true;
END $$;

-- ================================================================== PN-4 sign-out ends push
CREATE FUNCTION papi.push_on_revoke() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, papi AS $$
DECLARE
  v_contact bigint;
BEGIN
  SELECT d.contact_id INTO v_contact FROM papi.push_devices d WHERE d.family = NEW.family AND d.removed_at IS NULL;
  IF v_contact IS NOT NULL THEN PERFORM papi.push_end(v_contact, 'signed_out'); END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER tokens_push_on_revoke AFTER UPDATE OF revoked_at ON papi.tokens
  FOR EACH ROW WHEN (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL) EXECUTE FUNCTION papi.push_on_revoke();

-- ================================================================== PN-5 the worker drops a dead token
/** The push service says the delivery's token no longer exists: supersede it (lease owner only). */
CREATE FUNCTION notify.push_contact_gone(p_id bigint, p_worker text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, notify AS $$
DECLARE
  v_contact bigint;
BEGIN
  SELECT d.contact_id INTO v_contact FROM notify.deliveries d
  WHERE d.id = p_id AND d.channel = 'push' AND d.lease_owner = p_worker AND d.lease_until > now();
  IF v_contact IS NULL THEN RETURN false; END IF;
  PERFORM papi.push_end(v_contact, 'gone');
  PERFORM notify.audit_append(p_worker, 'contact.gone', jsonb_build_object('contact', v_contact, 'delivery', p_id));
  RETURN true;
END $$;

-- ================================================================== PN-6 templates
SELECT notify.add_template(t.kind, 'push', t.locale, NULL, t.body, 'migration-0065')
FROM (
  SELECT DISTINCT ON (kind, locale) kind, locale, body
  FROM notify.templates WHERE channel = 'sms'
  ORDER BY kind, locale, version DESC
) t
WHERE NOT EXISTS (SELECT 1 FROM notify.templates p WHERE p.kind = t.kind AND p.locale = t.locale AND p.channel = 'push')
ORDER BY t.kind, t.locale;

-- ================================================================== privileges
REVOKE ALL ON TABLE papi.push_devices FROM PUBLIC;
REVOKE ALL ON FUNCTION papi.guard_push_device(), papi.push_end(bigint, text), papi.push_recipient(bytea, text),
  papi.register_push(bytea, uuid, text, bytea, bytea), papi.unregister_push(bytea), papi.push_on_revoke(),
  notify.push_contact_gone(bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION papi.push_recipient(bytea, text), papi.register_push(bytea, uuid, text, bytea, bytea), papi.unregister_push(bytea)
  TO pt_svc_public_api;
GRANT EXECUTE ON FUNCTION notify.push_contact_gone(bigint, text) TO pt_notify_worker;

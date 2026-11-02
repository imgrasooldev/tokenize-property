-- goAML draft for STR filings with the Financial Monitoring Unit (threat KYC-2 follow-up). Applies on top of 0049.
--
--   GA-1  compliance.goaml_settings: the reporting entity's goAML values (FMU-assigned entity id,
--         branch, address, the codes used for Raast transfers and funds types). Every value is a
--         PLACEHOLDER until the FMU registration confirms it; the export says so in the file.
--   GA-2  compliance.goaml_indicators: the goAML indicator code for each STR category (PLACEHOLDER
--         codes until the FMU's indicator list is confirmed).
--   GA-3  admin.str_goaml_data(session, case): what the goAML file needs, for compliance.export only:
--         the case, the settings, the indicator and the investor's money movements (subscription
--         credits, their returns and refunds, rent payouts). No name, CNIC or IBAN: the MLRO adds the
--         person's identity from the KYC record (the portal never holds it). The STR export (ZIP)
--         adds the goAML XML next to the case JSON; nothing is sent anywhere automatically.
--   GA-4  Compliance officers change a setting or an indicator code (compliance.decide, step-up,
--         audited in both chains); never investors, operations or administrators.

CREATE TABLE compliance.goaml_settings (
  key        text PRIMARY KEY CHECK (key IN ('rentity_id', 'rentity_branch', 'entity_address', 'entity_city', 'entity_country', 'transmode_code',
                                             'funds_code_in', 'funds_code_out', 'schema_version')),
  value      text NOT NULL CHECK (length(value) BETWEEN 1 AND 200),
  placeholder boolean NOT NULL DEFAULT true,
  updated_by text NOT NULL DEFAULT 'migration:0050',
  updated_at timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp())
);

INSERT INTO compliance.goaml_settings (key, value) VALUES
  ('rentity_id', '0000'),
  ('rentity_branch', 'Head office'),
  ('entity_address', 'Registered office address (to confirm)'),
  ('entity_city', 'Lahore'),
  ('entity_country', 'PK'),
  ('transmode_code', 'EFT'),
  ('funds_code_in', 'K'),
  ('funds_code_out', 'K'),
  ('schema_version', '4.0');

CREATE TABLE compliance.goaml_indicators (
  category   text PRIMARY KEY,
  indicator  text NOT NULL CHECK (indicator ~ '^[A-Za-z0-9_.-]{1,40}$'),
  placeholder boolean NOT NULL DEFAULT true,
  updated_by text NOT NULL DEFAULT 'migration:0050',
  updated_at timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp())
);

INSERT INTO compliance.goaml_indicators (category, indicator)
SELECT code, 'PT-' || upper(code) FROM compliance.reason_codes WHERE applies_to = 'str';

/** GA-4: one compliance officer changes a goAML setting or indicator (no longer a placeholder). */
CREATE FUNCTION admin.goaml_set(p_session bytea, p_kind text, p_key text, p_value text, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'compliance.decide');
  v_handle text := admin.handle_of(v_me);
  v_old text;
BEGIN
  PERFORM admin.require_step_up(p_session);
  IF NOT admin.reason_ok(p_reason) THEN RETURN admin.refuse(v_me, 'goaml', coalesce(p_key, '-'), 'set', 'a reason of 10 to 500 characters is required'); END IF;
  IF p_value IS NULL OR length(btrim(p_value)) NOT BETWEEN 1 AND 200 THEN
    RETURN admin.refuse(v_me, 'goaml', coalesce(p_key, '-'), 'set', 'a value of 1 to 200 characters is required');
  END IF;
  IF p_kind = 'setting' THEN
    SELECT value INTO v_old FROM compliance.goaml_settings WHERE key = p_key;
    IF NOT FOUND THEN RETURN admin.refuse(v_me, 'goaml', coalesce(p_key, '-'), 'set', 'unknown goAML setting'); END IF;
    UPDATE compliance.goaml_settings SET value = btrim(p_value), placeholder = false, updated_by = v_handle, updated_at = clock_timestamp() WHERE key = p_key;
  ELSIF p_kind = 'indicator' THEN
    SELECT indicator INTO v_old FROM compliance.goaml_indicators WHERE category = p_key;
    IF NOT FOUND THEN RETURN admin.refuse(v_me, 'goaml', coalesce(p_key, '-'), 'set', 'unknown STR category'); END IF;
    IF btrim(p_value) !~ '^[A-Za-z0-9_.-]{1,40}$' THEN RETURN admin.refuse(v_me, 'goaml', p_key, 'set', 'an indicator code of letters, digits, _ . - is required'); END IF;
    UPDATE compliance.goaml_indicators SET indicator = btrim(p_value), placeholder = false, updated_by = v_handle, updated_at = clock_timestamp() WHERE category = p_key;
  ELSE
    RETURN admin.refuse(v_me, 'goaml', coalesce(p_key, '-'), 'set', 'choose a setting or an indicator');
  END IF;
  PERFORM compliance.audit_append(v_handle, 'goaml.set', jsonb_build_object('kind', p_kind, 'key', p_key, 'from', v_old, 'to', btrim(p_value), 'reason', btrim(p_reason)));
  PERFORM admin.audit_append(v_me::text, 'compliance.goaml_set', jsonb_build_object('kind', p_kind, 'key', p_key, 'to', btrim(p_value)));
  RETURN jsonb_build_object('ok', true, 'status', 'saved');
END $$;

/** The goAML values for the compliance pages (settings and indicators with their placeholder flags). */
CREATE FUNCTION admin.goaml_config(p_session bytea) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
BEGIN
  PERFORM admin.require(p_session, 'compliance.read');
  RETURN jsonb_build_object(
    'settings', (SELECT jsonb_agg(jsonb_build_object('key', s.key, 'value', s.value, 'placeholder', s.placeholder, 'by', s.updated_by, 'at', s.updated_at) ORDER BY s.key)
                 FROM compliance.goaml_settings s),
    'indicators', (SELECT jsonb_agg(jsonb_build_object('category', i.category, 'label', r.label, 'indicator', i.indicator, 'placeholder', i.placeholder) ORDER BY i.category)
                   FROM compliance.goaml_indicators i JOIN compliance.reason_codes r ON r.code = i.category AND r.applies_to = 'str'));
END $$;

/** GA-3: the content of the goAML file for one STR case (compliance.export). */
CREATE FUNCTION admin.str_goaml_data(p_session bytea, p_id bigint) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  s compliance.str_cases;
BEGIN
  PERFORM admin.require(p_session, 'compliance.export');
  SELECT * INTO s FROM compliance.str_cases WHERE id = p_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN jsonb_build_object(
    'case', s.id, 'category', s.category, 'summary', s.summary, 'openedAtUtc', admin.utc(s.opened_at),
    'categoryLabel', (SELECT label FROM compliance.reason_codes WHERE code = s.category AND applies_to = 'str'),
    'indicator', (SELECT jsonb_build_object('code', i.indicator, 'placeholder', i.placeholder) FROM compliance.goaml_indicators i WHERE i.category = s.category),
    'settings', (SELECT jsonb_object_agg(g.key, jsonb_build_object('value', g.value, 'placeholder', g.placeholder)) FROM compliance.goaml_settings g),
    'subject', CASE WHEN s.subject_id IS NOT NULL THEN jsonb_build_object(
        'subjectId', s.subject_id, 'cnicMasked', (SELECT admin.mask_cnic(x.cnic_last4) FROM kyc.subjects x WHERE x.id = s.subject_id),
        'wallet', (SELECT w.wallet FROM kyc.wallets w WHERE w.subject_id = s.subject_id)) END,
    'actions', coalesce((SELECT jsonb_agg(format('%s %s (%s)', q.kind, q.status, q.reason_code) ORDER BY q.id)
                         FROM compliance.freeze_requests q WHERE s.subject_id IS NOT NULL AND q.subject_id = s.subject_id), '[]'::jsonb),
    'transactions', CASE WHEN s.subject_id IS NULL THEN '[]'::jsonb ELSE coalesce((SELECT jsonb_agg(t ORDER BY t->>'date', t->>'ref') FROM (
        -- Money in: subscription payments matched to the investor's payment codes.
        SELECT jsonb_build_object('direction', 'in', 'ref', c.raast_ref, 'internalRef', c.intent_code, 'date', c.value_date, 'amountPaisa', c.amount_paisa::text,
                                  'counterpartyLast4', c.payer_last4, 'purpose', 'subscription payment') AS t
          FROM bank.credits c JOIN bank.payment_intents i ON i.code = c.intent_code
         WHERE i.subject_id = s.subject_id AND c.status = 'matched'
        UNION ALL
        -- Money back out: returned or refunded subscription payments.
        SELECT jsonb_build_object('direction', 'out', 'ref', c.raast_ref || '-R', 'internalRef', c.intent_code, 'date', r.at::date, 'amountPaisa', c.amount_paisa::text,
                                  'counterpartyLast4', c.payer_last4, 'purpose', 'subscription refund')
          FROM bank.credit_refunds r JOIN bank.credits c ON c.raast_ref = r.raast_ref JOIN bank.payment_intents i ON i.code = c.intent_code
         WHERE i.subject_id = s.subject_id
        UNION ALL
        -- Money out: rent and other payouts to the investor's own account.
        SELECT jsonb_build_object('direction', 'out', 'ref', b.reference || '/' || pi.line_no, 'internalRef', b.reference, 'date', coalesce(b.submitted_at, b.created_at)::date,
                                  'amountPaisa', pi.amount_paisa::text, 'counterpartyLast4', p.iban_last4, 'purpose', 'payout')
          FROM bank.payout_items pi JOIN bank.payout_batches b ON b.id = pi.batch_id AND b.status = 'submitted' JOIN bank.payees p ON p.id = pi.payee_id
         WHERE pi.subject_id = s.subject_id) x), '[]'::jsonb) END);
END $$;

REVOKE ALL ON TABLE compliance.goaml_settings, compliance.goaml_indicators FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.goaml_set(bytea, text, text, text, text), admin.goaml_config(bytea), admin.str_goaml_data(bytea, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.goaml_set(bytea, text, text, text, text), admin.goaml_config(bytea), admin.str_goaml_data(bytea, bigint) TO pt_admin_portal;

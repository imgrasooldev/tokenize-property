-- Tenant rent-collection links (later features: tenant rent-collection link; S-03 OP-1..OP-5 in part).
-- Applies on top of 0043.
--
--   RI-1  An operations maker issues a rent invoice for a token and period (tenant label, amount,
--         due date) with a fresh step-up. It gets a payment reference TR-XXXX-XXXX for the bank
--         narration and a one-time-shown link secret; only the link's SHA-256 is stored.
--   RI-2  The public payment page (website /pay/<secret>, no sign-in) shows only what the tenant needs:
--         token, period, tenant label, amount, due date, reference, status and the collection account
--         text (ops.settings rent_account_display, a PLACEHOLDER until the trustee bank account is
--         confirmed). Unknown or cancelled links read as not found.
--   RI-3  Payment is recorded maker-checker on the existing S-03 path: a maker links the invoice to
--         an incoming bank statement line of the same amount (ops.propose_collection, note carries
--         the reference), a different checker decides the collection (ops.decide_collection, now
--         also from PT Control); approval marks the invoice paid, rejection reopens it.
--   RI-4  Invoices cannot be rewritten: only status, collection link and cancellation move forward.

INSERT INTO ops.settings (key, value, note) VALUES
  ('rent_account_display', '"Trustee rent collection account: details to be confirmed by the trustee bank (PLACEHOLDER)"'::jsonb,
   'text shown to tenants on the rent payment page (RI-2); PLACEHOLDER until the trustee bank account is confirmed');

CREATE TABLE ops.rent_invoices (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  token         text NOT NULL CHECK (ops.is_address(token)),
  period        text NOT NULL CHECK (ops.is_period(period)),
  tenant_label  text NOT NULL CHECK (compliance.free_text_ok(tenant_label, 2, 80)),
  amount_paisa  bigint NOT NULL CHECK (amount_paisa BETWEEN 1 AND 100000000000000),
  due_date      date NOT NULL,
  code          text NOT NULL UNIQUE CHECK (code ~ '^TR-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$'),
  link_hash     bytea NOT NULL UNIQUE CHECK (length(link_hash) = 32),
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'proposed', 'paid', 'cancelled')),
  collection_id bigint REFERENCES ops.collections (id),
  created_by    text NOT NULL CHECK (length(created_by) BETWEEN 2 AND 100),
  created_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  cancelled_by  text,
  CHECK ((status = 'open') = (collection_id IS NULL) OR status = 'cancelled')
);
CREATE INDEX rent_invoices_status ON ops.rent_invoices (status, due_date);

CREATE FUNCTION ops.guard_rent_invoice() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' OR (NEW.token, NEW.period, NEW.tenant_label, NEW.amount_paisa, NEW.due_date, NEW.code, NEW.link_hash, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM (OLD.token, OLD.period, OLD.tenant_label, OLD.amount_paisa, OLD.due_date, OLD.code, OLD.link_hash, OLD.created_by, OLD.created_at)
     OR OLD.status IN ('paid', 'cancelled') THEN
    RAISE EXCEPTION 'a rent invoice''s terms never change, and a paid or cancelled invoice is final' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rent_invoices_guard BEFORE UPDATE OR DELETE ON ops.rent_invoices FOR EACH ROW EXECUTE FUNCTION ops.guard_rent_invoice();

/** Crockford base-32 (no I, L, O, U), as the investors' payment codes. */
CREATE FUNCTION ops.new_invoice_code() RETURNS text
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog AS $$
DECLARE
  a constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  b bytea := decode(replace(gen_random_uuid()::text, '-', ''), 'hex');
  s text := '';
BEGIN
  FOR i IN 0..7 LOOP
    s := s || substr(a, (get_byte(b, i) % 32) + 1, 1);
  END LOOP;
  RETURN 'TR-' || left(s, 4) || '-' || right(s, 4);
END $$;

-- ================================================================== RI-1, RI-3 PT Control
CREATE FUNCTION admin.create_rent_invoice(p_session bytea, p_token text, p_period text, p_tenant text, p_amount bigint, p_due date) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'operations.request');
  v_handle text := admin.handle_of(v_me);
  v_secret text := replace(replace(rtrim(encode(decode(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'hex'), 'base64'), '='), '+', '-'), '/', '_');
  v_code text;
  v_id bigint;
BEGIN
  PERFORM admin.require_step_up(p_session);
  IF NOT ops.is_address(coalesce(p_token, '')) OR NOT EXISTS (SELECT 1 FROM chain.tokens WHERE token = p_token) THEN
    RETURN admin.refuse(v_me, 'rent_invoice', '-', 'create', 'unknown token');
  END IF;
  IF NOT ops.is_period(coalesce(p_period, '')) OR p_amount IS NULL OR p_amount <= 0 OR p_due IS NULL OR p_due < current_date - 31
     OR NOT compliance.free_text_ok(coalesce(p_tenant, ''), 2, 80) THEN
    RETURN admin.refuse(v_me, 'rent_invoice', '-', 'create', 'a period (YYYY-MM), a tenant label without ID numbers, a positive amount and a due date are required');
  END IF;
  LOOP
    v_code := ops.new_invoice_code();
    EXIT WHEN NOT EXISTS (SELECT 1 FROM ops.rent_invoices WHERE code = v_code);
  END LOOP;
  INSERT INTO ops.rent_invoices (token, period, tenant_label, amount_paisa, due_date, code, link_hash, created_by)
  VALUES (p_token, p_period, btrim(p_tenant), p_amount, p_due, v_code, sha256(convert_to(v_secret, 'UTF8')), v_handle)
  RETURNING id INTO v_id;
  PERFORM ops.audit_append(v_handle, 'invoice.created', jsonb_build_object('invoice', v_id, 'code', v_code, 'token', p_token, 'period', p_period,
    'amount', p_amount::text));
  PERFORM admin.audit_append(v_me::text, 'operations.requested', jsonb_build_object('kind', 'rent_invoice', 'ref', v_id, 'action', 'create'));
  -- The link secret is returned once; only its hash is kept.
  RETURN jsonb_build_object('ok', true, 'id', v_id, 'code', v_code, 'link', v_secret);
END $$;

CREATE FUNCTION admin.rent_invoices(p_session bytea) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
BEGIN
  PERFORM admin.require(p_session, 'operations.read');
  RETURN jsonb_build_object(
    'invoices', coalesce((SELECT jsonb_agg(jsonb_build_object('id', i.id, 'token', i.token, 'period', i.period, 'tenant', i.tenant_label,
                  'amount', i.amount_paisa::text, 'due', i.due_date, 'code', i.code, 'status', i.status, 'collection', i.collection_id,
                  'collectionStatus', (SELECT c.status FROM ops.collections c WHERE c.id = i.collection_id),
                  'collectionBy', (SELECT c.proposed_by FROM ops.collections c WHERE c.id = i.collection_id),
                  'overdue', i.status = 'open' AND i.due_date < current_date, 'by', i.created_by, 'at', admin.utc(i.created_at),
                  -- Incoming bank lines of the same amount in the last 60 days not yet used for a collection.
                  'candidates', CASE WHEN i.status = 'open' THEN coalesce((SELECT jsonb_agg(jsonb_build_object('statement', l.statement_id, 'line', l.line_no,
                       'date', l.value_date, 'reference', l.reference, 'counterparty', left(l.counterparty, 60)) ORDER BY l.value_date DESC)
                     FROM recon.bank_lines l
                     WHERE l.amount_paisa = i.amount_paisa AND l.value_date >= current_date - 60
                       AND NOT EXISTS (SELECT 1 FROM ops.collections c WHERE c.statement_id = l.statement_id AND c.line_no = l.line_no AND c.status <> 'rejected')),
                     '[]'::jsonb) END) ORDER BY i.id DESC)
                FROM (SELECT * FROM ops.rent_invoices ORDER BY id DESC LIMIT 200) i), '[]'::jsonb),
    'tokens', coalesce((SELECT jsonb_agg(t.token ORDER BY t.token) FROM chain.tokens t), '[]'::jsonb));
END $$;

/** Maker: the invoice was paid by this bank line (RI-3): proposes the collection; a checker decides it. */
CREATE FUNCTION admin.record_invoice_payment(p_session bytea, p_invoice bigint, p_statement bigint, p_line integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'operations.request');
  v_handle text := admin.handle_of(v_me);
  i ops.rent_invoices;
  l recon.bank_lines;
  v_col bigint;
BEGIN
  PERFORM admin.require_step_up(p_session);
  SELECT * INTO i FROM ops.rent_invoices WHERE id = p_invoice FOR UPDATE;
  IF NOT FOUND OR i.status <> 'open' THEN RETURN admin.refuse(v_me, 'rent_invoice', coalesce(p_invoice::text, '-'), 'record', 'no open invoice with this id'); END IF;
  SELECT * INTO l FROM recon.bank_lines WHERE statement_id = p_statement AND line_no = p_line;
  IF NOT FOUND OR l.amount_paisa <> i.amount_paisa THEN
    RETURN admin.refuse(v_me, 'rent_invoice', p_invoice::text, 'record', 'the bank line does not exist or its amount differs from the invoice');
  END IF;
  BEGIN
    PERFORM admin.bind_officer(v_handle);
    v_col := ops.propose_collection(i.token, p_statement, p_line, format('rent invoice %s (%s, %s)', i.code, i.tenant_label, i.period), v_handle);
    PERFORM admin.unbind_officer(v_handle);
  EXCEPTION WHEN SQLSTATE '23514' OR SQLSTATE '23505' OR SQLSTATE 'P0002' OR SQLSTATE '22023' OR SQLSTATE '42501' THEN
    RETURN admin.refuse(v_me, 'rent_invoice', p_invoice::text, 'record', SQLERRM);
  END;
  UPDATE ops.rent_invoices SET status = 'proposed', collection_id = v_col WHERE id = i.id;
  PERFORM admin.audit_append(v_me::text, 'operations.requested', jsonb_build_object('kind', 'rent_invoice', 'ref', i.id, 'action', 'record', 'collection', v_col));
  RETURN jsonb_build_object('ok', true, 'id', v_col, 'status', 'proposed');
END $$;

/** Checker: decides a collection (S-03 OP-1) from PT Control; a linked invoice follows (RI-3). */
CREATE FUNCTION admin.decide_collection(p_session bytea, p_id bigint, p_decision text, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'operations.decide');
  v_handle text := admin.handle_of(v_me);
  v_status text;
BEGIN
  PERFORM admin.require_step_up(p_session);
  PERFORM admin.check_decision(p_decision, p_reason);
  BEGIN
    PERFORM admin.bind_officer(v_handle);
    v_status := ops.decide_collection(p_id, v_handle, p_decision, p_reason);
    PERFORM admin.unbind_officer(v_handle);
  EXCEPTION WHEN SQLSTATE '23514' OR SQLSTATE '23505' OR SQLSTATE 'P0002' OR SQLSTATE '22023' OR SQLSTATE '42501' THEN
    RETURN admin.refuse(v_me, 'collection', coalesce(p_id::text, '-'), coalesce(p_decision, '-'), SQLERRM);
  END;
  UPDATE ops.rent_invoices SET status = CASE WHEN v_status = 'approved' THEN 'paid' ELSE 'open' END,
         collection_id = CASE WHEN v_status = 'approved' THEN collection_id ELSE NULL END
  WHERE collection_id = p_id AND status = 'proposed';
  PERFORM admin.audit_append(v_me::text, 'operations.decided', jsonb_build_object('kind', 'collection', 'ref', p_id, 'action', p_decision, 'result', v_status));
  RETURN jsonb_build_object('ok', true, 'id', p_id, 'status', v_status);
END $$;

CREATE FUNCTION admin.cancel_rent_invoice(p_session bytea, p_id bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'operations.request');
BEGIN
  PERFORM admin.require_step_up(p_session);
  UPDATE ops.rent_invoices SET status = 'cancelled', cancelled_by = admin.handle_of(v_me) WHERE id = p_id AND status = 'open';
  IF NOT FOUND THEN RETURN admin.refuse(v_me, 'rent_invoice', coalesce(p_id::text, '-'), 'cancel', 'only an open invoice is cancelled'); END IF;
  PERFORM admin.audit_append(v_me::text, 'operations.requested', jsonb_build_object('kind', 'rent_invoice', 'ref', p_id, 'action', 'cancel'));
  RETURN jsonb_build_object('ok', true, 'id', p_id, 'status', 'cancelled');
END $$;

-- ================================================================== RI-2 website
CREATE FUNCTION ops.web_invoice(p_link text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, ops AS $$
  SELECT jsonb_build_object('token', i.token, 'period', i.period, 'tenant', i.tenant_label, 'amountPaisa', i.amount_paisa::text,
           'due', i.due_date, 'code', i.code, 'status', i.status, 'account', (SELECT value #>> '{}' FROM ops.settings WHERE key = 'rent_account_display'))
  FROM ops.rent_invoices i
  WHERE p_link ~ '^[A-Za-z0-9_-]{43,64}$' AND i.link_hash = sha256(convert_to(p_link, 'UTF8')) AND i.status <> 'cancelled'
$$;

REVOKE ALL ON TABLE ops.rent_invoices FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.guard_rent_invoice(), ops.new_invoice_code(), ops.web_invoice(text),
  admin.create_rent_invoice(bytea, text, text, text, bigint, date), admin.rent_invoices(bytea),
  admin.record_invoice_payment(bytea, bigint, bigint, integer), admin.decide_collection(bytea, bigint, text, text),
  admin.cancel_rent_invoice(bytea, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.web_invoice(text) TO pt_web;
GRANT EXECUTE ON FUNCTION admin.create_rent_invoice(bytea, text, text, text, bigint, date), admin.rent_invoices(bytea),
  admin.record_invoice_payment(bytea, bigint, bigint, integer), admin.decide_collection(bytea, bigint, text, text),
  admin.cancel_rent_invoice(bytea, bigint) TO pt_admin_portal;

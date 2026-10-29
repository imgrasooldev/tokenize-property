-- PT Control: bank statement import from the portal (until now `npm run recon:import-bank`, a
-- break-glass CLI with the admin login). Applies on top of 0036.
--
--   BI-1  admin.import_bank_statement(session, account, date, opening, closing, lines): an operations
--         maker (operations.request) with a fresh step-up imports one statement of a registered bank
--         account under their own handle (bound for the call). recon.import_bank_statement checks it
--         again (R-5: line format, running balances, closing = opening + lines, unique references,
--         same content = same statement id, a different content for the same account and day is
--         refused) and reconciliation uses it on its next run.
--   BI-2  admin.bank_statements(session): the registered bank accounts and the latest imported
--         statements (operations.read), for the import page.
--   BI-3  Refusals are audited (approval.refused); imports as operations.requested.

CREATE FUNCTION admin.import_bank_statement(p_session bytea, p_account text, p_date date, p_opening bigint, p_closing bigint, p_lines jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'operations.request');
  v_handle text := admin.handle_of(v_me);
  v_id bigint;
BEGIN
  PERFORM admin.require_step_up(p_session);
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) > 100000 THEN
    RETURN admin.refuse(v_me, 'bank_statement', coalesce(p_account, '-'), 'import', 'a statement needs a lines array of at most 100,000 lines');
  END IF;
  BEGIN
    PERFORM admin.bind_officer(v_handle);
    v_id := recon.import_bank_statement(v_handle, p_account, p_date, p_opening, p_closing, p_lines);
    PERFORM admin.unbind_officer(v_handle);
  EXCEPTION WHEN SQLSTATE '23514' OR SQLSTATE '23505' OR SQLSTATE '23503' OR SQLSTATE '22023' OR SQLSTATE '22P02' OR SQLSTATE 'P0002' THEN
    RETURN admin.refuse(v_me, 'bank_statement', coalesce(p_account, '-'), 'import', SQLERRM);
  END;
  PERFORM admin.audit_append(v_me::text, 'operations.requested', jsonb_build_object('kind', 'bank_statement', 'ref', v_id, 'action', 'import',
    'account', p_account, 'date', p_date, 'lines', jsonb_array_length(p_lines)));
  RETURN jsonb_build_object('ok', true, 'id', v_id, 'status', 'imported');
END $$;

CREATE FUNCTION admin.bank_statements(p_session bytea) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
BEGIN
  PERFORM admin.require(p_session, 'operations.read');
  RETURN jsonb_build_object(
    'accounts', coalesce((SELECT jsonb_agg(a.account ORDER BY a.account) FROM recon.bank_accounts a), '[]'::jsonb),
    'statements', coalesce((SELECT jsonb_agg(jsonb_build_object('id', s.id, 'account', s.account, 'date', s.statement_date,
                   'opening', s.opening_paisa::text, 'closing', s.closing_paisa::text, 'by', s.imported_by, 'at', admin.utc(s.imported_at))
                   ORDER BY s.id DESC)
                 FROM (SELECT * FROM recon.bank_statements ORDER BY id DESC LIMIT 30) s), '[]'::jsonb));
END $$;

REVOKE ALL ON FUNCTION admin.import_bank_statement(bytea, text, date, bigint, bigint, jsonb), admin.bank_statements(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.import_bank_statement(bytea, text, date, bigint, bigint, jsonb), admin.bank_statements(bytea) TO pt_admin_portal;

-- PT Control bank desk: returning credits that sit in suspense, and follow-up batches for held
-- payouts (until now bank CLI functions run with the admin login). Applies on top of 0037.
--
--   BD-1  Suspense returns are maker-checker: an operations maker asks to return one credit in
--         suspense to its payer (reference, reason 10..300), a different operations checker
--         decides; an approval runs bank.return_credit under the checker's handle (payout gate,
--         ledger journal bank:return:<ref>, bank audit). Both steps need a fresh step-up; one open
--         request per credit; decided requests are final.
--   BD-2  admin.create_followup_batch(session, parent): an operations maker creates the follow-up
--         batch of a submitted distribution batch for every held line whose investor now has an
--         active payout account and that is not in a live follow-up yet (bank.create_followup_batch
--         checks it all again). The batch then needs the existing checker decision on
--         /approvals/payouts (maker-checker, gate, record-before-send).
--   BD-3  admin.bank_desk(session) (operations.read): credits in suspense (reference, amount, value
--         date, payer's last four digits only), open return requests, and submitted batches with
--         held lines that a follow-up could pay now.

CREATE TABLE admin.suspense_returns (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  raast_ref       text NOT NULL REFERENCES bank.credits (raast_ref),
  reason          text NOT NULL CHECK (length(reason) BETWEEN 10 AND 300),
  requested_by    uuid NOT NULL REFERENCES admin.officers (id),
  requested_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'approved', 'rejected')),
  decided_by      uuid REFERENCES admin.officers (id),
  decided_at      timestamptz,
  decision_reason text CHECK (decision_reason IS NULL OR length(decision_reason) BETWEEN 10 AND 500),
  journal_id      bigint,
  CHECK ((status = 'open') = (decided_by IS NULL)),
  CHECK (decided_by IS NULL OR decided_by <> requested_by),
  CHECK ((status = 'approved') = (journal_id IS NOT NULL))
);
CREATE UNIQUE INDEX suspense_returns_one_open ON admin.suspense_returns (raast_ref) WHERE status = 'open';

CREATE FUNCTION admin.suspense_returns_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, admin AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status <> 'open' OR NEW.status = 'open'
     OR (NEW.raast_ref, NEW.reason, NEW.requested_by, NEW.requested_at) IS DISTINCT FROM (OLD.raast_ref, OLD.reason, OLD.requested_by, OLD.requested_at) THEN
    RAISE EXCEPTION 'suspense return requests are append-only once decided' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER suspense_returns_guard BEFORE UPDATE OR DELETE ON admin.suspense_returns
  FOR EACH ROW EXECUTE FUNCTION admin.suspense_returns_guard();

-- ================================================================== BD-1
CREATE FUNCTION admin.request_suspense_return(p_session bytea, p_ref text, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'operations.request');
  v_id bigint;
BEGIN
  PERFORM admin.require_step_up(p_session);
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 10 AND 300 THEN
    RETURN admin.refuse(v_me, 'suspense_return', coalesce(p_ref, '-'), 'request', 'give a reason of 10 to 300 characters');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM bank.credits WHERE raast_ref = p_ref AND status = 'suspense')
     OR EXISTS (SELECT 1 FROM bank.credit_returns WHERE raast_ref = p_ref) THEN
    RETURN admin.refuse(v_me, 'suspense_return', coalesce(p_ref, '-'), 'request', 'no credit with this reference is waiting in suspense');
  END IF;
  IF EXISTS (SELECT 1 FROM admin.suspense_returns WHERE raast_ref = p_ref AND status = 'open') THEN
    RETURN admin.refuse(v_me, 'suspense_return', p_ref, 'request', 'a return of this credit is already waiting for a checker');
  END IF;
  INSERT INTO admin.suspense_returns (raast_ref, reason, requested_by) VALUES (p_ref, btrim(p_reason), v_me) RETURNING id INTO v_id;
  PERFORM admin.audit_append(v_me::text, 'operations.requested', jsonb_build_object('kind', 'suspense_return', 'ref', v_id, 'action', 'request', 'credit', p_ref));
  RETURN jsonb_build_object('ok', true, 'id', v_id, 'status', 'open');
END $$;

CREATE FUNCTION admin.decide_suspense_return(p_session bytea, p_id bigint, p_decision text, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'operations.decide');
  v_handle text := admin.handle_of(v_me);
  r admin.suspense_returns;
  v_journal bigint;
BEGIN
  PERFORM admin.require_step_up(p_session);
  PERFORM admin.check_decision(p_decision, p_reason);
  SELECT * INTO r FROM admin.suspense_returns WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR r.status <> 'open' THEN RETURN admin.refuse(v_me, 'suspense_return', p_id::text, p_decision, 'no open return request with this id'); END IF;
  IF r.requested_by = v_me THEN RETURN admin.refuse(v_me, 'suspense_return', p_id::text, p_decision, 'you asked for it: a different officer decides'); END IF;
  IF p_decision = 'approve' THEN
    BEGIN
      PERFORM admin.bind_officer(v_handle);
      v_journal := bank.return_credit(r.raast_ref, v_handle, r.reason);
      PERFORM admin.unbind_officer(v_handle);
    EXCEPTION WHEN SQLSTATE '23514' OR SQLSTATE '23505' OR SQLSTATE '42501' OR SQLSTATE '22023' OR SQLSTATE 'P0002' THEN
      RETURN admin.refuse(v_me, 'suspense_return', p_id::text, p_decision, SQLERRM);
    END;
  END IF;
  UPDATE admin.suspense_returns SET status = CASE p_decision WHEN 'approve' THEN 'approved' ELSE 'rejected' END,
         decided_by = v_me, decided_at = clock_timestamp(), decision_reason = btrim(p_reason), journal_id = v_journal
  WHERE id = p_id;
  PERFORM admin.audit_append(v_me::text, 'operations.decided', jsonb_build_object('kind', 'suspense_return', 'ref', p_id, 'action', p_decision,
    'credit', r.raast_ref, 'journal', v_journal));
  RETURN jsonb_build_object('ok', true, 'id', p_id, 'status', CASE p_decision WHEN 'approve' THEN 'returned' ELSE 'rejected' END);
END $$;

-- ================================================================== BD-2
/** Held lines of a submitted distribution batch that a follow-up could pay now (active payee, not in a live follow-up). */
CREATE FUNCTION admin.followup_candidates(p_parent bigint) RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
  SELECT coalesce(array_agg(i.subject_id ORDER BY i.line_no), '{}')
  FROM bank.payout_items i
  WHERE i.batch_id = p_parent AND i.held
    AND bank.active_payee(i.subject_id) IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM bank.payout_items fi JOIN bank.payout_batches fb ON fb.id = fi.batch_id
                    WHERE fb.parent_id = p_parent AND fb.status <> 'rejected' AND fi.subject_id = i.subject_id)
$$;

CREATE FUNCTION admin.create_followup_batch(p_session bytea, p_parent bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'operations.request');
  v_handle text := admin.handle_of(v_me);
  v_subjects uuid[];
  v_ref text;
  v_id bigint;
BEGIN
  PERFORM admin.require_step_up(p_session);
  v_subjects := admin.followup_candidates(p_parent);
  IF cardinality(v_subjects) = 0 THEN
    RETURN admin.refuse(v_me, 'followup_batch', coalesce(p_parent::text, '-'), 'create', 'no held line of this batch can be paid now');
  END IF;
  v_ref := format('PTPAY-FU-%s-%s', p_parent, (SELECT count(*) + 1 FROM bank.payout_batches WHERE parent_id = p_parent));
  BEGIN
    PERFORM admin.bind_officer(v_handle);
    v_id := bank.create_followup_batch(v_ref, p_parent, to_jsonb(v_subjects::text[]), v_handle);
    PERFORM admin.unbind_officer(v_handle);
  EXCEPTION WHEN SQLSTATE '23514' OR SQLSTATE '23505' OR SQLSTATE '42501' OR SQLSTATE '22023' OR SQLSTATE 'P0002' THEN
    RETURN admin.refuse(v_me, 'followup_batch', p_parent::text, 'create', SQLERRM);
  END;
  PERFORM admin.audit_append(v_me::text, 'operations.requested', jsonb_build_object('kind', 'followup_batch', 'ref', v_id, 'action', 'create',
    'parent', p_parent, 'lines', cardinality(v_subjects)));
  RETURN jsonb_build_object('ok', true, 'id', v_id, 'status', 'created');
END $$;

-- ================================================================== BD-3
CREATE FUNCTION admin.bank_desk(p_session bytea) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
BEGIN
  PERFORM admin.require(p_session, 'operations.read');
  RETURN jsonb_build_object(
    'suspense', coalesce((SELECT jsonb_agg(jsonb_build_object('ref', c.raast_ref, 'amount', c.amount_paisa::text, 'valueDate', c.value_date,
                   'payerLast4', c.payer_last4) ORDER BY c.value_date, c.raast_ref)
                 FROM bank.credits c WHERE c.status = 'suspense' AND NOT EXISTS (SELECT 1 FROM bank.credit_returns x WHERE x.raast_ref = c.raast_ref)), '[]'::jsonb),
    'returns', coalesce((SELECT jsonb_agg(jsonb_build_object('id', r.id, 'ref', r.raast_ref, 'reason', r.reason,
                   'requestedBy', admin.handle_of(r.requested_by), 'requestedAt', admin.utc(r.requested_at)) ORDER BY r.id)
                 FROM admin.suspense_returns r WHERE r.status = 'open'), '[]'::jsonb),
    'held', coalesce((SELECT jsonb_agg(jsonb_build_object('batch', b.id, 'reference', b.reference, 'token', b.token, 'distribution', b.distribution_id::text,
                   'heldLines', (SELECT count(*) FROM bank.payout_items i WHERE i.batch_id = b.id AND i.held),
                   'payableNow', cardinality(admin.followup_candidates(b.id))) ORDER BY b.id DESC)
                 FROM bank.payout_batches b
                 WHERE b.kind = 'distribution' AND b.status = 'submitted' AND EXISTS (SELECT 1 FROM bank.payout_items i WHERE i.batch_id = b.id AND i.held)), '[]'::jsonb));
END $$;

REVOKE ALL ON TABLE admin.suspense_returns FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.suspense_returns_guard(), admin.request_suspense_return(bytea, text, text), admin.decide_suspense_return(bytea, bigint, text, text),
  admin.followup_candidates(bigint), admin.create_followup_batch(bytea, bigint), admin.bank_desk(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.request_suspense_return(bytea, text, text), admin.decide_suspense_return(bytea, bigint, text, text),
  admin.create_followup_batch(bytea, bigint), admin.bank_desk(bytea) TO pt_admin_portal;

-- Platform roles (T-049, ADR 0011 amendment 3, ADR 0007 amendment 2): three portal roles for the
-- people who run the platform but take no money, token, compliance or tax decision.
-- Applies on top of 0030 (notification producers).
--
--   PR-1  platform_owner: the platform's senior owner ("super admin"). Reads the operational
--         pages (overview, approvals inbox, properties, offerings, operations, exit, transfers,
--         officers, audit trails of ops and admin) and may place an EMERGENCY PAYOUT HOLD. It
--         prepares, approves, votes and decides nothing; it never reads compliance or tax data.
--         It may be held together with admin (officer management) and support_agent only.
--   PR-2  Emergency payout hold: one platform owner with a fresh security-key step-up and a
--         reason of 10 to 500 characters freezes the payout gate at once (stopping money is the
--         safe direction, so one person may do it). The hold is an ordinary freeze event bound to
--         the newest reconciliation run (finished or still running), so lifting it is the
--         existing maker-checker unfreeze (ADR 0007 R-3): an operations maker asks, a different
--         operations checker decides, and only after a reconciliation run that STARTED after the
--         hold has passed. A hold while payouts are already frozen, or before any reconciliation
--         run exists (payouts are blocked then anyway), is refused. Every hold and refusal is in
--         the recon and admin audit chains; officers get the usual "payouts paused" alert.
--   PR-3  property_manager: the external property manager (a fee payee in ops.charges). Reads
--         properties and the operating statements only, and holds no other role.
--   PR-4  support_agent: front-line investor support. Looks up ONE investor by the reference the
--         investor reads to them (first 8 hex characters of the KYC subject id) and sees only:
--         masked CNIC, a support-safe KYC status, the account age, the wallet and the investor's
--         own recent notices. A compliance hold, a review or a rejection reason are never shown:
--         those all read "refer to compliance" (no tipping-off, AML Act 2010 s.34). Every lookup,
--         found or not, is audited. Holds no other role except platform_owner.
--   PR-5  The role matrix digest is fixed again, so admin.verify_audit() keeps detecting any later
--         edit of roles, conflicts or permissions.

-- ================================================================== roles, conflicts, permissions
INSERT INTO admin.roles (role, description) VALUES
  ('platform_owner', 'Platform owner: reads operations, places an emergency payout hold; decides nothing'),
  ('property_manager', 'External property manager: reads properties and operating statements'),
  ('support_agent', 'Investor support: looks up one investor by reference, no compliance details');

INSERT INTO admin.role_conflicts (a, b, reason) VALUES
  ('auditor', 'platform_owner', 'auditors are read-only and independent of everyone they audit'),
  ('compliance_officer', 'platform_owner', 'the platform owner never takes compliance decisions or reads compliance cases'),
  ('legal_officer', 'platform_owner', 'the legal reviewer is independent of every other duty in a case'),
  ('ops_checker', 'platform_owner', 'whoever places an emergency hold never approves its release'),
  ('ops_maker', 'platform_owner', 'whoever places an emergency hold never asks for its release'),
  ('platform_owner', 'tax_officer', 'the platform owner never takes tax decisions'),
  ('platform_owner', 'trustee_officer', 'trustee officers belong to the independent trustee and hold no platform role'),
  ('platform_owner', 'property_manager', 'the property manager is an external fee payee and holds no other role'),
  ('admin', 'property_manager', 'the property manager is an external fee payee and holds no other role'),
  ('auditor', 'property_manager', 'the property manager is an external fee payee and holds no other role'),
  ('compliance_officer', 'property_manager', 'the property manager is an external fee payee and holds no other role'),
  ('legal_officer', 'property_manager', 'the property manager is an external fee payee and holds no other role'),
  ('ops_checker', 'property_manager', 'the property manager is an external fee payee and holds no other role'),
  ('ops_maker', 'property_manager', 'the property manager is an external fee payee and holds no other role'),
  ('property_manager', 'support_agent', 'the property manager is an external fee payee and holds no other role'),
  ('property_manager', 'tax_officer', 'the property manager is an external fee payee and holds no other role'),
  ('property_manager', 'trustee_officer', 'the property manager is an external fee payee and holds no other role'),
  ('admin', 'support_agent', 'least privilege: officer management and investor lookups stay with different people'),
  ('auditor', 'support_agent', 'auditors are read-only and independent of everyone they audit'),
  ('compliance_officer', 'support_agent', 'no tipping-off: front-line support never holds compliance cases'),
  ('legal_officer', 'support_agent', 'the legal reviewer is independent of every other duty in a case'),
  ('ops_checker', 'support_agent', 'front-line support prepares and approves no money or token action'),
  ('ops_maker', 'support_agent', 'front-line support prepares and approves no money or token action'),
  ('support_agent', 'tax_officer', 'least privilege: investor lookups and tax filing (which unseals CNICs) stay with different people'),
  ('support_agent', 'trustee_officer', 'trustee officers belong to the independent trustee and hold no platform role');

INSERT INTO admin.role_permissions (role, permission) VALUES
  ('platform_owner', 'ops.read'), ('platform_owner', 'audit.read.ops'), ('platform_owner', 'audit.read.admin'),
  ('platform_owner', 'officers.read'), ('platform_owner', 'approvals.read'), ('platform_owner', 'property.read'),
  ('platform_owner', 'offering.read'), ('platform_owner', 'operations.read'), ('platform_owner', 'exit.read'),
  ('platform_owner', 'transfer.read'), ('platform_owner', 'support.read'), ('platform_owner', 'payouts.hold'),
  ('property_manager', 'property.read'), ('property_manager', 'operations.read'),
  ('support_agent', 'support.read');

DO $$
BEGIN
  EXECUTE format('CREATE OR REPLACE FUNCTION admin.expected_role_matrix_digest() RETURNS text LANGUAGE sql IMMUTABLE AS %L',
                 format('SELECT %L::text', admin.role_matrix_digest()));
END $$;

-- ================================================================== PR-2 emergency payout hold
/**
 * Freezes the payout gate at once on an operator's word. The freeze event points at the newest
 * reconciliation run, so recon.decide_unfreeze only lifts it after a later run has passed.
 */
CREATE FUNCTION recon.emergency_hold(p_operator text, p_reason text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, recon AS $$
DECLARE
  e recon.gate_events;
  v_run bigint;
  v_event bigint;
BEGIN
  IF p_operator IS NULL OR length(p_operator) NOT BETWEEN 2 AND 100 OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 10 AND 500 THEN
    RAISE EXCEPTION 'an operator and a reason of 10 to 500 characters are required' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(586586082);
  SELECT * INTO e FROM recon.gate_events ORDER BY id DESC LIMIT 1;
  IF FOUND AND e.action = 'freeze' THEN
    RAISE EXCEPTION 'payouts are already frozen (event %)', e.id USING ERRCODE = 'check_violation';
  END IF;
  SELECT max(id) INTO v_run FROM recon.runs;
  IF v_run IS NULL THEN
    RAISE EXCEPTION 'no reconciliation run exists yet, so payouts are already blocked' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO recon.gate_events (action, run_id, actor, reason)
  VALUES ('freeze', v_run, p_operator, left('emergency hold by ' || p_operator || ': ' || btrim(p_reason), 500))
  RETURNING id INTO v_event;
  PERFORM recon.audit_append(p_operator, 'gate.hold', jsonb_build_object('event', v_event, 'run', v_run, 'reason', btrim(p_reason)));
  RETURN v_event;
END $$;
REVOKE ALL ON FUNCTION recon.emergency_hold(text, text) FROM PUBLIC;

/** Platform owner: emergency payout hold (PR-2). Needs a fresh step-up; operations release it maker-checker. */
CREATE FUNCTION admin.emergency_payout_hold(p_session bytea, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'payouts.hold');
  v_handle text := admin.handle_of(v_me);
  v_event bigint;
BEGIN
  PERFORM admin.require_step_up(p_session);
  PERFORM admin.check_decision('approve', p_reason);
  BEGIN
    v_event := recon.emergency_hold(v_handle, btrim(p_reason));
  EXCEPTION WHEN SQLSTATE '23514' THEN
    RETURN admin.refuse(v_me, 'payout_hold', 'new', 'hold', SQLERRM);
  END;
  PERFORM admin.audit_append(v_me::text, 'payouts.held', jsonb_build_object('event', v_event));
  RETURN jsonb_build_object('ok', true, 'event', v_event);
END $$;

-- ================================================================== PR-4 support lookup
/**
 * One investor by the reference they read out (8 hex characters of the subject id). Support-safe
 * view only: no name, CNIC beyond the last four, hold, case or decision reason.
 */
CREATE FUNCTION admin.support_lookup(p_session bytea, p_ref text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'support.read');
  v_ref text := lower(btrim(coalesce(p_ref, '')));
  v_subjects uuid[];
  s kyc.subjects;
  v_status text;
BEGIN
  IF v_ref !~ '^[0-9a-f]{8}$' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'a reference is 8 characters, 0-9 and a-f');
  END IF;
  SELECT array_agg(x.id) INTO v_subjects FROM kyc.subjects x WHERE left(replace(x.id::text, '-', ''), 8) = v_ref;
  PERFORM admin.audit_append(v_me::text, 'support.lookup', jsonb_build_object('ref', v_ref, 'matches', coalesce(cardinality(v_subjects), 0)));
  IF coalesce(cardinality(v_subjects), 0) = 0 THEN
    RETURN jsonb_build_object('ok', true, 'found', false);
  END IF;
  IF cardinality(v_subjects) > 1 THEN
    RETURN jsonb_build_object('ok', true, 'found', false, 'ambiguous', true);
  END IF;
  SELECT * INTO s FROM kyc.subjects WHERE id = v_subjects[1];
  v_status := kyc.underlying_status(s.id);
  RETURN jsonb_build_object('ok', true, 'found', true, 'investor', jsonb_build_object(
    'ref', v_ref, 'cnic', admin.mask_cnic(s.cnic_last4),
    'status', CASE WHEN kyc.subject_status(s.id) = 'suspended' OR v_status NOT IN ('verified', 'expired', 'pending')
                   THEN 'refer_compliance' ELSE v_status END,
    'since', admin.utc(s.created_at),
    'wallet', (SELECT w.wallet FROM kyc.wallets w WHERE w.subject_id = s.id),
    'notices', coalesce((SELECT jsonb_agg(jsonb_build_object('kind', n.kind, 'category', n.category, 'status', n.status,
                                                             'at', admin.utc(n.created_at)) ORDER BY n.id DESC)
                         FROM (SELECT n.* FROM notify.notifications n JOIN notify.recipients r ON r.id = n.recipient_id
                               WHERE r.subject_type = 'investor' AND r.subject_id = s.id::text ORDER BY n.id DESC LIMIT 20) n), '[]'::jsonb)));
END $$;

-- ================================================================== privileges
REVOKE ALL ON FUNCTION admin.emergency_payout_hold(bytea, text), admin.support_lookup(bytea, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.emergency_payout_hold(bytea, text), admin.support_lookup(bytea, text) TO pt_admin_portal;

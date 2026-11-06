-- The compliance SLA reminder is idempotent again (fix to 0030 NP-7). Applies on top of 0066.
--
-- notify.sweep sent officer.alert 'sla_breach' with at = the time of the sweep, under a key that
-- names only the item, its state and when it entered that state. A second sweep in a later second
-- then used the same key with other parameters: the enqueue was refused (a producer failure, and
-- the CI test "no producer failed" failed now and then). The alert now says when the service level
-- was breached (state entered + the level), which is the same on every sweep. Nothing else changes.

/**
 * Reminders that no business change triggers, idempotent by key (safe to run as often as wanted):
 * reservation expiring within 2 hours (S-02 §10), payout account active after the cooling-off
 * (last 7 days), KYC verification expired (last 30 days), compliance items past their service level.
 */
CREATE OR REPLACE FUNCTION notify.sweep(p_actor text) RETURNS jsonb
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
  FOR r IN SELECT 'kyc-case' AS what, 'KC' AS prefix, k.id, k.status, k.updated_at AS since, k.updated_at + compliance.sla('kyc.' || k.status) AS due FROM compliance.kyc_cases k
             WHERE k.status IN ('open', 'info_requested', 'pending_second') AND k.updated_at + compliance.sla('kyc.' || k.status) < v_now
           UNION ALL
           SELECT 'hold-request', 'FR', f.id, f.status, f.requested_at, f.requested_at + compliance.sla('freeze.open') FROM compliance.freeze_requests f
             WHERE f.status = 'open' AND f.requested_at + compliance.sla('freeze.open') < v_now
           UNION ALL
           SELECT 'case', 'CC', c.id, c.status, c.updated_at, c.updated_at + compliance.sla('str.' || c.status) FROM compliance.str_cases c
             WHERE c.status IN ('open', 'under_review', 'close_proposed') AND c.updated_at + compliance.sla('str.' || c.status) < v_now
           ORDER BY 1, 3 LOOP
    PERFORM notify.to_officers(format('sla:%s:%s:%s:%s', r.what, r.id, r.status, floor(extract(epoch FROM r.since))::bigint), 'officer.alert',
      ARRAY['compliance_officer'],
      jsonb_build_object('topic', 'sla_breach', 'reference', notify.ref_code(r.prefix, r.id::text), 'at', notify.utc_param(r.due)), v_actor, NULL);
    n_sla := n_sla + 1;
  END LOOP;
  RETURN jsonb_build_object('reservationExpiring', n_expiring, 'payoutAccountActive', n_active, 'kycExpired', n_expired, 'slaBreaches', n_sla);
END $$;

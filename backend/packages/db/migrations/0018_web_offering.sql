-- Investor offering screens on the website (spec S-02 §16 "investor UI", task T-044): the website's
-- role (pt_web, migration 0012 W-5) gets exactly the S-02 investor functions it needs, through thin
-- wrappers, and nothing else of the offering, KYC or bank schemas.
--
-- Numbered 0018: 0017 is the notifications module; 0019 is reserved for another branch.
--
-- Safety properties enforced by the database itself (rule IDs WO-n):
--   WO-1  Least privilege: pt_web may EXECUTE the offering.web_* functions below and nothing else in
--         schema offering (no table, no view, no other function). The wrappers call the S-02
--         functions of migration 0015 (offering.accept_document, offering.reserve, offering.cancel),
--         so every business rule (FCFS units under the offering lock, waitlist, payment code and its
--         expiry, eligibility OF-13/OF-14, one open reservation OF-17, idempotency) stays there.
--   WO-2  KYC gate: offering.web_reserve refuses unless kyc.subject_status(subject) = 'verified' at
--         the moment of the call. The website's own check is only for the message; this one decides.
--         (The backend's KYC queue V1 stays available to the operator path, not to the website.)
--   WO-3  Actors: every website write is audited under an actor `web:<website investor id>`; the
--         website role cannot write under an officer's or the system's name.
--   WO-4  Reads are scoped: offering.web_subscriptions / web_subscription_events return the rows of
--         ONE KYC subject (the website passes the signed-in investor's subject). Internal reasons,
--         actors and request details are never returned. Tipping-off (S-02 V4, §16 note 9): the
--         states blocked and disputed read as `under_review`, in the rows and in the timeline.
--   WO-5  Public offering data (offering.web_offerings) is limited to offerings that have passed
--         approval (ready and later), with public terms, aggregate unit counts, the anchored document
--         hashes and coarse property facts (province, district, use, covered area). No plot,
--         khasra, deed, address, GPS, sponsor or investor data.
--   WO-6  Payment instructions come from the backend: the payment code, exact amount and expiry of
--         the reservation (bank.create_intent via offering.reserve) and the trustee escrow account
--         registered for reconciliation (recon.bank_accounts, ledger account bank:trustee-escrow).
--         Shown only while the reservation awaits payment. The website collects no bank details.

-- ------------------------------------------------------------------ helpers
/** WO-3: website actors are `web:<uuid>`. */
CREATE FUNCTION offering.web_check_actor(p text) RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
BEGIN
  IF p IS NULL OR p !~ '^web:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'website actions are recorded under web:<investor id>' USING ERRCODE = '42501';
  END IF;
END $$;

/** WO-4: what an investor may see of a subscription state. */
CREATE FUNCTION offering.web_state(p text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT CASE WHEN p IN ('blocked', 'disputed') THEN 'under_review' ELSE p END
$$;

-- ------------------------------------------------------------------ reads
/** WO-5: offerings an investor may see (one when p_offering is given), with public terms and figures. */
CREATE FUNCTION offering.web_offerings(p_offering uuid DEFAULT NULL)
RETURNS TABLE (
  offering_id uuid, state text, token text, price_paisa bigint, min_raise_units bigint, target_units bigint, hard_cap_units bigint,
  min_units bigint, max_units bigint, max_holding_units bigint, opens_at timestamptz, closes_at timestamptz, extended boolean,
  payment_grace_minutes integer, reservation_minutes integer, completion_days integer, completion_deadline timestamptz,
  early_close boolean, all_or_nothing boolean, categories text[], use_of_proceeds jsonb, doc_en_sha text, doc_ur_sha text,
  risk_sha text, paid_units bigint, held_units bigint, available_units bigint, waitlisted_units bigint, withdrawal_until timestamptz,
  funded_at timestamptz, completed_at timestamptz, failed_at timestamptz, province text, district text, property_use text,
  covered_area_sqft numeric
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, offering AS $$
  SELECT o.id, o.state, o.token, o.price_paisa, o.min_raise_units, o.target_units, o.hard_cap_units,
         o.min_units, o.max_units, o.max_holding_units, o.opens_at, offering.close_time(o), o.extended_close_at IS NOT NULL,
         o.payment_grace_minutes, o.reservation_minutes, o.completion_days, o.completion_deadline,
         o.early_close, o.min_raise_units = o.hard_cap_units, o.categories, o.use_of_proceeds,
         encode(o.doc_en_sha, 'hex'), encode(o.doc_ur_sha, 'hex'), encode(o.risk_sha, 'hex'),
         u.paid, u.held, greatest(o.hard_cap_units - u.held, 0), u.waitlisted, o.withdrawal_until,
         o.funded_at, o.completed_at, o.failed_at, p.province, p.district, p.use, p.covered_area_sqft
  FROM offering.offerings o
  JOIN property.properties p ON p.id = o.property_id
  CROSS JOIN LATERAL offering.units(o.id) u
  WHERE o.state IN ('ready', 'live', 'suspended', 'closing', 'funded', 'completing', 'completed', 'failed', 'refunding', 'cancelled')
    AND (p_offering IS NULL OR o.id = p_offering)
  ORDER BY CASE o.state WHEN 'live' THEN 0 WHEN 'ready' THEN 1 WHEN 'closing' THEN 2 WHEN 'suspended' THEN 3 ELSE 4 END,
           o.opens_at DESC NULLS LAST, o.id
$$;

/**
 * WO-4/WO-6: the subscriptions of one investor (KYC subject), newest first. The payment code and the
 * escrow account are returned only while the reservation awaits payment. refund_status:
 * requested | approved | sent | in_review (a refund request that was not approved stays with operations).
 */
CREATE FUNCTION offering.web_subscriptions(p_subject uuid)
RETURNS TABLE (
  subscription_id uuid, offering_id uuid, offering_state text, token text, state text, units bigint, amount_paisa bigint,
  payment_code text, pay_to_account text, expires_at timestamptz, reserved_at timestamptz, paid_at timestamptz,
  public_reason text, mint_tx text, refund_cause text, refund_status text, refund_sent_at timestamptz, created_at timestamptz,
  withdrawal_until timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, offering AS $$
  SELECT s.id, s.offering_id, o.state, o.token, offering.web_state(s.state), s.units, s.amount_paisa,
         CASE WHEN s.state = 'payment_pending' THEN s.intent_code END,
         CASE WHEN s.state = 'payment_pending' THEN (SELECT b.account FROM recon.bank_accounts b WHERE b.ledger_account = 'bank:trustee-escrow') END,
         s.expires_at, s.reserved_at, s.paid_at,
         CASE WHEN s.state IN ('blocked', 'disputed') THEN NULL ELSE s.public_reason END,
         s.mint_tx, f.cause,
         CASE WHEN f.subscription_id IS NULL THEN NULL
              WHEN f.journal_id IS NOT NULL THEN 'sent'
              WHEN q.status = 'open' THEN 'requested'
              WHEN q.status = 'approved' THEN 'approved'
              ELSE 'in_review' END,
         f.sent_at, s.created_at, o.withdrawal_until
  FROM offering.subscriptions s
  JOIN offering.offerings o ON o.id = s.offering_id
  LEFT JOIN offering.refunds f ON f.subscription_id = s.id
  LEFT JOIN offering.requests q ON q.id = f.request_id
  WHERE p_subject IS NOT NULL AND s.subject_id = p_subject
  ORDER BY s.created_at DESC, s.id
$$;

/** WO-4: the state history of one investor's subscriptions (code, state, time; no actor, no reason). */
CREATE FUNCTION offering.web_subscription_events(p_subject uuid)
RETURNS TABLE (subscription_id uuid, code text, to_state text, at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, offering AS $$
  SELECT e.subscription_id, e.code, offering.web_state(e.to_state), e.at
  FROM offering.subscription_events e
  JOIN offering.subscriptions s ON s.id = e.subscription_id
  WHERE p_subject IS NOT NULL AND s.subject_id = p_subject
  ORDER BY e.subscription_id, e.id
$$;

-- ------------------------------------------------------------------ writes (wrappers, WO-1..WO-3)
/** OF-10 through the website: the investor accepts the exact approved document version. */
CREATE FUNCTION offering.web_accept_document(p_offering uuid, p_subject uuid, p_kind text, p_language text, p_sha text, p_session text, p_device text, p_actor text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, offering AS $$
BEGIN
  PERFORM offering.web_check_actor(p_actor);
  RETURN offering.accept_document(p_offering, p_subject, p_kind, p_language, p_sha, p_session, p_device, p_actor);
END $$;

/** V2/V3 through the website: only a KYC-verified investor (WO-2); retail category (OF-13, sophisticated evidence is LEGAL TO CONFIRM). */
CREATE FUNCTION offering.web_reserve(p_offering uuid, p_sub uuid, p_ref_id text, p_subject uuid, p_units bigint, p_idempotency text, p_actor text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, offering AS $$
BEGIN
  PERFORM offering.web_check_actor(p_actor);
  IF p_subject IS NULL OR kyc.subject_status(p_subject) IS DISTINCT FROM 'verified' THEN
    RAISE EXCEPTION 'only a KYC-verified investor can reserve units' USING ERRCODE = '42501';
  END IF;
  RETURN offering.reserve(p_offering, p_sub, p_ref_id, p_subject, p_units, 'retail', p_idempotency, p_actor);
END $$;

/** V11 through the website: the investor cancels before paying (the backend checks ownership and state). */
CREATE FUNCTION offering.web_cancel(p_sub uuid, p_subject uuid, p_actor text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, offering AS $$
BEGIN
  PERFORM offering.web_check_actor(p_actor);
  RETURN offering.cancel(p_sub, p_subject, p_actor);
END $$;

-- ------------------------------------------------------------------ privileges (WO-1)
REVOKE ALL ON FUNCTION
  offering.web_check_actor(text),
  offering.web_state(text),
  offering.web_offerings(uuid),
  offering.web_subscriptions(uuid),
  offering.web_subscription_events(uuid),
  offering.web_accept_document(uuid, uuid, text, text, text, text, text, text),
  offering.web_reserve(uuid, uuid, text, uuid, bigint, text, text),
  offering.web_cancel(uuid, uuid, text)
FROM PUBLIC;

GRANT USAGE ON SCHEMA offering TO pt_web;
GRANT EXECUTE ON FUNCTION
  offering.web_offerings(uuid),
  offering.web_subscriptions(uuid),
  offering.web_subscription_events(uuid),
  offering.web_accept_document(uuid, uuid, text, text, text, text, text, text),
  offering.web_reserve(uuid, uuid, text, uuid, bigint, text, text),
  offering.web_cancel(uuid, uuid, text)
TO pt_web;

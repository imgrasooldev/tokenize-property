-- Offering lifecycle (spec S-02, task T-020): terms, approvals, reservations with payment codes,
-- FCFS allocation with a waitlist, payment matching, closing outcomes, extension with withdrawal,
-- refunds to the sender, issuance batch, mint at completion only, settlement from the read model.
--
-- Safety properties enforced by the database itself (rule IDs OFR-n; S-02 rule IDs in brackets):
--   OFR-1  States live in append-only event tables. A transition is accepted only if it is listed in
--          offering.transitions (S-02 §4.1 L1..L18 and §4.2 V1..V22) and starts from the current
--          state; a trigger re-checks this on every insert, and the state column follows the event
--          log only. Terms are immutable once submitted [OF-7].
--   OFR-2  Maker-checker [S-02 §4 tables]: L3, L7, L8, L10, L11, L12, L13, L14, L15, L16, the
--          issuance batch, the completion record, a supplementary disclosure, a mint retry (V17) and
--          every refund (V20) are requests approved by DIFFERENT officers holding the required duties
--          (offering.request_rules); the requester never approves; one rejection is final; requests
--          expire (72 h) or go stale when the offering's state changes. OF-SOD-1: a party to the
--          property's S-01 file cannot approve its offering terms.
--   OFR-3  FCFS [OF-19]: under a lock on the offering row, reserved + paid units never exceed the
--          hard cap; nobody can pay for units they have not reserved (a payment code exists only for
--          a reservation, expires with it, and is cancelled with it), so the platform never collects
--          more than the hard cap. Freed units go to the oldest waitlisted investor first.
--   OFR-4  Payment [OF-15..OF-18]: the bank service books `sub:<refId>:paid` on an exact match
--          (ADR 0009 B-2); a trigger on bank.credits moves the subscription to Payment Confirmed in the
--          SAME transaction. Late, wrong-amount, cancelled-code or unregistered-payer credits go to
--          suspense and never become subscriptions.
--   OFR-5  Mint only at completion [S-02 §2, I-11]: `issuance.mint` commands are enqueued through the
--          outbox only by offering.start_minting, for an offering in Completing with an approved
--          completion record and an approved issuance batch, only for subscriptions whose
--          `sub:<refId>:paid` journal exists and has no refund, in the same transaction that records
--          the mint command; the outbox key `mint:<refId>` makes a retry exactly-once. The signing
--          service can ask offering.mint_allowed() before signing (ADR 0005 amendment).
--   OFR-6  Refunds [OF-50, OF-51]: a refund returns the whole matched credit to its sender under its
--          own Raast reference (bank.refund_credit), needs two bank operators (maker-checker), the
--          reconciliation gate, and is impossible while a mint for the refId exists or could still be
--          mined; `sub:<refId>:refunded` is posted in the same transaction as the state change.
--   OFR-7  Settlement [V14]: `sub:<refId>:settled` (investor liability -> property capital) is
--          posted only against a `Minted` event in the read model whose wallet AND amount match, in
--          the same transaction as the state change.
--   OFR-8  Append-only records, hash-chained audit with UTC timestamps (F-04); offering.verify_audit()
--          re-checks the chain, replays every state and finds rows written around the API.
--   OFR-9  Roles: pt_offering_service (investor actions and system jobs), pt_offering_officer
--          (officer actions and decisions), pt_offering_admin (duties), pt_offering_reader (views).
--          No role writes a table directly. pt_signer may call offering.mint_allowed only.
--
-- Bank amendment (ADR 0009, additive): bank.intent_cancellations + bank.cancel_intent (a cancelled
-- payment code can no longer be matched: book_credit sends the credit to suspense), and
-- bank.credit_refunds + bank.refund_credit (return of a MATCHED subscription credit, OF-50).
-- LEGAL TO CONFIRM values live in offering.settings. Amounts in paisa (bigint), units bigint.

CREATE SCHEMA IF NOT EXISTS offering;
REVOKE ALL ON SCHEMA offering FROM PUBLIC;

DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['pt_offering_service', 'pt_offering_officer', 'pt_offering_admin', 'pt_offering_reader'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN', r);
    END IF;
  END LOOP;
END $$;

-- ================================================================== helpers
CREATE FUNCTION offering.forbid_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'offering records are append-only: % on %.% is not allowed', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE FUNCTION offering.utc(p timestamptz) RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT to_char(p AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
$$;

/** Raises with an SQLSTATE the service maps (22023 input, 42501 duty/SoD, 23514 guard, 23505 duplicate, P0002 unknown). */
CREATE FUNCTION offering.fail(p_code text, p_message text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '%', p_message USING ERRCODE = p_code;
END $$;

CREATE FUNCTION offering.check_actor(p text) RETURNS void
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF p IS NULL OR p !~ '^[A-Za-z0-9][A-Za-z0-9@._:+-]{1,99}$' THEN
    PERFORM offering.fail('22023', 'an actor id of 2-100 characters (letters, digits, @._:+-) is required');
  END IF;
END $$;

CREATE FUNCTION offering.check_reason(p text, p_what text DEFAULT 'reason') RETURNS void
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF p IS NULL OR length(btrim(p)) NOT BETWEEN 10 AND 500 THEN
    PERFORM offering.fail('22023', format('a %s of 10-500 characters is required', p_what));
  END IF;
END $$;

CREATE FUNCTION offering.sha_of(p text, p_what text) RETURNS bytea
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF p IS NULL OR p !~ '^[0-9a-f]{64}$' THEN
    PERFORM offering.fail('22023', format('%s must be a SHA-256 as 64 lower-case hex characters', p_what));
  END IF;
  RETURN decode(p, 'hex');
END $$;

-- ------------------------------------------------------------------ settings (LEGAL TO CONFIRM values)
-- Values change only through a new migration (no role can write this table).
CREATE TABLE offering.settings (
  key              text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]{2,40}$'),
  value            numeric NOT NULL CHECK (value >= 0),
  legal_to_confirm boolean NOT NULL,
  note             text NOT NULL
);
INSERT INTO offering.settings (key, value, legal_to_confirm, note) VALUES
  ('reservation_ttl_minutes', 1440, false, 'OF-16: default reservation lifetime (24 h); an offering may set 60-4320 minutes (1-72 h)'),
  ('payment_grace_minutes', 120, false, 'OF-16: payment grace after the close time (2 h), so a Raast payment made just before close can arrive'),
  ('completion_days', 60, true, 'OF-42: completion deadline after Funded'),
  ('extension_max_days', 30, true, 'OF-20: at most one extension of at most 30 days'),
  ('extension_decision_hours', 48, true, 'OF-20: the offering waits in Closing for an extension decision for at most 2 business days (48 h used)'),
  ('withdrawal_days', 7, true, 'OF-22/OF-23: withdrawal right after an extension or supplementary disclosure (5 business days; 7 calendar days used)'),
  ('min_units_default', 10, false, 'OF-4: minimum investment per subscription in units'),
  ('min_offer_days', 7, true, 'OF-5: minimum period between open and close'),
  ('kyc_margin_days', 30, false, 'OF-13: KYC validity must extend this far past the scheduled completion deadline'),
  ('all_or_nothing', 1, true, 'Q-1 (adopted for the pilot): min raise = target = hard cap'),
  ('refund_sla_hours', 48, true, 'OF-53: refunds of a failed offering complete within 2 business days (48 h used)'),
  ('request_expiry_hours', 72, false, 'maker-checker requests expire (as ADR 0009 Y-4)'),
  ('allowed_country', 586, true, 'OF-13: Pakistan only until legal approves more countries'),
  ('min_reservation_minutes', 5, false, 'a reservation shorter than this (just before close) is not offered; the payment code minimum is 5 minutes');

CREATE FUNCTION offering.setting(p_key text) RETURNS numeric
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, offering AS $$
DECLARE
  v numeric;
BEGIN
  SELECT value INTO v FROM offering.settings WHERE key = p_key;
  IF NOT FOUND THEN PERFORM offering.fail('P0002', format('setting %s is missing', p_key)); END IF;
  RETURN v;
END $$;

-- ================================================================== audit (OFR-8)
CREATE TABLE offering.audit (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at        timestamptz NOT NULL,
  actor     text NOT NULL CHECK (length(actor) BETWEEN 1 AND 100),
  action    text NOT NULL CHECK (action ~ '^[a-z][a-z_.]{2,63}$'),
  detail    jsonb NOT NULL CHECK (jsonb_typeof(detail) = 'object' AND octet_length(detail::text) <= 8192),
  prev_hash bytea NOT NULL CHECK (length(prev_hash) = 32),
  hash      bytea NOT NULL UNIQUE CHECK (length(hash) = 32)
);

CREATE FUNCTION offering.audit_digest(p_prev bytea, p_id bigint, p_at timestamptz, p_actor text, p_action text, p_detail jsonb)
RETURNS bytea LANGUAGE sql STABLE SET search_path = pg_catalog, offering AS $$
  SELECT sha256(p_prev || convert_to('pt-offering-audit-v1' || jsonb_build_array(p_id, offering.utc(p_at), p_actor, p_action, p_detail)::text, 'UTF8'))
$$;

CREATE FUNCTION offering.audit_append(p_actor text, p_action text, p_detail jsonb)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, offering AS $$
DECLARE
  v_prev bytea;
  v_id bigint;
  v_at timestamptz := date_trunc('microseconds', clock_timestamp());
  v_detail jsonb := coalesce(p_detail, '{}'::jsonb);
BEGIN
  -- Lock order everywhere: payment code (586586098) -> ledger (586586002) -> bank audit
  -- (586586095) -> offering audit (586586150). bank.book_credit takes the first three and then, via
  -- the trigger on bank.credits, this one; taking the bank audit lock here first keeps an offering
  -- transaction that later writes bank audit entries from deadlocking with a payment. Rows are
  -- locked FOR NO KEY UPDATE (never FOR UPDATE), so foreign-key checks of a concurrent payment
  -- (KEY SHARE on the offering or subscription row) never wait for an offering transaction.
  PERFORM pg_advisory_xact_lock(586586095);
  PERFORM pg_advisory_xact_lock(586586150);
  SELECT hash INTO v_prev FROM offering.audit ORDER BY id DESC LIMIT 1;
  v_prev := coalesce(v_prev, decode(repeat('00', 32), 'hex'));
  v_id := nextval(pg_get_serial_sequence('offering.audit', 'id'));
  INSERT INTO offering.audit (id, at, actor, action, detail, prev_hash, hash)
  OVERRIDING SYSTEM VALUE
  VALUES (v_id, v_at, p_actor, p_action, v_detail, v_prev, offering.audit_digest(v_prev, v_id, v_at, p_actor, p_action, v_detail));
  RETURN v_id;
END $$;

-- ================================================================== duties (S-02 §3)
CREATE TABLE offering.duties (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor         text NOT NULL CHECK (actor ~ '^[A-Za-z0-9][A-Za-z0-9@._:+-]{1,99}$'),
  -- offering: offering maker or checker (operations); compliance; legal_head; trustee (trustee
  -- officer); bank_operator (refund maker-checker, OF-SOD-3).
  duty          text NOT NULL CHECK (duty IN ('offering', 'compliance', 'legal_head', 'trustee', 'bank_operator')),
  requested_by  text NOT NULL CHECK (length(requested_by) BETWEEN 2 AND 100),
  reason        text NOT NULL CHECK (length(reason) BETWEEN 10 AND 500),
  requested_at  timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'rejected', 'revoked')),
  decided_by    text CHECK (length(decided_by) BETWEEN 2 AND 100),
  decided_at    timestamptz,
  revoked_by    text CHECK (length(revoked_by) BETWEEN 2 AND 100),
  revoke_reason text CHECK (length(revoke_reason) BETWEEN 10 AND 500),
  revoked_at    timestamptz,
  CHECK (requested_by <> actor),
  CHECK (decided_by IS DISTINCT FROM requested_by AND decided_by IS DISTINCT FROM actor),
  CHECK ((status = 'pending') = (decided_by IS NULL)),
  CHECK ((status = 'revoked') = (revoked_by IS NOT NULL AND revoke_reason IS NOT NULL AND revoked_at IS NOT NULL))
);
CREATE UNIQUE INDEX duties_live ON offering.duties (actor, duty) WHERE status IN ('pending', 'active');

CREATE FUNCTION offering.guard_duty() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'duties are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (NEW.id, NEW.actor, NEW.duty, NEW.requested_by, NEW.reason, NEW.requested_at)
     IS DISTINCT FROM (OLD.id, OLD.actor, OLD.duty, OLD.requested_by, OLD.reason, OLD.requested_at)
     OR NOT ((OLD.status = 'pending' AND NEW.status IN ('active', 'rejected') AND NEW.revoked_by IS NULL)
             OR (OLD.status = 'active' AND NEW.status = 'revoked' AND (NEW.decided_by, NEW.decided_at) IS NOT DISTINCT FROM (OLD.decided_by, OLD.decided_at))) THEN
    RAISE EXCEPTION 'duty % can only be decided once and revoked once', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER duties_guard BEFORE UPDATE OR DELETE ON offering.duties FOR EACH ROW EXECUTE FUNCTION offering.guard_duty();

/** OF-SOD-4: a trustee officer holds no platform duty. */
CREATE FUNCTION offering.guard_duty_conflict() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM offering.duties d
             WHERE d.actor = NEW.actor AND d.status IN ('pending', 'active') AND d.id <> NEW.id
               AND (d.duty = 'trustee') <> (NEW.duty = 'trustee')) THEN
    RAISE EXCEPTION 'duty % conflicts with a duty % already holds (trustee officers hold no platform duty)', NEW.duty, NEW.actor
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER duties_conflict BEFORE INSERT ON offering.duties FOR EACH ROW EXECUTE FUNCTION offering.guard_duty_conflict();

CREATE FUNCTION offering.has_duty(p_actor text, p_duty text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, offering AS $$
  SELECT EXISTS (SELECT 1 FROM offering.duties WHERE actor = p_actor AND status = 'active' AND duty = p_duty)
$$;

CREATE FUNCTION offering.need_duty(p_actor text, p_duties text[], p_what text) RETURNS void
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, offering AS $$
BEGIN
  PERFORM offering.check_actor(p_actor);
  IF NOT EXISTS (SELECT 1 FROM offering.duties WHERE actor = p_actor AND status = 'active' AND duty = ANY (p_duties)) THEN
    PERFORM offering.fail('42501', format('%s needs an active %s duty to %s', p_actor, array_to_string(p_duties, ' or '), p_what));
  END IF;
END $$;

CREATE FUNCTION offering.request_duty(p_actor text, p_duty text, p_by text, p_reason text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, offering AS $$
DECLARE
  v_id bigint;
BEGIN
  PERFORM offering.check_actor(p_actor);
  PERFORM offering.check_actor(p_by);
  PERFORM offering.check_reason(p_reason);
  IF p_by = p_actor THEN PERFORM offering.fail('42501', 'nobody can request a duty for themselves'); END IF;
  IF p_duty IS NULL OR p_duty NOT IN ('offering', 'compliance', 'legal_head', 'trustee', 'bank_operator') THEN
    PERFORM offering.fail('22023', 'unknown duty');
  END IF;
  IF EXISTS (SELECT 1 FROM offering.duties WHERE actor = p_actor AND duty = p_duty AND status IN ('pending', 'active')) THEN
    PERFORM offering.fail('23505', format('%s already holds or awaits the %s duty', p_actor, p_duty));
  END IF;
  INSERT INTO offering.duties (actor, duty, requested_by, reason) VALUES (p_actor, p_duty, p_by, p_reason) RETURNING id INTO v_id;
  PERFORM offering.audit_append(p_by, 'duty.requested', jsonb_build_object('duty', v_id, 'actor', p_actor, 'name', p_duty));
  RETURN v_id;
END $$;

CREATE FUNCTION offering.decide_duty(p_id bigint, p_by text, p_approve boolean, p_reason text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, offering AS $$
DECLARE
  d offering.duties;
BEGIN
  PERFORM offering.check_actor(p_by);
  PERFORM offering.check_reason(p_reason);
  SELECT * INTO d FROM offering.duties WHERE id = p_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN PERFORM offering.fail('P0002', 'unknown duty request'); END IF;
  IF d.status <> 'pending' THEN PERFORM offering.fail('23514', format('duty request %s is already %s', p_id, d.status)); END IF;
  IF p_by IN (d.requested_by, d.actor) THEN PERFORM offering.fail('42501', 'a duty is approved by a second administrator (maker-checker)'); END IF;
  UPDATE offering.duties SET status = CASE WHEN p_approve THEN 'active' ELSE 'rejected' END, decided_by = p_by,
         decided_at = date_trunc('microseconds', clock_timestamp()) WHERE id = p_id;
  PERFORM offering.audit_append(p_by, CASE WHEN p_approve THEN 'duty.approved' ELSE 'duty.rejected' END,
                                jsonb_build_object('duty', p_id, 'reason', p_reason));
  RETURN CASE WHEN p_approve THEN 'active' ELSE 'rejected' END;
END $$;

CREATE FUNCTION offering.revoke_duty(p_id bigint, p_by text, p_reason text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, offering AS $$
DECLARE
  d offering.duties;
BEGIN
  PERFORM offering.check_actor(p_by);
  PERFORM offering.check_reason(p_reason);
  SELECT * INTO d FROM offering.duties WHERE id = p_id FOR NO KEY UPDATE;
  IF NOT FOUND OR d.status <> 'active' THEN PERFORM offering.fail('23514', 'only an active duty can be revoked'); END IF;
  IF p_by = d.actor THEN PERFORM offering.fail('42501', 'nobody revokes their own duty'); END IF;
  UPDATE offering.duties SET status = 'revoked', revoked_by = p_by, revoke_reason = p_reason,
         revoked_at = date_trunc('microseconds', clock_timestamp()) WHERE id = p_id;
  PERFORM offering.audit_append(p_by, 'duty.revoked', jsonb_build_object('duty', p_id, 'reason', p_reason));
  RETURN true;
END $$;

-- ================================================================== state machines (OFR-1)
CREATE TABLE offering.transitions (
  entity     text NOT NULL CHECK (entity IN ('offering', 'subscription')),
  code       text NOT NULL CHECK (code ~ '^[LV][0-9]{1,2}$'),
  from_state text NOT NULL,
  to_state   text NOT NULL,
  action     text NOT NULL,
  PRIMARY KEY (entity, code, from_state)
);
INSERT INTO offering.transitions (entity, code, from_state, to_state, action) VALUES
  ('offering', 'L1', 'draft', 'pending_approval', 'offering.submitted'),
  ('offering', 'L2', 'pending_approval', 'draft', 'offering.returned'),
  ('offering', 'L3', 'pending_approval', 'approved', 'offering.approved'),
  ('offering', 'L4', 'approved', 'ready', 'offering.ready'),
  ('offering', 'L5', 'ready', 'live', 'offering.opened'),
  ('offering', 'L6', 'live', 'suspended', 'offering.suspended'),
  ('offering', 'L7', 'suspended', 'live', 'offering.resumed'),
  ('offering', 'L8', 'suspended', 'failed', 'offering.cancelled'),
  ('offering', 'L9', 'live', 'closing', 'offering.closing'),
  ('offering', 'L10', 'closing', 'live', 'offering.extended'),
  ('offering', 'L11', 'closing', 'funded', 'offering.funded'),
  ('offering', 'L12', 'closing', 'failed', 'offering.failed'),
  ('offering', 'L13', 'funded', 'completing', 'offering.completing'),
  ('offering', 'L14', 'completing', 'completed', 'offering.completed'),
  ('offering', 'L15', 'funded', 'failed', 'offering.failed'),
  ('offering', 'L16', 'completing', 'failed', 'offering.failed'),
  ('offering', 'L17', 'failed', 'refunding', 'offering.refunding'),
  ('offering', 'L18', 'refunding', 'cancelled', 'offering.cancelled'),
  ('subscription', 'V1', 'initiated', 'kyc_pending', 'subscription.kyc_pending'),
  ('subscription', 'V2', 'initiated', 'payment_pending', 'subscription.reserved'),
  ('subscription', 'V3', 'initiated', 'waitlisted', 'subscription.waitlisted'),
  ('subscription', 'V3', 'kyc_pending', 'waitlisted', 'subscription.waitlisted'),
  ('subscription', 'V4', 'initiated', 'rejected', 'subscription.rejected'),
  -- Deviation (S-02 §15 notes): a waitlisted investor who is no longer eligible when units free up
  -- is rejected rather than blocking the queue.
  ('subscription', 'V4', 'waitlisted', 'rejected', 'subscription.rejected'),
  ('subscription', 'V5', 'kyc_pending', 'payment_pending', 'subscription.reserved'),
  ('subscription', 'V6', 'kyc_pending', 'rejected', 'subscription.rejected'),
  ('subscription', 'V7', 'waitlisted', 'payment_pending', 'subscription.reserved'),
  ('subscription', 'V8', 'waitlisted', 'expired', 'subscription.expired'),
  ('subscription', 'V8', 'kyc_pending', 'expired', 'subscription.expired'),
  ('subscription', 'V9', 'payment_pending', 'payment_confirmed', 'subscription.paid'),
  ('subscription', 'V10', 'payment_pending', 'expired', 'subscription.expired'),
  ('subscription', 'V11', 'payment_pending', 'cancelled', 'subscription.cancelled'),
  -- Deviation: an investor may also leave the KYC queue or the waitlist (nothing was paid).
  ('subscription', 'V11', 'kyc_pending', 'cancelled', 'subscription.cancelled'),
  ('subscription', 'V11', 'waitlisted', 'cancelled', 'subscription.cancelled'),
  ('subscription', 'V12', 'payment_confirmed', 'allocation_pending', 'subscription.allocated'),
  ('subscription', 'V13', 'payment_confirmed', 'refund_pending', 'subscription.refund_pending'),
  ('subscription', 'V14', 'allocation_pending', 'tokens_issued', 'subscription.minted'),
  ('subscription', 'V15', 'allocation_pending', 'refund_pending', 'subscription.refund_pending'),
  ('subscription', 'V16', 'allocation_pending', 'issuance_review', 'subscription.issuance_review'),
  ('subscription', 'V17', 'issuance_review', 'tokens_issued', 'subscription.minted'),
  ('subscription', 'V18', 'tokens_issued', 'active', 'subscription.active'),
  ('subscription', 'V19', 'active', 'redeemed', 'subscription.redeemed'),
  ('subscription', 'V20', 'refund_pending', 'refunded', 'subscription.refunded'),
  ('subscription', 'V21', 'payment_confirmed', 'blocked', 'subscription.blocked'),
  ('subscription', 'V21', 'allocation_pending', 'blocked', 'subscription.blocked'),
  ('subscription', 'V22', 'active', 'disputed', 'subscription.disputed'),
  ('subscription', 'V22', 'payment_confirmed', 'disputed', 'subscription.disputed');

-- ================================================================== offerings
CREATE TABLE offering.offerings (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id           uuid NOT NULL REFERENCES property.properties (id),
  -- A new offering of the same property after a cancelled one (fresh terms, new approvals).
  previous_id           uuid UNIQUE REFERENCES offering.offerings (id),
  state                 text NOT NULL DEFAULT 'draft'
                        CHECK (state IN ('draft', 'pending_approval', 'approved', 'ready', 'live', 'suspended', 'closing', 'funded',
                                         'completing', 'completed', 'failed', 'refunding', 'cancelled')),
  -- Terms (OF-1..OF-6): immutable once submitted (OF-7). Whole units; price in paisa.
  price_paisa           bigint CHECK (price_paisa BETWEEN 1 AND 1000000000000),
  min_raise_units       bigint CHECK (min_raise_units BETWEEN 1 AND 1000000000000),
  target_units          bigint CHECK (target_units BETWEEN 1 AND 1000000000000),
  hard_cap_units        bigint CHECK (hard_cap_units BETWEEN 1 AND 1000000000000),
  min_units             bigint CHECK (min_units BETWEEN 1 AND 1000000000000),
  max_units             bigint CHECK (max_units BETWEEN 1 AND 1000000000000),
  opens_at              timestamptz,
  closes_at             timestamptz,
  payment_grace_minutes integer CHECK (payment_grace_minutes BETWEEN 0 AND 1440),
  reservation_minutes   integer CHECK (reservation_minutes BETWEEN 60 AND 4320),
  completion_days       integer CHECK (completion_days BETWEEN 1 AND 365),
  early_close           boolean NOT NULL DEFAULT false,
  categories            text[] NOT NULL DEFAULT ARRAY['retail'] CHECK (cardinality(categories) BETWEEN 1 AND 2 AND categories <@ ARRAY['retail', 'sophisticated']),
  -- OF-3: [{"line": "...", "paisa": "..."}], sums exactly to hard cap x price.
  use_of_proceeds       jsonb CHECK (use_of_proceeds IS NULL OR (jsonb_typeof(use_of_proceeds) = 'array' AND octet_length(use_of_proceeds::text) <= 4096)),
  -- OF-10/OF-12: offering document (English, Urdu) and risk disclosure, as SHA-256.
  doc_en_sha            bytea CHECK (length(doc_en_sha) = 32),
  doc_ur_sha            bytea CHECK (length(doc_ur_sha) = 32),
  risk_sha              bytea CHECK (length(risk_sha) = 32),
  -- From the S-01 structure at submission (OB-36): planned register and the MaxBalance limit.
  structure_id          bigint REFERENCES property.structures (id),
  register_units        bigint,
  max_holding_units     bigint,
  -- Lifecycle facts (set once).
  token                 text CHECK (length(token) = 42 AND token ~ '^0x[0-9a-f]+$'),
  extended_close_at     timestamptz,
  withdrawal_until      timestamptz,
  funded_at             timestamptz,
  completion_deadline   timestamptz,
  completing_at         timestamptz,
  mint_started_at       timestamptz,
  completed_at          timestamptz,
  failed_at             timestamptz,
  created_by            text NOT NULL CHECK (length(created_by) BETWEEN 2 AND 100),
  created_at            timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  CHECK (extended_close_at IS NULL OR extended_close_at > closes_at)
);
-- One offering per property at a time; a cancelled one may be followed by a new one.
CREATE UNIQUE INDEX offerings_one_per_property ON offering.offerings (property_id) WHERE state <> 'cancelled';
CREATE UNIQUE INDEX offerings_token ON offering.offerings (token) WHERE state <> 'cancelled';

CREATE FUNCTION offering.term_columns() RETURNS text[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['price_paisa', 'min_raise_units', 'target_units', 'hard_cap_units', 'min_units', 'max_units', 'opens_at', 'closes_at',
               'payment_grace_minutes', 'reservation_minutes', 'completion_days', 'early_close', 'categories', 'use_of_proceeds',
               'doc_en_sha', 'doc_ur_sha', 'risk_sha']
$$;

CREATE TABLE offering.offering_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  offering_id uuid NOT NULL REFERENCES offering.offerings (id),
  code        text NOT NULL,
  from_state  text NOT NULL,
  to_state    text NOT NULL,
  actor       text NOT NULL CHECK (length(actor) BETWEEN 2 AND 100),
  reason      text CHECK (length(reason) BETWEEN 2 AND 500),
  request_id  bigint,
  at          timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp())
);
CREATE INDEX offering_events_idx ON offering.offering_events (offering_id, id DESC);

-- ================================================================== subscriptions
CREATE TABLE offering.subscriptions (
  id              uuid PRIMARY KEY,
  offering_id     uuid NOT NULL REFERENCES offering.offerings (id),
  subject_id      uuid NOT NULL REFERENCES kyc.subjects (id),
  -- keccak256("property-token:subscription:<id>"), computed by the service (no keccak in SQL);
  -- reconciliation re-derives and compares it (offering.ref_id_mismatch).
  ref_id          text NOT NULL UNIQUE CHECK (length(ref_id) = 66 AND ref_id ~ '^0x[0-9a-f]+$'),
  units           bigint NOT NULL CHECK (units BETWEEN 1 AND 1000000000000),
  amount_paisa    bigint NOT NULL CHECK (amount_paisa > 0 AND amount_paisa <= 1000000000000000),
  category        text NOT NULL CHECK (category IN ('retail', 'sophisticated')),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9:._-]{7,99}$'),
  state           text NOT NULL DEFAULT 'initiated'
                  CHECK (state IN ('initiated', 'kyc_pending', 'payment_pending', 'payment_confirmed', 'allocation_pending', 'tokens_issued',
                                   'active', 'redeemed', 'waitlisted', 'rejected', 'expired', 'cancelled', 'refund_pending', 'refunded',
                                   'issuance_review', 'blocked', 'disputed')),
  -- Set when units are reserved (V2/V5/V7).
  wallet          text CHECK (length(wallet) = 42 AND wallet ~ '^0x[0-9a-f]+$'),
  intent_code     text UNIQUE REFERENCES bank.payment_intents (code),
  reserved_at     timestamptz,
  expires_at      timestamptz,
  -- Set by the payment (V9).
  raast_ref       text UNIQUE REFERENCES bank.credits (raast_ref),
  paid_journal    bigint UNIQUE REFERENCES ledger.journal (id),
  paid_at         timestamptz,
  -- Set by settlement (V14/V17) and by the refund (V20).
  settled_journal bigint UNIQUE REFERENCES ledger.journal (id),
  mint_tx         text CHECK (length(mint_tx) = 66 AND mint_tx ~ '^0x[0-9a-f]+$'),
  refund_journal  bigint UNIQUE REFERENCES ledger.journal (id),
  -- Internal reason (compliance can see); the investor sees public_reason only (no tipping-off, V4).
  reason          text CHECK (length(reason) BETWEEN 2 AND 300),
  public_reason   text CHECK (length(public_reason) BETWEEN 2 AND 300),
  created_by      text NOT NULL CHECK (length(created_by) BETWEEN 2 AND 100),
  created_at      timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  UNIQUE (offering_id, subject_id, idempotency_key),
  CHECK ((intent_code IS NULL) = (reserved_at IS NULL) AND (reserved_at IS NULL) = (expires_at IS NULL)),
  CHECK ((raast_ref IS NULL) = (paid_journal IS NULL) AND (paid_journal IS NULL) = (paid_at IS NULL)),
  CHECK (settled_journal IS NULL OR refund_journal IS NULL)
);
-- OF-17: one open reservation (or queue place) per investor per offering.
CREATE UNIQUE INDEX subscriptions_one_open ON offering.subscriptions (offering_id, subject_id)
  WHERE state IN ('initiated', 'kyc_pending', 'waitlisted', 'payment_pending');
CREATE INDEX subscriptions_offering_idx ON offering.subscriptions (offering_id, state);
CREATE INDEX subscriptions_subject_idx ON offering.subscriptions (subject_id);

CREATE TABLE offering.subscription_events (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subscription_id uuid NOT NULL REFERENCES offering.subscriptions (id),
  code            text NOT NULL,
  from_state      text NOT NULL,
  to_state        text NOT NULL,
  actor           text NOT NULL CHECK (length(actor) BETWEEN 2 AND 100),
  reason          text CHECK (length(reason) BETWEEN 2 AND 500),
  request_id      bigint,
  at              timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp())
);
CREATE INDEX subscription_events_idx ON offering.subscription_events (subscription_id, id DESC);

/** OFR-1: an event must be an allowed transition from the current state. */
CREATE FUNCTION offering.apply_event() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_current text;
BEGIN
  IF TG_TABLE_NAME = 'offering_events' THEN
    SELECT state INTO v_current FROM offering.offerings WHERE id = NEW.offering_id FOR NO KEY UPDATE;
  ELSE
    SELECT state INTO v_current FROM offering.subscriptions WHERE id = NEW.subscription_id FOR NO KEY UPDATE;
  END IF;
  IF v_current IS DISTINCT FROM NEW.from_state OR NOT EXISTS (
       SELECT 1 FROM offering.transitions t
       WHERE t.entity = CASE WHEN TG_TABLE_NAME = 'offering_events' THEN 'offering' ELSE 'subscription' END
         AND t.code = NEW.code AND t.from_state = NEW.from_state AND t.to_state = NEW.to_state) THEN
    RAISE EXCEPTION 'transition % from % to % is not allowed (current state %)', NEW.code, NEW.from_state, NEW.to_state, v_current
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER offering_events_apply BEFORE INSERT ON offering.offering_events FOR EACH ROW EXECUTE FUNCTION offering.apply_event();
CREATE TRIGGER subscription_events_apply BEFORE INSERT ON offering.subscription_events FOR EACH ROW EXECUTE FUNCTION offering.apply_event();

/** The state follows the event log; terms change only in a draft; facts are set once. */
CREATE FUNCTION offering.guard_offering() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_last text;
  c text;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'offerings are never deleted' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    SELECT to_state INTO v_last FROM offering.offering_events WHERE offering_id = NEW.id ORDER BY id DESC LIMIT 1;
    IF v_last IS DISTINCT FROM NEW.state THEN
      RAISE EXCEPTION 'the state of offering % changes only through its event log', NEW.id USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF (NEW.id, NEW.property_id, NEW.previous_id, NEW.created_by, NEW.created_at, NEW.structure_id, NEW.register_units, NEW.max_holding_units)
     IS DISTINCT FROM (OLD.id, OLD.property_id, OLD.previous_id, OLD.created_by, OLD.created_at, OLD.structure_id, OLD.register_units, OLD.max_holding_units)
     AND OLD.state <> 'draft' THEN
    RAISE EXCEPTION 'identity and structure of offering % never change after submission', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.id, NEW.property_id, NEW.previous_id, NEW.created_by, NEW.created_at) IS DISTINCT FROM (OLD.id, OLD.property_id, OLD.previous_id, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'identity of offering % never changes', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.state <> 'draft' AND (to_jsonb(NEW) - ARRAY(SELECT x FROM jsonb_object_keys(to_jsonb(NEW)) x WHERE x <> ALL (offering.term_columns())))
                              IS DISTINCT FROM
                              (to_jsonb(OLD) - ARRAY(SELECT x FROM jsonb_object_keys(to_jsonb(OLD)) x WHERE x <> ALL (offering.term_columns()))) THEN
    RAISE EXCEPTION 'terms of offering % are immutable once submitted (OF-7)', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  FOREACH c IN ARRAY ARRAY['token', 'extended_close_at', 'funded_at', 'completion_deadline', 'completing_at', 'mint_started_at', 'completed_at', 'failed_at'] LOOP
    IF to_jsonb(OLD)->c IS DISTINCT FROM 'null'::jsonb AND to_jsonb(NEW)->c IS DISTINCT FROM to_jsonb(OLD)->c THEN
      RAISE EXCEPTION 'offering %: % is set once', OLD.id, c USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  IF OLD.withdrawal_until IS NOT NULL AND (NEW.withdrawal_until IS NULL OR NEW.withdrawal_until < OLD.withdrawal_until) THEN
    RAISE EXCEPTION 'offering %: a withdrawal window is never shortened', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER offerings_guard BEFORE UPDATE OR DELETE ON offering.offerings FOR EACH ROW EXECUTE FUNCTION offering.guard_offering();

/** The state follows the event log; what was reserved, paid, settled or refunded is set once. */
CREATE FUNCTION offering.guard_subscription() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_last text;
  c text;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'subscriptions are never deleted' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    SELECT to_state INTO v_last FROM offering.subscription_events WHERE subscription_id = NEW.id ORDER BY id DESC LIMIT 1;
    IF v_last IS DISTINCT FROM NEW.state THEN
      RAISE EXCEPTION 'the state of subscription % changes only through its event log', NEW.id USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF (NEW.id, NEW.offering_id, NEW.subject_id, NEW.ref_id, NEW.units, NEW.amount_paisa, NEW.category, NEW.idempotency_key, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.offering_id, OLD.subject_id, OLD.ref_id, OLD.units, OLD.amount_paisa, OLD.category, OLD.idempotency_key, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'subscription % never changes what was asked for', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  FOREACH c IN ARRAY ARRAY['wallet', 'intent_code', 'reserved_at', 'expires_at', 'raast_ref', 'paid_journal', 'paid_at', 'settled_journal', 'mint_tx', 'refund_journal'] LOOP
    IF to_jsonb(OLD)->c IS DISTINCT FROM 'null'::jsonb AND to_jsonb(NEW)->c IS DISTINCT FROM to_jsonb(OLD)->c THEN
      RAISE EXCEPTION 'subscription %: % is set once', OLD.id, c USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER subscriptions_guard BEFORE UPDATE OR DELETE ON offering.subscriptions FOR EACH ROW EXECUTE FUNCTION offering.guard_subscription();

-- ------------------------------------------------------------------ document acceptance (OF-10)
CREATE TABLE offering.acceptances (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  offering_id  uuid NOT NULL REFERENCES offering.offerings (id),
  subject_id   uuid NOT NULL REFERENCES kyc.subjects (id),
  kind         text NOT NULL CHECK (kind IN ('offering_document', 'risk_disclosure', 'supplementary_disclosure')),
  language     text NOT NULL CHECK (language IN ('en', 'ur')),
  doc_sha      bytea NOT NULL CHECK (length(doc_sha) = 32),
  -- Keyed hashes of the portal session and the device (no raw identifiers).
  session_hash bytea NOT NULL CHECK (length(session_hash) = 32),
  device_hash  bytea NOT NULL CHECK (length(device_hash) = 32),
  actor        text NOT NULL CHECK (length(actor) BETWEEN 2 AND 100),
  accepted_at  timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp())
);
CREATE INDEX acceptances_idx ON offering.acceptances (offering_id, subject_id);

-- ------------------------------------------------------------------ maker-checker requests (OFR-2)
CREATE TABLE offering.request_rules (
  code          text PRIMARY KEY CHECK (code ~ '^[A-Z][A-Z0-9]{1,4}$'),
  -- Duties whose approval is needed; a duty listed twice needs two different officers.
  needs         text[] NOT NULL CHECK (cardinality(needs) BETWEEN 1 AND 5),
  -- Duties allowed to make the request (NULL = only the system jobs / functions create it).
  maker_duties  text[],
  per_subscription boolean NOT NULL,
  -- A request goes stale when the offering leaves the state it was made in.
  stale_on_state boolean NOT NULL,
  expires       boolean NOT NULL,
  note          text NOT NULL
);
INSERT INTO offering.request_rules (code, needs, maker_duties, per_subscription, stale_on_state, expires, note) VALUES
  ('L3', ARRAY['offering', 'legal_head', 'compliance', 'trustee'], NULL, false, true, true,
   'L3: terms (checker), documents (legal head), eligibility and disclosures (compliance), trustee; made by L1'),
  ('L7', ARRAY['offering', 'trustee'], ARRAY['offering', 'compliance', 'trustee'], false, true, true, 'L7 resume after suspension'),
  ('L8', ARRAY['offering', 'trustee'], ARRAY['offering', 'compliance', 'trustee'], false, true, true, 'L8 cancel a suspended offering'),
  ('L10', ARRAY['offering', 'trustee'], ARRAY['offering'], false, false, true, 'L10 extension (OF-20..OF-22), requested before the close time'),
  ('L11', ARRAY['trustee'], NULL, false, true, false, 'L11 funded: proposed by the system, confirmed by the trustee'),
  ('L12', ARRAY['trustee'], NULL, false, true, false, 'L12 failed (min raise not met): proposed by the system, confirmed by the trustee'),
  ('L13', ARRAY['offering', 'trustee'], ARRAY['offering'], false, true, true, 'L13 completing: conditions precedent (OF-41) and a clean issuance dry run (OF-43)'),
  ('L14', ARRAY['trustee'], ARRAY['offering'], false, true, true, 'L14 completed: register attestation (OF-49), every allocation settled'),
  ('L15', ARRAY['trustee'], NULL, false, true, false, 'L15 completion deadline missed: proposed by the system, confirmed by the trustee'),
  ('L16', ARRAY['offering', 'trustee'], ARRAY['offering', 'trustee'], false, true, true, 'L16 completion aborted before any mint was enqueued'),
  ('IB', ARRAY['offering', 'trustee'], ARRAY['offering'], false, true, true, 'OF-46 issuance batch: the preparer never approves (OF-SOD-2)'),
  ('CMP', ARRAY['trustee'], ARRAY['offering'], false, true, true, 'OF-45 completion record: registered sale deed and the completion payment batch'),
  ('SD', ARRAY['compliance', 'trustee'], ARRAY['offering'], false, true, true, 'OF-23 supplementary disclosure: opens the withdrawal right'),
  ('V17', ARRAY['offering'], ARRAY['offering'], true, false, true, 'V17 mint retry with the same refId, only if it was never used on chain'),
  ('V20', ARRAY['bank_operator', 'bank_operator'], NULL, true, false, false, 'V20 refund to the sender: two bank operators (OF-SOD-3)');

CREATE TABLE offering.requests (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  offering_id     uuid NOT NULL REFERENCES offering.offerings (id),
  subscription_id uuid REFERENCES offering.subscriptions (id),
  code            text NOT NULL REFERENCES offering.request_rules (code),
  offering_state  text NOT NULL,
  requested_by    text NOT NULL CHECK (length(requested_by) BETWEEN 2 AND 100),
  reason          text NOT NULL CHECK (length(reason) BETWEEN 10 AND 500),
  detail          jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object' AND octet_length(detail::text) <= 4096),
  requested_at    timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  expires_at      timestamptz,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'approved', 'rejected', 'expired', 'stale')),
  decided_at      timestamptz,
  CHECK ((status = 'open') = (decided_at IS NULL))
);
CREATE UNIQUE INDEX requests_one_open ON offering.requests (offering_id, code, coalesce(subscription_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE status = 'open';

CREATE FUNCTION offering.guard_request() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'requests are never deleted' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF OLD.status <> 'open' OR NEW.status = 'open'
     OR (to_jsonb(NEW) - 'status' - 'decided_at') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'decided_at') THEN
    RAISE EXCEPTION 'request % is decided once', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER requests_guard BEFORE UPDATE OR DELETE ON offering.requests FOR EACH ROW EXECUTE FUNCTION offering.guard_request();

CREATE TABLE offering.request_votes (
  request_id bigint NOT NULL REFERENCES offering.requests (id),
  officer    text NOT NULL CHECK (length(officer) BETWEEN 2 AND 100),
  duty       text NOT NULL,
  approve    boolean NOT NULL,
  reason     text NOT NULL CHECK (length(reason) BETWEEN 10 AND 500),
  at         timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  PRIMARY KEY (request_id, officer)
);

-- ------------------------------------------------------------------ issuance batch (OF-46), completion (OF-41, OF-45, OF-49)
CREATE TABLE offering.issuance_batches (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  offering_id uuid NOT NULL REFERENCES offering.offerings (id),
  digest      bytea NOT NULL CHECK (length(digest) = 32),
  item_count  integer NOT NULL CHECK (item_count BETWEEN 1 AND 100000),
  total_units bigint NOT NULL CHECK (total_units > 0),
  prepared_by text NOT NULL CHECK (length(prepared_by) BETWEEN 2 AND 100),
  prepared_at timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  request_id  bigint NOT NULL UNIQUE REFERENCES offering.requests (id)
);
CREATE TABLE offering.issuance_items (
  batch_id        bigint NOT NULL REFERENCES offering.issuance_batches (id),
  line_no         integer NOT NULL CHECK (line_no >= 1),
  subscription_id uuid NOT NULL REFERENCES offering.subscriptions (id),
  ref_id          text NOT NULL,
  wallet          text NOT NULL,
  units           bigint NOT NULL CHECK (units > 0),
  PRIMARY KEY (batch_id, line_no),
  UNIQUE (batch_id, subscription_id)
);

CREATE TABLE offering.conditions_precedent (
  offering_id uuid PRIMARY KEY REFERENCES offering.offerings (id),
  conditions  jsonb NOT NULL CHECK (jsonb_typeof(conditions) = 'object'),
  request_id  bigint NOT NULL UNIQUE REFERENCES offering.requests (id),
  at          timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp())
);

CREATE TABLE offering.completions (
  offering_id       uuid PRIMARY KEY REFERENCES offering.offerings (id),
  deed_sha          bytea NOT NULL CHECK (length(deed_sha) = 32),
  deed_registration text NOT NULL CHECK (length(deed_registration) BETWEEN 3 AND 200),
  batch_reference   text NOT NULL CHECK (batch_reference ~ '^[A-Z0-9][A-Z0-9-]{3,63}$'),
  batch_file_sha    bytea NOT NULL CHECK (length(batch_file_sha) = 32),
  request_id        bigint NOT NULL UNIQUE REFERENCES offering.requests (id),
  at                timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp())
);

CREATE TABLE offering.register_attestations (
  offering_id  uuid PRIMARY KEY REFERENCES offering.offerings (id),
  total_units  bigint NOT NULL CHECK (total_units > 0),
  register_sha bytea NOT NULL CHECK (length(register_sha) = 32),
  request_id   bigint NOT NULL UNIQUE REFERENCES offering.requests (id),
  at           timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp())
);

-- Every mint command enqueued for a subscription (attempt 1 = start_minting, later = V17 retries).
CREATE TABLE offering.mint_commands (
  subscription_id uuid NOT NULL REFERENCES offering.subscriptions (id),
  attempt         smallint NOT NULL CHECK (attempt BETWEEN 1 AND 10),
  outbox_key      text NOT NULL UNIQUE,
  command_id      bigint NOT NULL UNIQUE REFERENCES outbox.commands (id),
  enqueued_by     text NOT NULL,
  at              timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  PRIMARY KEY (subscription_id, attempt)
);

-- Refunds (V20): what is owed back, and the journal once it was sent.
CREATE TABLE offering.refunds (
  subscription_id uuid PRIMARY KEY REFERENCES offering.subscriptions (id),
  cause           text NOT NULL CHECK (cause IN ('offering_failed', 'withdrawal', 'eligibility_lost', 'allocation_failed')),
  request_id      bigint NOT NULL UNIQUE REFERENCES offering.requests (id),
  raast_ref       text NOT NULL REFERENCES bank.credits (raast_ref),
  amount_paisa    bigint NOT NULL CHECK (amount_paisa > 0),
  created_at      timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  journal_id      bigint UNIQUE REFERENCES ledger.journal (id),
  sent_by         text CHECK (length(sent_by) BETWEEN 2 AND 100),
  sent_at         timestamptz,
  CHECK ((journal_id IS NULL) = (sent_at IS NULL) AND (sent_at IS NULL) = (sent_by IS NULL))
);
CREATE FUNCTION offering.guard_refund() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'refunds are never deleted' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF OLD.journal_id IS NOT NULL OR (to_jsonb(NEW) - 'journal_id' - 'sent_by' - 'sent_at') IS DISTINCT FROM (to_jsonb(OLD) - 'journal_id' - 'sent_by' - 'sent_at') THEN
    RAISE EXCEPTION 'refund of % is recorded once', OLD.subscription_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER refunds_guard BEFORE UPDATE OR DELETE ON offering.refunds FOR EACH ROW EXECUTE FUNCTION offering.guard_refund();

-- A matched credit for a subscription that was no longer waiting for it (should be impossible:
-- the payment code expires and is cancelled with the reservation). Reconciliation reports it.
CREATE TABLE offering.payment_anomalies (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subscription_id uuid NOT NULL REFERENCES offering.subscriptions (id),
  raast_ref       text NOT NULL UNIQUE,
  state           text NOT NULL,
  at              timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp())
);

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['audit', 'offering_events', 'subscription_events', 'acceptances', 'request_votes', 'issuance_batches',
                           'issuance_items', 'conditions_precedent', 'completions', 'register_attestations', 'mint_commands',
                           'payment_anomalies', 'transitions', 'request_rules', 'settings'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON offering.%I FOR EACH ROW EXECUTE FUNCTION offering.forbid_change()', t || '_append_only', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['audit', 'duties', 'offerings', 'offering_events', 'subscriptions', 'subscription_events', 'acceptances',
                           'requests', 'request_votes', 'issuance_batches', 'issuance_items', 'conditions_precedent', 'completions',
                           'register_attestations', 'mint_commands', 'refunds', 'payment_anomalies', 'transitions', 'request_rules', 'settings'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON offering.%I FOR EACH STATEMENT EXECUTE FUNCTION offering.forbid_change()', t || '_no_truncate', t);
  END LOOP;
END $$;

-- ================================================================== bank amendment (ADR 0009, additive)
CREATE TABLE bank.intent_cancellations (
  code   text PRIMARY KEY REFERENCES bank.payment_intents (code),
  by     text NOT NULL CHECK (length(by) BETWEEN 2 AND 100),
  reason text NOT NULL CHECK (length(reason) BETWEEN 10 AND 300),
  at     timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp())
);

-- The return of a MATCHED subscription credit to its sender (OF-50), under its own reference.
CREATE TABLE bank.credit_refunds (
  raast_ref  text PRIMARY KEY REFERENCES bank.credits (raast_ref),
  ledger_key text NOT NULL UNIQUE CHECK (ledger_key ~ '^sub:0x[0-9a-f]{64}:refunded$'),
  journal_id bigint NOT NULL UNIQUE REFERENCES ledger.journal (id),
  refunded_by text NOT NULL CHECK (length(refunded_by) BETWEEN 2 AND 100),
  reason     text NOT NULL CHECK (length(reason) BETWEEN 10 AND 300),
  at         timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp())
);

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['intent_cancellations', 'credit_refunds'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON bank.%I FOR EACH ROW EXECUTE FUNCTION bank.forbid_change()', t || '_append_only', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON bank.%I FOR EACH STATEMENT EXECUTE FUNCTION bank.forbid_change()', t || '_no_truncate', t);
  END LOOP;
END $$;

/**
 * Cancels an unpaid payment code: a later credit with it goes to suspense. Takes the same lock as
 * bank.book_credit for the code, so a cancellation and a payment never cross. Refuses a paid code.
 */
CREATE FUNCTION bank.cancel_intent(p_code text, p_actor text, p_reason text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, bank AS $$
BEGIN
  IF p_code IS NULL OR p_actor IS NULL OR length(p_actor) NOT BETWEEN 2 AND 100 OR p_reason IS NULL OR length(p_reason) NOT BETWEEN 10 AND 300 THEN
    RAISE EXCEPTION 'a code, an actor and a reason of 10 to 300 characters are required' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(586586098, hashtext(p_code));
  IF NOT EXISTS (SELECT 1 FROM bank.payment_intents WHERE code = p_code) THEN
    RAISE EXCEPTION 'unknown payment code %', p_code USING ERRCODE = 'no_data_found';
  END IF;
  IF EXISTS (SELECT 1 FROM bank.credits WHERE intent_code = p_code AND status = 'matched') THEN
    RAISE EXCEPTION 'payment code % is already paid', p_code USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM bank.intent_cancellations WHERE code = p_code) THEN RETURN false; END IF;
  INSERT INTO bank.intent_cancellations (code, by, reason) VALUES (p_code, p_actor, p_reason);
  PERFORM bank.audit_append(p_actor, 'intent.cancelled', jsonb_build_object('code', p_code));
  RETURN true;
END $$;

/** As in 0009, plus: a cancelled payment code is not a match (OF-19: nobody pays for units they no longer hold). */
CREATE OR REPLACE FUNCTION bank.book_credit(p_event text, p jsonb, p_actor text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, bank AS $$
DECLARE
  v_ref text;
  v_amount bigint;
  v_payer bytea;
  v_code text;
  c bank.credits;
  i bank.payment_intents;
  v_status text := 'suspense';
  v_reason text;
  v_key text;
  v_account text;
  v_journal bigint;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object'
     OR jsonb_typeof(p->'raastRef') IS DISTINCT FROM 'string' OR (p->>'raastRef') !~ '^[A-Z0-9][A-Z0-9-]{3,63}$'
     OR jsonb_typeof(p->'amountPaisa') IS DISTINCT FROM 'string' OR (p->>'amountPaisa') !~ '^[1-9][0-9]{0,14}$'
     OR jsonb_typeof(p->'valueDate') IS DISTINCT FROM 'string' OR (p->>'valueDate') !~ '^\d{4}-\d{2}-\d{2}$'
     OR jsonb_typeof(p->'payerHash') IS DISTINCT FROM 'string' OR (p->>'payerHash') !~ '^[0-9a-f]{64}$'
     OR jsonb_typeof(p->'payerLast4') IS DISTINCT FROM 'string' OR (p->>'payerLast4') !~ '^[0-9]{4}$'
     OR jsonb_typeof(p->'intentCode') IS NULL
     OR (jsonb_typeof(p->'intentCode') <> 'null' AND (jsonb_typeof(p->'intentCode') <> 'string' OR (p->>'intentCode') !~ '^PT-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$')) THEN
    RAISE EXCEPTION 'malformed credit event %', p_event USING ERRCODE = 'check_violation';
  END IF;
  v_ref := p->>'raastRef';
  v_amount := (p->>'amountPaisa')::bigint;
  v_payer := decode(p->>'payerHash', 'hex');
  v_code := p->>'intentCode';

  PERFORM pg_advisory_xact_lock(586586097, hashtext(v_ref));
  SELECT * INTO c FROM bank.credits WHERE raast_ref = v_ref;
  IF FOUND THEN
    -- The bank re-sent the same transfer under a new event id.
    IF c.amount_paisa = v_amount AND c.payer_hash = v_payer THEN RETURN 'duplicate_reference'; END IF;
    PERFORM bank.audit_append(p_actor, 'credit.reference_conflict', jsonb_build_object('ref', v_ref, 'event', p_event));
    PERFORM pg_notify('bank_alert', json_build_object('kind', 'reference_conflict', 'ref', v_ref, 'event', p_event)::text);
    RETURN 'reference_conflict';
  END IF;

  IF v_code IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(586586098, hashtext(v_code));
    SELECT * INTO i FROM bank.payment_intents WHERE code = v_code;
  END IF;
  IF i.code IS NULL THEN
    v_reason := 'no valid payment code';
  ELSIF clock_timestamp() > i.expires_at THEN
    v_reason := 'payment code expired';
  ELSIF EXISTS (SELECT 1 FROM bank.intent_cancellations WHERE code = i.code) THEN
    v_reason := 'payment code cancelled';
  ELSIF v_amount <> i.amount_paisa THEN
    v_reason := 'amount differs from the payment code';
  ELSIF EXISTS (SELECT 1 FROM bank.credits WHERE intent_code = i.code AND status = 'matched') THEN
    v_reason := 'payment code already paid';
  ELSIF i.subject_id IS NOT NULL AND kyc.subject_status(i.subject_id) <> 'verified' THEN
    v_reason := 'investor is not KYC-verified';
  ELSIF i.subject_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM bank.payees WHERE subject_id = i.subject_id AND iban_hash = v_payer) THEN
    v_reason := 'paid from an account not registered to the investor';
  ELSE
    v_status := 'matched';
    v_reason := 'matched ' || i.code;
  END IF;

  IF v_status = 'matched' THEN
    v_key := i.ledger_key;
    v_account := i.credit_account;
  ELSE
    v_key := 'bank:suspense:' || v_ref;
    v_account := 'bank:suspense';
  END IF;
  v_journal := ledger.post_journal(v_key, 'payment_in', v_reason, v_ref, p_actor, jsonb_build_array(
    jsonb_build_object('account', 'bank:trustee-escrow', 'amount', v_amount::text),
    jsonb_build_object('account', v_account, 'amount', (-v_amount)::text)));
  INSERT INTO bank.credits (raast_ref, event_id, amount_paisa, value_date, payer_hash, payer_last4, intent_code, status, reason, journal_id)
  VALUES (v_ref, p_event, v_amount, (p->>'valueDate')::date, v_payer, p->>'payerLast4', i.code, v_status, v_reason, v_journal);
  PERFORM bank.audit_append(p_actor, 'credit.booked', jsonb_build_object('ref', v_ref, 'event', p_event, 'amount', v_amount::text,
                                                                        'status', v_status, 'intent', i.code, 'journal', v_journal));
  IF v_status = 'suspense' THEN
    PERFORM pg_notify('bank_alert', json_build_object('kind', 'suspense', 'ref', v_ref, 'reason', v_reason)::text);
  END IF;
  RETURN v_status;
END $$;

/**
 * OF-50: returns a matched subscription credit to its sender, in full, under its own Raast
 * reference: Dr the investor's subscription liability, Cr escrow; journal `sub:<refId>:refunded`.
 * Needs the reconciliation gate (B-5). Idempotent for the same reference. Called by the offering
 * module only (after maker-checker); the caller instructs the bank after commit (record before send).
 */
CREATE FUNCTION bank.refund_credit(p_ref text, p_actor text, p_reason text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, bank AS $$
DECLARE
  c bank.credits;
  i bank.payment_intents;
  v_key text;
  v_journal bigint;
BEGIN
  IF p_ref IS NULL OR p_actor IS NULL OR length(p_actor) NOT BETWEEN 2 AND 100 OR p_reason IS NULL OR length(p_reason) NOT BETWEEN 10 AND 300 THEN
    RAISE EXCEPTION 'a reference, an actor and a reason of 10 to 300 characters are required' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(586586097, hashtext(p_ref));
  SELECT * INTO c FROM bank.credits WHERE raast_ref = p_ref;
  IF NOT FOUND OR c.status <> 'matched' THEN
    RAISE EXCEPTION 'credit % is not a matched credit', p_ref USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO i FROM bank.payment_intents WHERE code = c.intent_code;
  IF i.purpose <> 'subscription' THEN
    RAISE EXCEPTION 'only subscription credits are refunded this way' USING ERRCODE = 'check_violation';
  END IF;
  SELECT journal_id INTO v_journal FROM bank.credit_refunds WHERE raast_ref = p_ref;
  IF FOUND THEN RETURN v_journal; END IF;
  PERFORM bank.require_gate();
  v_key := regexp_replace(i.ledger_key, ':paid$', ':refunded');
  v_journal := ledger.post_journal(v_key, 'subscription_refund', left(p_reason, 200), p_ref, p_actor, jsonb_build_array(
    jsonb_build_object('account', i.credit_account, 'amount', c.amount_paisa::text),
    jsonb_build_object('account', 'bank:trustee-escrow', 'amount', (-c.amount_paisa)::text)));
  INSERT INTO bank.credit_refunds (raast_ref, ledger_key, journal_id, refunded_by, reason) VALUES (p_ref, v_key, v_journal, p_actor, left(p_reason, 300));
  PERFORM bank.audit_append(p_actor, 'credit.refunded', jsonb_build_object('ref', p_ref, 'amount', c.amount_paisa::text, 'journal', v_journal));
  RETURN v_journal;
END $$;

-- ================================================================== internal helpers
/** A Crockford base-32 payment code from 8 random bytes of a UUID (the version/variant bytes skipped). */
CREATE FUNCTION offering.new_code() RETURNS text
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog AS $$
DECLARE
  a constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  b bytea := uuid_send(gen_random_uuid());
  s text := '';
  i int;
BEGIN
  FOREACH i IN ARRAY ARRAY[0, 1, 2, 3, 4, 5, 7, 9] LOOP
    s := s || substr(a, (get_byte(b, i) % 32) + 1, 1);
  END LOOP;
  RETURN 'PT-' || substr(s, 1, 4) || '-' || substr(s, 5, 4);
END $$;

CREATE FUNCTION offering.close_time(o offering.offerings) RETURNS timestamptz
LANGUAGE sql STABLE AS $$ SELECT coalesce(o.extended_close_at, o.closes_at) $$;

-- States in which a subscription holds units (counted against the hard cap) and in which its money
-- counts towards the raise.
CREATE FUNCTION offering.holding_states() RETURNS text[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['payment_pending', 'payment_confirmed', 'allocation_pending', 'issuance_review', 'tokens_issued', 'active', 'refund_pending', 'blocked', 'disputed']
$$;
CREATE FUNCTION offering.paid_states() RETURNS text[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['payment_confirmed', 'allocation_pending', 'issuance_review', 'tokens_issued', 'active']
$$;

CREATE FUNCTION offering.units(p_offering uuid)
RETURNS TABLE (held bigint, reserved bigint, paid bigint, waitlisted bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, offering AS $$
  SELECT coalesce(sum(units) FILTER (WHERE state = ANY (offering.holding_states())), 0)::bigint,
         coalesce(sum(units) FILTER (WHERE state = 'payment_pending'), 0)::bigint,
         coalesce(sum(units) FILTER (WHERE state = ANY (offering.paid_states())), 0)::bigint,
         coalesce(sum(units) FILTER (WHERE state = 'waitlisted'), 0)::bigint
  FROM offering.subscriptions WHERE offering_id = p_offering
$$;

CREATE FUNCTION offering.contract_of(p_token text, p_role text) RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT c.address FROM chain.tokens t JOIN chain.contracts c ON c.deployment = t.deployment AND c.role = p_role WHERE t.token = p_token
$$;

CREATE FUNCTION offering.move(p_offering uuid, p_code text, p_to text, p_actor text, p_reason text, p_request bigint) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, offering AS $$
DECLARE
  v_from text;
  v_event bigint;
  v_action text;
BEGIN
  SELECT state INTO v_from FROM offering.offerings WHERE id = p_offering FOR NO KEY UPDATE;
  INSERT INTO offering.offering_events (offering_id, code, from_state, to_state, actor, reason, request_id)
  VALUES (p_offering, p_code, v_from, p_to, p_actor, left(p_reason, 500), p_request) RETURNING id INTO v_event;
  UPDATE offering.offerings SET state = p_to WHERE id = p_offering;
  SELECT action INTO v_action FROM offering.transitions WHERE entity = 'offering' AND code = p_code AND from_state = v_from;
  PERFORM offering.audit_append(p_actor, v_action, jsonb_build_object('ref', p_offering, 'event', v_event, 'code', p_code, 'from', v_from,
                                                                     'to', p_to, 'request', p_request, 'reason', p_reason));
END $$;

CREATE FUNCTION offering.sub_move(p_sub uuid, p_code text, p_to text, p_actor text, p_reason text, p_request bigint) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, offering AS $$
DECLARE
  v_from text;
  v_event bigint;
  v_action text;
BEGIN
  SELECT state INTO v_from FROM offering.subscriptions WHERE id = p_sub FOR NO KEY UPDATE;
  INSERT INTO offering.subscription_events (subscription_id, code, from_state, to_state, actor, reason, request_id)
  VALUES (p_sub, p_code, v_from, p_to, p_actor, left(p_reason, 500), p_request) RETURNING id INTO v_event;
  UPDATE offering.subscriptions SET state = p_to WHERE id = p_sub;
  SELECT action INTO v_action FROM offering.transitions WHERE entity = 'subscription' AND code = p_code AND from_state = v_from;
  PERFORM offering.audit_append(p_actor, v_action, jsonb_build_object('ref', p_sub, 'event', v_event, 'code', p_code, 'from', v_from,
                                                                     'to', p_to, 'request', p_request));
END $$;

/**
 * OF-13/OF-14 eligibility of an investor for units of an offering. kind: ok | kyc_pending | rejected;
 * problem is internal; public_problem is what the investor may see (never sanctions detail).
 */
CREATE FUNCTION offering.eligibility(p_offering uuid, p_subject uuid, p_units bigint, p_category text, p_exclude uuid)
RETURNS TABLE (kind text, problem text, public_problem text, wallet text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, offering AS $$
DECLARE
  o offering.offerings;
  v_status text;
  v_valid timestamptz;
  v_wallet text;
  v_registry text;
  v_held bigint;
  v_onchain numeric;
BEGIN
  SELECT * INTO o FROM offering.offerings WHERE id = p_offering;
  v_status := kyc.subject_status(p_subject);
  SELECT w.wallet INTO v_wallet FROM kyc.wallets w WHERE w.subject_id = p_subject;
  wallet := v_wallet;
  IF v_status IN ('pending', 'review', 'expired') THEN
    kind := 'kyc_pending'; problem := 'kyc ' || v_status; public_problem := 'identity verification is not complete';
    RETURN NEXT; RETURN;
  END IF;
  IF v_status <> 'verified' THEN
    -- Tipping-off (V4): a rejection or revocation, including a sanctions match, reads the same.
    kind := 'rejected'; problem := 'kyc ' || v_status; public_problem := 'not eligible for this offering';
    RETURN NEXT; RETURN;
  END IF;
  SELECT d.valid_until INTO v_valid FROM kyc.decisions d WHERE d.subject_id = p_subject ORDER BY d.id DESC LIMIT 1;
  IF v_valid < offering.close_time(o) + make_interval(days => o.completion_days + offering.setting('kyc_margin_days')::int) THEN
    kind := 'kyc_pending'; problem := 'kyc validity ends before completion + margin (OF-13)';
    public_problem := 'please renew your identity verification before subscribing';
    RETURN NEXT; RETURN;
  END IF;
  kind := 'rejected';
  IF EXISTS (SELECT 1 FROM offering.subscriptions s WHERE s.subject_id = p_subject AND s.state IN ('blocked', 'disputed')) THEN
    problem := 'blocked or disputed subscription elsewhere'; public_problem := 'not eligible for this offering'; RETURN NEXT; RETURN;
  END IF;
  IF v_wallet IS NULL THEN
    problem := 'no wallet bound'; public_problem := 'no wallet is set up for this investor yet'; RETURN NEXT; RETURN;
  END IF;
  v_registry := offering.contract_of(o.token, 'identityRegistry');
  IF NOT EXISTS (SELECT 1 FROM chain.investors i WHERE i.registry = v_registry AND i.wallet = v_wallet AND i.registered
                   AND i.country = offering.setting('allowed_country')::int) THEN
    problem := 'wallet not registered on the identity registry with an allowed country';
    public_problem := 'the wallet is not registered for this token yet'; RETURN NEXT; RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM chain.freezes f WHERE f.token = o.token AND f.holder = v_wallet AND f.address_frozen) THEN
    problem := 'wallet frozen'; public_problem := 'not eligible for this offering'; RETURN NEXT; RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM bank.payees p WHERE p.subject_id = p_subject AND p.superseded_at IS NULL) THEN
    problem := 'no registered bank account (OF-13, B-2)'; public_problem := 'register your bank account first: only a registered account can pay';
    RETURN NEXT; RETURN;
  END IF;
  IF NOT (p_category = ANY (o.categories)) THEN
    problem := 'investor category not allowed'; public_problem := 'this offering is not open to your investor category'; RETURN NEXT; RETURN;
  END IF;
  SELECT coalesce(sum(s.units), 0) INTO v_held FROM offering.subscriptions s
  WHERE s.offering_id = o.id AND s.subject_id = p_subject AND s.state = ANY (offering.holding_states()) AND s.id IS DISTINCT FROM p_exclude;
  IF v_held + p_units > o.max_units THEN
    problem := 'above the per-investor maximum (OF-4)'; public_problem := format('at most %s units per investor in this offering', o.max_units);
    RETURN NEXT; RETURN;
  END IF;
  -- OF-14 headroom across every offering of this token and the wallet's balance on chain.
  SELECT coalesce(sum(s.units), 0) INTO v_held FROM offering.subscriptions s JOIN offering.offerings x ON x.id = s.offering_id
  WHERE x.token = o.token AND s.subject_id = p_subject AND s.state = ANY (ARRAY['payment_pending', 'payment_confirmed', 'allocation_pending', 'issuance_review', 'refund_pending', 'blocked'])
    AND s.id IS DISTINCT FROM p_exclude;
  SELECT coalesce(h.balance, 0) INTO v_onchain FROM chain.holdings h WHERE h.token = o.token AND h.holder = v_wallet;
  IF coalesce(v_onchain, 0) + v_held + p_units > o.max_holding_units THEN
    problem := 'above the maximum holding (OF-14)'; public_problem := format('a holding may not exceed %s units (10 %% of the register)', o.max_holding_units);
    RETURN NEXT; RETURN;
  END IF;
  kind := 'ok'; problem := NULL; public_problem := NULL;
  RETURN NEXT;
END $$;

/**
 * Places a subscription: rejects, queues for KYC, waitlists, or reserves units with a payment code
 * (OF-15/OF-16/OF-19). The caller holds the offering row lock. mode: new | kyc | promote.
 */
CREATE FUNCTION offering.place(p_sub uuid, p_mode text, p_actor text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, offering AS $$
DECLARE
  s offering.subscriptions;
  o offering.offerings;
  e record;
  u record;
  v_until timestamptz;
  v_minutes integer;
  v_code text;
  v_expires timestamptz;
  v_account text;
  v_tries integer := 0;
BEGIN
  SELECT * INTO s FROM offering.subscriptions WHERE id = p_sub FOR NO KEY UPDATE;
  SELECT * INTO o FROM offering.offerings WHERE id = s.offering_id;
  PERFORM pg_advisory_xact_lock(586586151, hashtext(s.subject_id::text));
  SELECT * INTO e FROM offering.eligibility(o.id, s.subject_id, s.units, s.category, s.id);
  IF e.kind = 'kyc_pending' THEN
    IF p_mode = 'new' THEN
      UPDATE offering.subscriptions SET reason = e.problem, public_reason = e.public_problem WHERE id = p_sub;
      PERFORM offering.sub_move(p_sub, 'V1', 'kyc_pending', p_actor, e.problem, NULL);
      RETURN 'kyc_pending';
    ELSIF p_mode = 'kyc' THEN
      RETURN 'kyc_pending';
    END IF;
    e.kind := 'rejected';
  END IF;
  IF e.kind = 'rejected' THEN
    UPDATE offering.subscriptions SET reason = e.problem, public_reason = e.public_problem WHERE id = p_sub;
    PERFORM offering.sub_move(p_sub, CASE p_mode WHEN 'kyc' THEN 'V6' ELSE 'V4' END, 'rejected', p_actor, e.problem, NULL);
    RETURN 'rejected';
  END IF;

  SELECT * INTO u FROM offering.units(o.id);
  v_until := least(clock_timestamp() + make_interval(mins => o.reservation_minutes),
                   offering.close_time(o) + make_interval(mins => o.payment_grace_minutes));
  v_minutes := floor(extract(epoch FROM (v_until - clock_timestamp())) / 60);
  IF s.units > o.hard_cap_units - u.held
     OR (p_mode <> 'promote' AND EXISTS (SELECT 1 FROM offering.subscriptions w WHERE w.offering_id = o.id AND w.state = 'waitlisted' AND w.id <> p_sub))
     OR v_minutes < offering.setting('min_reservation_minutes') THEN
    IF p_mode = 'promote' THEN RETURN 'waitlisted'; END IF;
    PERFORM offering.sub_move(p_sub, 'V3', 'waitlisted', p_actor, 'no free units (OF-19)', NULL);
    RETURN 'waitlisted';
  END IF;

  -- Reserve: one payment code for exactly units x price, expiring with the reservation (OF-15/16).
  v_account := 'investor:' || s.subject_id || ':subscriptions';
  PERFORM ledger.open_account(v_account, 'liability', 'PKR', false);
  LOOP
    v_tries := v_tries + 1;
    v_code := offering.new_code();
    BEGIN
      PERFORM bank.create_intent(v_code, 'subscription', s.subject_id, s.amount_paisa, 'sub:' || s.ref_id || ':paid', v_account, v_minutes, p_actor);
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      IF v_tries >= 5 THEN RAISE; END IF;
    END;
  END LOOP;
  SELECT expires_at INTO v_expires FROM bank.payment_intents WHERE code = v_code;
  UPDATE offering.subscriptions SET wallet = e.wallet, intent_code = v_code, reserved_at = date_trunc('microseconds', clock_timestamp()),
         expires_at = v_expires, reason = NULL, public_reason = NULL WHERE id = p_sub;
  PERFORM offering.sub_move(p_sub, CASE p_mode WHEN 'new' THEN 'V2' WHEN 'kyc' THEN 'V5' ELSE 'V7' END, 'payment_pending', p_actor,
                            'units reserved, payment code ' || v_code, NULL);
  RETURN 'payment_pending';
END $$;

/** OF-19: the oldest waitlisted investors get freed units, strictly in order. Caller holds the offering lock. */
CREATE FUNCTION offering.promote_internal(p_offering uuid, p_actor text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, offering AS $$
DECLARE
  w record;
  v_n integer := 0;
  v_state text;
BEGIN
  IF (SELECT state FROM offering.offerings WHERE id = p_offering) <> 'live' THEN RETURN 0; END IF;
  FOR w IN SELECT id FROM offering.subscriptions WHERE offering_id = p_offering AND state = 'waitlisted' ORDER BY created_at, id LOOP
    v_state := offering.place(w.id, 'promote', p_actor);
    IF v_state = 'waitlisted' THEN EXIT; END IF;
    IF v_state = 'payment_pending' THEN v_n := v_n + 1; END IF;
  END LOOP;
  RETURN v_n;
END $$;

/** Confirms the payment of a reservation whose credit was matched (V9). Caller holds the subscription. */
CREATE FUNCTION offering.confirm_payment(p_sub uuid, p_ref text, p_actor text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, offering AS $$
DECLARE
  s offering.subscriptions;
  c bank.credits;
BEGIN
  SELECT * INTO s FROM offering.subscriptions WHERE id = p_sub FOR NO KEY UPDATE;
  SELECT * INTO c FROM bank.credits WHERE raast_ref = p_ref;
  IF s.state <> 'payment_pending' OR c.status <> 'matched' OR c.intent_code IS DISTINCT FROM s.intent_code THEN RETURN false; END IF;
  -- The matched journal is the ledger's `sub:<refId>:paid` (bank.create_intent was given that key).
  IF NOT EXISTS (SELECT 1 FROM ledger.journal j WHERE j.id = c.journal_id AND j.idempotency_key = 'sub:' || s.ref_id || ':paid') THEN
    RAISE EXCEPTION 'credit % is not booked as sub:%:paid', p_ref, s.ref_id USING ERRCODE = 'check_violation';
  END IF;
  UPDATE offering.subscriptions SET raast_ref = c.raast_ref, paid_journal = c.journal_id, paid_at = c.booked_at WHERE id = p_sub;
  PERFORM offering.sub_move(p_sub, 'V9', 'payment_confirmed', p_actor, 'exact credit ' || c.raast_ref, NULL);
  RETURN true;
END $$;

/** OFR-4: a matched credit confirms its reservation in the same transaction as the bank booking. */
CREATE FUNCTION offering.on_credit_booked() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, offering AS $$
DECLARE
  s offering.subscriptions;
BEGIN
  SELECT * INTO s FROM offering.subscriptions WHERE intent_code = NEW.intent_code FOR NO KEY UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;  -- not an offering payment code (rent collection, web prototype)
  IF s.state = 'payment_pending' THEN
    PERFORM offering.confirm_payment(s.id, NEW.raast_ref, 'bank-service');
  ELSE
    INSERT INTO offering.payment_anomalies (subscription_id, raast_ref, state) VALUES (s.id, NEW.raast_ref, s.state);
    PERFORM offering.audit_append('bank-service', 'subscription.payment_anomaly', jsonb_build_object('ref', s.id, 'raastRef', NEW.raast_ref, 'state', s.state));
    PERFORM pg_notify('offering_alert', json_build_object('kind', 'payment_anomaly', 'subscription', s.id, 'ref', NEW.raast_ref)::text);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER credits_offering AFTER INSERT ON bank.credits FOR EACH ROW WHEN (NEW.status = 'matched')
  EXECUTE FUNCTION offering.on_credit_booked();

/** Expires unpaid reservations past their time (V10); a matched credit always wins (same lock as the bank). */
CREATE FUNCTION offering.expire_internal(p_offering uuid, p_actor text, p_all boolean) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, offering AS $$
DECLARE
  r record;
  v_n integer := 0;
  v_ref text;
BEGIN
  -- Every payment code lock first, in one order, before anything is written (see audit_append).
  PERFORM pg_advisory_xact_lock(586586098, hashtext(x.intent_code))
  FROM (SELECT intent_code FROM offering.subscriptions
        WHERE offering_id = p_offering AND state = 'payment_pending' AND (p_all OR expires_at < clock_timestamp()) ORDER BY hashtext(intent_code), intent_code) x;
  FOR r IN SELECT id, intent_code FROM offering.subscriptions
           WHERE offering_id = p_offering AND state = 'payment_pending' AND (p_all OR expires_at < clock_timestamp()) ORDER BY id LOOP
    IF (SELECT state FROM offering.subscriptions WHERE id = r.id FOR NO KEY UPDATE) <> 'payment_pending' THEN CONTINUE; END IF;
    SELECT raast_ref INTO v_ref FROM bank.credits WHERE intent_code = r.intent_code AND status = 'matched';
    IF FOUND THEN
      PERFORM offering.confirm_payment(r.id, v_ref, p_actor);
      CONTINUE;
    END IF;
    IF p_all AND (SELECT expires_at FROM offering.subscriptions WHERE id = r.id) >= clock_timestamp() THEN
      PERFORM bank.cancel_intent(r.intent_code, p_actor, 'reservation ended before its time: offering suspended or closed');
    END IF;
    PERFORM offering.sub_move(r.id, 'V10', 'expired', p_actor, CASE WHEN p_all THEN 'offering stopped taking payments' ELSE 'reservation expired unpaid' END, NULL);
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END $$;

/** Opens a refund request (V20, two bank operators) for a subscription moving to Refund Pending. */
CREATE FUNCTION offering.open_refund(p_sub uuid, p_cause text, p_actor text, p_reason text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, offering AS $$
DECLARE
  s offering.subscriptions;
  o offering.offerings;
  v_req bigint;
BEGIN
  SELECT * INTO s FROM offering.subscriptions WHERE id = p_sub;
  SELECT * INTO o FROM offering.offerings WHERE id = s.offering_id;
  INSERT INTO offering.requests (offering_id, subscription_id, code, offering_state, requested_by, reason, detail)
  VALUES (o.id, p_sub, 'V20', o.state, p_actor, p_reason, jsonb_build_object('cause', p_cause, 'raastRef', s.raast_ref, 'amount', s.amount_paisa::text))
  RETURNING id INTO v_req;
  INSERT INTO offering.refunds (subscription_id, cause, request_id, raast_ref, amount_paisa) VALUES (p_sub, p_cause, v_req, s.raast_ref, s.amount_paisa);
  PERFORM offering.audit_append(p_actor, 'request.created', jsonb_build_object('request', v_req, 'ref', o.id, 'code', 'V20', 'subscription', p_sub,
                                                                              'cause', p_cause, 'reason', p_reason));
  RETURN v_req;
END $$;

/** L17: every paid subscription of a failed offering moves to Refund Pending with a refund request; then L18 if nothing is owed. */
CREATE FUNCTION offering.start_refunds(p_offering uuid, p_actor text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, offering AS $$
DECLARE
  r record;
  v_n integer := 0;
BEGIN
  PERFORM offering.expire_internal(p_offering, p_actor, true);
  FOR r IN SELECT id, state FROM offering.subscriptions WHERE offering_id = p_offering
           AND state IN ('payment_confirmed', 'allocation_pending', 'kyc_pending', 'waitlisted') ORDER BY created_at, id LOOP
    IF r.state IN ('kyc_pending', 'waitlisted') THEN
      PERFORM offering.sub_move(r.id, 'V8', 'expired', p_actor, 'offering failed', NULL);
    ELSE
      PERFORM offering.sub_move(r.id, CASE r.state WHEN 'payment_confirmed' THEN 'V13' ELSE 'V15' END, 'refund_pending', p_actor, 'offering failed: full refund (OF-50)', NULL);
      PERFORM offering.open_refund(r.id, 'offering_failed', p_actor, 'offering failed: full refund to the sending account (OF-50)');
      v_n := v_n + 1;
    END IF;
  END LOOP;
  PERFORM offering.move(p_offering, 'L17', 'refunding', p_actor, format('%s refund(s) prepared', v_n), NULL);
  PERFORM offering.finish_refunds_internal(p_offering, p_actor);
  RETURN v_n;
END $$;

/** L18 once no paid money is owed (blocked or disputed subscriptions continue in S-06 and are not refunded here). */
CREATE FUNCTION offering.finish_refunds_internal(p_offering uuid, p_actor text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, offering AS $$
BEGIN
  IF (SELECT state FROM offering.offerings WHERE id = p_offering) <> 'refunding' THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM offering.subscriptions WHERE offering_id = p_offering
             AND state IN ('payment_pending', 'payment_confirmed', 'allocation_pending', 'refund_pending', 'issuance_review', 'tokens_issued')) THEN
    RETURN false;
  END IF;
  PERFORM offering.move(p_offering, 'L18', 'cancelled', p_actor, 'every paid subscription refunded', NULL);
  RETURN true;
END $$;

/** OF-43 issuance dry run on the read model (view-call equivalents). Empty = clean. */
CREATE FUNCTION offering.dry_run(p_offering uuid) RETURNS TABLE (subscription_id uuid, problem text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, offering AS $$
DECLARE
  o offering.offerings;
  s offering.subscriptions;
  v_registry text;
  v_guard text;
  v_cap numeric;
  v_supply numeric;
  v_total bigint := 0;
  v_bal numeric;
BEGIN
  SELECT * INTO o FROM offering.offerings WHERE id = p_offering;
  v_registry := offering.contract_of(o.token, 'identityRegistry');
  v_guard := offering.contract_of(o.token, 'issuance');
  SELECT t.trustee_cap, t.total_supply INTO v_cap, v_supply FROM chain.tokens t WHERE t.token = o.token;
  IF v_guard IS NULL THEN subscription_id := NULL; problem := 'no IssuanceGuard known for the token'; RETURN NEXT; END IF;
  FOR s IN SELECT * FROM offering.subscriptions x WHERE x.offering_id = p_offering AND x.state = 'allocation_pending' ORDER BY x.created_at, x.id LOOP
    v_total := v_total + s.units;
    subscription_id := s.id;
    IF NOT kyc.is_verified(s.wallet) THEN problem := 'investor no longer KYC-verified'; RETURN NEXT; END IF;
    IF NOT EXISTS (SELECT 1 FROM chain.investors i WHERE i.registry = v_registry AND i.wallet = s.wallet AND i.registered
                     AND i.country = offering.setting('allowed_country')::int) THEN
      problem := 'wallet not verified in the identity registry'; RETURN NEXT;
    END IF;
    IF EXISTS (SELECT 1 FROM chain.freezes f WHERE f.token = o.token AND f.holder = s.wallet AND f.address_frozen) THEN
      problem := 'wallet frozen'; RETURN NEXT;
    END IF;
    IF EXISTS (SELECT 1 FROM chain.issuances i WHERE i.ref_id = s.ref_id) THEN problem := 'refId already used on chain'; RETURN NEXT; END IF;
    SELECT coalesce(h.balance, 0) INTO v_bal FROM chain.holdings h WHERE h.token = o.token AND h.holder = s.wallet;
    IF coalesce(v_bal, 0) + s.units > o.max_holding_units THEN problem := 'MaxBalance would be exceeded'; RETURN NEXT; END IF;
    IF NOT EXISTS (SELECT 1 FROM ledger.journal j WHERE j.idempotency_key = 'sub:' || s.ref_id || ':paid')
       OR EXISTS (SELECT 1 FROM ledger.journal j WHERE j.idempotency_key = 'sub:' || s.ref_id || ':refunded') THEN
      problem := 'payment not booked or already refunded'; RETURN NEXT;
    END IF;
  END LOOP;
  IF v_cap IS NULL OR v_total > v_cap - v_supply THEN
    subscription_id := NULL; problem := format('trustee cap headroom %s below the %s units to mint', coalesce(v_cap - v_supply, 0), v_total); RETURN NEXT;
  END IF;
END $$;

CREATE FUNCTION offering.batch_digest(p_items jsonb) RETURNS bytea
LANGUAGE sql IMMUTABLE AS $$
  SELECT sha256(convert_to('pt-issuance-batch-v1' || p_items::text, 'UTF8'))
$$;

/** The current allocation set of an offering as batch items (ordered), and whether an approved batch matches it. */
CREATE FUNCTION offering.allocation_items(p_offering uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, offering AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_array(s.ref_id, s.wallet, s.units::text, s.id::text) ORDER BY s.ref_id), '[]'::jsonb)
  FROM offering.subscriptions s WHERE s.offering_id = p_offering AND s.state = 'allocation_pending'
$$;

CREATE FUNCTION offering.approved_batch(p_offering uuid) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, offering AS $$
  SELECT b.id FROM offering.issuance_batches b JOIN offering.requests r ON r.id = b.request_id
  WHERE b.offering_id = p_offering AND r.status = 'approved' ORDER BY b.id DESC LIMIT 1
$$;

-- ================================================================== API: terms (offering maker)
CREATE FUNCTION offering.set_terms(p_offering uuid, t jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, offering AS $$
DECLARE
  k text;
BEGIN
  IF t IS NULL OR jsonb_typeof(t) <> 'object' THEN PERFORM offering.fail('22023', 'terms must be an object'); END IF;
  FOR k IN SELECT jsonb_object_keys(t) LOOP
    IF k NOT IN ('pricePaisa', 'minRaiseUnits', 'targetUnits', 'hardCapUnits', 'minUnits', 'maxUnits', 'opensAt', 'closesAt', 'paymentGraceMinutes',
                 'reservationMinutes', 'completionDays', 'earlyClose', 'categories', 'useOfProceeds', 'docEnSha', 'docUrSha', 'riskSha') THEN
      PERFORM offering.fail('22023', format('unknown term %s', k));
    END IF;
  END LOOP;
  BEGIN
    UPDATE offering.offerings SET
      price_paisa = coalesce((t->>'pricePaisa')::bigint, price_paisa),
      min_raise_units = coalesce((t->>'minRaiseUnits')::bigint, min_raise_units),
      target_units = coalesce((t->>'targetUnits')::bigint, target_units),
      hard_cap_units = coalesce((t->>'hardCapUnits')::bigint, hard_cap_units),
      min_units = coalesce((t->>'minUnits')::bigint, min_units),
      max_units = coalesce((t->>'maxUnits')::bigint, max_units),
      opens_at = coalesce((t->>'opensAt')::timestamptz, opens_at),
      closes_at = coalesce((t->>'closesAt')::timestamptz, closes_at),
      payment_grace_minutes = coalesce((t->>'paymentGraceMinutes')::integer, payment_grace_minutes),
      reservation_minutes = coalesce((t->>'reservationMinutes')::integer, reservation_minutes),
      completion_days = coalesce((t->>'completionDays')::integer, completion_days),
      early_close = coalesce((t->>'earlyClose')::boolean, early_close),
      categories = CASE WHEN t ? 'categories' THEN ARRAY(SELECT jsonb_array_elements_text(t->'categories')) ELSE categories END,
      use_of_proceeds = coalesce(t->'useOfProceeds', use_of_proceeds),
      doc_en_sha = CASE WHEN t ? 'docEnSha' THEN offering.sha_of(t->>'docEnSha', 'docEnSha') ELSE doc_en_sha END,
      doc_ur_sha = CASE WHEN t ? 'docUrSha' THEN offering.sha_of(t->>'docUrSha', 'docUrSha') ELSE doc_ur_sha END,
      risk_sha = CASE WHEN t ? 'riskSha' THEN offering.sha_of(t->>'riskSha', 'riskSha') ELSE risk_sha END
    WHERE id = p_offering;
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR invalid_datetime_format OR datetime_field_overflow
            OR check_violation OR invalid_parameter_value OR cannot_coerce THEN
    PERFORM offering.fail('22023', 'invalid terms: ' || SQLERRM);
  END;
END $$;

/** Creates a draft offering for a Tokenization Ready property, with defaults from the settings. */
CREATE FUNCTION offering.create_offering(p_property uuid, p_actor text, p_previous uuid, p_terms jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, offering AS $$
DECLARE
  v_id uuid;
BEGIN
  PERFORM offering.need_duty(p_actor, ARRAY['offering'], 'create an offering');
  IF (SELECT state FROM property.properties WHERE id = p_property) IS DISTINCT FROM 'tokenization_ready' THEN
    PERFORM offering.fail('23514', 'the property must be Tokenization Ready (S-01)');
  END IF;
  IF p_previous IS NOT NULL AND (SELECT state FROM offering.offerings WHERE id = p_previous AND property_id = p_property) IS DISTINCT FROM 'cancelled' THEN
    PERFORM offering.fail('23514', 'a new offering may only follow a cancelled offering of the same property');
  END IF;
  IF EXISTS (SELECT 1 FROM offering.offerings WHERE property_id = p_property AND state <> 'cancelled') THEN
    PERFORM offering.fail('23505', 'the property already has an offering');
  END IF;
  INSERT INTO offering.offerings (property_id, previous_id, created_by, min_units, payment_grace_minutes, reservation_minutes, completion_days)
  VALUES (p_property, p_previous, p_actor, offering.setting('min_units_default')::bigint, offering.setting('payment_grace_minutes')::int,
          offering.setting('reservation_ttl_minutes')::int, offering.setting('completion_days')::int)
  RETURNING id INTO v_id;
  PERFORM offering.set_terms(v_id, coalesce(p_terms, '{}'::jsonb));
  PERFORM offering.audit_append(p_actor, 'offering.created', jsonb_build_object('ref', v_id, 'property', p_property, 'previous', p_previous,
                                                                               'terms', coalesce(p_terms, '{}'::jsonb)));
  RETURN v_id;
END $$;

CREATE FUNCTION offering.update_terms(p_offering uuid, p_actor text, p_terms jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, offering AS $$
BEGIN
  PERFORM offering.need_duty(p_actor, ARRAY['offering'], 'change offering terms');
  IF (SELECT state FROM offering.offerings WHERE id = p_offering FOR NO KEY UPDATE) IS DISTINCT FROM 'draft' THEN
    PERFORM offering.fail('23514', 'terms change only while the offering is a draft (OF-7)');
  END IF;
  PERFORM offering.set_terms(p_offering, p_terms);
  PERFORM offering.audit_append(p_actor, 'offering.terms_changed', jsonb_build_object('ref', p_offering, 'terms', p_terms));
END $$;

/** OF-1..OF-6, OF-10..OF-12: what is missing or wrong in the terms (NULL = complete). */
CREATE FUNCTION offering.terms_problem(p_offering uuid) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, offering AS $$
DECLARE
  o offering.offerings;
  v_planned numeric;
  v_max numeric;
  v_sum numeric;
  v_purchase numeric;
  v_bad integer;
  v_cap bigint;
BEGIN
  SELECT * INTO o FROM offering.offerings WHERE id = p_offering;
  IF o.price_paisa IS NULL OR o.min_raise_units IS NULL OR o.target_units IS NULL OR o.hard_cap_units IS NULL OR o.max_units IS NULL
     OR o.opens_at IS NULL OR o.closes_at IS NULL OR o.use_of_proceeds IS NULL OR o.doc_en_sha IS NULL OR o.doc_ur_sha IS NULL OR o.risk_sha IS NULL THEN
    RETURN 'terms incomplete: price, min raise, target, hard cap, max per investor, open and close times, use of proceeds and the three document hashes are required';
  END IF;
  IF NOT (o.min_raise_units <= o.target_units AND o.target_units <= o.hard_cap_units) THEN RETURN 'min raise <= target <= hard cap is required (OF-2)'; END IF;
  IF offering.setting('all_or_nothing') = 1 AND NOT (o.min_raise_units = o.hard_cap_units AND o.target_units = o.hard_cap_units) THEN
    RETURN 'the pilot is all-or-nothing: min raise = target = hard cap (Q-1)';
  END IF;
  IF o.min_units > o.max_units OR o.max_units > o.hard_cap_units THEN RETURN 'min per subscription <= max per investor <= hard cap is required (OF-4)'; END IF;
  IF o.closes_at < o.opens_at + make_interval(days => offering.setting('min_offer_days')::int) THEN
    RETURN format('the offering must be open at least %s days (OF-5)', offering.setting('min_offer_days'));
  END IF;
  IF o.closes_at <= now() THEN RETURN 'the close time has passed'; END IF;
  SELECT st.planned_units, st.max_holding_units INTO v_planned, v_max
  FROM property.structures st JOIN property.trustee_decisions td ON td.structure_id = st.id AND td.decision = 'accept'
  WHERE st.property_id = o.property_id ORDER BY td.id DESC LIMIT 1;
  IF v_planned IS NULL THEN RETURN 'no structure accepted by the trustee (S-01 P8)'; END IF;
  IF o.hard_cap_units > v_planned THEN RETURN 'hard cap above the planned register size (OF-2)'; END IF;
  IF o.max_units > v_max THEN RETURN 'max per investor above the MaxBalance limit (OF-4, OF-14)'; END IF;
  SELECT count(*) FILTER (WHERE jsonb_typeof(e) <> 'object' OR jsonb_typeof(e->'line') IS DISTINCT FROM 'string'
                            OR (e->>'line') !~ '^[a-z][a-z0-9_]{2,40}$' OR jsonb_typeof(e->'paisa') IS DISTINCT FROM 'string'
                            OR (e->>'paisa') !~ '^[0-9]{1,15}$'),
         sum(CASE WHEN (e->>'paisa') ~ '^[0-9]{1,15}$' THEN (e->>'paisa')::numeric END),
         sum(CASE WHEN e->>'line' = 'purchase_price' AND (e->>'paisa') ~ '^[0-9]{1,15}$' THEN (e->>'paisa')::numeric END)
    INTO v_bad, v_sum, v_purchase
  FROM jsonb_array_elements(o.use_of_proceeds) e;
  IF v_bad > 0 OR v_purchase IS NULL THEN RETURN 'use of proceeds: lines {line, paisa} including purchase_price are required (OF-3)'; END IF;
  IF v_sum <> o.hard_cap_units::numeric * o.price_paisa THEN RETURN 'use of proceeds must sum exactly to hard cap x price (OF-3)'; END IF;
  v_cap := property.offering_value_cap(o.property_id);
  IF v_cap IS NULL OR v_purchase > v_cap THEN RETURN 'purchase price above the lower accepted valuation, or valuations not valid (OF-3, OB-26)'; END IF;
  RETURN NULL;
END $$;

/** L1: submit the terms; opens the L3 approval request. */
CREATE FUNCTION offering.submit(p_offering uuid, p_actor text, p_reason text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, offering AS $$
DECLARE
  o offering.offerings;
  v_problem text;
  v_req bigint;
  st property.structures;
BEGIN
  PERFORM offering.need_duty(p_actor, ARRAY['offering'], 'submit an offering');
  PERFORM offering.check_reason(p_reason);
  SELECT * INTO o FROM offering.offerings WHERE id = p_offering FOR NO KEY UPDATE;
  IF NOT FOUND THEN PERFORM offering.fail('P0002', 'unknown offering'); END IF;
  IF o.state <> 'draft' THEN PERFORM offering.fail('23514', 'only a draft can be submitted'); END IF;
  IF (SELECT state FROM property.properties WHERE id = o.property_id) <> 'tokenization_ready' THEN
    PERFORM offering.fail('23514', 'the property must be Tokenization Ready (S-01)');
  END IF;
  v_problem := offering.terms_problem(p_offering);
  IF v_problem IS NOT NULL THEN PERFORM offering.fail('23514', v_problem); END IF;
  SELECT x.* INTO st FROM property.structures x JOIN property.trustee_decisions td ON td.structure_id = x.id AND td.decision = 'accept'
  WHERE x.property_id = o.property_id ORDER BY td.id DESC LIMIT 1;
  UPDATE offering.offerings SET structure_id = st.id, register_units = st.planned_units::bigint, max_holding_units = st.max_holding_units::bigint
  WHERE id = p_offering;
  PERFORM offering.move(p_offering, 'L1', 'pending_approval', p_actor, p_reason, NULL);
  INSERT INTO offering.requests (offering_id, code, offering_state, requested_by, reason, expires_at)
  VALUES (p_offering, 'L3', 'pending_approval', p_actor, p_reason, clock_timestamp() + make_interval(hours => offering.setting('request_expiry_hours')::int))
  RETURNING id INTO v_req;
  PERFORM offering.audit_append(p_actor, 'request.created', jsonb_build_object('request', v_req, 'ref', p_offering, 'code', 'L3', 'reason', p_reason));
  RETURN v_req;
END $$;

/** L2: the checker, legal head or compliance returns the terms to the maker. */
CREATE FUNCTION offering.return_offering(p_offering uuid, p_actor text, p_reason text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, offering AS $$
DECLARE
  r record;
BEGIN
  PERFORM offering.need_duty(p_actor, ARRAY['offering', 'legal_head', 'compliance'], 'return an offering');
  PERFORM offering.check_reason(p_reason);
  IF (SELECT state FROM offering.offerings WHERE id = p_offering FOR NO KEY UPDATE) IS DISTINCT FROM 'pending_approval' THEN
    PERFORM offering.fail('23514', 'only an offering pending approval can be returned');
  END IF;
  IF p_actor = (SELECT actor FROM offering.offering_events WHERE offering_id = p_offering AND code = 'L1' ORDER BY id DESC LIMIT 1) THEN
    PERFORM offering.fail('42501', 'the maker cannot return their own submission');
  END IF;
  FOR r IN SELECT id FROM offering.requests WHERE offering_id = p_offering AND status = 'open' LOOP
    UPDATE offering.requests SET status = 'stale', decided_at = clock_timestamp() WHERE id = r.id;
    PERFORM offering.audit_append(p_actor, 'request.stale', jsonb_build_object('request', r.id, 'ref', p_offering));
  END LOOP;
  PERFORM offering.move(p_offering, 'L2', 'draft', p_actor, p_reason, NULL);
  RETURN 'draft';
END $$;

/**
 * L4: the token is deployed (DeployLib, paused), the trustee cap is set and the offering document is
 * anchored. Checked against the indexer's read model, not taken from the caller.
 */
CREATE FUNCTION offering.mark_ready(p_offering uuid, p_token text, p_actor text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, offering AS $$
DECLARE
  o offering.offerings;
  t chain.tokens;
  v_token text := lower(p_token);
BEGIN
  PERFORM offering.need_duty(p_actor, ARRAY['offering'], 'record the deployment of the token');
  SELECT * INTO o FROM offering.offerings WHERE id = p_offering FOR NO KEY UPDATE;
  IF NOT FOUND THEN PERFORM offering.fail('P0002', 'unknown offering'); END IF;
  IF o.state <> 'approved' THEN PERFORM offering.fail('23514', 'only an approved offering can become ready'); END IF;
  IF v_token IS NULL OR length(v_token) <> 42 OR v_token !~ '^0x[0-9a-f]+$' THEN PERFORM offering.fail('22023', 'token must be an address'); END IF;
  SELECT * INTO t FROM chain.tokens WHERE token = v_token;
  IF NOT FOUND THEN PERFORM offering.fail('23514', 'the token is not in the read model (deploy through DeployLib and run the indexer)'); END IF;
  IF NOT t.paused THEN PERFORM offering.fail('23514', 'the token must be paused until the mint window (OF-30, contract-spec 9)'); END IF;
  IF t.total_supply <> 0 THEN PERFORM offering.fail('23514', 'the token must have no units yet'); END IF;
  IF t.trustee_cap < o.hard_cap_units THEN PERFORM offering.fail('23514', 'the trustee cap is below the hard cap (set it through the timelock first)'); END IF;
  IF offering.contract_of(v_token, 'issuance') IS NULL OR offering.contract_of(v_token, 'identityRegistry') IS NULL THEN
    PERFORM offering.fail('23514', 'the deployment has no IssuanceGuard or IdentityRegistry in the read model');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM chain.documents d WHERE d.token = v_token AND d.superseded_by IS NULL
                   AND lower(d.sha256_hash) IN ('0x' || encode(o.doc_en_sha, 'hex'), encode(o.doc_en_sha, 'hex')))
     OR NOT EXISTS (SELECT 1 FROM chain.documents d WHERE d.token = v_token AND d.superseded_by IS NULL
                   AND lower(d.sha256_hash) IN ('0x' || encode(o.doc_ur_sha, 'hex'), encode(o.doc_ur_sha, 'hex'))) THEN
    PERFORM offering.fail('23514', 'the offering documents (English and Urdu) are not anchored in the DocumentRegistry (OF-12)');
  END IF;
  UPDATE offering.offerings SET token = v_token WHERE id = p_offering;
  PERFORM offering.move(p_offering, 'L4', 'ready', p_actor, 'token ' || v_token || ' deployed, paused, cap set, documents anchored', NULL);
  RETURN 'ready';
END $$;

/** L6: compliance or the trustee suspends a live offering; unpaid reservations end and their codes are cancelled. */
CREATE FUNCTION offering.suspend(p_offering uuid, p_actor text, p_reason text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, offering AS $$
DECLARE
  v_n integer;
BEGIN
  PERFORM offering.need_duty(p_actor, ARRAY['compliance', 'trustee'], 'suspend an offering');
  PERFORM offering.check_reason(p_reason);
  IF (SELECT state FROM offering.offerings WHERE id = p_offering FOR NO KEY UPDATE) IS DISTINCT FROM 'live' THEN
    PERFORM offering.fail('23514', 'only a live offering can be suspended');
  END IF;
  v_n := offering.expire_internal(p_offering, p_actor, true);
  PERFORM offering.move(p_offering, 'L6', 'suspended', p_actor, p_reason, NULL);
  RETURN v_n;
END $$;

-- ================================================================== API: requests and decisions (OFR-2)
/** Checks the guard of a request at creation and again at approval (NULL = fine). */
CREATE FUNCTION offering.request_problem(p_offering uuid, p_code text, p_sub uuid, p_detail jsonb) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, offering AS $$
DECLARE
  o offering.offerings;
  s offering.subscriptions;
  v_items jsonb;
  b offering.issuance_batches;
  u record;
  v_n integer;
BEGIN
  SELECT * INTO o FROM offering.offerings WHERE id = p_offering;
  IF p_sub IS NOT NULL THEN
    SELECT * INTO s FROM offering.subscriptions WHERE id = p_sub AND offering_id = p_offering;
    IF NOT FOUND THEN RETURN 'unknown subscription'; END IF;
  END IF;
  CASE p_code
    WHEN 'L3' THEN
      IF o.state <> 'pending_approval' THEN RETURN 'offering is not pending approval'; END IF;
      RETURN offering.terms_problem(p_offering);
    WHEN 'L7', 'L8' THEN
      IF o.state <> 'suspended' THEN RETURN 'offering is not suspended'; END IF;
    WHEN 'L10' THEN
      IF o.extended_close_at IS NOT NULL THEN RETURN 'the one extension was already used (OF-20)'; END IF;
      IF o.state NOT IN ('live', 'closing') THEN RETURN 'only a live or closing offering can be extended'; END IF;
      IF jsonb_typeof(p_detail->'days') IS DISTINCT FROM 'number' OR (p_detail->>'days') !~ '^[1-9][0-9]?$'
         OR (p_detail->>'days')::int > offering.setting('extension_max_days') THEN
        RETURN format('detail.days must be 1-%s (OF-20)', offering.setting('extension_max_days'));
      END IF;
      IF jsonb_typeof(p_detail->'disclosureSha') IS DISTINCT FROM 'string' OR (p_detail->>'disclosureSha') !~ '^[0-9a-f]{64}$' THEN
        RETURN 'detail.disclosureSha (supplementary disclosure with the reason, OF-21) is required';
      END IF;
    WHEN 'L11', 'L12' THEN
      IF o.state <> 'closing' THEN RETURN 'offering is not closing'; END IF;
      SELECT * INTO u FROM offering.units(p_offering);
      IF p_code = 'L11' AND u.paid < o.min_raise_units THEN RETURN 'paid units below the min raise'; END IF;
      IF p_code = 'L12' AND u.paid >= o.min_raise_units THEN RETURN 'paid units reach the min raise'; END IF;
      IF u.paid > o.hard_cap_units THEN RETURN 'paid units above the hard cap'; END IF;
      IF EXISTS (SELECT 1 FROM offering.subscriptions WHERE offering_id = p_offering AND state = 'payment_pending') THEN
        RETURN 'unpaid reservations are still open';
      END IF;
    WHEN 'L13' THEN
      IF o.state <> 'funded' THEN RETURN 'offering is not funded'; END IF;
      IF jsonb_typeof(p_detail->'conditions') IS DISTINCT FROM 'object'
         OR NOT (p_detail->'conditions') ?& ARRAY['encumbrances_discharged', 'sale_deed_ready', 'approvals_consents', 'insurance', 'trust_deed_executed', 'register_ready']
         OR EXISTS (SELECT 1 FROM jsonb_each(p_detail->'conditions') c WHERE jsonb_typeof(c.value) IS DISTINCT FROM 'string' OR c.value #>> '{}' !~ '^[0-9a-f]{64}$') THEN
        RETURN 'detail.conditions must give a SHA-256 of the evidence for every condition precedent (OF-41)';
      END IF;
      IF offering.approved_batch(p_offering) IS NULL THEN RETURN 'no approved issuance batch (OF-46)'; END IF;
      SELECT * INTO b FROM offering.issuance_batches WHERE id = offering.approved_batch(p_offering);
      IF b.digest <> offering.batch_digest(offering.allocation_items(p_offering)) THEN
        RETURN 'the approved issuance batch no longer matches the allocations: prepare a new one';
      END IF;
      SELECT count(*) INTO v_n FROM offering.dry_run(p_offering);
      IF v_n > 0 THEN RETURN format('issuance dry run found %s problem(s) (OF-43)', v_n); END IF;
    WHEN 'IB' THEN
      IF o.state <> 'funded' THEN RETURN 'an issuance batch is prepared while the offering is funded'; END IF;
      v_items := offering.allocation_items(p_offering);
      IF jsonb_array_length(v_items) = 0 THEN RETURN 'no allocations to issue'; END IF;
      IF p_detail->>'digest' IS DISTINCT FROM encode(offering.batch_digest(v_items), 'hex') THEN
        RETURN 'the batch no longer matches the allocations';
      END IF;
    WHEN 'CMP' THEN
      IF o.state <> 'completing' THEN RETURN 'offering is not completing'; END IF;
      IF EXISTS (SELECT 1 FROM offering.completions WHERE offering_id = p_offering) THEN RETURN 'completion already recorded'; END IF;
      IF (p_detail->>'deedSha') !~ '^[0-9a-f]{64}$' OR (p_detail->>'batchFileSha') !~ '^[0-9a-f]{64}$'
         OR (p_detail->>'batchReference') !~ '^[A-Z0-9][A-Z0-9-]{3,63}$' OR length(p_detail->>'deedRegistration') NOT BETWEEN 3 AND 200
         OR p_detail->>'deedSha' IS NULL OR p_detail->>'batchFileSha' IS NULL OR p_detail->>'batchReference' IS NULL OR p_detail->>'deedRegistration' IS NULL THEN
        RETURN 'detail needs deedSha, deedRegistration, batchReference and batchFileSha (OF-45)';
      END IF;
    WHEN 'L14' THEN
      IF o.state <> 'completing' THEN RETURN 'offering is not completing'; END IF;
      IF o.mint_started_at IS NULL THEN RETURN 'minting has not started'; END IF;
      IF EXISTS (SELECT 1 FROM offering.issuance_items i JOIN offering.subscriptions x ON x.id = i.subscription_id
                 WHERE i.batch_id = offering.approved_batch(p_offering) AND x.state <> 'tokens_issued') THEN
        RETURN 'not every allocation is minted and settled (OF-47)';
      END IF;
      IF (p_detail->>'registerSha') !~ '^[0-9a-f]{64}$' OR (p_detail->>'totalUnits') !~ '^[1-9][0-9]{0,15}$'
         OR p_detail->>'registerSha' IS NULL OR p_detail->>'totalUnits' IS NULL THEN
        RETURN 'detail needs registerSha and totalUnits (OF-49)';
      END IF;
      IF (p_detail->>'totalUnits')::bigint <> (SELECT sum(i.units) FROM offering.issuance_items i WHERE i.batch_id = offering.approved_batch(p_offering)) THEN
        RETURN 'the trustee register total differs from the units issued (supply = register)';
      END IF;
    WHEN 'L15' THEN
      IF o.state <> 'funded' THEN RETURN 'offering is not funded'; END IF;
      IF o.completion_deadline > now() THEN RETURN 'the completion deadline has not passed (OF-42)'; END IF;
    WHEN 'L16' THEN
      IF o.state <> 'completing' THEN RETURN 'offering is not completing'; END IF;
      IF o.mint_started_at IS NOT NULL THEN RETURN 'minting has started: completion can no longer be aborted'; END IF;
    WHEN 'SD' THEN
      IF o.state <> 'live' THEN RETURN 'a supplementary disclosure is published while the offering is live'; END IF;
      IF (p_detail->>'disclosureSha') !~ '^[0-9a-f]{64}$' OR p_detail->>'disclosureSha' IS NULL THEN RETURN 'detail.disclosureSha is required'; END IF;
    WHEN 'V17' THEN
      IF o.state <> 'completing' OR o.mint_started_at IS NULL THEN RETURN 'a mint retry needs an offering that is minting'; END IF;
      IF s.state <> 'issuance_review' THEN RETURN 'subscription is not in issuance review'; END IF;
      IF EXISTS (SELECT 1 FROM chain.issuances i WHERE i.ref_id = s.ref_id) THEN RETURN 'the refId is used on chain: settle against that event instead'; END IF;
      IF EXISTS (SELECT 1 FROM offering.mint_commands m JOIN outbox.commands c ON c.id = m.command_id
                 WHERE m.subscription_id = s.id AND c.status <> 'failed') THEN
        RETURN 'a mint command for this refId is not failed (it could still be mined, M-6)';
      END IF;
      IF NOT kyc.is_verified(s.wallet) THEN RETURN 'investor is not KYC-verified'; END IF;
    WHEN 'V20' THEN
      IF s.state <> 'refund_pending' THEN RETURN 'subscription is not refund pending'; END IF;
    ELSE
      RETURN 'unknown request code';
  END CASE;
  RETURN NULL;
END $$;

/** Opens a maker-checker request (L7, L8, L10, L13, L14, L16, IB via prepare_batch, CMP, SD, V17). */
CREATE FUNCTION offering.request(p_offering uuid, p_code text, p_actor text, p_reason text, p_detail jsonb, p_sub uuid) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, offering AS $$
DECLARE
  rr offering.request_rules;
  o offering.offerings;
  v_problem text;
  v_req bigint;
BEGIN
  PERFORM offering.check_actor(p_actor);
  PERFORM offering.check_reason(p_reason);
  SELECT * INTO rr FROM offering.request_rules WHERE code = p_code;
  IF NOT FOUND OR rr.maker_duties IS NULL THEN PERFORM offering.fail('22023', format('requests of kind %s are not made by officers', p_code)); END IF;
  PERFORM offering.need_duty(p_actor, rr.maker_duties, 'request ' || p_code);
  IF rr.per_subscription <> (p_sub IS NOT NULL) THEN PERFORM offering.fail('22023', format('request %s %s a subscription', p_code, CASE WHEN rr.per_subscription THEN 'needs' ELSE 'takes no' END)); END IF;
  SELECT * INTO o FROM offering.offerings WHERE id = p_offering FOR NO KEY UPDATE;
  IF NOT FOUND THEN PERFORM offering.fail('P0002', 'unknown offering'); END IF;
  IF p_code = 'L10' AND clock_timestamp() >= offering.close_time(o) THEN
    PERFORM offering.fail('23514', 'an extension must be requested before the close time (OF-20)');
  END IF;
  v_problem := offering.request_problem(p_offering, p_code, p_sub, coalesce(p_detail, '{}'::jsonb));
  IF v_problem IS NOT NULL THEN PERFORM offering.fail('23514', v_problem); END IF;
  IF EXISTS (SELECT 1 FROM offering.requests WHERE offering_id = p_offering AND code = p_code AND status = 'open'
             AND subscription_id IS NOT DISTINCT FROM p_sub) THEN
    PERFORM offering.fail('23505', format('a %s request is already open', p_code));
  END IF;
  INSERT INTO offering.requests (offering_id, subscription_id, code, offering_state, requested_by, reason, detail, expires_at)
  VALUES (p_offering, p_sub, p_code, o.state, p_actor, p_reason, coalesce(p_detail, '{}'::jsonb),
          CASE WHEN rr.expires THEN clock_timestamp() + make_interval(hours => offering.setting('request_expiry_hours')::int) END)
  RETURNING id INTO v_req;
  PERFORM offering.audit_append(p_actor, 'request.created', jsonb_build_object('request', v_req, 'ref', p_offering, 'code', p_code,
                                                                              'subscription', p_sub, 'detail', coalesce(p_detail, '{}'::jsonb), 'reason', p_reason));
  RETURN v_req;
END $$;

/** System-made requests (L11, L12, L15): proposed by the jobs, confirmed by the trustee. */
CREATE FUNCTION offering.system_request(p_offering uuid, p_code text, p_actor text, p_reason text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, offering AS $$
DECLARE
  v_req bigint;
BEGIN
  SELECT id INTO v_req FROM offering.requests WHERE offering_id = p_offering AND code = p_code AND status = 'open';
  IF FOUND THEN RETURN v_req; END IF;
  IF offering.request_problem(p_offering, p_code, NULL, '{}'::jsonb) IS NOT NULL THEN RETURN NULL; END IF;
  INSERT INTO offering.requests (offering_id, code, offering_state, requested_by, reason)
  VALUES (p_offering, p_code, (SELECT state FROM offering.offerings WHERE id = p_offering), p_actor, p_reason)
  RETURNING id INTO v_req;
  PERFORM offering.audit_append(p_actor, 'request.created', jsonb_build_object('request', v_req, 'ref', p_offering, 'code', p_code, 'reason', p_reason));
  RETURN v_req;
END $$;

/** Enqueues one mint command (attempt n) for an allocation, in the caller's transaction (OFR-5). */
CREATE FUNCTION offering.enqueue_mint(p_sub uuid, p_attempt integer, p_actor text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, offering AS $$
DECLARE
  s offering.subscriptions;
  o offering.offerings;
  v_key text;
  v_cmd bigint;
BEGIN
  SELECT * INTO s FROM offering.subscriptions WHERE id = p_sub FOR NO KEY UPDATE;
  SELECT * INTO o FROM offering.offerings WHERE id = s.offering_id;
  -- Mint only for a booked, unrefunded payment (I-11, M-6).
  IF NOT EXISTS (SELECT 1 FROM ledger.journal j WHERE j.idempotency_key = 'sub:' || s.ref_id || ':paid' AND j.id = s.paid_journal)
     OR EXISTS (SELECT 1 FROM ledger.journal j WHERE j.idempotency_key = 'sub:' || s.ref_id || ':refunded') THEN
    RAISE EXCEPTION 'subscription % has no booked, unrefunded payment', p_sub USING ERRCODE = 'check_violation';
  END IF;
  v_key := CASE WHEN p_attempt = 1 THEN 'mint:' || s.ref_id ELSE format('mint:%s:retry:%s', s.ref_id, p_attempt) END;
  v_cmd := outbox.enqueue(v_key, 'issuance.mint',
                          jsonb_build_object('issuance', offering.contract_of(o.token, 'issuance'), 'to', s.wallet, 'amount', s.units::text, 'refId', s.ref_id),
                          'offering:' || o.id, p_actor, 5);
  INSERT INTO offering.mint_commands (subscription_id, attempt, outbox_key, command_id, enqueued_by) VALUES (p_sub, p_attempt, v_key, v_cmd, p_actor)
  ON CONFLICT DO NOTHING;
  PERFORM offering.audit_append(p_actor, 'subscription.mint_enqueued', jsonb_build_object('ref', p_sub, 'attempt', p_attempt, 'command', v_cmd, 'key', v_key));
  RETURN v_cmd;
END $$;

/** Applies an approved request (re-checks its guard; raises if it no longer holds). */
CREATE FUNCTION offering.apply_request(p_req bigint, p_actor text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, offering AS $$
DECLARE
  q offering.requests;
  o offering.offerings;
  v_problem text;
  r record;
  v_attempt integer;
BEGIN
  SELECT * INTO q FROM offering.requests WHERE id = p_req;
  SELECT * INTO o FROM offering.offerings WHERE id = q.offering_id FOR NO KEY UPDATE;
  v_problem := offering.request_problem(q.offering_id, q.code, q.subscription_id, q.detail);
  IF v_problem IS NOT NULL THEN PERFORM offering.fail('23514', v_problem); END IF;
  CASE q.code
    WHEN 'L3' THEN PERFORM offering.move(o.id, 'L3', 'approved', p_actor, q.reason, p_req);
    WHEN 'L7' THEN PERFORM offering.move(o.id, 'L7', 'live', p_actor, q.reason, p_req);
    WHEN 'L8' THEN
      PERFORM offering.move(o.id, 'L8', 'failed', p_actor, q.reason, p_req);
      UPDATE offering.offerings SET failed_at = clock_timestamp() WHERE id = o.id;
      PERFORM offering.start_refunds(o.id, p_actor);
    WHEN 'L10' THEN
      UPDATE offering.offerings SET extended_close_at = offering.close_time(o) + make_interval(days => (q.detail->>'days')::int),
             withdrawal_until = greatest(coalesce(withdrawal_until, '-infinity'), clock_timestamp() + make_interval(days => offering.setting('withdrawal_days')::int))
      WHERE id = o.id;
      IF o.state = 'closing' THEN
        PERFORM offering.move(o.id, 'L10', 'live', p_actor, q.reason, p_req);
      ELSE
        PERFORM offering.audit_append(p_actor, 'offering.extended', jsonb_build_object('ref', o.id, 'request', p_req, 'days', q.detail->'days'));
      END IF;
    WHEN 'L11' THEN
      PERFORM offering.move(o.id, 'L11', 'funded', p_actor, q.reason, p_req);
      UPDATE offering.offerings SET funded_at = clock_timestamp(), completion_deadline = clock_timestamp() + make_interval(days => o.completion_days) WHERE id = o.id;
      FOR r IN SELECT id FROM offering.subscriptions WHERE offering_id = o.id AND state = 'payment_confirmed' ORDER BY created_at, id LOOP
        PERFORM offering.sub_move(r.id, 'V12', 'allocation_pending', p_actor, 'offering funded', p_req);
      END LOOP;
    WHEN 'L12', 'L15', 'L16' THEN
      PERFORM offering.move(o.id, q.code, 'failed', p_actor, q.reason, p_req);
      UPDATE offering.offerings SET failed_at = clock_timestamp() WHERE id = o.id;
      PERFORM offering.start_refunds(o.id, p_actor);
    WHEN 'L13' THEN
      INSERT INTO offering.conditions_precedent (offering_id, conditions, request_id) VALUES (o.id, q.detail->'conditions', p_req);
      PERFORM offering.move(o.id, 'L13', 'completing', p_actor, q.reason, p_req);
      UPDATE offering.offerings SET completing_at = clock_timestamp() WHERE id = o.id;
    WHEN 'IB' THEN
      PERFORM offering.audit_append(p_actor, 'batch.approved', jsonb_build_object('ref', o.id, 'request', p_req, 'digest', q.detail->>'digest'));
    WHEN 'CMP' THEN
      INSERT INTO offering.completions (offering_id, deed_sha, deed_registration, batch_reference, batch_file_sha, request_id)
      VALUES (o.id, decode(q.detail->>'deedSha', 'hex'), q.detail->>'deedRegistration', q.detail->>'batchReference', decode(q.detail->>'batchFileSha', 'hex'), p_req);
      PERFORM offering.audit_append(p_actor, 'offering.completion_recorded', jsonb_build_object('ref', o.id, 'request', p_req, 'detail', q.detail));
    WHEN 'L14' THEN
      INSERT INTO offering.register_attestations (offering_id, total_units, register_sha, request_id)
      VALUES (o.id, (q.detail->>'totalUnits')::bigint, decode(q.detail->>'registerSha', 'hex'), p_req);
      FOR r IN SELECT x.id FROM offering.subscriptions x WHERE x.offering_id = o.id AND x.state = 'tokens_issued' ORDER BY x.created_at, x.id LOOP
        PERFORM offering.sub_move(r.id, 'V18', 'active', p_actor, 'trustee register entry confirmed', p_req);
      END LOOP;
      PERFORM offering.move(o.id, 'L14', 'completed', p_actor, q.reason, p_req);
      UPDATE offering.offerings SET completed_at = clock_timestamp() WHERE id = o.id;
    WHEN 'SD' THEN
      UPDATE offering.offerings SET withdrawal_until = greatest(coalesce(withdrawal_until, '-infinity'), clock_timestamp() + make_interval(days => offering.setting('withdrawal_days')::int))
      WHERE id = o.id;
      PERFORM offering.audit_append(p_actor, 'offering.disclosure_published', jsonb_build_object('ref', o.id, 'request', p_req, 'sha', q.detail->>'disclosureSha'));
    WHEN 'V17' THEN
      SELECT coalesce(max(attempt), 0) + 1 INTO v_attempt FROM offering.mint_commands WHERE subscription_id = q.subscription_id;
      PERFORM offering.enqueue_mint(q.subscription_id, v_attempt, p_actor);
    WHEN 'V20' THEN
      PERFORM offering.audit_append(p_actor, 'refund.approved', jsonb_build_object('ref', q.subscription_id, 'request', p_req));
  END CASE;
END $$;

/**
 * A vote on a request by an officer holding one of its still-missing duties. The requester never
 * votes; one rejection is final; the last needed approval applies the request (whose guard is
 * re-checked). Returns open | approved | rejected | expired | stale.
 */
CREATE FUNCTION offering.decide(p_req bigint, p_officer text, p_approve boolean, p_reason text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, offering AS $$
DECLARE
  q offering.requests;
  rr offering.request_rules;
  o offering.offerings;
  v_duty text;
  d text;
  v_needed integer;
  v_have integer;
  v_done boolean := true;
BEGIN
  PERFORM offering.check_actor(p_officer);
  PERFORM offering.check_reason(p_reason);
  SELECT * INTO q FROM offering.requests WHERE id = p_req FOR NO KEY UPDATE;
  IF NOT FOUND THEN PERFORM offering.fail('P0002', 'unknown request'); END IF;
  SELECT * INTO rr FROM offering.request_rules WHERE code = q.code;
  SELECT * INTO o FROM offering.offerings WHERE id = q.offering_id FOR NO KEY UPDATE;
  IF q.status <> 'open' THEN PERFORM offering.fail('23514', format('request %s is %s', p_req, q.status)); END IF;
  IF rr.expires AND q.expires_at < clock_timestamp() THEN
    UPDATE offering.requests SET status = 'expired', decided_at = clock_timestamp() WHERE id = p_req;
    PERFORM offering.audit_append(p_officer, 'request.expired', jsonb_build_object('request', p_req, 'ref', q.offering_id));
    RETURN 'expired';
  END IF;
  IF rr.stale_on_state AND o.state <> q.offering_state THEN
    UPDATE offering.requests SET status = 'stale', decided_at = clock_timestamp() WHERE id = p_req;
    PERFORM offering.audit_append(p_officer, 'request.stale', jsonb_build_object('request', p_req, 'ref', q.offering_id));
    RETURN 'stale';
  END IF;
  IF p_officer = q.requested_by THEN PERFORM offering.fail('42501', 'the requester never approves their own request (maker-checker)'); END IF;
  IF EXISTS (SELECT 1 FROM offering.request_votes WHERE request_id = p_req AND officer = p_officer) THEN
    PERFORM offering.fail('42501', 'each officer votes once on a request');
  END IF;
  -- OF-SOD-1: nobody who took part in the property's S-01 file approves its offering terms.
  IF q.code = 'L3' AND p_officer = ANY (coalesce(property.parties(o.property_id), ARRAY[]::text[])) THEN
    PERFORM offering.fail('42501', 'a party to the property''s S-01 file cannot approve its offering (OF-SOD-1)');
  END IF;
  -- OF-SOD-2: whoever prepared an issuance batch never approves a mint of it.
  IF q.code IN ('L13', 'V17') AND p_officer IN (SELECT b.prepared_by FROM offering.issuance_batches b WHERE b.offering_id = q.offering_id) THEN
    PERFORM offering.fail('42501', 'the preparer of the issuance batch cannot approve its minting (OF-SOD-2)');
  END IF;
  -- The first needed duty the officer holds that still lacks an approval.
  FOR d IN SELECT DISTINCT unnest(rr.needs) LOOP
    IF v_duty IS NULL AND offering.has_duty(p_officer, d) THEN
      SELECT count(*) INTO v_needed FROM unnest(rr.needs) x WHERE x = d;
      SELECT count(*) INTO v_have FROM offering.request_votes WHERE request_id = p_req AND duty = d AND approve;
      IF v_have < v_needed THEN v_duty := d; END IF;
    END IF;
  END LOOP;
  IF v_duty IS NULL THEN
    PERFORM offering.fail('42501', format('%s holds none of the duties still needed for %s (%s)', p_officer, q.code, array_to_string(rr.needs, ', ')));
  END IF;
  INSERT INTO offering.request_votes (request_id, officer, duty, approve, reason) VALUES (p_req, p_officer, v_duty, p_approve, p_reason);
  PERFORM offering.audit_append(p_officer, CASE WHEN p_approve THEN 'request.approval' ELSE 'request.rejection' END,
                                jsonb_build_object('request', p_req, 'ref', q.offering_id, 'duty', v_duty, 'reason', p_reason));
  IF NOT p_approve THEN
    UPDATE offering.requests SET status = 'rejected', decided_at = clock_timestamp() WHERE id = p_req;
    RETURN 'rejected';
  END IF;
  FOR d IN SELECT DISTINCT unnest(rr.needs) LOOP
    SELECT count(*) INTO v_needed FROM unnest(rr.needs) x WHERE x = d;
    SELECT count(*) INTO v_have FROM offering.request_votes WHERE request_id = p_req AND duty = d AND approve;
    IF v_have < v_needed THEN v_done := false; END IF;
  END LOOP;
  IF NOT v_done THEN RETURN 'open'; END IF;
  UPDATE offering.requests SET status = 'approved', decided_at = clock_timestamp() WHERE id = p_req;
  PERFORM offering.audit_append(p_officer, 'request.approved', jsonb_build_object('request', p_req, 'ref', q.offering_id, 'code', q.code));
  PERFORM offering.apply_request(p_req, p_officer);
  RETURN 'approved';
END $$;

/** Votes on every open request of one kind for an offering (e.g. all refunds of a failed offering). */
CREATE FUNCTION offering.decide_all(p_offering uuid, p_code text, p_officer text, p_approve boolean, p_reason text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, offering AS $$
DECLARE
  r record;
  v_n integer := 0;
BEGIN
  FOR r IN SELECT id FROM offering.requests WHERE offering_id = p_offering AND code = p_code AND status = 'open'
           AND id NOT IN (SELECT request_id FROM offering.request_votes WHERE officer = p_officer) ORDER BY id LOOP
    PERFORM offering.decide(r.id, p_officer, p_approve, p_reason);
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END $$;

/** OF-46: the offering maker prepares the issuance batch from the allocations; checker and trustee approve. */
CREATE FUNCTION offering.prepare_batch(p_offering uuid, p_actor text, p_reason text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, offering AS $$
DECLARE
  v_items jsonb;
  v_req bigint;
  v_batch bigint;
BEGIN
  PERFORM offering.need_duty(p_actor, ARRAY['offering'], 'prepare an issuance batch');
  PERFORM offering.check_reason(p_reason);
  PERFORM 1 FROM offering.offerings WHERE id = p_offering FOR NO KEY UPDATE;
  v_items := offering.allocation_items(p_offering);
  UPDATE offering.requests SET status = 'stale', decided_at = clock_timestamp() WHERE offering_id = p_offering AND code = 'IB' AND status = 'open';
  v_req := offering.request(p_offering, 'IB', p_actor, p_reason, jsonb_build_object('digest', encode(offering.batch_digest(v_items), 'hex')), NULL);
  INSERT INTO offering.issuance_batches (offering_id, digest, item_count, total_units, prepared_by, request_id)
  VALUES (p_offering, offering.batch_digest(v_items), jsonb_array_length(v_items),
          (SELECT sum((x->>2)::bigint) FROM jsonb_array_elements(v_items) x), p_actor, v_req)
  RETURNING id INTO v_batch;
  INSERT INTO offering.issuance_items (batch_id, line_no, subscription_id, ref_id, wallet, units)
  SELECT v_batch, ord, (x->>3)::uuid, x->>0, x->>1, (x->>2)::bigint FROM jsonb_array_elements(v_items) WITH ORDINALITY AS t(x, ord);
  PERFORM offering.audit_append(p_actor, 'batch.prepared', jsonb_build_object('ref', p_offering, 'batch', v_batch, 'request', v_req,
                                                                             'digest', encode(offering.batch_digest(v_items), 'hex'), 'items', jsonb_array_length(v_items)));
  RETURN v_batch;
END $$;

-- ================================================================== API: investors (pt_offering_service)
/** OF-10: the investor accepts the exact document version (append-only acceptance record). */
CREATE FUNCTION offering.accept_document(p_offering uuid, p_subject uuid, p_kind text, p_language text, p_sha text, p_session text, p_device text, p_actor text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, offering AS $$
DECLARE
  o offering.offerings;
  v_sha bytea := offering.sha_of(p_sha, 'document hash');
  v_id bigint;
BEGIN
  PERFORM offering.check_actor(p_actor);
  SELECT * INTO o FROM offering.offerings WHERE id = p_offering;
  IF NOT FOUND THEN PERFORM offering.fail('P0002', 'unknown offering'); END IF;
  IF o.state NOT IN ('ready', 'live') THEN PERFORM offering.fail('23514', 'documents are accepted for a ready or live offering'); END IF;
  IF NOT EXISTS (SELECT 1 FROM kyc.subjects WHERE id = p_subject) THEN PERFORM offering.fail('P0002', 'unknown investor'); END IF;
  IF p_language NOT IN ('en', 'ur') OR p_kind NOT IN ('offering_document', 'risk_disclosure') THEN
    PERFORM offering.fail('22023', 'kind offering_document | risk_disclosure and language en | ur are required');
  END IF;
  IF (p_kind = 'offering_document' AND v_sha IS DISTINCT FROM CASE p_language WHEN 'en' THEN o.doc_en_sha ELSE o.doc_ur_sha END)
     OR (p_kind = 'risk_disclosure' AND v_sha IS DISTINCT FROM o.risk_sha) THEN
    PERFORM offering.fail('23514', 'this is not the approved version of the document (OF-10)');
  END IF;
  INSERT INTO offering.acceptances (offering_id, subject_id, kind, language, doc_sha, session_hash, device_hash, actor)
  VALUES (p_offering, p_subject, p_kind, p_language, v_sha, offering.sha_of(p_session, 'session hash'), offering.sha_of(p_device, 'device hash'), p_actor)
  RETURNING id INTO v_id;
  PERFORM offering.audit_append(p_actor, 'document.accepted', jsonb_build_object('acceptance', v_id, 'ref', p_offering, 'subject', p_subject,
                                                                                'kind', p_kind, 'language', p_language, 'sha', p_sha));
  RETURN v_id;
END $$;

CREATE FUNCTION offering.sub_json(p_sub uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, offering AS $$
  SELECT jsonb_build_object('subscriptionId', s.id, 'refId', s.ref_id, 'state', s.state, 'units', s.units::text, 'amountPaisa', s.amount_paisa::text,
                            'paymentCode', s.intent_code, 'expiresAt', offering.utc(s.expires_at), 'reason', s.public_reason)
  FROM offering.subscriptions s WHERE s.id = p_sub
$$;

/**
 * V1-V4: an investor asks for units. Idempotent per (offering, investor, idempotency key) (OF-17).
 * Returns the subscription with its state, and for a reservation the payment code, amount and expiry.
 */
CREATE FUNCTION offering.reserve(p_offering uuid, p_sub uuid, p_ref_id text, p_subject uuid, p_units bigint, p_category text, p_idempotency text, p_actor text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, offering AS $$
DECLARE
  o offering.offerings;
  s offering.subscriptions;
BEGIN
  PERFORM offering.check_actor(p_actor);
  IF p_sub IS NULL OR p_subject IS NULL OR p_units IS NULL OR p_category IS NULL OR p_idempotency IS NULL
     OR p_ref_id IS NULL OR length(p_ref_id) <> 66 OR p_ref_id !~ '^0x[0-9a-f]+$' THEN
    PERFORM offering.fail('22023', 'subscription id, refId, investor, units, category and an idempotency key are required');
  END IF;
  SELECT * INTO o FROM offering.offerings WHERE id = p_offering FOR NO KEY UPDATE;
  IF NOT FOUND THEN PERFORM offering.fail('P0002', 'unknown offering'); END IF;
  SELECT * INTO s FROM offering.subscriptions WHERE offering_id = p_offering AND subject_id = p_subject AND idempotency_key = p_idempotency;
  IF FOUND THEN
    IF s.units = p_units AND s.category = p_category THEN RETURN offering.sub_json(s.id); END IF;
    PERFORM offering.fail('23505', 'idempotency key already used for a different request');
  END IF;
  IF o.state <> 'live' OR clock_timestamp() >= offering.close_time(o) THEN PERFORM offering.fail('23514', 'the offering is not open for subscriptions'); END IF;
  IF p_units < o.min_units OR p_units > o.max_units THEN
    PERFORM offering.fail('22023', format('units must be between %s and %s (OF-4)', o.min_units, o.max_units));
  END IF;
  IF (SELECT state FROM property.properties WHERE id = o.property_id) <> 'tokenization_ready' THEN
    PERFORM offering.fail('23514', 'the property is under review again: subscriptions are paused');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM offering.acceptances WHERE offering_id = p_offering AND subject_id = p_subject AND kind = 'offering_document')
     OR NOT EXISTS (SELECT 1 FROM offering.acceptances WHERE offering_id = p_offering AND subject_id = p_subject AND kind = 'risk_disclosure') THEN
    PERFORM offering.fail('23514', 'accept the offering document and the risk disclosure first (OF-10)');
  END IF;
  IF EXISTS (SELECT 1 FROM offering.subscriptions WHERE offering_id = p_offering AND subject_id = p_subject
             AND state IN ('initiated', 'kyc_pending', 'waitlisted', 'payment_pending')) THEN
    PERFORM offering.fail('23505', 'the investor already has an open reservation in this offering (OF-17)');
  END IF;
  INSERT INTO offering.subscriptions (id, offering_id, subject_id, ref_id, units, amount_paisa, category, idempotency_key, created_by)
  VALUES (p_sub, p_offering, p_subject, p_ref_id, p_units, p_units * o.price_paisa, p_category, p_idempotency, p_actor);
  PERFORM offering.audit_append(p_actor, 'subscription.initiated', jsonb_build_object('ref', p_sub, 'offering', p_offering, 'subject', p_subject,
                                                                                     'refId', p_ref_id, 'units', p_units::text, 'amount', (p_units * o.price_paisa)::text));
  PERFORM offering.place(p_sub, 'new', p_actor);
  RETURN offering.sub_json(p_sub);
END $$;

/** V5/V6: re-checks a subscription waiting for KYC. */
CREATE FUNCTION offering.recheck(p_sub uuid, p_actor text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, offering AS $$
DECLARE
  s offering.subscriptions;
BEGIN
  PERFORM offering.check_actor(p_actor);
  SELECT * INTO s FROM offering.subscriptions WHERE id = p_sub;
  IF NOT FOUND THEN PERFORM offering.fail('P0002', 'unknown subscription'); END IF;
  PERFORM 1 FROM offering.offerings WHERE id = s.offering_id FOR NO KEY UPDATE;
  IF (SELECT state FROM offering.offerings WHERE id = s.offering_id) <> 'live' THEN PERFORM offering.fail('23514', 'the offering is not live'); END IF;
  IF (SELECT state FROM offering.subscriptions WHERE id = p_sub) = 'kyc_pending' THEN
    PERFORM offering.place(p_sub, 'kyc', p_actor);
  END IF;
  RETURN offering.sub_json(p_sub);
END $$;

/** V11: the investor cancels before paying; the payment code is cancelled with the reservation; freed units go to the waitlist. */
CREATE FUNCTION offering.cancel(p_sub uuid, p_subject uuid, p_actor text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, offering AS $$
DECLARE
  s offering.subscriptions;
BEGIN
  PERFORM offering.check_actor(p_actor);
  SELECT * INTO s FROM offering.subscriptions WHERE id = p_sub;
  IF NOT FOUND OR s.subject_id IS DISTINCT FROM p_subject THEN PERFORM offering.fail('P0002', 'unknown subscription'); END IF;
  PERFORM 1 FROM offering.offerings WHERE id = s.offering_id FOR NO KEY UPDATE;
  IF s.intent_code IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(586586098, hashtext(s.intent_code));
  END IF;
  SELECT * INTO s FROM offering.subscriptions WHERE id = p_sub FOR NO KEY UPDATE;
  IF s.state NOT IN ('payment_pending', 'kyc_pending', 'waitlisted') THEN
    PERFORM offering.fail('23514', format('a %s subscription cannot be cancelled (paid subscriptions are withdrawn, OF-22)', s.state));
  END IF;
  IF s.state = 'payment_pending' THEN
    -- Refuses if the code was paid in the meantime (the payment wins).
    PERFORM bank.cancel_intent(s.intent_code, p_actor, 'reservation cancelled by the investor (V11)');
  END IF;
  PERFORM offering.sub_move(p_sub, 'V11', 'cancelled', p_actor, 'cancelled by the investor', NULL);
  PERFORM offering.promote_internal(s.offering_id, p_actor);
  RETURN offering.sub_json(p_sub);
END $$;

/** V13 (OF-22/OF-23): a paid investor withdraws within the withdrawal window; a refund request is opened. */
CREATE FUNCTION offering.withdraw(p_sub uuid, p_subject uuid, p_actor text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, offering AS $$
DECLARE
  s offering.subscriptions;
  o offering.offerings;
BEGIN
  PERFORM offering.check_actor(p_actor);
  SELECT * INTO s FROM offering.subscriptions WHERE id = p_sub FOR NO KEY UPDATE;
  IF NOT FOUND OR s.subject_id IS DISTINCT FROM p_subject THEN PERFORM offering.fail('P0002', 'unknown subscription'); END IF;
  SELECT * INTO o FROM offering.offerings WHERE id = s.offering_id FOR NO KEY UPDATE;
  IF s.state <> 'payment_confirmed' THEN PERFORM offering.fail('23514', 'only a paid, not yet allocated subscription can be withdrawn'); END IF;
  IF o.withdrawal_until IS NULL OR o.withdrawal_until < clock_timestamp() OR o.state NOT IN ('live', 'closing') THEN
    PERFORM offering.fail('23514', 'no withdrawal right is open (only after an extension or a supplementary disclosure, OF-22/OF-23)');
  END IF;
  PERFORM offering.sub_move(p_sub, 'V13', 'refund_pending', p_actor, 'withdrawn within the withdrawal window', NULL);
  PERFORM offering.open_refund(p_sub, 'withdrawal', p_actor, 'investor withdrew within the withdrawal window (OF-22)');
  RETURN offering.sub_json(p_sub);
END $$;

-- ================================================================== API: system jobs (pt_offering_service)
/**
 * The offering's clock: opens (L5), expires reservations (V10) and promotes the waitlist, closes
 * (L9) and expires what is left, proposes the outcome (L11/L12) or the missed deadline (L15) to the
 * trustee, and ends refunding (L18). Idempotent; run by a scheduler. Returns what it did.
 */
CREATE FUNCTION offering.tick(p_offering uuid, p_actor text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, offering AS $$
DECLARE
  o offering.offerings;
  u record;
  v_out jsonb := '{}'::jsonb;
  v_n integer;
  v_ext offering.requests;
  r record;
  v_problem text;
BEGIN
  PERFORM offering.check_actor(p_actor);
  SELECT * INTO o FROM offering.offerings WHERE id = p_offering FOR NO KEY UPDATE;
  IF NOT FOUND THEN PERFORM offering.fail('P0002', 'unknown offering'); END IF;

  IF o.state = 'ready' AND clock_timestamp() >= o.opens_at THEN
    v_problem := CASE
      WHEN (SELECT state FROM property.properties WHERE id = o.property_id) <> 'tokenization_ready' THEN 'property is not Tokenization Ready'
      WHEN property.sponsor_state((SELECT sponsor_id FROM property.properties WHERE id = o.property_id)) <> 'kyb_approved' THEN 'sponsor KYB is not valid'
      WHEN property.offering_value_cap(o.property_id) IS NULL THEN 'valuations are no longer valid'
    END;
    IF v_problem IS NULL THEN
      PERFORM offering.move(o.id, 'L5', 'live', p_actor, 'open time reached', NULL);
      v_out := v_out || jsonb_build_object('opened', true);
    ELSE
      v_out := v_out || jsonb_build_object('openBlocked', v_problem);
    END IF;
    SELECT * INTO o FROM offering.offerings WHERE id = p_offering;
  END IF;

  IF o.state = 'live' THEN
    v_n := offering.expire_internal(o.id, p_actor, false);
    v_out := v_out || jsonb_build_object('expired', v_n, 'promoted', offering.promote_internal(o.id, p_actor));
    SELECT * INTO u FROM offering.units(o.id);
    IF clock_timestamp() >= offering.close_time(o) + make_interval(mins => o.payment_grace_minutes)
       OR (o.early_close AND u.paid >= o.hard_cap_units) THEN
      PERFORM offering.expire_internal(o.id, p_actor, true);
      FOR r IN SELECT id FROM offering.subscriptions WHERE offering_id = o.id AND state IN ('kyc_pending', 'waitlisted') ORDER BY created_at, id LOOP
        PERFORM offering.sub_move(r.id, 'V8', 'expired', p_actor, 'offering closed', NULL);
      END LOOP;
      PERFORM offering.move(o.id, 'L9', 'closing', p_actor, CASE WHEN u.paid >= o.hard_cap_units THEN 'hard cap paid' ELSE 'close time and payment grace passed' END, NULL);
      v_out := v_out || jsonb_build_object('closing', true);
    END IF;
    SELECT * INTO o FROM offering.offerings WHERE id = p_offering;
  END IF;

  IF o.state = 'closing' THEN
    SELECT * INTO v_ext FROM offering.requests WHERE offering_id = o.id AND code = 'L10' AND status = 'open';
    IF FOUND AND v_ext.requested_at + make_interval(hours => offering.setting('extension_decision_hours')::int) < clock_timestamp() THEN
      UPDATE offering.requests SET status = 'stale', decided_at = clock_timestamp() WHERE id = v_ext.id;
      PERFORM offering.audit_append(p_actor, 'request.stale', jsonb_build_object('request', v_ext.id, 'ref', o.id, 'why', 'no extension decision in time (OF-20)'));
      v_ext := NULL;
    END IF;
    IF v_ext.id IS NULL THEN
      SELECT * INTO u FROM offering.units(o.id);
      v_out := v_out || jsonb_build_object('proposed', offering.system_request(o.id, CASE WHEN u.paid >= o.min_raise_units THEN 'L11' ELSE 'L12' END, p_actor,
        format('paid %s of min raise %s units', u.paid, o.min_raise_units)));
    ELSE
      v_out := v_out || jsonb_build_object('waitingForExtension', v_ext.id);
    END IF;
  END IF;

  IF o.state = 'funded' AND clock_timestamp() > o.completion_deadline THEN
    v_out := v_out || jsonb_build_object('proposed', offering.system_request(o.id, 'L15', p_actor, 'completion deadline passed (OF-42)'));
  END IF;
  IF o.state = 'refunding' THEN
    v_out := v_out || jsonb_build_object('cancelled', offering.finish_refunds_internal(o.id, p_actor));
  END IF;
  SELECT state INTO o.state FROM offering.offerings WHERE id = p_offering;
  RETURN v_out || jsonb_build_object('state', o.state);
END $$;

/** Re-applies a matched credit to its reservation (normally done by the trigger on bank.credits). */
CREATE FUNCTION offering.sync_payment(p_sub uuid, p_actor text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, offering AS $$
DECLARE
  s offering.subscriptions;
  v_ref text;
BEGIN
  PERFORM offering.check_actor(p_actor);
  SELECT * INTO s FROM offering.subscriptions WHERE id = p_sub;
  IF NOT FOUND THEN PERFORM offering.fail('P0002', 'unknown subscription'); END IF;
  IF s.state = 'payment_pending' THEN
    PERFORM pg_advisory_xact_lock(586586098, hashtext(s.intent_code));
    SELECT raast_ref INTO v_ref FROM bank.credits WHERE intent_code = s.intent_code AND status = 'matched';
    IF FOUND THEN PERFORM offering.confirm_payment(p_sub, v_ref, p_actor); END IF;
  END IF;
  RETURN offering.sub_json(p_sub);
END $$;

/**
 * Opens the mint window's commands (OFR-5): only for an offering in Completing with the completion
 * record (deed registered, completion payments submitted) and an approved batch that still equals
 * the allocations. One outbox command per allocation, key mint:<refId>, in this transaction.
 */
CREATE FUNCTION offering.start_minting(p_offering uuid, p_actor text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, offering AS $$
DECLARE
  o offering.offerings;
  b offering.issuance_batches;
  i record;
  v_n integer := 0;
  v_problems integer;
BEGIN
  PERFORM offering.check_actor(p_actor);
  SELECT * INTO o FROM offering.offerings WHERE id = p_offering FOR NO KEY UPDATE;
  IF NOT FOUND THEN PERFORM offering.fail('P0002', 'unknown offering'); END IF;
  IF o.state <> 'completing' THEN PERFORM offering.fail('23514', 'tokens are minted only at completion (S-02 §2)'); END IF;
  IF o.mint_started_at IS NOT NULL THEN RETURN 0; END IF;
  IF NOT EXISTS (SELECT 1 FROM offering.completions WHERE offering_id = p_offering) THEN
    PERFORM offering.fail('23514', 'no approved completion record (registered deed, completion payments, OF-45)');
  END IF;
  SELECT * INTO b FROM offering.issuance_batches WHERE id = offering.approved_batch(p_offering);
  IF b.id IS NULL OR b.digest <> offering.batch_digest(offering.allocation_items(p_offering)) THEN
    PERFORM offering.fail('23514', 'the approved issuance batch does not match the allocations');
  END IF;
  SELECT count(*) INTO v_problems FROM offering.dry_run(p_offering);
  IF v_problems > 0 THEN PERFORM offering.fail('23514', format('issuance dry run found %s problem(s) (OF-43)', v_problems)); END IF;
  FOR i IN SELECT subscription_id FROM offering.issuance_items WHERE batch_id = b.id ORDER BY line_no LOOP
    PERFORM offering.enqueue_mint(i.subscription_id, 1, p_actor);
    v_n := v_n + 1;
  END LOOP;
  UPDATE offering.offerings SET mint_started_at = clock_timestamp() WHERE id = p_offering;
  PERFORM offering.audit_append(p_actor, 'offering.minting_started', jsonb_build_object('ref', p_offering, 'batch', b.id, 'commands', v_n));
  RETURN v_n;
END $$;

/**
 * OFR-7 settlement from the read model: a Minted event whose wallet and amount match settles the
 * allocation (V14/V17) with `sub:<refId>:settled`; a mismatch, or a mint command that ended failed
 * or in review without an event, puts it in Issuance Review (V16).
 */
CREATE FUNCTION offering.settle(p_offering uuid, p_actor text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, offering AS $$
DECLARE
  o offering.offerings;
  s offering.subscriptions;
  m chain.issuances;
  v_guard text;
  v_capital text;
  v_journal bigint;
  v_settled integer := 0;
  v_review integer := 0;
BEGIN
  PERFORM offering.check_actor(p_actor);
  SELECT * INTO o FROM offering.offerings WHERE id = p_offering FOR NO KEY UPDATE;
  IF NOT FOUND THEN PERFORM offering.fail('P0002', 'unknown offering'); END IF;
  IF o.state <> 'completing' OR o.mint_started_at IS NULL THEN RETURN jsonb_build_object('settled', 0, 'review', 0); END IF;
  v_guard := offering.contract_of(o.token, 'issuance');
  v_capital := 'property:' || o.token || ':capital';
  PERFORM ledger.open_account(v_capital, 'equity', 'PKR', false);
  FOR s IN SELECT * FROM offering.subscriptions WHERE offering_id = p_offering AND state IN ('allocation_pending', 'issuance_review') ORDER BY created_at, id FOR NO KEY UPDATE LOOP
    SELECT * INTO m FROM chain.issuances i WHERE i.guard = v_guard AND i.ref_id = s.ref_id AND i.kind = 'mint';
    IF FOUND THEN
      IF m.account = s.wallet AND m.amount = s.units THEN
        v_journal := ledger.post_journal('sub:' || s.ref_id || ':settled', 'subscription_settled', 'units minted at completion', m.tx_hash, p_actor,
          jsonb_build_array(jsonb_build_object('account', 'investor:' || s.subject_id || ':subscriptions', 'amount', s.amount_paisa::text),
                            jsonb_build_object('account', v_capital, 'amount', (-s.amount_paisa)::text)));
        UPDATE offering.subscriptions SET settled_journal = v_journal, mint_tx = m.tx_hash WHERE id = s.id;
        PERFORM offering.sub_move(s.id, CASE s.state WHEN 'allocation_pending' THEN 'V14' ELSE 'V17' END, 'tokens_issued', p_actor, 'Minted ' || m.tx_hash, NULL);
        v_settled := v_settled + 1;
      ELSIF s.state = 'allocation_pending' THEN
        PERFORM offering.sub_move(s.id, 'V16', 'issuance_review', p_actor, 'Minted event does not match wallet and amount', NULL);
        PERFORM pg_notify('offering_alert', json_build_object('kind', 'mint_mismatch', 'subscription', s.id)::text);
        v_review := v_review + 1;
      END IF;
    ELSIF s.state = 'allocation_pending' AND EXISTS (
        SELECT 1 FROM offering.mint_commands mc JOIN outbox.commands c ON c.id = mc.command_id
        WHERE mc.subscription_id = s.id AND c.status IN ('failed', 'review'))
      AND NOT EXISTS (SELECT 1 FROM offering.mint_commands mc JOIN outbox.commands c ON c.id = mc.command_id
                      WHERE mc.subscription_id = s.id AND c.status IN ('pending', 'claimed', 'submitted', 'confirmed')) THEN
      PERFORM offering.sub_move(s.id, 'V16', 'issuance_review', p_actor, 'mint refused, reverted or unknown', NULL);
      PERFORM pg_notify('offering_alert', json_build_object('kind', 'issuance_review', 'subscription', s.id)::text);
      v_review := v_review + 1;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('settled', v_settled, 'review', v_review);
END $$;

/**
 * Sends one approved refund (V20): recorded first (journal `sub:<refId>:refunded` through
 * bank.refund_credit, gate checked), the caller then instructs the bank. Refused while a mint for
 * the refId exists or could still be mined (OF-51).
 */
CREATE FUNCTION offering.execute_refund(p_sub uuid, p_actor text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, offering AS $$
DECLARE
  s offering.subscriptions;
  f offering.refunds;
  v_journal bigint;
BEGIN
  PERFORM offering.check_actor(p_actor);
  SELECT * INTO s FROM offering.subscriptions WHERE id = p_sub FOR NO KEY UPDATE;
  IF NOT FOUND THEN PERFORM offering.fail('P0002', 'unknown subscription'); END IF;
  SELECT * INTO f FROM offering.refunds WHERE subscription_id = p_sub FOR NO KEY UPDATE;
  IF f.journal_id IS NOT NULL THEN RETURN jsonb_build_object('raastRef', f.raast_ref, 'journal', f.journal_id, 'state', s.state); END IF;
  IF s.state <> 'refund_pending' OR f.subscription_id IS NULL THEN PERFORM offering.fail('23514', 'no refund is pending for this subscription'); END IF;
  IF (SELECT status FROM offering.requests WHERE id = f.request_id) <> 'approved' THEN
    PERFORM offering.fail('23514', 'the refund is not approved by two bank operators (V20)');
  END IF;
  IF EXISTS (SELECT 1 FROM chain.issuances i WHERE i.ref_id = s.ref_id)
     OR EXISTS (SELECT 1 FROM offering.mint_commands mc JOIN outbox.commands c ON c.id = mc.command_id
                WHERE mc.subscription_id = s.id AND c.status <> 'failed')
     OR EXISTS (SELECT 1 FROM outbox.commands c WHERE c.kind = 'issuance.mint' AND c.payload->>'refId' = s.ref_id AND c.status <> 'failed') THEN
    PERFORM offering.fail('23514', 'a mint for this refId exists or could still be mined: no refund (OF-51, M-6)');
  END IF;
  v_journal := bank.refund_credit(s.raast_ref, p_actor, 'subscription refund (' || f.cause || ')');
  UPDATE offering.refunds SET journal_id = v_journal, sent_by = p_actor, sent_at = clock_timestamp() WHERE subscription_id = p_sub;
  UPDATE offering.subscriptions SET refund_journal = v_journal WHERE id = p_sub;
  PERFORM offering.sub_move(p_sub, 'V20', 'refunded', p_actor, 'returned to the sender under ' || s.raast_ref, f.request_id);
  PERFORM offering.finish_refunds_internal(s.offering_id, p_actor);
  RETURN jsonb_build_object('raastRef', s.raast_ref, 'journal', v_journal, 'state', 'refunded');
END $$;

-- ================================================================== API: compliance actions
/** V21: sanctions hit on a paid subscription: blocked, funds stay in escrow (S-06). */
CREATE FUNCTION offering.block(p_sub uuid, p_officer text, p_reason text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, offering AS $$
DECLARE
  s offering.subscriptions;
BEGIN
  PERFORM offering.need_duty(p_officer, ARRAY['compliance'], 'block a subscription');
  PERFORM offering.check_reason(p_reason);
  SELECT * INTO s FROM offering.subscriptions WHERE id = p_sub FOR NO KEY UPDATE;
  IF NOT FOUND THEN PERFORM offering.fail('P0002', 'unknown subscription'); END IF;
  UPDATE offering.subscriptions SET reason = left(p_reason, 300), public_reason = 'under review' WHERE id = p_sub;
  PERFORM offering.sub_move(p_sub, 'V21', 'blocked', p_officer, p_reason, NULL);
  RETURN 'blocked';
END $$;

/** V22: payment recall or fraud claim. */
CREATE FUNCTION offering.dispute(p_sub uuid, p_officer text, p_reason text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, offering AS $$
BEGIN
  PERFORM offering.need_duty(p_officer, ARRAY['compliance'], 'mark a subscription disputed');
  PERFORM offering.check_reason(p_reason);
  PERFORM offering.sub_move(p_sub, 'V22', 'disputed', p_officer, p_reason, NULL);
  RETURN 'disputed';
END $$;

/** V13 (OF-44) or V15 (OF-43): verification lost or the dry run failed: full refund. */
CREATE FUNCTION offering.refund_subscription(p_sub uuid, p_officer text, p_reason text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, offering AS $$
DECLARE
  s offering.subscriptions;
  o offering.offerings;
BEGIN
  PERFORM offering.need_duty(p_officer, ARRAY['compliance', 'offering'], 'refund a subscription');
  PERFORM offering.check_reason(p_reason);
  SELECT * INTO s FROM offering.subscriptions WHERE id = p_sub FOR NO KEY UPDATE;
  IF NOT FOUND THEN PERFORM offering.fail('P0002', 'unknown subscription'); END IF;
  SELECT * INTO o FROM offering.offerings WHERE id = s.offering_id FOR NO KEY UPDATE;
  IF s.state = 'payment_confirmed' THEN
    PERFORM offering.sub_move(p_sub, 'V13', 'refund_pending', p_officer, p_reason, NULL);
    RETURN offering.open_refund(p_sub, 'eligibility_lost', p_officer, p_reason);
  ELSIF s.state = 'allocation_pending' AND o.state = 'funded' THEN
    -- Before any mint can exist (minting starts in Completing only).
    PERFORM offering.sub_move(p_sub, 'V15', 'refund_pending', p_officer, p_reason, NULL);
    UPDATE offering.requests SET status = 'stale', decided_at = clock_timestamp() WHERE offering_id = o.id AND code = 'IB' AND status = 'open';
    RETURN offering.open_refund(p_sub, 'allocation_failed', p_officer, p_reason);
  END IF;
  PERFORM offering.fail('23514', format('a %s subscription of a %s offering cannot be refunded here', s.state, o.state));
  RETURN NULL;
END $$;

-- ================================================================== signer fact (ADR 0005 amendment)
/**
 * Why the signing service must refuse an issuance.mint (NULL = an offering allows it): the refId
 * belongs to an allocation of an offering in Completing whose minting started, it is in the approved
 * issuance batch with the same wallet and units, its payment is booked and not refunded.
 */
CREATE FUNCTION offering.mint_allowed(p_ref_id text, p_to text, p_amount numeric) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, offering AS $$
DECLARE
  s offering.subscriptions;
  o offering.offerings;
BEGIN
  SELECT * INTO s FROM offering.subscriptions WHERE ref_id = lower(p_ref_id);
  IF NOT FOUND THEN RETURN 'refId is not an offering subscription'; END IF;
  SELECT * INTO o FROM offering.offerings WHERE id = s.offering_id;
  IF o.state <> 'completing' OR o.mint_started_at IS NULL THEN RETURN 'the offering is not in its mint window'; END IF;
  IF NOT EXISTS (SELECT 1 FROM offering.issuance_items i WHERE i.batch_id = offering.approved_batch(o.id) AND i.subscription_id = s.id
                   AND i.wallet = lower(p_to) AND i.units = p_amount) THEN
    RETURN 'not in the approved issuance batch with this wallet and amount';
  END IF;
  IF NOT (s.state = 'allocation_pending'
          OR (s.state = 'issuance_review' AND EXISTS (SELECT 1 FROM offering.requests r WHERE r.subscription_id = s.id AND r.code = 'V17' AND r.status = 'approved'))) THEN
    RETURN format('subscription is %s', s.state);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM ledger.journal j WHERE j.idempotency_key = 'sub:' || s.ref_id || ':paid')
     OR EXISTS (SELECT 1 FROM ledger.journal j WHERE j.idempotency_key = 'sub:' || s.ref_id || ':refunded') THEN
    RETURN 'payment not booked or refunded';
  END IF;
  RETURN NULL;
END $$;

-- ================================================================== reads
CREATE VIEW offering.overview AS
SELECT o.id AS offering_id, o.property_id, o.state, o.token, o.price_paisa, o.min_raise_units, o.target_units, o.hard_cap_units,
       o.min_units, o.max_units, o.opens_at, offering.close_time(o) AS closes_at, o.payment_grace_minutes, o.withdrawal_until,
       o.funded_at, o.completion_deadline, o.mint_started_at, o.completed_at, o.failed_at,
       u.held AS held_units, u.reserved AS reserved_units, u.paid AS paid_units, u.waitlisted AS waitlisted_units
FROM offering.offerings o, LATERAL offering.units(o.id) u;

-- What an investor may see of their subscriptions (no internal reasons: tipping-off).
CREATE VIEW offering.investor_subscriptions AS
SELECT s.id AS subscription_id, s.offering_id, s.subject_id, s.state, s.units, s.amount_paisa, s.intent_code AS payment_code, s.expires_at,
       s.public_reason, s.created_at
FROM offering.subscriptions s;

-- What reconciliation reads (ADR 0007 amendment).
CREATE VIEW offering.recon_subscriptions AS
SELECT s.id AS subscription_id, s.ref_id, s.offering_id, o.token, o.state AS offering_state, o.hard_cap_units, o.mint_started_at, o.failed_at,
       s.state, s.units, s.wallet, s.amount_paisa,
       (SELECT r.journal_id IS NULL FROM offering.refunds r WHERE r.subscription_id = s.id) AS refund_owed
FROM offering.subscriptions s JOIN offering.offerings o ON o.id = s.offering_id;

-- ================================================================== audit verification (OFR-8)
CREATE FUNCTION offering.verify_audit() RETURNS TABLE (audit_id bigint, problem text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, offering AS $$
DECLARE
  a offering.audit;
  v_prev bytea := decode(repeat('00', 32), 'hex');
  r record;
BEGIN
  FOR a IN SELECT * FROM offering.audit ORDER BY id LOOP
    IF a.prev_hash <> v_prev THEN audit_id := a.id; problem := 'prev_hash does not match'; RETURN NEXT; END IF;
    IF a.hash <> offering.audit_digest(a.prev_hash, a.id, a.at, a.actor, a.action, a.detail) THEN
      audit_id := a.id; problem := 'content does not match its hash'; RETURN NEXT;
    END IF;
    v_prev := a.hash;
  END LOOP;
  -- Every event has its audit entry with the same content; the state equals the last event.
  FOR r IN SELECT e.id::text AS id, 'offering event' AS what FROM offering.offering_events e
             WHERE NOT EXISTS (SELECT 1 FROM offering.audit x WHERE (x.detail->>'event')::bigint = e.id AND x.detail->>'ref' = e.offering_id::text
                                 AND x.detail->>'to' = e.to_state AND x.detail->>'code' = e.code)
           UNION ALL
           SELECT e.id::text, 'subscription event' FROM offering.subscription_events e
             WHERE NOT EXISTS (SELECT 1 FROM offering.audit x WHERE (x.detail->>'event')::bigint = e.id AND x.detail->>'ref' = e.subscription_id::text
                                 AND x.detail->>'to' = e.to_state AND x.detail->>'code' = e.code)
           UNION ALL
           SELECT o.id::text, 'offering state' FROM offering.offerings o
             WHERE o.state IS DISTINCT FROM coalesce((SELECT e.to_state FROM offering.offering_events e WHERE e.offering_id = o.id ORDER BY e.id DESC LIMIT 1), 'draft')
           UNION ALL
           SELECT s.id::text, 'subscription state' FROM offering.subscriptions s
             WHERE s.state IS DISTINCT FROM coalesce((SELECT e.to_state FROM offering.subscription_events e WHERE e.subscription_id = s.id ORDER BY e.id DESC LIMIT 1), 'initiated')
           UNION ALL
           SELECT s.id::text, 'subscription' FROM offering.subscriptions s
             WHERE NOT EXISTS (SELECT 1 FROM offering.audit x WHERE x.action = 'subscription.initiated' AND x.detail->>'ref' = s.id::text
                                 AND x.detail->>'refId' = s.ref_id AND x.detail->>'units' = s.units::text AND x.detail->>'amount' = s.amount_paisa::text)
           UNION ALL
           SELECT q.id::text, 'request' FROM offering.requests q
             WHERE NOT EXISTS (SELECT 1 FROM offering.audit x WHERE x.action = 'request.created' AND (x.detail->>'request')::bigint = q.id
                                 AND x.detail->>'code' = q.code)
           UNION ALL
           SELECT v.request_id || '/' || v.officer, 'vote' FROM offering.request_votes v
             WHERE NOT EXISTS (SELECT 1 FROM offering.audit x WHERE x.action IN ('request.approval', 'request.rejection')
                                 AND (x.detail->>'request')::bigint = v.request_id AND x.actor = v.officer
                                 AND (x.action = 'request.approval') = v.approve)
           UNION ALL
           SELECT c.id::text, 'acceptance' FROM offering.acceptances c
             WHERE NOT EXISTS (SELECT 1 FROM offering.audit x WHERE x.action = 'document.accepted' AND (x.detail->>'acceptance')::bigint = c.id
                                 AND x.detail->>'sha' = encode(c.doc_sha, 'hex'))
           UNION ALL
           SELECT b.id::text, 'issuance batch' FROM offering.issuance_batches b
             WHERE NOT EXISTS (SELECT 1 FROM offering.audit x WHERE x.action = 'batch.prepared' AND (x.detail->>'batch')::bigint = b.id
                                 AND x.detail->>'digest' = encode(b.digest, 'hex'))
                OR b.digest <> offering.batch_digest((SELECT jsonb_agg(jsonb_build_array(i.ref_id, i.wallet, i.units::text, i.subscription_id::text) ORDER BY i.ref_id)
                                                      FROM offering.issuance_items i WHERE i.batch_id = b.id))
           UNION ALL
           SELECT m.outbox_key, 'mint command' FROM offering.mint_commands m
             WHERE NOT EXISTS (SELECT 1 FROM offering.audit x WHERE x.action = 'subscription.mint_enqueued' AND (x.detail->>'command')::bigint = m.command_id)
           UNION ALL
           SELECT d.id::text, 'duty' FROM offering.duties d
             WHERE NOT EXISTS (SELECT 1 FROM offering.audit x WHERE x.action = 'duty.requested' AND (x.detail->>'duty')::bigint = d.id)
           UNION ALL
           SELECT c.code, 'payment code cancellation' FROM bank.intent_cancellations c
             WHERE NOT EXISTS (SELECT 1 FROM bank.audit x WHERE x.action = 'intent.cancelled' AND x.detail->>'code' = c.code)
           UNION ALL
           SELECT c.raast_ref, 'credit refund' FROM bank.credit_refunds c
             WHERE NOT EXISTS (SELECT 1 FROM bank.audit x WHERE x.action = 'credit.refunded' AND x.detail->>'ref' = c.raast_ref
                                 AND (x.detail->>'journal')::bigint = c.journal_id) LOOP
    audit_id := NULL; problem := format('%s %s has no matching audit entry or does not replay', r.what, r.id); RETURN NEXT;
  END LOOP;
END $$;

-- ================================================================== privileges (OFR-9)
REVOKE ALL ON ALL TABLES IN SCHEMA offering FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA offering FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA offering FROM PUBLIC;
REVOKE ALL ON TABLE bank.intent_cancellations, bank.credit_refunds FROM PUBLIC;
REVOKE ALL ON FUNCTION bank.cancel_intent(text, text, text), bank.refund_credit(text, text, text) FROM PUBLIC;

GRANT USAGE ON SCHEMA offering TO pt_offering_service, pt_offering_officer, pt_offering_admin, pt_offering_reader, pt_signer;

GRANT EXECUTE ON FUNCTION
  offering.accept_document(uuid, uuid, text, text, text, text, text, text),
  offering.reserve(uuid, uuid, text, uuid, bigint, text, text, text),
  offering.recheck(uuid, text),
  offering.cancel(uuid, uuid, text),
  offering.withdraw(uuid, uuid, text),
  offering.tick(uuid, text),
  offering.sync_payment(uuid, text),
  offering.start_minting(uuid, text),
  offering.settle(uuid, text),
  offering.execute_refund(uuid, text)
TO pt_offering_service;

GRANT EXECUTE ON FUNCTION
  offering.create_offering(uuid, text, uuid, jsonb),
  offering.update_terms(uuid, text, jsonb),
  offering.submit(uuid, text, text),
  offering.return_offering(uuid, text, text),
  offering.mark_ready(uuid, text, text),
  offering.suspend(uuid, text, text),
  offering.request(uuid, text, text, text, jsonb, uuid),
  offering.decide(bigint, text, boolean, text),
  offering.decide_all(uuid, text, text, boolean, text),
  offering.prepare_batch(uuid, text, text),
  offering.block(uuid, text, text),
  offering.dispute(uuid, text, text),
  offering.refund_subscription(uuid, text, text),
  offering.execute_refund(uuid, text),
  offering.terms_problem(uuid),
  offering.dry_run(uuid)
TO pt_offering_officer;

GRANT EXECUTE ON FUNCTION
  offering.request_duty(text, text, text, text),
  offering.decide_duty(bigint, text, boolean, text),
  offering.revoke_duty(bigint, text, text)
TO pt_offering_admin;

GRANT EXECUTE ON FUNCTION offering.verify_audit() TO pt_offering_officer, pt_offering_reader;
-- Used by the overview view (functions in a view are checked against the caller).
GRANT EXECUTE ON FUNCTION offering.units(uuid), offering.close_time(offering.offerings) TO pt_offering_service, pt_offering_officer, pt_offering_reader;
GRANT EXECUTE ON FUNCTION offering.mint_allowed(text, text, numeric) TO pt_signer;

GRANT SELECT ON offering.overview, offering.investor_subscriptions TO pt_offering_service, pt_offering_officer, pt_offering_reader;
GRANT SELECT ON offering.recon_subscriptions, offering.settings, offering.payment_anomalies TO pt_offering_reader, pt_recon_writer, pt_recon_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA offering TO pt_offering_officer;
GRANT SELECT ON offering.duties TO pt_offering_admin;
GRANT SELECT ON offering.settings, offering.request_rules, offering.transitions TO pt_offering_reader;
GRANT USAGE ON SCHEMA offering TO pt_recon_writer, pt_recon_reader;
GRANT SELECT ON bank.intent_cancellations, bank.credit_refunds TO pt_bank_operator, pt_bank_reader;

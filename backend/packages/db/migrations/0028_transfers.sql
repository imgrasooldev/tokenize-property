-- S-04 phase 0 (spec S-04 section 16): permitted secondary transfers between verified investors,
-- approved case by case and executed by the trustee as RecoveryGuard ForcedTransfer requests while
-- the token stays paused (transfer-closed mode). Numbered 0028: 0027 is reserved for S-05 (exit),
-- built in parallel; nothing here depends on it (16.7: transfer.blocks is the hook S-05 uses).
--
-- Safety properties enforced by the database itself (schema transfer, plus admin.* and webauth.* wrappers):
--   XF-1  Cases change only along their state machine (trigger): requested -> checks -> rejected |
--         awaiting_cash | proposed; awaiting_cash -> proposed | cancelled | refunding; proposed ->
--         executed | cancelling | failed; cancelling | failed -> executed | refunding | cancelled;
--         refunding -> cancelled; executed -> settled | disputed; settled -> disputed. Parties,
--         wallets, units, price and the agreement hash never change; decision facts are written
--         once; cases are never deleted. Every transition is a row in transfer.events.
--   XF-2  Checks (TR-10..TR-13, spec 16.3) are one SQL function, transfer.check_results(case, stage);
--         approval, the payment step and execution refuse while any fails (TR-11: re-run before
--         each execution; a hard failure cancels on chain instead of executing).
--   XF-3  Maker-checker (TR-SOD-1/2/3): a compliance officer AND a trustee officer approve, different
--         people, neither the opener nor the completer, neither with a declared conflict with a
--         party; decisions carry the digest of the case reviewed. Settlement and refund are prepared
--         by an operations maker and approved by an operations checker who is not the preparer, the
--         opener or the completer. Officer handles are accepted only inside PT Control (binding).
--   XF-4  DvP (TR-20): the buyer pays a `transfer` payment code into the case's own escrow
--         (transfer:<case>:escrow); the on-chain proposal is enqueued only once the exact credit is
--         booked; the seller is paid only after the read model shows the request executed with the
--         exact movement; money is refunded only when no execution happened and none can happen.
--   XF-5  On-chain commands exist only as a case enqueued them: transfer.command_allowed(kind,
--         payload) answers the signing service for transfer.propose | execute | cancel (deny by
--         default; separate from the S-06 gate).
--   XF-6  Register (6d): an executed case writes its two trustee register entries in the same
--         transaction.
--   XF-7  Surveillance (TR-23): alerts open 6c STR cases; never visible to investors.
--   XF-8  Every row is written by a function that also appends to the hash-chained transfer.audit (UTC
--         digests); transfer.verify_audit() re-checks the chain and finds rows written around it.
--   XF-9  Least data: no name, CNIC, IBAN or phone number; free text is refused if it carries one.
--   XF-10 Reconciliation rules in SQL (transfer.reconcile(token)): unapproved movements, settlement and
--         register mismatches, escrow residue, paid but not executed.

CREATE SCHEMA IF NOT EXISTS transfer;
REVOKE ALL ON SCHEMA transfer FROM PUBLIC;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pt_transfer_worker') THEN CREATE ROLE pt_transfer_worker NOLOGIN; END IF;
END $$;

-- ================================================================== helpers
CREATE FUNCTION transfer.forbid_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'transfer records are append-only: % on %.% is not allowed', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE FUNCTION transfer.utc(p timestamptz) RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT to_char(p AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
$$;

/** A UTC time as the notification service expects it (seconds). */
CREATE FUNCTION transfer.utc_s(p timestamptz) RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT to_char(p AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
$$;

CREATE FUNCTION transfer.fail(p_code text, p_message text) RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION '%', p_message USING ERRCODE = p_code;
END $$;

CREATE FUNCTION transfer.is_address(p text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT p IS NOT NULL AND length(p) = 42 AND p ~ '^0x[0-9a-f]+$'
$$;

CREATE FUNCTION transfer.zero_address() RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT '0x0000000000000000000000000000000000000000'::text $$;

/** The active signing policy's rule for a kind (NULL without one). */
CREATE FUNCTION transfer.policy(p_kind text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, transfer AS $$
  SELECT p.rule FROM signer.policies p WHERE p.kind = p_kind AND p.approved_at IS NOT NULL AND p.retired_at IS NULL
$$;

-- ================================================================== audit (XF-8)
CREATE TABLE transfer.audit (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at        timestamptz NOT NULL,
  actor     text NOT NULL CHECK (length(actor) BETWEEN 1 AND 100),
  action    text NOT NULL CHECK (action ~ '^[a-z][a-z_.]{2,63}$'),
  detail    jsonb NOT NULL CHECK (jsonb_typeof(detail) = 'object' AND octet_length(detail::text) <= 8192),
  prev_hash bytea NOT NULL CHECK (length(prev_hash) = 32),
  hash      bytea NOT NULL UNIQUE CHECK (length(hash) = 32)
);
CREATE INDEX audit_action_idx ON transfer.audit (action, id);

CREATE FUNCTION transfer.audit_digest(p_prev bytea, p_id bigint, p_at timestamptz, p_actor text, p_action text, p_detail jsonb)
RETURNS bytea LANGUAGE sql STABLE SET search_path = pg_catalog, transfer AS $$
  SELECT sha256(p_prev || convert_to('pt-transfer-audit-v1' || jsonb_build_array(p_id, transfer.utc(p_at), p_actor, p_action, p_detail)::text, 'UTF8'))
$$;

CREATE FUNCTION transfer.audit_append(p_actor text, p_action text, p_detail jsonb)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, transfer AS $$
DECLARE
  v_prev bytea;
  v_id bigint;
  v_at timestamptz := date_trunc('microseconds', clock_timestamp());
BEGIN
  PERFORM pg_advisory_xact_lock(586586280);
  SELECT hash INTO v_prev FROM transfer.audit ORDER BY id DESC LIMIT 1;
  v_prev := coalesce(v_prev, decode(repeat('00', 32), 'hex'));
  v_id := nextval(pg_get_serial_sequence('transfer.audit', 'id'));
  INSERT INTO transfer.audit (id, at, actor, action, detail, prev_hash, hash)
  OVERRIDING SYSTEM VALUE
  VALUES (v_id, v_at, left(p_actor, 100), p_action, coalesce(p_detail, '{}'::jsonb), v_prev,
          transfer.audit_digest(v_prev, v_id, v_at, left(p_actor, 100), p_action, coalesce(p_detail, '{}'::jsonb)));
  RETURN v_id;
END $$;

-- ================================================================== settings (changed by the database administrator only; audited)
CREATE TABLE transfer.settings (
  key   text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]{2,63}$'),
  value jsonb NOT NULL,
  note  text NOT NULL CHECK (length(note) BETWEEN 10 AND 300)
);
INSERT INTO transfer.settings (key, value, note) VALUES
  ('lockup_months', '6', 'TR-12 / Q-2: no transfer before the offering''s completion plus this many months (court orders exempt). Owner to confirm.'),
  ('price_band_ppm', '200000', 'TR-10 / Q-2: a sale price further than this (parts per million) from the reference price needs a written explanation.'),
  ('payment_hours', '72', 'T8 / TQ-2: the buyer pays within this many hours of approval (calendar hours until a business-day calendar exists).'),
  ('screening_max_age_hours', '24', 'TR-10 / TQ-1: a party''s latest sanctions screening must have passed within this many hours.'),
  ('fee_ppm', '0', 'TR-22 / Q-3 placeholder: platform fee on a sale, parts per million of the price, deducted from the seller''s proceeds.'),
  ('paid_not_executed_hours', '120', 'Reconciliation: a paid case not executed or refunded after this many hours is blocking (48 h delay + 72 h).'),
  ('escrow_residual_hours', '72', 'Reconciliation: an executed case still holding escrow after this many hours is blocking (seller not settled).'),
  ('round_trip_days', '30', 'TR-23 surveillance: an opposite transfer between the same two investors within this many days raises an alert.'),
  ('max_cases_30d', '3', 'TR-23 surveillance: more cases than this for one investor in 30 days raises an alert.'),
  ('receive_code_hours', '168', 'TR-B3: a buyer''s receive code is valid this many hours.'),
  ('request_acceptance_days', '7', 'TR-B3: a website request the buyer does not accept within this many days is cancelled.'),
  ('allowed_countries', '[586]', 'TR-10: registry countries both parties must have (Pakistan only until legal approves more).'),
  ('max_execute_attempts', '3', 'TR-B11: execution attempts before the case fails and the request is cancelled.'),
  -- Movements before this block (the read model's head when 0028 was applied) predate phase 0 checks.
  ('unapproved_from_block', to_jsonb(coalesce((SELECT max(number) FROM chain.blocks), 0) + 1),
   'Reconciliation transfer.unapproved: holder-to-holder movements from this block on must have an approved case (earlier ones predate 0028).');

CREATE FUNCTION transfer.setting(p_key text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, transfer AS $$
  SELECT value FROM transfer.settings WHERE key = p_key
$$;

CREATE FUNCTION transfer.num(p_key text) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, transfer AS $$
  SELECT (value #>> '{}')::numeric FROM transfer.settings WHERE key = p_key
$$;

CREATE FUNCTION transfer.setting_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, transfer AS $$
BEGIN
  IF TG_OP <> 'UPDATE' OR NEW.key <> OLD.key THEN
    RAISE EXCEPTION 'transfer settings are only ever updated in place' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM transfer.audit_append('db:' || session_user, 'setting.changed', jsonb_build_object('key', NEW.key, 'from', OLD.value, 'to', NEW.value));
  RETURN NEW;
END $$;
CREATE TRIGGER settings_audited BEFORE UPDATE OR DELETE ON transfer.settings FOR EACH ROW EXECUTE FUNCTION transfer.setting_changed();

-- ================================================================== cases (XF-1)
CREATE TABLE transfer.cases (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  case_uuid         uuid NOT NULL UNIQUE,
  -- bytes32 caseId in the signing payloads: SHA-256 of "pt-transfer-v1:<caseUuid>".
  case_ref          bytea NOT NULL UNIQUE CHECK (length(case_ref) = 32),
  origin            text NOT NULL CHECK (origin IN ('desk', 'investor')),
  token             text NOT NULL CHECK (transfer.is_address(token)),
  recovery_guard    text NOT NULL CHECK (transfer.is_address(recovery_guard)),
  identity_registry text NOT NULL CHECK (transfer.is_address(identity_registry)),
  seller_subject    uuid NOT NULL REFERENCES kyc.subjects (id),
  seller_wallet     text NOT NULL CHECK (transfer.is_address(seller_wallet)),
  buyer_subject     uuid NOT NULL REFERENCES kyc.subjects (id),
  buyer_wallet      text NOT NULL CHECK (transfer.is_address(buyer_wallet)),
  units             bigint NOT NULL CHECK (units BETWEEN 1 AND 1000000000000),
  consideration     text NOT NULL CHECK (consideration IN ('sale', 'gift', 'family', 'court_order')),
  price_paisa       bigint CHECK (price_paisa BETWEEN 1 AND 1000000000000),
  total_paisa       bigint CHECK (total_paisa BETWEEN 1 AND 1000000000000000),
  no_price_reason   text CHECK (no_price_reason IS NULL OR compliance.free_text_ok(no_price_reason, 10, 500)),
  agreement_sha256  bytea NOT NULL CHECK (length(agreement_sha256) = 32),
  price_explanation text CHECK (price_explanation IS NULL OR compliance.free_text_ok(price_explanation, 10, 1000)),
  holding_reason    text CHECK (holding_reason IS NULL OR compliance.free_text_ok(holding_reason, 10, 500)),
  status            text NOT NULL DEFAULT 'requested'
                    CHECK (status IN ('requested', 'checks', 'rejected', 'awaiting_cash', 'proposed', 'executed', 'settled', 'cancelling',
                                      'failed', 'refunding', 'cancelled', 'disputed')),
  opened_by         text NOT NULL CHECK (length(opened_by) BETWEEN 2 AND 100),
  opened_at         timestamptz NOT NULL,
  accepted_at       timestamptz,
  completed_by      text CHECK (length(completed_by) BETWEEN 2 AND 100),
  completed_at      timestamptz,
  approved_at       timestamptz,
  evidence_hash     bytea CHECK (length(evidence_hash) = 32),
  intent_code       text UNIQUE,
  pay_until         timestamptz,
  paid_ref          text UNIQUE,
  paid_at           timestamptz,
  propose_key       text UNIQUE,
  request_id        numeric(78,0) CHECK (request_id > 0),
  eta               bigint,
  execute_key       text UNIQUE,
  execute_attempts  integer NOT NULL DEFAULT 0 CHECK (execute_attempts BETWEEN 0 AND 10),
  cancel_key        text UNIQUE,
  cancel_attempts   integer NOT NULL DEFAULT 0 CHECK (cancel_attempts BETWEEN 0 AND 10),
  executed_tx       text CHECK (executed_tx IS NULL OR (length(executed_tx) = 66 AND executed_tx ~ '^0x[0-9a-f]+$')),
  executed_at       timestamptz,
  cancelled_by      text CHECK (length(cancelled_by) BETWEEN 2 AND 100),
  cancel_reason     text CHECK (cancel_reason IS NULL OR compliance.free_text_ok(cancel_reason, 5, 500)),
  disputed_by       text CHECK (length(disputed_by) BETWEEN 2 AND 100),
  dispute_reason    text CHECK (dispute_reason IS NULL OR compliance.free_text_ok(dispute_reason, 10, 500)),
  updated_at        timestamptz NOT NULL,
  CHECK (seller_subject <> buyer_subject),
  CHECK (seller_wallet <> buyer_wallet),
  CHECK ((consideration = 'sale') = (price_paisa IS NOT NULL)),
  CHECK ((consideration = 'sale') = (total_paisa IS NOT NULL)),
  CHECK (total_paisa IS NULL OR total_paisa::numeric = units::numeric * price_paisa::numeric),
  CHECK ((consideration = 'sale') = (no_price_reason IS NULL)),
  CHECK (origin = 'desk' OR consideration <> 'court_order'),
  CHECK ((completed_by IS NULL) = (completed_at IS NULL)),
  CHECK (accepted_at IS NOT NULL OR status IN ('requested', 'cancelled')),
  CHECK (completed_at IS NOT NULL OR status IN ('requested', 'cancelled')),
  CHECK (approved_at IS NOT NULL OR status IN ('requested', 'checks', 'rejected', 'cancelled')),
  CHECK ((approved_at IS NULL) = (evidence_hash IS NULL)),
  CHECK ((intent_code IS NULL) = (pay_until IS NULL)),
  CHECK (intent_code IS NULL OR consideration = 'sale'),
  CHECK ((paid_ref IS NULL) = (paid_at IS NULL)),
  CHECK (paid_ref IS NULL OR intent_code IS NOT NULL),
  CHECK ((request_id IS NULL) = (eta IS NULL)),
  CHECK (request_id IS NULL OR propose_key IS NOT NULL),
  CHECK (execute_key IS NULL OR request_id IS NOT NULL),
  CHECK (cancel_key IS NULL OR request_id IS NOT NULL),
  CHECK ((executed_tx IS NULL) = (executed_at IS NULL)),
  CHECK (status NOT IN ('executed', 'settled') OR executed_tx IS NOT NULL),
  CHECK ((cancelled_by IS NULL) = (cancel_reason IS NULL)),
  CHECK ((disputed_by IS NULL) = (dispute_reason IS NULL)),
  CHECK ((status = 'disputed') = (disputed_by IS NOT NULL))
);
CREATE INDEX cases_seller_idx ON transfer.cases (seller_subject, id DESC);
CREATE INDEX cases_buyer_idx ON transfer.cases (buyer_subject, id DESC);
CREATE INDEX cases_live_idx ON transfer.cases (status) WHERE status NOT IN ('settled', 'rejected', 'cancelled', 'disputed');
CREATE INDEX cases_token_idx ON transfer.cases (token, seller_wallet);

/** Columns written once (set, then never changed). */
CREATE FUNCTION transfer.write_once_columns() RETURNS text[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['accepted_at', 'completed_by', 'completed_at', 'approved_at', 'evidence_hash', 'intent_code', 'pay_until', 'paid_ref', 'paid_at',
               'propose_key', 'request_id', 'eta', 'executed_tx', 'executed_at', 'cancelled_by', 'cancel_reason', 'disputed_by', 'dispute_reason']
$$;

CREATE FUNCTION transfer.guard_case() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_old jsonb;
  v_new jsonb;
  k text;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'transfer cases are never deleted' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF (NEW.id, NEW.case_uuid, NEW.case_ref, NEW.origin, NEW.token, NEW.recovery_guard, NEW.identity_registry, NEW.seller_subject, NEW.seller_wallet,
      NEW.buyer_subject, NEW.buyer_wallet, NEW.units, NEW.consideration, NEW.price_paisa, NEW.total_paisa, NEW.no_price_reason, NEW.agreement_sha256,
      NEW.price_explanation, NEW.holding_reason, NEW.opened_by, NEW.opened_at)
     IS DISTINCT FROM
     (OLD.id, OLD.case_uuid, OLD.case_ref, OLD.origin, OLD.token, OLD.recovery_guard, OLD.identity_registry, OLD.seller_subject, OLD.seller_wallet,
      OLD.buyer_subject, OLD.buyer_wallet, OLD.units, OLD.consideration, OLD.price_paisa, OLD.total_paisa, OLD.no_price_reason, OLD.agreement_sha256,
      OLD.price_explanation, OLD.holding_reason, OLD.opened_by, OLD.opened_at) THEN
    RAISE EXCEPTION 'transfer case % keeps its parties, units, price and agreement once opened', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status IN ('rejected', 'cancelled', 'disputed') THEN
    RAISE EXCEPTION 'transfer case % is final (%)', OLD.id, OLD.status USING ERRCODE = 'check_violation';
  END IF;
  v_old := to_jsonb(OLD);
  v_new := to_jsonb(NEW);
  FOREACH k IN ARRAY transfer.write_once_columns() LOOP
    IF v_old->k <> 'null'::jsonb AND (v_new->k) IS DISTINCT FROM (v_old->k) THEN
      RAISE EXCEPTION 'transfer case %: % is written once', OLD.id, k USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  IF NEW.execute_attempts < OLD.execute_attempts OR NEW.cancel_attempts < OLD.cancel_attempts
     OR (OLD.execute_key IS NOT NULL AND NEW.execute_key IS NULL) OR (OLD.cancel_key IS NOT NULL AND NEW.cancel_key IS NULL) THEN
    RAISE EXCEPTION 'transfer case %: command attempts only move forward', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND (OLD.status || '>' || NEW.status) NOT IN (
       'requested>checks', 'requested>cancelled',
       'checks>rejected', 'checks>awaiting_cash', 'checks>proposed', 'checks>cancelled',
       'awaiting_cash>proposed', 'awaiting_cash>cancelled', 'awaiting_cash>refunding',
       'proposed>executed', 'proposed>cancelling', 'proposed>failed',
       'cancelling>executed', 'cancelling>refunding', 'cancelling>cancelled',
       'failed>executed', 'failed>refunding', 'failed>cancelled',
       'refunding>cancelled',
       'executed>settled', 'executed>disputed', 'settled>disputed') THEN
    RAISE EXCEPTION 'transfer case %: % -> % is not a transition of the transfer state machine', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cases_guard BEFORE UPDATE OR DELETE ON transfer.cases FOR EACH ROW EXECUTE FUNCTION transfer.guard_case();

CREATE TABLE transfer.events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  case_id     bigint NOT NULL REFERENCES transfer.cases (id),
  from_status text,
  to_status   text NOT NULL,
  actor       text NOT NULL CHECK (length(actor) BETWEEN 1 AND 100),
  reason      text NOT NULL CHECK (length(reason) BETWEEN 2 AND 500),
  at          timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp())
);
CREATE INDEX events_case_idx ON transfer.events (case_id, id);

-- ================================================================== decisions (XF-3)
CREATE TABLE transfer.decisions (
  id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  case_id  bigint NOT NULL REFERENCES transfer.cases (id),
  capacity text NOT NULL CHECK (capacity IN ('compliance', 'trustee')),
  officer  text NOT NULL CHECK (length(officer) BETWEEN 2 AND 100),
  decision text NOT NULL CHECK (decision IN ('approve', 'reject')),
  reason   text NOT NULL CHECK (compliance.free_text_ok(reason, 10, 500)),
  digest   bytea NOT NULL CHECK (length(digest) = 32),
  at       timestamptz NOT NULL,
  UNIQUE (case_id, capacity),
  UNIQUE (case_id, officer)
);

-- ================================================================== check runs (XF-2)
CREATE TABLE transfer.checks (
  id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  case_id bigint NOT NULL REFERENCES transfer.cases (id),
  stage   text NOT NULL CHECK (stage IN ('complete', 'approve', 'payment', 'execute')),
  passed  boolean NOT NULL,
  results jsonb NOT NULL CHECK (jsonb_typeof(results) = 'array' AND octet_length(results::text) <= 16384),
  actor   text NOT NULL CHECK (length(actor) BETWEEN 1 AND 100),
  at      timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp())
);
CREATE INDEX checks_case_idx ON transfer.checks (case_id, id DESC);

-- ================================================================== receive codes (TR-B3)
CREATE TABLE transfer.receive_codes (
  code       text PRIMARY KEY CHECK (code ~ '^TR-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$'),
  subject_id uuid NOT NULL REFERENCES kyc.subjects (id),
  created_by text NOT NULL CHECK (length(created_by) BETWEEN 2 AND 100),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  case_id    bigint UNIQUE REFERENCES transfer.cases (id),
  CHECK (expires_at > created_at),
  CHECK ((used_at IS NULL) = (case_id IS NULL))
);
CREATE INDEX receive_codes_subject_idx ON transfer.receive_codes (subject_id, created_at DESC);

CREATE FUNCTION transfer.guard_code() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'receive codes are never deleted' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF OLD.used_at IS NOT NULL OR (NEW.code, NEW.subject_id, NEW.created_by, NEW.created_at, NEW.expires_at)
     IS DISTINCT FROM (OLD.code, OLD.subject_id, OLD.created_by, OLD.created_at, OLD.expires_at) THEN
    RAISE EXCEPTION 'receive code % can only be used, once', OLD.code USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER receive_codes_guard BEFORE UPDATE OR DELETE ON transfer.receive_codes FOR EACH ROW EXECUTE FUNCTION transfer.guard_code();

-- ================================================================== reference prices, conflicts, links, alerts, blocks
CREATE TABLE transfer.reference_prices (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  token           text NOT NULL CHECK (transfer.is_address(token)),
  price_paisa     bigint NOT NULL CHECK (price_paisa BETWEEN 1 AND 1000000000000),
  evidence_sha256 bytea NOT NULL CHECK (length(evidence_sha256) = 32),
  reason          text NOT NULL CHECK (compliance.free_text_ok(reason, 10, 500)),
  recorded_by     text NOT NULL CHECK (length(recorded_by) BETWEEN 2 AND 100),
  at              timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp())
);
CREATE INDEX reference_prices_token_idx ON transfer.reference_prices (token, id DESC);

-- TR-SOD-2: an officer's declared conflict with an investor (relative, related company, own account).
CREATE TABLE transfer.conflicts (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  officer    text NOT NULL CHECK (length(officer) BETWEEN 2 AND 100),
  subject_id uuid NOT NULL REFERENCES kyc.subjects (id),
  reason     text NOT NULL CHECK (compliance.free_text_ok(reason, 10, 500)),
  at         timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  UNIQUE (officer, subject_id)
);

-- TR-23: declared links between investors (surveillance of self-dealing); subject_a < subject_b.
CREATE TABLE transfer.party_links (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subject_a   uuid NOT NULL REFERENCES kyc.subjects (id),
  subject_b   uuid NOT NULL REFERENCES kyc.subjects (id),
  relation    text NOT NULL CHECK (relation IN ('family', 'related_company', 'common_control', 'other')),
  reason      text NOT NULL CHECK (compliance.free_text_ok(reason, 10, 500)),
  recorded_by text NOT NULL CHECK (length(recorded_by) BETWEEN 2 AND 100),
  at          timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  CHECK (subject_a < subject_b),
  UNIQUE (subject_a, subject_b)
);

CREATE TABLE transfer.alerts (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  case_id     bigint NOT NULL REFERENCES transfer.cases (id),
  rule        text NOT NULL CHECK (rule IN ('price_outside_band', 'round_trip', 'frequent', 'linked_parties')),
  subject_id  uuid NOT NULL REFERENCES kyc.subjects (id),
  detail      text NOT NULL CHECK (length(detail) BETWEEN 5 AND 300),
  str_case_id bigint NOT NULL REFERENCES compliance.str_cases (id),
  at          timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  UNIQUE (case_id, rule, subject_id)
);

-- 16.7 the S-05 hook: an open block refuses approval, payment and execution for the token.
CREATE TABLE transfer.blocks (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  token        text NOT NULL CHECK (transfer.is_address(token)),
  source       text NOT NULL CHECK (source IN ('exit', 'incident')),
  ref          text NOT NULL CHECK (length(ref) BETWEEN 3 AND 120),
  reason       text NOT NULL CHECK (compliance.free_text_ok(reason, 10, 500)),
  opened_by    text NOT NULL CHECK (length(opened_by) BETWEEN 2 AND 100),
  opened_at    timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  closed_by    text CHECK (length(closed_by) BETWEEN 2 AND 100),
  close_reason text CHECK (close_reason IS NULL OR compliance.free_text_ok(close_reason, 10, 500)),
  closed_at    timestamptz,
  CHECK ((closed_by IS NULL) = (closed_at IS NULL) AND (closed_at IS NULL) = (close_reason IS NULL)),
  UNIQUE (source, ref)
);
CREATE INDEX blocks_open_idx ON transfer.blocks (token) WHERE closed_at IS NULL;

CREATE FUNCTION transfer.guard_block() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'transfer blocks are never deleted' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF OLD.closed_at IS NOT NULL OR NEW.closed_at IS NULL
     OR (NEW.id, NEW.token, NEW.source, NEW.ref, NEW.reason, NEW.opened_by, NEW.opened_at)
        IS DISTINCT FROM (OLD.id, OLD.token, OLD.source, OLD.ref, OLD.reason, OLD.opened_by, OLD.opened_at) THEN
    RAISE EXCEPTION 'transfer block % can only be closed, once', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER blocks_guard BEFORE UPDATE OR DELETE ON transfer.blocks FOR EACH ROW EXECUTE FUNCTION transfer.guard_block();

-- ================================================================== cash operations: seller settlement and buyer refund (XF-3, XF-4)
CREATE TABLE transfer.cash_ops (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  case_id         bigint NOT NULL REFERENCES transfer.cases (id),
  kind            text NOT NULL CHECK (kind IN ('settlement', 'refund')),
  attempt         integer NOT NULL CHECK (attempt BETWEEN 1 AND 20),
  reference       text NOT NULL UNIQUE CHECK (reference ~ '^[A-Z0-9][A-Z0-9-]{3,63}$'),
  gross_paisa     bigint NOT NULL CHECK (gross_paisa > 0),
  fee_paisa       bigint NOT NULL DEFAULT 0 CHECK (fee_paisa >= 0),
  tax_paisa       bigint NOT NULL DEFAULT 0 CHECK (tax_paisa >= 0),
  tax_rate_id     bigint REFERENCES tax.rates (id),
  tax_status      text CHECK (tax_status IN ('filer', 'non_filer', 'exempt')),
  tax_placeholder boolean NOT NULL DEFAULT false,
  net_paisa       bigint NOT NULL CHECK (net_paisa > 0),
  payee_id        bigint REFERENCES bank.payees (id),
  raast_ref       text REFERENCES bank.credits (raast_ref),
  prepared_by     text NOT NULL CHECK (length(prepared_by) BETWEEN 2 AND 100),
  prepared_at     timestamptz NOT NULL,
  status          text NOT NULL DEFAULT 'prepared' CHECK (status IN ('prepared', 'approved', 'rejected')),
  decided_by      text CHECK (length(decided_by) BETWEEN 2 AND 100),
  decision_reason text CHECK (decision_reason IS NULL OR compliance.free_text_ok(decision_reason, 10, 500)),
  decided_at      timestamptz,
  file_sha256     bytea CHECK (length(file_sha256) = 32),
  fee_journal     bigint UNIQUE REFERENCES ledger.journal (id),
  tax_journal     bigint UNIQUE REFERENCES ledger.journal (id),
  main_journal    bigint UNIQUE REFERENCES ledger.journal (id),
  UNIQUE (case_id, kind, attempt),
  CHECK (net_paisa = gross_paisa - fee_paisa - tax_paisa),
  CHECK (kind = 'settlement' OR (fee_paisa = 0 AND tax_paisa = 0 AND raast_ref IS NOT NULL AND payee_id IS NULL AND tax_rate_id IS NULL)),
  CHECK (kind = 'refund' OR (payee_id IS NOT NULL AND raast_ref IS NULL AND tax_rate_id IS NOT NULL AND tax_status IS NOT NULL)),
  CHECK (decided_by IS NULL OR decided_by <> prepared_by),
  CHECK ((status = 'prepared') = (decided_by IS NULL AND decided_at IS NULL AND decision_reason IS NULL)),
  CHECK ((status = 'approved') = (main_journal IS NOT NULL AND file_sha256 IS NOT NULL)),
  CHECK (status = 'approved' OR (fee_journal IS NULL AND tax_journal IS NULL))
);
CREATE UNIQUE INDEX cash_ops_one_live ON transfer.cash_ops (case_id, kind) WHERE status <> 'rejected';

CREATE FUNCTION transfer.guard_cash_op() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'cash operations are never deleted' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF OLD.status <> 'prepared' OR NEW.status = 'prepared'
     OR (NEW.id, NEW.case_id, NEW.kind, NEW.attempt, NEW.reference, NEW.gross_paisa, NEW.fee_paisa, NEW.tax_paisa, NEW.tax_rate_id, NEW.tax_status,
         NEW.tax_placeholder, NEW.net_paisa, NEW.payee_id, NEW.raast_ref, NEW.prepared_by, NEW.prepared_at)
        IS DISTINCT FROM
        (OLD.id, OLD.case_id, OLD.kind, OLD.attempt, OLD.reference, OLD.gross_paisa, OLD.fee_paisa, OLD.tax_paisa, OLD.tax_rate_id, OLD.tax_status,
         OLD.tax_placeholder, OLD.net_paisa, OLD.payee_id, OLD.raast_ref, OLD.prepared_by, OLD.prepared_at) THEN
    RAISE EXCEPTION 'cash operation % is decided once and never changes', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cash_ops_guard BEFORE UPDATE OR DELETE ON transfer.cash_ops FOR EACH ROW EXECUTE FUNCTION transfer.guard_cash_op();

-- ================================================================== append-only tables (XF-8)
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['audit', 'events', 'decisions', 'checks', 'reference_prices', 'conflicts', 'party_links', 'alerts'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON transfer.%I FOR EACH ROW EXECUTE FUNCTION transfer.forbid_change()', t || '_append_only', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['audit', 'settings', 'cases', 'events', 'decisions', 'checks', 'receive_codes', 'reference_prices', 'conflicts',
                           'party_links', 'alerts', 'blocks', 'cash_ops'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON transfer.%I FOR EACH STATEMENT EXECUTE FUNCTION transfer.forbid_change()', t || '_no_truncate', t);
  END LOOP;
END $$;

-- ================================================================== officer names bound to sessions (as 0016 A-3)
CREATE TRIGGER cases_officer_binding BEFORE INSERT OR UPDATE ON transfer.cases
  FOR EACH ROW EXECUTE FUNCTION compliance.bind_actor('opened_by', 'completed_by', 'cancelled_by', 'disputed_by');
CREATE TRIGGER decisions_officer_binding BEFORE INSERT ON transfer.decisions FOR EACH ROW EXECUTE FUNCTION compliance.bind_actor('officer');
CREATE TRIGGER reference_prices_officer_binding BEFORE INSERT ON transfer.reference_prices FOR EACH ROW EXECUTE FUNCTION compliance.bind_actor('recorded_by');
CREATE TRIGGER conflicts_officer_binding BEFORE INSERT ON transfer.conflicts FOR EACH ROW EXECUTE FUNCTION compliance.bind_actor('officer');
CREATE TRIGGER party_links_officer_binding BEFORE INSERT ON transfer.party_links FOR EACH ROW EXECUTE FUNCTION compliance.bind_actor('recorded_by');
CREATE TRIGGER blocks_officer_binding BEFORE INSERT OR UPDATE ON transfer.blocks FOR EACH ROW EXECUTE FUNCTION compliance.bind_actor('opened_by', 'closed_by');
CREATE TRIGGER cash_ops_officer_binding BEFORE INSERT OR UPDATE ON transfer.cash_ops FOR EACH ROW EXECUTE FUNCTION compliance.bind_actor('prepared_by', 'decided_by');

-- ================================================================== amendments of other schemas (additive)
-- ADR 0009 amendment: payment codes of purpose `transfer` (the buyer's payment into the case's escrow).
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT conname FROM pg_constraint WHERE conrelid = 'bank.payment_intents'::regclass AND contype = 'c'
           AND pg_get_constraintdef(oid) LIKE '%purpose%' LOOP
    EXECUTE format('ALTER TABLE bank.payment_intents DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;
ALTER TABLE bank.payment_intents
  ADD CONSTRAINT payment_intents_purpose_known CHECK (purpose IN ('subscription', 'rent_collection', 'transfer')),
  ADD CONSTRAINT payment_intents_subject_purpose CHECK ((purpose IN ('subscription', 'transfer')) = (subject_id IS NOT NULL)),
  ADD CONSTRAINT payment_intents_subscription_key CHECK (purpose <> 'subscription' OR ledger_key ~ '^sub:0x[0-9a-f]{64}:paid$'),
  ADD CONSTRAINT payment_intents_rent_key CHECK (purpose <> 'rent_collection' OR ledger_key ~ '^rent:collected:0x[0-9a-f]{40}:[a-z0-9-]{1,40}$'),
  ADD CONSTRAINT payment_intents_transfer_key CHECK (purpose <> 'transfer' OR (
    ledger_key ~ '^xfer:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:paid$'
    AND credit_account = 'transfer:' || substr(ledger_key, 6, 36) || ':escrow'));

-- 6d amendment: the trustee register records executed transfers (two entries per case, XF-6).
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT conname FROM pg_constraint WHERE conrelid = 'trustee.register_entries'::regclass AND contype = 'c'
           AND pg_get_constraintdef(oid) LIKE '%source%offering%' LOOP
    EXECUTE format('ALTER TABLE trustee.register_entries DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;
ALTER TABLE trustee.register_entries ADD CONSTRAINT register_entries_source_known CHECK (source IN ('offering', 'adjustment', 'transfer'));

-- S-03 amendment: withholding on the disposal of units (TR-22). PLACEHOLDER rates, LEGAL/TAX TO CONFIRM.
INSERT INTO tax.income_types (code, label, note) VALUES
  ('unit_disposal', 'Disposal of units in a secondary transfer',
   'LEGAL/TAX TO CONFIRM (S-04 TQ-3): withholding on the seller''s proceeds of a phase 0 transfer, basis and rates, gifts.');
DO $$
DECLARE
  r record;
  v_id bigint;
BEGIN
  FOR r IN SELECT * FROM (VALUES ('filer', 10000), ('non_filer', 20000), ('exempt', 0)) AS t(status, ppm) LOOP
    INSERT INTO tax.rates (income_type, status, rate_ppm, effective_from, version, basis, placeholder, state, proposed_by, decided_by, decision_reason, decided_at)
    VALUES ('unit_disposal', r.status, r.ppm, DATE '2025-07-01', 1,
            format('PLACEHOLDER - LEGAL/TAX TO CONFIRM: disposal of units, %s, ppm of gross proceeds (S-04 TQ-3)', r.status), true, 'active',
            'migration:0028', 'migration:0028:seed', 'placeholder seed, must be replaced by confirmed rates', clock_timestamp())
    RETURNING id INTO v_id;
    -- ops.verify_audit() expects the proposal and decision of every rate not seeded by 0021.
    PERFORM ops.audit_append('migration:0028', 'rate.proposed', jsonb_build_object('rate', v_id, 'incomeType', 'unit_disposal', 'status', r.status,
      'ratePpm', r.ppm, 'effectiveFrom', DATE '2025-07-01', 'version', 1));
    PERFORM ops.audit_append('migration:0028:seed', 'rate.decided', jsonb_build_object('rate', v_id, 'state', 'active', 'decision', 'approve'));
  END LOOP;
END $$;

-- Notifications (section 11): the seller's alert (security) and the parties' status updates.
INSERT INTO notify.event_kinds (kind, category, placeholders, description) VALUES
  ('security.transfer_requested', 'security', '{"at": {"type": "utc"}}',
   'A transfer of the investor''s units was requested (S-04 section 11, account-takeover defence).'),
  ('transfer.status_changed', 'transactional',
   '{"status": {"type": "word", "choices": ["accepted", "under_review", "not_approved", "approved", "payment_received", "on_chain", "transferred", "completed", "being_cancelled", "refund_pending", "refunded", "cancelled"]}}',
   'A transfer the investor is a party to changed state (S-04 section 11).'),
  ('transfer.payment_due', 'transactional',
   '{"amount_paisa": {"type": "paisa"}, "reference": {"type": "code"}, "expires_at": {"type": "utc"}}',
   'The buyer of an approved priced transfer must pay into the trustee escrow (S-04 T5).');

SELECT notify.add_template(t.kind, t.channel, t.locale, t.subject, t.body, 'migration:0028')
FROM (VALUES
  ('security.transfer_requested', 'sms', 'en', NULL,
   'Property Token: a transfer of your units was requested at {{at}}. Not you? Contact support in the app at once. We never ask for codes.'),
  ('security.transfer_requested', 'sms', 'ur', NULL,
   'پراپرٹی ٹوکن: {{at}} پر آپ کے یونٹس کی منتقلی کی درخواست آئی۔ آپ نہیں تھے؟ فوراً ایپ میں سپورٹ سے رابطہ کریں۔'),
  ('security.transfer_requested', 'email', 'en', 'A transfer of your Property Token units was requested',
   E'A transfer of your units was requested at {{at}}.\n\nIf you asked for it, no action is needed: nothing moves before the compliance and trustee checks and the 48-hour on-chain delay.\nIf you did not, open the Property Token app yourself (do not use links in messages) and contact support.'),
  ('security.transfer_requested', 'email', 'ur', 'آپ کے پراپرٹی ٹوکن یونٹس کی منتقلی کی درخواست',
   E'{{at}} پر آپ کے یونٹس کی منتقلی کی درخواست دی گئی۔\n\nاگر یہ درخواست آپ نے دی ہے تو کچھ کرنے کی ضرورت نہیں: کمپلائنس اور ٹرسٹی کی جانچ اور 48 گھنٹے کے وقفے سے پہلے کچھ منتقل نہیں ہوگا۔\nاگر نہیں، تو پراپرٹی ٹوکن ایپ خود کھولیں (پیغامات میں دیے گئے لنک استعمال نہ کریں) اور سپورٹ سے رابطہ کریں۔'),
  ('transfer.status_changed', 'sms', 'en', NULL, 'Property Token: your transfer is now {{status}}. Details in the app under Transfers.'),
  ('transfer.status_changed', 'sms', 'ur', NULL, 'پراپرٹی ٹوکن: آپ کی منتقلی کی حالت اب {{status}} ہے۔ تفصیل ایپ میں منتقلیاں کے تحت۔'),
  ('transfer.status_changed', 'email', 'en', 'Your transfer: {{status}}', E'Your transfer is now {{status}}.\n\nOpen the Property Token app yourself to see the details under Transfers.'),
  ('transfer.status_changed', 'email', 'ur', 'آپ کی منتقلی: {{status}}', E'آپ کی منتقلی کی حالت اب {{status}} ہے۔\n\nتفصیل کے لیے پراپرٹی ٹوکن ایپ خود کھولیں اور منتقلیاں دیکھیں۔'),
  ('transfer.payment_due', 'sms', 'en', NULL,
   'Property Token: pay {{amount_paisa}} paisa from your registered account with reference {{reference}} before {{expires_at}}.'),
  ('transfer.payment_due', 'sms', 'ur', NULL,
   'پراپرٹی ٹوکن: اپنے رجسٹرڈ اکاؤنٹ سے {{amount_paisa}} پیسے ریفرنس {{reference}} کے ساتھ {{expires_at}} سے پہلے ادا کریں۔'),
  ('transfer.payment_due', 'email', 'en', 'Payment due for your transfer',
   E'Your transfer was approved. Pay exactly {{amount_paisa}} paisa from your registered bank account with the reference {{reference}} before {{expires_at}}.\nThe money is held in the trustee''s escrow until the units move; if they never move it is returned to the account it came from.'),
  ('transfer.payment_due', 'email', 'ur', 'آپ کی منتقلی کی ادائیگی',
   E'آپ کی منتقلی منظور ہو گئی۔ اپنے رجسٹرڈ بینک اکاؤنٹ سے ٹھیک {{amount_paisa}} پیسے ریفرنس {{reference}} کے ساتھ {{expires_at}} سے پہلے ادا کریں۔\nرقم یونٹس منتقل ہونے تک ٹرسٹی کے ایسکرو میں رہتی ہے؛ اگر یونٹس منتقل نہ ہوں تو رقم اسی اکاؤنٹ میں واپس آتی ہے جہاں سے آئی تھی۔')
) AS t(kind, channel, locale, subject, body);

-- ================================================================== derived facts
CREATE FUNCTION transfer.case_id_hex(p_case_ref bytea) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$ SELECT '0x' || encode(p_case_ref, 'hex') $$;

CREATE FUNCTION transfer.new_case_ref(p_uuid uuid) RETURNS bytea
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$ SELECT sha256(convert_to('pt-transfer-v1:' || p_uuid::text, 'UTF8')) $$;

CREATE FUNCTION transfer.escrow_account(p_uuid uuid) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$ SELECT 'transfer:' || p_uuid::text || ':escrow' $$;

/** PKR (paisa) the case's escrow holds (a liability: a credit balance is money held); 0 when it does not exist. */
CREATE FUNCTION transfer.escrow_held(p_uuid uuid) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, transfer AS $$
  SELECT coalesce((SELECT -b.balance FROM ledger.accounts a JOIN ledger.account_balances b ON b.account_id = a.id
                   WHERE a.code = transfer.escrow_account(p_uuid)), 0)::bigint
$$;

/** XF-4: a sale case's escrow holds exactly the price; a case without consideration has nothing to hold. */
CREATE FUNCTION transfer.escrow_ok(c transfer.cases) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, transfer AS $$
  SELECT c.consideration <> 'sale' OR (c.paid_ref IS NOT NULL AND transfer.escrow_held(c.case_uuid) = c.total_paisa)
$$;

CREATE FUNCTION transfer.new_code(p_prefix text) RETURNS text
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
  RETURN p_prefix || '-' || substr(s, 1, 4) || '-' || substr(s, 5, 4);
END $$;

/** The latest completed offering of the token (lock-up, minimum and maximum holding, offering price). */
CREATE FUNCTION transfer.offering_of(p_token text)
RETURNS TABLE (completed_at timestamptz, min_units bigint, max_holding_units bigint, price_paisa bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, transfer AS $$
  SELECT o.completed_at, o.min_units, o.max_holding_units, o.price_paisa FROM offering.offerings o
  WHERE o.token = p_token AND o.completed_at IS NOT NULL ORDER BY o.completed_at DESC LIMIT 1
$$;

/** 16.3 the reference price per unit: the latest recorded valuation, else the offering price. */
CREATE FUNCTION transfer.reference_price(p_token text, OUT price_paisa bigint, OUT source text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, transfer AS $$
DECLARE
  v_id bigint;
BEGIN
  SELECT r.price_paisa, r.id INTO price_paisa, v_id FROM transfer.reference_prices r WHERE r.token = p_token ORDER BY r.id DESC LIMIT 1;
  IF price_paisa IS NOT NULL THEN source := format('valuation %s', v_id); RETURN; END IF;
  SELECT o.price_paisa INTO price_paisa FROM transfer.offering_of(p_token) o;
  IF price_paisa IS NOT NULL THEN source := 'offering price'; END IF;
END $$;

/** States in which a case's units may still move (they count against balances, register and headroom). */
CREATE FUNCTION transfer.live_states() RETURNS text[]
LANGUAGE sql IMMUTABLE AS $$ SELECT ARRAY['requested', 'checks', 'awaiting_cash', 'proposed', 'cancelling', 'failed'] $$;

/** Checks that may pass later without anything being wrong (fresh screening, policies): wait, never cancel. */
CREATE FUNCTION transfer.wait_codes() RETURNS text[]
LANGUAGE sql IMMUTABLE AS $$ SELECT ARRAY['seller_screened', 'buyer_screened', 'policy'] $$;

CREATE FUNCTION transfer.failed_codes(p_results jsonb) RETURNS text[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(array_agg(x->>'code' ORDER BY ord), '{}') FROM jsonb_array_elements(coalesce(p_results, '[]')) WITH ORDINALITY AS t(x, ord)
  WHERE (x->>'ok')::boolean IS NOT TRUE
$$;

/** Failed checks that are not wait codes: a reason to cancel (TR-11). */
CREATE FUNCTION transfer.hard_codes(p_results jsonb) RETURNS text[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(array_agg(c), '{}') FROM unnest(transfer.failed_codes(p_results)) c WHERE NOT (c = ANY (transfer.wait_codes()))
$$;

-- ================================================================== the checks (XF-2, spec 16.3)
CREATE FUNCTION transfer.check_results(p_case bigint, p_stage text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, transfer AS $$
DECLARE
  c transfer.cases;
  r jsonb := '[]'::jsonb;
  v_side text;
  s uuid;
  w text;
  v_status text;
  v_outcome text;
  v_at timestamptz;
  v_hours numeric := transfer.num('screening_max_age_hours');
  v_bool boolean;
  v_country integer;
  v_identity text;
  v_balance numeric;
  v_frozen numeric;
  v_pending numeric;
  v_other numeric;
  v_register numeric;
  v_held numeric;
  v_inbound numeric;
  v_pending_in numeric;
  v_cap numeric;
  v_policy jsonb;
  o record;
  v_ref record;
  v_band numeric;
  v_remaining numeric;
  v_now timestamptz := clock_timestamp();
  k text;
BEGIN
  IF p_stage IS NULL OR p_stage NOT IN ('complete', 'approve', 'payment', 'execute') THEN
    PERFORM transfer.fail('22023', 'stage must be complete, approve, payment or execute');
  END IF;
  SELECT * INTO c FROM transfer.cases WHERE id = p_case;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO o FROM transfer.offering_of(c.token);

  FOREACH v_side IN ARRAY ARRAY['seller', 'buyer'] LOOP
    s := CASE v_side WHEN 'seller' THEN c.seller_subject ELSE c.buyer_subject END;
    w := CASE v_side WHEN 'seller' THEN c.seller_wallet ELSE c.buyer_wallet END;
    v_status := kyc.subject_status(s);
    r := r || jsonb_build_object('code', v_side || '_kyc', 'ok', v_status = 'verified', 'detail', format('KYC status %s', v_status));
    v_outcome := NULL;
    v_at := NULL;
    SELECT k2.outcome, k2.at INTO v_outcome, v_at FROM kyc.checks k2 WHERE k2.subject_id = s AND k2.kind = 'sanctions' ORDER BY k2.id DESC LIMIT 1;
    r := r || jsonb_build_object('code', v_side || '_screened',
      'ok', coalesce(v_outcome = 'pass' AND v_at > v_now - make_interval(hours => v_hours::integer), false),
      'detail', CASE WHEN v_outcome IS NULL THEN 'no sanctions screening on record'
                     WHEN v_outcome <> 'pass' THEN format('latest sanctions screening: %s', v_outcome)
                     WHEN v_at <= v_now - make_interval(hours => v_hours::integer) THEN format('latest passed screening is older than %s hours: re-screen', v_hours)
                     ELSE format('screened %s UTC', to_char(v_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI')) END);
    v_bool := NOT EXISTS (SELECT 1 FROM compliance.kyc_cases k3 WHERE k3.subject_id = s AND k3.status IN ('open', 'info_requested', 'pending_second'))
              AND NOT EXISTS (SELECT 1 FROM recovery.cases x WHERE x.subject_id = s AND x.status IN ('opened', 'approved', 'executed'));
    r := r || jsonb_build_object('code', v_side || '_case', 'ok', v_bool,
      'detail', CASE WHEN v_bool THEN 'no open compliance review or recovery case' ELSE 'an open compliance review or recovery case exists' END);
  END LOOP;

  -- Bound wallets unchanged; registered with an identity in the read model; allowed country.
  v_bool := EXISTS (SELECT 1 FROM kyc.wallets x WHERE x.subject_id = c.seller_subject AND x.wallet = c.seller_wallet)
        AND EXISTS (SELECT 1 FROM kyc.wallets x WHERE x.subject_id = c.buyer_subject AND x.wallet = c.buyer_wallet)
        AND EXISTS (SELECT 1 FROM chain.investors i WHERE i.registry = c.identity_registry AND i.wallet = c.seller_wallet AND i.registered
                    AND NOT i.identity_stale AND i.identity IS NOT NULL)
        AND EXISTS (SELECT 1 FROM chain.investors i WHERE i.registry = c.identity_registry AND i.wallet = c.buyer_wallet AND i.registered
                    AND NOT i.identity_stale AND i.identity IS NOT NULL);
  r := r || jsonb_build_object('code', 'wallets', 'ok', v_bool,
    'detail', CASE WHEN v_bool THEN 'both wallets bound and registered' ELSE 'a bound wallet changed or is not registered with an identity' END);
  v_bool := true;
  FOREACH w IN ARRAY ARRAY[c.seller_wallet, c.buyer_wallet] LOOP
    v_country := NULL;
    SELECT i.country INTO v_country FROM chain.investors i WHERE i.registry = c.identity_registry AND i.wallet = w AND i.registered;
    v_bool := v_bool AND v_country IS NOT NULL AND coalesce(transfer.setting('allowed_countries') @> to_jsonb(v_country), false);
  END LOOP;
  r := r || jsonb_build_object('code', 'country', 'ok', v_bool,
    'detail', CASE WHEN v_bool THEN 'both registry countries allowed' ELSE 'a registry country is unknown or not allowed' END);

  -- Seller: not frozen, free balance, trustee register.
  v_bool := NOT coalesce((SELECT f.address_frozen FROM chain.freezes f WHERE f.token = c.token AND f.holder = c.seller_wallet), false);
  r := r || jsonb_build_object('code', 'seller_frozen', 'ok', v_bool, 'detail', CASE WHEN v_bool THEN 'seller wallet not frozen' ELSE 'seller wallet is frozen' END);
  v_balance := coalesce((SELECT h.balance FROM chain.holdings h WHERE h.token = c.token AND h.holder = c.seller_wallet), 0);
  v_frozen := coalesce((SELECT f.frozen_amount FROM chain.freezes f WHERE f.token = c.token AND f.holder = c.seller_wallet), 0);
  v_pending := coalesce((SELECT sum(q.amount) FROM chain.recoveries q WHERE q.guard = c.recovery_guard AND q.from_addr = c.seller_wallet
                         AND q.status = 'pending' AND q.id IS DISTINCT FROM c.request_id), 0);
  v_other := coalesce((SELECT sum(x.units) FROM transfer.cases x WHERE x.id <> c.id AND x.token = c.token AND x.seller_wallet = c.seller_wallet
                       AND x.status = ANY (transfer.live_states()) AND x.request_id IS NULL), 0);
  r := r || jsonb_build_object('code', 'seller_balance', 'ok', v_balance - v_frozen >= c.units + v_pending + v_other,
    'detail', format('free %s (balance %s, frozen %s); needed %s + pending %s + other cases %s', v_balance - v_frozen, v_balance, v_frozen, c.units, v_pending, v_other));
  v_register := trustee.register_balance(c.token, c.seller_wallet);
  v_other := coalesce((SELECT sum(x.units) FROM transfer.cases x WHERE x.id <> c.id AND x.token = c.token AND x.seller_wallet = c.seller_wallet
                       AND x.status = ANY (transfer.live_states())), 0);
  r := r || jsonb_build_object('code', 'register', 'ok', v_register >= c.units + v_other,
    'detail', format('trustee register %s; needed %s + other cases %s', v_register, c.units, v_other));

  -- Buyer: MaxBalance headroom over every wallet of its identity.
  SELECT i.identity INTO v_identity FROM chain.investors i WHERE i.registry = c.identity_registry AND i.wallet = c.buyer_wallet AND i.registered;
  v_policy := transfer.policy('transfer.propose');
  v_cap := nullif(v_policy->>'maxBalance', '')::numeric;
  IF o.max_holding_units IS NOT NULL THEN v_cap := least(coalesce(v_cap, o.max_holding_units), o.max_holding_units); END IF;
  v_held := coalesce((SELECT sum(h.balance) FROM chain.holdings h JOIN chain.investors i ON i.wallet = h.holder AND i.registry = c.identity_registry
                      WHERE h.token = c.token AND i.registered AND i.identity = v_identity), 0);
  v_inbound := coalesce((SELECT sum(x.units) FROM transfer.cases x WHERE x.id <> c.id AND x.token = c.token AND x.buyer_subject = c.buyer_subject
                         AND x.status = ANY (transfer.live_states())), 0);
  v_pending_in := coalesce((SELECT sum(q.amount) FROM chain.recoveries q JOIN chain.investors i ON i.wallet = q.to_addr AND i.registry = c.identity_registry
                            WHERE q.guard = c.recovery_guard AND q.status = 'pending' AND i.identity = v_identity AND q.id IS DISTINCT FROM c.request_id
                              AND NOT EXISTS (SELECT 1 FROM transfer.cases x WHERE x.request_id = q.id AND x.recovery_guard = q.guard)), 0);
  r := r || jsonb_build_object('code', 'buyer_headroom',
    'ok', v_identity IS NOT NULL AND v_cap IS NOT NULL AND v_held + v_inbound + v_pending_in + c.units <= v_cap,
    'detail', format('identity holds %s + other cases %s + pending %s + %s; cap %s', v_held, v_inbound, v_pending_in, c.units, coalesce(v_cap::text, 'unknown')));

  -- Lock-up (TR-12), exit block (S-05 hook).
  IF c.consideration = 'court_order' THEN
    r := r || jsonb_build_object('code', 'lockup', 'ok', true, 'detail', 'court orders are exempt from the lock-up');
  ELSE
    r := r || jsonb_build_object('code', 'lockup',
      'ok', o.completed_at IS NOT NULL AND v_now >= o.completed_at + make_interval(months => transfer.num('lockup_months')::integer),
      'detail', CASE WHEN o.completed_at IS NULL THEN 'no completed offering: the lock-up end is unknown'
                     ELSE format('lock-up ends %s UTC', to_char((o.completed_at + make_interval(months => transfer.num('lockup_months')::integer)) AT TIME ZONE 'UTC', 'YYYY-MM-DD')) END);
  END IF;
  v_bool := NOT EXISTS (SELECT 1 FROM transfer.blocks b WHERE b.token = c.token AND b.closed_at IS NULL);
  r := r || jsonb_build_object('code', 'exit', 'ok', v_bool, 'detail', CASE WHEN v_bool THEN 'no exit or incident block' ELSE 'the token is blocked (exit or incident)' END);

  -- Price band and minimum holding (decided at completion and approval).
  IF p_stage IN ('complete', 'approve') THEN
    IF c.consideration = 'sale' THEN
      SELECT * INTO v_ref FROM transfer.reference_price(c.token);
      v_band := transfer.num('price_band_ppm');
      r := r || jsonb_build_object('code', 'price_band',
        'ok', c.price_explanation IS NOT NULL OR (v_ref.price_paisa IS NOT NULL AND abs(c.price_paisa - v_ref.price_paisa)::numeric * 1000000 <= v_band * v_ref.price_paisa),
        'detail', CASE WHEN v_ref.price_paisa IS NULL THEN 'no reference price' ELSE format('price %s vs reference %s (%s), band %s ppm', c.price_paisa, v_ref.price_paisa, v_ref.source, v_band) END
                  || CASE WHEN c.price_explanation IS NOT NULL THEN '; explanation recorded' ELSE '' END);
    END IF;
    v_remaining := v_balance - c.units;
    r := r || jsonb_build_object('code', 'min_holding',
      'ok', v_remaining <= 0 OR o.min_units IS NULL OR v_remaining >= o.min_units OR c.holding_reason IS NOT NULL,
      'detail', format('seller keeps %s (offering minimum %s)%s', greatest(v_remaining, 0), coalesce(o.min_units::text, 'none'),
                       CASE WHEN c.holding_reason IS NOT NULL THEN '; reason recorded' ELSE '' END));
  END IF;

  -- The buyer's money in the case's escrow (DvP) before the proposal and the execution.
  IF p_stage IN ('payment', 'execute') AND c.consideration = 'sale' THEN
    r := r || jsonb_build_object('code', 'escrow', 'ok', transfer.escrow_ok(c),
      'detail', format('escrow holds %s of %s paisa', transfer.escrow_held(c.case_uuid), c.total_paisa));
  END IF;

  -- The signing policies that will carry the case.
  v_bool := true;
  FOREACH k IN ARRAY ARRAY['transfer.propose', 'transfer.execute', 'transfer.cancel'] LOOP
    v_policy := transfer.policy(k);
    v_bool := v_bool AND v_policy IS NOT NULL AND lower(v_policy->>'recoveryGuard') = c.recovery_guard AND lower(v_policy->>'token') = c.token
              AND lower(v_policy->>'identityRegistry') = c.identity_registry;
  END LOOP;
  r := r || jsonb_build_object('code', 'policy', 'ok', v_bool,
    'detail', CASE WHEN v_bool THEN 'transfer signing policies active' ELSE 'no active transfer.propose/execute/cancel policies for this token and RecoveryGuard' END);
  RETURN r;
END $$;

/** Runs the checks of a stage and records them when the result differs from the last run of that stage. */
CREATE FUNCTION transfer.run_checks(p_case bigint, p_stage text, p_actor text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, transfer AS $$
DECLARE
  v_results jsonb := transfer.check_results(p_case, p_stage);
  v_last jsonb;
  v_codes text[] := transfer.failed_codes(v_results);
BEGIN
  SELECT x.results INTO v_last FROM transfer.checks x WHERE x.case_id = p_case AND x.stage = p_stage ORDER BY x.id DESC LIMIT 1;
  IF v_last IS NULL OR transfer.failed_codes(v_last) IS DISTINCT FROM v_codes THEN
    INSERT INTO transfer.checks (case_id, stage, passed, results, actor) VALUES (p_case, p_stage, cardinality(v_codes) = 0, v_results, left(p_actor, 100));
    PERFORM transfer.audit_append(p_actor, 'case.checked', jsonb_build_object('case', p_case, 'stage', p_stage, 'failed', to_jsonb(v_codes)));
  END IF;
  RETURN v_results;
END $$;

-- ================================================================== state moves and notifications
/** Investor-facing name of a state (never a reason: tipping-off). */
CREATE FUNCTION transfer.public_status(p_status text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_status
    WHEN 'requested' THEN 'under_review' WHEN 'checks' THEN 'under_review' WHEN 'rejected' THEN 'not_approved'
    WHEN 'awaiting_cash' THEN 'approved' WHEN 'proposed' THEN 'on_chain' WHEN 'executed' THEN 'transferred' WHEN 'settled' THEN 'completed'
    WHEN 'cancelling' THEN 'being_cancelled' WHEN 'failed' THEN 'being_cancelled' WHEN 'refunding' THEN 'refund_pending'
    WHEN 'cancelled' THEN 'cancelled' WHEN 'disputed' THEN 'under_review' ELSE 'under_review' END
$$;

CREATE FUNCTION transfer.notify_parties(c transfer.cases, p_status text, p_actor text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, transfer AS $$
DECLARE
  s uuid;
BEGIN
  FOREACH s IN ARRAY ARRAY[c.seller_subject, c.buyer_subject] LOOP
    PERFORM notify.enqueue(format('transfer:%s:%s:%s', c.id, p_status, s), 'transfer.status_changed', 'investor', s::text,
                           jsonb_build_object('status', p_status), p_actor);
  END LOOP;
END $$;

/** Moves a case along the state machine: event row, audit entry, the parties' notification. */
CREATE FUNCTION transfer.move(p_case bigint, p_to text, p_actor text, p_reason text) RETURNS transfer.cases
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, transfer AS $$
DECLARE
  c transfer.cases;
  v_from text;
BEGIN
  SELECT status INTO v_from FROM transfer.cases WHERE id = p_case;
  UPDATE transfer.cases SET status = p_to, updated_at = date_trunc('microseconds', clock_timestamp()) WHERE id = p_case RETURNING * INTO c;
  INSERT INTO transfer.events (case_id, from_status, to_status, actor, reason) VALUES (p_case, v_from, p_to, left(p_actor, 100), left(coalesce(p_reason, p_to), 500));
  PERFORM transfer.audit_append(p_actor, 'case.' || p_to, jsonb_build_object('case', p_case, 'from', v_from, 'reason', left(coalesce(p_reason, ''), 300)));
  IF transfer.public_status(p_to) IS DISTINCT FROM transfer.public_status(v_from) OR p_to IN ('awaiting_cash', 'executed', 'settled') THEN
    PERFORM transfer.notify_parties(c, transfer.public_status(p_to), p_actor);
  END IF;
  RETURN c;
END $$;

CREATE FUNCTION transfer.need_role(p_actor text, p_roles text[], p_what text) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, transfer AS $$
BEGIN
  IF p_actor IS NULL OR NOT admin.officer_holds(p_actor, p_roles, true) THEN
    PERFORM transfer.fail('42501', format('%s needs an active PT Control officer holding %s', p_what, array_to_string(p_roles, ' or ')));
  END IF;
END $$;

/** What officers review (bound to every decision): parties, terms, state, decisions, checks, cash operations. */
CREATE FUNCTION transfer.case_digest(p_case bigint) RETURNS bytea
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, transfer AS $$
  SELECT sha256(convert_to('pt-transfer-case-v1' || jsonb_build_array(
    c.id, c.status, c.token, c.seller_subject, c.seller_wallet, c.buyer_subject, c.buyer_wallet, c.units, c.consideration, c.price_paisa,
    encode(c.agreement_sha256, 'hex'), c.no_price_reason, c.price_explanation, c.holding_reason, c.accepted_at IS NOT NULL, c.completed_by,
    c.paid_ref, c.request_id, c.executed_tx, c.cancelled_by,
    coalesce((SELECT jsonb_agg(jsonb_build_array(d.capacity, d.officer, d.decision) ORDER BY d.id) FROM transfer.decisions d WHERE d.case_id = c.id), '[]'),
    (SELECT max(x.id) FROM transfer.checks x WHERE x.case_id = c.id),
    coalesce((SELECT jsonb_agg(jsonb_build_array(o.id, o.kind, o.status, o.net_paisa) ORDER BY o.id) FROM transfer.cash_ops o WHERE o.case_id = c.id), '[]')
  )::text, 'UTF8'))
  FROM transfer.cases c WHERE c.id = p_case
$$;

/** Evidence hash given to RecoveryGuard: the case, its agreement, its approvals and the approval checks. */
CREATE FUNCTION transfer.evidence_hash(p_case bigint) RETURNS bytea
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, transfer AS $$
  SELECT sha256(convert_to('pt-transfer-evidence-v1' || jsonb_build_array(
    c.case_uuid, encode(c.agreement_sha256, 'hex'), c.seller_wallet, c.buyer_wallet, c.units, c.consideration, c.price_paisa,
    coalesce((SELECT jsonb_agg(jsonb_build_array(d.capacity, d.officer, encode(d.digest, 'hex')) ORDER BY d.id) FROM transfer.decisions d WHERE d.case_id = c.id), '[]')
  )::text, 'UTF8'))
  FROM transfer.cases c WHERE c.id = p_case
$$;

-- ================================================================== opening (T1, TR-B3)
CREATE FUNCTION transfer.insert_case(p_origin text, p_seller uuid, p_buyer uuid, p_token text, p_units bigint, p_consideration text, p_price bigint,
                                     p_no_price_reason text, p_agreement bytea, p_explanation text, p_holding_reason text, p_actor text)
RETURNS transfer.cases LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, transfer AS $$
DECLARE
  v_policy jsonb := transfer.policy('transfer.propose');
  v_token text := lower(btrim(p_token));
  v_seller_wallet text;
  v_buyer_wallet text;
  v_uuid uuid := gen_random_uuid();
  v_now timestamptz := date_trunc('microseconds', clock_timestamp());
  c transfer.cases;
BEGIN
  IF p_consideration IS NULL OR p_consideration NOT IN ('sale', 'gift', 'family', 'court_order') THEN
    PERFORM transfer.fail('23514', 'consideration must be sale, gift, family or court_order');
  END IF;
  IF p_units IS NULL OR p_units < 1 OR p_units > 1000000000000 THEN PERFORM transfer.fail('23514', 'units are a whole number of at least 1 (TR-13)'); END IF;
  IF p_consideration = 'sale' AND (p_price IS NULL OR p_price < 1 OR p_no_price_reason IS NOT NULL) THEN
    PERFORM transfer.fail('23514', 'a sale needs a price per unit in paisa (and no no-consideration reason)');
  END IF;
  IF p_consideration = 'sale' AND p_units::numeric * p_price::numeric > 1000000000000000 THEN
    PERFORM transfer.fail('23514', 'the total price is above the payment limit');
  END IF;
  IF p_consideration <> 'sale' AND (p_price IS NOT NULL OR NOT compliance.free_text_ok(p_no_price_reason, 10, 500)) THEN
    PERFORM transfer.fail('23514', 'a transfer without consideration has no price and needs a reason of 10 to 500 characters (never a CNIC, IBAN or phone number)');
  END IF;
  IF p_agreement IS NULL OR length(p_agreement) <> 32 THEN PERFORM transfer.fail('23514', 'the SHA-256 of the signed transfer agreement (or court order) is required'); END IF;
  IF (p_explanation IS NOT NULL AND NOT compliance.free_text_ok(p_explanation, 10, 1000))
     OR (p_holding_reason IS NOT NULL AND NOT compliance.free_text_ok(p_holding_reason, 10, 500)) THEN
    PERFORM transfer.fail('23514', 'explanations are 10 to 1000 characters and never carry a CNIC, IBAN or phone number');
  END IF;
  IF p_seller IS NULL OR p_buyer IS NULL OR p_seller = p_buyer THEN PERFORM transfer.fail('23514', 'seller and buyer are two different investors'); END IF;
  IF v_policy IS NULL THEN PERFORM transfer.fail('23514', 'no active transfer.propose signing policy: nothing could be executed'); END IF;
  IF NOT transfer.is_address(v_token) OR lower(v_policy->>'token') IS DISTINCT FROM v_token THEN
    PERFORM transfer.fail('23514', 'the token is not the one the transfer signing policy names');
  END IF;
  SELECT w.wallet INTO v_seller_wallet FROM kyc.wallets w WHERE w.subject_id = p_seller;
  SELECT w.wallet INTO v_buyer_wallet FROM kyc.wallets w WHERE w.subject_id = p_buyer;
  IF v_seller_wallet IS NULL OR v_buyer_wallet IS NULL THEN PERFORM transfer.fail('P0002', 'both investors need a bound wallet'); END IF;
  PERFORM pg_advisory_xact_lock(586586281);
  INSERT INTO transfer.cases (case_uuid, case_ref, origin, token, recovery_guard, identity_registry, seller_subject, seller_wallet, buyer_subject, buyer_wallet,
                              units, consideration, price_paisa, total_paisa, no_price_reason, agreement_sha256, price_explanation, holding_reason,
                              opened_by, opened_at, accepted_at, updated_at)
  VALUES (v_uuid, transfer.new_case_ref(v_uuid), p_origin, v_token, lower(v_policy->>'recoveryGuard'), lower(v_policy->>'identityRegistry'),
          p_seller, v_seller_wallet, p_buyer, v_buyer_wallet, p_units, p_consideration, p_price,
          CASE WHEN p_consideration = 'sale' THEN p_units * p_price END, nullif(btrim(p_no_price_reason), ''), p_agreement,
          nullif(btrim(p_explanation), ''), nullif(btrim(p_holding_reason), ''), p_actor, v_now,
          CASE WHEN p_origin = 'desk' THEN v_now END, v_now)
  RETURNING * INTO c;
  INSERT INTO transfer.events (case_id, from_status, to_status, actor, reason) VALUES (c.id, NULL, 'requested', left(p_actor, 100), 'opened by the ' || p_origin);
  PERFORM transfer.audit_append(p_actor, 'case.opened', jsonb_build_object('case', c.id, 'uuid', c.case_uuid, 'origin', p_origin, 'token', v_token,
    'seller', p_seller, 'buyer', p_buyer, 'units', p_units, 'consideration', p_consideration, 'price', p_price,
    'agreement', encode(p_agreement, 'hex'), 'caseId', transfer.case_id_hex(c.case_ref)));
  -- Section 11: the seller's contacts of record are alerted at every request (account-takeover defence).
  PERFORM notify.enqueue(format('transfer:%s:requested', c.id), 'security.transfer_requested', 'investor', p_seller::text,
                         jsonb_build_object('at', transfer.utc_s(v_now)), p_actor);
  RETURN c;
END $$;

/** Transfer desk (operations maker): any consideration, parties named by their KYC subject. */
CREATE FUNCTION transfer.open_desk(p_seller uuid, p_buyer uuid, p_token text, p_units bigint, p_consideration text, p_price bigint,
                                   p_no_price_reason text, p_agreement bytea, p_explanation text, p_holding_reason text, p_actor text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, transfer AS $$
DECLARE
  c transfer.cases;
BEGIN
  PERFORM transfer.need_role(p_actor, ARRAY['ops_maker'], 'opening a transfer at the desk');
  c := transfer.insert_case('desk', p_seller, p_buyer, p_token, p_units, p_consideration, p_price, p_no_price_reason, p_agreement, p_explanation,
                            p_holding_reason, p_actor);
  RETURN c.id;
END $$;

/** Website: the buyer's receive code (TR-B3), at most three live at a time. */
CREATE FUNCTION transfer.web_new_code(p_subject uuid, p_actor text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, transfer AS $$
DECLARE
  v_code text;
  v_now timestamptz := date_trunc('microseconds', clock_timestamp());
  v_until timestamptz;
BEGIN
  IF kyc.subject_status(p_subject) <> 'verified' THEN PERFORM transfer.fail('42501', 'only a KYC-verified investor can receive units'); END IF;
  IF NOT EXISTS (SELECT 1 FROM kyc.wallets w WHERE w.subject_id = p_subject) THEN PERFORM transfer.fail('42501', 'only an investor with a wallet can receive units'); END IF;
  PERFORM pg_advisory_xact_lock(586586282, hashtext(p_subject::text));
  IF (SELECT count(*) FROM transfer.receive_codes r WHERE r.subject_id = p_subject AND r.used_at IS NULL AND r.expires_at > v_now) >= 3 THEN
    PERFORM transfer.fail('23514', 'three receive codes are already live: use one of them');
  END IF;
  v_until := v_now + make_interval(hours => transfer.num('receive_code_hours')::integer);
  LOOP
    v_code := transfer.new_code('TR');
    EXIT WHEN NOT EXISTS (SELECT 1 FROM transfer.receive_codes WHERE code = v_code);
  END LOOP;
  INSERT INTO transfer.receive_codes (code, subject_id, created_by, created_at, expires_at) VALUES (v_code, p_subject, p_actor, v_now, v_until);
  PERFORM transfer.audit_append(p_actor, 'code.created', jsonb_build_object('code', v_code, 'subject', p_subject, 'expiresAt', transfer.utc(v_until)));
  RETURN jsonb_build_object('code', v_code, 'expiresAt', transfer.utc(v_until));
END $$;

/** Website: the seller requests a transfer to the holder of a receive code (sale, gift or family). */
CREATE FUNCTION transfer.web_request(p_seller uuid, p_token text, p_units bigint, p_code text, p_consideration text, p_price bigint,
                                     p_no_price_reason text, p_agreement bytea, p_explanation text, p_holding_reason text, p_actor text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, transfer AS $$
DECLARE
  rc transfer.receive_codes;
  c transfer.cases;
BEGIN
  IF p_consideration = 'court_order' THEN PERFORM transfer.fail('23514', 'court-ordered transfers are opened by the transfer desk'); END IF;
  IF kyc.subject_status(p_seller) <> 'verified' THEN PERFORM transfer.fail('42501', 'only a KYC-verified investor can request a transfer'); END IF;
  SELECT * INTO rc FROM transfer.receive_codes WHERE code = upper(btrim(coalesce(p_code, ''))) FOR UPDATE;
  IF NOT FOUND OR rc.used_at IS NOT NULL OR rc.expires_at <= clock_timestamp() THEN
    PERFORM transfer.fail('P0002', 'the receive code is unknown, used or expired: ask the buyer for a new one');
  END IF;
  IF rc.subject_id = p_seller THEN PERFORM transfer.fail('23514', 'this is your own receive code'); END IF;
  c := transfer.insert_case('investor', p_seller, rc.subject_id, p_token, p_units, p_consideration, p_price, p_no_price_reason, p_agreement,
                            p_explanation, p_holding_reason, p_actor);
  UPDATE transfer.receive_codes SET used_at = c.opened_at, case_id = c.id WHERE code = rc.code;
  PERFORM transfer.audit_append(p_actor, 'code.used', jsonb_build_object('code', rc.code, 'case', c.id));
  RETURN c.case_uuid;
END $$;

/** Website: the buyer accepts by re-entering the agreement's SHA-256 (both signed the same document). */
CREATE FUNCTION transfer.web_accept(p_buyer uuid, p_case uuid, p_agreement bytea, p_actor text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, transfer AS $$
DECLARE
  c transfer.cases;
BEGIN
  SELECT * INTO c FROM transfer.cases WHERE case_uuid = p_case FOR UPDATE;
  IF NOT FOUND OR c.buyer_subject IS DISTINCT FROM p_buyer THEN PERFORM transfer.fail('P0002', 'transfer not found'); END IF;
  IF c.status <> 'requested' OR c.accepted_at IS NOT NULL THEN PERFORM transfer.fail('23514', 'this transfer is not waiting for your acceptance'); END IF;
  IF kyc.subject_status(p_buyer) <> 'verified' THEN PERFORM transfer.fail('42501', 'only a KYC-verified investor can accept a transfer'); END IF;
  IF p_agreement IS DISTINCT FROM c.agreement_sha256 THEN
    PERFORM transfer.fail('23514', 'the agreement fingerprint differs from the seller''s: check that you both signed the same document');
  END IF;
  UPDATE transfer.cases SET accepted_at = date_trunc('microseconds', clock_timestamp()), updated_at = clock_timestamp() WHERE id = c.id;
  PERFORM transfer.audit_append(p_actor, 'case.accepted', jsonb_build_object('case', c.id));
  PERFORM transfer.notify_parties(c, 'accepted', p_actor);
  RETURN 'requested';
END $$;

-- ================================================================== surveillance (TR-23)
CREATE FUNCTION transfer.alert(c transfer.cases, p_rule text, p_subject uuid, p_category text, p_detail text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, transfer AS $$
DECLARE
  v_str bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM transfer.alerts a WHERE a.case_id = c.id AND a.rule = p_rule AND a.subject_id = p_subject) THEN RETURN; END IF;
  v_str := compliance.open_str(p_subject, p_category, format('Transfer surveillance, transfer case %s: %s', c.id, p_detail), 'system:transfer-surveillance');
  INSERT INTO transfer.alerts (case_id, rule, subject_id, detail, str_case_id) VALUES (c.id, p_rule, p_subject, left(p_detail, 300), v_str);
  PERFORM transfer.audit_append('system:transfer-surveillance', 'alert.raised', jsonb_build_object('case', c.id, 'rule', p_rule, 'str', v_str));
END $$;

CREATE FUNCTION transfer.surveil(c transfer.cases) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, transfer AS $$
DECLARE
  v_ref record;
  v_n integer := 0;
  s uuid;
BEGIN
  IF c.consideration = 'sale' THEN
    SELECT * INTO v_ref FROM transfer.reference_price(c.token);
    IF v_ref.price_paisa IS NULL OR abs(c.price_paisa - v_ref.price_paisa)::numeric * 1000000 > transfer.num('price_band_ppm') * v_ref.price_paisa THEN
      PERFORM transfer.alert(c, 'price_outside_band', c.seller_subject, 'unusual_pattern',
        'agreed price outside the reference price band (AML value transfer review)');
      v_n := v_n + 1;
    END IF;
    IF EXISTS (SELECT 1 FROM transfer.party_links l WHERE l.subject_a = least(c.seller_subject, c.buyer_subject) AND l.subject_b = greatest(c.seller_subject, c.buyer_subject)) THEN
      PERFORM transfer.alert(c, 'linked_parties', c.seller_subject, 'unusual_pattern', 'sale between investors with a declared link (possible self-dealing)');
      v_n := v_n + 1;
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM transfer.cases x WHERE x.id <> c.id AND x.token = c.token AND x.seller_subject = c.buyer_subject AND x.buyer_subject = c.seller_subject
             AND x.status <> 'rejected' AND x.opened_at > clock_timestamp() - make_interval(days => transfer.num('round_trip_days')::integer)) THEN
    PERFORM transfer.alert(c, 'round_trip', c.seller_subject, 'rapid_in_out', 'opposite transfer between the same two investors within the round-trip window');
    v_n := v_n + 1;
  END IF;
  FOREACH s IN ARRAY ARRAY[c.seller_subject, c.buyer_subject] LOOP
    IF (SELECT count(*) FROM transfer.cases x WHERE (x.seller_subject = s OR x.buyer_subject = s) AND x.opened_at > clock_timestamp() - interval '30 days')
       > transfer.num('max_cases_30d') THEN
      PERFORM transfer.alert(c, 'frequent', s, 'unusual_pattern', 'more transfers in 30 days than the surveillance limit');
      v_n := v_n + 1;
    END IF;
  END LOOP;
  RETURN v_n;
END $$;

/** Requests a re-screening for a party whose screening is stale (idempotent: one live request per investor). */
CREATE FUNCTION transfer.request_rescreens(c transfer.cases, p_results jsonb, p_actor text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, transfer AS $$
DECLARE
  v_codes text[] := transfer.failed_codes(p_results);
BEGIN
  IF 'seller_screened' = ANY (v_codes) AND NOT EXISTS (SELECT 1 FROM compliance.rescreens x WHERE x.subject_id = c.seller_subject AND x.status IN ('queued', 'running')) THEN
    PERFORM compliance.request_rescreen(c.seller_subject, 'system:transfer', 'a transfer case needs a fresh sanctions screening of this investor');
  END IF;
  IF 'buyer_screened' = ANY (v_codes) AND NOT EXISTS (SELECT 1 FROM compliance.rescreens x WHERE x.subject_id = c.buyer_subject AND x.status IN ('queued', 'running')) THEN
    PERFORM compliance.request_rescreen(c.buyer_subject, 'system:transfer', 'a transfer case needs a fresh sanctions screening of this investor');
  END IF;
END $$;

/** T1: the desk completes a request (agreement checked, checks recorded, surveillance) -> checks. */
CREATE FUNCTION transfer.complete(p_case bigint, p_actor text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, transfer AS $$
DECLARE
  c transfer.cases;
  v_results jsonb;
BEGIN
  PERFORM transfer.need_role(p_actor, ARRAY['ops_maker'], 'completing a transfer request');
  SELECT * INTO c FROM transfer.cases WHERE id = p_case FOR UPDATE;
  IF NOT FOUND THEN PERFORM transfer.fail('P0002', 'unknown transfer case'); END IF;
  IF c.status <> 'requested' THEN PERFORM transfer.fail('23514', format('the case is %s', c.status)); END IF;
  IF c.accepted_at IS NULL THEN PERFORM transfer.fail('23514', 'the buyer has not accepted the request yet'); END IF;
  UPDATE transfer.cases SET completed_by = p_actor, completed_at = date_trunc('microseconds', clock_timestamp()) WHERE id = c.id;
  v_results := transfer.run_checks(c.id, 'complete', p_actor);
  PERFORM transfer.request_rescreens(c, v_results, p_actor);
  c := transfer.move(c.id, 'checks', p_actor, 'request completed by the transfer desk');
  PERFORM transfer.surveil(c);
  RETURN 'checks';
END $$;

-- ================================================================== decisions and approval (T3/T4, XF-3)
CREATE FUNCTION transfer.capacity_roles(p_capacity text) RETURNS text[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_capacity WHEN 'compliance' THEN ARRAY['compliance_officer'] WHEN 'trustee' THEN ARRAY['trustee_officer'] END
$$;

CREATE FUNCTION transfer.has_conflict(p_officer text, c transfer.cases) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, transfer AS $$
  SELECT EXISTS (SELECT 1 FROM transfer.conflicts x WHERE x.officer = p_officer AND x.subject_id IN (c.seller_subject, c.buyer_subject))
$$;

CREATE FUNCTION transfer.enqueue_propose(c transfer.cases, p_actor text) RETURNS transfer.cases
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, transfer AS $$
DECLARE
  v_key text := format('transfer.propose:case:%s', c.id);
BEGIN
  PERFORM outbox.enqueue(v_key, 'transfer.propose',
    jsonb_build_object('recoveryGuard', c.recovery_guard, 'kind', 'forced_transfer', 'from', c.seller_wallet, 'to', c.buyer_wallet,
                       'onchainId', transfer.zero_address(), 'amount', c.units::text, 'evidenceHash', '0x' || encode(c.evidence_hash, 'hex'),
                       'caseId', transfer.case_id_hex(c.case_ref)),
    c.case_uuid::text, p_actor);
  UPDATE transfer.cases SET propose_key = v_key, updated_at = clock_timestamp() WHERE id = c.id RETURNING * INTO c;
  PERFORM transfer.audit_append(p_actor, 'command.propose', jsonb_build_object('case', c.id, 'command', v_key));
  RETURN c;
END $$;

CREATE FUNCTION transfer.enqueue_execute(c transfer.cases, p_actor text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, transfer AS $$
DECLARE
  v_key text := format('transfer.execute:case:%s:%s', c.id, c.execute_attempts + 1);
BEGIN
  PERFORM outbox.enqueue(v_key, 'transfer.execute',
    jsonb_build_object('recoveryGuard', c.recovery_guard, 'requestId', c.request_id::text, 'caseId', transfer.case_id_hex(c.case_ref)),
    c.case_uuid::text, p_actor);
  UPDATE transfer.cases SET execute_key = v_key, execute_attempts = c.execute_attempts + 1, updated_at = clock_timestamp() WHERE id = c.id;
  PERFORM transfer.audit_append(p_actor, 'command.execute', jsonb_build_object('case', c.id, 'command', v_key));
END $$;

CREATE FUNCTION transfer.enqueue_cancel(c transfer.cases, p_actor text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, transfer AS $$
DECLARE
  v_key text := format('transfer.cancel:case:%s:%s', c.id, c.cancel_attempts + 1);
BEGIN
  PERFORM outbox.enqueue(v_key, 'transfer.cancel',
    jsonb_build_object('recoveryGuard', c.recovery_guard, 'requestId', c.request_id::text, 'caseId', transfer.case_id_hex(c.case_ref)),
    c.case_uuid::text, p_actor);
  UPDATE transfer.cases SET cancel_key = v_key, cancel_attempts = c.cancel_attempts + 1, updated_at = clock_timestamp() WHERE id = c.id;
  PERFORM transfer.audit_append(p_actor, 'command.cancel', jsonb_build_object('case', c.id, 'command', v_key));
END $$;

/** T4 final approval: evidence hash, then the payment code (sale) or the on-chain proposal (no consideration). */
CREATE FUNCTION transfer.start(c transfer.cases, p_actor text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, transfer AS $$
DECLARE
  v_now timestamptz := date_trunc('microseconds', clock_timestamp());
  v_code text;
  v_hours integer := transfer.num('payment_hours')::integer;
BEGIN
  UPDATE transfer.cases SET approved_at = v_now, evidence_hash = transfer.evidence_hash(c.id), updated_at = v_now WHERE id = c.id RETURNING * INTO c;
  PERFORM transfer.audit_append(p_actor, 'case.approved', jsonb_build_object('case', c.id, 'evidenceHash', encode(c.evidence_hash, 'hex')));
  IF c.consideration = 'sale' THEN
    PERFORM ledger.open_account(transfer.escrow_account(c.case_uuid), 'liability', 'PKR', false);
    LOOP
      v_code := transfer.new_code('PT');
      EXIT WHEN NOT EXISTS (SELECT 1 FROM bank.payment_intents WHERE code = v_code);
    END LOOP;
    PERFORM bank.create_intent(v_code, 'transfer', c.buyer_subject, c.total_paisa, format('xfer:%s:paid', c.case_uuid),
                               transfer.escrow_account(c.case_uuid), v_hours * 60, p_actor);
    UPDATE transfer.cases SET intent_code = v_code, pay_until = (SELECT expires_at FROM bank.payment_intents WHERE code = v_code) WHERE id = c.id RETURNING * INTO c;
    c := transfer.move(c.id, 'awaiting_cash', p_actor, 'approved: waiting for the buyer''s payment into escrow (T5)');
    PERFORM notify.enqueue(format('transfer:%s:payment_due', c.id), 'transfer.payment_due', 'investor', c.buyer_subject::text,
      jsonb_build_object('amount_paisa', c.total_paisa::text, 'reference', v_code, 'expires_at', transfer.utc_s(c.pay_until)), p_actor);
    RETURN 'awaiting_cash';
  END IF;
  c := transfer.enqueue_propose(c, p_actor);
  PERFORM transfer.move(c.id, 'proposed', p_actor, 'approved without consideration: on-chain proposal enqueued (T6)');
  RETURN 'proposed';
END $$;

CREATE FUNCTION transfer.decide(p_case bigint, p_actor text, p_capacity text, p_decision text, p_reason text, p_digest bytea)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, transfer AS $$
DECLARE
  c transfer.cases;
  v_now timestamptz := date_trunc('microseconds', clock_timestamp());
  v_results jsonb;
  v_failed text[];
BEGIN
  IF p_decision IS NULL OR p_decision NOT IN ('approve', 'reject') THEN PERFORM transfer.fail('22023', 'decision must be approve or reject'); END IF;
  IF p_capacity IS NULL OR p_capacity NOT IN ('compliance', 'trustee') THEN PERFORM transfer.fail('22023', 'capacity must be compliance or trustee'); END IF;
  IF NOT compliance.free_text_ok(p_reason, 10, 500) THEN
    PERFORM transfer.fail('23514', 'a reason of 10 to 500 characters is required (never a CNIC, IBAN or phone number)');
  END IF;
  PERFORM transfer.need_role(p_actor, transfer.capacity_roles(p_capacity), format('deciding as %s', p_capacity));
  SELECT * INTO c FROM transfer.cases WHERE id = p_case FOR UPDATE;
  IF NOT FOUND THEN PERFORM transfer.fail('P0002', 'unknown transfer case'); END IF;
  IF p_digest IS NULL OR transfer.case_digest(c.id) IS DISTINCT FROM p_digest THEN
    PERFORM transfer.fail('23514', 'the case differs from what you reviewed: reload and check again');
  END IF;
  IF c.status <> 'checks' THEN PERFORM transfer.fail('23514', format('the case is %s', c.status)); END IF;
  IF p_actor IN (c.opened_by, c.completed_by) THEN PERFORM transfer.fail('23514', 'maker-checker: the officer who opened or completed the case cannot decide it (TR-SOD-1)'); END IF;
  IF transfer.has_conflict(p_actor, c) THEN PERFORM transfer.fail('23514', 'you declared a conflict with a party: a different officer decides (TR-SOD-2)'); END IF;
  IF EXISTS (SELECT 1 FROM transfer.decisions d WHERE d.case_id = c.id AND d.officer = p_actor) THEN
    PERFORM transfer.fail('23514', 'you already decided this case: a different officer decides in the other capacity');
  END IF;
  IF EXISTS (SELECT 1 FROM transfer.decisions d WHERE d.case_id = c.id AND d.capacity = p_capacity) THEN
    PERFORM transfer.fail('23505', format('the %s decision was already taken', p_capacity));
  END IF;
  IF p_decision = 'approve' THEN
    v_results := transfer.run_checks(c.id, 'approve', p_actor);
    v_failed := transfer.failed_codes(v_results);
    IF cardinality(v_failed) > 0 THEN
      PERFORM transfer.request_rescreens(c, v_results, p_actor);
      PERFORM transfer.fail('23514', format('checks failed: %s (TR-10)', array_to_string(v_failed, ', ')));
    END IF;
  END IF;
  INSERT INTO transfer.decisions (case_id, capacity, officer, decision, reason, digest, at) VALUES (c.id, p_capacity, p_actor, p_decision, btrim(p_reason), p_digest, v_now);
  PERFORM transfer.audit_append(p_actor, 'case.decided', jsonb_build_object('case', c.id, 'capacity', p_capacity, 'decision', p_decision,
    'reason', btrim(p_reason), 'digest', encode(p_digest, 'hex')));
  IF p_decision = 'reject' THEN
    PERFORM transfer.move(c.id, 'rejected', p_actor, format('rejected by %s (T3)', p_capacity));
    RETURN 'rejected';
  END IF;
  IF (SELECT count(*) FROM transfer.decisions d WHERE d.case_id = c.id AND d.decision = 'approve') < 2 THEN
    UPDATE transfer.cases SET updated_at = v_now WHERE id = c.id;
    RETURN 'checks';
  END IF;
  RETURN transfer.start(c, p_actor);
END $$;

-- ================================================================== withdrawal, cancellation, dispute (T2, T9, T15)
CREATE FUNCTION transfer.set_cancel(p_case bigint, p_actor text, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, transfer AS $$
BEGIN
  UPDATE transfer.cases SET cancelled_by = left(p_actor, 100), cancel_reason = left(btrim(p_reason), 500), updated_at = clock_timestamp()
  WHERE id = p_case AND cancelled_by IS NULL;
END $$;

/** T2 internal: a party (website) or the desk on a party's behalf, before any payment is booked. */
CREATE FUNCTION transfer.withdraw_case(c transfer.cases, p_actor text, p_reason text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, transfer AS $$
BEGIN
  IF c.status NOT IN ('requested', 'checks', 'awaiting_cash') OR c.paid_ref IS NOT NULL THEN
    PERFORM transfer.fail('23514', 'the transfer can no longer be withdrawn (payment booked or on chain): contact the transfer desk');
  END IF;
  IF c.status = 'awaiting_cash' THEN
    -- Same lock as the bank's booking: a payment that wins the race is booked and the withdrawal refused.
    PERFORM bank.cancel_intent(c.intent_code, p_actor, 'transfer withdrawn by a party before payment (T2)');
  END IF;
  PERFORM transfer.set_cancel(c.id, p_actor, p_reason);
  PERFORM transfer.move(c.id, 'cancelled', p_actor, 'withdrawn (T2)');
  RETURN 'cancelled';
END $$;

CREATE FUNCTION transfer.web_withdraw(p_subject uuid, p_case uuid, p_actor text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, transfer AS $$
DECLARE
  c transfer.cases;
BEGIN
  SELECT * INTO c FROM transfer.cases WHERE case_uuid = p_case FOR UPDATE;
  IF NOT FOUND OR p_subject IS NULL OR p_subject NOT IN (c.seller_subject, c.buyer_subject) THEN PERFORM transfer.fail('P0002', 'transfer not found'); END IF;
  RETURN transfer.withdraw_case(c, p_actor, CASE WHEN p_subject = c.seller_subject THEN 'withdrawn by the seller' ELSE 'withdrawn by the buyer' END);
END $$;

/** The desk withdraws for a party who asked in writing (operations maker). */
CREATE FUNCTION transfer.withdraw(p_case bigint, p_actor text, p_reason text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, transfer AS $$
DECLARE
  c transfer.cases;
BEGIN
  PERFORM transfer.need_role(p_actor, ARRAY['ops_maker'], 'withdrawing a transfer for a party');
  IF NOT compliance.free_text_ok(p_reason, 10, 500) THEN PERFORM transfer.fail('23514', 'a reason of 10 to 500 characters is required'); END IF;
  SELECT * INTO c FROM transfer.cases WHERE id = p_case FOR UPDATE;
  IF NOT FOUND THEN PERFORM transfer.fail('P0002', 'unknown transfer case'); END IF;
  RETURN transfer.withdraw_case(c, p_actor, p_reason);
END $$;

/** T9 before execution (compliance or trustee officer); a proposed request is cancelled on chain first. */
CREATE FUNCTION transfer.cancel(p_case bigint, p_actor text, p_reason text, p_digest bytea) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, transfer AS $$
DECLARE
  c transfer.cases;
BEGIN
  PERFORM transfer.need_role(p_actor, ARRAY['compliance_officer', 'trustee_officer'], 'cancelling a transfer');
  IF NOT compliance.free_text_ok(p_reason, 10, 500) THEN PERFORM transfer.fail('23514', 'a reason of 10 to 500 characters is required'); END IF;
  SELECT * INTO c FROM transfer.cases WHERE id = p_case FOR UPDATE;
  IF NOT FOUND THEN PERFORM transfer.fail('P0002', 'unknown transfer case'); END IF;
  IF p_digest IS NULL OR transfer.case_digest(c.id) IS DISTINCT FROM p_digest THEN
    PERFORM transfer.fail('23514', 'the case differs from what you reviewed: reload and check again');
  END IF;
  IF c.status NOT IN ('requested', 'checks', 'awaiting_cash', 'proposed') THEN PERFORM transfer.fail('23514', format('a %s case cannot be cancelled', c.status)); END IF;
  PERFORM transfer.set_cancel(c.id, p_actor, p_reason);
  IF c.status IN ('requested', 'checks') THEN
    PERFORM transfer.move(c.id, 'cancelled', p_actor, 'cancelled by an officer (T9)');
    RETURN 'cancelled';
  END IF;
  IF c.status = 'awaiting_cash' THEN
    IF c.paid_ref IS NOT NULL THEN
      PERFORM transfer.move(c.id, 'refunding', p_actor, 'cancelled by an officer after payment: the buyer is refunded (T13)');
      RETURN 'refunding';
    END IF;
    PERFORM bank.cancel_intent(c.intent_code, p_actor, 'transfer cancelled by an officer before payment (T9)');
    PERFORM transfer.move(c.id, 'cancelled', p_actor, 'cancelled by an officer (T9)');
    RETURN 'cancelled';
  END IF;
  PERFORM transfer.move(c.id, 'cancelling', p_actor, 'cancelled by an officer: the on-chain request is cancelled first (T9)');
  PERFORM transfer.tick_case(c.id, p_actor);
  RETURN (SELECT status FROM transfer.cases WHERE id = c.id);
END $$;

CREATE FUNCTION transfer.dispute(p_case bigint, p_actor text, p_reason text, p_digest bytea) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, transfer AS $$
DECLARE
  c transfer.cases;
BEGIN
  PERFORM transfer.need_role(p_actor, ARRAY['compliance_officer'], 'recording a dispute');
  IF NOT compliance.free_text_ok(p_reason, 10, 500) THEN PERFORM transfer.fail('23514', 'a reason of 10 to 500 characters is required'); END IF;
  SELECT * INTO c FROM transfer.cases WHERE id = p_case FOR UPDATE;
  IF NOT FOUND THEN PERFORM transfer.fail('P0002', 'unknown transfer case'); END IF;
  IF p_digest IS NULL OR transfer.case_digest(c.id) IS DISTINCT FROM p_digest THEN
    PERFORM transfer.fail('23514', 'the case differs from what you reviewed: reload and check again');
  END IF;
  IF c.status NOT IN ('executed', 'settled') THEN PERFORM transfer.fail('23514', 'only an executed or settled transfer can be disputed (T15)'); END IF;
  UPDATE transfer.cases SET disputed_by = p_actor, dispute_reason = btrim(p_reason), status = 'disputed', updated_at = clock_timestamp() WHERE id = c.id;
  INSERT INTO transfer.events (case_id, from_status, to_status, actor, reason) VALUES (c.id, c.status, 'disputed', left(p_actor, 100), 'claim after execution (T15, S-06)');
  PERFORM transfer.audit_append(p_actor, 'case.disputed', jsonb_build_object('case', c.id, 'from', c.status, 'reason', btrim(p_reason)));
  RETURN 'disputed';
END $$;

-- ================================================================== the tick: bank and chain -> case (TR-B7, TR-B11, TR-B12)
CREATE FUNCTION transfer.resolve(p_case bigint, p_actor text, p_reason text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, transfer AS $$
DECLARE
  c transfer.cases;
BEGIN
  SELECT * INTO c FROM transfer.cases WHERE id = p_case;
  IF c.paid_ref IS NOT NULL THEN
    PERFORM transfer.move(c.id, 'refunding', p_actor, p_reason || ': the buyer is refunded (T13)');
    RETURN 'refunding';
  END IF;
  PERFORM transfer.move(c.id, 'cancelled', p_actor, p_reason);
  RETURN 'cancelled';
END $$;

CREATE FUNCTION transfer.mark_executed(c transfer.cases, p_tx text, p_actor text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, transfer AS $$
BEGIN
  UPDATE transfer.cases SET executed_tx = p_tx, executed_at = date_trunc('microseconds', clock_timestamp()) WHERE id = c.id;
  PERFORM transfer.move(c.id, 'executed', p_actor, 'ForcedTransfer executed and the movement is in the read model (T10)');
  -- XF-6 the trustee register; a refusal (register below zero) is a reconciliation finding, not a lost execution.
  BEGIN
    PERFORM trustee.enter(c.token, c.seller_wallet, -c.units, 'transfer', format('transfer:%s:seller', c.case_uuid), p_actor);
    PERFORM trustee.enter(c.token, c.buyer_wallet, c.units, 'transfer', format('transfer:%s:buyer', c.case_uuid), p_actor);
  EXCEPTION WHEN check_violation THEN
    PERFORM transfer.audit_append(p_actor, 'register.refused', jsonb_build_object('case', c.id, 'error', left(SQLERRM, 200)));
  END;
END $$;

CREATE FUNCTION transfer.tick_case(p_case bigint, p_actor text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, transfer AS $$
DECLARE
  c transfer.cases;
  o outbox.commands;
  r chain.recoveries;
  v_ref text;
  v_id numeric;
  v_tx text;
  v_results jsonb;
  v_hard text[];
  v_now timestamptz := date_trunc('microseconds', clock_timestamp());
BEGIN
  SELECT * INTO c FROM transfer.cases WHERE id = p_case FOR UPDATE;
  IF NOT FOUND THEN RETURN 0; END IF;

  IF c.status = 'requested' THEN
    IF c.accepted_at IS NULL AND c.opened_at < v_now - make_interval(days => transfer.num('request_acceptance_days')::integer) THEN
      PERFORM transfer.set_cancel(c.id, p_actor, 'the buyer did not accept in time');
      PERFORM transfer.move(c.id, 'cancelled', p_actor, 'the buyer did not accept within the time allowed');
      RETURN 1;
    END IF;
    RETURN 0;
  END IF;

  IF c.status = 'awaiting_cash' THEN
    IF c.paid_ref IS NULL THEN
      SELECT x.raast_ref INTO v_ref FROM bank.credits x WHERE x.intent_code = c.intent_code AND x.status = 'matched';
      IF v_ref IS NULL THEN
        IF v_now <= c.pay_until THEN RETURN 0; END IF;
        BEGIN
          PERFORM bank.cancel_intent(c.intent_code, p_actor, 'transfer payment deadline passed (T8)');
        EXCEPTION WHEN check_violation THEN
          RETURN 0;  -- the payment won the race: the next tick sees it
        END;
        PERFORM transfer.set_cancel(c.id, p_actor, 'payment deadline missed');
        PERFORM transfer.move(c.id, 'cancelled', p_actor, 'payment deadline missed (T8)');
        RETURN 1;
      END IF;
      UPDATE transfer.cases SET paid_ref = v_ref, paid_at = v_now, updated_at = v_now WHERE id = c.id RETURNING * INTO c;
      PERFORM transfer.audit_append(p_actor, 'case.paid', jsonb_build_object('case', c.id, 'ref', v_ref, 'escrow', transfer.escrow_held(c.case_uuid)));
      PERFORM transfer.notify_parties(c, 'payment_received', p_actor);
    END IF;
    v_results := transfer.run_checks(c.id, 'payment', p_actor);
    v_hard := transfer.hard_codes(v_results);
    IF cardinality(v_hard) > 0 THEN
      PERFORM transfer.set_cancel(c.id, p_actor, format('checks failed after payment: %s', array_to_string(v_hard, ', ')));
      PERFORM transfer.move(c.id, 'refunding', p_actor, 'a check failed after payment (TR-11): the buyer is refunded');
      RETURN 1;
    ELSIF cardinality(transfer.failed_codes(v_results)) > 0 THEN
      PERFORM transfer.request_rescreens(c, v_results, p_actor);
      RETURN 0;
    END IF;
    c := transfer.enqueue_propose(c, p_actor);
    PERFORM transfer.move(c.id, 'proposed', p_actor, 'payment booked in escrow: on-chain proposal enqueued (T7)');
    RETURN 1;
  END IF;

  IF c.status NOT IN ('proposed', 'cancelling', 'failed') THEN RETURN 0; END IF;

  -- Not yet on chain: follow the propose command.
  IF c.request_id IS NULL THEN
    SELECT * INTO o FROM outbox.commands WHERE idempotency_key = c.propose_key;
    IF o.status = 'confirmed' AND o.tx_hash IS NOT NULL THEN
      SELECT (e.args->>'id')::numeric INTO v_id FROM chain.events e
      WHERE e.tx_hash = o.tx_hash AND e.name = 'RecoveryProposed' AND e.address = c.recovery_guard LIMIT 1;
      IF v_id IS NULL THEN RETURN 0; END IF;  -- the indexer has not seen it yet
      SELECT * INTO r FROM chain.recoveries WHERE guard = c.recovery_guard AND id = v_id;
      IF NOT FOUND THEN RETURN 0; END IF;
      IF r.from_addr <> c.seller_wallet OR r.to_addr <> c.buyer_wallet OR r.amount <> c.units OR r.kind <> 'forced_transfer' THEN
        PERFORM transfer.audit_append(p_actor, 'request.mismatch', jsonb_build_object('case', c.id, 'requestId', v_id::text));
        RETURN 0;
      END IF;
      UPDATE transfer.cases SET request_id = v_id, eta = r.eta, updated_at = v_now WHERE id = c.id RETURNING * INTO c;
      PERFORM transfer.audit_append(p_actor, 'request.proposed', jsonb_build_object('case', c.id, 'requestId', v_id::text, 'eta', r.eta, 'tx', o.tx_hash));
      RETURN 1 + transfer.tick_case(c.id, p_actor);
    ELSIF o.id IS NULL OR o.status = 'failed' THEN
      -- Nothing reached the chain and nothing can: the case ends here.
      IF c.status = 'proposed' THEN
        PERFORM transfer.set_cancel(c.id, p_actor, 'the on-chain proposal failed');
        PERFORM transfer.move(c.id, 'failed', p_actor, 'the on-chain proposal failed (T11)');
      END IF;
      PERFORM transfer.resolve(c.id, p_actor, 'nothing reached the chain');
      RETURN 1;
    END IF;
    RETURN 0;  -- in flight or in review: never decide on an unknown outcome
  END IF;

  SELECT * INTO r FROM chain.recoveries WHERE guard = c.recovery_guard AND id = c.request_id;
  IF r.status = 'executed' THEN
    SELECT e.tx_hash INTO v_tx FROM chain.events e
    WHERE e.name = 'RecoveryExecuted' AND e.address = c.recovery_guard AND (e.args->>'id')::numeric = c.request_id LIMIT 1;
    IF v_tx IS NULL THEN RETURN 0; END IF;
    IF EXISTS (SELECT 1 FROM chain.transfers t WHERE t.tx_hash = v_tx AND t.token = c.token AND t.from_addr = c.seller_wallet
               AND t.to_addr = c.buyer_wallet AND t.amount = c.units) THEN
      PERFORM transfer.mark_executed(c, v_tx, p_actor);
      RETURN 1;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM transfer.audit a WHERE a.action = 'execution.mismatch' AND (a.detail->>'case')::bigint = c.id) THEN
      PERFORM transfer.audit_append(p_actor, 'execution.mismatch', jsonb_build_object('case', c.id, 'tx', v_tx));
    END IF;
    RETURN 0;
  ELSIF r.status = 'cancelled' THEN
    IF c.status = 'proposed' THEN
      PERFORM transfer.set_cancel(c.id, p_actor, 'the on-chain request was cancelled by a Safe');
      PERFORM transfer.move(c.id, 'cancelling', p_actor, 'the on-chain request was cancelled (T9)');
    END IF;
    PERFORM transfer.resolve(c.id, p_actor, 'the on-chain request is cancelled');
    RETURN 1;
  ELSIF r.status IS DISTINCT FROM 'pending' THEN
    RETURN 0;
  END IF;

  -- Pending on chain.
  IF c.status IN ('cancelling', 'failed') THEN
    IF c.cancel_key IS NULL THEN
      PERFORM transfer.enqueue_cancel(c, p_actor);
      RETURN 1;
    END IF;
    SELECT * INTO o FROM outbox.commands WHERE idempotency_key = c.cancel_key;
    IF o.status = 'failed' AND c.cancel_attempts < 3 THEN
      PERFORM transfer.enqueue_cancel(c, p_actor);
      RETURN 1;
    END IF;
    RETURN 0;
  END IF;

  -- proposed, pending: wait for eta, re-check (TR-11), execute.
  IF r.eta > extract(epoch FROM clock_timestamp()) THEN RETURN 0; END IF;
  IF c.execute_key IS NOT NULL THEN
    SELECT * INTO o FROM outbox.commands WHERE idempotency_key = c.execute_key;
    IF o.status IS DISTINCT FROM 'failed' THEN RETURN 0; END IF;  -- in flight, in review or confirmed: wait for the read model
    IF c.execute_attempts >= transfer.num('max_execute_attempts') THEN
      PERFORM transfer.set_cancel(c.id, p_actor, 'execution failed repeatedly');
      PERFORM transfer.move(c.id, 'failed', p_actor, format('execution failed %s times: the request is cancelled before any refund (T11)', c.execute_attempts));
      SELECT * INTO c FROM transfer.cases WHERE id = c.id;
      PERFORM transfer.enqueue_cancel(c, p_actor);
      RETURN 1;
    END IF;
  END IF;
  v_results := transfer.run_checks(c.id, 'execute', p_actor);
  v_hard := transfer.hard_codes(v_results);
  IF cardinality(v_hard) > 0 THEN
    PERFORM transfer.set_cancel(c.id, p_actor, format('checks failed before execution: %s', array_to_string(v_hard, ', ')));
    PERFORM transfer.move(c.id, 'cancelling', p_actor, 'a check failed before execution (TR-11): cancelled instead of executed');
    SELECT * INTO c FROM transfer.cases WHERE id = c.id;
    PERFORM transfer.enqueue_cancel(c, p_actor);
    RETURN 1;
  ELSIF cardinality(transfer.failed_codes(v_results)) > 0 THEN
    PERFORM transfer.request_rescreens(c, v_results, p_actor);
    RETURN 0;
  END IF;
  PERFORM transfer.enqueue_execute(c, p_actor);
  RETURN 1;
END $$;

/** All live cases (npm run transfer:tick, and "Refresh from chain" in PT Control). One case's error never stops the others. */
CREATE FUNCTION transfer.tick(p_actor text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, transfer AS $$
DECLARE
  v_case bigint;
  v_n integer := 0;
BEGIN
  IF p_actor IS NULL OR length(p_actor) NOT BETWEEN 2 AND 100 THEN PERFORM transfer.fail('23514', 'an actor is required'); END IF;
  PERFORM pg_advisory_xact_lock(586586281);
  FOR v_case IN SELECT id FROM transfer.cases WHERE status IN ('requested', 'awaiting_cash', 'proposed', 'cancelling', 'failed') ORDER BY id LOOP
    BEGIN
      v_n := v_n + transfer.tick_case(v_case, p_actor);
    EXCEPTION WHEN OTHERS THEN
      PERFORM transfer.audit_append(p_actor, 'tick.error', jsonb_build_object('case', v_case, 'state', SQLSTATE, 'error', left(SQLERRM, 300)));
    END;
  END LOOP;
  RETURN v_n;
END $$;

-- ================================================================== cash: settlement and refund (TR-B8, TR-B9)
/** Canonical bank instruction of a cash operation; its SHA-256 is recorded before anything is sent. */
CREATE FUNCTION transfer.instruction(p_op bigint) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, transfer AS $$
  SELECT concat_ws('|', 'pt-transfer-instruction-v1', o.kind, o.reference, c.case_uuid::text, o.net_paisa::text,
                   coalesce((SELECT encode(p.iban_hash, 'hex') FROM bank.payees p WHERE p.id = o.payee_id), ''), coalesce(o.raast_ref, ''))
  FROM transfer.cash_ops o JOIN transfer.cases c ON c.id = o.case_id WHERE o.id = p_op
$$;

CREATE FUNCTION transfer.prepare_cash(p_case bigint, p_kind text, p_actor text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, transfer AS $$
DECLARE
  c transfer.cases;
  v_attempt integer;
  v_payee bigint;
  v_fee bigint := 0;
  v_tax bigint := 0;
  v_rate record;
  v_status record;
  v_amount bigint;
  v_id bigint;
  v_today date := (clock_timestamp() AT TIME ZONE 'Asia/Karachi')::date;
  v_hex text;
BEGIN
  PERFORM transfer.need_role(p_actor, ARRAY['ops_maker'], 'preparing a transfer settlement or refund');
  IF p_kind IS NULL OR p_kind NOT IN ('settlement', 'refund') THEN PERFORM transfer.fail('22023', 'kind must be settlement or refund'); END IF;
  SELECT * INTO c FROM transfer.cases WHERE id = p_case FOR UPDATE;
  IF NOT FOUND THEN PERFORM transfer.fail('P0002', 'unknown transfer case'); END IF;
  IF c.consideration <> 'sale' THEN PERFORM transfer.fail('23514', 'a transfer without consideration has no cash leg'); END IF;
  IF p_kind = 'settlement' AND c.status <> 'executed' THEN
    PERFORM transfer.fail('23514', 'the seller is settled only after the movement is in the read model (executed)');
  END IF;
  IF p_kind = 'refund' AND c.status <> 'refunding' THEN PERFORM transfer.fail('23514', 'only a case in refunding is refunded'); END IF;
  IF EXISTS (SELECT 1 FROM transfer.cash_ops x WHERE x.case_id = c.id AND x.kind = p_kind AND x.status <> 'rejected') THEN
    PERFORM transfer.fail('23505', format('a %s is already prepared or done', p_kind));
  END IF;
  SELECT coalesce(max(attempt), 0) + 1 INTO v_attempt FROM transfer.cash_ops x WHERE x.case_id = c.id AND x.kind = p_kind;
  v_hex := upper(substr(replace(c.case_uuid::text, '-', ''), 1, 12));
  IF p_kind = 'settlement' THEN
    v_payee := bank.active_payee(c.seller_subject);
    IF v_payee IS NULL THEN PERFORM transfer.fail('23514', 'the seller has no active payout account (registration or cooling-off)'); END IF;
    v_fee := floor((c.total_paisa::numeric * transfer.num('fee_ppm') + 500000) / 1000000)::bigint;
    SELECT * INTO v_status FROM tax.filer_status(c.seller_subject, v_today);
    SELECT * INTO v_rate FROM tax.rate_for('unit_disposal', v_status.status, v_today);
    IF v_rate.id IS NULL THEN PERFORM transfer.fail('23514', 'no active withholding rate for unit disposals'); END IF;
    v_tax := tax.withholding(c.total_paisa, v_rate.rate_ppm);
    IF c.total_paisa - v_fee - v_tax <= 0 THEN PERFORM transfer.fail('23514', 'fee and withholding leave nothing for the seller'); END IF;
    INSERT INTO transfer.cash_ops (case_id, kind, attempt, reference, gross_paisa, fee_paisa, tax_paisa, tax_rate_id, tax_status, tax_placeholder, net_paisa,
                                   payee_id, prepared_by, prepared_at)
    VALUES (c.id, 'settlement', v_attempt, format('PTXFER-%s-%s', v_hex, v_attempt), c.total_paisa, v_fee, v_tax, v_rate.id, v_status.status,
            v_rate.placeholder, c.total_paisa - v_fee - v_tax, v_payee, p_actor, date_trunc('microseconds', clock_timestamp()))
    RETURNING id INTO v_id;
  ELSE
    SELECT amount_paisa INTO v_amount FROM bank.credits WHERE raast_ref = c.paid_ref;
    INSERT INTO transfer.cash_ops (case_id, kind, attempt, reference, gross_paisa, net_paisa, raast_ref, prepared_by, prepared_at)
    VALUES (c.id, 'refund', v_attempt, format('PTXREF-%s-%s', v_hex, v_attempt), v_amount, v_amount, c.paid_ref, p_actor, date_trunc('microseconds', clock_timestamp()))
    RETURNING id INTO v_id;
  END IF;
  UPDATE transfer.cases SET updated_at = clock_timestamp() WHERE id = c.id;
  PERFORM transfer.audit_append(p_actor, 'cash.prepared', jsonb_build_object('case', c.id, 'op', v_id, 'kind', p_kind, 'attempt', v_attempt,
    'fee', v_fee, 'tax', v_tax, 'net', (SELECT net_paisa FROM transfer.cash_ops WHERE id = v_id)));
  RETURN v_id;
END $$;

CREATE FUNCTION transfer.decide_cash(p_case bigint, p_actor text, p_decision text, p_reason text, p_digest bytea) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, transfer AS $$
DECLARE
  c transfer.cases;
  o transfer.cash_ops;
  v_now timestamptz := date_trunc('microseconds', clock_timestamp());
  v_escrow text;
  v_fee bigint;
  v_tax bigint;
  v_main bigint;
  v_tax_account text;
BEGIN
  PERFORM transfer.need_role(p_actor, ARRAY['ops_checker'], 'approving a transfer settlement or refund');
  IF p_decision IS NULL OR p_decision NOT IN ('approve', 'reject') THEN PERFORM transfer.fail('22023', 'decision must be approve or reject'); END IF;
  IF NOT compliance.free_text_ok(p_reason, 10, 500) THEN PERFORM transfer.fail('23514', 'a reason of 10 to 500 characters is required'); END IF;
  SELECT * INTO c FROM transfer.cases WHERE id = p_case FOR UPDATE;
  IF NOT FOUND THEN PERFORM transfer.fail('P0002', 'unknown transfer case'); END IF;
  IF p_digest IS NULL OR transfer.case_digest(c.id) IS DISTINCT FROM p_digest THEN
    PERFORM transfer.fail('23514', 'the case differs from what you reviewed: reload and check again');
  END IF;
  SELECT * INTO o FROM transfer.cash_ops x WHERE x.case_id = c.id AND x.status = 'prepared' FOR UPDATE;
  IF NOT FOUND THEN PERFORM transfer.fail('23514', 'nothing is prepared for this case'); END IF;
  IF p_actor IN (o.prepared_by, c.opened_by, coalesce(c.completed_by, '')) THEN
    PERFORM transfer.fail('23514', 'maker-checker: the preparer, the opener and the completer of the case never confirm its cash leg (TR-SOD-3)');
  END IF;
  IF p_decision = 'reject' THEN
    UPDATE transfer.cash_ops SET status = 'rejected', decided_by = p_actor, decision_reason = btrim(p_reason), decided_at = v_now WHERE id = o.id;
    PERFORM transfer.audit_append(p_actor, 'cash.decided', jsonb_build_object('case', c.id, 'op', o.id, 'decision', 'reject'));
    RETURN c.status;
  END IF;
  IF (o.kind = 'settlement' AND c.status <> 'executed') OR (o.kind = 'refund' AND c.status <> 'refunding') THEN
    PERFORM transfer.fail('23514', format('the case is %s', c.status));
  END IF;
  PERFORM bank.require_gate();
  v_escrow := transfer.escrow_account(c.case_uuid);
  IF o.kind = 'settlement' THEN
    IF kyc.subject_status(c.seller_subject) <> 'verified' THEN
      PERFORM transfer.fail('23514', format('the seller is %s: the payment is held', kyc.subject_status(c.seller_subject)));
    END IF;
    IF bank.active_payee(c.seller_subject) IS DISTINCT FROM o.payee_id THEN
      PERFORM transfer.fail('23514', 'the seller''s payout account changed or is not active: reject and prepare again');
    END IF;
    IF o.tax_placeholder AND ops.setting('allow_placeholder_rates') IS DISTINCT FROM 'true'::jsonb THEN
      PERFORM transfer.fail('23514', 'the settlement uses a PLACEHOLDER withholding rate (LEGAL/TAX TO CONFIRM): confirmed rates are needed first');
    END IF;
    IF o.fee_paisa > 0 THEN
      PERFORM ledger.open_account('fees:payable:platform', 'liability', 'PKR', false);
      v_fee := ledger.post_journal(format('xfer:%s:fee', c.case_uuid), 'transfer_fee', format('platform fee on transfer case %s', c.id), o.reference, p_actor,
        jsonb_build_array(jsonb_build_object('account', v_escrow, 'amount', o.fee_paisa::text),
                          jsonb_build_object('account', 'fees:payable:platform', 'amount', (-o.fee_paisa)::text)));
    END IF;
    IF o.tax_paisa > 0 THEN
      v_tax_account := 'tax:cgt-payable:' || c.token;
      PERFORM ledger.open_account(v_tax_account, 'liability', 'PKR', false);
      v_tax := ledger.post_journal(format('xfer:%s:tax', c.case_uuid), 'transfer_tax', format('withholding on transfer case %s', c.id), o.reference, p_actor,
        jsonb_build_array(jsonb_build_object('account', v_escrow, 'amount', o.tax_paisa::text),
                          jsonb_build_object('account', v_tax_account, 'amount', (-o.tax_paisa)::text)));
    END IF;
    v_main := ledger.post_journal(format('xfer:%s:settled', c.case_uuid), 'transfer_settlement', format('seller settlement of transfer case %s', c.id),
      o.reference, p_actor,
      jsonb_build_array(jsonb_build_object('account', v_escrow, 'amount', o.net_paisa::text),
                        jsonb_build_object('account', 'bank:trustee-escrow', 'amount', (-o.net_paisa)::text)));
  ELSE
    v_main := ledger.post_journal(format('xfer:%s:refunded', c.case_uuid), 'transfer_refund', format('refund of transfer case %s', c.id),
      o.raast_ref, p_actor,
      jsonb_build_array(jsonb_build_object('account', v_escrow, 'amount', o.net_paisa::text),
                        jsonb_build_object('account', 'bank:trustee-escrow', 'amount', (-o.net_paisa)::text)));
  END IF;
  UPDATE transfer.cash_ops SET status = 'approved', decided_by = p_actor, decision_reason = btrim(p_reason), decided_at = v_now,
         fee_journal = v_fee, tax_journal = v_tax, main_journal = v_main, file_sha256 = sha256(convert_to(transfer.instruction(o.id), 'UTF8'))
  WHERE id = o.id;
  PERFORM transfer.audit_append(p_actor, 'cash.decided', jsonb_build_object('case', c.id, 'op', o.id, 'decision', 'approve', 'kind', o.kind,
    'journal', v_main, 'fileSha256', encode(sha256(convert_to(transfer.instruction(o.id), 'UTF8')), 'hex')));
  IF o.kind = 'settlement' THEN
    PERFORM transfer.move(c.id, 'settled', p_actor, 'seller settled from escrow (T12)');
    RETURN 'settled';
  END IF;
  PERFORM transfer.notify_parties(c, 'refunded', p_actor);
  PERFORM transfer.move(c.id, 'cancelled', p_actor, 'refund booked to the buyer''s source account (T14)');
  RETURN 'cancelled';
END $$;

-- ================================================================== reference prices, conflicts, links, blocks
CREATE FUNCTION transfer.set_reference_price(p_token text, p_price bigint, p_evidence bytea, p_reason text, p_actor text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, transfer AS $$
DECLARE
  v_id bigint;
BEGIN
  PERFORM transfer.need_role(p_actor, ARRAY['ops_checker'], 'recording a reference price');
  IF NOT transfer.is_address(lower(p_token)) OR p_price IS NULL OR p_price < 1 OR p_evidence IS NULL OR length(p_evidence) <> 32
     OR NOT compliance.free_text_ok(p_reason, 10, 500) THEN
    PERFORM transfer.fail('23514', 'a token, a price per unit in paisa, the valuation''s SHA-256 and a reason are required');
  END IF;
  INSERT INTO transfer.reference_prices (token, price_paisa, evidence_sha256, reason, recorded_by) VALUES (lower(p_token), p_price, p_evidence, btrim(p_reason), p_actor)
  RETURNING id INTO v_id;
  PERFORM transfer.audit_append(p_actor, 'price.recorded', jsonb_build_object('price', v_id, 'token', lower(p_token), 'pricePaisa', p_price,
    'evidence', encode(p_evidence, 'hex')));
  RETURN v_id;
END $$;

CREATE FUNCTION transfer.declare_conflict(p_subject uuid, p_reason text, p_actor text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, transfer AS $$
DECLARE
  v_id bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admin.officers WHERE handle = p_actor) THEN PERFORM transfer.fail('42501', 'only a PT Control officer declares a conflict'); END IF;
  IF NOT EXISTS (SELECT 1 FROM kyc.subjects WHERE id = p_subject) THEN PERFORM transfer.fail('P0002', 'unknown investor'); END IF;
  IF NOT compliance.free_text_ok(p_reason, 10, 500) THEN PERFORM transfer.fail('23514', 'a reason of 10 to 500 characters is required'); END IF;
  INSERT INTO transfer.conflicts (officer, subject_id, reason) VALUES (p_actor, p_subject, btrim(p_reason)) RETURNING id INTO v_id;
  PERFORM transfer.audit_append(p_actor, 'conflict.declared', jsonb_build_object('conflict', v_id, 'subject', p_subject));
  RETURN v_id;
END $$;

CREATE FUNCTION transfer.link_parties(p_a uuid, p_b uuid, p_relation text, p_reason text, p_actor text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, transfer AS $$
DECLARE
  v_id bigint;
BEGIN
  PERFORM transfer.need_role(p_actor, ARRAY['compliance_officer'], 'recording a link between investors');
  IF p_a IS NULL OR p_b IS NULL OR p_a = p_b THEN PERFORM transfer.fail('23514', 'two different investors are needed'); END IF;
  IF NOT compliance.free_text_ok(p_reason, 10, 500) THEN PERFORM transfer.fail('23514', 'a reason of 10 to 500 characters is required'); END IF;
  INSERT INTO transfer.party_links (subject_a, subject_b, relation, reason, recorded_by) VALUES (least(p_a, p_b), greatest(p_a, p_b), p_relation, btrim(p_reason), p_actor)
  RETURNING id INTO v_id;
  PERFORM transfer.audit_append(p_actor, 'link.recorded', jsonb_build_object('link', v_id, 'a', least(p_a, p_b), 'b', greatest(p_a, p_b), 'relation', p_relation));
  RETURN v_id;
END $$;

/** 16.7 hook (S-05, incidents): opens a block of the token's transfers. */
CREATE FUNCTION transfer.open_block(p_token text, p_source text, p_ref text, p_reason text, p_actor text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, transfer AS $$
DECLARE
  v_id bigint;
BEGIN
  IF p_actor IS NULL OR length(p_actor) NOT BETWEEN 2 AND 100 THEN PERFORM transfer.fail('23514', 'an actor is required'); END IF;
  INSERT INTO transfer.blocks (token, source, ref, reason, opened_by) VALUES (lower(p_token), p_source, p_ref, btrim(p_reason), p_actor)
  ON CONFLICT (source, ref) DO NOTHING RETURNING id INTO v_id;
  IF v_id IS NULL THEN SELECT id INTO v_id FROM transfer.blocks WHERE source = p_source AND ref = p_ref; RETURN v_id; END IF;
  PERFORM transfer.audit_append(p_actor, 'block.opened', jsonb_build_object('block', v_id, 'token', lower(p_token), 'source', p_source, 'ref', p_ref));
  RETURN v_id;
END $$;

CREATE FUNCTION transfer.close_block(p_id bigint, p_reason text, p_actor text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, transfer AS $$
BEGIN
  UPDATE transfer.blocks SET closed_by = p_actor, close_reason = btrim(p_reason), closed_at = date_trunc('microseconds', clock_timestamp())
  WHERE id = p_id AND closed_at IS NULL;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM transfer.audit_append(p_actor, 'block.closed', jsonb_build_object('block', p_id));
  RETURN true;
END $$;

-- ================================================================== XF-5 the signing service's gate
/**
 * For the signing service (deny by default): is this exactly a command a case enqueued, and is the case
 * in the state the kind needs now? Chain facts are checked again by the policy.
 */
CREATE FUNCTION transfer.command_allowed(p_kind text, p_payload jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, transfer AS $$
DECLARE
  c transfer.cases;
  r chain.recoveries;
BEGIN
  IF p_kind = 'transfer.propose' THEN
    SELECT x.* INTO c FROM transfer.cases x JOIN outbox.commands o ON o.idempotency_key = x.propose_key WHERE o.kind = p_kind AND o.payload = p_payload;
    RETURN FOUND AND c.status = 'proposed' AND c.request_id IS NULL AND transfer.escrow_ok(c);
  ELSIF p_kind = 'transfer.execute' THEN
    SELECT x.* INTO c FROM transfer.cases x JOIN outbox.commands o ON o.idempotency_key = x.execute_key WHERE o.kind = p_kind AND o.payload = p_payload;
    IF NOT FOUND OR c.status <> 'proposed' OR c.request_id IS NULL OR (p_payload->>'requestId') IS DISTINCT FROM c.request_id::text THEN RETURN false; END IF;
    SELECT * INTO r FROM chain.recoveries WHERE guard = c.recovery_guard AND id = c.request_id;
    IF NOT FOUND OR r.status <> 'pending' OR r.kind <> 'forced_transfer' OR r.from_addr <> c.seller_wallet OR r.to_addr <> c.buyer_wallet
       OR r.amount <> c.units OR r.eta > extract(epoch FROM clock_timestamp()) THEN
      RETURN false;
    END IF;
    RETURN transfer.escrow_ok(c) AND cardinality(transfer.failed_codes(transfer.check_results(c.id, 'execute'))) = 0;
  ELSIF p_kind = 'transfer.cancel' THEN
    SELECT x.* INTO c FROM transfer.cases x JOIN outbox.commands o ON o.idempotency_key = x.cancel_key WHERE o.kind = p_kind AND o.payload = p_payload;
    RETURN FOUND AND c.status IN ('cancelling', 'failed') AND c.request_id IS NOT NULL AND (p_payload->>'requestId') = c.request_id::text;
  END IF;
  RETURN false;
END $$;

-- ================================================================== reconciliation (XF-10, spec 16.8)
CREATE VIEW transfer.recon_requests AS
SELECT c.recovery_guard AS guard, c.request_id, c.id AS case_id, c.status FROM transfer.cases c WHERE c.request_id IS NOT NULL;

CREATE FUNCTION transfer.reconcile(p_token text)
RETURNS TABLE (check_name text, subject text, expected text, actual text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, transfer AS $$
#variable_conflict use_column
DECLARE
  v_token text := lower(p_token);
  v_from bigint := transfer.num('unapproved_from_block')::bigint;
  r record;
  v_now timestamptz := clock_timestamp();
BEGIN
  -- transfer.unapproved
  FOR r IN SELECT t.tx_hash, t.block_number, t.from_addr, t.to_addr, t.amount FROM chain.transfers t
           WHERE t.token = v_token AND t.kind = 'transfer' AND t.block_number >= v_from
             AND NOT EXISTS (SELECT 1 FROM chain.events e WHERE e.tx_hash = t.tx_hash AND e.name = 'RecoveryExecuted'
                               AND (EXISTS (SELECT 1 FROM transfer.cases x WHERE x.recovery_guard = e.address AND x.request_id = (e.args->>'id')::numeric)
                                    OR EXISTS (SELECT 1 FROM recovery.proposals p WHERE p.recovery_guard = e.address AND p.request_id = (e.args->>'id')::numeric)))
             AND NOT EXISTS (SELECT 1 FROM outbox.commands o WHERE o.kind = 'token.transfer' AND o.status = 'confirmed' AND o.tx_hash = t.tx_hash)
             AND NOT EXISTS (SELECT 1 FROM webdemo.trades w WHERE w.transfer_tx = t.tx_hash AND w.status = 'settled')
           ORDER BY t.block_number, t.log_index LOOP
    check_name := 'transfer.unapproved'; subject := format('tx %s', r.tx_hash);
    expected := 'an executed request of an approved case (or a confirmed demo-market delivery)';
    actual := format('%s units from %s to %s at block %s', r.amount, r.from_addr, r.to_addr, r.block_number); RETURN NEXT;
  END LOOP;

  FOR r IN SELECT c.*, transfer.escrow_held(c.case_uuid) AS held FROM transfer.cases c WHERE c.token = v_token ORDER BY c.id LOOP
    -- transfer.settlement_mismatch
    IF r.executed_tx IS NOT NULL AND NOT EXISTS (SELECT 1 FROM chain.transfers t WHERE t.tx_hash = r.executed_tx AND t.token = r.token
         AND t.from_addr = r.seller_wallet AND t.to_addr = r.buyer_wallet AND t.amount = r.units) THEN
      check_name := 'transfer.settlement_mismatch'; subject := format('case %s', r.id);
      expected := format('%s units from %s to %s in %s', r.units, r.seller_wallet, r.buyer_wallet, r.executed_tx); actual := 'no matching movement'; RETURN NEXT;
    END IF;
    IF r.status = 'settled' AND NOT EXISTS (SELECT 1 FROM transfer.cash_ops o JOIN ledger.journal j ON j.id = o.main_journal
         WHERE o.case_id = r.id AND o.kind = 'settlement' AND o.status = 'approved' AND j.idempotency_key = format('xfer:%s:settled', r.case_uuid)
           AND o.net_paisa = o.gross_paisa - o.fee_paisa - o.tax_paisa AND o.gross_paisa = r.total_paisa) THEN
      check_name := 'transfer.settlement_mismatch'; subject := format('case %s', r.id);
      expected := 'an approved settlement of gross = price, net = gross - fee - tax'; actual := 'missing or different'; RETURN NEXT;
    END IF;
    -- transfer.register_mismatch
    IF r.executed_tx IS NOT NULL AND (
         NOT EXISTS (SELECT 1 FROM trustee.register_entries e WHERE e.source = 'transfer' AND e.source_ref = format('transfer:%s:seller', r.case_uuid)
                       AND e.wallet = r.seller_wallet AND e.units = -r.units AND e.token = r.token)
         OR NOT EXISTS (SELECT 1 FROM trustee.register_entries e WHERE e.source = 'transfer' AND e.source_ref = format('transfer:%s:buyer', r.case_uuid)
                       AND e.wallet = r.buyer_wallet AND e.units = r.units AND e.token = r.token)) THEN
      check_name := 'transfer.register_mismatch'; subject := format('case %s', r.id);
      expected := format('register entries -%s for the seller and +%s for the buyer', r.units, r.units); actual := 'missing or different'; RETURN NEXT;
    END IF;
    -- transfer.escrow_residual
    IF r.consideration = 'sale' AND r.status IN ('settled', 'cancelled', 'rejected') AND r.held <> 0 THEN
      check_name := 'transfer.escrow_residual'; subject := format('case %s', r.id); expected := '0 paisa in escrow'; actual := format('%s paisa (%s)', r.held, r.status); RETURN NEXT;
    ELSIF r.status = 'executed' AND r.held <> 0 AND r.executed_at < v_now - make_interval(hours => transfer.num('escrow_residual_hours')::integer) THEN
      check_name := 'transfer.escrow_residual'; subject := format('case %s', r.id); expected := 'the seller settled within the SLA';
      actual := format('%s paisa still in escrow since %s', r.held, transfer.utc(r.executed_at)); RETURN NEXT;
    END IF;
    -- transfer.paid_not_executed (warning, then blocking after the SLA)
    IF r.paid_ref IS NOT NULL AND r.status IN ('awaiting_cash', 'proposed', 'cancelling', 'failed', 'refunding') THEN
      check_name := CASE WHEN r.paid_at < v_now - make_interval(hours => transfer.num('paid_not_executed_hours')::integer)
                         THEN 'transfer.paid_not_executed_overdue' ELSE 'transfer.paid_not_executed' END;
      subject := format('case %s', r.id); expected := 'executed or refunded'; actual := format('%s since %s (paid)', r.status, transfer.utc(r.paid_at)); RETURN NEXT;
    END IF;
  END LOOP;

  -- A `:settled` journal without an executed (or settled) case of this token.
  FOR r IN SELECT j.id, j.idempotency_key FROM ledger.journal j WHERE j.idempotency_key LIKE 'xfer:%:settled'
           AND NOT EXISTS (SELECT 1 FROM transfer.cases c WHERE format('xfer:%s:settled', c.case_uuid) = j.idempotency_key AND c.status IN ('settled', 'disputed')
                             AND c.executed_tx IS NOT NULL) LOOP
    check_name := 'transfer.settlement_mismatch'; subject := format('journal %s (%s)', r.id, r.idempotency_key);
    expected := 'a settled case with an executed movement'; actual := 'seller paid without a matching case'; RETURN NEXT;
  END LOOP;
END $$;

-- ================================================================== verification (XF-8)
CREATE FUNCTION transfer.verify_audit() RETURNS TABLE (audit_id bigint, problem text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, transfer AS $$
DECLARE
  a transfer.audit;
  v_prev bytea := decode(repeat('00', 32), 'hex');
  r record;
BEGIN
  FOR a IN SELECT * FROM transfer.audit ORDER BY id LOOP
    IF a.prev_hash <> v_prev THEN audit_id := a.id; problem := 'prev_hash does not match'; RETURN NEXT; END IF;
    IF a.hash <> transfer.audit_digest(a.prev_hash, a.id, a.at, a.actor, a.action, a.detail) THEN
      audit_id := a.id; problem := 'content does not match its hash'; RETURN NEXT;
    END IF;
    v_prev := a.hash;
  END LOOP;
  FOR r IN
    SELECT format('case %s', c.id) AS what FROM transfer.cases c WHERE NOT EXISTS (
      SELECT 1 FROM transfer.audit x WHERE x.action = 'case.opened' AND (x.detail->>'case')::bigint = c.id AND x.detail->>'agreement' = encode(c.agreement_sha256, 'hex')
        AND (x.detail->>'units')::bigint = c.units)
    UNION ALL
    SELECT format('case %s: %s without its audit entry', c.id, c.status) FROM transfer.cases c WHERE c.status <> 'requested' AND NOT EXISTS (
      SELECT 1 FROM transfer.audit x WHERE x.action = 'case.' || c.status AND (x.detail->>'case')::bigint = c.id)
    UNION ALL
    SELECT format('case %s: approval without its audit entry', c.id) FROM transfer.cases c WHERE c.approved_at IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM transfer.audit x WHERE x.action = 'case.approved' AND (x.detail->>'case')::bigint = c.id AND x.detail->>'evidenceHash' = encode(c.evidence_hash, 'hex'))
    UNION ALL
    SELECT format('event %s', e.id) FROM transfer.events e WHERE e.from_status IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM transfer.audit x WHERE x.action = 'case.' || e.to_status AND (x.detail->>'case')::bigint = e.case_id AND x.detail->>'from' = e.from_status)
    UNION ALL
    SELECT format('decision %s', d.id) FROM transfer.decisions d WHERE NOT EXISTS (
      SELECT 1 FROM transfer.audit x WHERE x.action = 'case.decided' AND (x.detail->>'case')::bigint = d.case_id AND x.actor = d.officer
        AND x.detail->>'capacity' = d.capacity AND x.detail->>'decision' = d.decision AND x.detail->>'digest' = encode(d.digest, 'hex'))
    UNION ALL
    SELECT format('cash operation %s', o.id) FROM transfer.cash_ops o WHERE NOT EXISTS (
      SELECT 1 FROM transfer.audit x WHERE x.action = 'cash.prepared' AND (x.detail->>'op')::bigint = o.id AND (x.detail->>'net')::bigint = o.net_paisa)
      OR (o.status <> 'prepared' AND NOT EXISTS (SELECT 1 FROM transfer.audit x WHERE x.action = 'cash.decided' AND (x.detail->>'op')::bigint = o.id
            AND x.actor = o.decided_by AND x.detail->>'decision' = CASE o.status WHEN 'approved' THEN 'approve' ELSE 'reject' END))
    UNION ALL
    SELECT format('reference price %s', p.id) FROM transfer.reference_prices p WHERE NOT EXISTS (
      SELECT 1 FROM transfer.audit x WHERE x.action = 'price.recorded' AND (x.detail->>'price')::bigint = p.id AND (x.detail->>'pricePaisa')::bigint = p.price_paisa)
    UNION ALL
    SELECT format('alert %s', l.id) FROM transfer.alerts l WHERE NOT EXISTS (
      SELECT 1 FROM transfer.audit x WHERE x.action = 'alert.raised' AND (x.detail->>'case')::bigint = l.case_id AND x.detail->>'rule' = l.rule
        AND (x.detail->>'str')::bigint = l.str_case_id)
    UNION ALL
    SELECT format('conflict %s', k.id) FROM transfer.conflicts k WHERE NOT EXISTS (
      SELECT 1 FROM transfer.audit x WHERE x.action = 'conflict.declared' AND (x.detail->>'conflict')::bigint = k.id)
    UNION ALL
    SELECT format('link %s', k.id) FROM transfer.party_links k WHERE NOT EXISTS (
      SELECT 1 FROM transfer.audit x WHERE x.action = 'link.recorded' AND (x.detail->>'link')::bigint = k.id)
    UNION ALL
    SELECT format('receive code %s', q.code) FROM transfer.receive_codes q WHERE NOT EXISTS (
      SELECT 1 FROM transfer.audit x WHERE x.action = 'code.created' AND x.detail->>'code' = q.code)
  LOOP
    audit_id := NULL; problem := r.what || ' has no matching audit entry'; RETURN NEXT;
  END LOOP;
END $$;

-- ================================================================== website (TR-B3, spec 16.9): investor reads and actions
/** What one investor may see of their transfers: no other investor's identity, no reasons (tipping-off). */
CREATE FUNCTION transfer.web_list(p_subject uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, transfer AS $$
  SELECT jsonb_build_object(
    'verified', kyc.subject_status(p_subject) = 'verified',
    'codes', coalesce((SELECT jsonb_agg(jsonb_build_object('code', r.code, 'expiresAt', transfer.utc(r.expires_at)) ORDER BY r.created_at DESC)
                       FROM transfer.receive_codes r WHERE r.subject_id = p_subject AND r.used_at IS NULL AND r.expires_at > clock_timestamp()), '[]'::jsonb),
    'holdings', coalesce((SELECT jsonb_agg(jsonb_build_object('token', h.token, 'units', h.balance::text) ORDER BY h.token)
                          FROM kyc.wallets w JOIN chain.holdings h ON h.holder = w.wallet WHERE w.subject_id = p_subject AND h.balance > 0), '[]'::jsonb),
    'policyToken', lower(transfer.policy('transfer.propose')->>'token'),
    'cases', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'id', c.case_uuid,
        'role', CASE WHEN c.seller_subject = p_subject THEN 'seller' ELSE 'buyer' END,
        'status', transfer.public_status(c.status),
        'awaitingAcceptance', c.status = 'requested' AND c.accepted_at IS NULL,
        'canAccept', c.status = 'requested' AND c.accepted_at IS NULL AND c.buyer_subject = p_subject,
        'canWithdraw', c.status IN ('requested', 'checks', 'awaiting_cash') AND c.paid_ref IS NULL,
        'token', c.token, 'units', c.units::text, 'consideration', c.consideration,
        'pricePaisa', c.price_paisa::text, 'totalPaisa', c.total_paisa::text,
        'agreementSha256', encode(c.agreement_sha256, 'hex'),
        'openedAt', transfer.utc(c.opened_at), 'updatedAt', transfer.utc(c.updated_at),
        'payment', CASE WHEN c.buyer_subject = p_subject AND c.status = 'awaiting_cash' THEN jsonb_build_object(
            'code', c.intent_code, 'amountPaisa', c.total_paisa::text, 'payUntil', transfer.utc(c.pay_until), 'paid', c.paid_ref IS NOT NULL) END,
        'eta', CASE WHEN c.eta IS NOT NULL AND c.status = 'proposed' THEN transfer.utc(to_timestamp(c.eta)) END,
        'executedAt', transfer.utc(c.executed_at),
        'settlement', CASE WHEN c.seller_subject = p_subject THEN (SELECT jsonb_build_object('grossPaisa', o.gross_paisa::text, 'feePaisa', o.fee_paisa::text,
              'taxPaisa', o.tax_paisa::text, 'netPaisa', o.net_paisa::text, 'reference', o.reference, 'at', transfer.utc(o.decided_at))
            FROM transfer.cash_ops o WHERE o.case_id = c.id AND o.kind = 'settlement' AND o.status = 'approved') END,
        'refund', CASE WHEN c.buyer_subject = p_subject THEN (SELECT jsonb_build_object('amountPaisa', o.net_paisa::text, 'at', transfer.utc(o.decided_at))
            FROM transfer.cash_ops o WHERE o.case_id = c.id AND o.kind = 'refund' AND o.status = 'approved') END
      ) ORDER BY c.id DESC)
      FROM transfer.cases c WHERE c.seller_subject = p_subject OR c.buyer_subject = p_subject), '[]'::jsonb))
$$;

-- Step-up rules for the website's transfer actions (IP-6: from PKR 0 = always).
INSERT INTO webauth.step_up_actions (action, min_amount_paisa, note) VALUES
  ('transfer.request', 0, 'Requesting a transfer of units to another investor (S-04)'),
  ('transfer.accept', 0, 'Accepting a transfer of units from another investor (S-04)'),
  ('transfer.withdraw', 0, 'Withdrawing a transfer request (S-04)');

CREATE FUNCTION webauth.web_transfer_subject(p_investor uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, webauth AS $$
  SELECT i.kyc_subject FROM webdemo.investors i WHERE i.id = p_investor
$$;

/** The signed-in investor's transfers (no step-up: read only). NULL without a session. */
CREATE FUNCTION webauth.web_transfers(p_session bytea) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, webauth AS $$
DECLARE
  v_investor uuid;
  v_subject uuid;
BEGIN
  SELECT s.investor_id INTO v_investor FROM webauth.web_session(p_session) s;
  IF v_investor IS NULL THEN RETURN NULL; END IF;
  v_subject := webauth.web_transfer_subject(v_investor);
  IF v_subject IS NULL THEN RETURN jsonb_build_object('verified', false, 'codes', '[]'::jsonb, 'holdings', '[]'::jsonb, 'cases', '[]'::jsonb); END IF;
  RETURN transfer.web_list(v_subject);
END $$;

/** A receive code for the signed-in investor (they can only receive with it: no step-up). */
CREATE FUNCTION webauth.web_transfer_code(p_session bytea) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, webauth AS $$
DECLARE
  v_investor uuid;
  v_subject uuid;
BEGIN
  SELECT s.investor_id INTO v_investor FROM webauth.web_session(p_session) s;
  IF v_investor IS NULL THEN RETURN jsonb_build_object('error', 'session'); END IF;
  v_subject := webauth.web_transfer_subject(v_investor);
  IF v_subject IS NULL THEN RAISE EXCEPTION 'only a KYC-verified investor can receive units' USING ERRCODE = '42501'; END IF;
  RETURN transfer.web_new_code(v_subject, webauth.actor(v_investor));
END $$;

CREATE FUNCTION webauth.web_transfer_request(p_session bytea, p_token text, p_units bigint, p_code text, p_consideration text, p_price bigint,
                                             p_no_price_reason text, p_agreement text, p_explanation text, p_holding_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, webauth AS $$
DECLARE
  g record;
  v_subject uuid;
  v_id uuid;
BEGIN
  SELECT * INTO g FROM webauth.gate(p_session, 'transfer.request',
    CASE WHEN p_consideration = 'sale' THEN coalesce(p_price, 0)::numeric * greatest(coalesce(p_units, 0), 0)::numeric ELSE 0 END);
  IF g.decision NOT IN ('ok', 'waived') THEN RETURN jsonb_build_object('error', g.decision); END IF;
  v_subject := webauth.web_transfer_subject(g.investor_id);
  IF v_subject IS NULL THEN RAISE EXCEPTION 'only a KYC-verified investor can request a transfer' USING ERRCODE = '42501'; END IF;
  IF p_agreement IS NULL OR p_agreement !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'the agreement fingerprint (SHA-256, 64 hex digits) is required' USING ERRCODE = '23514'; END IF;
  v_id := transfer.web_request(v_subject, p_token, p_units, p_code, p_consideration, p_price, p_no_price_reason, decode(p_agreement, 'hex'),
                               p_explanation, p_holding_reason, webauth.actor(g.investor_id));
  RETURN jsonb_build_object('ok', true, 'id', v_id);
END $$;

CREATE FUNCTION webauth.web_transfer_accept(p_session bytea, p_case uuid, p_agreement text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, webauth AS $$
DECLARE
  g record;
  v_subject uuid;
BEGIN
  SELECT * INTO g FROM webauth.gate(p_session, 'transfer.accept', 0);
  IF g.decision NOT IN ('ok', 'waived') THEN RETURN jsonb_build_object('error', g.decision); END IF;
  v_subject := webauth.web_transfer_subject(g.investor_id);
  IF v_subject IS NULL THEN RAISE EXCEPTION 'transfer not found' USING ERRCODE = 'P0002'; END IF;
  IF p_agreement IS NULL OR p_agreement !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'the agreement fingerprint (SHA-256, 64 hex digits) is required' USING ERRCODE = '23514'; END IF;
  RETURN jsonb_build_object('ok', true, 'status', transfer.web_accept(v_subject, p_case, decode(p_agreement, 'hex'), webauth.actor(g.investor_id)));
END $$;

CREATE FUNCTION webauth.web_transfer_withdraw(p_session bytea, p_case uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, webauth AS $$
DECLARE
  g record;
  v_subject uuid;
BEGIN
  SELECT * INTO g FROM webauth.gate(p_session, 'transfer.withdraw', 0);
  IF g.decision NOT IN ('ok', 'waived') THEN RETURN jsonb_build_object('error', g.decision); END IF;
  v_subject := webauth.web_transfer_subject(g.investor_id);
  IF v_subject IS NULL THEN RAISE EXCEPTION 'transfer not found' USING ERRCODE = 'P0002'; END IF;
  RETURN jsonb_build_object('ok', true, 'status', transfer.web_withdraw(v_subject, p_case, webauth.actor(g.investor_id)));
END $$;

-- ================================================================== portal (admin.*): permissions and functions (spec 16.9)
INSERT INTO admin.role_permissions (role, permission) VALUES
  ('ops_maker', 'transfer.read'), ('ops_checker', 'transfer.read'), ('compliance_officer', 'transfer.read'), ('trustee_officer', 'transfer.read'),
  ('auditor', 'transfer.read'),
  ('ops_maker', 'transfer.request'),
  ('compliance_officer', 'transfer.decide'), ('trustee_officer', 'transfer.decide'),
  ('ops_maker', 'transfer.cash'), ('ops_checker', 'transfer.cash'),
  ('ops_checker', 'transfer.price');

DO $$
BEGIN
  EXECUTE format('CREATE OR REPLACE FUNCTION admin.expected_role_matrix_digest() RETURNS text LANGUAGE sql IMMUTABLE AS %L',
                 format('SELECT %L::text', admin.role_matrix_digest()));
END $$;

CREATE FUNCTION admin.transfer_policies() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
  SELECT jsonb_object_agg(k, transfer.policy('transfer.' || k) IS NOT NULL) FROM unnest(ARRAY['propose', 'execute', 'cancel']) k
$$;

CREATE FUNCTION admin.transfer_cases(p_session bytea, p_status text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'transfer.read');
  v_token text := lower(transfer.policy('transfer.propose')->>'token');
  v_ref record;
BEGIN
  SELECT * INTO v_ref FROM transfer.reference_price(v_token);
  RETURN jsonb_build_object(
    'at', admin.utc(clock_timestamp()),
    'policies', admin.transfer_policies(),
    'token', v_token,
    'referencePrice', CASE WHEN v_ref.price_paisa IS NOT NULL THEN jsonb_build_object('pricePaisa', v_ref.price_paisa::text, 'source', v_ref.source) END,
    'settings', (SELECT jsonb_object_agg(key, value) FROM transfer.settings),
    'counts', coalesce((SELECT jsonb_object_agg(status, n) FROM (SELECT status, count(*) AS n FROM transfer.cases GROUP BY 1) q), '{}'::jsonb),
    'openBlocks', coalesce((SELECT jsonb_agg(jsonb_build_object('id', b.id, 'token', b.token, 'source', b.source, 'ref', b.ref, 'reason', b.reason,
        'openedAt', admin.utc(b.opened_at)) ORDER BY b.id) FROM transfer.blocks b WHERE b.closed_at IS NULL), '[]'::jsonb),
    'prices', coalesce((SELECT jsonb_agg(jsonb_build_object('id', p.id, 'token', p.token, 'pricePaisa', p.price_paisa::text, 'evidence', encode(p.evidence_sha256, 'hex'),
        'reason', p.reason, 'by', p.recorded_by, 'at', admin.utc(p.at)) ORDER BY p.id DESC)
      FROM (SELECT * FROM transfer.reference_prices ORDER BY id DESC LIMIT 20) p), '[]'::jsonb),
    'cases', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'id', c.id, 'status', c.status, 'origin', c.origin, 'consideration', c.consideration, 'units', c.units::text, 'totalPaisa', c.total_paisa::text,
        'seller', left(replace(c.seller_subject::text, '-', ''), 8), 'buyer', left(replace(c.buyer_subject::text, '-', ''), 8),
        'accepted', c.accepted_at IS NOT NULL, 'openedBy', c.opened_by, 'openedAt', admin.utc(c.opened_at), 'updatedAt', admin.utc(c.updated_at),
        'approvals', (SELECT count(*) FROM transfer.decisions d WHERE d.case_id = c.id AND d.decision = 'approve'),
        'eta', CASE WHEN c.eta IS NOT NULL THEN admin.utc(to_timestamp(c.eta)) END) ORDER BY c.id DESC)
      FROM (SELECT * FROM transfer.cases WHERE p_status IS NULL OR status = p_status ORDER BY id DESC LIMIT 300) c), '[]'::jsonb));
END $$;

CREATE FUNCTION admin.transfer_case(p_session bytea, p_id bigint) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'transfer.read');
  v_handle text := admin.handle_of(v_me);
  c transfer.cases;
  v_request boolean := admin.has_permission(p_session, 'transfer.request');
  v_decide boolean := admin.has_permission(p_session, 'transfer.decide');
  v_cash boolean := admin.has_permission(p_session, 'transfer.cash');
  v_compliance boolean := admin.has_permission(p_session, 'compliance.read');
  v_caps text[] := '{}';
  v_maker text[] := '{}';
  v_decision text[] := '{}';
  v_cancel text[] := '{}';
  v_dispute text[] := '{}';
  v_prepare text[] := '{}';
  v_confirm text[] := '{}';
  v_live record;
  v_open record;
BEGIN
  SELECT * INTO c FROM transfer.cases WHERE id = p_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF admin.officer_holds(v_handle, ARRAY['compliance_officer'], true) AND NOT EXISTS (SELECT 1 FROM transfer.decisions d WHERE d.case_id = c.id AND d.capacity = 'compliance') THEN
    v_caps := v_caps || 'compliance'::text;
  END IF;
  IF admin.officer_holds(v_handle, ARRAY['trustee_officer'], true) AND NOT EXISTS (SELECT 1 FROM transfer.decisions d WHERE d.case_id = c.id AND d.capacity = 'trustee') THEN
    v_caps := v_caps || 'trustee'::text;
  END IF;
  -- Maker: complete or withdraw.
  IF NOT v_request THEN v_maker := v_maker || 'Only an operations maker (transfer desk) completes or withdraws a request.'::text; END IF;
  IF c.status <> 'requested' THEN v_maker := v_maker || format('The case is %s.', c.status); END IF;
  IF c.status = 'requested' AND c.accepted_at IS NULL THEN v_maker := v_maker || 'The buyer has not accepted the request yet.'::text; END IF;
  -- Decisions.
  IF NOT v_decide THEN v_decision := v_decision || 'Only compliance and trustee officers decide transfers; your role reads them.'::text; END IF;
  IF c.status <> 'checks' THEN v_decision := v_decision || format('The case is %s.', c.status); END IF;
  IF v_handle IN (c.opened_by, coalesce(c.completed_by, '')) THEN v_decision := v_decision || 'You opened or completed this case (maker-checker).'::text; END IF;
  IF transfer.has_conflict(v_handle, c) THEN v_decision := v_decision || 'You declared a conflict with a party.'::text; END IF;
  IF EXISTS (SELECT 1 FROM transfer.decisions d WHERE d.case_id = c.id AND d.officer = v_handle) THEN
    v_decision := v_decision || 'You already decided this case.'::text;
  ELSIF v_decide AND cardinality(v_caps) = 0 AND c.status = 'checks' THEN
    v_decision := v_decision || 'Your capacity has already decided.'::text;
  END IF;
  -- Cancel (T9) and dispute (T15).
  IF NOT v_decide THEN v_cancel := v_cancel || 'Only a compliance or trustee officer cancels a transfer.'::text; END IF;
  IF c.status NOT IN ('requested', 'checks', 'awaiting_cash', 'proposed') THEN v_cancel := v_cancel || format('A %s case cannot be cancelled.', c.status); END IF;
  IF NOT admin.officer_holds(v_handle, ARRAY['compliance_officer'], true) THEN v_dispute := v_dispute || 'Only a compliance officer records a dispute.'::text; END IF;
  IF c.status NOT IN ('executed', 'settled') THEN v_dispute := v_dispute || 'Only an executed or settled transfer can be disputed.'::text; END IF;
  -- Cash.
  SELECT * INTO v_live FROM transfer.cash_ops o WHERE o.case_id = c.id AND o.status = 'prepared';
  IF NOT v_cash OR NOT admin.officer_holds(v_handle, ARRAY['ops_maker'], true) THEN v_prepare := v_prepare || 'Only an operations maker prepares a settlement or refund.'::text; END IF;
  IF c.consideration <> 'sale' THEN v_prepare := v_prepare || 'No cash leg (no consideration).'::text;
  ELSIF c.status NOT IN ('executed', 'refunding') THEN v_prepare := v_prepare || 'Settlement after execution, refund in refunding only.'::text; END IF;
  IF v_live.id IS NOT NULL THEN v_prepare := v_prepare || 'Already prepared: waiting for the checker.'::text; END IF;
  IF NOT v_cash OR NOT admin.officer_holds(v_handle, ARRAY['ops_checker'], true) THEN v_confirm := v_confirm || 'Only an operations checker confirms the cash leg.'::text; END IF;
  IF v_live.id IS NULL THEN v_confirm := v_confirm || 'Nothing is prepared.'::text;
  ELSIF v_handle IN (v_live.prepared_by, c.opened_by, coalesce(c.completed_by, '')) THEN
    v_confirm := v_confirm || 'You prepared it or opened/completed the case (TR-SOD-3).'::text;
  END IF;
  RETURN jsonb_build_object(
    'id', c.id, 'uuid', c.case_uuid, 'caseId', transfer.case_id_hex(c.case_ref), 'status', c.status, 'publicStatus', transfer.public_status(c.status),
    'origin', c.origin, 'token', c.token, 'recoveryGuard', c.recovery_guard,
    'seller', admin.subject_json(c.seller_subject), 'sellerWallet', c.seller_wallet,
    'buyer', admin.subject_json(c.buyer_subject), 'buyerWallet', c.buyer_wallet,
    'units', c.units::text, 'consideration', c.consideration, 'pricePaisa', c.price_paisa::text, 'totalPaisa', c.total_paisa::text,
    'noPriceReason', c.no_price_reason, 'agreementSha256', encode(c.agreement_sha256, 'hex'), 'priceExplanation', c.price_explanation,
    'holdingReason', c.holding_reason,
    'openedBy', c.opened_by, 'openedAt', admin.utc(c.opened_at), 'acceptedAt', admin.utc(c.accepted_at), 'completedBy', c.completed_by,
    'completedAt', admin.utc(c.completed_at), 'approvedAt', admin.utc(c.approved_at), 'updatedAt', admin.utc(c.updated_at),
    'evidenceHash', CASE WHEN c.evidence_hash IS NOT NULL THEN '0x' || encode(c.evidence_hash, 'hex') END,
    'payment', CASE WHEN c.intent_code IS NOT NULL THEN jsonb_build_object('code', c.intent_code, 'payUntil', admin.utc(c.pay_until), 'paidRef', c.paid_ref,
        'paidAt', admin.utc(c.paid_at), 'escrowPaisa', transfer.escrow_held(c.case_uuid)::text) END,
    'request', jsonb_build_object('requestId', c.request_id::text, 'eta', CASE WHEN c.eta IS NOT NULL THEN admin.utc(to_timestamp(c.eta)) END,
        'executeAttempts', c.execute_attempts, 'cancelAttempts', c.cancel_attempts, 'executedTx', c.executed_tx, 'executedAt', admin.utc(c.executed_at)),
    'commands', jsonb_build_object('propose', admin.command_json(c.propose_key), 'execute', admin.command_json(c.execute_key), 'cancel', admin.command_json(c.cancel_key)),
    'cancelledBy', c.cancelled_by, 'cancelReason', c.cancel_reason, 'disputedBy', c.disputed_by, 'disputeReason', c.dispute_reason,
    'checks', (SELECT jsonb_build_object('stage', x.stage, 'passed', x.passed, 'results', x.results, 'at', admin.utc(x.at))
               FROM transfer.checks x WHERE x.case_id = c.id ORDER BY x.id DESC LIMIT 1),
    'liveChecks', CASE WHEN c.status IN ('requested', 'checks') THEN transfer.check_results(c.id, 'approve') END,
    'decisions', coalesce((SELECT jsonb_agg(jsonb_build_object('capacity', d.capacity, 'officer', d.officer, 'decision', d.decision, 'reason', d.reason,
        'at', admin.utc(d.at)) ORDER BY d.id) FROM transfer.decisions d WHERE d.case_id = c.id), '[]'::jsonb),
    'events', coalesce((SELECT jsonb_agg(jsonb_build_object('from', e.from_status, 'to', e.to_status, 'actor', e.actor, 'reason', e.reason, 'at', admin.utc(e.at)) ORDER BY e.id)
      FROM transfer.events e WHERE e.case_id = c.id), '[]'::jsonb),
    'cash', coalesce((SELECT jsonb_agg(jsonb_build_object('id', o.id, 'kind', o.kind, 'attempt', o.attempt, 'reference', o.reference, 'status', o.status,
        'grossPaisa', o.gross_paisa::text, 'feePaisa', o.fee_paisa::text, 'taxPaisa', o.tax_paisa::text, 'taxStatus', o.tax_status, 'taxPlaceholder', o.tax_placeholder,
        'netPaisa', o.net_paisa::text, 'payee', CASE WHEN o.payee_id IS NOT NULL THEN (SELECT jsonb_build_object('bank', p.bank_code, 'last4', p.iban_last4)
            FROM bank.payees p WHERE p.id = o.payee_id) END, 'raastRef', o.raast_ref,
        'preparedBy', o.prepared_by, 'preparedAt', admin.utc(o.prepared_at), 'decidedBy', o.decided_by, 'decisionReason', o.decision_reason,
        'decidedAt', admin.utc(o.decided_at), 'fileSha256', CASE WHEN o.file_sha256 IS NOT NULL THEN encode(o.file_sha256, 'hex') END) ORDER BY o.id)
      FROM transfer.cash_ops o WHERE o.case_id = c.id), '[]'::jsonb),
    -- Surveillance alerts: compliance officers and auditors only (tipping-off).
    'alerts', CASE WHEN v_compliance THEN coalesce((SELECT jsonb_agg(jsonb_build_object('rule', a.rule, 'detail', a.detail, 'strCase', a.str_case_id,
        'at', admin.utc(a.at)) ORDER BY a.id) FROM transfer.alerts a WHERE a.case_id = c.id), '[]'::jsonb) END,
    'policies', admin.transfer_policies(),
    'myCapacities', to_jsonb(v_caps),
    'digest', encode(transfer.case_digest(c.id), 'hex'),
    'blockers', jsonb_build_object('maker', to_jsonb(v_maker), 'decide', to_jsonb(v_decision), 'cancel', to_jsonb(v_cancel), 'dispute', to_jsonb(v_dispute),
                                   'prepare', to_jsonb(v_prepare), 'confirm', to_jsonb(v_confirm)));
END $$;

/** Transfer desk: opens a case (parties by KYC subject id; agreement SHA-256 as 64 hex digits). */
CREATE FUNCTION admin.transfer_open(p_session bytea, p_seller uuid, p_buyer uuid, p_token text, p_units bigint, p_consideration text, p_price bigint,
                                    p_no_price_reason text, p_agreement text, p_explanation text, p_holding_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'transfer.request');
  v_handle text := admin.handle_of(v_me);
  v_id bigint;
BEGIN
  PERFORM admin.require_step_up(p_session);
  BEGIN
    IF p_agreement IS NULL OR p_agreement !~ '^[0-9a-f]{64}$' THEN PERFORM transfer.fail('23514', 'the agreement''s SHA-256 (64 hex digits) is required'); END IF;
    PERFORM admin.bind_officer(v_handle);
    v_id := transfer.open_desk(p_seller, p_buyer, p_token, p_units, p_consideration, p_price, nullif(btrim(p_no_price_reason), ''), decode(p_agreement, 'hex'),
                               nullif(btrim(p_explanation), ''), nullif(btrim(p_holding_reason), ''), v_handle);
    PERFORM admin.unbind_officer(v_handle);
  EXCEPTION WHEN SQLSTATE '23514' OR SQLSTATE '23505' OR SQLSTATE '42501' OR SQLSTATE '22023' OR SQLSTATE 'P0002' OR SQLSTATE '23503' THEN
    RETURN admin.refuse(v_me, 'transfer', 'new', coalesce(p_consideration, '?'), SQLERRM);
  END;
  PERFORM admin.audit_append(v_me::text, 'transfer.requested', jsonb_build_object('ref', v_id, 'action', 'open'));
  RETURN jsonb_build_object('ok', true, 'id', v_id, 'status', 'requested');
END $$;

/** complete | withdraw (desk), approve | reject (capacity), cancel, dispute: step-up, digest, officer binding; refusals audited. */
CREATE FUNCTION admin.transfer_act(p_session bytea, p_case bigint, p_action text, p_capacity text, p_reason text, p_digest bytea)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'transfer.read');
  v_handle text := admin.handle_of(v_me);
  v_status text;
BEGIN
  PERFORM admin.require(p_session, CASE WHEN p_action IN ('complete', 'withdraw') THEN 'transfer.request' ELSE 'transfer.decide' END);
  PERFORM admin.require_step_up(p_session);
  IF p_action IS DISTINCT FROM 'complete' THEN PERFORM admin.check_text(p_reason, 10, 500); END IF;
  IF NOT EXISTS (SELECT 1 FROM transfer.cases WHERE id = p_case) THEN
    RETURN admin.refuse(v_me, 'transfer', coalesce(p_case::text, '?'), coalesce(p_action, '?'), 'unknown transfer case');
  END IF;
  BEGIN
    IF p_digest IS NULL OR transfer.case_digest(p_case) IS DISTINCT FROM p_digest THEN
      PERFORM transfer.fail('23514', 'the case differs from what you reviewed: reload and check again');
    END IF;
    PERFORM admin.bind_officer(v_handle);
    IF p_action = 'complete' THEN
      v_status := transfer.complete(p_case, v_handle);
    ELSIF p_action = 'withdraw' THEN
      v_status := transfer.withdraw(p_case, v_handle, p_reason);
    ELSIF p_action IN ('approve', 'reject') THEN
      v_status := transfer.decide(p_case, v_handle, p_capacity, p_action, p_reason, p_digest);
    ELSIF p_action = 'cancel' THEN
      v_status := transfer.cancel(p_case, v_handle, p_reason, p_digest);
    ELSIF p_action = 'dispute' THEN
      v_status := transfer.dispute(p_case, v_handle, p_reason, p_digest);
    ELSE
      PERFORM transfer.fail('22023', 'action must be complete, withdraw, approve, reject, cancel or dispute');
    END IF;
    PERFORM admin.unbind_officer(v_handle);
  EXCEPTION WHEN SQLSTATE '23514' OR SQLSTATE '23505' OR SQLSTATE '42501' OR SQLSTATE '22023' OR SQLSTATE 'P0002' THEN
    -- A refused approval because a screening is stale still queues the re-screening (outside the rolled-back block).
    IF p_action = 'approve' AND (SELECT status FROM transfer.cases WHERE id = p_case) = 'checks' THEN
      PERFORM transfer.request_rescreens(c2, transfer.check_results(p_case, 'approve'), 'system:transfer')
      FROM transfer.cases c2 WHERE c2.id = p_case;
    END IF;
    RETURN admin.refuse(v_me, 'transfer', p_case::text, coalesce(p_action, '?'), SQLERRM);
  END;
  PERFORM admin.audit_append(v_me::text, 'transfer.decided', jsonb_build_object('ref', p_case, 'action', p_action, 'capacity', p_capacity,
    'result', v_status, 'digest', encode(p_digest, 'hex')));
  RETURN jsonb_build_object('ok', true, 'status', v_status);
END $$;

/** prepare_settlement | prepare_refund (operations maker), approve | reject (operations checker). */
CREATE FUNCTION admin.transfer_cash(p_session bytea, p_case bigint, p_action text, p_reason text, p_digest bytea)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'transfer.cash');
  v_handle text := admin.handle_of(v_me);
  v_status text;
  v_op bigint;
BEGIN
  PERFORM admin.require_step_up(p_session);
  IF p_action IN ('approve', 'reject') THEN PERFORM admin.check_text(p_reason, 10, 500); END IF;
  IF NOT EXISTS (SELECT 1 FROM transfer.cases WHERE id = p_case) THEN
    RETURN admin.refuse(v_me, 'transfer', coalesce(p_case::text, '?'), coalesce(p_action, '?'), 'unknown transfer case');
  END IF;
  BEGIN
    IF p_digest IS NULL OR transfer.case_digest(p_case) IS DISTINCT FROM p_digest THEN
      PERFORM transfer.fail('23514', 'the case differs from what you reviewed: reload and check again');
    END IF;
    PERFORM admin.bind_officer(v_handle);
    IF p_action IN ('prepare_settlement', 'prepare_refund') THEN
      v_op := transfer.prepare_cash(p_case, CASE p_action WHEN 'prepare_settlement' THEN 'settlement' ELSE 'refund' END, v_handle);
      v_status := 'prepared';
    ELSIF p_action IN ('approve', 'reject') THEN
      v_status := transfer.decide_cash(p_case, v_handle, p_action, p_reason, p_digest);
    ELSE
      PERFORM transfer.fail('22023', 'action must be prepare_settlement, prepare_refund, approve or reject');
    END IF;
    PERFORM admin.unbind_officer(v_handle);
  EXCEPTION WHEN SQLSTATE '23514' OR SQLSTATE '23505' OR SQLSTATE '42501' OR SQLSTATE '22023' OR SQLSTATE 'P0002' THEN
    RETURN admin.refuse(v_me, 'transfer', p_case::text, coalesce(p_action, '?'), SQLERRM);
  END;
  PERFORM admin.audit_append(v_me::text, 'transfer.cash', jsonb_build_object('ref', p_case, 'action', p_action, 'result', v_status, 'op', v_op));
  RETURN jsonb_build_object('ok', true, 'status', v_status, 'id', v_op);
END $$;

/** "Refresh from chain" (transfer.tick). */
CREATE FUNCTION admin.transfer_sync(p_session bytea) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'transfer.request');
  v_n integer;
BEGIN
  v_n := transfer.tick('portal:' || left(admin.handle_of(v_me), 90));
  PERFORM admin.audit_append(v_me::text, 'transfer.synced', jsonb_build_object('changes', v_n));
  RETURN jsonb_build_object('ok', true, 'status', format('%s change(s)', v_n), 'id', v_n);
END $$;

CREATE FUNCTION admin.transfer_set_price(p_session bytea, p_token text, p_price bigint, p_evidence text, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'transfer.price');
  v_handle text := admin.handle_of(v_me);
  v_id bigint;
BEGIN
  PERFORM admin.require_step_up(p_session);
  PERFORM admin.check_text(p_reason, 10, 500);
  BEGIN
    IF p_evidence IS NULL OR p_evidence !~ '^[0-9a-f]{64}$' THEN PERFORM transfer.fail('23514', 'the valuation''s SHA-256 (64 hex digits) is required'); END IF;
    PERFORM admin.bind_officer(v_handle);
    v_id := transfer.set_reference_price(p_token, p_price, decode(p_evidence, 'hex'), p_reason, v_handle);
    PERFORM admin.unbind_officer(v_handle);
  EXCEPTION WHEN SQLSTATE '23514' OR SQLSTATE '23505' OR SQLSTATE '42501' OR SQLSTATE '22023' OR SQLSTATE 'P0002' THEN
    RETURN admin.refuse(v_me, 'transfer', 'price', 'record', SQLERRM);
  END;
  PERFORM admin.audit_append(v_me::text, 'transfer.price', jsonb_build_object('ref', v_id));
  RETURN jsonb_build_object('ok', true, 'id', v_id, 'status', 'recorded');
END $$;

/** TR-SOD-2: the signed-in officer declares a conflict with an investor (any transfer reader). */
CREATE FUNCTION admin.transfer_declare_conflict(p_session bytea, p_subject uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'transfer.read');
  v_handle text := admin.handle_of(v_me);
  v_id bigint;
BEGIN
  PERFORM admin.require_step_up(p_session);
  PERFORM admin.check_text(p_reason, 10, 500);
  BEGIN
    PERFORM admin.bind_officer(v_handle);
    v_id := transfer.declare_conflict(p_subject, p_reason, v_handle);
    PERFORM admin.unbind_officer(v_handle);
  EXCEPTION WHEN SQLSTATE '23514' OR SQLSTATE '23505' OR SQLSTATE '42501' OR SQLSTATE '22023' OR SQLSTATE 'P0002' THEN
    RETURN admin.refuse(v_me, 'transfer', 'conflict', 'declare', SQLERRM);
  END;
  PERFORM admin.audit_append(v_me::text, 'transfer.conflict', jsonb_build_object('ref', v_id));
  RETURN jsonb_build_object('ok', true, 'id', v_id, 'status', 'declared');
END $$;

CREATE FUNCTION admin.transfer_link_parties(p_session bytea, p_a uuid, p_b uuid, p_relation text, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'transfer.decide');
  v_handle text := admin.handle_of(v_me);
  v_id bigint;
BEGIN
  PERFORM admin.require_step_up(p_session);
  PERFORM admin.check_text(p_reason, 10, 500);
  BEGIN
    PERFORM admin.bind_officer(v_handle);
    v_id := transfer.link_parties(p_a, p_b, p_relation, p_reason, v_handle);
    PERFORM admin.unbind_officer(v_handle);
  EXCEPTION WHEN SQLSTATE '23514' OR SQLSTATE '23505' OR SQLSTATE '42501' OR SQLSTATE '22023' OR SQLSTATE 'P0002' OR SQLSTATE '23503' THEN
    RETURN admin.refuse(v_me, 'transfer', 'link', 'record', SQLERRM);
  END;
  PERFORM admin.audit_append(v_me::text, 'transfer.link', jsonb_build_object('ref', v_id));
  RETURN jsonb_build_object('ok', true, 'id', v_id, 'status', 'recorded');
END $$;

/** The transfer audit chain for PT Control (newest first) and its verification. */
CREATE FUNCTION admin.transfer_audit(p_session bytea, p_before bigint, p_limit integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'transfer.read');
BEGIN
  RETURN jsonb_build_object(
    'problems', (SELECT count(*) FROM transfer.verify_audit()),
    'firstProblem', (SELECT min(problem) FROM transfer.verify_audit()),
    'rows', coalesce((SELECT jsonb_agg(jsonb_build_object('id', a.id, 'at', admin.utc(a.at), 'actor', a.actor, 'action', a.action, 'detail', a.detail,
        'hash', encode(a.hash, 'hex')) ORDER BY a.id DESC)
      FROM (SELECT * FROM transfer.audit WHERE p_before IS NULL OR id < p_before ORDER BY id DESC LIMIT least(greatest(coalesce(p_limit, 50), 1), 500)) a), '[]'::jsonb));
END $$;

-- ================================================================== privileges
REVOKE ALL ON ALL TABLES IN SCHEMA transfer FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA transfer FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA admin FROM PUBLIC;
REVOKE ALL ON FUNCTION webauth.web_transfer_subject(uuid), webauth.web_transfers(bytea), webauth.web_transfer_code(bytea),
  webauth.web_transfer_request(bytea, text, bigint, text, text, bigint, text, text, text, text), webauth.web_transfer_accept(bytea, uuid, text),
  webauth.web_transfer_withdraw(bytea, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
  admin.transfer_cases(bytea, text),
  admin.transfer_case(bytea, bigint),
  admin.transfer_open(bytea, uuid, uuid, text, bigint, text, bigint, text, text, text, text),
  admin.transfer_act(bytea, bigint, text, text, text, bytea),
  admin.transfer_cash(bytea, bigint, text, text, bytea),
  admin.transfer_sync(bytea),
  admin.transfer_set_price(bytea, text, bigint, text, text),
  admin.transfer_declare_conflict(bytea, uuid, text),
  admin.transfer_link_parties(bytea, uuid, uuid, text, text),
  admin.transfer_audit(bytea, bigint, integer)
TO pt_admin_portal;

-- The website reaches transfers only through the session-bound wrappers (IP-9).
GRANT EXECUTE ON FUNCTION
  webauth.web_transfers(bytea),
  webauth.web_transfer_code(bytea),
  webauth.web_transfer_request(bytea, text, bigint, text, text, bigint, text, text, text, text),
  webauth.web_transfer_accept(bytea, uuid, text),
  webauth.web_transfer_withdraw(bytea, uuid)
TO pt_web;

-- The signing service checks every transfer command against its case (XF-5).
GRANT USAGE ON SCHEMA transfer TO pt_signer, pt_transfer_worker, pt_recon_writer, pt_recon_reader, pt_admin_auditor;
GRANT EXECUTE ON FUNCTION transfer.command_allowed(text, jsonb) TO pt_signer;
-- The tick runs as its own worker role (npm run transfer:tick).
GRANT EXECUTE ON FUNCTION transfer.tick(text) TO pt_transfer_worker;
GRANT SELECT ON transfer.recon_requests TO pt_recon_writer, pt_recon_reader;
GRANT EXECUTE ON FUNCTION transfer.reconcile(text), transfer.verify_audit() TO pt_recon_writer, pt_recon_reader;
GRANT EXECUTE ON FUNCTION transfer.verify_audit() TO pt_admin_auditor;

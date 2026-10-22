-- S-06 (T-026, spec S-06 section 14): lost-wallet recovery, succession and reversals of platform
-- errors, with the portal functions for them. Numbered 0020: 0021 is reserved for work built in
-- parallel; nothing here depends on it.
--
-- Safety properties enforced by the database itself (schema recovery, plus admin.* wrappers):
--   RV-1  Cases (wallet_recovery, succession, reversal) change only along their state machine (trigger):
--         opened -> approved -> executed -> closed; opened -> rejected | cancelled -> closed; approved
--         -> cancelled; a reversal closes when its correcting journal is posted. Identity columns of
--         a case never change; a case is never deleted.
--   RV-2  Approval is two officers in the capacities the kind needs (wallet recovery: operations +
--         compliance; succession: legal + compliance; reversal: operations), different people, never
--         the maker (CHECK + unique keys + function). An officer's capacity is one of their roles.
--   RV-3  Wallet recovery: the 48-hour objection window has passed (the investor's contacts of
--         record were notified at opening), NADRA and liveness passed again after opening for the
--         same subject, the subject is KYC-verified (no compliance hold), the new wallet is an unbound,
--         unregistered custodial wallet holding nothing, and the old wallet is frozen on chain.
--   RV-4  Succession: death certificate + succession instrument recorded (metadata and SHA-256 only),
--         heirs KYC-verified with registered wallets, shares summing to exactly 1; units are
--         floor(balance x share), the remainder by largest remainder only with a family settlement,
--         otherwise it stays frozen in the deceased's wallet.
--   RV-5  Reversal: one journal of a reversible kind booked in error by the platform, never one with
--         an on-chain counterpart, never twice; the correcting journal (exact contra) is posted in the
--         approval transaction under the ledger's own rules.
--   RV-6  On-chain commands exist only as the case enqueued them: recovery.command_allowed(kind,
--         payload) answers the signing service for every new kind (deny by default).
--   RV-7  The KYC wallet binding moves to the new wallet only when the read model shows the recovery
--         executed (kyc.wallets may change in no other way; history in recovery.wallet_history).
--   RV-8  Release (unfreeze) needs two different compliance officers, neither the officer who opened
--         (froze) the case.
--   RV-9  Every row is written by a function that also appends to the hash-chained recovery.audit
--         (UTC digests); recovery.verify_audit() re-checks the chain and finds rows written around it.
--         Officer handles are bound to officer sessions (as 0016/0019).
--   RV-10 Least data: no name, CNIC, IBAN or phone number; free text is refused if it carries one.

CREATE SCHEMA IF NOT EXISTS recovery;
REVOKE ALL ON SCHEMA recovery FROM PUBLIC;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pt_recovery_worker') THEN CREATE ROLE pt_recovery_worker NOLOGIN; END IF;
END $$;

-- ================================================================== helpers
CREATE FUNCTION recovery.forbid_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'recovery records are append-only: % on %.% is not allowed', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE FUNCTION recovery.utc(p timestamptz) RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT to_char(p AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
$$;

CREATE FUNCTION recovery.fail(p_code text, p_message text) RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION '%', p_message USING ERRCODE = p_code;
END $$;

CREATE FUNCTION recovery.objection_window() RETURNS interval LANGUAGE sql IMMUTABLE AS $$ SELECT interval '48 hours' $$;
CREATE FUNCTION recovery.max_execute_attempts() RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT 3 $$;
CREATE FUNCTION recovery.zero_address() RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT '0x0000000000000000000000000000000000000000'::text $$;

CREATE FUNCTION recovery.is_address(p text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT p IS NOT NULL AND length(p) = 42 AND p ~ '^0x[0-9a-f]+$'
$$;

/** The active signing policy's rule for a kind (NULL without one). */
CREATE FUNCTION recovery.policy(p_kind text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, recovery AS $$
  SELECT p.rule FROM signer.policies p WHERE p.kind = p_kind AND p.approved_at IS NOT NULL AND p.retired_at IS NULL
$$;

-- ================================================================== audit (RV-9)
CREATE TABLE recovery.audit (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at        timestamptz NOT NULL,
  actor     text NOT NULL CHECK (length(actor) BETWEEN 1 AND 100),
  action    text NOT NULL CHECK (action ~ '^[a-z][a-z_.]{2,63}$'),
  detail    jsonb NOT NULL CHECK (jsonb_typeof(detail) = 'object' AND octet_length(detail::text) <= 8192),
  prev_hash bytea NOT NULL CHECK (length(prev_hash) = 32),
  hash      bytea NOT NULL UNIQUE CHECK (length(hash) = 32)
);
CREATE INDEX audit_action_idx ON recovery.audit (action, id);

CREATE FUNCTION recovery.audit_digest(p_prev bytea, p_id bigint, p_at timestamptz, p_actor text, p_action text, p_detail jsonb)
RETURNS bytea LANGUAGE sql STABLE SET search_path = pg_catalog, recovery AS $$
  SELECT sha256(p_prev || convert_to('pt-recovery-audit-v1' || jsonb_build_array(p_id, recovery.utc(p_at), p_actor, p_action, p_detail)::text, 'UTF8'))
$$;

CREATE FUNCTION recovery.audit_append(p_actor text, p_action text, p_detail jsonb)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, recovery AS $$
DECLARE
  v_prev bytea;
  v_id bigint;
  v_at timestamptz := date_trunc('microseconds', clock_timestamp());
BEGIN
  PERFORM pg_advisory_xact_lock(586586200);
  SELECT hash INTO v_prev FROM recovery.audit ORDER BY id DESC LIMIT 1;
  v_prev := coalesce(v_prev, decode(repeat('00', 32), 'hex'));
  v_id := nextval(pg_get_serial_sequence('recovery.audit', 'id'));
  INSERT INTO recovery.audit (id, at, actor, action, detail, prev_hash, hash)
  OVERRIDING SYSTEM VALUE
  VALUES (v_id, v_at, left(p_actor, 100), p_action, coalesce(p_detail, '{}'::jsonb), v_prev,
          recovery.audit_digest(v_prev, v_id, v_at, left(p_actor, 100), p_action, coalesce(p_detail, '{}'::jsonb)));
  RETURN v_id;
END $$;

-- ================================================================== reference lists
CREATE TABLE recovery.reversal_reasons (
  code  text PRIMARY KEY CHECK (code ~ '^[a-z][a-z_]{2,39}$'),
  label text NOT NULL CHECK (length(label) BETWEEN 5 AND 120)
);
INSERT INTO recovery.reversal_reasons (code, label) VALUES
  ('duplicate_booking', 'The same money or event was booked twice by the platform'),
  ('wrong_account', 'Booked to the wrong ledger account by the platform'),
  ('wrong_amount', 'Booked with the wrong amount by the platform'),
  ('system_error', 'Booked by a platform defect (incident reference in the reason)');

-- RF-18: journal kinds a reversal may correct (owner question OQ-6). New kinds need a migration.
CREATE TABLE recovery.reversible_kinds (
  kind  text PRIMARY KEY CHECK (kind ~ '^[a-z][a-z0-9_]{2,63}$' AND kind <> 'reversal'),
  label text NOT NULL CHECK (length(label) BETWEEN 5 AND 120)
);
INSERT INTO recovery.reversible_kinds (kind, label) VALUES
  ('rent_received', 'Rent received from a tenant (booked by operations)'),
  ('cash_topup', 'Cash top-up of an investor''s market account (demo market)');

-- ================================================================== cases (RV-1)
CREATE TABLE recovery.cases (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  case_uuid           uuid NOT NULL UNIQUE,
  -- bytes32 caseId on chain (FreezeGuard events): SHA-256 of "pt-case-v1:<caseUuid>" (spec section 3).
  case_ref            bytea NOT NULL UNIQUE CHECK (length(case_ref) = 32),
  kind                text NOT NULL CHECK (kind IN ('wallet_recovery', 'succession', 'reversal')),
  subject_id          uuid REFERENCES kyc.subjects (id),
  token               text CHECK (token IS NULL OR recovery.is_address(token)),
  recovery_guard      text CHECK (recovery_guard IS NULL OR recovery.is_address(recovery_guard)),
  freeze_guard        text CHECK (freeze_guard IS NULL OR recovery.is_address(freeze_guard)),
  identity_registry   text CHECK (identity_registry IS NULL OR recovery.is_address(identity_registry)),
  from_wallet         text CHECK (from_wallet IS NULL OR recovery.is_address(from_wallet)),
  to_wallet           text CHECK (to_wallet IS NULL OR recovery.is_address(to_wallet)),
  onchain_id          text CHECK (onchain_id IS NULL OR recovery.is_address(onchain_id)),
  journal_id          bigint REFERENCES ledger.journal (id),
  reason_code         text REFERENCES recovery.reversal_reasons (code),
  evidence_sha256     bytea CHECK (evidence_sha256 IS NULL OR length(evidence_sha256) = 32),
  summary             text NOT NULL CHECK (compliance.free_text_ok(summary, 10, 1000)),
  objection_until     timestamptz,
  status              text NOT NULL DEFAULT 'opened' CHECK (status IN ('opened', 'approved', 'executed', 'rejected', 'cancelled', 'closed')),
  opened_by           text NOT NULL CHECK (length(opened_by) BETWEEN 2 AND 100),
  opened_at           timestamptz NOT NULL,
  updated_at          timestamptz NOT NULL,
  approved_at         timestamptz,
  -- evidence hash given to RecoveryGuard (SHA-256 over the case's document and re-verification hashes).
  evidence_hash       bytea CHECK (evidence_hash IS NULL OR length(evidence_hash) = 32),
  units_total         numeric(78,0) CHECK (units_total >= 0),
  units_residual      numeric(78,0) CHECK (units_residual >= 0),
  freeze_key          text UNIQUE,
  add_key_key         text UNIQUE,
  reversal_journal_id bigint UNIQUE REFERENCES ledger.journal (id),
  cancelled_by        text CHECK (length(cancelled_by) BETWEEN 2 AND 100),
  cancel_reason       text CHECK (cancel_reason IS NULL OR compliance.free_text_ok(cancel_reason, 10, 500)),
  release_proposed_by text CHECK (length(release_proposed_by) BETWEEN 2 AND 100),
  release_reason      text CHECK (release_reason IS NULL OR compliance.free_text_ok(release_reason, 10, 500)),
  release_proposed_at timestamptz,
  released_by         text CHECK (length(released_by) BETWEEN 2 AND 100),
  released_at         timestamptz,
  unfreeze_wallet     text CHECK (unfreeze_wallet IS NULL OR recovery.is_address(unfreeze_wallet)),
  unfreeze_key        text UNIQUE,
  closed_at           timestamptz,
  -- Shape of each kind.
  CHECK ((kind = 'reversal') = (journal_id IS NOT NULL)),
  CHECK ((kind = 'reversal') = (reason_code IS NOT NULL AND evidence_sha256 IS NOT NULL)),
  CHECK (kind = 'reversal' OR (subject_id IS NOT NULL AND from_wallet IS NOT NULL AND token IS NOT NULL AND recovery_guard IS NOT NULL
                               AND freeze_guard IS NOT NULL AND identity_registry IS NOT NULL)),
  CHECK (kind <> 'wallet_recovery' OR (onchain_id IS NOT NULL AND objection_until IS NOT NULL)),
  CHECK (kind = 'wallet_recovery' OR (to_wallet IS NULL AND onchain_id IS NULL AND objection_until IS NULL)),
  CHECK (to_wallet IS NULL OR to_wallet <> from_wallet),
  CHECK ((status IN ('approved', 'executed') OR (status IN ('cancelled', 'closed') AND approved_at IS NOT NULL)) = (approved_at IS NOT NULL)),
  CHECK ((status = 'closed') = (closed_at IS NOT NULL)),
  CHECK ((kind = 'reversal' AND status = 'closed') = (reversal_journal_id IS NOT NULL)),
  CHECK ((status = 'cancelled' OR (status = 'closed' AND cancelled_by IS NOT NULL)) = (cancelled_by IS NOT NULL AND cancel_reason IS NOT NULL)),
  -- RV-8 release: proposed by one compliance officer, confirmed by another, neither the maker.
  CHECK ((release_proposed_by IS NULL) = (release_reason IS NULL AND release_proposed_at IS NULL)),
  CHECK (release_proposed_by IS NULL OR release_proposed_by <> opened_by),
  CHECK (released_by IS NULL OR (release_proposed_by IS NOT NULL AND released_by <> release_proposed_by AND released_by <> opened_by)),
  CHECK ((released_by IS NULL) = (released_at IS NULL)),
  CHECK (unfreeze_key IS NULL OR (released_by IS NOT NULL AND unfreeze_wallet IS NOT NULL))
);
-- One live case per wallet, per new wallet and per journal.
CREATE UNIQUE INDEX cases_one_live_wallet ON recovery.cases (from_wallet) WHERE kind <> 'reversal' AND status IN ('opened', 'approved', 'executed');
CREATE UNIQUE INDEX cases_one_live_new_wallet ON recovery.cases (to_wallet) WHERE status IN ('opened', 'approved', 'executed');
CREATE UNIQUE INDEX cases_one_reversal ON recovery.cases (journal_id) WHERE kind = 'reversal' AND status IN ('opened', 'closed');
CREATE INDEX cases_subject_idx ON recovery.cases (subject_id, id DESC);
CREATE INDEX cases_live_idx ON recovery.cases (status) WHERE status NOT IN ('closed', 'rejected');

CREATE FUNCTION recovery.guard_case() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'recovery cases are never deleted' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF (NEW.id, NEW.case_uuid, NEW.case_ref, NEW.kind, NEW.subject_id, NEW.token, NEW.recovery_guard, NEW.freeze_guard, NEW.identity_registry,
      NEW.from_wallet, NEW.onchain_id, NEW.journal_id, NEW.reason_code, NEW.evidence_sha256, NEW.summary, NEW.objection_until, NEW.opened_by,
      NEW.opened_at, NEW.freeze_key)
     IS DISTINCT FROM
     (OLD.id, OLD.case_uuid, OLD.case_ref, OLD.kind, OLD.subject_id, OLD.token, OLD.recovery_guard, OLD.freeze_guard, OLD.identity_registry,
      OLD.from_wallet, OLD.onchain_id, OLD.journal_id, OLD.reason_code, OLD.evidence_sha256, OLD.summary, OLD.objection_until, OLD.opened_by,
      OLD.opened_at, OLD.freeze_key) THEN
    RAISE EXCEPTION 'case % keeps its identity, wallets and evidence once opened', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.to_wallet IS DISTINCT FROM OLD.to_wallet
     AND (OLD.status <> 'opened' OR EXISTS (SELECT 1 FROM recovery.approvals a WHERE a.case_id = OLD.id)) THEN
    RAISE EXCEPTION 'the new wallet of case % can change only before any approval', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'opened' AND NEW.status IN ('approved', 'rejected', 'cancelled'))
    OR (OLD.status = 'opened' AND NEW.status = 'closed' AND OLD.kind = 'reversal')
    OR (OLD.status = 'approved' AND NEW.status IN ('executed', 'cancelled') AND OLD.kind <> 'reversal')
    OR (OLD.status IN ('executed', 'rejected', 'cancelled') AND NEW.status = 'closed' AND OLD.kind <> 'reversal')) THEN
    RAISE EXCEPTION 'case %: % -> % is not a transition of the recovery state machine', OLD.id, OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'closed' OR (OLD.kind = 'reversal' AND OLD.status IN ('rejected', 'cancelled')) THEN
    RAISE EXCEPTION 'case % is final', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  -- Decision facts are written once.
  IF (OLD.approved_at IS NOT NULL AND NEW.approved_at IS DISTINCT FROM OLD.approved_at)
     OR (OLD.evidence_hash IS NOT NULL AND NEW.evidence_hash IS DISTINCT FROM OLD.evidence_hash)
     OR (OLD.units_total IS NOT NULL AND NEW.units_total IS DISTINCT FROM OLD.units_total)
     OR (OLD.units_residual IS NOT NULL AND NEW.units_residual IS DISTINCT FROM OLD.units_residual)
     OR (OLD.add_key_key IS NOT NULL AND NEW.add_key_key IS DISTINCT FROM OLD.add_key_key)
     OR (OLD.cancelled_by IS NOT NULL AND (NEW.cancelled_by, NEW.cancel_reason) IS DISTINCT FROM (OLD.cancelled_by, OLD.cancel_reason))
     OR (OLD.release_proposed_by IS NOT NULL AND (NEW.release_proposed_by, NEW.release_reason, NEW.release_proposed_at)
                                                  IS DISTINCT FROM (OLD.release_proposed_by, OLD.release_reason, OLD.release_proposed_at))
     OR (OLD.released_by IS NOT NULL AND (NEW.released_by, NEW.released_at, NEW.unfreeze_wallet, NEW.unfreeze_key)
                                          IS DISTINCT FROM (OLD.released_by, OLD.released_at, OLD.unfreeze_wallet, OLD.unfreeze_key))
     OR (OLD.reversal_journal_id IS NOT NULL AND NEW.reversal_journal_id IS DISTINCT FROM OLD.reversal_journal_id) THEN
    RAISE EXCEPTION 'case %: a decision, once recorded, never changes', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cases_guard BEFORE UPDATE OR DELETE ON recovery.cases FOR EACH ROW EXECUTE FUNCTION recovery.guard_case();

-- ================================================================== approvals (RV-2)
CREATE TABLE recovery.approvals (
  id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  case_id  bigint NOT NULL REFERENCES recovery.cases (id),
  capacity text NOT NULL CHECK (capacity IN ('operations', 'compliance', 'legal')),
  officer  text NOT NULL CHECK (length(officer) BETWEEN 2 AND 100),
  decision text NOT NULL CHECK (decision IN ('approve', 'reject')),
  reason   text NOT NULL CHECK (compliance.free_text_ok(reason, 10, 500)),
  digest   bytea NOT NULL CHECK (length(digest) = 32),
  at       timestamptz NOT NULL,
  UNIQUE (case_id, capacity),
  UNIQUE (case_id, officer)
);

-- ================================================================== documents and heirs (RV-4)
CREATE TABLE recovery.documents (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  case_id   bigint NOT NULL REFERENCES recovery.cases (id),
  doc_type  text NOT NULL CHECK (doc_type IN ('death_certificate', 'succession_certificate', 'letters_of_administration', 'court_order',
                                              'family_settlement', 'reverification', 'other')),
  -- e.g. the certificate or court-order number; never personal data.
  reference text NOT NULL CHECK (compliance.free_text_ok(reference, 3, 120)),
  issuer    text CHECK (issuer IS NULL OR compliance.free_text_ok(issuer, 2, 120)),
  sha256    bytea NOT NULL CHECK (length(sha256) = 32),
  added_by  text NOT NULL CHECK (length(added_by) BETWEEN 2 AND 100),
  added_at  timestamptz NOT NULL,
  UNIQUE (case_id, sha256)
);
CREATE INDEX documents_case_idx ON recovery.documents (case_id, id);

CREATE TABLE recovery.heirs (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  case_id    bigint NOT NULL REFERENCES recovery.cases (id),
  subject_id uuid NOT NULL REFERENCES kyc.subjects (id),
  wallet     text NOT NULL CHECK (recovery.is_address(wallet)),
  share_num  integer NOT NULL CHECK (share_num > 0),
  share_den  integer NOT NULL CHECK (share_den > 0 AND share_num <= share_den),
  added_by   text NOT NULL CHECK (length(added_by) BETWEEN 2 AND 100),
  added_at   timestamptz NOT NULL,
  UNIQUE (case_id, subject_id),
  UNIQUE (case_id, wallet)
);
CREATE INDEX heirs_case_idx ON recovery.heirs (case_id, id);

-- ================================================================== on-chain requests (RV-6)
CREATE TABLE recovery.proposals (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  case_id          bigint NOT NULL REFERENCES recovery.cases (id),
  heir_id          bigint REFERENCES recovery.heirs (id),
  kind             text NOT NULL CHECK (kind IN ('wallet_recovery', 'forced_transfer')),
  recovery_guard   text NOT NULL CHECK (recovery.is_address(recovery_guard)),
  from_wallet      text NOT NULL CHECK (recovery.is_address(from_wallet)),
  to_wallet        text NOT NULL CHECK (recovery.is_address(to_wallet)),
  onchain_id       text NOT NULL CHECK (recovery.is_address(onchain_id)),
  amount           numeric(78,0) NOT NULL CHECK (amount >= 0),
  evidence_hash    bytea NOT NULL CHECK (length(evidence_hash) = 32),
  propose_key      text NOT NULL UNIQUE,
  request_id       numeric(78,0) CHECK (request_id > 0),
  eta              bigint,
  status           text NOT NULL DEFAULT 'enqueued' CHECK (status IN ('enqueued', 'pending', 'executed', 'cancelled', 'failed')),
  execute_key      text UNIQUE,
  execute_attempts integer NOT NULL DEFAULT 0 CHECK (execute_attempts BETWEEN 0 AND 3),
  cancel_key       text UNIQUE,
  created_at       timestamptz NOT NULL,
  updated_at       timestamptz NOT NULL,
  UNIQUE (recovery_guard, request_id),
  CHECK ((kind = 'wallet_recovery') = (amount = 0 AND onchain_id <> '0x0000000000000000000000000000000000000000')),
  CHECK ((kind = 'forced_transfer') = (heir_id IS NOT NULL AND onchain_id = '0x0000000000000000000000000000000000000000')),
  CHECK ((status IN ('pending', 'executed', 'cancelled') AND request_id IS NOT NULL) OR (status IN ('enqueued', 'failed') AND request_id IS NULL)
         OR (status = 'cancelled' AND request_id IS NULL)),
  CHECK ((request_id IS NULL) = (eta IS NULL)),
  CHECK (execute_key IS NULL OR request_id IS NOT NULL),
  CHECK (cancel_key IS NULL OR request_id IS NOT NULL)
);
CREATE INDEX proposals_case_idx ON recovery.proposals (case_id, id);
CREATE INDEX proposals_live_idx ON recovery.proposals (status) WHERE status IN ('enqueued', 'pending');

CREATE FUNCTION recovery.guard_proposal() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'recovery requests are never deleted' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF (NEW.id, NEW.case_id, NEW.heir_id, NEW.kind, NEW.recovery_guard, NEW.from_wallet, NEW.to_wallet, NEW.onchain_id, NEW.amount,
      NEW.evidence_hash, NEW.propose_key, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.case_id, OLD.heir_id, OLD.kind, OLD.recovery_guard, OLD.from_wallet, OLD.to_wallet, OLD.onchain_id,
      OLD.amount, OLD.evidence_hash, OLD.propose_key, OLD.created_at)
     OR (OLD.request_id IS NOT NULL AND (NEW.request_id, NEW.eta) IS DISTINCT FROM (OLD.request_id, OLD.eta))
     OR (OLD.cancel_key IS NOT NULL AND NEW.cancel_key IS DISTINCT FROM OLD.cancel_key)
     OR NEW.execute_attempts < OLD.execute_attempts THEN
    RAISE EXCEPTION 'recovery request % changes only along its life cycle', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'enqueued' AND NEW.status IN ('pending', 'failed', 'cancelled'))
    OR (OLD.status = 'pending' AND NEW.status IN ('executed', 'cancelled'))) THEN
    RAISE EXCEPTION 'recovery request %: % -> % is not allowed', OLD.id, OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER proposals_guard BEFORE UPDATE OR DELETE ON recovery.proposals FOR EACH ROW EXECUTE FUNCTION recovery.guard_proposal();

-- ================================================================== wallet binding moves only with an executed recovery (RV-7)
CREATE TABLE recovery.wallet_history (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subject_id uuid NOT NULL REFERENCES kyc.subjects (id),
  old_wallet text NOT NULL CHECK (recovery.is_address(old_wallet)),
  new_wallet text NOT NULL UNIQUE CHECK (recovery.is_address(new_wallet)),
  case_id    bigint NOT NULL UNIQUE REFERENCES recovery.cases (id),
  at         timestamptz NOT NULL,
  actor      text NOT NULL CHECK (length(actor) BETWEEN 1 AND 100)
);

-- One row per (transaction) while recovery.rebind_wallet moves a binding; removed before it returns.
CREATE TABLE recovery.rebind_context (
  txid       bigint PRIMARY KEY,
  old_wallet text NOT NULL,
  new_wallet text NOT NULL
);

-- kyc.wallets stays append-only except for the one update an executed recovery makes (0009 Y-5 amended).
DROP TRIGGER wallets_append_only ON kyc.wallets;
CREATE FUNCTION kyc.guard_wallet() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, kyc AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.subject_id = OLD.subject_id AND NEW.wallet IS DISTINCT FROM OLD.wallet
     AND EXISTS (SELECT 1 FROM recovery.rebind_context x WHERE x.txid = txid_current() AND x.old_wallet = OLD.wallet AND x.new_wallet = NEW.wallet) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'kyc records are append-only: % on %.% is not allowed (a wallet binding moves only with an executed wallet recovery)',
    TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER wallets_append_only BEFORE UPDATE OR DELETE ON kyc.wallets FOR EACH ROW EXECUTE FUNCTION kyc.guard_wallet();

-- ================================================================== append-only tables (RV-9)
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['audit', 'reversal_reasons', 'reversible_kinds', 'approvals', 'documents', 'heirs', 'wallet_history'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON recovery.%I FOR EACH ROW EXECUTE FUNCTION recovery.forbid_change()', t || '_append_only', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['audit', 'reversal_reasons', 'reversible_kinds', 'cases', 'approvals', 'documents', 'heirs', 'proposals', 'wallet_history'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON recovery.%I FOR EACH STATEMENT EXECUTE FUNCTION recovery.forbid_change()', t || '_no_truncate', t);
  END LOOP;
END $$;

-- ================================================================== officer names bound to sessions (RV-9, as 0016 A-3)
CREATE TRIGGER cases_officer_binding BEFORE INSERT OR UPDATE ON recovery.cases
  FOR EACH ROW EXECUTE FUNCTION compliance.bind_actor('opened_by', 'cancelled_by', 'release_proposed_by', 'released_by');
CREATE TRIGGER approvals_officer_binding BEFORE INSERT ON recovery.approvals FOR EACH ROW EXECUTE FUNCTION compliance.bind_actor('officer');
CREATE TRIGGER documents_officer_binding BEFORE INSERT ON recovery.documents FOR EACH ROW EXECUTE FUNCTION compliance.bind_actor('added_by');
CREATE TRIGGER heirs_officer_binding BEFORE INSERT ON recovery.heirs FOR EACH ROW EXECUTE FUNCTION compliance.bind_actor('added_by');

-- ================================================================== notification of the investor's contacts (RC-2)
INSERT INTO notify.event_kinds (kind, category, placeholders, description) VALUES
  ('security.wallet_recovery_requested', 'security',
   '{"at": {"type": "utc"}, "objection_until": {"type": "utc"}}',
   'A recovery of the investor''s wallet was requested (S-06 RC-2); the investor can object until the given time.');

SELECT notify.add_template(t.kind, t.channel, t.locale, t.subject, t.body, 'migration:0020')
FROM (VALUES
  ('security.wallet_recovery_requested', 'sms', 'en', NULL,
   'Property Token: a recovery of your wallet was requested at {{at}}. Not you? Contact support in the app before {{objection_until}}. We never ask for codes.'),
  ('security.wallet_recovery_requested', 'sms', 'ur', NULL,
   'پراپرٹی ٹوکن: {{at}} پر آپ کے والیٹ کی ریکوری کی درخواست آئی۔ آپ نہیں تھے؟ {{objection_until}} سے پہلے ایپ میں سپورٹ سے رابطہ کریں۔'),
  ('security.wallet_recovery_requested', 'email', 'en', 'A recovery of your Property Token wallet was requested',
   E'A recovery of your wallet was requested at {{at}}.\n\nIf you asked for it, no action is needed: nothing moves before {{objection_until}} and the trustee''s 48-hour delay after that.\nIf you did not, open the Property Token app yourself (do not use links in messages) and contact support before {{objection_until}}.'),
  ('security.wallet_recovery_requested', 'email', 'ur', 'آپ کے پراپرٹی ٹوکن والیٹ کی ریکوری کی درخواست',
   E'{{at}} پر آپ کے والیٹ کی ریکوری کی درخواست دی گئی۔\n\nاگر یہ درخواست آپ نے دی ہے تو کچھ کرنے کی ضرورت نہیں: {{objection_until}} سے پہلے اور اس کے بعد ٹرسٹی کے 48 گھنٹے کے وقفے تک کچھ منتقل نہیں ہوگا۔\nاگر نہیں، تو پراپرٹی ٹوکن ایپ خود کھولیں (پیغامات میں دیے گئے لنک استعمال نہ کریں) اور {{objection_until}} سے پہلے سپورٹ سے رابطہ کریں۔')
) AS t(kind, channel, locale, subject, body);

-- ================================================================== derived facts
CREATE FUNCTION recovery.case_id_hex(p_case_ref bytea) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$ SELECT '0x' || encode(p_case_ref, 'hex') $$;

/** Capacities a kind needs (RV-2). */
CREATE FUNCTION recovery.capacities(p_kind text) RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT CASE p_kind
    WHEN 'wallet_recovery' THEN ARRAY['operations', 'compliance']
    WHEN 'succession' THEN ARRAY['legal', 'compliance']
    WHEN 'reversal' THEN ARRAY['operations']
    ELSE '{}'::text[] END
$$;

/** The portal role behind a capacity. */
CREATE FUNCTION recovery.capacity_role(p_capacity text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT CASE p_capacity WHEN 'operations' THEN 'ops_checker' WHEN 'compliance' THEN 'compliance_officer' WHEN 'legal' THEN 'legal_officer' END
$$;

/** An officer acts only in a capacity one of their roles gives; backend operator names (not officers) are checked by role grants. */
CREATE FUNCTION recovery.capacity_ok(p_actor text, p_capacity text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, recovery AS $$
  SELECT recovery.capacity_role(p_capacity) IS NOT NULL
     AND (NOT EXISTS (SELECT 1 FROM admin.officers o WHERE o.handle = p_actor)
          OR admin.officer_holds(p_actor, ARRAY[recovery.capacity_role(p_capacity)], true))
$$;

/** Read model: balance, address freeze and registry identity of a wallet for a case's token. */
CREATE FUNCTION recovery.balance_of(p_token text, p_wallet text) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, recovery AS $$
  SELECT coalesce((SELECT h.balance FROM chain.holdings h WHERE h.token = p_token AND h.holder = p_wallet), 0)
$$;

CREATE FUNCTION recovery.frozen_on_chain(p_token text, p_wallet text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, recovery AS $$
  SELECT coalesce((SELECT f.address_frozen FROM chain.freezes f WHERE f.token = p_token AND f.holder = p_wallet), false)
$$;

CREATE FUNCTION recovery.registered_identity(p_registry text, p_wallet text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, recovery AS $$
  SELECT i.identity FROM chain.investors i WHERE i.registry = p_registry AND i.wallet = p_wallet AND i.registered AND NOT i.identity_stale
$$;

/** RF-8: NADRA and liveness passed again for this subject after p_since. */
CREATE FUNCTION recovery.reverified(p_subject uuid, p_since timestamptz) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, recovery AS $$
  SELECT EXISTS (SELECT 1 FROM kyc.checks c WHERE c.subject_id = p_subject AND c.kind = 'nadra' AND c.outcome = 'pass' AND c.at > p_since)
     AND EXISTS (SELECT 1 FROM kyc.checks c WHERE c.subject_id = p_subject AND c.kind = 'liveness' AND c.outcome = 'pass' AND c.at > p_since)
$$;

/** Evidence hash for RecoveryGuard: SHA-256 over the documents' hashes and (recovery) the fresh re-verification evidence, sorted. */
CREATE FUNCTION recovery.evidence_hash(p_case bigint) RETURNS bytea
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, recovery AS $$
  SELECT sha256(convert_to('pt-evidence-v1' || c.case_uuid::text || coalesce((
    SELECT string_agg(h, ',' ORDER BY h) FROM (
      SELECT encode(d.sha256, 'hex') AS h FROM recovery.documents d WHERE d.case_id = c.id
      UNION ALL
      SELECT encode(k.evidence_sha256, 'hex') FROM kyc.checks k
      WHERE c.kind = 'wallet_recovery' AND k.subject_id = c.subject_id AND k.kind IN ('nadra', 'liveness') AND k.outcome = 'pass' AND k.at > c.opened_at
    ) x), ''), 'UTF8'))
  FROM recovery.cases c WHERE c.id = p_case
$$;

/** What the officers review (digest bound to every decision). */
CREATE FUNCTION recovery.case_digest(p_case bigint) RETURNS bytea
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, recovery AS $$
  SELECT sha256(convert_to('pt-recovery-case-v1' || jsonb_build_array(
    c.id, c.kind, c.status, c.subject_id, c.from_wallet, c.to_wallet, c.onchain_id, c.journal_id, c.reason_code, c.summary,
    encode(c.evidence_sha256, 'hex'), c.release_proposed_by,
    coalesce((SELECT jsonb_agg(jsonb_build_array(d.id, d.doc_type, d.reference, encode(d.sha256, 'hex')) ORDER BY d.id) FROM recovery.documents d WHERE d.case_id = c.id), '[]'),
    coalesce((SELECT jsonb_agg(jsonb_build_array(h.id, h.subject_id, h.wallet, h.share_num, h.share_den) ORDER BY h.id) FROM recovery.heirs h WHERE h.case_id = c.id), '[]'),
    coalesce((SELECT jsonb_agg(jsonb_build_array(a.capacity, a.officer, a.decision) ORDER BY a.id) FROM recovery.approvals a WHERE a.case_id = c.id), '[]')
  )::text, 'UTF8'))
  FROM recovery.cases c WHERE c.id = p_case
$$;

/**
 * RF-14 allocation: floor(balance x share) per heir; with a family settlement the remaining units go
 * to the largest fractional remainders (ties: the heir added first), otherwise they stay unallocated.
 * Fractions are compared exactly enough: two different remainders r1/d1 and r2/d2 (denominators
 * below 2^31) differ by at least 1/(d1 d2) > 1e-19, far above the 1e-40 resolution used here.
 */
CREATE FUNCTION recovery.allocation(p_case bigint, p_balance numeric, p_settlement boolean)
RETURNS TABLE (heir_id bigint, units numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, recovery AS $$
  WITH b AS (
    SELECT h.id, floor(p_balance * h.share_num / h.share_den) AS base,
           div(mod(p_balance * h.share_num, h.share_den::numeric) * 10::numeric ^ 40, h.share_den::numeric) AS rkey
    FROM recovery.heirs h WHERE h.case_id = p_case
  ), r AS (
    SELECT p_balance - coalesce(sum(base), 0) AS leftover FROM b
  ), ranked AS (
    SELECT b.id, b.base, row_number() OVER (ORDER BY b.rkey DESC, b.id) AS rk FROM b
  )
  SELECT ranked.id, ranked.base + CASE WHEN p_settlement AND ranked.rk <= (SELECT leftover FROM r) THEN 1 ELSE 0 END
  FROM ranked ORDER BY ranked.id
$$;

/** Shares of a succession sum to exactly 1 (exact rational arithmetic). */
CREATE FUNCTION recovery.shares_complete(p_case bigint) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, recovery AS $$
DECLARE
  v_lcm numeric := 1;
  v_sum numeric := 0;
  h recovery.heirs;
  v_any boolean := false;
BEGIN
  FOR h IN SELECT * FROM recovery.heirs x WHERE x.case_id = p_case LOOP
    v_lcm := lcm(v_lcm, h.share_den::numeric);
    v_any := true;
  END LOOP;
  IF NOT v_any THEN RETURN false; END IF;
  FOR h IN SELECT * FROM recovery.heirs x WHERE x.case_id = p_case LOOP
    v_sum := v_sum + h.share_num::numeric * (v_lcm / h.share_den::numeric);
  END LOOP;
  RETURN v_sum = v_lcm;
END $$;

/** RF-18: why a journal cannot be reversed (NULL: it can). */
CREATE FUNCTION recovery.reversal_problem(p_journal bigint) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, recovery AS $$
DECLARE
  j ledger.journal;
BEGIN
  SELECT * INTO j FROM ledger.journal WHERE id = p_journal;
  IF NOT FOUND THEN RETURN 'unknown journal'; END IF;
  IF j.kind = 'reversal' THEN RETURN 'a correcting journal is never reversed'; END IF;
  IF NOT EXISTS (SELECT 1 FROM recovery.reversible_kinds k WHERE k.kind = j.kind) THEN
    RETURN format('journals of kind %s are not reversible (platform-error corrections only: %s)', j.kind,
                  (SELECT string_agg(kind, ', ' ORDER BY kind) FROM recovery.reversible_kinds));
  END IF;
  IF j.idempotency_key ~ '^(sub:|web:sub:|web:trade:|web:order:|rent:|bank:|case:)' THEN
    RETURN 'the journal belongs to a subscription, trade, rent distribution, payout, bank return or case: never reversed';
  END IF;
  IF j.external_ref IS NOT NULL AND EXISTS (SELECT 1 FROM chain.events e WHERE e.tx_hash = lower(j.external_ref)) THEN
    RETURN 'the journal refers to an on-chain transaction: a legitimate trade or token movement is never reversed';
  END IF;
  IF EXISTS (SELECT 1 FROM recovery.cases c WHERE c.kind = 'reversal' AND c.journal_id = p_journal AND c.status IN ('opened', 'closed')) THEN
    RETURN 'the journal already has an open or completed reversal';
  END IF;
  RETURN NULL;
END $$;

-- ================================================================== maker functions
CREATE FUNCTION recovery.new_case_ref(p_uuid uuid) RETURNS bytea
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$ SELECT sha256(convert_to('pt-case-v1:' || p_uuid::text, 'UTF8')) $$;

/** RF-7 / RF-12: opens a wallet-recovery or succession case for the subject's bound wallet. */
CREATE FUNCTION recovery.open_case(p_kind text, p_subject uuid, p_summary text, p_actor text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, recovery AS $$
DECLARE
  v_wallet text;
  v_freeze jsonb := recovery.policy('recovery.freeze');
  v_propose jsonb := recovery.policy('recovery.propose');
  v_token text;
  v_registry text;
  v_identity text;
  v_uuid uuid := gen_random_uuid();
  v_id bigint;
  v_now timestamptz := date_trunc('microseconds', clock_timestamp());
  c recovery.cases;
  v_key text;
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('wallet_recovery', 'succession') THEN
    PERFORM recovery.fail('23514', 'kind must be wallet_recovery or succession');
  END IF;
  IF p_actor IS NULL OR length(p_actor) NOT BETWEEN 2 AND 100 OR NOT compliance.free_text_ok(p_summary, 10, 1000) THEN
    PERFORM recovery.fail('23514', 'a summary of 10 to 1000 characters is required (never a CNIC, IBAN or phone number)');
  END IF;
  IF v_freeze IS NULL OR v_propose IS NULL THEN
    PERFORM recovery.fail('23514', 'no active recovery.freeze and recovery.propose signing policies: nothing could be executed');
  END IF;
  v_token := lower(v_propose->>'token');
  v_registry := lower(v_propose->>'identityRegistry');
  IF lower(v_freeze->>'token') IS DISTINCT FROM v_token THEN
    PERFORM recovery.fail('23514', 'the recovery.freeze and recovery.propose policies name different tokens');
  END IF;
  PERFORM pg_advisory_xact_lock(586586201);
  SELECT w.wallet INTO v_wallet FROM kyc.wallets w WHERE w.subject_id = p_subject;
  IF NOT FOUND THEN PERFORM recovery.fail('P0002', 'the investor has no bound wallet'); END IF;
  IF recovery.balance_of(v_token, v_wallet) <= 0 THEN
    PERFORM recovery.fail('23514', 'the wallet holds no units of the token (read model): nothing to recover');
  END IF;
  IF EXISTS (SELECT 1 FROM recovery.cases x WHERE x.from_wallet = v_wallet AND x.status IN ('opened', 'approved', 'executed')) THEN
    PERFORM recovery.fail('23505', 'a live recovery or succession case exists for this wallet');
  END IF;
  IF p_kind = 'wallet_recovery' THEN
    v_identity := recovery.registered_identity(v_registry, v_wallet);
    IF v_identity IS NULL THEN PERFORM recovery.fail('23514', 'the wallet is not registered with an identity in the read model'); END IF;
  END IF;
  v_id := nextval(pg_get_serial_sequence('recovery.cases', 'id'));
  -- C1 protective freeze, unless the read model already shows the wallet frozen.
  IF NOT recovery.frozen_on_chain(v_token, v_wallet) THEN v_key := format('recovery.freeze:case:%s', v_id); END IF;
  INSERT INTO recovery.cases (id, case_uuid, case_ref, kind, subject_id, token, recovery_guard, freeze_guard, identity_registry, from_wallet,
                              onchain_id, summary, objection_until, opened_by, opened_at, updated_at, freeze_key)
  OVERRIDING SYSTEM VALUE
  VALUES (v_id, v_uuid, recovery.new_case_ref(v_uuid), p_kind, p_subject, v_token, lower(v_propose->>'recoveryGuard'), lower(v_freeze->>'freezeGuard'),
          v_registry, v_wallet, v_identity, btrim(p_summary),
          CASE WHEN p_kind = 'wallet_recovery' THEN v_now + recovery.objection_window() END, p_actor, v_now, v_now, v_key)
  RETURNING * INTO c;
  IF v_key IS NOT NULL THEN
    PERFORM outbox.enqueue(v_key, 'recovery.freeze',
      jsonb_build_object('freezeGuard', c.freeze_guard, 'account', c.from_wallet, 'caseId', recovery.case_id_hex(c.case_ref)),
      c.subject_id::text, p_actor);
  END IF;
  PERFORM recovery.audit_append(p_actor, 'case.opened', jsonb_build_object('case', v_id, 'kind', p_kind, 'subject', p_subject, 'wallet', v_wallet,
    'caseId', recovery.case_id_hex(c.case_ref), 'freezeCommand', v_key, 'objectionUntil', recovery.utc(c.objection_until)));
  IF p_kind = 'wallet_recovery' THEN
    PERFORM notify.enqueue(format('recovery:case:%s:requested', v_id), 'security.wallet_recovery_requested', 'investor', p_subject::text,
      jsonb_build_object('at', to_char(v_now AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                         'objection_until', to_char(c.objection_until AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')), p_actor);
  END IF;
  RETURN v_id;
END $$;

/** RF-17..19: opens the reversal of one journal booked in error by the platform. */
CREATE FUNCTION recovery.open_reversal(p_journal bigint, p_reason_code text, p_summary text, p_evidence bytea, p_actor text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, recovery AS $$
DECLARE
  v_problem text;
  v_uuid uuid := gen_random_uuid();
  v_id bigint;
  v_now timestamptz := date_trunc('microseconds', clock_timestamp());
BEGIN
  IF p_actor IS NULL OR length(p_actor) NOT BETWEEN 2 AND 100 OR NOT compliance.free_text_ok(p_summary, 10, 1000) THEN
    PERFORM recovery.fail('23514', 'a summary of 10 to 1000 characters is required (never a CNIC, IBAN or phone number)');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM recovery.reversal_reasons WHERE code = p_reason_code) THEN
    PERFORM recovery.fail('23514', format('reason code %s is not a platform-error reason', coalesce(p_reason_code, '(none)')));
  END IF;
  IF p_evidence IS NULL OR length(p_evidence) <> 32 THEN PERFORM recovery.fail('23514', 'the SHA-256 of the evidence (incident record) is required'); END IF;
  PERFORM pg_advisory_xact_lock(586586201);
  v_problem := recovery.reversal_problem(p_journal);
  IF v_problem IS NOT NULL THEN PERFORM recovery.fail('23514', v_problem); END IF;
  v_id := nextval(pg_get_serial_sequence('recovery.cases', 'id'));
  INSERT INTO recovery.cases (id, case_uuid, case_ref, kind, journal_id, reason_code, evidence_sha256, summary, opened_by, opened_at, updated_at)
  OVERRIDING SYSTEM VALUE
  VALUES (v_id, v_uuid, recovery.new_case_ref(v_uuid), 'reversal', p_journal, p_reason_code, p_evidence, btrim(p_summary), p_actor, v_now, v_now);
  PERFORM recovery.audit_append(p_actor, 'case.opened', jsonb_build_object('case', v_id, 'kind', 'reversal', 'journal', p_journal,
    'reasonCode', p_reason_code, 'evidence', encode(p_evidence, 'hex')));
  RETURN v_id;
END $$;

/** RF-9: sets the new custodial wallet of a wallet-recovery case (before any approval). */
CREATE FUNCTION recovery.set_new_wallet(p_case bigint, p_wallet text, p_actor text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, recovery AS $$
DECLARE
  c recovery.cases;
  v_wallet text := lower(btrim(p_wallet));
BEGIN
  IF NOT recovery.is_address(v_wallet) THEN PERFORM recovery.fail('23514', 'a wallet address (0x + 40 hex digits) is required'); END IF;
  PERFORM pg_advisory_xact_lock(586586201);
  SELECT * INTO c FROM recovery.cases WHERE id = p_case FOR UPDATE;
  IF NOT FOUND THEN PERFORM recovery.fail('P0002', 'unknown case'); END IF;
  IF c.kind <> 'wallet_recovery' THEN PERFORM recovery.fail('23514', 'only a wallet-recovery case has a new wallet'); END IF;
  IF c.status <> 'opened' OR EXISTS (SELECT 1 FROM recovery.approvals a WHERE a.case_id = c.id) THEN
    PERFORM recovery.fail('23514', 'the new wallet can be set only before any approval');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM signer.custodial_wallets w WHERE w.address = v_wallet) THEN
    PERFORM recovery.fail('23514', 'the new wallet must be a custodial wallet of the signing service');
  END IF;
  IF EXISTS (SELECT 1 FROM kyc.wallets w WHERE w.wallet = v_wallet) OR EXISTS (SELECT 1 FROM recovery.wallet_history h WHERE h.old_wallet = v_wallet) THEN
    PERFORM recovery.fail('23505', 'the wallet is (or was) bound to an investor');
  END IF;
  IF EXISTS (SELECT 1 FROM chain.investors i WHERE i.wallet = v_wallet AND i.registered) OR recovery.balance_of(c.token, v_wallet) > 0 THEN
    PERFORM recovery.fail('23514', 'the new wallet must be unregistered and hold nothing');
  END IF;
  IF EXISTS (SELECT 1 FROM recovery.cases x WHERE x.to_wallet = v_wallet AND x.id <> c.id AND x.status IN ('opened', 'approved', 'executed')) THEN
    PERFORM recovery.fail('23505', 'the wallet is the new wallet of another live case');
  END IF;
  UPDATE recovery.cases SET to_wallet = v_wallet, updated_at = clock_timestamp() WHERE id = c.id;
  PERFORM recovery.audit_append(p_actor, 'case.wallet_set', jsonb_build_object('case', c.id, 'wallet', v_wallet, 'previous', c.to_wallet));
END $$;

/** RF-12: records a document of a case (metadata and SHA-256 only). */
CREATE FUNCTION recovery.add_document(p_case bigint, p_type text, p_reference text, p_issuer text, p_sha256 bytea, p_actor text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, recovery AS $$
DECLARE
  c recovery.cases;
  v_id bigint;
BEGIN
  IF p_sha256 IS NULL OR length(p_sha256) <> 32 THEN PERFORM recovery.fail('23514', 'the document''s SHA-256 is required'); END IF;
  IF NOT compliance.free_text_ok(p_reference, 3, 120) OR (p_issuer IS NOT NULL AND NOT compliance.free_text_ok(p_issuer, 2, 120)) THEN
    PERFORM recovery.fail('23514', 'a reference of 3 to 120 characters (and an optional issuer) is required, never a CNIC, IBAN or phone number');
  END IF;
  SELECT * INTO c FROM recovery.cases WHERE id = p_case FOR UPDATE;
  IF NOT FOUND THEN PERFORM recovery.fail('P0002', 'unknown case'); END IF;
  IF c.kind = 'reversal' THEN PERFORM recovery.fail('23514', 'a reversal carries its evidence hash from opening'); END IF;
  IF c.status <> 'opened' OR EXISTS (SELECT 1 FROM recovery.approvals a WHERE a.case_id = c.id) THEN
    PERFORM recovery.fail('23514', 'documents can be added only before any approval');
  END IF;
  INSERT INTO recovery.documents (case_id, doc_type, reference, issuer, sha256, added_by, added_at)
  VALUES (c.id, p_type, btrim(p_reference), nullif(btrim(p_issuer), ''), p_sha256, p_actor, date_trunc('microseconds', clock_timestamp()))
  RETURNING id INTO v_id;
  UPDATE recovery.cases SET updated_at = clock_timestamp() WHERE id = c.id;
  PERFORM recovery.audit_append(p_actor, 'case.document_added', jsonb_build_object('case', c.id, 'document', v_id, 'type', p_type,
    'sha256', encode(p_sha256, 'hex')));
  RETURN v_id;
END $$;

/** RF-13: adds an heir with a share (fraction) to a succession case. */
CREATE FUNCTION recovery.add_heir(p_case bigint, p_subject uuid, p_num integer, p_den integer, p_actor text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, recovery AS $$
DECLARE
  c recovery.cases;
  v_wallet text;
  v_id bigint;
BEGIN
  IF p_num IS NULL OR p_den IS NULL OR p_num <= 0 OR p_den <= 0 OR p_num > p_den THEN
    PERFORM recovery.fail('23514', 'a share is a fraction numerator/denominator with 0 < numerator <= denominator');
  END IF;
  SELECT * INTO c FROM recovery.cases WHERE id = p_case FOR UPDATE;
  IF NOT FOUND THEN PERFORM recovery.fail('P0002', 'unknown case'); END IF;
  IF c.kind <> 'succession' THEN PERFORM recovery.fail('23514', 'only a succession case has heirs'); END IF;
  IF c.status <> 'opened' OR EXISTS (SELECT 1 FROM recovery.approvals a WHERE a.case_id = c.id) THEN
    PERFORM recovery.fail('23514', 'heirs can be added only before any approval');
  END IF;
  IF p_subject = c.subject_id THEN PERFORM recovery.fail('23514', 'the deceased cannot be an heir'); END IF;
  IF kyc.subject_status(p_subject) <> 'verified' THEN PERFORM recovery.fail('23514', 'every heir must be KYC-verified (RC-12)'); END IF;
  SELECT w.wallet INTO v_wallet FROM kyc.wallets w WHERE w.subject_id = p_subject;
  IF NOT FOUND THEN PERFORM recovery.fail('23514', 'the heir has no bound wallet'); END IF;
  IF recovery.registered_identity(c.identity_registry, v_wallet) IS NULL THEN
    PERFORM recovery.fail('23514', 'the heir''s wallet is not registered in the identity registry');
  END IF;
  INSERT INTO recovery.heirs (case_id, subject_id, wallet, share_num, share_den, added_by, added_at)
  VALUES (c.id, p_subject, v_wallet, p_num, p_den, p_actor, date_trunc('microseconds', clock_timestamp()))
  RETURNING id INTO v_id;
  UPDATE recovery.cases SET updated_at = clock_timestamp() WHERE id = c.id;
  PERFORM recovery.audit_append(p_actor, 'case.heir_added', jsonb_build_object('case', c.id, 'heir', v_id, 'subject', p_subject, 'wallet', v_wallet,
    'share', format('%s/%s', p_num, p_den)));
  RETURN v_id;
END $$;

-- ================================================================== approval (RV-2..RV-5)
/** Why the case cannot be approved now (NULL: it can). */
CREATE FUNCTION recovery.approve_problem(p_case bigint) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, recovery AS $$
DECLARE
  c recovery.cases;
  h recovery.heirs;
  v_policy jsonb;
BEGIN
  SELECT * INTO c FROM recovery.cases WHERE id = p_case;
  IF NOT FOUND THEN RETURN 'unknown case'; END IF;
  IF c.status <> 'opened' THEN RETURN format('the case is %s', c.status); END IF;
  IF c.kind = 'reversal' THEN RETURN recovery.reversal_problem_for(c); END IF;
  v_policy := recovery.policy('recovery.propose');
  IF v_policy IS NULL OR lower(v_policy->>'recoveryGuard') IS DISTINCT FROM c.recovery_guard OR lower(v_policy->>'token') IS DISTINCT FROM c.token THEN
    RETURN 'no active recovery.propose signing policy for this case''s token and RecoveryGuard';
  END IF;
  IF c.kind = 'wallet_recovery' AND clock_timestamp() < c.objection_until THEN
    RETURN format('the objection window runs until %s UTC (RC-2)', to_char(c.objection_until AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI'));
  END IF;
  IF NOT recovery.frozen_on_chain(c.token, c.from_wallet) THEN RETURN 'the wallet is not frozen on chain yet (protective freeze first, read model)'; END IF;
  IF recovery.balance_of(c.token, c.from_wallet) <= 0 THEN RETURN 'the wallet holds no units (read model)'; END IF;
  IF c.kind = 'wallet_recovery' THEN
    IF recovery.policy('recovery.add_key') IS NULL THEN RETURN 'no active recovery.add_key signing policy'; END IF;
    IF c.to_wallet IS NULL THEN RETURN 'no new custodial wallet yet'; END IF;
    IF EXISTS (SELECT 1 FROM kyc.wallets w WHERE w.wallet = c.to_wallet) OR EXISTS (SELECT 1 FROM chain.investors i WHERE i.wallet = c.to_wallet AND i.registered)
       OR recovery.balance_of(c.token, c.to_wallet) > 0 THEN
      RETURN 'the new wallet is no longer unbound, unregistered and empty';
    END IF;
    IF NOT recovery.reverified(c.subject_id, c.opened_at) THEN RETURN 'NADRA and liveness must pass again after the case was opened (RC-2)'; END IF;
    IF kyc.subject_status(c.subject_id) <> 'verified' THEN
      RETURN format('the investor''s KYC status is %s: only a verified investor''s wallet is recovered', kyc.subject_status(c.subject_id));
    END IF;
    IF recovery.registered_identity(c.identity_registry, c.from_wallet) IS DISTINCT FROM c.onchain_id THEN
      RETURN 'the wallet''s identity in the read model changed since opening';
    END IF;
    RETURN NULL;
  END IF;
  -- succession
  IF NOT EXISTS (SELECT 1 FROM recovery.documents d WHERE d.case_id = c.id AND d.doc_type = 'death_certificate') THEN
    RETURN 'a death certificate must be recorded (RC-11)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM recovery.documents d WHERE d.case_id = c.id AND d.doc_type IN ('succession_certificate', 'letters_of_administration', 'court_order')) THEN
    RETURN 'a succession certificate, letters of administration or a court order must be recorded (RC-11)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM recovery.heirs x WHERE x.case_id = c.id) THEN RETURN 'no heir recorded'; END IF;
  IF NOT recovery.shares_complete(c.id) THEN RETURN 'the heirs'' shares do not sum to exactly 1'; END IF;
  FOR h IN SELECT * FROM recovery.heirs x WHERE x.case_id = c.id ORDER BY x.id LOOP
    IF kyc.subject_status(h.subject_id) <> 'verified' THEN RETURN format('heir %s is no longer KYC-verified', h.id); END IF;
    IF NOT EXISTS (SELECT 1 FROM kyc.wallets w WHERE w.subject_id = h.subject_id AND w.wallet = h.wallet) THEN
      RETURN format('heir %s''s bound wallet changed: reject and open a new case', h.id);
    END IF;
    IF recovery.registered_identity(c.identity_registry, h.wallet) IS NULL THEN RETURN format('heir %s''s wallet is not registered', h.id); END IF;
  END LOOP;
  RETURN NULL;
END $$;

/** RV-5 for a reversal case. */
CREATE FUNCTION recovery.reversal_problem_for(c recovery.cases) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, recovery AS $$
DECLARE
  j ledger.journal;
BEGIN
  SELECT * INTO j FROM ledger.journal WHERE id = c.journal_id;
  IF NOT EXISTS (SELECT 1 FROM recovery.reversible_kinds k WHERE k.kind = j.kind) OR j.kind = 'reversal' THEN RETURN 'the journal is not reversible'; END IF;
  IF j.idempotency_key ~ '^(sub:|web:sub:|web:trade:|web:order:|rent:|bank:|case:)' THEN RETURN 'the journal belongs to a protected flow'; END IF;
  IF j.external_ref IS NOT NULL AND EXISTS (SELECT 1 FROM chain.events e WHERE e.tx_hash = lower(j.external_ref)) THEN
    RETURN 'the journal refers to an on-chain transaction';
  END IF;
  RETURN NULL;
END $$;

/** Posts the correcting journal of a reversal case (exact contra postings). */
CREATE FUNCTION recovery.post_reversal(c recovery.cases, p_actor text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, recovery AS $$
DECLARE
  j ledger.journal;
  v_postings jsonb;
BEGIN
  SELECT * INTO j FROM ledger.journal WHERE id = c.journal_id;
  SELECT jsonb_agg(jsonb_build_object('account', a.code, 'amount', (-p.amount)::text) ORDER BY p.id) INTO v_postings
  FROM ledger.postings p JOIN ledger.accounts a ON a.id = p.account_id WHERE p.journal_id = j.id;
  RETURN ledger.post_journal('case:' || encode(c.case_ref, 'hex') || ':reversal', 'reversal',
    left(format('reversal of journal %s (%s): %s', j.id, c.reason_code, c.summary), 500), j.external_ref, p_actor, v_postings);
END $$;

/** RF-10 / RF-15: on the final approval, the on-chain requests and their commands. */
CREATE FUNCTION recovery.start_onchain(c recovery.cases, p_actor text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, recovery AS $$
DECLARE
  v_evidence bytea := recovery.evidence_hash(c.id);
  v_balance numeric := recovery.balance_of(c.token, c.from_wallet);
  v_settlement boolean;
  v_add jsonb := recovery.policy('recovery.add_key');
  v_now timestamptz := date_trunc('microseconds', clock_timestamp());
  v_seq integer := 0;
  v_key text;
  v_add_key text;
  v_residual numeric := 0;
  a record;
BEGIN
  IF c.kind = 'wallet_recovery' THEN
    v_add_key := format('recovery.add_key:case:%s', c.id);
    PERFORM outbox.enqueue(v_add_key, 'recovery.add_key',
      jsonb_build_object('identity', c.onchain_id, 'wallet', c.from_wallet, 'newWallet', c.to_wallet, 'caseId', recovery.case_id_hex(c.case_ref)),
      c.subject_id::text, p_actor);
    v_key := format('recovery.propose:case:%s:1', c.id);
    INSERT INTO recovery.proposals (case_id, kind, recovery_guard, from_wallet, to_wallet, onchain_id, amount, evidence_hash, propose_key, created_at, updated_at)
    VALUES (c.id, 'wallet_recovery', c.recovery_guard, c.from_wallet, c.to_wallet, c.onchain_id, 0, v_evidence, v_key, v_now, v_now);
    PERFORM outbox.enqueue(v_key, 'recovery.propose',
      jsonb_build_object('recoveryGuard', c.recovery_guard, 'kind', 'wallet_recovery', 'from', c.from_wallet, 'to', c.to_wallet,
                         'onchainId', c.onchain_id, 'amount', '0', 'evidenceHash', '0x' || encode(v_evidence, 'hex'), 'caseId', recovery.case_id_hex(c.case_ref)),
      c.subject_id::text, p_actor);
  ELSE
    v_settlement := EXISTS (SELECT 1 FROM recovery.documents d WHERE d.case_id = c.id AND d.doc_type = 'family_settlement');
    v_residual := v_balance;
    FOR a IN SELECT x.heir_id, x.units, h.wallet FROM recovery.allocation(c.id, v_balance, v_settlement) x JOIN recovery.heirs h ON h.id = x.heir_id ORDER BY x.heir_id LOOP
      v_residual := v_residual - a.units;
      CONTINUE WHEN a.units = 0;
      v_seq := v_seq + 1;
      v_key := format('recovery.propose:case:%s:%s', c.id, v_seq);
      INSERT INTO recovery.proposals (case_id, heir_id, kind, recovery_guard, from_wallet, to_wallet, onchain_id, amount, evidence_hash, propose_key, created_at, updated_at)
      VALUES (c.id, a.heir_id, 'forced_transfer', c.recovery_guard, c.from_wallet, a.wallet, recovery.zero_address(), a.units, v_evidence, v_key, v_now, v_now);
      PERFORM outbox.enqueue(v_key, 'recovery.propose',
        jsonb_build_object('recoveryGuard', c.recovery_guard, 'kind', 'forced_transfer', 'from', c.from_wallet, 'to', a.wallet,
                           'onchainId', recovery.zero_address(), 'amount', a.units::text, 'evidenceHash', '0x' || encode(v_evidence, 'hex'),
                           'caseId', recovery.case_id_hex(c.case_ref)),
        c.subject_id::text, p_actor);
    END LOOP;
    IF v_seq = 0 THEN PERFORM recovery.fail('23514', 'no heir receives a whole unit: nothing to transfer (cash-out, RC-14)'); END IF;
  END IF;
  UPDATE recovery.cases SET status = 'approved', approved_at = v_now, updated_at = v_now, evidence_hash = v_evidence, units_total = v_balance,
         units_residual = CASE WHEN c.kind = 'succession' THEN v_residual ELSE 0 END, add_key_key = v_add_key
  WHERE id = c.id;
  PERFORM recovery.audit_append(p_actor, 'case.approved', jsonb_build_object('case', c.id, 'kind', c.kind, 'evidenceHash', encode(v_evidence, 'hex'),
    'units', v_balance::text, 'residual', CASE WHEN c.kind = 'succession' THEN v_residual::text ELSE '0' END, 'requests', greatest(v_seq, 1),
    'addKeyCommand', v_add_key, 'settlement', v_settlement));
END $$;

/** RV-2: an officer's approval or rejection in a capacity of the case's kind. */
CREATE FUNCTION recovery.decide(p_case bigint, p_actor text, p_capacity text, p_decision text, p_reason text, p_digest bytea)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, recovery AS $$
DECLARE
  c recovery.cases;
  v_problem text;
  v_now timestamptz := date_trunc('microseconds', clock_timestamp());
  v_journal bigint;
BEGIN
  IF p_decision IS NULL OR p_decision NOT IN ('approve', 'reject') THEN PERFORM recovery.fail('23514', 'decision must be approve or reject'); END IF;
  IF p_actor IS NULL OR length(p_actor) NOT BETWEEN 2 AND 100 OR NOT compliance.free_text_ok(p_reason, 10, 500) THEN
    PERFORM recovery.fail('23514', 'a reason of 10 to 500 characters is required (never a CNIC, IBAN or phone number)');
  END IF;
  PERFORM pg_advisory_xact_lock(586586201);
  SELECT * INTO c FROM recovery.cases WHERE id = p_case FOR UPDATE;
  IF NOT FOUND THEN PERFORM recovery.fail('P0002', 'unknown case'); END IF;
  IF p_digest IS NULL OR recovery.case_digest(c.id) IS DISTINCT FROM p_digest THEN
    PERFORM recovery.fail('23514', 'the case differs from what you reviewed: reload and check again');
  END IF;
  IF c.status <> 'opened' THEN PERFORM recovery.fail('23514', format('the case is %s', c.status)); END IF;
  IF p_capacity IS NULL OR NOT (p_capacity = ANY (recovery.capacities(c.kind))) THEN
    PERFORM recovery.fail('23514', format('a %s case is decided in the capacities %s', c.kind, array_to_string(recovery.capacities(c.kind), ' and ')));
  END IF;
  IF NOT recovery.capacity_ok(p_actor, p_capacity) THEN
    PERFORM recovery.fail('42501', format('you do not hold the %s role needed to decide as %s', recovery.capacity_role(p_capacity), p_capacity));
  END IF;
  IF p_actor = c.opened_by THEN PERFORM recovery.fail('23514', 'maker-checker: the officer who opened the case cannot decide it'); END IF;
  IF EXISTS (SELECT 1 FROM recovery.approvals a WHERE a.case_id = c.id AND a.officer = p_actor) THEN
    PERFORM recovery.fail('23514', 'you already decided this case: a different officer decides in the other capacity');
  END IF;
  IF EXISTS (SELECT 1 FROM recovery.approvals a WHERE a.case_id = c.id AND a.capacity = p_capacity) THEN
    PERFORM recovery.fail('23505', format('the %s decision was already taken', p_capacity));
  END IF;
  IF p_decision = 'approve' THEN
    v_problem := recovery.approve_problem(c.id);
    IF v_problem IS NOT NULL THEN PERFORM recovery.fail('23514', v_problem); END IF;
  END IF;
  INSERT INTO recovery.approvals (case_id, capacity, officer, decision, reason, digest, at)
  VALUES (c.id, p_capacity, p_actor, p_decision, btrim(p_reason), p_digest, v_now);
  PERFORM recovery.audit_append(p_actor, 'case.decided', jsonb_build_object('case', c.id, 'capacity', p_capacity, 'decision', p_decision,
    'reason', btrim(p_reason), 'digest', encode(p_digest, 'hex')));
  IF p_decision = 'reject' THEN
    UPDATE recovery.cases SET status = 'rejected', updated_at = v_now WHERE id = c.id;
    PERFORM recovery.audit_append(p_actor, 'case.rejected', jsonb_build_object('case', c.id, 'capacity', p_capacity));
    RETURN 'rejected';
  END IF;
  IF (SELECT count(*) FROM recovery.approvals a WHERE a.case_id = c.id AND a.decision = 'approve') < cardinality(recovery.capacities(c.kind)) THEN
    UPDATE recovery.cases SET updated_at = v_now WHERE id = c.id;
    RETURN 'opened';
  END IF;
  IF c.kind = 'reversal' THEN
    v_journal := recovery.post_reversal(c, p_actor);
    UPDATE recovery.cases SET status = 'closed', approved_at = v_now, closed_at = v_now, updated_at = v_now, reversal_journal_id = v_journal WHERE id = c.id;
    PERFORM recovery.audit_append(p_actor, 'case.reversed', jsonb_build_object('case', c.id, 'journal', c.journal_id, 'reversal', v_journal));
    RETURN 'closed';
  END IF;
  PERFORM recovery.start_onchain(c, p_actor);
  RETURN 'approved';
END $$;

/** Objection or error: cancels a case before execution; pending on-chain requests are cancelled by the tick. */
CREATE FUNCTION recovery.cancel(p_case bigint, p_actor text, p_reason text, p_digest bytea)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, recovery AS $$
DECLARE
  c recovery.cases;
  v_now timestamptz := date_trunc('microseconds', clock_timestamp());
BEGIN
  IF p_actor IS NULL OR length(p_actor) NOT BETWEEN 2 AND 100 OR NOT compliance.free_text_ok(p_reason, 10, 500) THEN
    PERFORM recovery.fail('23514', 'a reason of 10 to 500 characters is required (never a CNIC, IBAN or phone number)');
  END IF;
  PERFORM pg_advisory_xact_lock(586586201);
  SELECT * INTO c FROM recovery.cases WHERE id = p_case FOR UPDATE;
  IF NOT FOUND THEN PERFORM recovery.fail('P0002', 'unknown case'); END IF;
  IF p_digest IS NULL OR recovery.case_digest(c.id) IS DISTINCT FROM p_digest THEN
    PERFORM recovery.fail('23514', 'the case differs from what you reviewed: reload and check again');
  END IF;
  IF c.status NOT IN ('opened', 'approved') OR (c.kind = 'reversal' AND c.status <> 'opened') THEN
    PERFORM recovery.fail('23514', format('a %s case cannot be cancelled', c.status));
  END IF;
  IF EXISTS (SELECT 1 FROM recovery.proposals p WHERE p.case_id = c.id AND p.status = 'executed') THEN
    PERFORM recovery.fail('23514', 'an on-chain request of this case already executed: it can no longer be cancelled');
  END IF;
  UPDATE recovery.cases SET status = 'cancelled', cancelled_by = p_actor, cancel_reason = btrim(p_reason), updated_at = v_now WHERE id = c.id;
  -- Requests not yet proposed are never proposed now (the signing service asks recovery.command_allowed).
  UPDATE recovery.proposals SET status = 'cancelled', updated_at = v_now
  WHERE case_id = c.id AND status = 'enqueued'
    AND NOT EXISTS (SELECT 1 FROM outbox.commands o WHERE o.idempotency_key = recovery.proposals.propose_key AND o.status IN ('claimed', 'submitted', 'confirmed', 'review'));
  PERFORM recovery.audit_append(p_actor, 'case.cancelled', jsonb_build_object('case', c.id, 'reason', btrim(p_reason), 'digest', encode(p_digest, 'hex')));
  PERFORM recovery.tick_case(c.id, p_actor);
  RETURN 'cancelled';
END $$;

/** RV-8: release (unfreeze) after execution, rejection or cancellation: two compliance officers. */
CREATE FUNCTION recovery.release(p_case bigint, p_actor text, p_reason text, p_digest bytea)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, recovery AS $$
DECLARE
  c recovery.cases;
  v_now timestamptz := date_trunc('microseconds', clock_timestamp());
  v_wallet text;
  v_key text;
  v_unfreeze jsonb;
BEGIN
  IF p_actor IS NULL OR length(p_actor) NOT BETWEEN 2 AND 100 OR NOT compliance.free_text_ok(p_reason, 10, 500) THEN
    PERFORM recovery.fail('23514', 'a reason of 10 to 500 characters is required (never a CNIC, IBAN or phone number)');
  END IF;
  PERFORM pg_advisory_xact_lock(586586201);
  SELECT * INTO c FROM recovery.cases WHERE id = p_case FOR UPDATE;
  IF NOT FOUND THEN PERFORM recovery.fail('P0002', 'unknown case'); END IF;
  IF p_digest IS NULL OR recovery.case_digest(c.id) IS DISTINCT FROM p_digest THEN
    PERFORM recovery.fail('23514', 'the case differs from what you reviewed: reload and check again');
  END IF;
  IF c.kind = 'reversal' OR c.status NOT IN ('executed', 'rejected', 'cancelled') THEN
    PERFORM recovery.fail('23514', 'only an executed, rejected or cancelled recovery or succession case is released');
  END IF;
  IF c.kind = 'succession' AND c.status = 'executed' THEN
    PERFORM recovery.fail('23514', 'units remain in the deceased''s wallet for a cash-out (RC-14): it stays frozen');
  END IF;
  IF EXISTS (SELECT 1 FROM recovery.proposals p WHERE p.case_id = c.id AND p.status IN ('enqueued', 'pending')) THEN
    PERFORM recovery.fail('23514', 'an on-chain request of this case is still open: refresh from the chain first');
  END IF;
  IF NOT recovery.capacity_ok(p_actor, 'compliance') THEN PERFORM recovery.fail('42501', 'only a compliance officer releases a freeze'); END IF;
  IF p_actor = c.opened_by THEN PERFORM recovery.fail('23514', 'the officer who opened (froze) the case cannot release it (RC-SOD-2)'); END IF;
  IF c.release_proposed_by IS NULL THEN
    UPDATE recovery.cases SET release_proposed_by = p_actor, release_reason = btrim(p_reason), release_proposed_at = v_now, updated_at = v_now WHERE id = c.id;
    PERFORM recovery.audit_append(p_actor, 'case.release_proposed', jsonb_build_object('case', c.id, 'reason', btrim(p_reason)));
    RETURN c.status;
  END IF;
  IF c.release_proposed_by = p_actor THEN
    PERFORM recovery.fail('23514', 'you proposed the release: a different compliance officer confirms it (RC-SOD-2)');
  END IF;
  v_wallet := CASE WHEN c.kind = 'wallet_recovery' AND c.status = 'executed' THEN c.to_wallet ELSE c.from_wallet END;
  IF recovery.frozen_on_chain(c.token, v_wallet) THEN
    v_unfreeze := recovery.policy('recovery.unfreeze');
    IF v_unfreeze IS NULL OR lower(v_unfreeze->>'freezeGuard') IS DISTINCT FROM c.freeze_guard THEN
      PERFORM recovery.fail('23514', 'no active recovery.unfreeze signing policy for this FreezeGuard');
    END IF;
    v_key := format('recovery.unfreeze:case:%s', c.id);
  END IF;
  UPDATE recovery.cases SET released_by = p_actor, released_at = v_now, unfreeze_wallet = v_wallet, unfreeze_key = v_key,
         status = 'closed', closed_at = v_now, updated_at = v_now
  WHERE id = c.id;
  IF v_key IS NOT NULL THEN
    PERFORM outbox.enqueue(v_key, 'recovery.unfreeze',
      jsonb_build_object('freezeGuard', c.freeze_guard, 'account', v_wallet, 'caseId', recovery.case_id_hex(c.case_ref)), c.subject_id::text, p_actor);
  END IF;
  PERFORM recovery.audit_append(p_actor, 'case.released', jsonb_build_object('case', c.id, 'wallet', v_wallet, 'command', v_key,
    'proposedBy', c.release_proposed_by, 'reason', btrim(p_reason)));
  RETURN 'closed';
END $$;

-- ================================================================== RV-7 rebinding
CREATE FUNCTION recovery.rebind_wallet(c recovery.cases, p_actor text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, recovery AS $$
BEGIN
  INSERT INTO recovery.rebind_context (txid, old_wallet, new_wallet) VALUES (txid_current(), c.from_wallet, c.to_wallet);
  UPDATE kyc.wallets SET wallet = c.to_wallet, bound_at = date_trunc('microseconds', clock_timestamp()), bound_by = left(p_actor, 100)
  WHERE subject_id = c.subject_id AND wallet = c.from_wallet;
  IF NOT FOUND THEN PERFORM recovery.fail('P0002', 'the investor''s binding is no longer the old wallet'); END IF;
  DELETE FROM recovery.rebind_context WHERE txid = txid_current();
  INSERT INTO recovery.wallet_history (subject_id, old_wallet, new_wallet, case_id, at, actor)
  VALUES (c.subject_id, c.from_wallet, c.to_wallet, c.id, date_trunc('microseconds', clock_timestamp()), left(p_actor, 100));
  -- kyc.verify_audit() expects a wallet.bound entry for every bound wallet.
  PERFORM kyc.audit_append(p_actor, 'wallet.bound', jsonb_build_object('wallet', c.to_wallet, 'subject', c.subject_id, 'recoveryCase', c.id,
    'previous', c.from_wallet));
  PERFORM recovery.audit_append(p_actor, 'wallet.rebound', jsonb_build_object('case', c.id, 'subject', c.subject_id, 'old', c.from_wallet, 'new', c.to_wallet));
END $$;

-- ================================================================== RF-6 the tick (chain -> case)
CREATE FUNCTION recovery.tick_case(p_case bigint, p_actor text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, recovery AS $$
DECLARE
  c recovery.cases;
  p recovery.proposals;
  o outbox.commands;
  r chain.recoveries;
  v_id numeric;
  v_n integer := 0;
  v_key text;
  v_now timestamptz;
BEGIN
  SELECT * INTO c FROM recovery.cases WHERE id = p_case FOR UPDATE;
  IF NOT FOUND THEN RETURN 0; END IF;
  FOR p IN SELECT * FROM recovery.proposals x WHERE x.case_id = c.id AND x.status IN ('enqueued', 'pending') ORDER BY x.id FOR UPDATE LOOP
    v_now := date_trunc('microseconds', clock_timestamp());
    IF p.status = 'enqueued' THEN
      SELECT * INTO o FROM outbox.commands WHERE idempotency_key = p.propose_key;
      IF o.status = 'confirmed' AND o.tx_hash IS NOT NULL THEN
        SELECT (e.args->>'id')::numeric INTO v_id FROM chain.events e
        WHERE e.tx_hash = o.tx_hash AND e.name = 'RecoveryProposed' AND e.address = p.recovery_guard LIMIT 1;
        CONTINUE WHEN v_id IS NULL;  -- the indexer has not seen it yet
        SELECT * INTO r FROM chain.recoveries WHERE guard = p.recovery_guard AND id = v_id;
        CONTINUE WHEN NOT FOUND;
        UPDATE recovery.proposals SET request_id = v_id, eta = r.eta, status = 'pending', updated_at = v_now WHERE id = p.id RETURNING * INTO p;
        PERFORM recovery.audit_append(p_actor, 'request.proposed', jsonb_build_object('case', c.id, 'proposal', p.id, 'requestId', v_id::text,
          'eta', r.eta, 'tx', o.tx_hash));
        v_n := v_n + 1;
      ELSIF o.status = 'failed' OR (o.id IS NOT NULL AND c.status = 'cancelled' AND o.status = 'pending') THEN
        UPDATE recovery.proposals SET status = CASE WHEN c.status = 'cancelled' THEN 'cancelled' ELSE 'failed' END, updated_at = v_now WHERE id = p.id;
        PERFORM recovery.audit_append(p_actor, 'request.failed', jsonb_build_object('case', c.id, 'proposal', p.id, 'command', o.status,
          'error', left(o.last_error, 200)));
        v_n := v_n + 1;
        CONTINUE;
      ELSE
        CONTINUE;
      END IF;
    END IF;
    -- pending: follow the read model
    SELECT * INTO r FROM chain.recoveries WHERE guard = p.recovery_guard AND id = p.request_id;
    IF r.status IN ('executed', 'cancelled') THEN
      UPDATE recovery.proposals SET status = r.status, updated_at = v_now WHERE id = p.id;
      PERFORM recovery.audit_append(p_actor, 'request.' || r.status, jsonb_build_object('case', c.id, 'proposal', p.id, 'requestId', p.request_id::text));
      v_n := v_n + 1;
      CONTINUE;
    END IF;
    IF c.status = 'cancelled' AND p.cancel_key IS NULL THEN
      v_key := format('recovery.cancel:proposal:%s', p.id);
      PERFORM outbox.enqueue(v_key, 'recovery.cancel',
        jsonb_build_object('recoveryGuard', p.recovery_guard, 'requestId', p.request_id::text, 'caseId', recovery.case_id_hex(c.case_ref)),
        c.subject_id::text, p_actor);
      UPDATE recovery.proposals SET cancel_key = v_key, updated_at = v_now WHERE id = p.id;
      PERFORM recovery.audit_append(p_actor, 'request.cancel_enqueued', jsonb_build_object('case', c.id, 'proposal', p.id, 'command', v_key));
      v_n := v_n + 1;
    ELSIF c.status = 'approved' AND p.eta <= extract(epoch FROM clock_timestamp())
          AND p.execute_attempts < recovery.max_execute_attempts()
          AND (p.execute_key IS NULL OR EXISTS (SELECT 1 FROM outbox.commands x WHERE x.idempotency_key = p.execute_key AND x.status = 'failed')) THEN
      v_key := format('recovery.execute:proposal:%s:%s', p.id, p.execute_attempts + 1);
      PERFORM outbox.enqueue(v_key, 'recovery.execute',
        jsonb_build_object('recoveryGuard', p.recovery_guard, 'requestId', p.request_id::text, 'caseId', recovery.case_id_hex(c.case_ref)),
        c.subject_id::text, p_actor);
      UPDATE recovery.proposals SET execute_key = v_key, execute_attempts = p.execute_attempts + 1, updated_at = v_now WHERE id = p.id;
      PERFORM recovery.audit_append(p_actor, 'request.execute_enqueued', jsonb_build_object('case', c.id, 'proposal', p.id, 'command', v_key));
      v_n := v_n + 1;
    END IF;
  END LOOP;

  -- Case level: every request executed -> executed (and the KYC binding moves for a recovery).
  IF c.status = 'approved' AND EXISTS (SELECT 1 FROM recovery.proposals x WHERE x.case_id = c.id)
     AND NOT EXISTS (SELECT 1 FROM recovery.proposals x WHERE x.case_id = c.id AND x.status <> 'executed') THEN
    v_now := date_trunc('microseconds', clock_timestamp());
    IF c.kind = 'wallet_recovery' THEN PERFORM recovery.rebind_wallet(c, p_actor); END IF;
    IF c.kind = 'succession' AND c.units_residual = 0 THEN
      UPDATE recovery.cases SET status = 'executed', updated_at = v_now WHERE id = c.id;
      UPDATE recovery.cases SET status = 'closed', closed_at = v_now, updated_at = v_now WHERE id = c.id;
      PERFORM recovery.audit_append(p_actor, 'case.executed', jsonb_build_object('case', c.id, 'closed', true));
    ELSE
      UPDATE recovery.cases SET status = 'executed', updated_at = v_now WHERE id = c.id;
      PERFORM recovery.audit_append(p_actor, 'case.executed', jsonb_build_object('case', c.id, 'closed', false));
    END IF;
    v_n := v_n + 1;
  END IF;
  RETURN v_n;
END $$;

/** All live cases (npm run recovery:tick, and the portal's "Refresh from chain"). */
CREATE FUNCTION recovery.tick(p_actor text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, recovery AS $$
DECLARE
  v_case bigint;
  v_n integer := 0;
BEGIN
  IF p_actor IS NULL OR length(p_actor) NOT BETWEEN 2 AND 100 THEN PERFORM recovery.fail('23514', 'an actor is required'); END IF;
  PERFORM pg_advisory_xact_lock(586586201);
  FOR v_case IN SELECT DISTINCT p.case_id FROM recovery.proposals p WHERE p.status IN ('enqueued', 'pending')
                UNION SELECT c.id FROM recovery.cases c WHERE c.status = 'approved' ORDER BY 1 LOOP
    v_n := v_n + recovery.tick_case(v_case, p_actor);
  END LOOP;
  RETURN v_n;
END $$;

-- ================================================================== RV-6 the signing service's gate
/**
 * For the signing service (deny by default): is this exactly a command a case enqueued, and are the
 * case and its request in the state the kind needs now? Chain facts are checked by the policy.
 */
CREATE FUNCTION recovery.command_allowed(p_kind text, p_payload jsonb) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, recovery AS $$
  SELECT CASE p_kind
    WHEN 'recovery.freeze' THEN EXISTS (
      SELECT 1 FROM recovery.cases c JOIN outbox.commands o ON o.idempotency_key = c.freeze_key
      WHERE o.kind = p_kind AND o.payload = p_payload AND c.status IN ('opened', 'approved'))
    WHEN 'recovery.add_key' THEN EXISTS (
      SELECT 1 FROM recovery.cases c JOIN outbox.commands o ON o.idempotency_key = c.add_key_key
      WHERE o.kind = p_kind AND o.payload = p_payload AND c.kind = 'wallet_recovery' AND c.status = 'approved')
    WHEN 'recovery.propose' THEN EXISTS (
      SELECT 1 FROM recovery.proposals p JOIN recovery.cases c ON c.id = p.case_id JOIN outbox.commands o ON o.idempotency_key = p.propose_key
      WHERE o.kind = p_kind AND o.payload = p_payload AND p.status = 'enqueued' AND c.status = 'approved')
    WHEN 'recovery.execute' THEN EXISTS (
      SELECT 1 FROM recovery.proposals p JOIN recovery.cases c ON c.id = p.case_id JOIN outbox.commands o ON o.idempotency_key = p.execute_key
      WHERE o.kind = p_kind AND o.payload = p_payload AND p.status = 'pending' AND c.status = 'approved'
        AND p.eta <= extract(epoch FROM clock_timestamp())
        AND (c.kind <> 'wallet_recovery' OR kyc.subject_status(c.subject_id) = 'verified')
        AND (p.heir_id IS NULL OR EXISTS (SELECT 1 FROM recovery.heirs h WHERE h.id = p.heir_id AND kyc.subject_status(h.subject_id) = 'verified')))
    WHEN 'recovery.cancel' THEN EXISTS (
      SELECT 1 FROM recovery.proposals p JOIN recovery.cases c ON c.id = p.case_id JOIN outbox.commands o ON o.idempotency_key = p.cancel_key
      WHERE o.kind = p_kind AND o.payload = p_payload AND p.status = 'pending' AND c.status = 'cancelled')
    WHEN 'recovery.unfreeze' THEN EXISTS (
      SELECT 1 FROM recovery.cases c JOIN outbox.commands o ON o.idempotency_key = c.unfreeze_key
      WHERE o.kind = p_kind AND o.payload = p_payload AND c.status = 'closed' AND c.released_by IS NOT NULL)
    ELSE false END
$$;

/** For the signing service: pending RecoveryGuard requests from a wallet in the read model (count and units). */
CREATE FUNCTION recovery.pending_from(p_guard text, p_wallet text) RETURNS TABLE (requests bigint, amount numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, recovery AS $$
  SELECT count(*), coalesce(sum(r.amount), 0) FROM chain.recoveries r
  WHERE r.guard = lower(p_guard) AND r.from_addr = lower(p_wallet) AND r.status = 'pending'
$$;

-- ================================================================== reconciliation views (RF-20, section 14.7)
CREATE VIEW recovery.recon_requests AS
SELECT p.recovery_guard AS guard, p.request_id, p.case_id, p.status, p.kind, p.from_wallet, p.to_wallet, p.amount
FROM recovery.proposals p WHERE p.request_id IS NOT NULL;

CREATE VIEW recovery.recon_reversals AS
SELECT c.id AS case_id, c.journal_id, c.reversal_journal_id, c.status FROM recovery.cases c WHERE c.kind = 'reversal' AND c.status = 'closed';

-- ================================================================== verification (RV-9)
CREATE FUNCTION recovery.verify_audit() RETURNS TABLE (audit_id bigint, problem text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, recovery AS $$
DECLARE
  a recovery.audit;
  v_prev bytea := decode(repeat('00', 32), 'hex');
  r record;
BEGIN
  FOR a IN SELECT * FROM recovery.audit ORDER BY id LOOP
    IF a.prev_hash <> v_prev THEN audit_id := a.id; problem := 'prev_hash does not match'; RETURN NEXT; END IF;
    IF a.hash <> recovery.audit_digest(a.prev_hash, a.id, a.at, a.actor, a.action, a.detail) THEN
      audit_id := a.id; problem := 'content does not match its hash'; RETURN NEXT;
    END IF;
    v_prev := a.hash;
  END LOOP;
  FOR r IN
    SELECT format('case %s', c.id) AS what FROM recovery.cases c WHERE NOT EXISTS (
      SELECT 1 FROM recovery.audit x WHERE x.action = 'case.opened' AND (x.detail->>'case')::bigint = c.id AND x.detail->>'kind' = c.kind)
    UNION ALL
    SELECT format('case %s: %s without its audit entry', c.id, c.status) FROM recovery.cases c
      WHERE (c.status IN ('approved', 'executed') OR (c.approved_at IS NOT NULL AND c.kind <> 'reversal')) AND NOT EXISTS (
        SELECT 1 FROM recovery.audit x WHERE x.action = 'case.approved' AND (x.detail->>'case')::bigint = c.id)
    UNION ALL
    SELECT format('case %s: reversal journal without its audit entry', c.id) FROM recovery.cases c
      WHERE c.reversal_journal_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM recovery.audit x WHERE x.action = 'case.reversed' AND (x.detail->>'case')::bigint = c.id AND (x.detail->>'reversal')::bigint = c.reversal_journal_id)
    UNION ALL
    SELECT format('case %s: release without its audit entry', c.id) FROM recovery.cases c
      WHERE c.released_by IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM recovery.audit x WHERE x.action = 'case.released' AND (x.detail->>'case')::bigint = c.id AND x.actor = c.released_by)
    UNION ALL
    SELECT format('approval %s', a2.id) FROM recovery.approvals a2 WHERE NOT EXISTS (
      SELECT 1 FROM recovery.audit x WHERE x.action = 'case.decided' AND (x.detail->>'case')::bigint = a2.case_id AND x.actor = a2.officer
        AND x.detail->>'capacity' = a2.capacity AND x.detail->>'decision' = a2.decision)
    UNION ALL
    SELECT format('document %s', d.id) FROM recovery.documents d WHERE NOT EXISTS (
      SELECT 1 FROM recovery.audit x WHERE x.action = 'case.document_added' AND (x.detail->>'document')::bigint = d.id AND x.detail->>'sha256' = encode(d.sha256, 'hex'))
    UNION ALL
    SELECT format('heir %s', h.id) FROM recovery.heirs h WHERE NOT EXISTS (
      SELECT 1 FROM recovery.audit x WHERE x.action = 'case.heir_added' AND (x.detail->>'heir')::bigint = h.id AND x.detail->>'wallet' = h.wallet)
    UNION ALL
    SELECT format('wallet history %s', w.id) FROM recovery.wallet_history w WHERE NOT EXISTS (
      SELECT 1 FROM recovery.audit x WHERE x.action = 'wallet.rebound' AND (x.detail->>'case')::bigint = w.case_id AND x.detail->>'new' = w.new_wallet)
      OR NOT EXISTS (SELECT 1 FROM recovery.cases c WHERE c.id = w.case_id AND c.kind = 'wallet_recovery' AND c.to_wallet = w.new_wallet AND c.from_wallet = w.old_wallet)
    UNION ALL
    SELECT format('request %s', p.id) FROM recovery.proposals p WHERE p.request_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM recovery.audit x WHERE x.action = 'request.proposed' AND (x.detail->>'proposal')::bigint = p.id AND x.detail->>'requestId' = p.request_id::text)
  LOOP
    audit_id := NULL; problem := r.what || ' has no matching audit entry'; RETURN NEXT;
  END LOOP;
END $$;

-- ================================================================== portal (admin.*): role and permissions
INSERT INTO admin.roles (role, description) VALUES
  ('legal_officer', 'Legal: verifies succession instruments and court orders; co-decides succession cases');
INSERT INTO admin.role_conflicts (a, b, reason) VALUES
  ('admin', 'legal_officer', 'the legal reviewer is independent of every other duty in a case'),
  ('auditor', 'legal_officer', 'auditors are read-only and independent of everyone they audit'),
  ('compliance_officer', 'legal_officer', 'the legal reviewer is independent of every other duty in a case'),
  ('legal_officer', 'ops_checker', 'the legal reviewer is independent of every other duty in a case'),
  ('legal_officer', 'ops_maker', 'the legal reviewer is independent of every other duty in a case'),
  ('legal_officer', 'trustee_officer', 'trustee officers belong to the independent trustee and hold no platform role');
INSERT INTO admin.role_permissions (role, permission) VALUES
  ('ops_maker', 'recovery.read'), ('ops_checker', 'recovery.read'), ('compliance_officer', 'recovery.read'), ('legal_officer', 'recovery.read'),
  ('auditor', 'recovery.read'),
  ('ops_maker', 'recovery.request'),
  ('ops_checker', 'recovery.decide'), ('compliance_officer', 'recovery.decide'), ('legal_officer', 'recovery.decide');

DO $$
BEGIN
  EXECUTE format('CREATE OR REPLACE FUNCTION admin.expected_role_matrix_digest() RETURNS text LANGUAGE sql IMMUTABLE AS %L',
                 format('SELECT %L::text', admin.role_matrix_digest()));
END $$;

/** The capacities this officer holds for a case kind. */
CREATE FUNCTION admin.recovery_capacities(p_handle text, p_kind text) RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
  SELECT coalesce(array_agg(x ORDER BY x), '{}') FROM unnest(recovery.capacities(p_kind)) x
  WHERE admin.officer_holds(p_handle, ARRAY[recovery.capacity_role(x)], true)
$$;

CREATE FUNCTION admin.recovery_policies() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
  SELECT jsonb_object_agg(k, recovery.policy('recovery.' || k) IS NOT NULL)
  FROM unnest(ARRAY['freeze', 'unfreeze', 'add_key', 'propose', 'execute', 'cancel']) k
$$;

-- ------------------------------------------------------------------ reads (recovery.read)
CREATE FUNCTION admin.recovery_cases(p_session bytea, p_kind text, p_status text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'recovery.read');
BEGIN
  RETURN jsonb_build_object(
    'at', admin.utc(clock_timestamp()),
    'policies', admin.recovery_policies(),
    'reasons', (SELECT jsonb_agg(jsonb_build_object('code', code, 'label', label) ORDER BY code) FROM recovery.reversal_reasons),
    'reversibleKinds', (SELECT jsonb_agg(jsonb_build_object('kind', kind, 'label', label) ORDER BY kind) FROM recovery.reversible_kinds),
    'counts', coalesce((SELECT jsonb_object_agg(kind || ':' || status, n) FROM (SELECT kind, status, count(*) AS n FROM recovery.cases GROUP BY 1, 2) q), '{}'::jsonb),
    'cases', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'id', c.id, 'kind', c.kind, 'status', c.status,
        'subject', CASE WHEN c.subject_id IS NOT NULL THEN left(replace(c.subject_id::text, '-', ''), 8) END,
        'wallet', c.from_wallet, 'newWallet', c.to_wallet, 'journal', c.journal_id, 'openedBy', c.opened_by,
        'openedAt', admin.utc(c.opened_at), 'updatedAt', admin.utc(c.updated_at),
        'approvals', (SELECT count(*) FROM recovery.approvals a WHERE a.case_id = c.id AND a.decision = 'approve'),
        'needed', cardinality(recovery.capacities(c.kind)),
        'objectionUntil', admin.utc(c.objection_until)) ORDER BY c.id DESC)
      FROM (SELECT * FROM recovery.cases
            WHERE (p_kind IS NULL OR kind = p_kind) AND (p_status IS NULL OR status = p_status)
            ORDER BY id DESC LIMIT 300) c), '[]'::jsonb));
END $$;

CREATE FUNCTION admin.recovery_case(p_session bytea, p_id bigint) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'recovery.read');
  v_handle text := admin.handle_of(v_me);
  c recovery.cases;
  v_request boolean := admin.has_permission(p_session, 'recovery.request');
  v_decide boolean := admin.has_permission(p_session, 'recovery.decide');
  v_caps text[];
  v_open text[];
  v_problem text;
  v_maker text[] := '{}';
  v_decision text[] := '{}';
  v_cancel text[] := '{}';
  v_release text[] := '{}';
  v_approve text[] := '{}';
  v_alloc jsonb;
  j ledger.journal;
BEGIN
  SELECT * INTO c FROM recovery.cases WHERE id = p_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  v_caps := admin.recovery_capacities(v_handle, c.kind);
  v_open := ARRAY(SELECT x FROM unnest(v_caps) x WHERE NOT EXISTS (SELECT 1 FROM recovery.approvals a WHERE a.case_id = c.id AND a.capacity = x));
  -- Maker actions (documents, heirs, new wallet)
  IF NOT v_request THEN v_maker := v_maker || 'Only an operations maker prepares a case; your role reads it.'::text; END IF;
  IF c.status <> 'opened' OR EXISTS (SELECT 1 FROM recovery.approvals a WHERE a.case_id = c.id) THEN
    v_maker := v_maker || 'The case can no longer change: an officer has decided it.'::text;
  END IF;
  -- Decisions
  IF NOT v_decide THEN v_decision := v_decision || 'Only operations checkers, compliance and legal officers decide cases; your role reads them.'::text; END IF;
  IF c.status <> 'opened' THEN v_decision := v_decision || format('The case is %s.', c.status); END IF;
  IF v_decide AND cardinality(v_caps) = 0 THEN
    v_decision := v_decision || format('A %s case is decided as %s: you hold neither role.', c.kind, array_to_string(recovery.capacities(c.kind), ' and '));
  END IF;
  IF c.opened_by = v_handle THEN v_decision := v_decision || 'You opened this case: different officers decide it (maker-checker).'::text; END IF;
  IF EXISTS (SELECT 1 FROM recovery.approvals a WHERE a.case_id = c.id AND a.officer = v_handle) THEN
    v_decision := v_decision || 'You already decided this case: a different officer decides in the other capacity.'::text;
  ELSIF cardinality(v_caps) > 0 AND cardinality(v_open) = 0 AND c.status = 'opened' THEN
    v_decision := v_decision || 'Your capacity has already decided.'::text;
  END IF;
  v_problem := recovery.approve_problem(c.id);
  IF v_problem IS NOT NULL AND c.status = 'opened' THEN v_approve := v_approve || v_problem; END IF;
  -- Cancel
  IF NOT v_decide THEN v_cancel := v_cancel || 'Only a deciding officer cancels a case.'::text; END IF;
  IF c.status NOT IN ('opened', 'approved') OR (c.kind = 'reversal' AND c.status <> 'opened') THEN v_cancel := v_cancel || format('A %s case cannot be cancelled.', c.status); END IF;
  IF EXISTS (SELECT 1 FROM recovery.proposals p WHERE p.case_id = c.id AND p.status = 'executed') THEN
    v_cancel := v_cancel || 'An on-chain request already executed.'::text;
  END IF;
  -- Release
  IF NOT admin.officer_holds(v_handle, ARRAY['compliance_officer'], true) THEN v_release := v_release || 'Only a compliance officer releases a freeze.'::text; END IF;
  IF c.kind = 'reversal' OR c.status NOT IN ('executed', 'rejected', 'cancelled') OR (c.kind = 'succession' AND c.status = 'executed') THEN
    v_release := v_release || 'Nothing to release in this state.'::text;
  END IF;
  IF c.opened_by = v_handle THEN v_release := v_release || 'You opened (froze) this case.'::text; END IF;
  IF c.release_proposed_by = v_handle THEN v_release := v_release || 'You proposed the release: a different compliance officer confirms it.'::text; END IF;
  IF EXISTS (SELECT 1 FROM recovery.proposals p WHERE p.case_id = c.id AND p.status IN ('enqueued', 'pending')) THEN
    v_release := v_release || 'An on-chain request is still open: refresh from the chain first.'::text;
  END IF;
  IF c.kind = 'succession' AND c.status = 'opened' THEN
    v_alloc := (SELECT jsonb_agg(jsonb_build_object('heir', x.heir_id, 'units', x.units::text) ORDER BY x.heir_id)
                FROM recovery.allocation(c.id, recovery.balance_of(c.token, c.from_wallet),
                                         EXISTS (SELECT 1 FROM recovery.documents d WHERE d.case_id = c.id AND d.doc_type = 'family_settlement')) x);
  END IF;
  IF c.kind = 'reversal' THEN SELECT * INTO j FROM ledger.journal WHERE id = c.journal_id; END IF;
  RETURN jsonb_build_object(
    'id', c.id, 'kind', c.kind, 'status', c.status, 'caseId', recovery.case_id_hex(c.case_ref),
    'summary', c.summary, 'openedBy', c.opened_by, 'openedAt', admin.utc(c.opened_at), 'updatedAt', admin.utc(c.updated_at),
    'objectionUntil', admin.utc(c.objection_until), 'approvedAt', admin.utc(c.approved_at), 'closedAt', admin.utc(c.closed_at),
    'subject', CASE WHEN c.subject_id IS NOT NULL THEN admin.subject_json(c.subject_id) END,
    'token', c.token, 'recoveryGuard', c.recovery_guard, 'wallet', c.from_wallet, 'newWallet', c.to_wallet, 'identity', c.onchain_id,
    'onChain', CASE WHEN c.kind <> 'reversal' THEN jsonb_build_object(
        'balance', recovery.balance_of(c.token, c.from_wallet)::text, 'frozen', recovery.frozen_on_chain(c.token, c.from_wallet),
        'newWalletBalance', CASE WHEN c.to_wallet IS NOT NULL THEN recovery.balance_of(c.token, c.to_wallet)::text END,
        'newWalletFrozen', CASE WHEN c.to_wallet IS NOT NULL THEN recovery.frozen_on_chain(c.token, c.to_wallet) END) END,
    'reverified', CASE WHEN c.kind = 'wallet_recovery' THEN recovery.reverified(c.subject_id, c.opened_at) END,
    'evidenceHash', CASE WHEN c.evidence_hash IS NOT NULL THEN '0x' || encode(c.evidence_hash, 'hex') END,
    'unitsTotal', c.units_total::text, 'unitsResidual', c.units_residual::text,
    'journal', CASE WHEN c.kind = 'reversal' THEN jsonb_build_object('id', j.id, 'kind', j.kind, 'key', j.idempotency_key, 'externalRef', j.external_ref,
        'memo', j.memo, 'createdAt', admin.utc(j.created_at),
        'postings', (SELECT jsonb_agg(jsonb_build_object('account', a.code, 'amount', p.amount::text) ORDER BY p.id)
                     FROM ledger.postings p JOIN ledger.accounts a ON a.id = p.account_id WHERE p.journal_id = j.id)) END,
    'reasonCode', c.reason_code, 'evidenceSha256', CASE WHEN c.evidence_sha256 IS NOT NULL THEN encode(c.evidence_sha256, 'hex') END,
    'reversalJournal', c.reversal_journal_id,
    'cancelledBy', c.cancelled_by, 'cancelReason', c.cancel_reason,
    'releaseProposedBy', c.release_proposed_by, 'releaseReason', c.release_reason, 'releasedBy', c.released_by, 'unfreezeWallet', c.unfreeze_wallet,
    'commands', jsonb_build_object('freeze', admin.command_json(c.freeze_key), 'addKey', admin.command_json(c.add_key_key),
                                   'unfreeze', admin.command_json(c.unfreeze_key)),
    'documents', coalesce((SELECT jsonb_agg(jsonb_build_object('id', d.id, 'type', d.doc_type, 'reference', d.reference, 'issuer', d.issuer,
        'sha256', encode(d.sha256, 'hex'), 'addedBy', d.added_by, 'addedAt', admin.utc(d.added_at)) ORDER BY d.id)
      FROM recovery.documents d WHERE d.case_id = c.id), '[]'::jsonb),
    'heirs', coalesce((SELECT jsonb_agg(jsonb_build_object('id', h.id, 'subject', left(replace(h.subject_id::text, '-', ''), 8),
        'cnic', (SELECT admin.mask_cnic(s.cnic_last4) FROM kyc.subjects s WHERE s.id = h.subject_id), 'status', kyc.subject_status(h.subject_id),
        'wallet', h.wallet, 'share', format('%s/%s', h.share_num, h.share_den), 'addedBy', h.added_by) ORDER BY h.id)
      FROM recovery.heirs h WHERE h.case_id = c.id), '[]'::jsonb),
    'allocationPreview', v_alloc,
    'approvals', coalesce((SELECT jsonb_agg(jsonb_build_object('capacity', a.capacity, 'officer', a.officer, 'decision', a.decision, 'reason', a.reason,
        'at', admin.utc(a.at)) ORDER BY a.id) FROM recovery.approvals a WHERE a.case_id = c.id), '[]'::jsonb),
    'needed', to_jsonb(recovery.capacities(c.kind)),
    'requests', coalesce((SELECT jsonb_agg(jsonb_build_object('id', p.id, 'kind', p.kind, 'from', p.from_wallet, 'to', p.to_wallet,
        'amount', p.amount::text, 'status', p.status, 'requestId', p.request_id::text,
        'eta', CASE WHEN p.eta IS NOT NULL THEN admin.utc(to_timestamp(p.eta)) END,
        'propose', admin.command_json(p.propose_key), 'execute', admin.command_json(p.execute_key), 'cancel', admin.command_json(p.cancel_key)) ORDER BY p.id)
      FROM recovery.proposals p WHERE p.case_id = c.id), '[]'::jsonb),
    'policies', admin.recovery_policies(),
    'myCapacities', to_jsonb(v_open),
    'digest', encode(recovery.case_digest(c.id), 'hex'),
    'blockers', jsonb_build_object('maker', to_jsonb(v_maker), 'decide', to_jsonb(v_decision), 'approve', to_jsonb(v_approve),
                                   'cancel', to_jsonb(v_cancel), 'release', to_jsonb(v_release)));
END $$;

-- ------------------------------------------------------------------ writes
CREATE FUNCTION admin.recovery_open(p_session bytea, p_kind text, p_subject uuid, p_journal bigint, p_reason_code text, p_evidence text, p_summary text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'recovery.request');
  v_handle text := admin.handle_of(v_me);
  v_id bigint;
BEGIN
  PERFORM admin.require_step_up(p_session);
  PERFORM admin.check_text(p_summary, 10, 1000);
  BEGIN
    PERFORM admin.bind_officer(v_handle);
    IF p_kind = 'reversal' THEN
      IF p_evidence IS NULL OR p_evidence !~ '^[0-9a-f]{64}$' THEN PERFORM recovery.fail('23514', 'the SHA-256 of the evidence (64 hex digits) is required'); END IF;
      v_id := recovery.open_reversal(p_journal, p_reason_code, p_summary, decode(p_evidence, 'hex'), v_handle);
    ELSE
      v_id := recovery.open_case(p_kind, p_subject, p_summary, v_handle);
    END IF;
    PERFORM admin.unbind_officer(v_handle);
  EXCEPTION WHEN SQLSTATE '23514' OR SQLSTATE '23505' OR SQLSTATE '42501' OR SQLSTATE '22023' OR SQLSTATE 'P0002' OR SQLSTATE '23503' THEN
    RETURN admin.refuse(v_me, 'recovery', 'new', coalesce(p_kind, '?'), SQLERRM);
  END;
  PERFORM admin.audit_append(v_me::text, 'recovery.requested', jsonb_build_object('kind', p_kind, 'ref', v_id, 'action', 'open'));
  RETURN jsonb_build_object('ok', true, 'id', v_id, 'status', 'opened');
END $$;

CREATE FUNCTION admin.recovery_add_document(p_session bytea, p_case bigint, p_type text, p_reference text, p_issuer text, p_sha256 text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'recovery.request');
  v_handle text := admin.handle_of(v_me);
  v_id bigint;
BEGIN
  BEGIN
    IF p_sha256 IS NULL OR p_sha256 !~ '^[0-9a-f]{64}$' THEN PERFORM recovery.fail('23514', 'the document''s SHA-256 (64 hex digits) is required'); END IF;
    PERFORM admin.bind_officer(v_handle);
    v_id := recovery.add_document(p_case, p_type, p_reference, p_issuer, decode(p_sha256, 'hex'), v_handle);
    PERFORM admin.unbind_officer(v_handle);
  EXCEPTION WHEN SQLSTATE '23514' OR SQLSTATE '23505' OR SQLSTATE '42501' OR SQLSTATE '22023' OR SQLSTATE 'P0002' OR SQLSTATE '23503' THEN
    RETURN admin.refuse(v_me, 'recovery', coalesce(p_case::text, '?'), 'document', SQLERRM);
  END;
  PERFORM admin.audit_append(v_me::text, 'recovery.requested', jsonb_build_object('kind', 'document', 'ref', p_case, 'action', 'add'));
  RETURN jsonb_build_object('ok', true, 'id', v_id, 'status', 'opened');
END $$;

CREATE FUNCTION admin.recovery_add_heir(p_session bytea, p_case bigint, p_subject uuid, p_num integer, p_den integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'recovery.request');
  v_handle text := admin.handle_of(v_me);
  v_id bigint;
BEGIN
  BEGIN
    PERFORM admin.bind_officer(v_handle);
    v_id := recovery.add_heir(p_case, p_subject, p_num, p_den, v_handle);
    PERFORM admin.unbind_officer(v_handle);
  EXCEPTION WHEN SQLSTATE '23514' OR SQLSTATE '23505' OR SQLSTATE '42501' OR SQLSTATE '22023' OR SQLSTATE 'P0002' OR SQLSTATE '23503' THEN
    RETURN admin.refuse(v_me, 'recovery', coalesce(p_case::text, '?'), 'heir', SQLERRM);
  END;
  PERFORM admin.audit_append(v_me::text, 'recovery.requested', jsonb_build_object('kind', 'heir', 'ref', p_case, 'action', 'add'));
  RETURN jsonb_build_object('ok', true, 'id', v_id, 'status', 'opened');
END $$;

CREATE FUNCTION admin.recovery_set_wallet(p_session bytea, p_case bigint, p_wallet text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'recovery.request');
  v_handle text := admin.handle_of(v_me);
BEGIN
  PERFORM admin.require_step_up(p_session);
  BEGIN
    PERFORM admin.bind_officer(v_handle);
    PERFORM recovery.set_new_wallet(p_case, p_wallet, v_handle);
    PERFORM admin.unbind_officer(v_handle);
  EXCEPTION WHEN SQLSTATE '23514' OR SQLSTATE '23505' OR SQLSTATE '42501' OR SQLSTATE '22023' OR SQLSTATE 'P0002' THEN
    RETURN admin.refuse(v_me, 'recovery', coalesce(p_case::text, '?'), 'wallet', SQLERRM);
  END;
  PERFORM admin.audit_append(v_me::text, 'recovery.requested', jsonb_build_object('kind', 'wallet', 'ref', p_case, 'action', 'set'));
  RETURN jsonb_build_object('ok', true, 'id', p_case, 'status', 'opened');
END $$;

/** approve | reject (capacity), cancel, release: step-up, digest, officer binding; refusals audited. */
CREATE FUNCTION admin.recovery_act(p_session bytea, p_case bigint, p_action text, p_capacity text, p_reason text, p_digest bytea)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'recovery.decide');
  v_handle text := admin.handle_of(v_me);
  v_status text;
BEGIN
  PERFORM admin.require_step_up(p_session);
  PERFORM admin.check_text(p_reason, 10, 500);
  IF NOT EXISTS (SELECT 1 FROM recovery.cases WHERE id = p_case) THEN
    RETURN admin.refuse(v_me, 'recovery', coalesce(p_case::text, '?'), coalesce(p_action, '?'), 'unknown case');
  END IF;
  BEGIN
    PERFORM admin.bind_officer(v_handle);
    IF p_action IN ('approve', 'reject') THEN
      v_status := recovery.decide(p_case, v_handle, p_capacity, p_action, p_reason, p_digest);
    ELSIF p_action = 'cancel' THEN
      v_status := recovery.cancel(p_case, v_handle, p_reason, p_digest);
    ELSIF p_action = 'release' THEN
      v_status := recovery.release(p_case, v_handle, p_reason, p_digest);
    ELSE
      PERFORM recovery.fail('22023', 'action must be approve, reject, cancel or release');
    END IF;
    PERFORM admin.unbind_officer(v_handle);
  EXCEPTION WHEN SQLSTATE '23514' OR SQLSTATE '23505' OR SQLSTATE '42501' OR SQLSTATE '22023' OR SQLSTATE 'P0002' THEN
    RETURN admin.refuse(v_me, 'recovery', p_case::text, coalesce(p_action, '?'), SQLERRM);
  END;
  PERFORM admin.audit_append(v_me::text, 'recovery.decided', jsonb_build_object('kind', 'recovery', 'ref', p_case, 'action', p_action,
    'capacity', p_capacity, 'result', v_status, 'digest', encode(p_digest, 'hex')));
  RETURN jsonb_build_object('ok', true, 'status', v_status);
END $$;

/** "Refresh from chain": runs the tick (idempotent, deterministic from the read model and the outbox). */
CREATE FUNCTION admin.recovery_sync(p_session bytea) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'recovery.request');
  v_n integer;
BEGIN
  v_n := recovery.tick('portal:' || left(admin.handle_of(v_me), 90));
  PERFORM admin.audit_append(v_me::text, 'recovery.synced', jsonb_build_object('changes', v_n));
  RETURN jsonb_build_object('ok', true, 'status', format('%s change(s)', v_n), 'id', v_n);
END $$;

-- The recovery audit chain in the audit viewer (compliance officers and auditors).
CREATE OR REPLACE FUNCTION admin.audit_rows(p_session bytea, p_source text, p_from timestamptz, p_to timestamptz, p_actor text, p_action text,
                                            p_before bigint, p_limit integer)
RETURNS TABLE (id bigint, at timestamptz, actor text, action text, ref text, detail jsonb, prev_hash text, hash text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
#variable_conflict use_column
DECLARE
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 50000);
BEGIN
  IF p_source = 'admin' THEN
    PERFORM admin.require(p_session, 'audit.read.admin');
    RETURN QUERY SELECT a.id, a.at, a.actor, a.action, NULL::text, a.detail, encode(a.prev_hash, 'hex'), encode(a.hash, 'hex')
      FROM admin.audit a
      WHERE (p_from IS NULL OR a.at >= p_from) AND (p_to IS NULL OR a.at < p_to)
        AND (p_actor IS NULL OR strpos(a.actor, p_actor) > 0) AND (p_action IS NULL OR starts_with(a.action, p_action))
        AND (p_before IS NULL OR a.id < p_before)
      ORDER BY a.id DESC LIMIT v_limit;
  ELSIF p_source = 'signer' THEN
    PERFORM admin.require(p_session, 'audit.read.ops');
    RETURN QUERY SELECT a.id, a.at, a.actor, a.action, a.request_id::text, a.detail, encode(a.prev_hash, 'hex'), encode(a.hash, 'hex')
      FROM signer.audit a
      WHERE (p_from IS NULL OR a.at >= p_from) AND (p_to IS NULL OR a.at < p_to)
        AND (p_actor IS NULL OR strpos(a.actor, p_actor) > 0) AND (p_action IS NULL OR starts_with(a.action, p_action))
        AND (p_before IS NULL OR a.id < p_before)
      ORDER BY a.id DESC LIMIT v_limit;
  ELSIF p_source = 'recon' THEN
    PERFORM admin.require(p_session, 'audit.read.ops');
    RETURN QUERY SELECT a.id, a.at, a.actor, a.action, NULL::text, a.detail, encode(a.prev_hash, 'hex'), encode(a.hash, 'hex')
      FROM recon.audit a
      WHERE (p_from IS NULL OR a.at >= p_from) AND (p_to IS NULL OR a.at < p_to)
        AND (p_actor IS NULL OR strpos(a.actor, p_actor) > 0) AND (p_action IS NULL OR starts_with(a.action, p_action))
        AND (p_before IS NULL OR a.id < p_before)
      ORDER BY a.id DESC LIMIT v_limit;
  ELSIF p_source = 'ledger' THEN
    PERFORM admin.require(p_session, 'audit.read.ops');
    RETURN QUERY SELECT j.id, j.created_at, j.created_by, j.kind, j.external_ref,
        jsonb_build_object('idempotencyKey', j.idempotency_key, 'memo', j.memo), encode(j.prev_hash, 'hex'), encode(j.hash, 'hex')
      FROM ledger.journal j
      WHERE (p_from IS NULL OR j.created_at >= p_from) AND (p_to IS NULL OR j.created_at < p_to)
        AND (p_actor IS NULL OR strpos(j.created_by, p_actor) > 0) AND (p_action IS NULL OR starts_with(j.kind, p_action))
        AND (p_before IS NULL OR j.id < p_before)
      ORDER BY j.id DESC LIMIT v_limit;
  ELSIF p_source = 'compliance' THEN
    PERFORM admin.require(p_session, 'compliance.read');
    RETURN QUERY SELECT a.id, a.at, a.actor, a.action, coalesce(a.detail->>'case', a.detail->>'request', a.detail->>'rescreen'), a.detail,
        encode(a.prev_hash, 'hex'), encode(a.hash, 'hex')
      FROM compliance.audit a
      WHERE (p_from IS NULL OR a.at >= p_from) AND (p_to IS NULL OR a.at < p_to)
        AND (p_actor IS NULL OR strpos(a.actor, p_actor) > 0) AND (p_action IS NULL OR starts_with(a.action, p_action))
        AND (p_before IS NULL OR a.id < p_before)
      ORDER BY a.id DESC LIMIT v_limit;
  ELSIF p_source = 'recovery' THEN
    PERFORM admin.require(p_session, 'recovery.read');
    RETURN QUERY SELECT a.id, a.at, a.actor, a.action, a.detail->>'case', a.detail, encode(a.prev_hash, 'hex'), encode(a.hash, 'hex')
      FROM recovery.audit a
      WHERE (p_from IS NULL OR a.at >= p_from) AND (p_to IS NULL OR a.at < p_to)
        AND (p_actor IS NULL OR strpos(a.actor, p_actor) > 0) AND (p_action IS NULL OR starts_with(a.action, p_action))
        AND (p_before IS NULL OR a.id < p_before)
      ORDER BY a.id DESC LIMIT v_limit;
  ELSE
    RAISE EXCEPTION 'unknown audit source' USING ERRCODE = 'check_violation';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION admin.verify_chains(p_session bytea, p_source text)
RETURNS TABLE (source text, entries bigint, problems bigint, first_problem text, verified_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
#variable_conflict use_column
DECLARE
  v_ops boolean;
  v_admin boolean;
  v_comp boolean;
  v_rec boolean;
BEGIN
  PERFORM admin.require(p_session, NULL);
  v_ops := admin.has_permission(p_session, 'audit.read.ops');
  v_admin := admin.has_permission(p_session, 'audit.read.admin');
  v_comp := admin.has_permission(p_session, 'compliance.read');
  v_rec := admin.has_permission(p_session, 'recovery.read');
  IF v_ops AND coalesce(p_source, 'signer') = 'signer' THEN
    RETURN QUERY SELECT 'signer'::text, (SELECT count(*) FROM signer.audit), count(*), min(v.problem), clock_timestamp() FROM signer.verify_audit() v;
  END IF;
  IF v_ops AND coalesce(p_source, 'recon') = 'recon' THEN
    RETURN QUERY SELECT 'recon'::text, (SELECT count(*) FROM recon.audit), count(*), min(v.problem), clock_timestamp() FROM recon.verify_audit() v;
  END IF;
  IF v_ops AND coalesce(p_source, 'ledger') = 'ledger' THEN
    RETURN QUERY SELECT 'ledger'::text, (SELECT count(*) FROM ledger.journal), count(*), min(v.problem), clock_timestamp() FROM ledger.verify_chain() v;
  END IF;
  IF v_admin AND coalesce(p_source, 'admin') = 'admin' THEN
    RETURN QUERY SELECT 'admin'::text, (SELECT count(*) FROM admin.audit), count(*), min(v.problem), clock_timestamp() FROM admin.verify_audit() v;
  END IF;
  IF v_comp AND coalesce(p_source, 'compliance') = 'compliance' THEN
    RETURN QUERY SELECT 'compliance'::text, (SELECT count(*) FROM compliance.audit), count(*), min(v.problem), clock_timestamp()
      FROM compliance.verify_audit() v;
  END IF;
  IF v_rec AND coalesce(p_source, 'recovery') = 'recovery' THEN
    RETURN QUERY SELECT 'recovery'::text, (SELECT count(*) FROM recovery.audit), count(*), min(v.problem), clock_timestamp()
      FROM recovery.verify_audit() v;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION admin.record_export(p_session bytea, p_source text, p_filters jsonb, p_rows integer, p_format text, p_sha256 text)
RETURNS TABLE (audit_id bigint, audit_hash text, at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
#variable_conflict use_column
DECLARE
  v_me uuid := admin.require(p_session, 'audit.export');
  v_id bigint;
BEGIN
  IF p_source NOT IN ('admin', 'signer', 'recon', 'ledger', 'compliance', 'recovery') OR p_format NOT IN ('csv', 'json') OR p_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid export description' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM admin.require(p_session, CASE p_source WHEN 'admin' THEN 'audit.read.admin' WHEN 'compliance' THEN 'compliance.read'
                                                 WHEN 'recovery' THEN 'recovery.read' ELSE 'audit.read.ops' END);
  v_id := admin.audit_append(v_me::text, 'audit.exported', jsonb_build_object('source', p_source, 'format', p_format, 'rows', p_rows,
                                                                             'filters', coalesce(p_filters, '{}'::jsonb), 'sha256', p_sha256));
  RETURN QUERY SELECT a.id, encode(a.hash, 'hex'), a.at FROM admin.audit a WHERE a.id = v_id;
END $$;

-- ================================================================== privileges
REVOKE ALL ON ALL TABLES IN SCHEMA recovery FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA recovery FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA admin FROM PUBLIC;
REVOKE ALL ON FUNCTION kyc.guard_wallet() FROM PUBLIC;
-- CREATE OR REPLACE keeps the grants of admin.audit_rows, admin.verify_chains and admin.record_export.

GRANT EXECUTE ON FUNCTION
  admin.recovery_cases(bytea, text, text),
  admin.recovery_case(bytea, bigint),
  admin.recovery_open(bytea, text, uuid, bigint, text, text, text),
  admin.recovery_add_document(bytea, bigint, text, text, text, text),
  admin.recovery_add_heir(bytea, bigint, uuid, integer, integer),
  admin.recovery_set_wallet(bytea, bigint, text),
  admin.recovery_act(bytea, bigint, text, text, text, bytea),
  admin.recovery_sync(bytea)
TO pt_admin_portal;

-- The signing service checks every recovery command against the case (RV-6).
GRANT USAGE ON SCHEMA recovery TO pt_signer, pt_recovery_worker, pt_recon_writer, pt_recon_reader, pt_admin_auditor;
GRANT EXECUTE ON FUNCTION recovery.command_allowed(text, jsonb), recovery.pending_from(text, text) TO pt_signer;
-- The tick runs as its own worker role (npm run recovery:tick).
GRANT EXECUTE ON FUNCTION recovery.tick(text) TO pt_recovery_worker;
GRANT SELECT ON recovery.recon_requests, recovery.recon_reversals TO pt_recon_writer, pt_recon_reader;
GRANT EXECUTE ON FUNCTION recovery.verify_audit() TO pt_admin_auditor, pt_recon_writer, pt_recon_reader;

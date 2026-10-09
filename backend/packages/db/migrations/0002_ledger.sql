-- Ledger (Step 5b): double-entry, append-only, hash-chained.
--
-- Safety properties enforced by the database itself, not by application code:
--   L-1  Every journal balances to zero per asset (PKR in paisa, token units).
--   L-2  Rows are never updated, deleted or truncated (triggers + no privileges).
--   L-3  Writes happen only through ledger.post_journal / ledger.open_account (validated,
--        SECURITY DEFINER); service roles have no INSERT privilege on the tables.
--   L-4  Each journal stores sha256(prev_hash, own content, postings): ledger.verify_chain()
--        detects any later change, insertion or reordering.
--   L-5  An idempotency key returns the original journal for an identical request and is
--        rejected for a different one.
--   L-6  Accounts without allow_overdraft can never leave their normal side
--        (an investor payable cannot be overpaid).
-- Amounts: bigint, positive = debit, negative = credit. Never floating point.

-- ------------------------------------------------------------------ roles (cluster-wide)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pt_ledger_writer') THEN
    CREATE ROLE pt_ledger_writer NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pt_ledger_reader') THEN
    CREATE ROLE pt_ledger_reader NOLOGIN;
  END IF;
END $$;

-- ------------------------------------------------------------------ tables
CREATE TABLE ledger.accounts (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code            text NOT NULL UNIQUE
                  CHECK (length(code) <= 128 AND code ~ '^[a-z][a-z0-9_]*(:[a-z0-9_-]+)*$'),
  kind            text NOT NULL CHECK (kind IN ('asset', 'liability', 'equity', 'income', 'expense')),
  asset           text NOT NULL CHECK (asset ~ '^[A-Z][A-Z0-9]{2,11}$'),
  normal_side     text NOT NULL GENERATED ALWAYS AS
                  (CASE WHEN kind IN ('asset', 'expense') THEN 'debit' ELSE 'credit' END) STORED,
  allow_overdraft boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ledger.journal (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  kind            text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_]{2,63}$'),
  memo            text CHECK (length(memo) <= 500),
  external_ref    text CHECK (length(external_ref) <= 200),
  created_by      text NOT NULL CHECK (length(created_by) BETWEEN 1 AND 100),
  created_at      timestamptz NOT NULL,
  payload_hash    bytea NOT NULL CHECK (length(payload_hash) = 32),
  prev_hash       bytea NOT NULL CHECK (length(prev_hash) = 32),
  hash            bytea NOT NULL UNIQUE CHECK (length(hash) = 32)
);

CREATE TABLE ledger.postings (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  journal_id bigint NOT NULL REFERENCES ledger.journal (id),
  account_id bigint NOT NULL REFERENCES ledger.accounts (id),
  asset      text NOT NULL,
  amount     bigint NOT NULL CHECK (amount <> 0)
);
CREATE INDEX postings_account_idx ON ledger.postings (account_id);
CREATE INDEX postings_journal_idx ON ledger.postings (journal_id);

-- ------------------------------------------------------------------ L-2 append-only
CREATE FUNCTION ledger.forbid_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ledger is append-only: % on %.% is not allowed', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE TRIGGER accounts_append_only BEFORE UPDATE OR DELETE ON ledger.accounts
  FOR EACH ROW EXECUTE FUNCTION ledger.forbid_change();
CREATE TRIGGER accounts_no_truncate BEFORE TRUNCATE ON ledger.accounts
  FOR EACH STATEMENT EXECUTE FUNCTION ledger.forbid_change();
CREATE TRIGGER journal_append_only BEFORE UPDATE OR DELETE ON ledger.journal
  FOR EACH ROW EXECUTE FUNCTION ledger.forbid_change();
CREATE TRIGGER journal_no_truncate BEFORE TRUNCATE ON ledger.journal
  FOR EACH STATEMENT EXECUTE FUNCTION ledger.forbid_change();
CREATE TRIGGER postings_append_only BEFORE UPDATE OR DELETE ON ledger.postings
  FOR EACH ROW EXECUTE FUNCTION ledger.forbid_change();
CREATE TRIGGER postings_no_truncate BEFORE TRUNCATE ON ledger.postings
  FOR EACH STATEMENT EXECUTE FUNCTION ledger.forbid_change();

-- ------------------------------------------------------------------ L-4 digest
-- Canonical form: a JSON array (unambiguous, no delimiter tricks). `postings` is an array of
-- [account_id, asset, amount_as_text] in posting order.
CREATE FUNCTION ledger.digest(
  p_prev_hash bytea, p_id bigint, p_key text, p_kind text, p_memo text, p_ref text,
  p_created_by text, p_created_at timestamptz, p_postings jsonb
) RETURNS bytea
LANGUAGE sql IMMUTABLE AS $$
  SELECT sha256(convert_to(jsonb_build_array(
    encode(p_prev_hash, 'hex'), p_id, p_key, p_kind, coalesce(p_memo, ''), coalesce(p_ref, ''),
    p_created_by, to_char(p_created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), p_postings
  )::text, 'UTF8'))
$$;

-- ------------------------------------------------------------------ L-3 write path
CREATE FUNCTION ledger.open_account(p_code text, p_kind text, p_asset text, p_allow_overdraft boolean DEFAULT false)
RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, ledger AS $$
DECLARE
  v ledger.accounts;
BEGIN
  SELECT * INTO v FROM ledger.accounts WHERE code = p_code;
  IF FOUND THEN
    IF v.kind = p_kind AND v.asset = p_asset AND v.allow_overdraft = p_allow_overdraft THEN
      RETURN v.id;
    END IF;
    RAISE EXCEPTION 'account % already exists with different attributes', p_code USING ERRCODE = 'unique_violation';
  END IF;
  INSERT INTO ledger.accounts (code, kind, asset, allow_overdraft)
  VALUES (p_code, p_kind, p_asset, p_allow_overdraft)
  RETURNING id INTO v.id;
  RETURN v.id;
END $$;

CREATE FUNCTION ledger.post_journal(
  p_key text, p_kind text, p_memo text, p_ref text, p_created_by text, p_postings jsonb
) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, ledger AS $$
DECLARE
  v_payload  bytea := sha256(convert_to(jsonb_build_array(p_kind, p_memo, p_ref, p_created_by, p_postings)::text, 'UTF8'));
  v_existing ledger.journal;
  v_rows     jsonb;
  v_count    int;
  v_prev     bytea;
  v_id       bigint;
  v_now      timestamptz := date_trunc('microseconds', clock_timestamp());
  v_bad      text;
  r          record;
BEGIN
  -- One writer at a time keeps the hash chain strictly linear.
  PERFORM pg_advisory_xact_lock(586586002);

  -- L-5 idempotency
  SELECT * INTO v_existing FROM ledger.journal WHERE idempotency_key = p_key;
  IF FOUND THEN
    IF v_existing.payload_hash = v_payload THEN
      RETURN v_existing.id;
    END IF;
    RAISE EXCEPTION 'idempotency key % was already used for a different journal', p_key USING ERRCODE = 'unique_violation';
  END IF;

  -- Shape: an array of at least two {"account": code, "amount": "<non-zero integer as string>"}.
  IF p_postings IS NULL OR jsonb_typeof(p_postings) <> 'array' OR jsonb_array_length(p_postings) < 2 THEN
    RAISE EXCEPTION 'a journal needs at least two postings' USING ERRCODE = 'check_violation';
  END IF;
  SELECT string_agg(ord::text, ',') INTO v_bad
  FROM jsonb_array_elements(p_postings) WITH ORDINALITY AS t(e, ord)
  WHERE jsonb_typeof(e) <> 'object'
     OR jsonb_typeof(e -> 'account') <> 'string'
     OR jsonb_typeof(e -> 'amount') <> 'string'
     OR (e ->> 'amount') !~ '^-?[1-9][0-9]{0,17}$';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'malformed posting(s) at position %: amount must be a non-zero integer string', v_bad
      USING ERRCODE = 'check_violation';
  END IF;

  -- Resolve accounts; reject unknown or repeated accounts.
  SELECT jsonb_agg(jsonb_build_array(a.id, a.asset, (t.e ->> 'amount')) ORDER BY t.ord),
         count(*) FILTER (WHERE a.id IS NULL)
    INTO v_rows, v_count
  FROM jsonb_array_elements(p_postings) WITH ORDINALITY AS t(e, ord)
  LEFT JOIN ledger.accounts a ON a.code = t.e ->> 'account';
  IF v_count > 0 THEN
    RAISE EXCEPTION 'unknown account in postings' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF (SELECT count(DISTINCT e ->> 'account') FROM jsonb_array_elements(p_postings) e) <> jsonb_array_length(p_postings) THEN
    RAISE EXCEPTION 'an account may appear only once per journal' USING ERRCODE = 'check_violation';
  END IF;

  -- L-1 balance per asset
  SELECT string_agg(asset || '=' || total::text, ', ') INTO v_bad
  FROM (
    SELECT p ->> 1 AS asset, sum((p ->> 2)::bigint) AS total
    FROM jsonb_array_elements(v_rows) p
    GROUP BY p ->> 1
  ) s
  WHERE total <> 0;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'journal does not balance: %', v_bad USING ERRCODE = 'check_violation';
  END IF;

  -- L-4 chain
  SELECT hash INTO v_prev FROM ledger.journal ORDER BY id DESC LIMIT 1;
  v_prev := coalesce(v_prev, decode(repeat('00', 32), 'hex'));
  v_id := nextval(pg_get_serial_sequence('ledger.journal', 'id'));

  INSERT INTO ledger.journal (id, idempotency_key, kind, memo, external_ref, created_by, created_at, payload_hash, prev_hash, hash)
  OVERRIDING SYSTEM VALUE
  VALUES (v_id, p_key, p_kind, p_memo, p_ref, p_created_by, v_now, v_payload, v_prev,
          ledger.digest(v_prev, v_id, p_key, p_kind, p_memo, p_ref, p_created_by, v_now, v_rows));

  -- Insert postings one by one so their ids follow the hashed order exactly.
  FOR r IN SELECT p, ord FROM jsonb_array_elements(v_rows) WITH ORDINALITY AS t(p, ord) ORDER BY ord LOOP
    INSERT INTO ledger.postings (journal_id, account_id, asset, amount)
    VALUES (v_id, (r.p ->> 0)::bigint, r.p ->> 1, (r.p ->> 2)::bigint);
  END LOOP;

  -- L-6 no overdraft on protected accounts touched by this journal
  SELECT string_agg(a.code, ', ') INTO v_bad
  FROM ledger.accounts a
  JOIN (SELECT account_id, sum(amount) AS bal FROM ledger.postings
        WHERE account_id IN (SELECT (p ->> 0)::bigint FROM jsonb_array_elements(v_rows) p)
        GROUP BY account_id) b ON b.account_id = a.id
  WHERE NOT a.allow_overdraft
    AND ((a.normal_side = 'debit' AND b.bal < 0) OR (a.normal_side = 'credit' AND b.bal > 0));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'insufficient balance on: %', v_bad USING ERRCODE = 'check_violation';
  END IF;

  RETURN v_id;
END $$;

-- ------------------------------------------------------------------ L-4 verification
CREATE FUNCTION ledger.verify_chain()
RETURNS TABLE (journal_id bigint, problem text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, ledger AS $$
DECLARE
  j        ledger.journal;
  v_prev   bytea := decode(repeat('00', 32), 'hex');
  v_rows   jsonb;
BEGIN
  FOR j IN SELECT * FROM ledger.journal ORDER BY id LOOP
    SELECT jsonb_agg(jsonb_build_array(p.account_id, p.asset, p.amount::text) ORDER BY p.id) INTO v_rows
    FROM ledger.postings p WHERE p.journal_id = j.id;
    IF j.prev_hash <> v_prev THEN
      journal_id := j.id; problem := 'prev_hash does not match the previous journal'; RETURN NEXT;
    END IF;
    IF v_rows IS NULL OR j.hash <> ledger.digest(j.prev_hash, j.id, j.idempotency_key, j.kind, j.memo,
                                                 j.external_ref, j.created_by, j.created_at, v_rows) THEN
      journal_id := j.id; problem := 'content does not match its hash'; RETURN NEXT;
    END IF;
    IF EXISTS (SELECT 1 FROM ledger.postings p WHERE p.journal_id = j.id GROUP BY p.asset HAVING sum(p.amount) <> 0) THEN
      journal_id := j.id; problem := 'postings do not balance'; RETURN NEXT;
    END IF;
    v_prev := j.hash;
  END LOOP;
END $$;

-- ------------------------------------------------------------------ read model
CREATE VIEW ledger.balances AS
SELECT a.id AS account_id, a.code, a.kind, a.asset, a.normal_side,
       coalesce(sum(p.amount), 0)::bigint AS balance
FROM ledger.accounts a
LEFT JOIN ledger.postings p ON p.account_id = a.id
GROUP BY a.id;

CREATE FUNCTION ledger.chain_head() RETURNS TABLE (journal_id bigint, hash text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, ledger AS $$
  SELECT id, encode(hash, 'hex') FROM ledger.journal ORDER BY id DESC LIMIT 1
$$;

-- ------------------------------------------------------------------ privileges
-- Functions are executable by PUBLIC by default in PostgreSQL; revoke that first.
REVOKE ALL ON ALL TABLES IN SCHEMA ledger FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ledger FROM PUBLIC;

GRANT USAGE ON SCHEMA ledger TO pt_ledger_writer, pt_ledger_reader;
GRANT EXECUTE ON FUNCTION ledger.post_journal(text, text, text, text, text, jsonb) TO pt_ledger_writer;
GRANT EXECUTE ON FUNCTION ledger.open_account(text, text, text, boolean) TO pt_ledger_writer;
GRANT SELECT ON ledger.accounts, ledger.journal, ledger.postings, ledger.balances TO pt_ledger_reader;
GRANT EXECUTE ON FUNCTION ledger.verify_chain(), ledger.chain_head() TO pt_ledger_reader;

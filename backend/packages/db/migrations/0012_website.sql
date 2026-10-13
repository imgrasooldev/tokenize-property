-- Website on the outbox, the signing service and the read model (Step 5h, ADR 0010).
--
--   W-1  Custodial wallets: a key the signing service generated (or, on the local dev chain only,
--        imported) is recorded in signer.custodial_wallets together with its signer.keys row, in one
--        call (signer.register_custodial_wallet) that also writes the audit log. The table is
--        append-only: a wallet never changes owner key and is never removed.
--   W-2  token.transfer (DvP delivery) may move tokens only FROM a custodial wallet. The signer reads
--        that fact from signer.custodial_wallets, never from the caller.
--   W-3  Delivery versus payment: the signer may deliver tokens for a trade only while the trade's
--        escrow account in the ledger holds at least the trade's cost. It reads that amount through
--        ledger.escrow_held (only escrow accounts of the market, `web:order:<uuid>:escrow`), never the
--        ledger tables.
--   W-4  The website's own demo records (schema webdemo) are created here, not by the website at run
--        time (audit item A2): the website runs no DDL.
--   W-5  The website connects as its own least-privilege role (pt_web), never as the admin.

-- ------------------------------------------------------------------ W-1 custodial wallets
CREATE TABLE signer.custodial_wallets (
  address    text PRIMARY KEY CHECK (length(address) = 42 AND address ~ '^0x[0-9a-f]+$'),
  key_ref    text NOT NULL UNIQUE REFERENCES signer.keys (key_ref),
  created_by text NOT NULL CHECK (length(created_by) BETWEEN 1 AND 100),
  origin     text NOT NULL CHECK (origin IN ('generated', 'imported_dev')),
  created_at timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  CHECK (key_ref = 'w' || substr(address, 3))
);
CREATE TRIGGER custodial_wallets_append_only BEFORE UPDATE OR DELETE ON signer.custodial_wallets
  FOR EACH ROW EXECUTE FUNCTION signer.forbid_change();
CREATE TRIGGER custodial_wallets_no_truncate BEFORE TRUNCATE ON signer.custodial_wallets
  FOR EACH STATEMENT EXECUTE FUNCTION signer.forbid_change();

/** W-1: records a custodial wallet the service holds the key for. Idempotent for the same wallet. */
CREATE FUNCTION signer.register_custodial_wallet(p_address text, p_origin text, p_actor text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, signer AS $$
DECLARE
  v_address text := lower(p_address);
  v_ref text;
BEGIN
  IF p_address IS NULL OR v_address !~ '^0x[0-9a-f]{40}$' OR p_origin IS NULL OR p_actor IS NULL THEN
    RAISE EXCEPTION 'address, origin and actor are required' USING ERRCODE = 'check_violation';
  END IF;
  v_ref := 'w' || substr(v_address, 3);
  IF EXISTS (SELECT 1 FROM signer.custodial_wallets WHERE address = v_address) THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM signer.keys WHERE address = v_address) THEN
    -- A platform key can never become an investor's wallet.
    RAISE EXCEPTION 'address % already belongs to a signing key', v_address USING ERRCODE = 'unique_violation';
  END IF;
  INSERT INTO signer.keys (key_ref, address, purpose) VALUES (v_ref, v_address, 'custodial investor wallet');
  INSERT INTO signer.custodial_wallets (address, key_ref, created_by, origin) VALUES (v_address, v_ref, p_actor, p_origin);
  PERFORM signer.audit_append(p_actor, 'custody.created', NULL, jsonb_build_object('address', v_address, 'origin', p_origin));
  RETURN true;
END $$;

-- ------------------------------------------------------------------ W-3 escrow fact for DvP
/** PKR (paisa) a market order's escrow account holds; 0 if it does not exist. Only market escrows. */
CREATE FUNCTION ledger.escrow_held(p_account text) RETURNS bigint
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, ledger AS $$
DECLARE
  v bigint;
BEGIN
  IF p_account IS NULL OR p_account !~ '^web:order:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:escrow$' THEN
    RAISE EXCEPTION 'not a market escrow account' USING ERRCODE = 'check_violation';
  END IF;
  -- Escrows are liability accounts: a credit balance (negative) is money held.
  SELECT -b.balance INTO v FROM ledger.accounts a JOIN ledger.account_balances b ON b.account_id = a.id
  WHERE a.code = p_account AND a.kind = 'liability';
  RETURN coalesce(v, 0);
END $$;

-- ------------------------------------------------------------------ privileges
REVOKE ALL ON signer.custodial_wallets FROM PUBLIC;
REVOKE ALL ON FUNCTION signer.register_custodial_wallet(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION ledger.escrow_held(text) FROM PUBLIC;
GRANT SELECT ON signer.custodial_wallets TO pt_signer, pt_signer_operator, pt_signer_auditor;
GRANT EXECUTE ON FUNCTION signer.register_custodial_wallet(text, text, text) TO pt_signer;
GRANT USAGE ON SCHEMA ledger TO pt_signer;
GRANT EXECUTE ON FUNCTION ledger.escrow_held(text) TO pt_signer, pt_ledger_reader;

-- ------------------------------------------------------------------ W-4 the website's own records (webdemo)
-- Until Step 5h the website created schema webdemo at run time as the database admin (audit item
-- A2). The DDL lives here now, so the website never runs DDL. IF NOT EXISTS: a database where the
-- website already created these tables keeps its rows, and missing columns are added.
CREATE SCHEMA IF NOT EXISTS webdemo;
CREATE TABLE IF NOT EXISTS webdemo.investors (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  persona          text UNIQUE CHECK (persona IN ('ALICE', 'BOB')),
  display_name     text NOT NULL CHECK (length(display_name) BETWEEN 2 AND 80),
  cnic_last4       text CHECK (cnic_last4 ~ '^[0-9]{4}$'),
  cnic_hmac        text UNIQUE,
  phone_last3      text CHECK (phone_last3 ~ '^[0-9]{3}$'),
  wallet_address   text NOT NULL UNIQUE CHECK (wallet_address ~ '^0x[0-9a-fA-F]{40}$'),
  wallet_key_enc   bytea,
  identity_address text CHECK (identity_address ~ '^0x[0-9a-fA-F]{40}$'),
  kyc_status       text NOT NULL CHECK (kyc_status IN ('pending', 'verified', 'rejected')),
  kyc_note         text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS webdemo.subscriptions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id   uuid NOT NULL UNIQUE,
  investor_id  uuid NOT NULL REFERENCES webdemo.investors (id),
  symbol       text NOT NULL CHECK (symbol ~ '^[A-Z][A-Z0-9]{2,11}$'),
  tokens       bigint NOT NULL CHECK (tokens > 0),
  amount_paisa bigint NOT NULL CHECK (amount_paisa > 0),
  bank_ref     text NOT NULL CHECK (bank_ref ~ '^RAAST-DEMO-[0-9A-F]{12}$'),
  ref_id       text NOT NULL UNIQUE CHECK (ref_id ~ '^0x[0-9a-f]{64}$'),
  status       text NOT NULL CHECK (status IN ('paid', 'minting', 'done', 'refunded', 'review')),
  mint_tx      text CHECK (mint_tx ~ '^0x[0-9a-f]{64}$'),
  note         text CHECK (length(note) <= 300),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS subscriptions_investor ON webdemo.subscriptions (investor_id, created_at DESC);
CREATE TABLE IF NOT EXISTS webdemo.topups (
  id           uuid PRIMARY KEY,
  request_id   uuid NOT NULL UNIQUE,
  investor_id  uuid NOT NULL REFERENCES webdemo.investors (id),
  amount_paisa bigint NOT NULL CHECK (amount_paisa > 0),
  bank_ref     text NOT NULL CHECK (bank_ref ~ '^RAAST-DEMO-[0-9A-F]{12}$'),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS webdemo.orders (
  id          uuid PRIMARY KEY,
  request_id  uuid NOT NULL UNIQUE,
  investor_id uuid NOT NULL REFERENCES webdemo.investors (id),
  symbol      text NOT NULL CHECK (symbol ~ '^[A-Z][A-Z0-9]{2,11}$'),
  side        text NOT NULL CHECK (side IN ('buy', 'sell')),
  price_paisa bigint NOT NULL CHECK (price_paisa > 0),
  tokens      bigint NOT NULL CHECK (tokens > 0),
  filled      bigint NOT NULL DEFAULT 0 CHECK (filled >= 0 AND filled <= tokens),
  status      text NOT NULL CHECK (status IN ('open', 'filled', 'cancelled')),
  note        text CHECK (length(note) <= 300),
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at  timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS orders_book ON webdemo.orders (symbol, side, status, price_paisa, created_at);
CREATE INDEX IF NOT EXISTS orders_investor ON webdemo.orders (investor_id, created_at DESC);
CREATE TABLE IF NOT EXISTS webdemo.trades (
  id          uuid PRIMARY KEY,
  symbol      text NOT NULL,
  buy_order   uuid NOT NULL REFERENCES webdemo.orders (id),
  sell_order  uuid NOT NULL REFERENCES webdemo.orders (id),
  buyer_id    uuid NOT NULL REFERENCES webdemo.investors (id),
  seller_id   uuid NOT NULL REFERENCES webdemo.investors (id),
  price_paisa bigint NOT NULL CHECK (price_paisa > 0),
  tokens      bigint NOT NULL CHECK (tokens > 0),
  status      text NOT NULL CHECK (status IN ('settling', 'settled', 'failed', 'review')),
  transfer_tx text CHECK (transfer_tx ~ '^0x[0-9a-f]{64}$'),
  note        text CHECK (length(note) <= 300),
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (buyer_id <> seller_id)
);
CREATE INDEX IF NOT EXISTS trades_symbol ON webdemo.trades (symbol, status, created_at);
-- Recorded before broadcast, so an interrupted send can be resolved from the chain later.
ALTER TABLE webdemo.subscriptions ADD COLUMN IF NOT EXISTS mint_nonce integer CHECK (mint_nonce >= 0);
ALTER TABLE webdemo.subscriptions ADD COLUMN IF NOT EXISTS mint_from text CHECK (mint_from ~ '^0x[0-9a-fA-F]{40}$');
ALTER TABLE webdemo.trades ADD COLUMN IF NOT EXISTS transfer_nonce integer CHECK (transfer_nonce >= 0);
-- Step 5h (ADR 0010): chain work goes through the outbox; each row points at its command.
ALTER TABLE webdemo.subscriptions ADD COLUMN IF NOT EXISTS command_id bigint;
ALTER TABLE webdemo.trades ADD COLUMN IF NOT EXISTS command_id bigint;
ALTER TABLE webdemo.investors ADD COLUMN IF NOT EXISTS kyc_subject uuid;
ALTER TABLE webdemo.investors ADD COLUMN IF NOT EXISTS onboard_step text
  CHECK (onboard_step IN ('identity', 'claims', 'register', 'done', 'failed'));
ALTER TABLE webdemo.investors ADD COLUMN IF NOT EXISTS onboard_attempt integer NOT NULL DEFAULT 0 CHECK (onboard_attempt BETWEEN 0 AND 10);
CREATE INDEX IF NOT EXISTS subscriptions_open ON webdemo.subscriptions (status) WHERE status IN ('paid', 'minting', 'review');
CREATE INDEX IF NOT EXISTS trades_open ON webdemo.trades (status) WHERE status IN ('settling', 'review');

-- ------------------------------------------------------------------ W-5 the website's database role
-- The website no longer connects as the admin. pt_web (NOLOGIN) holds exactly what it needs; a
-- login role in it (pt_web_app, password generated by `npm run db:web-role`, kept in the
-- git-ignored backend/.env.local) is what the website uses. It can:
--   * read and write its own records (webdemo: SELECT, INSERT, UPDATE; never DELETE or TRUNCATE);
--   * post journals and open accounts only through the ledger's functions (pt_ledger_writer) and
--     read the ledger (pt_ledger_reader); ledger tables stay append-only and unwritable;
--   * enqueue outbox commands and read their state (pt_outbox_writer, pt_outbox_reader);
--   * read the chain read model (pt_chain_reader) and which wallets are custodial.
-- It cannot sign, decide approvals, change policies, resolve outbox reviews, unfreeze payouts, touch
-- KYC or bank data, or run DDL.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pt_web') THEN CREATE ROLE pt_web NOLOGIN; END IF;
END $$;

REVOKE ALL ON ALL TABLES IN SCHEMA webdemo FROM PUBLIC;
GRANT USAGE ON SCHEMA webdemo TO pt_web;
GRANT SELECT, INSERT, UPDATE ON webdemo.investors, webdemo.subscriptions, webdemo.topups, webdemo.orders, webdemo.trades TO pt_web;
GRANT pt_ledger_writer, pt_ledger_reader, pt_outbox_writer, pt_outbox_reader, pt_chain_reader TO pt_web;
GRANT USAGE ON SCHEMA signer TO pt_web;
GRANT SELECT ON signer.custodial_wallets TO pt_web;

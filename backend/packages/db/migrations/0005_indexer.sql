-- Indexer (Step 5e): the read model of the chain, built from contract events (ADR 0006).
--
-- Safety properties enforced by the database itself:
--   C-1  A batch (raw events, derived tables and the cursor) is applied by ONE call to
--        chain.apply_batch inside one transaction. The cursor moves by compare-and-set: a batch
--        that does not start exactly at cursor + 1 is refused, so a retried, duplicated or
--        concurrent batch can never be applied twice (exactly-once, crash-safe).
--   C-2  Blocks link up: the first block of every batch must name the cursor block as its parent,
--        every log must carry the hash of a recorded block, and a block number is never recorded
--        with two different hashes. The indexer additionally checks every header in between.
--        QBFT has immediate finality, so any mismatch means the node serves a different chain:
--        the deployment halts instead of guessing.
--   C-3  Raw events, blocks, transfers, issuances, freeze actions and the halt history are
--        append-only (no UPDATE, DELETE or TRUNCATE, even for the admin without disabling triggers).
--        Derived rows are never deleted.
--   C-4  Service roles have no direct table writes: pt_chain_writer only calls register_deployment,
--        apply_batch and halt; pt_chain_reader only reads.
--   C-5  Contract invariants are re-checked while deriving, so a gap or a duplicate in the event
--        stream cannot pass silently: balances, supply and frozen amounts never go negative, each
--        refId is used once (I-11), a distribution is published once and moves only
--        published -> rejected | finalized -> paid (I-14), a recovery request closes once (I-13), a
--        document is added once and superseded once (I-15). A violation aborts the batch and the
--        indexer halts.
--   C-6  A halted deployment refuses every batch until an administrator clears the halt with a
--        reason (chain.clear_halt is granted to nobody).
--   C-7  NOTIFY chain_events fires at commit only; an aborted batch never wakes a consumer.
-- Amounts and IDs are uint256 on chain: numeric(78,0), never floating point.
-- Hex checks use length() plus '^0x[0-9a-f]+$': PostgreSQL's regex engine takes ~50 us per match
-- for counted repetition such as {64}, which made inserts several times slower.
-- One database serves one network: every deployment must have the same chain ID.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pt_chain_writer') THEN CREATE ROLE pt_chain_writer NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pt_chain_reader') THEN CREATE ROLE pt_chain_reader NOLOGIN; END IF;
END $$;

-- ------------------------------------------------------------------ deployments and cursor
CREATE TABLE chain.deployments (
  deployment text PRIMARY KEY CHECK (length(deployment) <= 80 AND deployment ~ '^[a-z0-9][a-z0-9_.:-]*$'),
  chain_id   bigint NOT NULL CHECK (chain_id > 0),
  from_block bigint NOT NULL CHECK (from_block >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE chain.contracts (
  deployment text NOT NULL REFERENCES chain.deployments,
  role       text NOT NULL CHECK (role IN ('token', 'identityRegistry', 'issuance', 'pauseGuard', 'freezeGuard', 'recovery',
                                           'registrarGuard', 'distributions', 'documents', 'timelock', 'idFactory')),
  address    text NOT NULL CHECK ((length(address) = 42 AND address ~ '^0x[0-9a-f]+$')),
  PRIMARY KEY (deployment, role),
  UNIQUE (deployment, address)
);

CREATE TABLE chain.cursors (
  deployment   text PRIMARY KEY REFERENCES chain.deployments,
  -- Last block fully applied; from_block - 1 before the first batch.
  block_number bigint NOT NULL CHECK (block_number >= -1),
  -- Its hash: the next batch must start with a block whose parent is this hash (C-2).
  block_hash   text CHECK ((length(block_hash) = 66 AND block_hash ~ '^0x[0-9a-f]+$')),
  batches      bigint NOT NULL DEFAULT 0,
  events       bigint NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  halted_at    timestamptz,
  halt_reason  text CHECK (length(halt_reason) <= 1000),
  CHECK ((halted_at IS NULL) = (halt_reason IS NULL))
);

-- Blocks that matter: the first and last block of every batch and every block with an event.
CREATE TABLE chain.blocks (
  number      bigint PRIMARY KEY CHECK (number >= 0),
  hash        text NOT NULL UNIQUE CHECK ((length(hash) = 66 AND hash ~ '^0x[0-9a-f]+$')),
  parent_hash text NOT NULL CHECK ((length(parent_hash) = 66 AND parent_hash ~ '^0x[0-9a-f]+$')),
  block_time  timestamptz NOT NULL
);

CREATE TABLE chain.halts (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  deployment text NOT NULL REFERENCES chain.deployments,
  at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  action     text NOT NULL CHECK (action IN ('halt', 'clear')),
  actor      text NOT NULL CHECK (length(actor) BETWEEN 1 AND 100),
  reason     text NOT NULL CHECK (length(reason) BETWEEN 1 AND 1000)
);

-- ------------------------------------------------------------------ raw events
CREATE TABLE chain.events (
  deployment   text NOT NULL REFERENCES chain.deployments,
  block_number bigint NOT NULL REFERENCES chain.blocks (number),
  log_index    integer NOT NULL CHECK (log_index >= 0),
  block_hash   text NOT NULL CHECK ((length(block_hash) = 66 AND block_hash ~ '^0x[0-9a-f]+$')),
  tx_hash      text NOT NULL CHECK ((length(tx_hash) = 66 AND tx_hash ~ '^0x[0-9a-f]+$')),
  tx_index     integer NOT NULL CHECK (tx_index >= 0),
  address      text NOT NULL CHECK ((length(address) = 42 AND address ~ '^0x[0-9a-f]+$')),
  contract     text NOT NULL,
  -- NULL when the log does not match the contract's ABI; topics and data are always kept.
  name         text CHECK (length(name) <= 64 AND name ~ '^[A-Za-z_][A-Za-z0-9_]*$'),
  args         jsonb CHECK (args IS NULL OR jsonb_typeof(args) = 'object'),
  topics       text[] NOT NULL CHECK (cardinality(topics) <= 4),
  data         text NOT NULL CHECK (length(data) % 2 = 0 AND data ~ '^0x[0-9a-f]*$'),
  CHECK ((name IS NULL) = (args IS NULL)),
  CHECK (octet_length(data) <= 1048576 AND (args IS NULL OR octet_length(args::text) <= 1048576)),
  PRIMARY KEY (deployment, block_number, log_index),
  UNIQUE (deployment, tx_hash, log_index)
);
CREATE INDEX events_name_idx ON chain.events (deployment, name, block_number);

-- ------------------------------------------------------------------ read model
CREATE TABLE chain.tokens (
  token         text PRIMARY KEY CHECK ((length(token) = 42 AND token ~ '^0x[0-9a-f]+$')),
  deployment    text NOT NULL UNIQUE REFERENCES chain.deployments,
  total_supply  numeric(78,0) NOT NULL DEFAULT 0 CHECK (total_supply >= 0),
  trustee_cap   numeric(78,0) NOT NULL DEFAULT 0 CHECK (trustee_cap >= 0),
  -- ERC-3643 4.1.3 tokens are initialised paused without emitting Paused.
  paused        boolean NOT NULL DEFAULT true,
  pause_reason  text,
  paused_by     text,
  updated_block bigint NOT NULL
);

CREATE TABLE chain.holdings (
  token         text NOT NULL REFERENCES chain.tokens,
  holder        text NOT NULL CHECK ((length(holder) = 42 AND holder ~ '^0x[0-9a-f]+$')),
  balance       numeric(78,0) NOT NULL CHECK (balance >= 0),
  updated_block bigint NOT NULL,
  PRIMARY KEY (token, holder)
);
CREATE INDEX holdings_holder_idx ON chain.holdings (holder) INCLUDE (balance);
CREATE INDEX holdings_rank_idx ON chain.holdings (token, balance DESC) WHERE balance > 0;

CREATE TABLE chain.transfers (
  deployment   text NOT NULL,
  block_number bigint NOT NULL,
  log_index    integer NOT NULL,
  token        text NOT NULL REFERENCES chain.tokens,
  tx_hash      text NOT NULL,
  from_addr    text NOT NULL,
  to_addr      text NOT NULL,
  amount       numeric(78,0) NOT NULL CHECK (amount >= 0),
  kind         text NOT NULL CHECK (kind IN ('mint', 'burn', 'transfer')),
  PRIMARY KEY (deployment, block_number, log_index),
  FOREIGN KEY (deployment, block_number, log_index) REFERENCES chain.events
);
CREATE INDEX transfers_from_idx ON chain.transfers (from_addr, block_number DESC, log_index DESC);
CREATE INDEX transfers_to_idx ON chain.transfers (to_addr, block_number DESC, log_index DESC);
CREATE INDEX transfers_token_idx ON chain.transfers (token, block_number DESC, log_index DESC);

CREATE TABLE chain.issuances (
  guard        text NOT NULL,
  ref_id       text NOT NULL CHECK ((length(ref_id) = 66 AND ref_id ~ '^0x[0-9a-f]+$')),
  kind         text NOT NULL CHECK (kind IN ('mint', 'burn')),
  account      text NOT NULL,
  amount       numeric(78,0) NOT NULL CHECK (amount >= 0),
  deployment   text NOT NULL,
  block_number bigint NOT NULL,
  log_index    integer NOT NULL,
  tx_hash      text NOT NULL,
  -- I-11: a refId is used once, across mint and burn.
  PRIMARY KEY (guard, ref_id),
  FOREIGN KEY (deployment, block_number, log_index) REFERENCES chain.events
);
CREATE INDEX issuances_account_idx ON chain.issuances (account, block_number DESC);

CREATE TABLE chain.freezes (
  token          text NOT NULL REFERENCES chain.tokens,
  holder         text NOT NULL CHECK ((length(holder) = 42 AND holder ~ '^0x[0-9a-f]+$')),
  address_frozen boolean NOT NULL DEFAULT false,
  frozen_amount  numeric(78,0) NOT NULL DEFAULT 0 CHECK (frozen_amount >= 0),
  updated_block  bigint NOT NULL,
  PRIMARY KEY (token, holder)
);

CREATE TABLE chain.freeze_actions (
  deployment   text NOT NULL,
  block_number bigint NOT NULL,
  log_index    integer NOT NULL,
  guard        text NOT NULL,
  holder       text NOT NULL,
  scope        text NOT NULL CHECK (scope IN ('address', 'partial')),
  frozen       boolean NOT NULL,
  amount       numeric(78,0),
  case_id      text NOT NULL,
  PRIMARY KEY (deployment, block_number, log_index),
  FOREIGN KEY (deployment, block_number, log_index) REFERENCES chain.events
);
CREATE INDEX freeze_actions_holder_idx ON chain.freeze_actions (holder, block_number DESC);

CREATE TABLE chain.distributions (
  registry          text NOT NULL,
  id                numeric(78,0) NOT NULL CHECK (id > 0),
  token             text NOT NULL,
  record_block      bigint NOT NULL,
  merkle_root       text NOT NULL,
  total_paisa       numeric(78,0) NOT NULL CHECK (total_paisa >= 0),
  statement_hash    text NOT NULL,
  status            text NOT NULL CHECK (status IN ('published', 'rejected', 'finalized', 'paid')),
  reject_reason     text,
  payout_batch_hash text,
  published_block   bigint NOT NULL,
  updated_block     bigint NOT NULL,
  PRIMARY KEY (registry, id)
);
CREATE INDEX distributions_token_idx ON chain.distributions (token, id DESC);

CREATE TABLE chain.documents (
  registry      text NOT NULL,
  id            numeric(78,0) NOT NULL CHECK (id > 0),
  token         text NOT NULL,
  doc_type      smallint NOT NULL CHECK (doc_type BETWEEN 0 AND 255),
  sha256_hash   text NOT NULL,
  uri           text NOT NULL,
  superseded_by numeric(78,0),
  added_block   bigint NOT NULL,
  updated_block bigint NOT NULL,
  PRIMARY KEY (registry, id)
);
CREATE INDEX documents_token_idx ON chain.documents (token, id DESC);

CREATE TABLE chain.recoveries (
  guard          text NOT NULL,
  id             numeric(78,0) NOT NULL CHECK (id > 0),
  kind           text NOT NULL CHECK (kind IN ('wallet_recovery', 'forced_transfer')),
  from_addr      text NOT NULL,
  to_addr        text NOT NULL,
  onchain_id     text NOT NULL,
  amount         numeric(78,0) NOT NULL CHECK (amount >= 0),
  evidence_hash  text NOT NULL,
  eta            bigint NOT NULL,
  status         text NOT NULL CHECK (status IN ('pending', 'executed', 'cancelled')),
  cancelled_by   text,
  proposed_block bigint NOT NULL,
  updated_block  bigint NOT NULL,
  PRIMARY KEY (guard, id)
);

CREATE TABLE chain.investors (
  registry      text NOT NULL,
  wallet        text NOT NULL CHECK ((length(wallet) = 42 AND wallet ~ '^0x[0-9a-f]+$')),
  identity      text,
  -- Set from RegistrarGuard.InvestorRegistered or IdentityRegistry.CountryUpdated; NULL if neither was seen.
  country       integer CHECK (country BETWEEN 0 AND 65535),
  registered    boolean NOT NULL,
  -- IdentityUpdated names the old and new identity but not the wallet. When the old identity
  -- belongs to more than one wallet the read model cannot tell which one changed, so it marks
  -- them stale (to be re-read from chain) instead of guessing.
  identity_stale boolean NOT NULL DEFAULT false,
  updated_block bigint NOT NULL,
  PRIMARY KEY (registry, wallet)
);
CREATE INDEX investors_identity_idx ON chain.investors (registry, identity);

-- ------------------------------------------------------------------ C-3 append-only
CREATE FUNCTION chain.forbid_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'chain read model: % on %.% is not allowed', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END $$;

DO $$
DECLARE
  t text;
BEGIN
  -- History: never updated or deleted.
  FOREACH t IN ARRAY ARRAY['blocks', 'events', 'transfers', 'issuances', 'freeze_actions', 'halts'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON chain.%I FOR EACH ROW EXECUTE FUNCTION chain.forbid_change()', t || '_append_only', t);
  END LOOP;
  -- Derived state: updated by apply_batch, never deleted.
  FOREACH t IN ARRAY ARRAY['deployments', 'contracts', 'cursors', 'tokens', 'holdings', 'freezes', 'distributions',
                           'documents', 'recoveries', 'investors'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE DELETE ON chain.%I FOR EACH ROW EXECUTE FUNCTION chain.forbid_change()', t || '_no_delete', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['blocks', 'events', 'transfers', 'issuances', 'freeze_actions', 'halts', 'deployments', 'contracts',
                           'cursors', 'tokens', 'holdings', 'freezes', 'distributions', 'documents', 'recoveries', 'investors'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON chain.%I FOR EACH STATEMENT EXECUTE FUNCTION chain.forbid_change()', t || '_no_truncate', t);
  END LOOP;
END $$;

-- Deployment identity never changes after registration.
CREATE FUNCTION chain.guard_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'chain.%: registered deployments are immutable', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER deployments_immutable BEFORE UPDATE ON chain.deployments FOR EACH ROW EXECUTE FUNCTION chain.guard_identity();
CREATE TRIGGER contracts_immutable BEFORE UPDATE ON chain.contracts FOR EACH ROW EXECUTE FUNCTION chain.guard_identity();

-- ------------------------------------------------------------------ API (SECURITY DEFINER)
-- Error codes the indexer acts on:
--   PTC01  cursor moved (another batch was applied first): re-read the cursor, nothing to undo
--   PTC02  chain mismatch (hash or parent link): HALT
--   PTC03  invariant violated while deriving (gap, duplicate, impossible transition): HALT
--   PTC04  deployment is halted

/**
 * Registers a deployment and its contracts (idempotent). A second call must name exactly the same
 * chain, start block and contracts. p_start_hash is the hash of block from_block - 1 (NULL when
 * from_block is 0), so even the first batch is linked to a known parent (C-2).
 */
CREATE FUNCTION chain.register_deployment(
  p_deployment text, p_chain_id bigint, p_from_block bigint, p_contracts jsonb, p_start_hash text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, chain AS $$
DECLARE
  v_existing chain.deployments;
  v_given jsonb;
  v_stored jsonb;
  v_token text;
BEGIN
  IF p_contracts IS NULL OR jsonb_typeof(p_contracts) <> 'object' OR NOT (p_contracts ? 'token') THEN
    RAISE EXCEPTION 'contracts must be an object with at least a token' USING ERRCODE = 'check_violation';
  END IF;
  IF p_from_block IS NULL OR (p_from_block > 0) <> (p_start_hash IS NOT NULL) THEN
    RAISE EXCEPTION 'the start hash is required exactly when from_block > 0' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM chain.deployments WHERE chain_id <> p_chain_id) THEN
    RAISE EXCEPTION 'this database already indexes another chain; use one database per network' USING ERRCODE = 'check_violation';
  END IF;
  SELECT jsonb_object_agg(key, lower(value)) INTO v_given FROM jsonb_each_text(p_contracts);
  v_token := v_given->>'token';

  -- Serialise registrations of the same deployment.
  PERFORM pg_advisory_xact_lock(586586051, hashtext(p_deployment));
  SELECT * INTO v_existing FROM chain.deployments WHERE deployment = p_deployment;
  IF FOUND THEN
    SELECT jsonb_object_agg(role, address) INTO v_stored FROM chain.contracts WHERE deployment = p_deployment;
    IF v_existing.chain_id <> p_chain_id OR v_existing.from_block <> p_from_block OR v_stored <> v_given THEN
      RAISE EXCEPTION 'deployment % is already registered with different settings', p_deployment USING ERRCODE = 'unique_violation';
    END IF;
    RETURN;
  END IF;

  INSERT INTO chain.deployments (deployment, chain_id, from_block) VALUES (p_deployment, p_chain_id, p_from_block);
  INSERT INTO chain.contracts (deployment, role, address) SELECT p_deployment, key, value FROM jsonb_each_text(v_given);
  INSERT INTO chain.cursors (deployment, block_number, block_hash) VALUES (p_deployment, p_from_block - 1, lower(p_start_hash));
  INSERT INTO chain.tokens (token, deployment, updated_block) VALUES (v_token, p_deployment, p_from_block - 1);
END $$;

/** Records a halt (C-6). Idempotent: the first reason is kept. Wakes alerting at commit. */
CREATE FUNCTION chain.halt(p_deployment text, p_actor text, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, chain AS $$
BEGIN
  IF p_reason IS NULL OR length(p_reason) = 0 THEN
    RAISE EXCEPTION 'a halt needs a reason' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE chain.cursors SET halted_at = clock_timestamp(), halt_reason = left(p_reason, 1000)
  WHERE deployment = p_deployment AND halted_at IS NULL;
  IF FOUND THEN
    INSERT INTO chain.halts (deployment, action, actor, reason) VALUES (p_deployment, 'halt', left(p_actor, 100), left(p_reason, 1000));
    PERFORM pg_notify('chain_alert', json_build_object('deployment', p_deployment, 'reason', left(p_reason, 500))::text);
  END IF;
END $$;

/**
 * Clears a halt after an investigation. Granted to nobody: an administrator runs it, with a reason
 * of at least 10 characters, and it is recorded. Usually the right fix is a rebuild instead.
 */
CREATE FUNCTION chain.clear_halt(p_deployment text, p_operator text, p_reason text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, chain AS $$
BEGIN
  IF p_operator IS NULL OR length(p_operator) = 0 OR p_reason IS NULL OR length(p_reason) < 10 THEN
    RAISE EXCEPTION 'an operator and a reason of at least 10 characters are required' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE chain.cursors SET halted_at = NULL, halt_reason = NULL WHERE deployment = p_deployment AND halted_at IS NOT NULL;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO chain.halts (deployment, action, actor, reason) VALUES (p_deployment, 'clear', left(p_operator, 100), left(p_reason, 1000));
  RETURN true;
END $$;

-- Raises PTC03 (C-5).
CREATE FUNCTION chain.violation(p_message text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'invariant violated: %', p_message USING ERRCODE = 'PTC03';
END $$;

/** Applies one decoded event to the derived tables. Internal: called only by apply_batch. */
CREATE FUNCTION chain.derive(
  p_deployment text, p_role text, p_address text, p_name text, a jsonb, p_block bigint, p_log integer, p_tx text
) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, chain AS $$
DECLARE
  zero constant text := '0x0000000000000000000000000000000000000000';
  v_token text;
  v_ir text;
  v_from text;
  v_to text;
  v_amount numeric;
  v_n integer;
BEGIN
  IF p_name IS NULL THEN
    RETURN;
  END IF;

  IF p_role = 'token' THEN
    v_token := p_address;
    IF p_name = 'Transfer' THEN
      v_from := lower(a->>'from');
      v_to := lower(a->>'to');
      v_amount := (a->>'value')::numeric;
      INSERT INTO chain.transfers (deployment, block_number, log_index, token, tx_hash, from_addr, to_addr, amount, kind)
      VALUES (p_deployment, p_block, p_log, v_token, p_tx, v_from, v_to, v_amount,
              CASE WHEN v_from = zero THEN 'mint' WHEN v_to = zero THEN 'burn' ELSE 'transfer' END);
      IF v_from = zero THEN
        UPDATE chain.tokens SET total_supply = total_supply + v_amount, updated_block = p_block WHERE token = v_token;
      ELSE
        UPDATE chain.holdings SET balance = balance - v_amount, updated_block = p_block
        WHERE token = v_token AND holder = v_from AND balance >= v_amount;
        GET DIAGNOSTICS v_n = ROW_COUNT;
        IF v_n = 0 AND v_amount > 0 THEN
          PERFORM chain.violation(format('balance of %s would go negative at block %s', v_from, p_block));
        END IF;
      END IF;
      IF v_to = zero THEN
        UPDATE chain.tokens SET total_supply = total_supply - v_amount, updated_block = p_block
        WHERE token = v_token AND total_supply >= v_amount;
        GET DIAGNOSTICS v_n = ROW_COUNT;
        IF v_n = 0 THEN
          PERFORM chain.violation(format('total supply would go negative at block %s', p_block));
        END IF;
      ELSE
        INSERT INTO chain.holdings (token, holder, balance, updated_block) VALUES (v_token, v_to, v_amount, p_block)
        ON CONFLICT (token, holder) DO UPDATE SET balance = holdings.balance + EXCLUDED.balance, updated_block = p_block;
      END IF;
    ELSIF p_name = 'Paused' THEN
      UPDATE chain.tokens SET paused = true, updated_block = p_block WHERE token = v_token;
    ELSIF p_name = 'Unpaused' THEN
      UPDATE chain.tokens SET paused = false, pause_reason = NULL, paused_by = NULL, updated_block = p_block WHERE token = v_token;
    ELSIF p_name = 'AddressFrozen' THEN
      INSERT INTO chain.freezes (token, holder, address_frozen, updated_block)
      VALUES (v_token, lower(a->>'_userAddress'), (a->>'_isFrozen')::boolean, p_block)
      ON CONFLICT (token, holder) DO UPDATE SET address_frozen = EXCLUDED.address_frozen, updated_block = p_block;
    ELSIF p_name = 'TokensFrozen' THEN
      INSERT INTO chain.freezes (token, holder, frozen_amount, updated_block)
      VALUES (v_token, lower(a->>'_userAddress'), (a->>'_amount')::numeric, p_block)
      ON CONFLICT (token, holder) DO UPDATE SET frozen_amount = freezes.frozen_amount + EXCLUDED.frozen_amount, updated_block = p_block;
    ELSIF p_name = 'TokensUnfrozen' THEN
      v_amount := (a->>'_amount')::numeric;
      UPDATE chain.freezes SET frozen_amount = frozen_amount - v_amount, updated_block = p_block
      WHERE token = v_token AND holder = lower(a->>'_userAddress') AND frozen_amount >= v_amount;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      IF v_n = 0 AND v_amount > 0 THEN
        PERFORM chain.violation(format('frozen amount of %s would go negative at block %s', a->>'_userAddress', p_block));
      END IF;
    END IF;

  ELSIF p_role = 'issuance' THEN
    IF p_name IN ('Minted', 'Burned') THEN
      INSERT INTO chain.issuances (guard, ref_id, kind, account, amount, deployment, block_number, log_index, tx_hash)
      VALUES (p_address, lower(a->>'refId'), CASE p_name WHEN 'Minted' THEN 'mint' ELSE 'burn' END,
              lower(coalesce(a->>'to', a->>'from')), (a->>'amount')::numeric, p_deployment, p_block, p_log, p_tx)
      ON CONFLICT (guard, ref_id) DO NOTHING;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      IF v_n = 0 THEN
        PERFORM chain.violation(format('refId %s used twice (I-11) at block %s', a->>'refId', p_block));
      END IF;
    ELSIF p_name = 'TrusteeCapSet' THEN
      UPDATE chain.tokens SET trustee_cap = (a->>'current')::numeric, updated_block = p_block WHERE deployment = p_deployment;
    END IF;

  ELSIF p_role = 'pauseGuard' THEN
    IF p_name = 'Paused' THEN
      UPDATE chain.tokens SET pause_reason = a->>'reason', paused_by = lower(a->>'by'), updated_block = p_block WHERE deployment = p_deployment;
    END IF;

  ELSIF p_role = 'freezeGuard' THEN
    IF p_name IN ('AddressFreezeSet', 'PartialFreezeSet') THEN
      INSERT INTO chain.freeze_actions (deployment, block_number, log_index, guard, holder, scope, frozen, amount, case_id)
      VALUES (p_deployment, p_block, p_log, p_address, lower(a->>'account'),
              CASE p_name WHEN 'AddressFreezeSet' THEN 'address' ELSE 'partial' END,
              (a->>'frozen')::boolean, (a->>'amount')::numeric, lower(a->>'caseId'));
    END IF;

  ELSIF p_role = 'recovery' THEN
    IF p_name = 'RecoveryProposed' THEN
      INSERT INTO chain.recoveries (guard, id, kind, from_addr, to_addr, onchain_id, amount, evidence_hash, eta, status,
                                    proposed_block, updated_block)
      VALUES (p_address, (a->>'id')::numeric, CASE (a->>'kind')::int WHEN 0 THEN 'wallet_recovery' ELSE 'forced_transfer' END,
              lower(a->>'from'), lower(a->>'to'), lower(a->>'onchainId'), (a->>'amount')::numeric, lower(a->>'evidenceHash'),
              (a->>'eta')::bigint, 'pending', p_block, p_block)
      ON CONFLICT (guard, id) DO NOTHING;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      IF v_n = 0 THEN
        PERFORM chain.violation(format('recovery %s proposed twice at block %s', a->>'id', p_block));
      END IF;
    ELSIF p_name IN ('RecoveryExecuted', 'RecoveryCancelled') THEN
      UPDATE chain.recoveries
      SET status = CASE p_name WHEN 'RecoveryExecuted' THEN 'executed' ELSE 'cancelled' END,
          cancelled_by = lower(a->>'by'), updated_block = p_block
      WHERE guard = p_address AND id = (a->>'id')::numeric AND status = 'pending';
      GET DIAGNOSTICS v_n = ROW_COUNT;
      IF v_n = 0 THEN
        PERFORM chain.violation(format('recovery %s closed while not pending (I-13) at block %s', a->>'id', p_block));
      END IF;
    END IF;

  ELSIF p_role = 'identityRegistry' THEN
    v_ir := p_address;
    IF p_name = 'IdentityRegistered' THEN
      INSERT INTO chain.investors (registry, wallet, identity, registered, updated_block)
      VALUES (v_ir, lower(a->>'investorAddress'), lower(a->>'identity'), true, p_block)
      ON CONFLICT (registry, wallet) DO UPDATE
        SET identity = EXCLUDED.identity, registered = true, identity_stale = false, updated_block = p_block
        WHERE NOT investors.registered;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      IF v_n = 0 THEN
        PERFORM chain.violation(format('wallet %s registered twice at block %s', a->>'investorAddress', p_block));
      END IF;
    ELSIF p_name = 'IdentityRemoved' THEN
      UPDATE chain.investors SET registered = false, identity = NULL, country = NULL, identity_stale = false, updated_block = p_block
      WHERE registry = v_ir AND wallet = lower(a->>'investorAddress') AND registered;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      IF v_n = 0 THEN
        PERFORM chain.violation(format('wallet %s removed while not registered at block %s', a->>'investorAddress', p_block));
      END IF;
    ELSIF p_name = 'CountryUpdated' THEN
      UPDATE chain.investors SET country = (a->>'country')::int, updated_block = p_block
      WHERE registry = v_ir AND wallet = lower(a->>'investorAddress');
    ELSIF p_name = 'IdentityUpdated' THEN
      SELECT count(*) INTO v_n FROM chain.investors WHERE registry = v_ir AND registered AND identity = lower(a->>'oldIdentity');
      IF v_n = 1 THEN
        UPDATE chain.investors SET identity = lower(a->>'newIdentity'), updated_block = p_block
        WHERE registry = v_ir AND registered AND identity = lower(a->>'oldIdentity');
      ELSE
        UPDATE chain.investors SET identity_stale = true, updated_block = p_block
        WHERE registry = v_ir AND registered AND identity = lower(a->>'oldIdentity');
      END IF;
    END IF;

  ELSIF p_role = 'registrarGuard' THEN
    -- RegistrarGuard emits InvestorRegistered BEFORE it calls the identity registry, so this only
    -- records the country; IdentityRegistered (authoritative) marks the wallet registered.
    IF p_name = 'InvestorRegistered' THEN
      SELECT address INTO v_ir FROM chain.contracts WHERE deployment = p_deployment AND role = 'identityRegistry';
      IF v_ir IS NOT NULL THEN
        INSERT INTO chain.investors (registry, wallet, country, registered, updated_block)
        VALUES (v_ir, lower(a->>'account'), (a->>'country')::int, false, p_block)
        ON CONFLICT (registry, wallet) DO UPDATE SET country = EXCLUDED.country, updated_block = p_block;
      END IF;
    END IF;

  ELSIF p_role = 'distributions' THEN
    IF p_name = 'DistributionPublished' THEN
      INSERT INTO chain.distributions (registry, id, token, record_block, merkle_root, total_paisa, statement_hash, status,
                                       published_block, updated_block)
      VALUES (p_address, (a->>'id')::numeric, lower(a->>'token'), (a->>'recordBlock')::bigint, lower(a->>'merkleRoot'),
              (a->>'totalPaisa')::numeric, lower(a->>'statementHash'), 'published', p_block, p_block)
      ON CONFLICT (registry, id) DO NOTHING;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      IF v_n = 0 THEN
        PERFORM chain.violation(format('distribution %s published twice (I-14) at block %s', a->>'id', p_block));
      END IF;
    ELSIF p_name IN ('DistributionRejected', 'DistributionFinalized', 'PayoutRecorded') THEN
      UPDATE chain.distributions
      SET status = CASE p_name WHEN 'DistributionRejected' THEN 'rejected' WHEN 'DistributionFinalized' THEN 'finalized' ELSE 'paid' END,
          reject_reason = CASE WHEN p_name = 'DistributionRejected' THEN a->>'reason' ELSE reject_reason END,
          payout_batch_hash = CASE WHEN p_name = 'PayoutRecorded' THEN lower(a->>'payoutBatchHash') ELSE payout_batch_hash END,
          updated_block = p_block
      WHERE registry = p_address AND id = (a->>'id')::numeric
        AND status = CASE WHEN p_name = 'PayoutRecorded' THEN 'finalized' ELSE 'published' END;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      IF v_n = 0 THEN
        PERFORM chain.violation(format('distribution %s: %s in the wrong status (I-14) at block %s', a->>'id', p_name, p_block));
      END IF;
    END IF;

  ELSIF p_role = 'documents' THEN
    IF p_name = 'DocumentAdded' THEN
      INSERT INTO chain.documents (registry, id, token, doc_type, sha256_hash, uri, added_block, updated_block)
      VALUES (p_address, (a->>'id')::numeric, lower(a->>'token'), (a->>'docType')::smallint, lower(a->>'sha256Hash'), a->>'uri',
              p_block, p_block)
      ON CONFLICT (registry, id) DO NOTHING;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      IF v_n = 0 THEN
        PERFORM chain.violation(format('document %s added twice (I-15) at block %s', a->>'id', p_block));
      END IF;
    ELSIF p_name = 'DocumentSuperseded' THEN
      UPDATE chain.documents SET superseded_by = (a->>'newId')::numeric, updated_block = p_block
      WHERE registry = p_address AND id = (a->>'oldId')::numeric AND superseded_by IS NULL;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      IF v_n = 0 THEN
        PERFORM chain.violation(format('document %s superseded twice or unknown (I-15) at block %s', a->>'oldId', p_block));
      END IF;
    END IF;
  END IF;
  -- Timelock, ID factory and ownership events are kept as raw events only.
END $$;

/**
 * C-1/C-2/C-5/C-7: applies one batch.
 *   p_expected_block  the cursor the caller read; the batch covers p_expected_block + 1 .. p_to_block
 *   p_blocks          [{number, hash, parentHash, timestamp}] ascending: the first and last block of
 *                     the batch and every block that has an event
 *   p_events          [{blockNumber, blockHash, logIndex, txHash, txIndex, address, name, args, topics, data}]
 *                     ascending by (blockNumber, logIndex)
 * Returns the number of events applied.
 */
CREATE FUNCTION chain.apply_batch(
  p_deployment text, p_expected_block bigint, p_to_block bigint, p_to_hash text, p_blocks jsonb, p_events jsonb
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, chain AS $$
DECLARE
  c chain.cursors;
  b jsonb;
  e jsonb;
  v_first boolean := true;
  v_prev_number bigint;
  v_prev_hash text;
  v_number bigint;
  v_hash text;
  v_parent text;
  v_stored text;
  v_role text;
  v_address text;
  v_last_block bigint := -1;
  v_last_log integer := -1;
  v_log integer;
  v_n integer := 0;
BEGIN
  SELECT * INTO c FROM chain.cursors WHERE deployment = p_deployment FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown deployment %', p_deployment USING ERRCODE = 'check_violation';
  END IF;
  IF c.halted_at IS NOT NULL THEN
    RAISE EXCEPTION 'deployment % is halted: %', p_deployment, c.halt_reason USING ERRCODE = 'PTC04';
  END IF;
  IF c.block_number IS DISTINCT FROM p_expected_block THEN
    RAISE EXCEPTION 'cursor of % is at %, not %', p_deployment, c.block_number, p_expected_block USING ERRCODE = 'PTC01';
  END IF;
  IF p_to_block IS NULL OR p_to_block <= c.block_number OR jsonb_typeof(p_blocks) <> 'array' OR jsonb_typeof(p_events) <> 'array'
     OR jsonb_array_length(p_blocks) = 0 THEN
    RAISE EXCEPTION 'invalid batch' USING ERRCODE = 'check_violation';
  END IF;

  -- C-2: blocks.
  FOR b IN SELECT value FROM jsonb_array_elements(p_blocks) LOOP
    v_number := (b->>'number')::bigint;
    v_hash := lower(b->>'hash');
    v_parent := lower(b->>'parentHash');
    IF v_first THEN
      IF v_number <> c.block_number + 1 THEN
        RAISE EXCEPTION 'batch must start at block %, not %', c.block_number + 1, v_number USING ERRCODE = 'check_violation';
      END IF;
      IF c.block_hash IS NOT NULL AND v_parent IS DISTINCT FROM c.block_hash THEN
        RAISE EXCEPTION 'chain mismatch: block % names parent %, but block % was recorded as %',
          v_number, v_parent, c.block_number, c.block_hash USING ERRCODE = 'PTC02';
      END IF;
    ELSE
      IF v_number <= v_prev_number OR v_number > p_to_block THEN
        RAISE EXCEPTION 'batch blocks must ascend within the batch' USING ERRCODE = 'check_violation';
      END IF;
      IF v_number = v_prev_number + 1 AND v_parent IS DISTINCT FROM v_prev_hash THEN
        RAISE EXCEPTION 'chain mismatch: block % does not link to block %', v_number, v_prev_number USING ERRCODE = 'PTC02';
      END IF;
    END IF;
    INSERT INTO chain.blocks (number, hash, parent_hash, block_time)
    VALUES (v_number, v_hash, v_parent, to_timestamp((b->>'timestamp')::bigint))
    ON CONFLICT (number) DO NOTHING;
    SELECT hash INTO v_stored FROM chain.blocks WHERE number = v_number;
    IF v_stored IS DISTINCT FROM v_hash THEN
      RAISE EXCEPTION 'chain mismatch: block % was recorded as %, now %', v_number, v_stored, v_hash USING ERRCODE = 'PTC02';
    END IF;
    v_first := false;
    v_prev_number := v_number;
    v_prev_hash := v_hash;
  END LOOP;
  IF v_prev_number <> p_to_block OR v_prev_hash IS DISTINCT FROM lower(p_to_hash) THEN
    RAISE EXCEPTION 'the last batch block must be % with hash %', p_to_block, p_to_hash USING ERRCODE = 'check_violation';
  END IF;

  -- Events, strictly ordered, each on a recorded block of this batch.
  FOR e IN SELECT value FROM jsonb_array_elements(p_events) LOOP
    v_number := (e->>'blockNumber')::bigint;
    v_log := (e->>'logIndex')::integer;
    IF v_number <= c.block_number OR v_number > p_to_block
       OR v_number < v_last_block OR (v_number = v_last_block AND v_log <= v_last_log) THEN
      RAISE EXCEPTION 'events must be ordered and inside the batch (block %, log %)', v_number, v_log USING ERRCODE = 'check_violation';
    END IF;
    SELECT hash INTO v_stored FROM chain.blocks WHERE number = v_number;
    IF v_stored IS DISTINCT FROM lower(e->>'blockHash') THEN
      RAISE EXCEPTION 'chain mismatch: event at block % log % has block hash %, recorded %',
        v_number, v_log, e->>'blockHash', v_stored USING ERRCODE = 'PTC02';
    END IF;
    v_address := lower(e->>'address');
    SELECT role INTO v_role FROM chain.contracts WHERE deployment = p_deployment AND address = v_address;
    IF v_role IS NULL THEN
      RAISE EXCEPTION 'event from % is not from a contract of %', v_address, p_deployment USING ERRCODE = 'check_violation';
    END IF;
    INSERT INTO chain.events (deployment, block_number, log_index, block_hash, tx_hash, tx_index, address, contract, name, args, topics, data)
    VALUES (p_deployment, v_number, v_log, lower(e->>'blockHash'), lower(e->>'txHash'), (e->>'txIndex')::integer, v_address, v_role,
            e->>'name', CASE WHEN e->>'name' IS NULL THEN NULL ELSE e->'args' END,
            ARRAY(SELECT lower(t) FROM jsonb_array_elements_text(e->'topics') AS t), lower(e->>'data'));
    PERFORM chain.derive(p_deployment, v_role, v_address, e->>'name', e->'args', v_number, v_log, lower(e->>'txHash'));
    v_last_block := v_number;
    v_last_log := v_log;
    v_n := v_n + 1;
  END LOOP;

  UPDATE chain.cursors
  SET block_number = p_to_block, block_hash = lower(p_to_hash), batches = batches + 1, events = events + v_n, updated_at = now()
  WHERE deployment = p_deployment;

  IF v_n > 0 THEN
    PERFORM pg_notify('chain_events', json_build_object('deployment', p_deployment, 'toBlock', p_to_block, 'events', v_n)::text);
  END IF;
  RETURN v_n;
END $$;

-- ------------------------------------------------------------------ privileges
REVOKE ALL ON ALL TABLES IN SCHEMA chain FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA chain FROM PUBLIC;

GRANT USAGE ON SCHEMA chain TO pt_chain_writer, pt_chain_reader;
GRANT EXECUTE ON FUNCTION
  chain.register_deployment(text, bigint, bigint, jsonb, text),
  chain.apply_batch(text, bigint, bigint, text, jsonb, jsonb),
  chain.halt(text, text, text)
  TO pt_chain_writer;
GRANT SELECT ON chain.deployments, chain.contracts, chain.cursors TO pt_chain_writer;
GRANT SELECT ON ALL TABLES IN SCHEMA chain TO pt_chain_reader;

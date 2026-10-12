-- Public-chain anchoring (Step 5f-2, ADR 0008): every hourly anchor of the private chain and the
-- ledger head, recorded BEFORE anything is sent to the public chain.
--
-- What is anchored (contract-spec.md section 7.1): StateAnchor.anchor(besuBlock, commitment) with
--   commitment = keccak256(abi.encode(domain, besuChainId, besuBlock, besuBlockHash,
--                                     ledgerJournalId, ledgerHeadHash))
-- The components are stored here so anyone can recompute the public value. PostgreSQL has no
-- keccak, so the commitment itself is checked by `anchor:verify`, not by the database.
--
-- Safety properties enforced by the database itself:
--   A-1  The inputs of an anchor (anchor chain, contract, private chain and block, block hash, ledger
--        head, commitment, creator) never change after the record is written.
--   A-2  Never a lower block: a new anchor's private block must be greater than every earlier anchor
--        of the same contract that did not fail, the ledger head may never move backwards, and the
--        private chain ID never changes. At most one anchor per contract is open (recorded or sent).
--   A-3  Record before send: the transaction hash, nonce, sender and the signed raw transaction are
--        stored (recorded -> sent) before it is broadcast, so after a crash the job re-broadcasts the
--        SAME transaction instead of signing a second one. Status edges:
--          recorded -> sent | failed;  sent -> confirmed | failed | recorded (only when the
--          transaction is proven dropped; the transaction fields are cleared).
--        confirmed and failed are final. A failure always carries a reason (never a silent skip).
--   A-4  No DELETE or TRUNCATE; every change is appended to anchor.history (append-only).
--   A-5  Roles: pt_anchor_writer only calls the API functions; pt_anchor_reader only reads.
-- Hex checks use length() plus '^0x[0-9a-f]+$' (counted repetition is slow in PostgreSQL regex).

CREATE SCHEMA IF NOT EXISTS anchor;
REVOKE ALL ON SCHEMA anchor FROM PUBLIC;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pt_anchor_writer') THEN CREATE ROLE pt_anchor_writer NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pt_anchor_reader') THEN CREATE ROLE pt_anchor_reader NOLOGIN; END IF;
END $$;

-- ------------------------------------------------------------------ tables
CREATE TABLE anchor.anchors (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  anchor_chain_id   bigint NOT NULL CHECK (anchor_chain_id > 0),
  contract          text NOT NULL CHECK (length(contract) = 42 AND contract ~ '^0x[0-9a-f]+$'),
  besu_chain_id     bigint NOT NULL CHECK (besu_chain_id > 0 AND besu_chain_id <> anchor_chain_id),
  besu_block        bigint NOT NULL CHECK (besu_block > 0),
  besu_block_hash   text NOT NULL CHECK (length(besu_block_hash) = 66 AND besu_block_hash ~ '^0x[0-9a-f]+$'),
  ledger_journal_id bigint NOT NULL CHECK (ledger_journal_id >= 0),
  ledger_head_hash  text NOT NULL CHECK (length(ledger_head_hash) = 66 AND ledger_head_hash ~ '^0x[0-9a-f]+$'),
  commitment        text NOT NULL CHECK (length(commitment) = 66 AND commitment ~ '^0x[0-9a-f]+$'
                                         AND commitment <> '0x' || repeat('0', 64)),
  status            text NOT NULL DEFAULT 'recorded' CHECK (status IN ('recorded', 'sent', 'confirmed', 'failed')),
  tx_hash           text CHECK (length(tx_hash) = 66 AND tx_hash ~ '^0x[0-9a-f]+$'),
  tx_nonce          bigint CHECK (tx_nonce >= 0),
  tx_from           text CHECK (length(tx_from) = 42 AND tx_from ~ '^0x[0-9a-f]+$'),
  raw_tx            text CHECK (length(raw_tx) BETWEEN 4 AND 4096 AND raw_tx ~ '^0x[0-9a-f]+$'),
  sent_at           timestamptz,
  anchor_block      bigint CHECK (anchor_block >= 0),
  anchor_block_hash text CHECK (length(anchor_block_hash) = 66 AND anchor_block_hash ~ '^0x[0-9a-f]+$'),
  confirmed_at      timestamptz,
  failure           text CHECK (length(failure) BETWEEN 1 AND 1000),
  created_by        text NOT NULL CHECK (length(created_by) BETWEEN 1 AND 100),
  created_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- The ledger head is "nothing yet" exactly when the hash is zero.
  CHECK ((ledger_journal_id = 0) = (ledger_head_hash = '0x' || repeat('0', 64))),
  -- The transaction is either fully known or absent.
  CHECK ((tx_hash IS NULL) = (tx_nonce IS NULL) AND (tx_hash IS NULL) = (tx_from IS NULL)
         AND (tx_hash IS NULL) = (raw_tx IS NULL) AND (tx_hash IS NULL) = (sent_at IS NULL)),
  CHECK (status <> 'recorded' OR tx_hash IS NULL),
  CHECK (status NOT IN ('sent', 'confirmed') OR tx_hash IS NOT NULL),
  CHECK ((status = 'confirmed') = (anchor_block IS NOT NULL)),
  CHECK ((anchor_block IS NULL) = (anchor_block_hash IS NULL) AND (anchor_block IS NULL) = (confirmed_at IS NULL)),
  CHECK ((status = 'failed') = (failure IS NOT NULL))
);
-- A-2: one live anchor per private block (a failed one may be retried), at most one open anchor per contract.
CREATE UNIQUE INDEX anchors_block_idx ON anchor.anchors (anchor_chain_id, contract, besu_block) WHERE status <> 'failed';
CREATE UNIQUE INDEX anchors_one_open_idx ON anchor.anchors (anchor_chain_id, contract) WHERE status IN ('recorded', 'sent');

CREATE TABLE anchor.history (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  anchor_id bigint NOT NULL REFERENCES anchor.anchors (id),
  at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor     text NOT NULL CHECK (length(actor) BETWEEN 1 AND 100),
  action    text NOT NULL CHECK (action IN ('record', 'sent', 'confirm', 'dropped', 'fail')),
  detail    jsonb NOT NULL CHECK (jsonb_typeof(detail) = 'object' AND octet_length(detail::text) <= 8192)
);
CREATE INDEX history_anchor_idx ON anchor.history (anchor_id, id);

-- ------------------------------------------------------------------ A-1, A-3, A-4 triggers
CREATE FUNCTION anchor.forbid_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'anchor records are append-only: % on %.% is not allowed', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE TRIGGER anchors_no_delete BEFORE DELETE ON anchor.anchors FOR EACH ROW EXECUTE FUNCTION anchor.forbid_change();
CREATE TRIGGER anchors_no_truncate BEFORE TRUNCATE ON anchor.anchors FOR EACH STATEMENT EXECUTE FUNCTION anchor.forbid_change();
CREATE TRIGGER history_append_only BEFORE UPDATE OR DELETE ON anchor.history FOR EACH ROW EXECUTE FUNCTION anchor.forbid_change();
CREATE TRIGGER history_no_truncate BEFORE TRUNCATE ON anchor.history FOR EACH STATEMENT EXECUTE FUNCTION anchor.forbid_change();

-- Applies to every UPDATE, including one typed by an administrator.
CREATE FUNCTION anchor.guard_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.anchor_chain_id, NEW.contract, NEW.besu_chain_id, NEW.besu_block, NEW.besu_block_hash,
      NEW.ledger_journal_id, NEW.ledger_head_hash, NEW.commitment, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.anchor_chain_id, OLD.contract, OLD.besu_chain_id, OLD.besu_block, OLD.besu_block_hash,
      OLD.ledger_journal_id, OLD.ledger_head_hash, OLD.commitment, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'anchor % inputs are immutable', OLD.id USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.status = OLD.status THEN
    RAISE EXCEPTION 'anchor %: no status change (%)', OLD.id, OLD.status USING ERRCODE = 'check_violation';
  END IF;
  IF NOT ((OLD.status = 'recorded' AND NEW.status IN ('sent', 'failed'))
       OR (OLD.status = 'sent' AND NEW.status IN ('confirmed', 'failed', 'recorded'))) THEN
    RAISE EXCEPTION 'anchor %: status % -> % is not allowed', OLD.id, OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  -- A transaction, once recorded, stays as it is until it is confirmed or proven dropped.
  IF OLD.status = 'sent' AND NEW.status IN ('confirmed', 'failed')
     AND (NEW.tx_hash, NEW.tx_nonce, NEW.tx_from, NEW.raw_tx, NEW.sent_at)
         IS DISTINCT FROM (OLD.tx_hash, OLD.tx_nonce, OLD.tx_from, OLD.raw_tx, OLD.sent_at) THEN
    RAISE EXCEPTION 'anchor %: the recorded transaction cannot change', OLD.id USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER anchors_guard BEFORE UPDATE ON anchor.anchors FOR EACH ROW EXECUTE FUNCTION anchor.guard_update();

-- ------------------------------------------------------------------ API (SECURITY DEFINER)
CREATE FUNCTION anchor.log(p_anchor bigint, p_actor text, p_action text, p_detail jsonb) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, anchor AS $$
  INSERT INTO anchor.history (anchor_id, actor, action, detail) VALUES (p_anchor, p_actor, p_action, p_detail)
$$;

/** A-2: records a new anchor before anything is signed or sent. Returns its id. */
CREATE FUNCTION anchor.record(
  p_anchor_chain_id bigint, p_contract text, p_besu_chain_id bigint, p_besu_block bigint, p_besu_block_hash text,
  p_ledger_journal_id bigint, p_ledger_head_hash text, p_commitment text, p_actor text
) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, anchor AS $$
DECLARE
  v_last anchor.anchors;
  v_id   bigint;
BEGIN
  -- One writer per contract at a time keeps the order strict.
  PERFORM pg_advisory_xact_lock(586586070, hashtext(p_anchor_chain_id::text || ':' || lower(p_contract)));
  IF EXISTS (SELECT 1 FROM anchor.anchors WHERE anchor_chain_id = p_anchor_chain_id AND contract = lower(p_contract)
             AND status IN ('recorded', 'sent')) THEN
    RAISE EXCEPTION 'an anchor is already open for this contract' USING ERRCODE = 'PTA01';
  END IF;
  SELECT * INTO v_last FROM anchor.anchors
  WHERE anchor_chain_id = p_anchor_chain_id AND contract = lower(p_contract) AND status <> 'failed'
  ORDER BY besu_block DESC LIMIT 1;
  IF FOUND THEN
    IF p_besu_block <= v_last.besu_block THEN
      RAISE EXCEPTION 'private block % is not above the last anchored block %', p_besu_block, v_last.besu_block
        USING ERRCODE = 'PTA02';
    END IF;
    IF p_ledger_journal_id < v_last.ledger_journal_id THEN
      RAISE EXCEPTION 'ledger head moved backwards: journal % after %', p_ledger_journal_id, v_last.ledger_journal_id
        USING ERRCODE = 'PTA03';
    END IF;
    IF p_besu_chain_id <> v_last.besu_chain_id THEN
      RAISE EXCEPTION 'private chain ID % differs from the anchored chain %', p_besu_chain_id, v_last.besu_chain_id
        USING ERRCODE = 'PTA04';
    END IF;
  END IF;
  INSERT INTO anchor.anchors (anchor_chain_id, contract, besu_chain_id, besu_block, besu_block_hash,
                              ledger_journal_id, ledger_head_hash, commitment, created_by)
  VALUES (p_anchor_chain_id, lower(p_contract), p_besu_chain_id, p_besu_block, lower(p_besu_block_hash),
          p_ledger_journal_id, lower(p_ledger_head_hash), lower(p_commitment), p_actor)
  RETURNING id INTO v_id;
  PERFORM anchor.log(v_id, p_actor, 'record', jsonb_build_object('besuBlock', p_besu_block, 'commitment', lower(p_commitment)));
  RETURN v_id;
END $$;

/** A-3: stores the signed transaction BEFORE it is broadcast. False if the anchor is not 'recorded'. */
CREATE FUNCTION anchor.mark_sent(p_id bigint, p_tx_hash text, p_nonce bigint, p_from text, p_raw_tx text, p_actor text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, anchor AS $$
BEGIN
  UPDATE anchor.anchors
  SET status = 'sent', tx_hash = lower(p_tx_hash), tx_nonce = p_nonce, tx_from = lower(p_from), raw_tx = lower(p_raw_tx),
      sent_at = clock_timestamp()
  WHERE id = p_id AND status = 'recorded';
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM anchor.log(p_id, p_actor, 'sent', jsonb_build_object('txHash', lower(p_tx_hash), 'nonce', p_nonce));
  RETURN true;
END $$;

/** The transaction is mined successfully on the anchor chain (with enough confirmations). */
CREATE FUNCTION anchor.confirm(p_id bigint, p_tx_hash text, p_anchor_block bigint, p_anchor_block_hash text, p_actor text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, anchor AS $$
BEGIN
  UPDATE anchor.anchors
  SET status = 'confirmed', anchor_block = p_anchor_block, anchor_block_hash = lower(p_anchor_block_hash), confirmed_at = clock_timestamp()
  WHERE id = p_id AND status = 'sent' AND tx_hash = lower(p_tx_hash);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'anchor % is not sent with transaction %', p_id, p_tx_hash USING ERRCODE = 'PTA05';
  END IF;
  PERFORM anchor.log(p_id, p_actor, 'confirm', jsonb_build_object('txHash', lower(p_tx_hash), 'anchorBlock', p_anchor_block));
END $$;

/** The recorded transaction was proven dropped (its nonce was used by another transaction, and it has no receipt). */
CREATE FUNCTION anchor.clear_dropped(p_id bigint, p_tx_hash text, p_reason text, p_actor text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, anchor AS $$
BEGIN
  IF p_reason IS NULL OR length(p_reason) < 5 THEN
    RAISE EXCEPTION 'a reason is required' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE anchor.anchors
  SET status = 'recorded', tx_hash = NULL, tx_nonce = NULL, tx_from = NULL, raw_tx = NULL, sent_at = NULL
  WHERE id = p_id AND status = 'sent' AND tx_hash = lower(p_tx_hash);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'anchor % is not sent with transaction %', p_id, p_tx_hash USING ERRCODE = 'PTA05';
  END IF;
  PERFORM anchor.log(p_id, p_actor, 'dropped', jsonb_build_object('txHash', lower(p_tx_hash), 'reason', left(p_reason, 500)));
END $$;

/** Ends an open anchor that can never be completed (e.g. reverted on chain). Always loud: callers alert. */
CREATE FUNCTION anchor.fail(p_id bigint, p_reason text, p_actor text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, anchor AS $$
BEGIN
  IF p_reason IS NULL OR length(p_reason) < 5 THEN
    RAISE EXCEPTION 'a reason is required' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE anchor.anchors SET status = 'failed', failure = left(p_reason, 1000)
  WHERE id = p_id AND status IN ('recorded', 'sent');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'anchor % is not open', p_id USING ERRCODE = 'PTA05';
  END IF;
  PERFORM anchor.log(p_id, p_actor, 'fail', jsonb_build_object('reason', left(p_reason, 1000)));
END $$;

-- ------------------------------------------------------------------ privileges
REVOKE ALL ON ALL TABLES IN SCHEMA anchor FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA anchor FROM PUBLIC;

GRANT USAGE ON SCHEMA anchor TO pt_anchor_writer, pt_anchor_reader;
GRANT EXECUTE ON FUNCTION
  anchor.record(bigint, text, bigint, bigint, text, bigint, text, text, text),
  anchor.mark_sent(bigint, text, bigint, text, text, text),
  anchor.confirm(bigint, text, bigint, text, text),
  anchor.clear_dropped(bigint, text, text, text),
  anchor.fail(bigint, text, text)
TO pt_anchor_writer;
GRANT SELECT ON anchor.anchors, anchor.history TO pt_anchor_writer, pt_anchor_reader;
-- The anchoring job reads the ledger head; verification recomputes the ledger hash chain.
GRANT USAGE ON SCHEMA ledger TO pt_anchor_writer, pt_anchor_reader;
GRANT EXECUTE ON FUNCTION ledger.chain_head() TO pt_anchor_writer;
GRANT SELECT ON ledger.journal, ledger.postings TO pt_anchor_reader;

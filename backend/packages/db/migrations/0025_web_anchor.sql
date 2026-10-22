-- Website: the public-anchoring status (task T-047, S-07 PV-20..PV-23, ADR 0008 and 0010). The
-- website's role (pt_web, migration 0012 W-5) gets two thin read functions of schema anchor and
-- nothing else there. Same pattern as migration 0022 (recon.web_status) and 0018 (offering.web_*).
--
-- Numbered 0025 on top of 0024; 0026 is reserved for a parallel branch.
--
-- Safety properties enforced by the database itself (rule IDs WN-n):
--   WN-1  Least privilege: pt_web may EXECUTE anchor.web_status() and anchor.web_recent(integer)
--         and nothing else in schema anchor (no table, no view, no other function). The writer API
--         (record, mark_sent, confirm, clear_dropped, fail) stays with pt_anchor_writer.
--   WN-2  Public values only: the components of the commitment (private chain ID, block and block
--         hash, ledger journal id and head hash), the commitment, the anchor chain ID, the
--         StateAnchor address, the public transaction hash, the anchor-chain block and the times.
--         Never the signed raw transaction, the nonce, the sender, the creator, the history or the
--         failure reason (it may carry internal detail); a failure is a coarse state only.
--   WN-3  Scope: the "current" anchor target is the anchor chain and contract of the newest anchor
--         record (by id), so an earlier stand-in deployment never mixes with the current one.
--   WN-4  Bounded: anchor.web_recent returns at most 20 rows (NULL or below 1 means 12) and never
--         a failed anchor (it was never on the anchor chain).

-- ------------------------------------------------------------------ WN-2/WN-3 latest status
/**
 * One row (none before the first anchor record) for the current target:
 *   latest confirmed anchor (private block, commitment, transaction hash, anchor-chain block, time),
 *   number of confirmed anchors, age of the latest confirmation in seconds,
 *   open_state: 'pending' while an anchor is recorded or sent, 'failed' when the newest anchor
 *   failed and none is open, otherwise 'none'; open_since: when that open or failed anchor began.
 */
CREATE FUNCTION anchor.web_status()
RETURNS TABLE (
  anchor_chain_id bigint, contract text, besu_chain_id bigint, besu_block bigint, commitment text, tx_hash text,
  anchor_block bigint, confirmed_at timestamptz, confirmed_count bigint, age_seconds bigint,
  open_state text, open_since timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, anchor AS $$
  WITH target AS (
    SELECT a.anchor_chain_id, a.contract FROM anchor.anchors a ORDER BY a.id DESC LIMIT 1
  ), mine AS (
    SELECT a.* FROM anchor.anchors a JOIN target t USING (anchor_chain_id, contract)
  ), latest AS (
    SELECT m.* FROM mine m WHERE m.status = 'confirmed' ORDER BY m.besu_block DESC LIMIT 1
  ), newest AS (
    SELECT m.status, m.created_at FROM mine m ORDER BY m.id DESC LIMIT 1
  ), open_a AS (
    SELECT m.created_at FROM mine m WHERE m.status IN ('recorded', 'sent') ORDER BY m.id DESC LIMIT 1
  )
  SELECT t.anchor_chain_id, t.contract, l.besu_chain_id, l.besu_block, l.commitment, l.tx_hash,
         l.anchor_block, l.confirmed_at,
         (SELECT count(*) FROM mine m WHERE m.status = 'confirmed'),
         CASE WHEN l.confirmed_at IS NULL THEN NULL
              ELSE greatest(0, floor(extract(epoch FROM (now() - l.confirmed_at))))::bigint END,
         CASE WHEN EXISTS (SELECT 1 FROM open_a) THEN 'pending'
              WHEN (SELECT n.status FROM newest n) = 'failed' THEN 'failed'
              ELSE 'none' END,
         coalesce((SELECT o.created_at FROM open_a o),
                  (SELECT n.created_at FROM newest n WHERE n.status = 'failed'))
  FROM target t
  LEFT JOIN latest l ON true
$$;

-- ------------------------------------------------------------------ WN-2/WN-3/WN-4 recent anchors
/** The newest anchors of the current target with their commitment components (never failed ones). */
CREATE FUNCTION anchor.web_recent(p_limit integer)
RETURNS TABLE (
  id bigint, anchor_chain_id bigint, contract text, besu_chain_id bigint, besu_block bigint, besu_block_hash text,
  ledger_journal_id bigint, ledger_head_hash text, commitment text, status text, tx_hash text,
  anchor_block bigint, confirmed_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, anchor AS $$
  WITH target AS (
    SELECT a.anchor_chain_id, a.contract FROM anchor.anchors a ORDER BY a.id DESC LIMIT 1
  )
  SELECT a.id, a.anchor_chain_id, a.contract, a.besu_chain_id, a.besu_block, a.besu_block_hash,
         a.ledger_journal_id, a.ledger_head_hash, a.commitment, a.status, a.tx_hash,
         a.anchor_block, a.confirmed_at
  FROM anchor.anchors a JOIN target t USING (anchor_chain_id, contract)
  WHERE a.status <> 'failed'
  ORDER BY a.besu_block DESC
  LIMIT CASE WHEN p_limit IS NULL OR p_limit < 1 THEN 12 ELSE least(p_limit, 20) END
$$;

-- ------------------------------------------------------------------ privileges (WN-1)
REVOKE ALL ON FUNCTION anchor.web_status(), anchor.web_recent(integer) FROM PUBLIC;

GRANT USAGE ON SCHEMA anchor TO pt_web;
GRANT EXECUTE ON FUNCTION anchor.web_status(), anchor.web_recent(integer) TO pt_web;

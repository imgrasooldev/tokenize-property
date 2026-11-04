-- Public API phase 1b: the investor's rent distributions and Merkle proofs (ADR 0018,
-- docs/api/openapi.json /me/distributions). Applies on top of 0058.
--
--   PD-1  papi.distributions(access): the token owner's lines of every calculation whose statement
--         is published on chain (chain.distributions with the same token and statement hash, not
--         rejected): units, gross, WHT, net and the on-chain status. Returned calculations and
--         unpublished ones are not shown.
--   PD-2  papi.distribution_statement(access, token, onchain id): the published statement text, its
--         hash on chain and the root, only when the investor has a paid line in it. The API builds
--         the proof from the statement's own entitlements (as the reconciliation's independent check
--         does) and checks keccak256(statement) against the chain; the client gets only its proof.

CREATE FUNCTION papi.distributions(p_access_hash bytea)
RETURNS TABLE (token text, onchain_id text, period text, record_date date, status text, units text, gross bigint, wht bigint, net bigint,
               statement_hash text, merkle_root text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, papi AS $$
  SELECT d.token, c.id::text, d.period, d.record_date, c.status, l.units::text, l.gross, l.wht, l.net, c.statement_hash, c.merkle_root
  FROM webdemo.investors i
  JOIN ops.distribution_lines l ON l.wallet = lower(i.wallet_address)
  JOIN ops.distributions d ON d.id = l.distribution_id AND d.status <> 'returned' AND d.statement_hash IS NOT NULL
  JOIN chain.distributions c ON c.token = d.token AND c.statement_hash = d.statement_hash AND c.status <> 'rejected'
  WHERE i.id = papi.token_investor(p_access_hash)
  ORDER BY d.record_date DESC, c.id DESC
  LIMIT 500
$$;

CREATE FUNCTION papi.distribution_statement(p_access_hash bytea, p_token text, p_onchain_id numeric)
RETURNS TABLE (wallet text, registry text, statement text, statement_hash text, merkle_root text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, papi AS $$
  SELECT lower(i.wallet_address), c.registry, d.statement, c.statement_hash, c.merkle_root
  FROM webdemo.investors i
  JOIN chain.distributions c ON c.token = lower(p_token) AND c.id = p_onchain_id AND c.status <> 'rejected'
  JOIN ops.distributions d ON d.token = c.token AND d.statement_hash = c.statement_hash AND d.status <> 'returned'
  WHERE i.id = papi.token_investor(p_access_hash)
    AND EXISTS (SELECT 1 FROM ops.distribution_lines l WHERE l.distribution_id = d.id AND l.wallet = lower(i.wallet_address) AND l.net > 0)
  LIMIT 1
$$;

REVOKE ALL ON FUNCTION papi.distributions(bytea), papi.distribution_statement(bytea, text, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION papi.distributions(bytea), papi.distribution_statement(bytea, text, numeric) TO pt_svc_public_api;

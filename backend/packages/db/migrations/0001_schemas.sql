-- Separate schemas per concern, so each service role can be granted only what it needs (Step 5b+).
--   ledger  : double-entry money and token records (append-only)
--   outbox  : commands waiting for the signing service / chain
--   chain   : read model built by the indexer from chain events
--   signer  : signing-service policy and audit records (signing service role only)
--   recon   : reconciliation runs and findings

CREATE SCHEMA IF NOT EXISTS ledger;
CREATE SCHEMA IF NOT EXISTS outbox;
CREATE SCHEMA IF NOT EXISTS chain;
CREATE SCHEMA IF NOT EXISTS signer;
CREATE SCHEMA IF NOT EXISTS recon;

-- Nobody gets implicit rights through PUBLIC.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON SCHEMA ledger, outbox, chain, signer, recon FROM PUBLIC;

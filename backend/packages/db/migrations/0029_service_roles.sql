-- T-012 (ADR 0016): one database role per backend service process.
--
-- Until now every backend service connected as the admin (schema owner). Each service now has a
-- NOLOGIN group role pt_svc_<service> that holds exactly what its code does, and a LOGIN role
-- (pt_<service>_app) created outside migrations by `npm run db:service-roles` (password generated
-- there, appended to the git-ignored backend/.env.local, never printed). A login is a member of
-- its group only (INHERIT TRUE, SET FALSE): it cannot SET ROLE, own objects or grant anything on.
--
-- The groups are composed from the per-domain roles the earlier migrations already defined (each
-- of those grants only API functions and the reads its consumers need), plus the few grants that
-- were missing for what the service code actually runs (marked FIX below). Nothing here widens
-- any existing role. Service group -> processes (deploy/demo-server units, deploy/ops jobs):
--   pt_svc_indexer      indexer run / status / verify           pt-indexer, pt-ops indexer:verify
--   pt_svc_signer       signing service                          pt-signer
--   pt_svc_outbox       outbox worker                            pt-outbox
--   pt_svc_kyc          KYC API (sign-up) and re-screening        pt-kyc
--   pt_svc_offboarding  KYC offboarding worker                    pt-offboarding
--   pt_svc_bank         bank webhook and payout-account API       pt-bank-payees
--   pt_svc_anchor       anchoring job, anchor status / verify     pt-anchor, pt-ops anchor:verify
--   pt_svc_recon        reconciliation run and status             pt-ops recon
--   pt_svc_recovery     recovery tick and audit check             (recovery:tick --loop)
--   pt_svc_tax          tax service (filing exports)              (tax:serve)
--   pt_svc_notify       notification delivery worker              (notify:run)
--   pt_svc_audit        audit hash-chain checks (read only)       pt-ops signer/kyc/bank:audit
--   pt_svc_console      demo console ledger panel and rent demo   pt-console
-- Operator and setup commands (migrate, *:setup, signer:decide, recon:unfreeze, ops:run, seeds)
-- keep the admin login: they are break-glass or deploy-time tools, not services.

DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['pt_svc_indexer', 'pt_svc_signer', 'pt_svc_outbox', 'pt_svc_kyc', 'pt_svc_offboarding',
    'pt_svc_bank', 'pt_svc_anchor', 'pt_svc_recon', 'pt_svc_recovery', 'pt_svc_tax', 'pt_svc_notify', 'pt_svc_audit',
    'pt_svc_console'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', r);
    END IF;
  END LOOP;
END $$;

-- ------------------------------------------------------------------ composition (existing roles)
-- WITH INHERIT TRUE: the privileges flow to the group; SET FALSE: nobody can SET ROLE through it.
GRANT pt_chain_writer, pt_chain_reader TO pt_svc_indexer WITH INHERIT TRUE, SET FALSE;
GRANT pt_signer TO pt_svc_signer WITH INHERIT TRUE, SET FALSE;
GRANT pt_outbox_worker TO pt_svc_outbox WITH INHERIT TRUE, SET FALSE;
GRANT pt_kyc_service TO pt_svc_kyc WITH INHERIT TRUE, SET FALSE;
GRANT pt_bank_service TO pt_svc_bank WITH INHERIT TRUE, SET FALSE;
GRANT pt_anchor_writer, pt_anchor_reader TO pt_svc_anchor WITH INHERIT TRUE, SET FALSE;
GRANT pt_recon_writer, pt_ledger_reader, pt_chain_reader, pt_signer_auditor, pt_outbox_reader TO pt_svc_recon WITH INHERIT TRUE, SET FALSE;
GRANT pt_recovery_worker TO pt_svc_recovery WITH INHERIT TRUE, SET FALSE;
GRANT pt_tax_service TO pt_svc_tax WITH INHERIT TRUE, SET FALSE;
GRANT pt_notify_worker TO pt_svc_notify WITH INHERIT TRUE, SET FALSE;
GRANT pt_signer_auditor, pt_kyc_reader, pt_bank_reader TO pt_svc_audit WITH INHERIT TRUE, SET FALSE;
-- The demo console's rent cycle posts demo:* journals through the ledger API (no direct writes).
GRANT pt_ledger_reader, pt_ledger_writer TO pt_svc_console WITH INHERIT TRUE, SET FALSE;

-- ------------------------------------------------------------------ outbox worker
-- FIX: after an executor error the worker re-reads its command (outbox getCommand) and decides from
-- the database whether anything was recorded (ADR 0004). pt_outbox_worker alone cannot read it, so
-- that path failed with 42501 and the command waited for its lease to expire.
GRANT SELECT ON outbox.commands TO pt_svc_outbox;

-- ------------------------------------------------------------------ offboarding worker
-- It only turns a lost verification into a queued freeze (kyc.enqueue_offboarding, SECURITY DEFINER).
GRANT USAGE ON SCHEMA kyc TO pt_svc_offboarding;
GRANT EXECUTE ON FUNCTION kyc.enqueue_offboarding(text, text) TO pt_svc_offboarding;

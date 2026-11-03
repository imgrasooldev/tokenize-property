-- Website side of spec S-08 (Roshan Digital Account investors). Applies on top of 0056.
--
--   WR-1  A non-resident who signs up reads "review" until two compliance officers approve
--         (0056 RD-2). The website keeps their account with onboard_step 'waiting' and starts the
--         on-chain onboarding only once kyc.subject_status() reads 'verified' (the signing service
--         would refuse identity.create before that).
--   WR-2  webnotice.waiting_onboard(): the waiting investors that may start now. pt_web gets only
--         this function (its own schema, gotcha of 2026-10-30), never kyc or compliance.

ALTER TABLE webdemo.investors DROP CONSTRAINT IF EXISTS investors_onboard_step_check;
ALTER TABLE webdemo.investors ADD CONSTRAINT investors_onboard_step_check
  CHECK (onboard_step IN ('waiting', 'identity', 'claims', 'register', 'done', 'failed'));

CREATE FUNCTION webnotice.waiting_onboard() RETURNS TABLE (investor_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, webnotice AS $$
  SELECT i.id FROM webdemo.investors i
  WHERE i.onboard_step = 'waiting' AND i.kyc_subject IS NOT NULL AND kyc.subject_status(i.kyc_subject) = 'verified'
  ORDER BY i.created_at LIMIT 100
$$;

REVOKE ALL ON FUNCTION webnotice.waiting_onboard() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION webnotice.waiting_onboard() TO pt_web;

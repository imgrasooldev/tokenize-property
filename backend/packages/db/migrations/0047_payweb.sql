-- Fix for 0044 RI-2: the website's role (pt_web) has no USAGE on schema ops, so it could not reach
-- ops.web_invoice and the tenant payment page failed. Rather than open schema ops to the website, a
-- schema of its own holds the one function the website may call. Applies on top of 0046.

CREATE SCHEMA payweb;
REVOKE ALL ON SCHEMA payweb FROM PUBLIC;

/** The tenant's invoice by its payment link (0044 RI-2): only the fields the payment page shows. */
CREATE FUNCTION payweb.invoice(p_link text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, ops AS $$
  SELECT ops.web_invoice(p_link)
$$;

REVOKE ALL ON FUNCTION payweb.invoice(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION ops.web_invoice(text) FROM pt_web;
GRANT USAGE ON SCHEMA payweb TO pt_web;
GRANT EXECUTE ON FUNCTION payweb.invoice(text) TO pt_web;

-- Vault master key rotation (ADR 0017 follow-up). Applies on top of 0042.
--
--   VR-1  Files never change on rotation: each file has its own data key; rotation re-wraps that
--         data key with the current master key version. vault.rewrap(sha, from, to, wrapped) is the
--         only way to change an object: only key_version (upwards, from the version it has) and
--         wrapped_key may change, and every re-wrap is recorded in vault.rewraps (append-only).
--   VR-2  The vault service does it (`npm run vault:rotate`): it unwraps with the old key and checks
--         that the file still decrypts to its hash before it records the new wrap. A file that does
--         not check out keeps its old wrap and is reported (exit 3); the others are re-wrapped.
--   VR-3  vault.stale(current, limit, after) pages by hash so a reported file is not retried in a loop.

CREATE TABLE vault.rewraps (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sha256       bytea NOT NULL REFERENCES vault.objects (sha256),
  from_version smallint NOT NULL,
  to_version   smallint NOT NULL CHECK (to_version > from_version),
  at           timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER rewraps_append_only BEFORE UPDATE OR DELETE ON vault.rewraps FOR EACH ROW EXECUTE FUNCTION vault.append_only();

/** Objects stay append-only except a re-wrap made inside vault.rewrap (VR-1). */
CREATE OR REPLACE FUNCTION vault.append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  -- Nested: PL/pgSQL does not short-circuit AND, and other tables have no such columns.
  IF TG_TABLE_NAME = 'objects' AND TG_OP = 'UPDATE' AND current_setting('vault.rewrap', true) = 'on' THEN
    IF (NEW.sha256, NEW.size_bytes, NEW.media_type, NEW.nonce, NEW.created_by, NEW.created_at)
       IS NOT DISTINCT FROM (OLD.sha256, OLD.size_bytes, OLD.media_type, OLD.nonce, OLD.created_by, OLD.created_at)
       AND NEW.key_version > OLD.key_version THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'vault.% is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE FUNCTION vault.rewrap(p_sha bytea, p_from smallint, p_to smallint, p_wrapped bytea) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, vault AS $$
BEGIN
  IF p_wrapped IS NULL OR length(p_wrapped) <> 60 OR p_to IS NULL OR p_from IS NULL OR p_to <= p_from THEN
    RAISE EXCEPTION 'a re-wrap goes to a newer key version with a 60-byte wrapped key' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM set_config('vault.rewrap', 'on', true);
  UPDATE vault.objects SET key_version = p_to, wrapped_key = p_wrapped WHERE sha256 = p_sha AND key_version = p_from;
  IF NOT FOUND THEN
    PERFORM set_config('vault.rewrap', 'off', true);
    RAISE EXCEPTION 'no object with this hash at key version %', p_from USING ERRCODE = 'no_data_found';
  END IF;
  PERFORM set_config('vault.rewrap', 'off', true);
  INSERT INTO vault.rewraps (sha256, from_version, to_version) VALUES (p_sha, p_from, p_to);
END $$;

/** Objects still wrapped with an older key than p_current (for the rotation run). */
CREATE FUNCTION vault.stale(p_current smallint, p_limit integer, p_after bytea) RETURNS TABLE (sha256 bytea, key_version smallint, wrapped_key bytea)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, vault AS $$
  SELECT o.sha256, o.key_version, o.wrapped_key FROM vault.objects o
  WHERE o.key_version < p_current AND o.sha256 > coalesce(p_after, '\x'::bytea)
  ORDER BY o.sha256 LIMIT greatest(1, least(p_limit, 1000))
$$;

REVOKE ALL ON TABLE vault.rewraps FROM PUBLIC;
REVOKE ALL ON FUNCTION vault.rewrap(bytea, smallint, smallint, bytea), vault.stale(smallint, integer, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION vault.rewrap(bytea, smallint, smallint, bytea), vault.stale(smallint, integer, bytea) TO pt_svc_vault;

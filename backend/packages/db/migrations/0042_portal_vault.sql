-- PT Control: document uploads into the vault (T-038 follow-up, ADR 0017). Applies on top of 0041.
--
--   PV-1  admin.vault_upload(session, sha256, size, media): an operations maker (operations.request)
--         with a fresh step-up may store one document; the call is audited (vault.upload) with the
--         hash, size and media type BEFORE the portal sends the file to the vault service, and
--         returns the officer's handle, which the vault records as officer:<handle>. The portal
--         holds no vault key; the service encrypts.
--   PV-2  admin.vault_objects(session) (operations.read): the latest stored documents (hash, size,
--         media type, who, when) and whether each is published (vault.public_document).

CREATE FUNCTION admin.vault_upload(p_session bytea, p_sha bytea, p_size bigint, p_media text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'operations.request');
BEGIN
  PERFORM admin.require_step_up(p_session);
  IF p_sha IS NULL OR length(p_sha) <> 32 OR p_size IS NULL OR p_size NOT BETWEEN 1 AND 26214400
     OR p_media IS NULL OR p_media NOT IN ('application/pdf', 'image/jpeg', 'image/png', 'image/tiff') THEN
    RETURN admin.refuse(v_me, 'vault_upload', coalesce(encode(p_sha, 'hex'), '-'), 'store', 'a PDF, JPEG, PNG or TIFF of 1 byte to 25 MB is required');
  END IF;
  PERFORM admin.audit_append(v_me::text, 'vault.upload', jsonb_build_object('sha256', encode(p_sha, 'hex'), 'size', p_size, 'media', p_media));
  RETURN jsonb_build_object('ok', true, 'officer', admin.handle_of(v_me));
END $$;

CREATE FUNCTION admin.vault_objects(p_session bytea) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
BEGIN
  PERFORM admin.require(p_session, 'operations.read');
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('sha256', encode(o.sha256, 'hex'), 'size', o.size_bytes, 'media', o.media_type,
                     'by', o.created_by, 'at', admin.utc(o.created_at), 'published', vault.public_document(o.sha256),
                     'reads', (SELECT count(*) FROM vault.reads r WHERE r.sha256 = o.sha256)) ORDER BY o.created_at DESC)
                   FROM (SELECT * FROM vault.objects ORDER BY created_at DESC LIMIT 50) o), '[]'::jsonb);
END $$;

REVOKE ALL ON FUNCTION admin.vault_upload(bytea, bytea, bigint, text), admin.vault_objects(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.vault_upload(bytea, bytea, bigint, text), admin.vault_objects(bytea) TO pt_admin_portal;

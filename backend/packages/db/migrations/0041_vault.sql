-- Encrypted document vault (T-038, ADR 0017). Applies on top of 0040.
--
--   DV-1  Document files live outside the database, encrypted by the vault service (AES-256-GCM, one
--         random data key per file, wrapped with the vault master key of a numbered version). The
--         database keeps only metadata: SHA-256 of the PLAINTEXT (the identity everyone already
--         uses: property.documents, offering doc hashes, on-chain DocumentRegistry), size, media
--         type, key version, the wrapped key and nonce. store_ref of a vault object is
--         vault://<sha256 hex>.
--   DV-2  Objects are append-only: a stored hash is never replaced or deleted here (retention and
--         erasure are a separate, legal-approved procedure, ADR 0009).
--   DV-3  Publication rule (vault.public_document): a file may be given to the public website only
--         if its hash is the offering document (EN or UR) or the risk disclosure of an offering the
--         website may show, or a current public property document of such an offering
--         (property.web_documents rules). Everything else (KYC, title deeds, valuations) is never
--         public.
--   DV-4  Every read through the service is logged (vault.reads: hash, client, purpose, time);
--         append-only.
--   DV-5  The vault service connects as pt_vault_app (group pt_svc_vault); it may only register
--         objects, look them up, check the publication rule and log reads.

CREATE SCHEMA vault;
REVOKE ALL ON SCHEMA vault FROM PUBLIC;

CREATE TABLE vault.objects (
  sha256       bytea PRIMARY KEY CHECK (length(sha256) = 32),
  size_bytes   bigint NOT NULL CHECK (size_bytes BETWEEN 1 AND 1073741824),
  media_type   text NOT NULL CHECK (media_type IN ('application/pdf', 'image/jpeg', 'image/png', 'image/tiff')),
  key_version  smallint NOT NULL CHECK (key_version BETWEEN 1 AND 999),
  wrapped_key  bytea NOT NULL CHECK (length(wrapped_key) = 60),
  nonce        bytea NOT NULL CHECK (length(nonce) = 12),
  created_by   text NOT NULL CHECK (length(created_by) BETWEEN 2 AND 100),
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE vault.reads (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sha256    bytea NOT NULL REFERENCES vault.objects (sha256),
  client    text NOT NULL CHECK (length(client) BETWEEN 2 AND 60),
  purpose   text NOT NULL CHECK (purpose IN ('public', 'operator')),
  at        timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX reads_sha ON vault.reads (sha256, id);

CREATE FUNCTION vault.append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'vault.% is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER objects_append_only BEFORE UPDATE OR DELETE ON vault.objects FOR EACH ROW EXECUTE FUNCTION vault.append_only();
CREATE TRIGGER reads_append_only BEFORE UPDATE OR DELETE ON vault.reads FOR EACH ROW EXECUTE FUNCTION vault.append_only();

/** DV-1: registers an encrypted object (idempotent for the same hash: the first one stays). */
CREATE FUNCTION vault.register(p_sha bytea, p_size bigint, p_media text, p_key_version smallint, p_wrapped bytea, p_nonce bytea, p_actor text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, vault AS $$
BEGIN
  INSERT INTO vault.objects (sha256, size_bytes, media_type, key_version, wrapped_key, nonce, created_by)
  VALUES (p_sha, p_size, p_media, p_key_version, p_wrapped, p_nonce, p_actor)
  ON CONFLICT (sha256) DO NOTHING;
  RETURN 'vault://' || encode(p_sha, 'hex');
END $$;

CREATE FUNCTION vault.object(p_sha bytea)
RETURNS TABLE (size_bytes bigint, media_type text, key_version smallint, wrapped_key bytea, nonce bytea)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, vault AS $$
  SELECT o.size_bytes, o.media_type, o.key_version, o.wrapped_key, o.nonce FROM vault.objects o WHERE o.sha256 = p_sha
$$;

/** DV-3: may this file be given to the public website? */
CREATE FUNCTION vault.public_document(p_sha bytea) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, vault AS $$
  SELECT EXISTS (
    SELECT 1 FROM offering.offerings o
    WHERE o.state IN ('ready', 'live', 'suspended', 'closing', 'funded', 'completing', 'completed', 'failed', 'refunding', 'cancelled')
      AND p_sha IN (o.doc_en_sha, o.doc_ur_sha, o.risk_sha))
  OR EXISTS (
    SELECT 1 FROM offering.offerings o JOIN property.documents d ON d.property_id = o.property_id
    WHERE o.state IN ('ready', 'live', 'suspended', 'closing', 'funded', 'completing', 'completed', 'failed', 'refunding', 'cancelled')
      AND d.sha256 = p_sha AND property.web_public_doc_type(d.doc_type) AND property.is_current(d.id))
$$;

/** DV-4: one read, logged before the bytes leave the service. */
CREATE FUNCTION vault.log_read(p_sha bytea, p_client text, p_purpose text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, vault AS $$
DECLARE
  v_id bigint;
BEGIN
  INSERT INTO vault.reads (sha256, client, purpose) VALUES (p_sha, p_client, p_purpose) RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- ================================================================== DV-5 privileges
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pt_svc_vault') THEN
    CREATE ROLE pt_svc_vault NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA vault FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA vault FROM PUBLIC;
GRANT USAGE ON SCHEMA vault TO pt_svc_vault;
GRANT EXECUTE ON FUNCTION vault.register(bytea, bigint, text, smallint, bytea, bytea, text), vault.object(bytea), vault.public_document(bytea),
  vault.log_read(bytea, text, text) TO pt_svc_vault;

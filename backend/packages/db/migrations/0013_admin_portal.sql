-- Internal portals, Step 6a (ADR 0011): officers, hardware-key credentials, sessions, roles with
-- segregation of duties, maker-checker officer changes and a hash-chained admin audit log.
--
-- Safety properties enforced by the database itself:
--   P-1  Officers are their own population. Nothing here refers to investors (webdemo, kyc); an
--        investor record can never become an officer session. Only an ACTIVE officer with an
--        enrolled, device-bound WebAuthn credential that verified the user can hold a session.
--   P-2  Segregation of duties: admin.role_conflicts lists incompatible roles; a trigger refuses any
--        grant that conflicts with a role the officer currently holds, whoever writes the row
--        (also a direct INSERT). Maker and checker, trustee and any platform role, auditor and any
--        other role, admin and any role that approves money or token actions are incompatible.
--   P-3  Officer changes (invite, grant, revoke, disable) are maker-checker: requested by one
--        administrator and decided by a DIFFERENT administrator whose session has a fresh step-up
--        (a WebAuthn assertion less than 5 minutes old); nobody requests or decides a change to
--        their own account; requests expire after 24 hours; at least two active administrators
--        must remain. The only officers created without a checker are the (at most two) bootstrap
--        administrators, and only while no other officer exists.
--   P-4  Sessions: a random 256-bit token lives in the cookie, only its SHA-256 here. 15 minutes
--        idle and 8 hours absolute, enforced here; one live session per officer; disabling an
--        officer ends their session.
--   P-5  Enrolment tokens: only the SHA-256 is stored; single use; at most 30 minutes; issued only
--        for an approved (or bootstrap) officer who has no credential yet.
--   P-6  WebAuthn challenges are single use, live at most 5 minutes and are bound to their purpose
--        (and to the session for a step-up, to the enrolment token for an enrolment).
--   P-7  Every authentication event, role change, officer change, sensitive page view, denial
--        and export is written to an append-only, hash-chained audit log (timestamps in UTC inside
--        the digest, finding F-04). admin.verify_audit() re-checks the chain and finds rows written
--        around the API (credentials, sessions, grants, changes) and an edited role matrix.
--   P-8  Authorisation is enforced here as well as in the portal: every read function takes the
--        session hash and checks the permission (admin.role_permissions). The portal's database
--        role has no table grants at all, only EXECUTE on these functions, and reads the other
--        schemas only through them (read-only in Step 6a).
--   P-9  Roles: pt_admin_portal (the portal), pt_admin_cli (bootstrap and enrolment links, run on
--        the server), pt_admin_auditor (verification only).

CREATE SCHEMA IF NOT EXISTS admin;
REVOKE ALL ON SCHEMA admin FROM PUBLIC;

DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['pt_admin_portal', 'pt_admin_cli', 'pt_admin_auditor'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN', r);
    END IF;
  END LOOP;
END $$;

-- ================================================================== helpers and limits
CREATE FUNCTION admin.forbid_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'admin.% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE FUNCTION admin.utc(p timestamptz) RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT to_char(p AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
$$;

CREATE FUNCTION admin.idle_limit() RETURNS interval LANGUAGE sql IMMUTABLE AS $$ SELECT interval '15 minutes' $$;
CREATE FUNCTION admin.absolute_limit() RETURNS interval LANGUAGE sql IMMUTABLE AS $$ SELECT interval '8 hours' $$;
CREATE FUNCTION admin.step_up_window() RETURNS interval LANGUAGE sql IMMUTABLE AS $$ SELECT interval '5 minutes' $$;

-- ================================================================== audit (P-7)
CREATE TABLE admin.audit (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at        timestamptz NOT NULL,
  actor     text NOT NULL CHECK (length(actor) BETWEEN 1 AND 100),
  action    text NOT NULL CHECK (action ~ '^[a-z][a-z_.]{2,63}$'),
  detail    jsonb NOT NULL CHECK (jsonb_typeof(detail) = 'object' AND octet_length(detail::text) <= 8192),
  prev_hash bytea NOT NULL CHECK (length(prev_hash) = 32),
  hash      bytea NOT NULL UNIQUE CHECK (length(hash) = 32)
);
CREATE INDEX audit_action_idx ON admin.audit (action, id);
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON admin.audit FOR EACH ROW EXECUTE FUNCTION admin.forbid_change();
CREATE TRIGGER audit_no_truncate BEFORE TRUNCATE ON admin.audit FOR EACH STATEMENT EXECUTE FUNCTION admin.forbid_change();

CREATE FUNCTION admin.audit_digest(p_prev bytea, p_id bigint, p_at timestamptz, p_actor text, p_action text, p_detail jsonb)
RETURNS bytea LANGUAGE sql STABLE SET search_path = pg_catalog, admin AS $$
  SELECT sha256(p_prev || convert_to('pt-admin-audit-v1' || jsonb_build_array(p_id, admin.utc(p_at), p_actor, p_action, p_detail)::text, 'UTF8'))
$$;

/** Internal: appends one entry. Granted to nobody; the API functions call it. */
CREATE FUNCTION admin.audit_append(p_actor text, p_action text, p_detail jsonb)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_prev bytea;
  v_id bigint;
  v_at timestamptz := date_trunc('microseconds', clock_timestamp());
BEGIN
  PERFORM pg_advisory_xact_lock(586586100);
  SELECT hash INTO v_prev FROM admin.audit ORDER BY id DESC LIMIT 1;
  v_prev := coalesce(v_prev, decode(repeat('00', 32), 'hex'));
  v_id := nextval(pg_get_serial_sequence('admin.audit', 'id'));
  INSERT INTO admin.audit (id, at, actor, action, detail, prev_hash, hash)
  OVERRIDING SYSTEM VALUE
  VALUES (v_id, v_at, left(p_actor, 100), p_action, coalesce(p_detail, '{}'::jsonb), v_prev,
          admin.audit_digest(v_prev, v_id, v_at, left(p_actor, 100), p_action, coalesce(p_detail, '{}'::jsonb)));
  RETURN v_id;
END $$;

-- ================================================================== roles, permissions, conflicts (P-2)
CREATE TABLE admin.roles (
  role        text PRIMARY KEY CHECK (role ~ '^[a-z][a-z_]{2,31}$'),
  description text NOT NULL CHECK (length(description) BETWEEN 5 AND 200)
);
INSERT INTO admin.roles (role, description) VALUES
  ('ops_maker', 'Operations: prepares money and token actions (maker)'),
  ('ops_checker', 'Operations: approves actions prepared by someone else (checker)'),
  ('compliance_officer', 'Compliance: KYC reviews, sanctions, freezes, FMU reports'),
  ('trustee_officer', 'Independent trustee: register, co-signing, distribution review'),
  ('auditor', 'Internal or external auditor: read-only, exports evidence'),
  ('admin', 'Manages officers and roles only; never approves money or token actions');

CREATE TABLE admin.role_conflicts (
  a      text NOT NULL REFERENCES admin.roles,
  b      text NOT NULL REFERENCES admin.roles,
  reason text NOT NULL CHECK (length(reason) BETWEEN 5 AND 200),
  PRIMARY KEY (a, b),
  CHECK (a < b)
);
INSERT INTO admin.role_conflicts (a, b, reason) VALUES
  ('ops_checker', 'ops_maker', 'maker-checker: whoever prepares an action never approves it'),
  ('ops_maker', 'trustee_officer', 'trustee officers belong to the independent trustee and hold no platform role'),
  ('ops_checker', 'trustee_officer', 'trustee officers belong to the independent trustee and hold no platform role'),
  ('compliance_officer', 'trustee_officer', 'trustee officers belong to the independent trustee and hold no platform role'),
  ('admin', 'trustee_officer', 'trustee officers belong to the independent trustee and hold no platform role'),
  ('auditor', 'trustee_officer', 'auditors are read-only and independent of everyone they audit'),
  ('auditor', 'ops_maker', 'auditors are read-only and independent of everyone they audit'),
  ('auditor', 'ops_checker', 'auditors are read-only and independent of everyone they audit'),
  ('auditor', 'compliance_officer', 'auditors are read-only and independent of everyone they audit'),
  ('admin', 'auditor', 'auditors are read-only and independent of everyone they audit'),
  ('admin', 'ops_maker', 'administrators manage officers only and never prepare or approve money or token actions'),
  ('admin', 'ops_checker', 'administrators manage officers only and never prepare or approve money or token actions'),
  ('admin', 'compliance_officer', 'administrators manage officers only and never take compliance decisions'),
  ('compliance_officer', 'ops_maker', 'compliance reviews operations and never initiates money or token actions');

CREATE TABLE admin.role_permissions (
  role       text NOT NULL REFERENCES admin.roles,
  permission text NOT NULL CHECK (permission ~ '^[a-z]+(\.[a-z]+)+$'),
  PRIMARY KEY (role, permission)
);
INSERT INTO admin.role_permissions (role, permission) VALUES
  ('ops_maker', 'ops.read'), ('ops_checker', 'ops.read'), ('compliance_officer', 'ops.read'), ('auditor', 'ops.read'),
  ('ops_maker', 'audit.read.ops'), ('ops_checker', 'audit.read.ops'), ('compliance_officer', 'audit.read.ops'), ('auditor', 'audit.read.ops'),
  ('admin', 'audit.read.admin'), ('compliance_officer', 'audit.read.admin'), ('auditor', 'audit.read.admin'),
  ('compliance_officer', 'audit.export'), ('auditor', 'audit.export'),
  ('admin', 'officers.read'), ('auditor', 'officers.read'),
  ('admin', 'officers.manage'),
  ('ops_maker', 'approvals.read'), ('ops_checker', 'approvals.read'),
  ('compliance_officer', 'compliance.read'), ('auditor', 'compliance.read'),
  ('trustee_officer', 'trustee.read'), ('auditor', 'trustee.read');

CREATE TRIGGER roles_append_only BEFORE UPDATE OR DELETE ON admin.roles FOR EACH ROW EXECUTE FUNCTION admin.forbid_change();
CREATE TRIGGER role_conflicts_append_only BEFORE UPDATE OR DELETE ON admin.role_conflicts FOR EACH ROW EXECUTE FUNCTION admin.forbid_change();
CREATE TRIGGER role_permissions_append_only BEFORE UPDATE OR DELETE ON admin.role_permissions FOR EACH ROW EXECUTE FUNCTION admin.forbid_change();
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['roles', 'role_conflicts', 'role_permissions'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON admin.%I FOR EACH STATEMENT EXECUTE FUNCTION admin.forbid_change()', t || '_no_truncate', t);
  END LOOP;
END $$;

/** Digest of the whole role matrix; admin.verify_audit() compares it with the value fixed below. */
CREATE FUNCTION admin.role_matrix_digest() RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog, admin AS $$
  SELECT encode(sha256(convert_to(jsonb_build_array(
    (SELECT jsonb_agg(jsonb_build_array(role, description) ORDER BY role) FROM admin.roles),
    (SELECT jsonb_agg(jsonb_build_array(a, b) ORDER BY a, b) FROM admin.role_conflicts),
    (SELECT jsonb_agg(jsonb_build_array(role, permission) ORDER BY role, permission) FROM admin.role_permissions)
  )::text, 'UTF8')), 'hex')
$$;
-- Fixed at migration time: a later change to the matrix needs a migration that replaces this function.
DO $$
BEGIN
  EXECUTE format('CREATE FUNCTION admin.expected_role_matrix_digest() RETURNS text LANGUAGE sql IMMUTABLE AS %L',
                 format('SELECT %L::text', admin.role_matrix_digest()));
END $$;

-- ================================================================== officers (P-1)
CREATE TABLE admin.changes (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind            text NOT NULL CHECK (kind IN ('invite', 'grant', 'revoke', 'disable')),
  officer_id      uuid,
  role            text REFERENCES admin.roles,
  new_handle      text CHECK (new_handle ~ '^[a-z][a-z0-9._-]{2,39}$'),
  new_name        text CHECK (length(new_name) BETWEEN 2 AND 80 AND new_name ~ '^[[:alpha:]][[:alpha:] .''-]*$'),
  reason          text NOT NULL CHECK (length(reason) BETWEEN 10 AND 500),
  requested_by    uuid NOT NULL,
  requested_at    timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  -- Set by admin.change_expiry() to requested_at + 24 hours.
  expires_at      timestamptz NOT NULL,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'approved', 'rejected', 'expired')),
  decided_by      uuid,
  decision_reason text CHECK (length(decision_reason) BETWEEN 10 AND 500),
  decided_at      timestamptz,
  result_officer  uuid,
  CHECK (expires_at = requested_at + interval '24 hours'),
  -- Maker-checker, also against a direct UPDATE.
  CHECK (decided_by IS NULL OR decided_by <> requested_by),
  CHECK ((status = 'open') = (decided_at IS NULL)),
  CHECK ((status IN ('approved', 'rejected')) = (decided_by IS NOT NULL AND decision_reason IS NOT NULL)),
  CHECK (kind <> 'invite' OR (officer_id IS NULL AND role IS NOT NULL AND new_handle IS NOT NULL AND new_name IS NOT NULL)),
  CHECK (kind = 'invite' OR (officer_id IS NOT NULL AND new_handle IS NULL AND new_name IS NULL)),
  CHECK (kind NOT IN ('grant', 'revoke') OR role IS NOT NULL),
  CHECK (kind <> 'disable' OR role IS NULL),
  CHECK (officer_id IS NULL OR officer_id <> requested_by),
  CHECK ((status = 'approved' AND kind = 'invite') = (result_officer IS NOT NULL))
);
CREATE FUNCTION admin.change_expiry() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.expires_at := NEW.requested_at + interval '24 hours';
  RETURN NEW;
END $$;
CREATE TRIGGER changes_expiry BEFORE INSERT ON admin.changes FOR EACH ROW EXECUTE FUNCTION admin.change_expiry();
CREATE UNIQUE INDEX changes_one_open ON admin.changes (kind, coalesce(officer_id::text, new_handle), coalesce(role, '')) WHERE status = 'open';

CREATE TABLE admin.officers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  handle        text NOT NULL UNIQUE CHECK (handle ~ '^[a-z][a-z0-9._-]{2,39}$'),
  display_name  text NOT NULL CHECK (length(display_name) BETWEEN 2 AND 80 AND display_name ~ '^[[:alpha:]][[:alpha:] .''-]*$'),
  status        text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'active', 'disabled')),
  -- 1 or 2 for the bootstrap administrators (no checker exists yet); NULL for everyone else.
  bootstrap_seq smallint UNIQUE CHECK (bootstrap_seq IN (1, 2)),
  change_id     bigint UNIQUE REFERENCES admin.changes (id),
  created_at    timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  created_by    text NOT NULL CHECK (length(created_by) BETWEEN 1 AND 100),
  enrolled_at   timestamptz,
  disabled_at   timestamptz,
  CHECK ((bootstrap_seq IS NULL) <> (change_id IS NULL)),
  CHECK ((status = 'invited') = (enrolled_at IS NULL) OR status = 'disabled'),
  CHECK ((status = 'disabled') = (disabled_at IS NOT NULL))
);
ALTER TABLE admin.changes ADD FOREIGN KEY (officer_id) REFERENCES admin.officers (id);
ALTER TABLE admin.changes ADD FOREIGN KEY (requested_by) REFERENCES admin.officers (id);
ALTER TABLE admin.changes ADD FOREIGN KEY (decided_by) REFERENCES admin.officers (id);
ALTER TABLE admin.changes ADD FOREIGN KEY (result_officer) REFERENCES admin.officers (id);

CREATE FUNCTION admin.guard_officer() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'officers are never deleted' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF (NEW.id, NEW.handle, NEW.display_name, NEW.bootstrap_seq, NEW.change_id, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM (OLD.id, OLD.handle, OLD.display_name, OLD.bootstrap_seq, OLD.change_id, OLD.created_at, OLD.created_by)
     OR (OLD.enrolled_at IS NOT NULL AND NEW.enrolled_at IS DISTINCT FROM OLD.enrolled_at)
     OR (OLD.status <> NEW.status AND (OLD.status || '>' || NEW.status) NOT IN ('invited>active', 'invited>disabled', 'active>disabled')) THEN
    RAISE EXCEPTION 'officer %: only invited>active>disabled is allowed', OLD.handle USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER officers_guard BEFORE UPDATE OR DELETE ON admin.officers FOR EACH ROW EXECUTE FUNCTION admin.guard_officer();

CREATE FUNCTION admin.guard_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'officer changes are never deleted' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF OLD.status <> 'open'
     OR (NEW.id, NEW.kind, NEW.officer_id, NEW.role, NEW.new_handle, NEW.new_name, NEW.reason, NEW.requested_by, NEW.requested_at, NEW.expires_at)
        IS DISTINCT FROM (OLD.id, OLD.kind, OLD.officer_id, OLD.role, OLD.new_handle, OLD.new_name, OLD.reason, OLD.requested_by, OLD.requested_at, OLD.expires_at) THEN
    RAISE EXCEPTION 'officer change % can only be decided once', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER changes_guard BEFORE UPDATE OR DELETE ON admin.changes FOR EACH ROW EXECUTE FUNCTION admin.guard_change();

-- ================================================================== role grants (P-2)
CREATE TABLE admin.role_grants (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  officer_id     uuid NOT NULL REFERENCES admin.officers (id),
  role           text NOT NULL REFERENCES admin.roles,
  granted_at     timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  -- NULL only for the admin role of a bootstrap administrator.
  granted_change bigint REFERENCES admin.changes (id),
  revoked_at     timestamptz,
  revoked_change bigint REFERENCES admin.changes (id),
  CHECK ((revoked_at IS NULL) = (revoked_change IS NULL))
);
CREATE UNIQUE INDEX role_grants_current ON admin.role_grants (officer_id, role) WHERE revoked_at IS NULL;

/** P-2: refuses a grant that conflicts with a current role, or a grant without an approved change. */
CREATE FUNCTION admin.check_grant() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, admin AS $$
DECLARE
  o admin.officers;
  v_conflict text;
BEGIN
  -- Serialises grants per officer, so two concurrent conflicting grants cannot both pass.
  SELECT * INTO o FROM admin.officers WHERE id = NEW.officer_id FOR UPDATE;
  IF o.status = 'disabled' THEN
    RAISE EXCEPTION 'officer % is disabled', o.handle USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.granted_change IS NULL AND NOT (o.bootstrap_seq IS NOT NULL AND NEW.role = 'admin') THEN
    RAISE EXCEPTION 'a role is granted only through an approved change (bootstrap administrators excepted)' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.granted_change IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM admin.changes c WHERE c.id = NEW.granted_change AND c.status = 'approved' AND c.role = NEW.role
         AND ((c.kind = 'grant' AND c.officer_id = NEW.officer_id) OR (c.kind = 'invite' AND c.result_officer = NEW.officer_id))) THEN
    RAISE EXCEPTION 'grant does not match an approved change' USING ERRCODE = 'check_violation';
  END IF;
  SELECT g.role || ' + ' || NEW.role || ': ' || c.reason INTO v_conflict
  FROM admin.role_grants g
  JOIN admin.role_conflicts c ON c.a = least(g.role, NEW.role) AND c.b = greatest(g.role, NEW.role)
  WHERE g.officer_id = NEW.officer_id AND g.revoked_at IS NULL
  LIMIT 1;
  IF v_conflict IS NOT NULL THEN
    RAISE EXCEPTION 'segregation of duties: % cannot hold %', o.handle, v_conflict USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER role_grants_check BEFORE INSERT ON admin.role_grants FOR EACH ROW EXECUTE FUNCTION admin.check_grant();

CREATE FUNCTION admin.guard_grant() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'role grants are never deleted' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL
     OR (NEW.id, NEW.officer_id, NEW.role, NEW.granted_at, NEW.granted_change)
        IS DISTINCT FROM (OLD.id, OLD.officer_id, OLD.role, OLD.granted_at, OLD.granted_change) THEN
    RAISE EXCEPTION 'role grant % can only be revoked, once', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER role_grants_guard BEFORE UPDATE OR DELETE ON admin.role_grants FOR EACH ROW EXECUTE FUNCTION admin.guard_grant();

-- ================================================================== credentials (P-1)
CREATE TABLE admin.credentials (
  id           text PRIMARY KEY CHECK (length(id) BETWEEN 16 AND 1366 AND id ~ '^[A-Za-z0-9_-]+$'),
  officer_id   uuid NOT NULL REFERENCES admin.officers (id),
  public_key   bytea NOT NULL CHECK (length(public_key) BETWEEN 16 AND 2048),
  counter      bigint NOT NULL CHECK (counter >= 0),
  transports   text[] NOT NULL DEFAULT '{}' CHECK (cardinality(transports) <= 8),
  aaguid       uuid NOT NULL,
  fmt          text NOT NULL CHECK (fmt ~ '^[a-z][a-z0-9-]{1,31}$'),
  -- NIST AAL3 needs a hardware-bound authenticator: synced passkeys (backed up, multi-device) are refused.
  device_type  text NOT NULL CHECK (device_type = 'singleDevice'),
  backed_up    boolean NOT NULL CHECK (NOT backed_up),
  created_at   timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  last_used_at timestamptz,
  disabled_at  timestamptz
);
CREATE INDEX credentials_officer_idx ON admin.credentials (officer_id);

CREATE FUNCTION admin.guard_credential() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'credentials are never deleted' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF (NEW.id, NEW.officer_id, NEW.public_key, NEW.transports, NEW.aaguid, NEW.fmt, NEW.device_type, NEW.backed_up, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.officer_id, OLD.public_key, OLD.transports, OLD.aaguid, OLD.fmt, OLD.device_type, OLD.backed_up, OLD.created_at)
     OR NEW.counter < OLD.counter
     OR (OLD.disabled_at IS NOT NULL AND NEW.disabled_at IS DISTINCT FROM OLD.disabled_at) THEN
    RAISE EXCEPTION 'credential %: only the counter (forward), last use and disabling may change', left(OLD.id, 12) USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER credentials_guard BEFORE UPDATE OR DELETE ON admin.credentials FOR EACH ROW EXECUTE FUNCTION admin.guard_credential();

-- ================================================================== enrolment tokens (P-5)
CREATE TABLE admin.enrolments (
  token_hash bytea PRIMARY KEY CHECK (length(token_hash) = 32),
  officer_id uuid NOT NULL REFERENCES admin.officers (id),
  issued_at  timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  expires_at timestamptz NOT NULL,
  issued_by  text NOT NULL CHECK (length(issued_by) BETWEEN 1 AND 100),
  used_at    timestamptz,
  revoked_at timestamptz,
  CHECK (expires_at > issued_at AND expires_at <= issued_at + interval '30 minutes'),
  CHECK (used_at IS NULL OR revoked_at IS NULL)
);
CREATE INDEX enrolments_officer_idx ON admin.enrolments (officer_id);

CREATE FUNCTION admin.guard_enrolment() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'enrolment tokens are never deleted' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF OLD.used_at IS NOT NULL OR OLD.revoked_at IS NOT NULL
     OR (NEW.token_hash, NEW.officer_id, NEW.issued_at, NEW.expires_at, NEW.issued_by)
        IS DISTINCT FROM (OLD.token_hash, OLD.officer_id, OLD.issued_at, OLD.expires_at, OLD.issued_by) THEN
    RAISE EXCEPTION 'enrolment token can only be used or revoked, once' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER enrolments_guard BEFORE UPDATE OR DELETE ON admin.enrolments FOR EACH ROW EXECUTE FUNCTION admin.guard_enrolment();

-- ================================================================== sessions (P-4)
CREATE TABLE admin.sessions (
  token_hash      bytea PRIMARY KEY CHECK (length(token_hash) = 32),
  officer_id      uuid NOT NULL REFERENCES admin.officers (id),
  credential_id   text NOT NULL REFERENCES admin.credentials (id),
  created_at      timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  last_seen_at    timestamptz NOT NULL DEFAULT date_trunc('microseconds', clock_timestamp()),
  expires_at      timestamptz NOT NULL,
  step_up_at      timestamptz,
  step_up_credential text REFERENCES admin.credentials (id),
  ended_at        timestamptz,
  end_reason      text CHECK (end_reason IN ('logout', 'idle', 'absolute', 'superseded', 'officer_disabled')),
  CHECK (expires_at = created_at + interval '8 hours'),
  CHECK ((ended_at IS NULL) = (end_reason IS NULL)),
  CHECK ((step_up_at IS NULL) = (step_up_credential IS NULL))
);
CREATE UNIQUE INDEX sessions_one_live ON admin.sessions (officer_id) WHERE ended_at IS NULL;

CREATE FUNCTION admin.guard_session() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'sessions are never deleted' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF OLD.ended_at IS NOT NULL
     OR (NEW.token_hash, NEW.officer_id, NEW.credential_id, NEW.created_at, NEW.expires_at)
        IS DISTINCT FROM (OLD.token_hash, OLD.officer_id, OLD.credential_id, OLD.created_at, OLD.expires_at)
     OR NEW.last_seen_at < OLD.last_seen_at
     OR (OLD.step_up_at IS NOT NULL AND NEW.step_up_at < OLD.step_up_at) THEN
    RAISE EXCEPTION 'session: only last use, step-up (forward) and ending (once) may change' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sessions_guard BEFORE UPDATE OR DELETE ON admin.sessions FOR EACH ROW EXECUTE FUNCTION admin.guard_session();

-- ================================================================== WebAuthn challenges (P-6)
CREATE TABLE admin.challenges (
  id_hash      bytea PRIMARY KEY CHECK (length(id_hash) = 32),
  purpose      text NOT NULL CHECK (purpose IN ('enrol', 'login', 'step_up')),
  challenge    text NOT NULL CHECK (challenge ~ '^[A-Za-z0-9_-]{32,128}$'),
  enrol_token  bytea REFERENCES admin.enrolments (token_hash),
  session_hash bytea REFERENCES admin.sessions (token_hash),
  -- Both set from one clock reading by admin.create_challenge (two defaults would differ by microseconds).
  created_at   timestamptz NOT NULL,
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz,
  CHECK (expires_at <= created_at + interval '5 minutes'),
  CHECK ((purpose = 'enrol') = (enrol_token IS NOT NULL)),
  CHECK ((purpose = 'step_up') = (session_hash IS NOT NULL))
);

-- ================================================================== session checks (P-4, P-8)
CREATE TYPE admin.session_info AS (
  officer_id   uuid,
  handle       text,
  display_name text,
  roles        text[],
  permissions  text[],
  created_at   timestamptz,
  expires_at   timestamptz,
  idle_until   timestamptz,
  step_up_at   timestamptz,
  allowed      boolean
);

/** Internal: ends a session that is past a limit or whose officer is no longer active. */
CREATE FUNCTION admin.expire_if_needed(s admin.sessions) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_reason text;
BEGIN
  IF s.ended_at IS NOT NULL THEN RETURN true; END IF;
  IF clock_timestamp() >= s.expires_at THEN v_reason := 'absolute';
  ELSIF clock_timestamp() >= s.last_seen_at + admin.idle_limit() THEN v_reason := 'idle';
  ELSIF (SELECT status FROM admin.officers WHERE id = s.officer_id) <> 'active' THEN v_reason := 'officer_disabled';
  ELSE RETURN false;
  END IF;
  UPDATE admin.sessions SET ended_at = clock_timestamp(), end_reason = v_reason WHERE token_hash = s.token_hash AND ended_at IS NULL;
  PERFORM admin.audit_append(s.officer_id::text, 'session.expired', jsonb_build_object('session', left(encode(s.token_hash, 'hex'), 16), 'reason', v_reason));
  RETURN true;
END $$;

CREATE FUNCTION admin.info_of(s admin.sessions, p_allowed boolean) RETURNS admin.session_info
LANGUAGE sql STABLE SET search_path = pg_catalog, admin AS $$
  SELECT ROW(o.id, o.handle, o.display_name,
             coalesce((SELECT array_agg(g.role ORDER BY g.role) FROM admin.role_grants g WHERE g.officer_id = o.id AND g.revoked_at IS NULL), '{}'),
             coalesce((SELECT array_agg(DISTINCT p.permission ORDER BY p.permission) FROM admin.role_grants g
                       JOIN admin.role_permissions p ON p.role = g.role WHERE g.officer_id = o.id AND g.revoked_at IS NULL), '{}'),
             s.created_at, s.expires_at, s.last_seen_at + admin.idle_limit(), s.step_up_at, p_allowed)::admin.session_info
  FROM admin.officers o WHERE o.id = s.officer_id
$$;

/**
 * The portal calls this once per request: validates the session (ending it at a limit), records
 * the activity, checks p_permission (NULL = any officer) and audits a denial of p_resource, or a
 * view of it when p_log_view. Returns no row when there is no valid session.
 */
CREATE FUNCTION admin.authorize(p_session bytea, p_permission text, p_resource text, p_log_view boolean)
RETURNS SETOF admin.session_info LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  s admin.sessions;
  i admin.session_info;
BEGIN
  SELECT * INTO s FROM admin.sessions WHERE token_hash = p_session FOR UPDATE;
  IF NOT FOUND OR admin.expire_if_needed(s) THEN RETURN; END IF;
  UPDATE admin.sessions SET last_seen_at = greatest(last_seen_at, date_trunc('microseconds', clock_timestamp())) WHERE token_hash = s.token_hash
  RETURNING * INTO s;
  i := admin.info_of(s, true);
  IF p_permission IS NOT NULL AND NOT (p_permission = ANY (i.permissions)) THEN
    i.allowed := false;
    PERFORM admin.audit_append(s.officer_id::text, 'access.denied',
      jsonb_build_object('permission', p_permission, 'resource', left(coalesce(p_resource, ''), 200), 'roles', to_jsonb(i.roles)));
  ELSIF p_log_view AND p_resource IS NOT NULL THEN
    PERFORM admin.audit_append(s.officer_id::text, 'page.view', jsonb_build_object('resource', left(p_resource, 200)));
  END IF;
  RETURN NEXT i;
END $$;

/** Internal: whether the officer behind this session currently holds p_permission (validity not checked). */
CREATE FUNCTION admin.has_permission(p_session bytea, p_permission text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
  SELECT EXISTS (SELECT 1 FROM admin.sessions s JOIN admin.role_grants g ON g.officer_id = s.officer_id AND g.revoked_at IS NULL
                 JOIN admin.role_permissions p ON p.role = g.role
                 WHERE s.token_hash = p_session AND p.permission = p_permission)
$$;

/** Internal: the officer behind a valid session that holds p_permission, or an error (P-8). */
CREATE FUNCTION admin.require(p_session bytea, p_permission text) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  s admin.sessions;
BEGIN
  SELECT * INTO s FROM admin.sessions WHERE token_hash = p_session;
  IF NOT FOUND OR s.ended_at IS NOT NULL OR clock_timestamp() >= s.expires_at OR clock_timestamp() >= s.last_seen_at + admin.idle_limit()
     OR (SELECT status FROM admin.officers WHERE id = s.officer_id) <> 'active' THEN
    RAISE EXCEPTION 'no valid officer session' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_permission IS NOT NULL AND NOT admin.has_permission(p_session, p_permission) THEN
    RAISE EXCEPTION 'permission % is not held', p_permission USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN s.officer_id;
END $$;

/**
 * Step-up (P-3): raises PTS01 unless the session's last WebAuthn assertion is younger than five
 * minutes. Every approval function calls this inside its own transaction.
 */
CREATE FUNCTION admin.require_step_up(p_session bytea) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_officer uuid := admin.require(p_session, NULL);
  v_at timestamptz;
BEGIN
  SELECT step_up_at INTO v_at FROM admin.sessions WHERE token_hash = p_session;
  IF v_at IS NULL OR clock_timestamp() >= v_at + admin.step_up_window() THEN
    RAISE EXCEPTION 'step-up required: confirm with your security key (valid for 5 minutes)' USING ERRCODE = 'PTS01';
  END IF;
  RETURN v_officer;
END $$;

CREATE FUNCTION admin.end_session(p_session bytea, p_reason text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  s admin.sessions;
BEGIN
  IF p_reason <> 'logout' THEN RAISE EXCEPTION 'only logout ends a session on request' USING ERRCODE = 'check_violation'; END IF;
  SELECT * INTO s FROM admin.sessions WHERE token_hash = p_session FOR UPDATE;
  IF NOT FOUND OR s.ended_at IS NOT NULL THEN RETURN false; END IF;
  UPDATE admin.sessions SET ended_at = clock_timestamp(), end_reason = 'logout' WHERE token_hash = p_session;
  PERFORM admin.audit_append(s.officer_id::text, 'logout', jsonb_build_object('session', left(encode(p_session, 'hex'), 16)));
  RETURN true;
END $$;

-- ================================================================== WebAuthn ceremonies (P-1, P-4, P-6)
/** Stores a challenge. Step-up challenges need a valid session, enrolment challenges a valid token. */
CREATE FUNCTION admin.create_challenge(p_id_hash bytea, p_purpose text, p_challenge text, p_enrol_token bytea, p_session bytea)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
BEGIN
  IF p_purpose = 'step_up' THEN PERFORM admin.require(p_session, NULL); END IF;
  IF p_purpose = 'enrol' AND NOT EXISTS (SELECT 1 FROM admin.enrolment_officer(p_enrol_token)) THEN
    RAISE EXCEPTION 'enrolment link is not valid' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Housekeeping: challenges are short-lived and carry nothing worth keeping.
  DELETE FROM admin.challenges WHERE expires_at < clock_timestamp() - interval '1 day';
  INSERT INTO admin.challenges (id_hash, purpose, challenge, created_at, expires_at, enrol_token, session_hash)
  VALUES (p_id_hash, p_purpose, p_challenge, v_now, v_now + interval '5 minutes',
          CASE WHEN p_purpose = 'enrol' THEN p_enrol_token END,
          CASE WHEN p_purpose = 'step_up' THEN p_session END);
END $$;

/** Uses a challenge once: returns it only if it exists, is unused, unexpired and of this purpose and binding. */
CREATE FUNCTION admin.consume_challenge(p_id_hash bytea, p_purpose text, p_enrol_token bytea, p_session bytea)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v text;
BEGIN
  UPDATE admin.challenges SET used_at = clock_timestamp()
  WHERE id_hash = p_id_hash AND purpose = p_purpose AND used_at IS NULL AND expires_at > clock_timestamp()
    AND enrol_token IS NOT DISTINCT FROM CASE WHEN p_purpose = 'enrol' THEN p_enrol_token END
    AND session_hash IS NOT DISTINCT FROM CASE WHEN p_purpose = 'step_up' THEN p_session END
  RETURNING challenge INTO v;
  RETURN v;
END $$;

/** The officer an enrolment token belongs to, if the token can still be used. */
CREATE FUNCTION admin.enrolment_officer(p_token_hash bytea)
RETURNS TABLE (officer_id uuid, handle text, display_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
  SELECT o.id, o.handle, o.display_name
  FROM admin.enrolments e JOIN admin.officers o ON o.id = e.officer_id
  WHERE e.token_hash = p_token_hash AND e.used_at IS NULL AND e.revoked_at IS NULL AND e.expires_at > clock_timestamp()
    AND o.status = 'invited' AND NOT EXISTS (SELECT 1 FROM admin.credentials c WHERE c.officer_id = o.id)
$$;

/**
 * Completes an enrolment: stores the verified credential, uses the token, activates the officer.
 * Refusals return NULL after auditing them (an exception would roll the audit entry back).
 */
CREATE FUNCTION admin.complete_enrolment(p_token_hash bytea, p_credential_id text, p_public_key bytea, p_counter bigint,
                                         p_transports text[], p_aaguid uuid, p_fmt text, p_device_type text, p_backed_up boolean,
                                         p_user_verified boolean)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  e admin.enrolments;
  o admin.officers;
BEGIN
  SELECT * INTO e FROM admin.enrolments WHERE token_hash = p_token_hash FOR UPDATE;
  IF NOT FOUND OR e.used_at IS NOT NULL OR e.revoked_at IS NOT NULL OR e.expires_at <= clock_timestamp() THEN
    PERFORM admin.audit_append(coalesce(e.officer_id::text, 'anonymous'), 'enrol.failed', jsonb_build_object('reason', 'link not valid, used, revoked or expired'));
    RETURN NULL;
  END IF;
  SELECT * INTO o FROM admin.officers WHERE id = e.officer_id FOR UPDATE;
  IF o.status <> 'invited' OR EXISTS (SELECT 1 FROM admin.credentials WHERE officer_id = o.id) THEN
    PERFORM admin.audit_append(o.id::text, 'enrol.failed', jsonb_build_object('reason', 'officer not waiting for enrolment'));
    RETURN NULL;
  END IF;
  IF NOT coalesce(p_user_verified, false) THEN
    PERFORM admin.audit_append(o.id::text, 'enrol.failed', jsonb_build_object('reason', 'user not verified (PIN or biometric required)'));
    RETURN NULL;
  END IF;
  IF p_device_type IS DISTINCT FROM 'singleDevice' OR p_backed_up IS DISTINCT FROM false THEN
    PERFORM admin.audit_append(o.id::text, 'enrol.failed', jsonb_build_object('reason', 'synced passkey refused (device-bound key required)'));
    RETURN NULL;
  END IF;
  INSERT INTO admin.credentials (id, officer_id, public_key, counter, transports, aaguid, fmt, device_type, backed_up)
  VALUES (p_credential_id, o.id, p_public_key, p_counter, coalesce(p_transports, '{}'), p_aaguid, p_fmt, p_device_type, p_backed_up);
  UPDATE admin.enrolments SET used_at = clock_timestamp() WHERE token_hash = p_token_hash;
  UPDATE admin.officers SET status = 'active', enrolled_at = clock_timestamp() WHERE id = o.id;
  PERFORM admin.audit_append(o.id::text, 'enrol.completed', jsonb_build_object(
    'officer', o.id, 'handle', o.handle, 'credential', p_credential_id, 'publicKeySha256', encode(sha256(p_public_key), 'hex'),
    'aaguid', p_aaguid, 'fmt', p_fmt));
  RETURN o.id;
END $$;

/** Records a failed ceremony (bad signature, wrong origin, unknown key...) without personal data. */
CREATE FUNCTION admin.auth_failed(p_kind text, p_reason text, p_credential_id text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_officer uuid;
BEGIN
  IF p_kind NOT IN ('login', 'enrol', 'stepup') THEN RAISE EXCEPTION 'unknown ceremony' USING ERRCODE = 'check_violation'; END IF;
  SELECT officer_id INTO v_officer FROM admin.credentials WHERE id = p_credential_id;
  PERFORM admin.audit_append(coalesce(v_officer::text, 'anonymous'), p_kind || '.failed',
    jsonb_build_object('reason', left(coalesce(p_reason, ''), 200), 'credential', left(coalesce(p_credential_id, ''), 64)));
END $$;

/** The stored credential for an assertion (login or step-up); nothing for an unusable one. */
CREATE FUNCTION admin.credential_for_login(p_credential_id text)
RETURNS TABLE (officer_id uuid, public_key bytea, counter bigint, transports text[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
  SELECT c.officer_id, c.public_key, c.counter, c.transports
  FROM admin.credentials c JOIN admin.officers o ON o.id = c.officer_id
  WHERE c.id = p_credential_id AND c.disabled_at IS NULL AND o.status = 'active'
$$;

/** Credentials a session's officer may use for a step-up (allowCredentials). */
CREATE FUNCTION admin.session_credentials(p_session bytea)
RETURNS TABLE (id text, transports text[])
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
#variable_conflict use_column
DECLARE
  v_me uuid := admin.require(p_session, NULL);
BEGIN
  RETURN QUERY SELECT c.id, c.transports FROM admin.credentials c WHERE c.officer_id = v_me AND c.disabled_at IS NULL ORDER BY c.created_at;
END $$;

/**
 * Internal: moves a credential's signature counter forward (clone detection, WebAuthn 6.1.1).
 * Returns the officer, or NULL (audited and alerted) for a disabled key or a counter that did not move.
 */
CREATE FUNCTION admin.use_credential(p_credential_id text, p_new_counter bigint, p_kind text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  c admin.credentials;
BEGIN
  SELECT * INTO c FROM admin.credentials WHERE id = p_credential_id FOR UPDATE;
  IF NOT FOUND OR c.disabled_at IS NOT NULL THEN
    PERFORM admin.audit_append(coalesce(c.officer_id::text, 'anonymous'), p_kind || '.failed', jsonb_build_object('reason', 'credential unknown or disabled'));
    RETURN NULL;
  END IF;
  -- A counter that does not increase (other than an authenticator without a counter: both zero)
  -- means a cloned authenticator: refuse and alert.
  IF NOT (p_new_counter > c.counter OR (p_new_counter = 0 AND c.counter = 0)) THEN
    PERFORM admin.audit_append(c.officer_id::text, p_kind || '.counter_regression',
      jsonb_build_object('credential', left(c.id, 64), 'stored', c.counter, 'presented', p_new_counter));
    PERFORM pg_notify('admin_alert', json_build_object('alert', 'counter_regression', 'officer', c.officer_id)::text);
    RETURN NULL;
  END IF;
  UPDATE admin.credentials SET counter = p_new_counter, last_used_at = clock_timestamp() WHERE id = c.id;
  RETURN c.officer_id;
END $$;

/**
 * Starts a session after the portal verified a login assertion (challenge consumed first). Ends
 * any other live session of the officer; the login itself counts as a fresh step-up. Returns NULL
 * (audited) when the officer is not active or the key is unusable or possibly cloned.
 */
CREATE FUNCTION admin.start_session(p_token_hash bytea, p_credential_id text, p_new_counter bigint)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_officer uuid;
  o admin.officers;
  v_now timestamptz := date_trunc('microseconds', clock_timestamp());
  n integer;
BEGIN
  SELECT x.* INTO o FROM admin.officers x JOIN admin.credentials c ON c.officer_id = x.id WHERE c.id = p_credential_id FOR UPDATE OF x;
  IF NOT FOUND OR o.status <> 'active' THEN
    PERFORM admin.audit_append(coalesce(o.id::text, 'anonymous'), 'login.failed', jsonb_build_object('reason', 'officer not active', 'credential', left(coalesce(p_credential_id, ''), 64)));
    RETURN NULL;
  END IF;
  v_officer := admin.use_credential(p_credential_id, p_new_counter, 'login');
  IF v_officer IS NULL THEN RETURN NULL; END IF;
  UPDATE admin.sessions SET ended_at = v_now, end_reason = 'superseded' WHERE officer_id = v_officer AND ended_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  INSERT INTO admin.sessions (token_hash, officer_id, credential_id, created_at, last_seen_at, expires_at, step_up_at, step_up_credential)
  VALUES (p_token_hash, v_officer, p_credential_id, v_now, v_now, v_now + admin.absolute_limit(), v_now, p_credential_id);
  PERFORM admin.audit_append(v_officer::text, 'login.success', jsonb_build_object(
    'session', left(encode(p_token_hash, 'hex'), 16), 'credential', left(p_credential_id, 64), 'superseded', n));
  RETURN v_officer;
END $$;

/**
 * Records a verified step-up assertion on the session (the credential must be the officer's own).
 * Returns the step-up time, or NULL (audited) when refused.
 */
CREATE FUNCTION admin.record_step_up(p_session bytea, p_credential_id text, p_new_counter bigint)
RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_officer uuid := admin.require(p_session, NULL);
  v_now timestamptz := date_trunc('microseconds', clock_timestamp());
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admin.credentials WHERE id = p_credential_id AND officer_id = v_officer) THEN
    PERFORM admin.audit_append(v_officer::text, 'stepup.failed', jsonb_build_object('reason', 'credential of another officer'));
    RETURN NULL;
  END IF;
  IF admin.use_credential(p_credential_id, p_new_counter, 'stepup') IS NULL THEN RETURN NULL; END IF;
  UPDATE admin.sessions SET step_up_at = v_now, step_up_credential = p_credential_id, last_seen_at = greatest(last_seen_at, v_now)
  WHERE token_hash = p_session;
  PERFORM admin.audit_append(v_officer::text, 'stepup.success', jsonb_build_object('session', left(encode(p_session, 'hex'), 16), 'credential', left(p_credential_id, 64)));
  RETURN v_now;
END $$;

-- ================================================================== bootstrap and enrolment links (CLI, P-3, P-5)
/**
 * Creates a bootstrap administrator (no checker exists yet). Allowed only while every officer is a
 * bootstrap administrator, and at most twice, so the second one can be the first checker.
 */
CREATE FUNCTION admin.bootstrap_admin(p_handle text, p_name text, p_token_hash bytea, p_actor text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_seq smallint;
  v_id uuid;
BEGIN
  LOCK TABLE admin.officers IN EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM admin.officers WHERE bootstrap_seq IS NULL) THEN
    RAISE EXCEPTION 'bootstrap is closed: officers already exist; invite through the portal (maker-checker)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT coalesce(max(bootstrap_seq), 0) + 1 INTO v_seq FROM admin.officers;
  IF v_seq > 2 THEN
    RAISE EXCEPTION 'bootstrap is closed: two bootstrap administrators exist' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO admin.officers (handle, display_name, bootstrap_seq, created_by) VALUES (p_handle, p_name, v_seq, p_actor) RETURNING id INTO v_id;
  INSERT INTO admin.role_grants (officer_id, role) VALUES (v_id, 'admin');
  PERFORM admin.audit_append(p_actor, 'officer.bootstrapped', jsonb_build_object('officer', v_id, 'handle', p_handle, 'seq', v_seq));
  PERFORM admin.audit_append(p_actor, 'role.granted', jsonb_build_object(
    'grant', (SELECT id FROM admin.role_grants WHERE officer_id = v_id AND role = 'admin' AND revoked_at IS NULL),
    'officer', v_id, 'role', 'admin', 'change', NULL));
  PERFORM admin.issue_enrolment(p_handle, p_token_hash, p_actor, 30);
  RETURN v_id;
END $$;

/**
 * One-time enrolment link for an approved (or bootstrap) officer without a credential. Earlier
 * unused links of the officer are revoked. Only the SHA-256 of the token is stored.
 */
CREATE FUNCTION admin.issue_enrolment(p_handle text, p_token_hash bytea, p_actor text, p_minutes integer)
RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  o admin.officers;
  v_exp timestamptz;
BEGIN
  SELECT * INTO o FROM admin.officers WHERE handle = p_handle FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown officer %', p_handle USING ERRCODE = 'no_data_found'; END IF;
  IF o.status <> 'invited' OR EXISTS (SELECT 1 FROM admin.credentials WHERE officer_id = o.id) THEN
    RAISE EXCEPTION 'officer % is not waiting for enrolment (status %)', p_handle, o.status USING ERRCODE = 'check_violation';
  END IF;
  -- An invited officer exists only through an approved invite change or as a bootstrap administrator.
  IF o.bootstrap_seq IS NULL AND NOT EXISTS (SELECT 1 FROM admin.changes WHERE id = o.change_id AND status = 'approved') THEN
    RAISE EXCEPTION 'officer % has no approved invitation', p_handle USING ERRCODE = 'check_violation';
  END IF;
  IF p_minutes NOT BETWEEN 5 AND 30 THEN RAISE EXCEPTION 'an enrolment link lives 5 to 30 minutes' USING ERRCODE = 'check_violation'; END IF;
  UPDATE admin.enrolments SET revoked_at = clock_timestamp() WHERE officer_id = o.id AND used_at IS NULL AND revoked_at IS NULL;
  v_exp := date_trunc('microseconds', clock_timestamp()) + make_interval(mins => p_minutes);
  INSERT INTO admin.enrolments (token_hash, officer_id, issued_at, expires_at, issued_by)
  VALUES (p_token_hash, o.id, v_exp - make_interval(mins => p_minutes), v_exp, p_actor);
  PERFORM admin.audit_append(p_actor, 'enrol.issued', jsonb_build_object('officer', o.id, 'handle', o.handle, 'expires', admin.utc(v_exp)));
  RETURN v_exp;
END $$;

CREATE FUNCTION admin.directory()
RETURNS TABLE (handle text, display_name text, status text, roles text[], credentials bigint, bootstrap boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
  SELECT o.handle, o.display_name, o.status,
         coalesce((SELECT array_agg(g.role ORDER BY g.role) FROM admin.role_grants g WHERE g.officer_id = o.id AND g.revoked_at IS NULL), '{}'),
         (SELECT count(*) FROM admin.credentials c WHERE c.officer_id = o.id), o.bootstrap_seq IS NOT NULL
  FROM admin.officers o ORDER BY o.created_at
$$;

-- ================================================================== maker-checker officer changes (P-3)
CREATE FUNCTION admin.active_admins() RETURNS bigint
LANGUAGE sql STABLE SET search_path = pg_catalog, admin AS $$
  SELECT count(*) FROM admin.officers o
  WHERE o.status = 'active' AND EXISTS (SELECT 1 FROM admin.role_grants g WHERE g.officer_id = o.id AND g.role = 'admin' AND g.revoked_at IS NULL)
$$;

CREATE FUNCTION admin.change_digest(p_id bigint) RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog, admin AS $$
  SELECT encode(sha256(convert_to(jsonb_build_array(c.id, c.kind, c.officer_id, c.role, c.new_handle, c.new_name, c.reason,
    c.requested_by, admin.utc(c.requested_at), admin.utc(c.expires_at), c.status, c.decided_by, c.decision_reason,
    admin.utc(c.decided_at), c.result_officer)::text, 'UTF8')), 'hex')
  FROM admin.changes c WHERE c.id = p_id
$$;

/** Internal: the change would leave fewer than two active administrators. */
CREATE FUNCTION admin.would_orphan(p_kind text, p_officer uuid, p_role text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, admin AS $$
  SELECT (p_kind = 'disable' OR (p_kind = 'revoke' AND p_role = 'admin'))
     AND EXISTS (SELECT 1 FROM admin.role_grants g JOIN admin.officers o ON o.id = g.officer_id
                 WHERE g.officer_id = p_officer AND g.role = 'admin' AND g.revoked_at IS NULL AND o.status = 'active')
     AND admin.active_admins() <= 2
$$;

/** Maker: an administrator requests a change to ANOTHER officer (or an invitation). */
CREATE FUNCTION admin.request_change(p_session bytea, p_kind text, p_officer uuid, p_role text, p_new_handle text,
                                     p_new_name text, p_reason text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'officers.manage');
  o admin.officers;
  v_conflict text;
  v_id bigint;
BEGIN
  IF p_kind NOT IN ('invite', 'grant', 'revoke', 'disable') THEN
    RAISE EXCEPTION 'unknown change kind' USING ERRCODE = 'check_violation';
  END IF;
  IF p_kind = 'invite' THEN
    IF EXISTS (SELECT 1 FROM admin.officers WHERE handle = p_new_handle) THEN
      RAISE EXCEPTION 'handle % is taken', p_new_handle USING ERRCODE = 'unique_violation';
    END IF;
  ELSE
    SELECT * INTO o FROM admin.officers WHERE id = p_officer;
    IF NOT FOUND THEN RAISE EXCEPTION 'unknown officer' USING ERRCODE = 'no_data_found'; END IF;
    IF o.id = v_me THEN
      RAISE EXCEPTION 'maker-checker: nobody changes their own account' USING ERRCODE = 'check_violation';
    END IF;
    IF o.status = 'disabled' THEN RAISE EXCEPTION 'officer % is disabled', o.handle USING ERRCODE = 'check_violation'; END IF;
    IF p_kind = 'grant' THEN
      IF EXISTS (SELECT 1 FROM admin.role_grants WHERE officer_id = o.id AND role = p_role AND revoked_at IS NULL) THEN
        RAISE EXCEPTION '% already holds %', o.handle, p_role USING ERRCODE = 'check_violation';
      END IF;
      SELECT g.role || ' + ' || p_role || ': ' || c.reason INTO v_conflict
      FROM admin.role_grants g JOIN admin.role_conflicts c ON c.a = least(g.role, p_role) AND c.b = greatest(g.role, p_role)
      WHERE g.officer_id = o.id AND g.revoked_at IS NULL LIMIT 1;
      IF v_conflict IS NOT NULL THEN
        RAISE EXCEPTION 'segregation of duties: % cannot hold %', o.handle, v_conflict USING ERRCODE = 'check_violation';
      END IF;
    ELSIF p_kind = 'revoke' AND NOT EXISTS (SELECT 1 FROM admin.role_grants WHERE officer_id = o.id AND role = p_role AND revoked_at IS NULL) THEN
      RAISE EXCEPTION '% does not hold %', o.handle, p_role USING ERRCODE = 'check_violation';
    END IF;
    IF admin.would_orphan(p_kind, o.id, p_role) THEN
      RAISE EXCEPTION 'at least two active administrators must remain' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  INSERT INTO admin.changes (kind, officer_id, role, new_handle, new_name, reason, requested_by)
  VALUES (p_kind, CASE WHEN p_kind <> 'invite' THEN p_officer END, CASE WHEN p_kind <> 'disable' THEN p_role END,
          CASE WHEN p_kind = 'invite' THEN p_new_handle END, CASE WHEN p_kind = 'invite' THEN p_new_name END, p_reason, v_me)
  RETURNING id INTO v_id;
  PERFORM admin.audit_append(v_me::text, 'change.requested', jsonb_build_object('change', v_id, 'kind', p_kind,
    'officer', CASE WHEN p_kind <> 'invite' THEN p_officer END, 'role', p_role, 'handle', p_new_handle, 'digest', admin.change_digest(v_id)));
  RETURN v_id;
END $$;

/**
 * Checker: a DIFFERENT administrator with a fresh step-up approves or rejects. Approval applies the
 * change in the same transaction; segregation of duties is checked again by the grant trigger.
 */
CREATE FUNCTION admin.decide_change(p_session bytea, p_change bigint, p_decision text, p_reason text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_me uuid := admin.require(p_session, 'officers.manage');
  c admin.changes;
  v_new uuid;
  v_grant bigint;
BEGIN
  PERFORM admin.require_step_up(p_session);
  IF p_decision NOT IN ('approve', 'reject') THEN RAISE EXCEPTION 'decision must be approve or reject' USING ERRCODE = 'check_violation'; END IF;
  SELECT * INTO c FROM admin.changes WHERE id = p_change FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown change' USING ERRCODE = 'no_data_found'; END IF;
  IF c.status <> 'open' THEN RETURN c.status; END IF;
  IF c.requested_by = v_me THEN
    RAISE EXCEPTION 'maker-checker: the requester cannot decide their own request' USING ERRCODE = 'check_violation';
  END IF;
  IF c.officer_id = v_me THEN
    RAISE EXCEPTION 'maker-checker: nobody decides a change to their own account' USING ERRCODE = 'check_violation';
  END IF;
  IF c.expires_at <= clock_timestamp() THEN
    UPDATE admin.changes SET status = 'expired', decided_at = clock_timestamp() WHERE id = c.id;
    PERFORM admin.audit_append(v_me::text, 'change.expired', jsonb_build_object('change', c.id, 'digest', admin.change_digest(c.id)));
    RETURN 'expired';
  END IF;
  IF p_decision = 'reject' THEN
    UPDATE admin.changes SET status = 'rejected', decided_by = v_me, decision_reason = p_reason, decided_at = clock_timestamp() WHERE id = c.id;
    PERFORM admin.audit_append(v_me::text, 'change.decided', jsonb_build_object('change', c.id, 'decision', 'reject', 'digest', admin.change_digest(c.id)));
    RETURN 'rejected';
  END IF;
  IF admin.would_orphan(c.kind, c.officer_id, c.role) THEN
    RAISE EXCEPTION 'at least two active administrators must remain' USING ERRCODE = 'check_violation';
  END IF;
  IF c.kind = 'invite' THEN
    IF EXISTS (SELECT 1 FROM admin.officers WHERE handle = c.new_handle) THEN
      RAISE EXCEPTION 'handle % is taken', c.new_handle USING ERRCODE = 'unique_violation';
    END IF;
    INSERT INTO admin.officers (handle, display_name, change_id, created_by) VALUES (c.new_handle, c.new_name, c.id, v_me::text)
    RETURNING id INTO v_new;
  END IF;
  UPDATE admin.changes SET status = 'approved', decided_by = v_me, decision_reason = p_reason, decided_at = clock_timestamp(), result_officer = v_new
  WHERE id = c.id;
  IF c.kind = 'invite' THEN
    PERFORM admin.audit_append(v_me::text, 'officer.invited', jsonb_build_object('officer', v_new, 'handle', c.new_handle, 'change', c.id));
    INSERT INTO admin.role_grants (officer_id, role, granted_change) VALUES (v_new, c.role, c.id) RETURNING id INTO v_grant;
    PERFORM admin.audit_append(v_me::text, 'role.granted', jsonb_build_object('grant', v_grant, 'officer', v_new, 'role', c.role, 'change', c.id));
  ELSIF c.kind = 'grant' THEN
    INSERT INTO admin.role_grants (officer_id, role, granted_change) VALUES (c.officer_id, c.role, c.id) RETURNING id INTO v_grant;
    PERFORM admin.audit_append(v_me::text, 'role.granted', jsonb_build_object('grant', v_grant, 'officer', c.officer_id, 'role', c.role, 'change', c.id));
  ELSIF c.kind = 'revoke' THEN
    UPDATE admin.role_grants SET revoked_at = clock_timestamp(), revoked_change = c.id
    WHERE officer_id = c.officer_id AND role = c.role AND revoked_at IS NULL RETURNING id INTO v_grant;
    IF v_grant IS NULL THEN RAISE EXCEPTION 'the role is no longer held' USING ERRCODE = 'check_violation'; END IF;
    PERFORM admin.audit_append(v_me::text, 'role.revoked', jsonb_build_object('grant', v_grant, 'officer', c.officer_id, 'role', c.role, 'change', c.id));
  ELSE
    UPDATE admin.officers SET status = 'disabled', disabled_at = clock_timestamp() WHERE id = c.officer_id;
    UPDATE admin.sessions SET ended_at = clock_timestamp(), end_reason = 'officer_disabled' WHERE officer_id = c.officer_id AND ended_at IS NULL;
    UPDATE admin.enrolments SET revoked_at = clock_timestamp() WHERE officer_id = c.officer_id AND used_at IS NULL AND revoked_at IS NULL;
    PERFORM admin.audit_append(v_me::text, 'officer.disabled', jsonb_build_object('officer', c.officer_id, 'change', c.id));
  END IF;
  PERFORM admin.audit_append(v_me::text, 'change.decided', jsonb_build_object('change', c.id, 'decision', 'approve', 'digest', admin.change_digest(c.id)));
  RETURN 'approved';
END $$;

-- ================================================================== portal reads (P-8; read-only towards other schemas)
CREATE FUNCTION admin.officers_list(p_session bytea)
RETURNS TABLE (id uuid, handle text, display_name text, status text, roles text[], credentials bigint, enrolled_at timestamptz,
               last_login timestamptz, bootstrap boolean, created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
#variable_conflict use_column
BEGIN
  PERFORM admin.require(p_session, 'officers.read');
  RETURN QUERY
  SELECT o.id, o.handle, o.display_name, o.status,
         coalesce((SELECT array_agg(g.role ORDER BY g.role) FROM admin.role_grants g WHERE g.officer_id = o.id AND g.revoked_at IS NULL), '{}'),
         (SELECT count(*) FROM admin.credentials c WHERE c.officer_id = o.id AND c.disabled_at IS NULL), o.enrolled_at,
         (SELECT max(s.created_at) FROM admin.sessions s WHERE s.officer_id = o.id), o.bootstrap_seq IS NOT NULL, o.created_at
  FROM admin.officers o
  ORDER BY o.status = 'disabled', o.handle;
END $$;

CREATE FUNCTION admin.changes_list(p_session bytea, p_limit integer)
RETURNS TABLE (id bigint, kind text, officer_handle text, role text, new_handle text, new_name text, reason text,
               requested_by text, requested_at timestamptz, expires_at timestamptz, status text, decided_by text,
               decision_reason text, decided_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
#variable_conflict use_column
BEGIN
  PERFORM admin.require(p_session, 'officers.read');
  RETURN QUERY
  SELECT c.id, c.kind, t.handle, c.role, c.new_handle, c.new_name, c.reason, r.handle, c.requested_at, c.expires_at,
         CASE WHEN c.status = 'open' AND c.expires_at <= clock_timestamp() THEN 'expired' ELSE c.status END,
         d.handle, c.decision_reason, c.decided_at
  FROM admin.changes c
  LEFT JOIN admin.officers t ON t.id = c.officer_id
  JOIN admin.officers r ON r.id = c.requested_by
  LEFT JOIN admin.officers d ON d.id = c.decided_by
  ORDER BY c.status <> 'open', c.id DESC
  LIMIT least(greatest(coalesce(p_limit, 50), 1), 200);
END $$;

CREATE FUNCTION admin.my_account(p_session bytea)
RETURNS TABLE (credential text, aaguid uuid, fmt text, transports text[], created_at timestamptz, last_used_at timestamptz,
               disabled_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
#variable_conflict use_column
DECLARE
  v_me uuid := admin.require(p_session, NULL);
BEGIN
  RETURN QUERY SELECT c.id, c.aaguid, c.fmt, c.transports, c.created_at, c.last_used_at, c.disabled_at
  FROM admin.credentials c WHERE c.officer_id = v_me ORDER BY c.created_at;
END $$;

/** The role matrix for the portal's menus (its copy is tested against this one). Not sensitive. */
CREATE FUNCTION admin.role_matrix()
RETURNS TABLE (kind text, a text, b text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
  SELECT 'permission', role, permission FROM admin.role_permissions
  UNION ALL SELECT 'conflict', a, b FROM admin.role_conflicts
  ORDER BY 1, 2, 3
$$;

/** Operations overview: health and queue counts only, no personal data, no payloads (ops.read). */
CREATE FUNCTION admin.ops_overview(p_session bytea) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v jsonb;
BEGIN
  PERFORM admin.require(p_session, 'ops.read');
  SELECT jsonb_build_object(
    'at', admin.utc(clock_timestamp()),
    'indexer', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'deployment', c.deployment, 'chainId', d.chain_id, 'block', c.block_number, 'updatedAt', admin.utc(c.updated_at),
        'batches', c.batches, 'events', c.events, 'haltedAt', admin.utc(c.halted_at), 'haltReason', c.halt_reason) ORDER BY c.deployment)
      FROM chain.cursors c JOIN chain.deployments d USING (deployment)), '[]'::jsonb),
    'outbox', coalesce((SELECT jsonb_agg(jsonb_build_object('status', s.status, 'commands', s.commands, 'oldestSeconds', round(s.oldest_seconds::numeric, 1)))
      FROM outbox.stats() s), '[]'::jsonb),
    'outboxRecent', coalesce((SELECT jsonb_agg(x ORDER BY (x->>'id')::bigint DESC) FROM (
        SELECT jsonb_build_object('id', c.id, 'kind', c.kind, 'status', c.status, 'attempts', c.attempts, 'maxAttempts', c.max_attempts,
               'ageSeconds', round(extract(epoch FROM clock_timestamp() - c.created_at)::numeric), 'txHash', c.tx_hash,
               'lastError', left(c.last_error, 160)) AS x
        FROM outbox.commands c ORDER BY c.id DESC LIMIT 8) r), '[]'::jsonb),
    'signer', jsonb_build_object(
      'pendingApprovals', (SELECT count(*) FROM signer.requests WHERE status = 'pending_approval' AND expires_at > clock_timestamp())),
    'recon', jsonb_build_object(
      'gate', (SELECT jsonb_build_object('allowed', g.allowed, 'frozen', g.frozen, 'reason', g.reason, 'lastRun', g.last_run,
                                         'lastStatus', g.last_status, 'lastFinished', admin.utc(g.last_finished)) FROM recon.payout_gate() g),
      'lastRun', (SELECT jsonb_build_object('id', r.id, 'status', r.status, 'startedAt', admin.utc(r.started_at), 'finishedAt', admin.utc(r.finished_at),
                                            'pinnedBlock', r.pinned_block, 'blocking', r.blocking, 'warnings', r.warnings, 'error', left(r.error, 200))
                  FROM recon.runs r ORDER BY r.id DESC LIMIT 1),
      'lastFindings', coalesce((SELECT jsonb_agg(jsonb_build_object('check', f.check_name, 'severity', f.severity, 'count', f.n) ORDER BY f.n DESC)
                                FROM (SELECT check_name, severity, count(*) AS n FROM recon.findings
                                      WHERE run_id = (SELECT max(id) FROM recon.runs WHERE status <> 'running') GROUP BY 1, 2) f), '[]'::jsonb),
      'openUnfreezeRequests', (SELECT count(*) FROM recon.unfreeze_requests WHERE status = 'open' AND expires_at > clock_timestamp())),
    'anchor', jsonb_build_object(
      'latest', (SELECT jsonb_build_object('id', a.id, 'status', a.status, 'besuBlock', a.besu_block, 'anchorChainId', a.anchor_chain_id,
                                           'anchorBlock', a.anchor_block, 'createdAt', admin.utc(a.created_at), 'confirmedAt', admin.utc(a.confirmed_at),
                                           'failure', left(a.failure, 200))
                 FROM anchor.anchors a ORDER BY a.id DESC LIMIT 1),
      'confirmed', (SELECT count(*) FROM anchor.anchors WHERE status = 'confirmed'),
      'open', (SELECT count(*) FROM anchor.anchors WHERE status IN ('recorded', 'sent')),
      'failed24h', (SELECT count(*) FROM anchor.anchors WHERE status = 'failed' AND updated_at > clock_timestamp() - interval '24 hours')),
    'kyc', jsonb_build_object(
      'subjects', (SELECT count(*) FROM kyc.subjects),
      'byStatus', coalesce((SELECT jsonb_object_agg(st, n) FROM (
          SELECT CASE WHEN d.status = 'verified' AND d.valid_until <= clock_timestamp() THEN 'expired' ELSE d.status END AS st, count(*) AS n
          FROM (SELECT DISTINCT ON (subject_id) status, valid_until FROM kyc.decisions ORDER BY subject_id, id DESC) d GROUP BY 1) q), '{}'::jsonb),
      'openClearances', (SELECT count(*) FROM kyc.clearances WHERE status = 'open' AND expires_at > clock_timestamp())),
    'bank', jsonb_build_object(
      'batches', coalesce((SELECT jsonb_object_agg(status, n) FROM (SELECT status, count(*) AS n FROM bank.payout_batches GROUP BY 1) q), '{}'::jsonb),
      'suspense', (SELECT count(*) FROM bank.credits c WHERE c.status = 'suspense' AND NOT EXISTS (SELECT 1 FROM bank.credit_returns r WHERE r.raast_ref = c.raast_ref)),
      'coolingOff', (SELECT count(*) FROM bank.payees WHERE superseded_at IS NULL AND active_from > clock_timestamp())),
    'ledger', (SELECT jsonb_build_object('journals', count(*), 'lastAt', admin.utc(max(created_at))) FROM ledger.journal)
  ) INTO v;
  RETURN v;
END $$;

/** Audit rows of one source with filters and keyset paging (newest first). */
CREATE FUNCTION admin.audit_rows(p_session bytea, p_source text, p_from timestamptz, p_to timestamptz, p_actor text, p_action text,
                                 p_before bigint, p_limit integer)
RETURNS TABLE (id bigint, at timestamptz, actor text, action text, ref text, detail jsonb, prev_hash text, hash text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
#variable_conflict use_column
DECLARE
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 50000);
BEGIN
  IF p_source = 'admin' THEN
    PERFORM admin.require(p_session, 'audit.read.admin');
    RETURN QUERY SELECT a.id, a.at, a.actor, a.action, NULL::text, a.detail, encode(a.prev_hash, 'hex'), encode(a.hash, 'hex')
      FROM admin.audit a
      WHERE (p_from IS NULL OR a.at >= p_from) AND (p_to IS NULL OR a.at < p_to)
        AND (p_actor IS NULL OR strpos(a.actor, p_actor) > 0) AND (p_action IS NULL OR starts_with(a.action, p_action))
        AND (p_before IS NULL OR a.id < p_before)
      ORDER BY a.id DESC LIMIT v_limit;
  ELSIF p_source = 'signer' THEN
    PERFORM admin.require(p_session, 'audit.read.ops');
    RETURN QUERY SELECT a.id, a.at, a.actor, a.action, a.request_id::text, a.detail, encode(a.prev_hash, 'hex'), encode(a.hash, 'hex')
      FROM signer.audit a
      WHERE (p_from IS NULL OR a.at >= p_from) AND (p_to IS NULL OR a.at < p_to)
        AND (p_actor IS NULL OR strpos(a.actor, p_actor) > 0) AND (p_action IS NULL OR starts_with(a.action, p_action))
        AND (p_before IS NULL OR a.id < p_before)
      ORDER BY a.id DESC LIMIT v_limit;
  ELSIF p_source = 'recon' THEN
    PERFORM admin.require(p_session, 'audit.read.ops');
    RETURN QUERY SELECT a.id, a.at, a.actor, a.action, NULL::text, a.detail, encode(a.prev_hash, 'hex'), encode(a.hash, 'hex')
      FROM recon.audit a
      WHERE (p_from IS NULL OR a.at >= p_from) AND (p_to IS NULL OR a.at < p_to)
        AND (p_actor IS NULL OR strpos(a.actor, p_actor) > 0) AND (p_action IS NULL OR starts_with(a.action, p_action))
        AND (p_before IS NULL OR a.id < p_before)
      ORDER BY a.id DESC LIMIT v_limit;
  ELSIF p_source = 'ledger' THEN
    PERFORM admin.require(p_session, 'audit.read.ops');
    RETURN QUERY SELECT j.id, j.created_at, j.created_by, j.kind, j.external_ref,
        jsonb_build_object('idempotencyKey', j.idempotency_key, 'memo', j.memo), encode(j.prev_hash, 'hex'), encode(j.hash, 'hex')
      FROM ledger.journal j
      WHERE (p_from IS NULL OR j.created_at >= p_from) AND (p_to IS NULL OR j.created_at < p_to)
        AND (p_actor IS NULL OR strpos(j.created_by, p_actor) > 0) AND (p_action IS NULL OR starts_with(j.kind, p_action))
        AND (p_before IS NULL OR j.id < p_before)
      ORDER BY j.id DESC LIMIT v_limit;
  ELSE
    RAISE EXCEPTION 'unknown audit source' USING ERRCODE = 'check_violation';
  END IF;
END $$;

/**
 * Verifies the hash chains the officer may read: entries and problems per chain. VOLATILE because
 * the signer's legacy verification switches the TimeZone (transaction-local, restored).
 */
CREATE FUNCTION admin.verify_chains(p_session bytea, p_source text)
RETURNS TABLE (source text, entries bigint, problems bigint, first_problem text, verified_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
#variable_conflict use_column
DECLARE
  v_ops boolean;
  v_admin boolean;
BEGIN
  PERFORM admin.require(p_session, NULL);
  v_ops := admin.has_permission(p_session, 'audit.read.ops');
  v_admin := admin.has_permission(p_session, 'audit.read.admin');
  IF v_ops AND coalesce(p_source, 'signer') = 'signer' THEN
    RETURN QUERY SELECT 'signer'::text, (SELECT count(*) FROM signer.audit), count(*), min(v.problem), clock_timestamp() FROM signer.verify_audit() v;
  END IF;
  IF v_ops AND coalesce(p_source, 'recon') = 'recon' THEN
    RETURN QUERY SELECT 'recon'::text, (SELECT count(*) FROM recon.audit), count(*), min(v.problem), clock_timestamp() FROM recon.verify_audit() v;
  END IF;
  IF v_ops AND coalesce(p_source, 'ledger') = 'ledger' THEN
    RETURN QUERY SELECT 'ledger'::text, (SELECT count(*) FROM ledger.journal), count(*), min(v.problem), clock_timestamp() FROM ledger.verify_chain() v;
  END IF;
  IF v_admin AND coalesce(p_source, 'admin') = 'admin' THEN
    RETURN QUERY SELECT 'admin'::text, (SELECT count(*) FROM admin.audit), count(*), min(v.problem), clock_timestamp() FROM admin.verify_audit() v;
  END IF;
END $$;

/** Records an evidence export BEFORE it is handed out; returns the audit entry for the manifest. */
CREATE FUNCTION admin.record_export(p_session bytea, p_source text, p_filters jsonb, p_rows integer, p_format text, p_sha256 text)
RETURNS TABLE (audit_id bigint, audit_hash text, at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
#variable_conflict use_column
DECLARE
  v_me uuid := admin.require(p_session, 'audit.export');
  v_id bigint;
BEGIN
  IF p_source NOT IN ('admin', 'signer', 'recon', 'ledger') OR p_format NOT IN ('csv', 'json') OR p_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid export description' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM admin.require(p_session, CASE WHEN p_source = 'admin' THEN 'audit.read.admin' ELSE 'audit.read.ops' END);
  v_id := admin.audit_append(v_me::text, 'audit.exported', jsonb_build_object('source', p_source, 'format', p_format, 'rows', p_rows,
                                                                             'filters', coalesce(p_filters, '{}'::jsonb), 'sha256', p_sha256));
  RETURN QUERY SELECT a.id, encode(a.hash, 'hex'), a.at FROM admin.audit a WHERE a.id = v_id;
END $$;

-- ================================================================== verification (P-7)
CREATE FUNCTION admin.verify_audit() RETURNS TABLE (audit_id bigint, problem text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  a admin.audit;
  v_prev bytea := decode(repeat('00', 32), 'hex');
  r record;
BEGIN
  FOR a IN SELECT * FROM admin.audit ORDER BY id LOOP
    IF a.prev_hash <> v_prev THEN audit_id := a.id; problem := 'prev_hash does not match'; RETURN NEXT; END IF;
    IF a.hash <> admin.audit_digest(a.prev_hash, a.id, a.at, a.actor, a.action, a.detail) THEN
      audit_id := a.id; problem := 'content does not match its hash'; RETURN NEXT;
    END IF;
    IF a.action IN ('change.decided', 'change.expired')
       AND admin.change_digest((a.detail->>'change')::bigint) IS DISTINCT FROM a.detail->>'digest' THEN
      audit_id := a.id; problem := format('officer change %s was edited after it was decided', a.detail->>'change'); RETURN NEXT;
    END IF;
    v_prev := a.hash;
  END LOOP;
  IF admin.role_matrix_digest() <> admin.expected_role_matrix_digest() THEN
    audit_id := NULL; problem := 'the role matrix (roles, conflicts, permissions) differs from the migration'; RETURN NEXT;
  END IF;
  -- Rows that exist without the audit entry their API function always writes: written around the API.
  FOR r IN
    SELECT 'credential ' || left(c.id, 16) AS what FROM admin.credentials c WHERE NOT EXISTS (
      SELECT 1 FROM admin.audit x WHERE x.action = 'enrol.completed' AND x.detail->>'credential' = c.id
        AND x.detail->>'publicKeySha256' = encode(sha256(c.public_key), 'hex') AND x.detail->>'officer' = c.officer_id::text)
    UNION ALL
    SELECT 'session ' || left(encode(s.token_hash, 'hex'), 16) FROM admin.sessions s WHERE NOT EXISTS (
      SELECT 1 FROM admin.audit x WHERE x.action = 'login.success' AND x.detail->>'session' = left(encode(s.token_hash, 'hex'), 16)
        AND x.actor = s.officer_id::text)
    UNION ALL
    SELECT 'role grant ' || g.id FROM admin.role_grants g WHERE NOT EXISTS (
      SELECT 1 FROM admin.audit x WHERE x.action = 'role.granted' AND (x.detail->>'grant')::bigint = g.id
        AND x.detail->>'officer' = g.officer_id::text AND x.detail->>'role' = g.role)
      OR (g.revoked_at IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM admin.audit x WHERE x.action = 'role.revoked' AND (x.detail->>'grant')::bigint = g.id))
    UNION ALL
    SELECT 'officer ' || o.handle FROM admin.officers o WHERE NOT EXISTS (
      SELECT 1 FROM admin.audit x WHERE x.action IN ('officer.bootstrapped', 'officer.invited') AND x.detail->>'officer' = o.id::text
        AND x.detail->>'handle' = o.handle)
      OR (o.status = 'disabled' AND NOT EXISTS (
      SELECT 1 FROM admin.audit x WHERE x.action = 'officer.disabled' AND x.detail->>'officer' = o.id::text))
    UNION ALL
    SELECT 'officer change ' || c.id FROM admin.changes c WHERE NOT EXISTS (
      SELECT 1 FROM admin.audit x WHERE x.action = 'change.requested' AND (x.detail->>'change')::bigint = c.id)
      OR (c.status <> 'open' AND NOT EXISTS (
      SELECT 1 FROM admin.audit x WHERE x.action IN ('change.decided', 'change.expired') AND (x.detail->>'change')::bigint = c.id))
  LOOP
    audit_id := NULL; problem := r.what || ' has no matching audit entry'; RETURN NEXT;
  END LOOP;
END $$;

-- ================================================================== privileges (P-8, P-9)
REVOKE ALL ON ALL TABLES IN SCHEMA admin FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA admin FROM PUBLIC;
REVOKE ALL ON TYPE admin.session_info FROM PUBLIC;

GRANT USAGE ON SCHEMA admin TO pt_admin_portal, pt_admin_cli, pt_admin_auditor;
GRANT USAGE ON TYPE admin.session_info TO pt_admin_portal;
GRANT EXECUTE ON FUNCTION
  admin.authorize(bytea, text, text, boolean),
  admin.end_session(bytea, text),
  admin.create_challenge(bytea, text, text, bytea, bytea),
  admin.consume_challenge(bytea, text, bytea, bytea),
  admin.enrolment_officer(bytea),
  admin.complete_enrolment(bytea, text, bytea, bigint, text[], uuid, text, text, boolean, boolean),
  admin.auth_failed(text, text, text),
  admin.credential_for_login(text),
  admin.session_credentials(bytea),
  admin.start_session(bytea, text, bigint),
  admin.record_step_up(bytea, text, bigint),
  admin.require_step_up(bytea),
  admin.has_permission(bytea, text),
  admin.request_change(bytea, text, uuid, text, text, text, text),
  admin.decide_change(bytea, bigint, text, text),
  admin.officers_list(bytea),
  admin.changes_list(bytea, integer),
  admin.my_account(bytea),
  admin.role_matrix(),
  admin.ops_overview(bytea),
  admin.audit_rows(bytea, text, timestamptz, timestamptz, text, text, bigint, integer),
  admin.verify_chains(bytea, text),
  admin.record_export(bytea, text, jsonb, integer, text, text)
TO pt_admin_portal;
GRANT EXECUTE ON FUNCTION
  admin.bootstrap_admin(text, text, bytea, text),
  admin.issue_enrolment(text, bytea, text, integer),
  admin.directory()
TO pt_admin_cli;
GRANT EXECUTE ON FUNCTION admin.verify_audit(), admin.role_matrix() TO pt_admin_auditor, pt_admin_cli;

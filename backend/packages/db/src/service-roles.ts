/**
 * Creates or updates the backend services' login roles (T-012, migration 0029, ADR 0016): one LOGIN
 * role per service, a member of that service's group role (pt_svc_<service>) only, with no
 * superuser, database, role, replication or RLS-bypass rights. Each password is generated here the
 * first time and appended to backend/.env.local (git-ignored, mode 0600) as <PREFIX>_PG_USER and
 * <PREFIX>_PG_PASSWORD; nothing secret is printed. Idempotent: a re-run keeps the passwords,
 * re-asserts each role's limits and drops any other membership.
 *   npm run db:service-roles               (service-roles-cli.ts; needs migration 0029 in property_token)
 *   npm run db:service-roles -- --test     (checks property_token_test instead; roles are cluster-wide)
 * Pattern of db:web-role (website) and admin/scripts/setup-server.mjs (portal).
 */
import { serviceRoles, type ServiceName } from "@pt/config";
import type pg from "pg";

/** Generous per-service ceilings: pools are 2-10 connections; a runaway loop cannot exhaust the server. */
const LIMITS = "LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT CONNECTION LIMIT 30";

export interface ServiceRoleResult {
  service: ServiceName;
  user: string;
  created: boolean;
}

/** Ensures every service login on the cluster `client` is connected to (as the admin). */
export async function ensureServiceRoles(client: pg.ClientBase, logins: ReadonlyMap<ServiceName, { user: string; password: string }>): Promise<ServiceRoleResult[]> {
  const results: ServiceRoleResult[] = [];
  for (const [service, { group }] of serviceRoles()) {
    const login = logins.get(service);
    if (!login) throw new Error(`no login for the ${service} service`);
    const { user, password } = login;
    const g = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1 AND NOT rolcanlogin", [group]);
    if (g.rowCount !== 1) throw new Error(`group role ${group} does not exist: run npm run migrate first (migration 0029)`);
    const exists = (await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [user])).rowCount === 1;
    const id = client.escapeIdentifier(user);
    // DDL cannot take parameters; the name is validated by the caller and the password is escaped as a literal.
    await client.query(`${exists ? "ALTER" : "CREATE"} ROLE ${id} ${LIMITS} PASSWORD ${client.escapeLiteral(password)}`);
    // Privileges come only through the group (inherited); the login cannot SET ROLE or grant it on.
    await client.query(`GRANT ${client.escapeIdentifier(group)} TO ${id} WITH INHERIT TRUE, SET FALSE, ADMIN FALSE`);
    const other = await client.query<{ name: string }>(
      `SELECT g.rolname AS name FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid JOIN pg_roles u ON u.oid = m.member
       WHERE u.rolname = $1 AND g.rolname <> $2`, [user, group]);
    for (const r of other.rows) await client.query(`REVOKE ${client.escapeIdentifier(r.name)} FROM ${id}`);
    results.push({ service, user, created: !exists });
  }
  return results;
}

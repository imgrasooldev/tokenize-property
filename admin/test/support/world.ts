import { createHash, randomBytes } from "node:crypto";
import pg from "pg";
import { adminSettings, createMigratedDatabase, dropDatabase, ensurePortalLogin } from "../../scripts/lib-db.mjs";
import type { Role } from "../../src/lib/permissions";

/**
 * A scratch database with every migration, three connections and helpers that create officers the
 * way production does (bootstrap or maker-checker invite, one-time link, enrolment, sign-in). The
 * WebAuthn signature check happens in the portal, not in the database, so the database steps can
 * be driven directly here with a stand-in public key.
 */
export interface Actor {
  officerId: string;
  handle: string;
  credentialId: string;
  token: string;
  sessionHash: Buffer;
}

export interface World {
  name: string;
  /** Superuser in the scratch database (tamper tests, ageing rows). */
  su: pg.Client;
  /** Logged in as a role that is only a member of pt_admin_portal, exactly like the portal. */
  portal: pg.Pool;
  /** Superuser that dropped to pt_admin_cli, exactly like tools/officer.ts. */
  cli: pg.Client;
  portalUser: string;
  portalPassword: string;
  drop: () => Promise<void>;
}

export const sha = (s: string): Buffer => createHash("sha256").update(s, "utf8").digest();
export const token = (): string => randomBytes(32).toString("base64url");

export async function createWorld(portalUser = "pt_admin_testdb"): Promise<World> {
  const name = `pt_scratch_admin_${String(Date.now())}_${String(Math.floor(Math.random() * 1e6))}`;
  await createMigratedDatabase(name);
  const portalPassword = await ensurePortalLogin(portalUser);
  const base = adminSettings(name);
  const su = new pg.Client(base);
  await su.connect();
  const cli = new pg.Client(base);
  await cli.connect();
  await cli.query("SET ROLE pt_admin_cli");
  const portal = new pg.Pool({ ...base, user: portalUser, password: portalPassword, max: 6 });
  return {
    name,
    su,
    portal,
    cli,
    portalUser,
    portalPassword,
    drop: async () => {
      await portal.end();
      await cli.end();
      await su.end();
      await dropDatabase(name);
    },
  };
}

export interface FakeKey {
  id: string;
  publicKey: Buffer;
}

export function fakeKey(): FakeKey {
  return { id: randomBytes(20).toString("base64url"), publicKey: randomBytes(77) };
}

export async function enrol(w: World, enrolToken: string, key: FakeKey, opts: { deviceType?: string; backedUp?: boolean; uv?: boolean } = {}) {
  const { rows } = await w.portal.query<{ id: string }>(
    "SELECT admin.complete_enrolment($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) AS id",
    [sha(enrolToken), key.id, key.publicKey, 0, ["usb"], "00000000-0000-0000-0000-000000000000", "packed", opts.deviceType ?? "singleDevice", opts.backedUp ?? false, opts.uv ?? true],
  );
  return rows[0]?.id ?? "";
}

let counter = 1;
export async function login(w: World, key: FakeKey): Promise<{ token: string; sessionHash: Buffer }> {
  const t = token();
  await w.portal.query("SELECT admin.start_session($1, $2, $3)", [sha(t), key.id, counter++]);
  return { token: t, sessionHash: sha(t) };
}

export async function bootstrap(w: World, handle: string, name: string): Promise<Actor> {
  const link = token();
  await w.cli.query("SELECT admin.bootstrap_admin($1, $2, $3, 'cli:test')", [handle, name, sha(link)]);
  const key = fakeKey();
  const officerId = await enrol(w, link, key);
  const s = await login(w, key);
  return { officerId, handle, credentialId: key.id, token: s.token, sessionHash: s.sessionHash };
}

export async function invite(w: World, maker: Actor, checker: Actor, handle: string, role: Role): Promise<Actor> {
  const { rows } = await w.portal.query<{ id: string }>("SELECT admin.request_change($1, 'invite', NULL, $2, $3, $4, $5) AS id", [
    maker.sessionHash,
    role,
    handle,
    `Test ${handle.replace(/[^a-z]/g, " ")}`.slice(0, 60),
    "test invitation for the matrix",
  ]);
  await w.portal.query("SELECT admin.decide_change($1, $2, 'approve', 'approved by the second admin')", [checker.sessionHash, rows[0]?.id]);
  const link = token();
  await w.cli.query("SELECT admin.issue_enrolment($1, $2, 'cli:test', 30)", [handle, sha(link)]);
  const key = fakeKey();
  const officerId = await enrol(w, link, key);
  const s = await login(w, key);
  return { officerId, handle, credentialId: key.id, token: s.token, sessionHash: s.sessionHash };
}

export type Cast = Record<Role | "admin2", Actor>;

/** Two bootstrap administrators and one officer per other role, all signed in. */
export async function cast(w: World): Promise<Cast> {
  const admin = await bootstrap(w, "admin.one", "Admin One");
  const admin2 = await bootstrap(w, "admin.two", "Admin Two");
  const invited = new Map<string, Actor>();
  for (const role of ["ops_maker", "ops_checker", "compliance_officer", "trustee_officer", "auditor"] as const) {
    invited.set(role, await invite(w, admin, admin2, role.replace("_officer", "").replace("_", "."), role));
  }
  return { admin, admin2, ...Object.fromEntries(invited) } as Cast;
}

export async function auditActions(w: World, sinceId = 0): Promise<{ id: string; actor: string; action: string; detail: Record<string, unknown> }[]> {
  const { rows } = await w.su.query<{ id: string; actor: string; action: string; detail: Record<string, unknown> }>(
    "SELECT id, actor, action, detail FROM admin.audit WHERE id > $1 ORDER BY id",
    [sinceId],
  );
  return rows;
}

export async function verify(w: World): Promise<{ audit_id: string | null; problem: string }[]> {
  return (await w.su.query<{ audit_id: string | null; problem: string }>("SELECT * FROM admin.verify_audit()")).rows;
}

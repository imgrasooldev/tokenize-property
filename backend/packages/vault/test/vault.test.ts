import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authHeaders, type Client } from "@pt/http-auth";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../db/src/migrate.ts";
import { contiguousMigrations, scratchDatabase, serviceLogin } from "../../db/test/helpers.ts";
import { ADMIN_VAULT_SCOPE, createVaultServer, WEB_VAULT_SCOPE } from "../src/http.ts";
import { MasterKeys, sha256, Vault, VaultError } from "../src/store.ts";

/**
 * T-038 document vault (migration 0041, ADR 0017): encrypted at rest with a per-file key, the file
 * name is the plaintext hash only, a changed file or a wrong key is refused, only published offering
 * documents go to the website, every read is logged, the service login can do nothing else.
 */
let su: pg.Client;
let pool: pg.Pool;
let drop: () => Promise<void>;
let login: Awaited<ReturnType<typeof serviceLogin>>;
let dir: string;
let vault: Vault;
const keys = MasterKeys.of([{ version: 1, key: randomBytes(32) }], 1);
const pdf = (s: string): Buffer => Buffer.from(`%PDF-1.7\n${s}\n%%EOF\n`);

beforeAll(async () => {
  const s = await scratchDatabase();
  ({ client: su, drop } = s);
  await migrate(su, contiguousMigrations());
  login = await serviceLogin("vault", String(s.settings.database));
  pool = new pg.Pool({ ...login.settings, max: 4 });
  dir = await mkdtemp(join(tmpdir(), "pt-vault-"));
  vault = new Vault(pool, dir, keys);
}, 180_000);

afterAll(async () => {
  await pool.end();
  await drop();
  await login.drop();
}, 180_000);

/** An offering the website may show, whose English document is this hash (TEST ONLY: written directly, foreign keys off). */
async function publish(sha: string): Promise<void> {
  await su.query("SET session_replication_role = replica");
  try {
    await su.query(
      `INSERT INTO offering.offerings (property_id, state, price_paisa, min_units, max_units, max_holding_units, register_units, doc_en_sha, created_by)
       VALUES (gen_random_uuid(), 'live', 100000, 10, 1000, 1000, 1000000, $1, 'test-setup')`,
      [Buffer.from(sha, "hex")],
    );
  } finally {
    await su.query("RESET session_replication_role");
  }
}

describe("document vault (T-038)", () => {
  it("encrypts at rest, names the file by its hash only, returns the same bytes and logs the read", async () => {
    const doc = pdf(`offering document ${randomBytes(4).toString("hex")}`);
    const r = await vault.put(doc, "application/pdf", "test:operator");
    expect(r.storeRef).toBe(`vault://${sha256(doc).toString("hex")}`);
    expect(await vault.put(doc, "application/pdf", "test:operator")).toEqual(r);
    const sub = r.sha256.slice(0, 2);
    const files = await readdir(join(dir, sub));
    expect(files).toEqual([`${r.sha256}.bin`]);
    const stored = await readFile(join(dir, sub, `${r.sha256}.bin`));
    expect(stored.includes(Buffer.from("offering document"))).toBe(false);
    const back = await vault.get(r.sha256, "test", "operator");
    expect(back).toMatchObject({ media: "application/pdf" });
    expect(back.bytes.equals(doc)).toBe(true);
    const reads = await su.query("SELECT 1 FROM vault.reads WHERE sha256 = $1 AND purpose = 'operator'", [Buffer.from(r.sha256, "hex")]);
    expect(reads.rowCount).toBe(1);
  });

  it("refuses a changed file and a wrong master key", async () => {
    const doc = pdf("tamper target");
    const r = await vault.put(doc, "application/pdf", "test:operator");
    const other = new Vault(pool, dir, MasterKeys.of([{ version: 1, key: randomBytes(32) }], 1));
    await expect(other.get(r.sha256, "test", "operator")).rejects.toMatchObject({ code: "CORRUPT" });
    const file = join(dir, r.sha256.slice(0, 2), `${r.sha256}.bin`);
    const bytes = await readFile(file);
    bytes[0] = (bytes[0] ?? 0) ^ 1;
    await writeFile(file, bytes);
    await expect(vault.get(r.sha256, "test", "operator")).rejects.toMatchObject({ code: "CORRUPT" });
    await expect(vault.put(Buffer.from("x"), "text/html", "t")).rejects.toBeInstanceOf(VaultError);
  });

  it("the website gets only published offering documents, over HMAC, and the same answer for unpublished and unknown", async () => {
    const secret = randomBytes(32);
    const client: Client = { id: "web", secret, scope: WEB_VAULT_SCOPE };
    const server: Server = createVaultServer(vault, [client]);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    const ask = async (sha: string, c: Pick<Client, "id" | "secret"> = client) => {
      const body = JSON.stringify({ sha256: sha });
      return fetch(`${url}/v1/public-document`, { method: "POST", headers: { ...authHeaders(c, "POST", "/v1/public-document", body), "content-type": "application/json" }, body });
    };
    try {
      const published = pdf("published risk disclosure");
      const secretDoc = pdf("title deed, never public");
      const a = await vault.put(published, "application/pdf", "test:operator");
      const b = await vault.put(secretDoc, "application/pdf", "test:operator");
      await publish(a.sha256);
      const ok = await ask(a.sha256);
      expect(ok.status).toBe(200);
      expect(ok.headers.get("content-type")).toBe("application/pdf");
      expect(Buffer.from(await ok.arrayBuffer()).equals(published)).toBe(true);
      const hidden = await ask(b.sha256);
      const unknown = await ask(randomBytes(32).toString("hex"));
      expect([hidden.status, unknown.status]).toEqual([404, 404]);
      expect(await hidden.text()).toBe(await unknown.text());
      expect((await ask(a.sha256, { id: "web", secret: randomBytes(32) })).status).toBe(401);
      const logged = await su.query("SELECT client, purpose FROM vault.reads WHERE sha256 = $1", [Buffer.from(a.sha256, "hex")]);
      expect(logged.rows).toEqual([{ client: "web", purpose: "public" }]);
    } finally {
      server.close();
    }
  });

  it("the portal stores through /v1/store under the officer's handle; the website cannot store and the portal cannot read", async () => {
    const web: Client = { id: "web", secret: randomBytes(32), scope: WEB_VAULT_SCOPE };
    const portal: Client = { id: "admin-portal", secret: randomBytes(32), scope: ADMIN_VAULT_SCOPE };
    const server: Server = createVaultServer(vault, [web, portal]);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    const call = (c: Client, path: string, payload: object) => {
      const body = JSON.stringify(payload);
      return fetch(`${url}${path}`, { method: "POST", headers: { ...authHeaders(c, "POST", path, body), "content-type": "application/json" }, body });
    };
    try {
      const doc = pdf("valuation report via the portal");
      const ok = await call(portal, "/v1/store", { mediaType: "application/pdf", officer: "ops.maker.one", dataBase64: doc.toString("base64") });
      expect(ok.status).toBe(200);
      const r = (await ok.json()) as { sha256: string; storeRef: string };
      expect(r.sha256).toBe(sha256(doc).toString("hex"));
      const who = await su.query<{ created_by: string }>("SELECT created_by FROM vault.objects WHERE sha256 = $1", [Buffer.from(r.sha256, "hex")]);
      expect(who.rows[0]?.created_by).toBe("officer:ops.maker.one");
      expect((await call(web, "/v1/store", { mediaType: "application/pdf", officer: "web", dataBase64: doc.toString("base64") })).status).toBe(403);
      expect((await call(portal, "/v1/public-document", { sha256: r.sha256 })).status).toBe(403);
      expect((await call(portal, "/v1/store", { mediaType: "text/html", officer: "ops.maker.one", dataBase64: "PGgxPg==" })).status).toBe(400);
    } finally {
      server.close();
    }
  });

  it("rotation re-wraps the data keys under the new master key; files are unchanged and still read; old keys can then go", async () => {
    const v1 = keys.key(1);
    const doc = pdf("rotate me");
    const r = await vault.put(doc, "application/pdf", "test:operator");
    const file = join(dir, r.sha256.slice(0, 2), `${r.sha256}.bin`);
    const before = await readFile(file);
    const both = MasterKeys.of([{ version: 1, key: v1 }, { version: 2, key: randomBytes(32) }], 2);
    const rotated = new Vault(pool, dir, both);
    const first = await rotated.rotate();
    expect(first.rewrapped).toBeGreaterThanOrEqual(1);
    // The file changed on purpose in an earlier test keeps its old wrap and is reported, not retried forever.
    expect(first.failed).toHaveLength(1);
    expect(await rotated.rotate()).toEqual({ rewrapped: 0, failed: first.failed });
    expect((await readFile(file)).equals(before)).toBe(true);
    const onlyV2 = new Vault(pool, dir, MasterKeys.of([{ version: 2, key: both.key(2) }], 2));
    expect((await onlyV2.get(r.sha256, "test", "operator")).bytes.equals(doc)).toBe(true);
    const log = await su.query("SELECT 1 FROM vault.rewraps WHERE sha256 = $1 AND from_version = 1 AND to_version = 2", [Buffer.from(r.sha256, "hex")]);
    expect(log.rowCount).toBe(1);
    // Outside vault.rewrap an object still cannot change, and a re-wrap never goes backwards.
    await expect(su.query("UPDATE vault.objects SET key_version = 3 WHERE sha256 = $1", [Buffer.from(r.sha256, "hex")])).rejects.toMatchObject({ code: "42501" });
    await expect(pool.query("SELECT vault.rewrap($1, 2::smallint, 1::smallint, $2)", [Buffer.from(r.sha256, "hex"), randomBytes(60)])).rejects.toMatchObject({ code: "23514" });
  });

  it("is append-only, and the service login can do nothing else", async () => {
    const code = (p: Promise<unknown>) =>
      p.then(
        () => "ok",
        (e: unknown) => (e as { code?: string }).code,
      );
    expect(await code(su.query("DELETE FROM vault.objects"))).toBe("42501");
    expect(await code(su.query("UPDATE vault.reads SET client = 'x'"))).toBe("42501");
    expect(await code(pool.query("SELECT * FROM vault.objects"))).toBe("42501");
    expect(await code(pool.query("SELECT * FROM offering.offerings"))).toBe("42501");
    expect(await code(pool.query("SELECT * FROM kyc.subjects"))).toBe("42501");
  });
});

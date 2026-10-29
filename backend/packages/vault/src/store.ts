import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type pg from "pg";

/**
 * The encrypted document vault (T-038, ADR 0017, migration 0041). Each file is encrypted with its own
 * random 256-bit data key (AES-256-GCM, 12-byte nonce, tag appended to the file); the data key is
 * wrapped with the vault master key of a numbered version (AES-256-GCM: nonce | ciphertext | tag =
 * 60 bytes) and kept in vault.objects with the nonce. Files are named by the SHA-256 of their
 * PLAINTEXT under the vault directory; nothing about the content is in the file name beyond that
 * hash, which is already public (offering pages, DocumentRegistry). A read decrypts, then checks
 * the SHA-256 again before any byte leaves the vault.
 */
export const MEDIA_TYPES = ["application/pdf", "image/jpeg", "image/png", "image/tiff"] as const;
export type MediaType = (typeof MEDIA_TYPES)[number];
const MAX_BYTES = 1024 * 1024 * 1024;

export class MasterKeys {
  private constructor(
    private readonly keys: Map<number, Buffer>,
    readonly current: number,
  ) {}

  static of(entries: { version: number; key: Buffer }[], current: number): MasterKeys {
    const m = new Map<number, Buffer>();
    for (const e of entries) {
      if (!Number.isInteger(e.version) || e.version < 1 || e.version > 999 || e.key.length !== 32) throw new Error("vault master keys are 32 bytes, versions 1-999");
      m.set(e.version, e.key);
    }
    if (!m.has(current)) throw new Error("the current vault key version is not loaded");
    return new MasterKeys(m, current);
  }

  /** VAULT_MASTER_KEY_V<n> (hex, 32 bytes) and VAULT_KEY_CURRENT from the environment. Values are never echoed. */
  static fromEnv(env: Record<string, string | undefined>): MasterKeys {
    const entries: { version: number; key: Buffer }[] = [];
    for (const [k, v] of Object.entries(env)) {
      const m = /^VAULT_MASTER_KEY_V([1-9]\d{0,2})$/.exec(k);
      if (m && v) {
        if (!/^[0-9a-f]{64}$/.test(v)) throw new Error(`${k} must be 64 hex characters`);
        entries.push({ version: Number(m[1]), key: Buffer.from(v, "hex") });
      }
    }
    return MasterKeys.of(entries, Number(env.VAULT_KEY_CURRENT ?? "0"));
  }

  key(version: number): Buffer {
    const k = this.keys.get(version);
    if (!k) throw new Error(`vault master key v${String(version)} is not loaded`);
    return k;
  }
}

function gcmSeal(key: Buffer, plain: Buffer, nonce: Buffer, aad: string): Buffer {
  const c = createCipheriv("aes-256-gcm", key, nonce);
  c.setAAD(Buffer.from(aad, "utf8"));
  return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
}

function gcmOpen(key: Buffer, sealed: Buffer, nonce: Buffer, aad: string): Buffer {
  if (sealed.length < 16) throw new Error("sealed data too short");
  const d = createDecipheriv("aes-256-gcm", key, nonce);
  d.setAAD(Buffer.from(aad, "utf8"));
  d.setAuthTag(sealed.subarray(sealed.length - 16));
  return Buffer.concat([d.update(sealed.subarray(0, sealed.length - 16)), d.final()]);
}

export const sha256 = (b: Buffer): Buffer => createHash("sha256").update(b).digest();

interface StaleRow {
  sha256: Buffer;
  key_version: number;
  wrapped_key: Buffer;
}

export class VaultError extends Error {
  override name = "VaultError";
  constructor(
    readonly code: "NOT_FOUND" | "NOT_PUBLIC" | "INVALID" | "CORRUPT",
    message: string,
  ) {
    super(message);
  }
}

export class Vault {
  constructor(
    private readonly db: pg.Pool,
    private readonly dir: string,
    private readonly keys: MasterKeys,
  ) {}

  private path(sha: Buffer): string {
    const h = sha.toString("hex");
    return join(this.dir, h.slice(0, 2), `${h}.bin`);
  }

  /** Encrypts and stores one file; returns its store reference (vault://<sha256>). Same content = same object. */
  async put(plain: Buffer, media: string, actor: string): Promise<{ sha256: string; storeRef: string }> {
    if (!(MEDIA_TYPES as readonly string[]).includes(media)) throw new VaultError("INVALID", "media type must be pdf, jpeg, png or tiff");
    if (plain.length < 1 || plain.length > MAX_BYTES) throw new VaultError("INVALID", "a document is 1 byte to 1 GiB");
    const sha = sha256(plain);
    const dataKey = randomBytes(32);
    const nonce = randomBytes(12);
    const wrapNonce = randomBytes(12);
    const v = this.keys.current;
    const wrapped = Buffer.concat([wrapNonce, gcmSeal(this.keys.key(v), dataKey, wrapNonce, `pt-vault-key-v1:${sha.toString("hex")}`)]);
    const sealed = gcmSeal(dataKey, plain, nonce, `pt-vault-file-v1:${sha.toString("hex")}`);
    const file = this.path(sha);
    const existing = await this.db.query<{ n: number }>("SELECT count(*)::int AS n FROM vault.object($1)", [sha]);
    if (existing.rows[0]?.n) return { sha256: sha.toString("hex"), storeRef: `vault://${sha.toString("hex")}` };
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from a hex hash under the vault directory
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from a hex hash under the vault directory
    await writeFile(tmp, sealed, { flag: "wx" });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from a hex hash under the vault directory
    await rename(tmp, file);
    const { rows } = await this.db.query<{ r: string }>("SELECT vault.register($1, $2, $3, $4, $5, $6, $7) AS r", [
      sha,
      plain.length,
      media,
      v,
      wrapped,
      nonce,
      actor,
    ]);
    return { sha256: sha.toString("hex"), storeRef: rows[0]?.r ?? "" };
  }

  /**
   * Re-wraps every data key that is not under the current master key version (key rotation,
   * migration 0043). The files do not change: each data key is unwrapped with its old master key,
   * the file is decrypted and checked against its hash, and only then is the new wrap recorded. A
   * file that does not check out keeps its old wrap and is reported in `failed`.
   */
  async rotate(batch = 200): Promise<{ rewrapped: number; failed: string[] }> {
    const v = this.keys.current;
    let rewrapped = 0;
    const failed: string[] = [];
    let after: Buffer | null = null;
    for (;;) {
      const page: pg.QueryResult<StaleRow> = await this.db.query<StaleRow>("SELECT * FROM vault.stale($1, $2, $3)", [v, batch, after]);
      const rows: StaleRow[] = page.rows;
      if (rows.length === 0) return { rewrapped, failed };
      for (const o of rows) {
        after = o.sha256;
        const hex = o.sha256.toString("hex");
        const meta = await this.db.query<{ nonce: Buffer }>("SELECT nonce FROM vault.object($1)", [o.sha256]);
        let dataKey: Buffer;
        try {
          dataKey = gcmOpen(this.keys.key(o.key_version), o.wrapped_key.subarray(12), o.wrapped_key.subarray(0, 12), `pt-vault-key-v1:${hex}`);
          // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from a hex hash under the vault directory
          const plain = gcmOpen(dataKey, await readFile(this.path(o.sha256)), meta.rows[0]?.nonce ?? Buffer.alloc(12), `pt-vault-file-v1:${hex}`);
          if (!sha256(plain).equals(o.sha256)) throw new Error("hash");
        } catch {
          failed.push(hex);
          continue;
        }
        const wrapNonce = randomBytes(12);
        const wrapped = Buffer.concat([wrapNonce, gcmSeal(this.keys.key(v), dataKey, wrapNonce, `pt-vault-key-v1:${hex}`)]);
        await this.db.query("SELECT vault.rewrap($1, $2, $3, $4)", [o.sha256, o.key_version, v, wrapped]);
        rewrapped++;
      }
    }
  }

  /**
   * Reads one file for a client. purpose "public": only what vault.public_document allows (the
   * published offering and property documents). Every read is logged before the bytes are returned.
   */
  async get(shaHex: string, client: string, purpose: "public" | "operator"): Promise<{ bytes: Buffer; media: MediaType }> {
    if (!/^[0-9a-f]{64}$/.test(shaHex)) throw new VaultError("INVALID", "a document is named by its SHA-256 (64 hex characters)");
    const sha = Buffer.from(shaHex, "hex");
    if (purpose === "public") {
      const { rows } = await this.db.query<{ ok: boolean }>("SELECT vault.public_document($1) AS ok", [sha]);
      if (!rows[0]?.ok) throw new VaultError("NOT_PUBLIC", "this document is not published");
    }
    const { rows } = await this.db.query<{ media_type: MediaType; key_version: number; wrapped_key: Buffer; nonce: Buffer }>("SELECT * FROM vault.object($1)", [sha]);
    const o = rows[0];
    if (!o) throw new VaultError("NOT_FOUND", "the vault holds no file with this hash");
    let plain: Buffer;
    try {
      const dataKey = gcmOpen(this.keys.key(o.key_version), o.wrapped_key.subarray(12), o.wrapped_key.subarray(0, 12), `pt-vault-key-v1:${shaHex}`);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from a validated hex hash under the vault directory
      plain = gcmOpen(dataKey, await readFile(this.path(sha)), o.nonce, `pt-vault-file-v1:${shaHex}`);
    } catch {
      throw new VaultError("CORRUPT", "the stored file cannot be decrypted (missing, changed or a wrong key)");
    }
    if (!sha256(plain).equals(sha)) throw new VaultError("CORRUPT", "the stored file does not match its hash");
    await this.db.query("SELECT vault.log_read($1, $2, $3)", [sha, client, purpose]);
    return { bytes: plain, media: o.media_type };
  }
}

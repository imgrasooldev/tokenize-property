import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";

/**
 * A software WebAuthn authenticator for tests (T-030): real P-256 keys, real CBOR attestation
 * objects ("none" format), real authenticator data and ES256 signatures, so the website's
 * @simplewebauthn/server verification runs exactly as with a browser. Options let a test forge or
 * break things: another origin, no user verification, a counter that does not move, a bad signature.
 */

// ------------------------------------------------------------------ minimal CBOR (RFC 8949) encoder
type Cbor = number | string | Uint8Array | Map<Cbor, Cbor> | Cbor[];

function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 0x100) return Buffer.from([(major << 5) | 24, n]);
  if (n < 0x10000) return Buffer.from([(major << 5) | 25, n >> 8, n & 0xff]);
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(n, 1);
  return b;
}

export function cbor(v: Cbor): Buffer {
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") {
    const s = Buffer.from(v, "utf8");
    return Buffer.concat([head(3, s.length), s]);
  }
  if (v instanceof Uint8Array) return Buffer.concat([head(2, v.length), Buffer.from(v)]);
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(cbor)]);
  const parts: Buffer[] = [head(5, v.size)];
  for (const [k, x] of v) parts.push(cbor(k), cbor(x));
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------ authenticator
const b64u = (b: Uint8Array): string => Buffer.from(b).toString("base64url");
const sha256 = (b: Uint8Array | string): Buffer => createHash("sha256").update(b).digest();

interface Credential {
  id: Buffer;
  key: KeyObject;
  cose: Buffer;
  rpId: string;
  userHandle: string;
  counter: number;
}

export interface AuthenticatorOptions {
  /** Counting authenticator (security key) or one that always reports 0 (most synced passkeys). */
  counting?: boolean;
  /** Synced passkey (backup eligible and backed up). */
  synced?: boolean;
}

export interface Tamper {
  origin?: string;
  rpId?: string;
  noUserVerification?: boolean;
  /** Present this counter instead of the next one (clone detection). */
  counter?: number;
  badSignature?: boolean;
  type?: string;
}

interface CreationOptions {
  challenge: string;
  rp: { id?: string };
  user: { id: string };
}
interface RequestOptions {
  challenge: string;
  rpId?: string;
  allowCredentials?: { id: string }[];
}

export class SoftAuthenticator {
  readonly creds: Credential[] = [];
  constructor(
    readonly origin: string,
    private readonly opts: AuthenticatorOptions = {},
  ) {}

  private flags(t: Tamper, attested: boolean): number {
    let f = 0x01; // user present
    if (!t.noUserVerification) f |= 0x04;
    if (this.opts.synced) f |= 0x08 | 0x10;
    if (attested) f |= 0x40;
    return f;
  }

  private counterBytes(n: number): Buffer {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n, 0);
    return b;
  }

  /** navigator.credentials.create(): a RegistrationResponseJSON. */
  register(options: CreationOptions, t: Tamper = {}) {
    const rpId = t.rpId ?? options.rp.id ?? "localhost";
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = publicKey.export({ format: "jwk" });
    const cose = cbor(
      new Map<Cbor, Cbor>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x ?? "", "base64url")],
        [-3, Buffer.from(jwk.y ?? "", "base64url")],
      ]),
    );
    const id = randomBytes(32);
    const credIdLen = Buffer.alloc(2);
    credIdLen.writeUInt16BE(id.length, 0);
    const authData = Buffer.concat([sha256(rpId), Buffer.from([this.flags(t, true)]), this.counterBytes(0), Buffer.alloc(16), credIdLen, id, cose]);
    const attestationObject = cbor(
      new Map<Cbor, Cbor>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", authData],
      ]),
    );
    const clientDataJSON = Buffer.from(
      JSON.stringify({ type: t.type ?? "webauthn.create", challenge: options.challenge, origin: t.origin ?? this.origin, crossOrigin: false }),
    );
    this.creds.push({ id, key: privateKey, cose, rpId, userHandle: options.user.id, counter: 0 });
    return {
      id: b64u(id),
      rawId: b64u(id),
      type: "public-key" as const,
      response: { clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(attestationObject), transports: ["internal" as const] },
      clientExtensionResults: {},
      authenticatorAttachment: "platform" as const,
    };
  }

  /** navigator.credentials.get(): an AuthenticationResponseJSON (discoverable when allowCredentials is empty). */
  authenticate(options: RequestOptions, t: Tamper = {}, pick?: string) {
    const rpId = options.rpId ?? "localhost";
    const allowed = (options.allowCredentials ?? []).map((c) => c.id);
    const cred = this.creds.find((c) => (pick ? b64u(c.id) === pick : c.rpId === rpId && (allowed.length === 0 || allowed.includes(b64u(c.id)))));
    if (!cred) throw Object.assign(new Error("no credential"), { name: "NotAllowedError" });
    if (this.opts.counting && t.counter === undefined) cred.counter += 1;
    const counter = t.counter ?? (this.opts.counting ? cred.counter : 0);
    const authData = Buffer.concat([sha256(t.rpId ?? rpId), Buffer.from([this.flags(t, false)]), this.counterBytes(counter)]);
    const clientDataJSON = Buffer.from(
      JSON.stringify({ type: t.type ?? "webauthn.get", challenge: options.challenge, origin: t.origin ?? this.origin, crossOrigin: false }),
    );
    const signature = sign("sha256", Buffer.concat([authData, sha256(clientDataJSON)]), cred.key);
    if (t.badSignature) signature[signature.length - 1] = (signature[signature.length - 1] ?? 0) ^ 0xff;
    return {
      id: b64u(cred.id),
      rawId: b64u(cred.id),
      type: "public-key" as const,
      response: { clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authData), signature: b64u(signature), userHandle: cred.userHandle },
      clientExtensionResults: {},
      authenticatorAttachment: "platform" as const,
    };
  }
}

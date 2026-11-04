import { createHash, randomBytes, randomInt } from "node:crypto";
import { render } from "@pt/notify";
import type { CatalogueRepository, GrantRepository, InvestorRepository, OfferingRow } from "./repositories.ts";

/**
 * Service layer (use cases) of the public API, ADR 0018 section 3: no HTTP and no SQL here. The
 * controllers call these; the services call repository interfaces only. Output shapes are the
 * schemas of docs/api/openapi.json.
 */

export const CLIENT_ID = "pt-mobile";
export const ACCESS_SECONDS = 900;
const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ"; // RFC 8628 section 6.1: no vowels, no look-alikes
const DEVICE_GRANT_INTERVAL = 5;

export const sha256 = (s: string): Buffer => createHash("sha256").update(s, "utf8").digest();
const token = (): string => randomBytes(32).toString("base64url");
const money = (paisa: string) => ({ amount: paisa, currency: "PKR" as const });
const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/** An OAuth error (RFC 6749 section 5.2 / RFC 8628 section 3.5). */
export class OAuthError extends Error {
  constructor(
    readonly error: "invalid_request" | "invalid_client" | "invalid_grant" | "unsupported_grant_type" | "invalid_scope" | "authorization_pending" | "slow_down" | "access_denied" | "expired_token",
    readonly description?: string,
  ) {
    super(error);
  }
}

/** A cursor is opaque to clients: base64url of the next position. */
export function encodeCursor(n: bigint | number): string {
  return Buffer.from(`v1:${n.toString()}`, "utf8").toString("base64url");
}
export function decodeCursor(c: string | null): bigint | null {
  if (c === null) return null;
  const m = /^v1:([0-9]{1,19})$/.exec(Buffer.from(c, "base64url").toString("utf8"));
  if (!m?.[1]) throw new RangeError("invalid cursor");
  return BigInt(m[1]);
}

export interface Page<T> {
  data: T[];
  next_cursor: string | null;
}

function page<T>(all: T[], cursor: string | null, limit: number): Page<T> {
  const start = Number(decodeCursor(cursor) ?? 0n);
  const data = all.slice(start, start + limit);
  return { data, next_cursor: start + limit < all.length ? encodeCursor(start + limit) : null };
}

export class AuthService {
  constructor(
    private readonly grants: GrantRepository,
    private readonly verificationUri: string,
  ) {}

  async deviceAuthorization(input: { clientId: string; scope?: string | undefined; deviceName?: string | undefined }) {
    if (input.clientId !== CLIENT_ID) throw new OAuthError("invalid_client");
    if (input.scope !== undefined && input.scope !== "read") throw new OAuthError("invalid_scope", "phase 1 offers scope read only");
    const deviceCode = token();
    let raw = "";
    for (let i = 0; i < 8; i++) raw += USER_CODE_ALPHABET.charAt(randomInt(USER_CODE_ALPHABET.length));
    const userCode = `${raw.slice(0, 4)}-${raw.slice(4)}`;
    const expiresIn = await this.grants.authorize(sha256(deviceCode), raw, input.clientId, input.deviceName?.trim() || "Mobile device");
    return {
      device_code: deviceCode,
      user_code: userCode,
      verification_uri: this.verificationUri,
      verification_uri_complete: `${this.verificationUri}?code=${userCode}`,
      expires_in: expiresIn,
      interval: DEVICE_GRANT_INTERVAL,
    };
  }

  async token(input: { grantType: string; clientId: string; deviceCode?: string | undefined; refreshToken?: string | undefined }) {
    if (input.clientId !== CLIENT_ID) throw new OAuthError("invalid_client");
    const access = token();
    const refresh = token();
    if (input.grantType === "urn:ietf:params:oauth:grant-type:device_code") {
      if (!input.deviceCode) throw new OAuthError("invalid_request", "device_code is required");
      const r = await this.grants.exchange(sha256(input.deviceCode), sha256(access), sha256(refresh));
      if (r !== "ok") throw new OAuthError(r);
    } else if (input.grantType === "refresh_token") {
      if (!input.refreshToken) throw new OAuthError("invalid_request", "refresh_token is required");
      if ((await this.grants.refresh(sha256(input.refreshToken), sha256(access), sha256(refresh))) !== "ok") throw new OAuthError("invalid_grant");
    } else {
      throw new OAuthError("unsupported_grant_type");
    }
    return { access_token: access, token_type: "Bearer" as const, expires_in: ACCESS_SECONDS, refresh_token: refresh, scope: "read" as const };
  }

  async revoke(input: { clientId: string; token: string }): Promise<void> {
    if (input.clientId !== CLIENT_ID) throw new OAuthError("invalid_client");
    await this.grants.revoke(sha256(input.token));
  }
}

function offering(o: OfferingRow) {
  return {
    id: o.id,
    state: o.state,
    building: o.building,
    province: o.province,
    district: o.district,
    use: o.property_use,
    price: money(o.price_paisa),
    units: {
      hard_cap: o.hard_cap_units,
      min_raise: o.min_raise_units,
      min_per_investor: o.min_units,
      max_per_investor: o.max_units,
      paid: o.paid_units,
      available: o.available_units,
    },
    opens_at: iso(o.opens_at),
    closes_at: iso(o.closes_at),
    token: o.token ? o.token.toLowerCase() : null,
  };
}

export class CatalogueService {
  constructor(private readonly repo: CatalogueRepository) {}

  async offerings(cursor: string | null, limit: number) {
    return page((await this.repo.offerings()).map(offering), cursor, limit);
  }

  async offering(id: string) {
    const o = await this.repo.offering(id);
    return o ? offering(o) : null;
  }

  status() {
    return this.repo.status();
  }
}

export class InvestorService {
  constructor(private readonly repo: InvestorRepository) {}

  /** The SHA-256 of a live access token, or null (the database checks expiry and revocation). */
  async authenticate(accessToken: string): Promise<Buffer | null> {
    const h = sha256(accessToken);
    return (await this.repo.investorOf(h)) ? h : null;
  }

  me(h: Buffer) {
    return this.repo.me(h);
  }

  async holdings(h: Buffer, asOfBlock: string | null) {
    return { data: await this.repo.holdings(h), as_of_block: asOfBlock };
  }

  async subscriptions(h: Buffer, cursor: string | null, limit: number) {
    const rows = (await this.repo.subscriptions(h)).map((s) => ({
      id: s.id,
      offering_id: s.offering_id,
      units: s.units,
      amount: money(s.amount_paisa),
      status: s.status,
      created_at: s.created_at.toISOString(),
    }));
    return page(rows, cursor, limit);
  }

  async certificates(h: Buffer) {
    return {
      data: (await this.repo.certificates(h)).map((c) => ({ id: c.id, fiscal_year: c.fiscal_year, issued_at: c.issued_at.toISOString(), sha256: c.sha256, superseded_by: c.superseded_by })),
    };
  }

  /** Keyset pagination by id (newest first); texts rendered exactly as the e-mail would be. */
  async notifications(h: Buffer, locale: "en" | "ur", cursor: string | null, limit: number) {
    const rows = await this.repo.notifications(h, locale, decodeCursor(cursor), limit + 1);
    const data = rows.slice(0, limit).map((n) => {
      let title = n.kind;
      let body = "";
      try {
        const r = render({ kind: n.kind, channel: "email", locale, subject: n.subject, body: n.body ?? "", params: n.params });
        title = r.subject ?? n.kind;
        body = r.text;
      } catch {
        // A template that cannot be rendered is shown by its event name only (never the raw parameters).
      }
      return { id: n.id, event: n.kind, title, body, created_at: n.created_at.toISOString(), read: n.read };
    });
    const last = data.at(-1);
    return { data, next_cursor: rows.length > limit && last ? encodeCursor(BigInt(last.id)) : null };
  }
}

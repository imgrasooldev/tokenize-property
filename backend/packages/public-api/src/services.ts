import { createHash, randomBytes, randomInt } from "node:crypto";
import { render } from "@pt/notify";
import { buildTree, rentLeaf } from "@pt/tax";
import { keccak256, stringToBytes, type Address } from "viem";
import type { CatalogueRepository, GrantRepository, InvestorRepository, MarketBookRow, OfferingRow, OrderRequestRow, RequestRow } from "./repositories.ts";

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

  /** Migration 0062 (PO-1): the demo markets' order books. */
  async markets(cursor: string | null, limit: number) {
    return page((await this.repo.markets(null)).map(book), cursor, limit);
  }

  async market(symbol: string) {
    const b = (await this.repo.markets(symbol)).at(0);
    return b ? book(b) : null;
  }
}

const book = (b: MarketBookRow) => ({
  symbol: b.symbol,
  bids: b.bids.map((l) => ({ price: money(l.price_paisa), tokens: l.tokens })),
  asks: b.asks.map((l) => ({ price: money(l.price_paisa), tokens: l.tokens })),
  last_price: b.last_price_paisa === null ? null : money(b.last_price_paisa),
  last_trade_at: b.last_trade_at === null ? null : new Date(b.last_trade_at).toISOString(),
});

/** Why a request was refused (mapped to Problem Details by the HTTP layer). */
export class RequestError extends Error {
  constructor(readonly reason: "offering" | "conflict" | "limit" | "token" | "unknown" | "state") {
    super(reason);
  }
}

const userCode = (): string => {
  let raw = "";
  for (let i = 0; i < 8; i++) raw += USER_CODE_ALPHABET.charAt(randomInt(USER_CODE_ALPHABET.length));
  return raw;
};

export class InvestorService {
  constructor(
    private readonly repo: InvestorRepository,
    /** The website's confirmation page (phase 2a): the investor confirms app requests there. */
    private readonly confirmUri = "http://localhost:3100/confirm",
  ) {}

  private request(r: RequestRow) {
    const code = `${r.code.slice(0, 4)}-${r.code.slice(4)}`;
    return {
      id: r.id,
      kind: r.kind,
      offering_id: r.offering_id,
      units: r.units,
      amount: r.amount_paisa === null ? null : money(r.amount_paisa),
      status: r.status,
      confirmation_code: code,
      confirmation_uri: this.confirmUri,
      confirmation_uri_complete: `${this.confirmUri}?code=${code}`,
      created_at: new Date(r.created_at).toISOString(),
      expires_at: new Date(r.expires_at).toISOString(),
      subscription_id: r.subscription_id,
    };
  }

  /**
   * Phase 2a: asks for a reservation the investor then confirms on the website. The same
   * Idempotency-Key returns the same request (created false); a fresh code is drawn if one collides.
   */
  async requestReservation(h: Buffer, input: { offeringId: string; units: bigint; idempotencyKey: string }) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const r = await this.repo.requestReserve(h, input.offeringId, input.units, input.idempotencyKey, userCode());
      if ("error" in r) {
        if (r.error === "code") continue;
        throw new RequestError(r.error);
      }
      return { created: r.replayed !== true, body: this.request(r) };
    }
    throw new Error("no free confirmation code after 5 attempts");
  }

  /**
   * Phase 2b (migration 0061): asks to cancel an unpaid reservation or withdraw a paid subscription;
   * the investor confirms on the website. Same idempotency rules as a reservation request.
   */
  async requestChange(h: Buffer, input: { subscriptionId: string; action: "cancel" | "withdraw"; idempotencyKey: string }) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const r = await this.repo.requestChange(h, input.subscriptionId, input.action, input.idempotencyKey, userCode());
      if ("error" in r) {
        if (r.error === "code") continue;
        if (r.error === "input") throw new Error("unexpected change request action");
        throw new RequestError(r.error);
      }
      return { created: r.replayed !== true, body: this.request(r) };
    }
    throw new Error("no free confirmation code after 5 attempts");
  }

  private orderRequestView(r: OrderRequestRow) {
    const code = `${r.code.slice(0, 4)}-${r.code.slice(4)}`;
    return {
      id: r.id,
      symbol: r.symbol,
      side: r.side,
      price: money(r.price_paisa),
      tokens: r.tokens,
      total: money(r.total_paisa),
      status: r.status,
      confirmation_code: code,
      confirmation_uri: this.confirmUri,
      confirmation_uri_complete: `${this.confirmUri}?code=${code}`,
      created_at: new Date(r.created_at).toISOString(),
      expires_at: new Date(r.expires_at).toISOString(),
      order_id: r.order_id,
    };
  }

  /**
   * Phase 2b part 2 (migration 0062): asks for a limit order on the demo market; the investor
   * confirms on the website, which checks the band, cash or tokens and limits and places it.
   */
  async requestOrder(h: Buffer, input: { symbol: string; side: "buy" | "sell"; pricePaisa: bigint; tokens: bigint; idempotencyKey: string }) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const r = await this.repo.requestOrder(h, input, input.idempotencyKey, userCode());
      if ("error" in r) {
        if (r.error === "code") continue;
        if (r.error === "input") throw new Error("order request format not checked by the route");
        throw new RequestError(r.error);
      }
      return { created: r.replayed !== true, body: this.orderRequestView(r) };
    }
    throw new Error("no free confirmation code after 5 attempts");
  }

  async orderRequest(h: Buffer, id: string) {
    const r = await this.repo.orderRequest(h, id);
    return r ? this.orderRequestView(r) : null;
  }

  async orders(h: Buffer, cursor: string | null, limit: number) {
    const rows = (await this.repo.orders(h)).map((o) => ({
      id: o.id,
      symbol: o.symbol,
      side: o.side,
      price: money(o.price_paisa),
      tokens: o.tokens,
      filled: o.filled,
      status: o.status,
      created_at: o.created_at.toISOString(),
    }));
    return page(rows, cursor, limit);
  }

  async requestStatus(h: Buffer, id: string) {
    const r = await this.repo.request(h, id);
    return r ? this.request(r) : null;
  }

  async subscription(h: Buffer, id: string) {
    const s = await this.repo.subscription(h, id);
    if (!s) return null;
    const at = (v: string | null): string | null => (v ? new Date(v).toISOString() : null);
    return {
      id: s.id,
      offering_id: s.offering_id,
      units: s.units,
      amount: money(s.amount_paisa),
      status: s.status,
      created_at: new Date(s.created_at).toISOString(),
      expires_at: at(s.expires_at),
      paid_at: at(s.paid_at),
      withdrawal_until: at(s.withdrawal_until),
      payment: s.payment ? { code: s.payment.code, pay_to_account: s.payment.pay_to_account, expires_at: at(s.payment.expires_at) } : null,
    };
  }

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

  async distributions(h: Buffer, cursor: string | null, limit: number) {
    const rows = (await this.repo.distributions(h)).map((d) => ({
      token: d.token.toLowerCase(),
      distribution_id: d.onchain_id,
      period: d.period,
      record_date: d.record_date,
      status: d.status,
      units: d.units,
      gross: money(d.gross),
      withheld: money(d.wht),
      net: money(d.net),
      statement_hash: d.statement_hash.toLowerCase(),
      merkle_root: d.merkle_root.toLowerCase(),
    }));
    return page(rows, cursor, limit);
  }

  /**
   * The investor's proof, built from the published statement's own entitlements (in statement order,
   * as the reconciliation checks them); null when the investor has no paid line. The statement hash
   * is compared with the chain's, and the rebuilt root with the root on chain.
   */
  async proof(h: Buffer, token: string, onchainId: string) {
    const s = await this.repo.statement(h, token.toLowerCase(), onchainId);
    if (!s) return null;
    let entitlements: { wallet: string; netPaisa: string }[];
    try {
      const parsed = JSON.parse(s.statement) as { entitlements?: { wallet?: unknown; netPaisa?: unknown }[] };
      entitlements = (parsed.entitlements ?? []).map((e) => ({ wallet: String(e.wallet).toLowerCase(), netPaisa: String(e.netPaisa) }));
    } catch {
      return null;
    }
    const index = entitlements.findIndex((e) => e.wallet === s.wallet);
    const mine = entitlements.at(index);
    if (index < 0 || !mine) return null;
    const leaves = entitlements.map((e) => rentLeaf(e.wallet as Address, BigInt(e.netPaisa)));
    const { root, proofs } = buildTree(leaves);
    if (root.toLowerCase() !== s.merkle_root.toLowerCase()) throw new Error("the statement's entitlements do not rebuild the root on chain");
    return {
      token: token.toLowerCase(),
      distribution_id: onchainId,
      registry: s.registry.toLowerCase(),
      wallet: s.wallet,
      amount: money(mine.netPaisa),
      leaf: leaves.at(index) ?? "0x",
      proof: (proofs.at(index) ?? []).map((p) => p.toLowerCase()),
      merkle_root: root.toLowerCase(),
      statement_hash: s.statement_hash.toLowerCase(),
      statement_matches: keccak256(stringToBytes(s.statement)) === s.statement_hash.toLowerCase(),
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

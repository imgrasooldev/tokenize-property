import type pg from "pg";

/**
 * Repository layer of the public API (ADR 0018 section 3). The services depend only on these
 * interfaces; the PostgreSQL implementations call the papi.* functions of migration 0058 and
 * nothing else (the service's database login can do nothing more). Tests use in-memory fakes.
 */

export type DeviceTokenOutcome = "ok" | "authorization_pending" | "slow_down" | "access_denied" | "expired_token" | "invalid_grant";

export interface GrantRepository {
  /** Stores a new device grant; returns its lifetime in seconds. */
  authorize(deviceHash: Buffer, userCode: string, clientId: string, deviceName: string): Promise<number>;
  /** One poll of the device; on "ok" the token family exists with these hashes. */
  exchange(deviceHash: Buffer, accessHash: Buffer, refreshHash: Buffer): Promise<DeviceTokenOutcome>;
  /** Refresh-token rotation; "ok" or "invalid_grant" (also on reuse, which revokes the family). */
  refresh(refreshHash: Buffer, accessHash: Buffer, newRefreshHash: Buffer): Promise<"ok" | "invalid_grant">;
  revoke(hash: Buffer): Promise<void>;
}

export interface OfferingRow {
  id: string;
  state: string;
  token: string | null;
  building: string | null;
  province: string | null;
  district: string | null;
  property_use: string | null;
  price_paisa: string;
  hard_cap_units: string;
  min_raise_units: string;
  min_units: string;
  max_units: string;
  paid_units: string;
  available_units: string;
  opens_at: Date | null;
  closes_at: Date | null;
}

export interface StatusRow {
  as_of_block: string | null;
  indexed_at: string | null;
  reconciliation: { status: "passed" | "failed"; finished_at: string } | null;
}

/** Migration 0062 (PO-1): one demo-market order book by price level and the last settled trade. */
export interface MarketBookRow {
  symbol: string;
  bids: { price_paisa: string; tokens: string }[];
  asks: { price_paisa: string; tokens: string }[];
  last_price_paisa: string | null;
  last_trade_at: string | null;
}

export interface CatalogueRepository {
  offerings(): Promise<OfferingRow[]>;
  offering(id: string): Promise<OfferingRow | null>;
  /** Every symbol with a demo market, or the one given. */
  markets(symbol: string | null): Promise<MarketBookRow[]>;
  status(): Promise<StatusRow>;
}

export interface MeRow {
  id: string;
  display_name: string;
  wallet: string;
  kyc: "verified" | "pending" | "review" | "expired" | "rejected";
  residency: { status: "resident" | "non_resident"; document: "cnic" | "nicop" | "poc"; country: number | null };
  support_reference: string | null;
}

export interface HoldingRow {
  token: string;
  units: string;
  frozen_units: string;
}

export interface SubscriptionRow {
  id: string;
  offering_id: string;
  units: string;
  amount_paisa: string;
  status: string;
  created_at: Date;
}

export interface CertificateRow {
  id: string;
  fiscal_year: number;
  issued_at: Date;
  sha256: string;
  superseded_by: string | null;
}

export interface NotificationRow {
  id: string;
  kind: string;
  params: Record<string, unknown>;
  created_at: Date;
  read: boolean;
  subject: string | null;
  body: string | null;
}

export interface DistributionRow {
  token: string;
  onchain_id: string;
  period: string;
  record_date: string;
  status: "published" | "finalized" | "paid";
  units: string;
  gross: string;
  wht: string;
  net: string;
  statement_hash: string;
  merkle_root: string;
}

export interface StatementRow {
  wallet: string;
  registry: string;
  statement: string;
  statement_hash: string;
  merkle_root: string;
}

/** Phase 2a/2b (migrations 0060, 0061): an app request the investor confirms on the website. */
export interface RequestRow {
  id: string;
  kind: "reserve" | "cancel" | "withdraw";
  offering_id: string;
  units: string;
  amount_paisa: string | null;
  status: "pending" | "confirmed" | "declined" | "expired";
  code: string;
  created_at: string;
  expires_at: string;
  subscription_id: string | null;
  replayed?: boolean;
}

export type RequestRefusal = "token" | "offering" | "conflict" | "limit" | "code";

/** Migration 0062: an order request the investor confirms on the website (resource OrderRequest). */
export interface OrderRequestRow {
  id: string;
  /** order: place an order; order_cancel (migration 0063): cancel target_order_id. */
  kind: "order" | "order_cancel";
  symbol: string;
  side: "buy" | "sell";
  price_paisa: string;
  tokens: string;
  total_paisa: string;
  status: "pending" | "confirmed" | "declined" | "expired";
  code: string;
  created_at: string;
  expires_at: string;
  order_id: string | null;
  target_order_id?: string | null;
  replayed?: boolean;
}

export type OrderRefusal = "token" | "input" | "conflict" | "limit" | "code";

/** Migration 0064: a request to add demo cash, confirmed on the website (resource TopUpRequest). */
export interface TopUpRequestRow {
  id: string;
  kind: "topup";
  amount_paisa: string;
  status: "pending" | "confirmed" | "declined" | "expired";
  code: string;
  created_at: string;
  expires_at: string;
  topup_id: string | null;
  replayed?: boolean;
}

export type TopUpRefusal = "token" | "input" | "conflict" | "limit" | "code";

/** Migration 0064: the investor's demo-market cash as the ledger has it. */
export interface CashRow {
  available_paisa: string;
  in_orders_paisa: string;
}

/** Migration 0063: why a cancellation request for an order was refused ("order": not the investor's open order). */
export type OrderCancelRefusal = "token" | "order" | "conflict" | "limit" | "code";

export interface OrderRow {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  price_paisa: string;
  tokens: string;
  filled: string;
  status: "open" | "filled" | "cancelled";
  created_at: Date;
}

/** Why a cancel / withdraw request was refused (migration 0061). */
export type ChangeRefusal = "token" | "input" | "unknown" | "state" | "conflict" | "limit" | "code";

export interface SubscriptionDetailRow {
  id: string;
  offering_id: string;
  units: string;
  amount_paisa: string;
  status: string;
  created_at: string;
  expires_at: string | null;
  paid_at: string | null;
  withdrawal_until: string | null;
  payment: { code: string; pay_to_account: string | null; expires_at: string | null } | null;
}

/** Every method takes the SHA-256 of the access token; the database checks it and scopes the data. */
export interface InvestorRepository {
  investorOf(accessHash: Buffer): Promise<string | null>;
  me(accessHash: Buffer): Promise<MeRow | null>;
  holdings(accessHash: Buffer): Promise<HoldingRow[]>;
  subscriptions(accessHash: Buffer): Promise<SubscriptionRow[]>;
  certificates(accessHash: Buffer): Promise<CertificateRow[]>;
  notifications(accessHash: Buffer, locale: "en" | "ur", before: bigint | null, limit: number): Promise<NotificationRow[]>;
  distributions(accessHash: Buffer): Promise<DistributionRow[]>;
  statement(accessHash: Buffer, token: string, onchainId: string): Promise<StatementRow | null>;
  /** A new reservation request, the one already made with this key, or why not. */
  requestReserve(accessHash: Buffer, offeringId: string, units: bigint, idempotencyKey: string, code: string): Promise<RequestRow | { error: RequestRefusal }>;
  requestChange(accessHash: Buffer, subscriptionId: string, action: "cancel" | "withdraw", idempotencyKey: string, code: string): Promise<RequestRow | { error: ChangeRefusal }>;
  request(accessHash: Buffer, id: string): Promise<RequestRow | null>;
  requestOrder(
    accessHash: Buffer,
    order: { symbol: string; side: "buy" | "sell"; pricePaisa: bigint; tokens: bigint },
    idempotencyKey: string,
    code: string,
  ): Promise<OrderRequestRow | { error: OrderRefusal }>;
  /** Migration 0063: a request to cancel one of the investor's open orders. */
  requestOrderCancel(accessHash: Buffer, orderId: string, idempotencyKey: string, code: string): Promise<OrderRequestRow | { error: OrderCancelRefusal }>;
  orderRequest(accessHash: Buffer, id: string): Promise<OrderRequestRow | null>;
  /** Migration 0064: demo cash, a top-up request and its status. */
  cash(accessHash: Buffer): Promise<CashRow | null>;
  requestTopUp(accessHash: Buffer, amountPaisa: bigint, idempotencyKey: string, code: string): Promise<TopUpRequestRow | { error: TopUpRefusal }>;
  topUpRequest(accessHash: Buffer, id: string): Promise<TopUpRequestRow | null>;
  orders(accessHash: Buffer): Promise<OrderRow[]>;
  subscription(accessHash: Buffer, id: string): Promise<SubscriptionDetailRow | null>;
}

/** Push devices (migration 0065): the investor's notification recipient and the sealed token. */
export type PushOutcome = "ok" | "token" | "recipient" | "input";

export interface PushRepository {
  /** The notification recipient of the token's investor (null: no live token or no KYC subject). */
  recipient(accessHash: Buffer, locale: "en" | "ur"): Promise<string | null>;
  register(accessHash: Buffer, recipientId: string, platform: "android" | "ios", lookupHash: Buffer, sealed: Buffer): Promise<PushOutcome>;
  /** false without a live access token. */
  unregister(accessHash: Buffer): Promise<boolean>;
}

export interface Repositories {
  grants: GrantRepository;
  catalogue: CatalogueRepository;
  investors: InvestorRepository;
  push: PushRepository;
}

const OFFERING_COLUMNS =
  "id, state, token, building, province, district, property_use, price_paisa::text, hard_cap_units::text, min_raise_units::text, min_units::text, max_units::text, paid_units::text, available_units::text, opens_at, closes_at";

export function pgRepositories(db: pg.Pool): Repositories {
  const one = async <T extends pg.QueryResultRow>(sql: string, params: unknown[]): Promise<T | undefined> => (await db.query<T>(sql, params)).rows[0];
  return {
    grants: {
      authorize: async (deviceHash, userCode, clientId, deviceName) =>
        (await one<{ s: number }>("SELECT papi.device_authorize($1, $2, $3, $4) AS s", [deviceHash, userCode, clientId, deviceName]))?.s ?? 0,
      exchange: async (deviceHash, accessHash, refreshHash) =>
        ((await one<{ r: string }>("SELECT papi.device_token($1, $2, $3) AS r", [deviceHash, accessHash, refreshHash]))?.r ?? "invalid_grant") as DeviceTokenOutcome,
      refresh: async (refreshHash, accessHash, newRefreshHash) =>
        (await one<{ r: string }>("SELECT papi.refresh($1, $2, $3) AS r", [refreshHash, accessHash, newRefreshHash]))?.r === "ok" ? "ok" : "invalid_grant",
      revoke: async (hash) => {
        await db.query("SELECT papi.revoke($1)", [hash]);
      },
    },
    catalogue: {
      offerings: async () => (await db.query<OfferingRow>(`SELECT ${OFFERING_COLUMNS} FROM papi.offerings(NULL)`)).rows,
      offering: async (id) => (await one<OfferingRow>(`SELECT ${OFFERING_COLUMNS} FROM papi.offerings($1)`, [id])) ?? null,
      markets: async (symbol) => (await db.query<{ book: MarketBookRow }>("SELECT book FROM papi.markets($1)", [symbol])).rows.map((r) => r.book),
      status: async () => (await one<{ s: StatusRow }>("SELECT papi.status() AS s", []))?.s ?? { as_of_block: null, indexed_at: null, reconciliation: null },
    },
    investors: {
      investorOf: async (h) => (await one<{ i: string | null }>("SELECT papi.token_investor($1) AS i", [h]))?.i ?? null,
      me: async (h) => (await one<{ m: MeRow | null }>("SELECT papi.me($1) AS m", [h]))?.m ?? null,
      holdings: async (h) => (await db.query<HoldingRow>("SELECT token, units, frozen_units FROM papi.holdings($1)", [h])).rows,
      subscriptions: async (h) =>
        (await db.query<SubscriptionRow>("SELECT id, offering_id, units::text, amount_paisa::text, status, created_at FROM papi.subscriptions($1)", [h])).rows,
      certificates: async (h) =>
        (await db.query<CertificateRow>("SELECT id::text, fiscal_year, issued_at, sha256, superseded_by::text FROM papi.tax_certificates($1)", [h])).rows,
      notifications: async (h, locale, before, limit) =>
        (
          await db.query<NotificationRow>("SELECT id::text, kind, params, created_at, read, subject, body FROM papi.notifications($1, $2, $3, $4)", [
            h,
            locale,
            before === null ? null : before.toString(),
            limit,
          ])
        ).rows,
      distributions: async (h) =>
        (
          await db.query<DistributionRow>(
            "SELECT token, onchain_id, period, to_char(record_date, 'YYYY-MM-DD') AS record_date, status, units, gross::text, wht::text, net::text, statement_hash, merkle_root FROM papi.distributions($1)",
            [h],
          )
        ).rows,
      statement: async (h, token, onchainId) =>
        (await one<StatementRow>("SELECT wallet, registry, statement, statement_hash, merkle_root FROM papi.distribution_statement($1, $2, $3)", [h, token, onchainId])) ?? null,
      requestReserve: async (h, offeringId, units, key, code) =>
        (await one<{ r: RequestRow | { error: RequestRefusal } }>("SELECT papi.request_reserve($1, $2, $3, $4, $5) AS r", [h, offeringId, units.toString(), key, code]))?.r ?? {
          error: "token",
        },
      requestChange: async (h, sub, action, key, code) =>
        (await one<{ r: RequestRow | { error: ChangeRefusal } }>("SELECT papi.request_change($1, $2, $3, $4, $5) AS r", [h, sub, action, key, code]))?.r ?? {
          error: "token",
        },
      requestOrder: async (h, o, key, code) =>
        (
          await one<{ r: OrderRequestRow | { error: OrderRefusal } }>("SELECT papi.request_order($1, $2, $3, $4, $5, $6, $7) AS r", [
            h,
            o.symbol,
            o.side,
            o.pricePaisa.toString(),
            o.tokens.toString(),
            key,
            code,
          ])
        )?.r ?? { error: "token" },
      requestOrderCancel: async (h, order, key, code) =>
        (await one<{ r: OrderRequestRow | { error: OrderCancelRefusal } }>("SELECT papi.request_order_cancel($1, $2, $3, $4) AS r", [h, order, key, code]))?.r ?? {
          error: "token",
        },
      orderRequest: async (h, id) => (await one<{ r: OrderRequestRow | null }>("SELECT papi.order_request($1, $2) AS r", [h, id]))?.r ?? null,
      cash: async (h) => (await one<{ r: CashRow | null }>("SELECT papi.cash($1) AS r", [h]))?.r ?? null,
      requestTopUp: async (h, amount, key, code) =>
        (await one<{ r: TopUpRequestRow | { error: TopUpRefusal } }>("SELECT papi.request_topup($1, $2, $3, $4) AS r", [h, amount.toString(), key, code]))?.r ?? {
          error: "token",
        },
      topUpRequest: async (h, id) => (await one<{ r: TopUpRequestRow | null }>("SELECT papi.topup_request($1, $2) AS r", [h, id]))?.r ?? null,
      orders: async (h) =>
        (await db.query<OrderRow>("SELECT id, symbol, side, price_paisa::text, tokens::text, filled::text, status, created_at FROM papi.orders($1)", [h])).rows,
      request: async (h, id) => (await one<{ r: RequestRow | null }>("SELECT papi.request($1, $2) AS r", [h, id]))?.r ?? null,
      subscription: async (h, id) => (await one<{ r: SubscriptionDetailRow | null }>("SELECT papi.subscription($1, $2) AS r", [h, id]))?.r ?? null,
    },
    push: {
      recipient: async (h, locale) => (await one<{ r: string | null }>("SELECT papi.push_recipient($1, $2)::text AS r", [h, locale]))?.r ?? null,
      register: async (h, recipient, platform, lookupHash, sealed) =>
        (await one<{ r: PushOutcome }>("SELECT papi.register_push($1, $2, $3, $4, $5) AS r", [h, recipient, platform, lookupHash, sealed]))?.r ?? "token",
      unregister: async (h) => (await one<{ r: boolean }>("SELECT papi.unregister_push($1) AS r", [h]))?.r ?? false,
    },
  };
}

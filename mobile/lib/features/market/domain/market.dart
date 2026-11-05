import 'package:equatable/equatable.dart';
import 'package:property_token_app/features/invest/domain/invest.dart';

/// One price level of the demo market's order book (schema MarketBook).
class BookLevel extends Equatable {
  const BookLevel({required this.pricePaisa, required this.tokens});

  factory BookLevel.fromJson(Map<String, dynamic> j) =>
      BookLevel(pricePaisa: (j['price'] as Map<String, dynamic>)['amount'] as String, tokens: j['tokens'] as String);

  final String pricePaisa;
  final String tokens;

  @override
  List<Object?> get props => [pricePaisa, tokens];
}

class MarketBook extends Equatable {
  const MarketBook({required this.symbol, required this.bids, required this.asks, this.lastPricePaisa});

  factory MarketBook.fromJson(Map<String, dynamic> j) => MarketBook(
    symbol: j['symbol'] as String,
    bids: (j['bids'] as List<dynamic>).map((e) => BookLevel.fromJson(e as Map<String, dynamic>)).toList(),
    asks: (j['asks'] as List<dynamic>).map((e) => BookLevel.fromJson(e as Map<String, dynamic>)).toList(),
    lastPricePaisa: (j['last_price'] as Map<String, dynamic>?)?['amount'] as String?,
  );

  final String symbol;

  /// Best first: highest buy price, lowest sell price.
  final List<BookLevel> bids;
  final List<BookLevel> asks;
  final String? lastPricePaisa;

  @override
  List<Object?> get props => [symbol, bids, asks, lastPricePaisa];
}

/// One of the investor's own orders (schema Order).
class MarketOrder extends Equatable {
  const MarketOrder({
    required this.id,
    required this.symbol,
    required this.side,
    required this.pricePaisa,
    required this.tokens,
    required this.filled,
    required this.status,
  });

  factory MarketOrder.fromJson(Map<String, dynamic> j) => MarketOrder(
    id: j['id'] as String,
    symbol: j['symbol'] as String,
    side: j['side'] as String,
    pricePaisa: (j['price'] as Map<String, dynamic>)['amount'] as String,
    tokens: j['tokens'] as String,
    filled: j['filled'] as String,
    status: j['status'] as String,
  );

  final String id;
  final String symbol;

  /// buy or sell.
  final String side;
  final String pricePaisa;
  final String tokens;
  final String filled;

  /// open, filled or cancelled.
  final String status;

  @override
  List<Object?> get props => [id, status, filled];
}

/// The investor's demo-market cash (schema Cash, ADR 0018 amendment 5).
class Cash extends Equatable {
  const Cash({required this.availablePaisa, required this.inOrdersPaisa});

  factory Cash.fromJson(Map<String, dynamic> j) => Cash(
    availablePaisa: (j['available'] as Map<String, dynamic>)['amount'] as String,
    inOrdersPaisa: (j['in_orders'] as Map<String, dynamic>)['amount'] as String,
  );

  final String availablePaisa;

  /// Held in the escrow of open buy orders.
  final String inOrdersPaisa;

  @override
  List<Object?> get props => [availablePaisa, inOrdersPaisa];
}

/// The markets, the investor's orders and cash, for the market screen.
class MarketData extends Equatable {
  const MarketData({required this.markets, required this.orders, this.cash});

  final List<MarketBook> markets;
  final List<MarketOrder> orders;
  final Cash? cash;

  @override
  List<Object?> get props => [markets, orders, cash];
}

/// A demo cash top-up the app asked for; the investor confirms it on the
/// website (schema TopUpRequest, ADR 0018 amendment 5).
class TopUpRequest extends Equatable implements WebsiteConfirmation {
  const TopUpRequest({
    required this.id,
    required this.amountPaisa,
    required this.status,
    required this.code,
    required this.confirmUriComplete,
    required this.expiresAt,
    required this.topUpId,
  });

  factory TopUpRequest.fromJson(Map<String, dynamic> j) => TopUpRequest(
    id: j['id'] as String,
    amountPaisa: (j['amount'] as Map<String, dynamic>)['amount'] as String,
    status: j['status'] as String,
    code: j['confirmation_code'] as String,
    confirmUriComplete: j['confirmation_uri_complete'] as String,
    expiresAt: DateTime.parse(j['expires_at'] as String),
    topUpId: j['topup_id'] as String?,
  );

  final String id;
  final String amountPaisa;

  /// pending, confirmed, declined or expired.
  final String status;
  @override
  final String code;
  @override
  final String confirmUriComplete;
  @override
  final DateTime expiresAt;
  final String? topUpId;

  bool get pending => status == 'pending';

  @override
  List<Object?> get props => [id, status, topUpId];
}

/// A limit order the app asked for, or the cancellation of an open one; the
/// investor confirms it on the website (schema OrderRequest, ADR 0018
/// amendments 3 and 4).
class OrderRequest extends Equatable implements WebsiteConfirmation {
  const OrderRequest({
    required this.id,
    required this.symbol,
    required this.side,
    required this.pricePaisa,
    required this.tokens,
    required this.totalPaisa,
    required this.status,
    required this.code,
    required this.confirmUriComplete,
    required this.expiresAt,
    required this.orderId,
    this.kind = 'order',
    this.targetOrderId,
  });

  factory OrderRequest.fromJson(Map<String, dynamic> j) => OrderRequest(
    id: j['id'] as String,
    symbol: j['symbol'] as String,
    side: j['side'] as String,
    pricePaisa: (j['price'] as Map<String, dynamic>)['amount'] as String,
    tokens: j['tokens'] as String,
    totalPaisa: (j['total'] as Map<String, dynamic>)['amount'] as String,
    status: j['status'] as String,
    code: j['confirmation_code'] as String,
    confirmUriComplete: j['confirmation_uri_complete'] as String,
    expiresAt: DateTime.parse(j['expires_at'] as String),
    orderId: j['order_id'] as String?,
    kind: j['kind'] as String? ?? 'order',
    targetOrderId: j['target_order_id'] as String?,
  );

  final String id;
  final String symbol;
  final String side;
  final String pricePaisa;
  final String tokens;
  final String totalPaisa;

  /// pending, confirmed, declined or expired.
  final String status;
  @override
  final String code;
  @override
  final String confirmUriComplete;
  @override
  final DateTime expiresAt;
  final String? orderId;

  /// order (place) or order_cancel (cancel [targetOrderId]).
  final String kind;
  final String? targetOrderId;

  bool get pending => status == 'pending';

  @override
  List<Object?> get props => [id, status, orderId];
}

abstract interface class MarketRepository {
  /// Every market with its book, and the investor's own orders.
  Future<MarketData> overview();

  /// Asks for a limit order; the same [idempotencyKey] returns the same request.
  Future<OrderRequest> requestOrder({
    required String symbol,
    required String side,
    required String pricePaisa,
    required String tokens,
    required String idempotencyKey,
  });

  /// Asks to cancel one of the investor's open orders (ADR 0018 amendment 4).
  Future<OrderRequest> requestOrderCancel({required String orderId, required String idempotencyKey});

  Future<OrderRequest> orderRequest(String id);

  /// Asks for a demo cash top-up of [amountPaisa] (whole rupees).
  Future<TopUpRequest> requestTopUp({required String amountPaisa, required String idempotencyKey});

  Future<TopUpRequest> topUpRequest(String id);
}

/// "505", "505.5" or "505.25" rupees to paisa as a string; null for anything else (no floats).
String? rupeesToPaisa(String input) {
  final m = RegExp(r'^([1-9][0-9]{0,6})(?:\.([0-9]{1,2}))?$').firstMatch(input.trim());
  if (m == null) return null;
  return (BigInt.parse(m.group(1)!) * BigInt.from(100) + BigInt.parse((m.group(2) ?? '').padRight(2, '0'))).toString();
}

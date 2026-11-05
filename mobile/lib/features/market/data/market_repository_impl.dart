import 'package:property_token_app/core/network/api_client.dart';
import 'package:property_token_app/features/market/domain/market.dart';

/// `GET /v1/markets`, `GET /v1/me/orders`, `POST /v1/me/order-requests`,
/// `POST /v1/me/orders/{id}/cancel-requests` (ADR 0018 amendments 3 and 4).
class MarketRepositoryImpl implements MarketRepository {
  MarketRepositoryImpl(this._api);

  final ApiClient _api;

  @override
  Future<MarketData> overview() async {
    final markets = await _api.get('/markets', auth: false);
    final orders = await _api.get('/me/orders', query: {'limit': '50'});
    return MarketData(
      markets: (markets['data'] as List<dynamic>).map((e) => MarketBook.fromJson(e as Map<String, dynamic>)).toList(),
      orders: (orders['data'] as List<dynamic>).map((e) => MarketOrder.fromJson(e as Map<String, dynamic>)).toList(),
    );
  }

  @override
  Future<OrderRequest> requestOrder({
    required String symbol,
    required String side,
    required String pricePaisa,
    required String tokens,
    required String idempotencyKey,
  }) async => OrderRequest.fromJson(
    await _api.postJson('/me/order-requests', {
      'symbol': symbol,
      'side': side,
      'price': {'amount': pricePaisa, 'currency': 'PKR'},
      'tokens': tokens,
    }, idempotencyKey: idempotencyKey),
  );

  @override
  Future<OrderRequest> requestOrderCancel({required String orderId, required String idempotencyKey}) async =>
      OrderRequest.fromJson(
        await _api.postJson('/me/orders/$orderId/cancel-requests', {}, idempotencyKey: idempotencyKey),
      );

  @override
  Future<OrderRequest> orderRequest(String id) async => OrderRequest.fromJson(await _api.get('/me/order-requests/$id'));
}

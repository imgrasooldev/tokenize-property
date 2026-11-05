import 'package:property_token_app/core/network/api_client.dart';
import 'package:property_token_app/features/invest/domain/invest.dart';

/// Reservation requests over the public API (phase 2a, ADR 0018 amendment 1).
class InvestRepositoryImpl implements InvestRepository {
  InvestRepositoryImpl(this._api);

  final ApiClient _api;

  @override
  Future<SubscriptionRequest> requestReservation({
    required String offeringId,
    required String units,
    required String idempotencyKey,
  }) async => SubscriptionRequest.fromJson(
    await _api.postJson('/me/subscription-requests', {
      'offering_id': offeringId,
      'units': units,
    }, idempotencyKey: idempotencyKey),
  );

  @override
  Future<SubscriptionRequest> request(String id) async =>
      SubscriptionRequest.fromJson(await _api.get('/me/subscription-requests/$id'));

  @override
  Future<SubscriptionDetail> subscription(String id) async =>
      SubscriptionDetail.fromJson(await _api.get('/me/subscriptions/$id'));
}

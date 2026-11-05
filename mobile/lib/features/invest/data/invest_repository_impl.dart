import 'package:property_token_app/core/network/api_client.dart';
import 'package:property_token_app/features/invest/domain/invest.dart';

/// App requests over the public API (phases 2a and 2b, ADR 0018 amendments 1 and 2).
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
  Future<SubscriptionRequest> requestChange({
    required String subscriptionId,
    required String action,
    required String idempotencyKey,
  }) async => SubscriptionRequest.fromJson(
    await _api.postJson('/me/subscriptions/$subscriptionId/change-requests', {
      'action': action,
    }, idempotencyKey: idempotencyKey),
  );

  @override
  Future<SubscriptionRequest> request(String id) async =>
      SubscriptionRequest.fromJson(await _api.get('/me/subscription-requests/$id'));

  @override
  Future<SubscriptionDetail> subscription(String id) async =>
      SubscriptionDetail.fromJson(await _api.get('/me/subscriptions/$id'));
}

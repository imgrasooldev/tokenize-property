import 'package:property_token_app/core/network/api_client.dart';
import 'package:property_token_app/features/offerings/domain/offering.dart';

/// `GET /v1/offerings`, all pages (the catalogue is small; cursor pagination per RFC 8288).
class OfferingsRepositoryImpl implements OfferingsRepository {
  OfferingsRepositoryImpl(this._api);

  final ApiClient _api;

  @override
  Future<List<Offering>> offerings() async {
    final all = <Offering>[];
    String? cursor;
    do {
      final j = await _api.get('/offerings', query: {'limit': '50', 'cursor': ?cursor}, auth: false);
      all.addAll((j['data'] as List<dynamic>).map((e) => Offering.fromJson(e as Map<String, dynamic>)));
      cursor = j['next_cursor'] as String?;
    } while (cursor != null);
    return all;
  }
}

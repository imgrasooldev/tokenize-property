import 'package:property_token_app/core/network/api_client.dart';
import 'package:property_token_app/features/rent/domain/rent.dart';

/// `GET /v1/me/distributions` (first page, newest first) and `.../{token}/{id}/proof`.
class RentRepositoryImpl implements RentRepository {
  RentRepositoryImpl(this._api);

  final ApiClient _api;

  @override
  Future<List<RentDistribution>> distributions() async {
    final j = await _api.get('/me/distributions', query: {'limit': '50'});
    return (j['data'] as List<dynamic>).map((e) => RentDistribution.fromJson(e as Map<String, dynamic>)).toList();
  }

  @override
  Future<RentProof> proof(RentDistribution d) async =>
      RentProof.fromJson(await _api.get('/me/distributions/${d.token}/${d.distributionId}/proof'));
}

import 'package:property_token_app/core/network/api_client.dart';
import 'package:property_token_app/features/portfolio/domain/portfolio.dart';

/// `GET /v1/me/holdings` and `/v1/me/subscriptions` (first page; newest first).
class PortfolioRepositoryImpl implements PortfolioRepository {
  PortfolioRepositoryImpl(this._api);

  final ApiClient _api;

  @override
  Future<Portfolio> portfolio() async {
    final results = await Future.wait([
      _api.get('/me/holdings'),
      _api.get('/me/subscriptions', query: {'limit': '20'}),
    ]);
    final holdings = results[0];
    final subs = results[1];
    return Portfolio(
      holdings: (holdings['data'] as List<dynamic>).map((e) => Holding.fromJson(e as Map<String, dynamic>)).toList(),
      subscriptions: (subs['data'] as List<dynamic>)
          .map((e) => Subscription.fromJson(e as Map<String, dynamic>))
          .toList(),
      asOfBlock: holdings['as_of_block'] as String?,
    );
  }
}

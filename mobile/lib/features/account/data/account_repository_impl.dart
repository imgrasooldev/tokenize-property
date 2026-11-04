import 'package:property_token_app/core/network/api_client.dart';
import 'package:property_token_app/features/account/domain/me.dart';

/// `GET /v1/me`.
class AccountRepositoryImpl implements AccountRepository {
  AccountRepositoryImpl(this._api);

  final ApiClient _api;

  @override
  Future<Me> me() async => Me.fromJson(await _api.get('/me'));
}

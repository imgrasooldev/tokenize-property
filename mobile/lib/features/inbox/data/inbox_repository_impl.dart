import 'package:property_token_app/core/network/api_client.dart';
import 'package:property_token_app/features/inbox/domain/message.dart';

/// `GET /v1/me/notifications` with keyset cursors (the API's Accept-Language decides the texts).
class InboxRepositoryImpl implements InboxRepository {
  InboxRepositoryImpl(this._api);

  final ApiClient _api;

  @override
  Future<MessagePage> page({String? cursor}) async {
    final j = await _api.get('/me/notifications', query: {'limit': '20', 'cursor': ?cursor});
    return MessagePage(
      (j['data'] as List<dynamic>).map((e) => Message.fromJson(e as Map<String, dynamic>)).toList(),
      j['next_cursor'] as String?,
    );
  }
}

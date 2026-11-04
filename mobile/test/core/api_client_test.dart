import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:property_token_app/core/network/api_client.dart';
import 'package:property_token_app/core/storage/token_store.dart';
import 'package:property_token_app/features/account/data/account_repository_impl.dart';
import 'package:property_token_app/features/inbox/data/inbox_repository_impl.dart';
import 'package:property_token_app/features/offerings/data/offerings_repository_impl.dart';

/// The data layer against a fake HTTP server speaking the contract of docs/api/openapi.json.
void main() {
  const old = TokenPair(accessToken: 'a1', refreshToken: 'r1');
  final me = {
    'id': '7d1e2b0c-0000-4000-8000-000000000001',
    'display_name': 'Ayesha',
    'kyc': 'review',
    'wallet': '0x${'1' * 40}',
    'residency': {'status': 'non_resident', 'document': 'nicop', 'country': 784},
    'support_reference': 'deadbeef',
  };

  test('a 401 rotates the refresh token once and repeats the request', () async {
    final tokens = MemoryTokenStore();
    await tokens.write(old);
    final seen = <String>[];
    final client = MockClient((req) async {
      seen.add('${req.method} ${req.url.path} ${req.headers['authorization'] ?? ''}');
      if (req.url.path == '/v1/oauth/token') {
        expect(req.bodyFields, {'grant_type': 'refresh_token', 'refresh_token': 'r1', 'client_id': 'pt-mobile'});
        return http.Response(
          jsonEncode({
            'access_token': 'a2',
            'token_type': 'Bearer',
            'expires_in': 900,
            'refresh_token': 'r2',
            'scope': 'read',
          }),
          200,
        );
      }
      if (req.headers['authorization'] == 'Bearer a1') {
        return http.Response(
          jsonEncode({'type': 'about:blank', 'title': 'Sign in again', 'status': 401, 'code': 'invalid_token'}),
          401,
        );
      }
      return http.Response(jsonEncode(me), 200);
    });
    final api = ApiClient(baseUrl: Uri.parse('http://api/v1'), tokens: tokens, client: client);
    final m = await AccountRepositoryImpl(api).me();
    expect(m.nonResident, isTrue);
    expect(m.kyc, 'review');
    expect(seen, ['GET /v1/me Bearer a1', 'POST /v1/oauth/token ', 'GET /v1/me Bearer a2']);
    expect(await tokens.read(), const TokenPair(accessToken: 'a2', refreshToken: 'r2'));
  });

  test('a refused refresh token signs the device out (reuse detection on the server)', () async {
    final tokens = MemoryTokenStore();
    await tokens.write(old);
    final client = MockClient(
      (req) async => req.url.path == '/v1/oauth/token'
          ? http.Response(jsonEncode({'error': 'invalid_grant'}), 400)
          : http.Response(
              jsonEncode({'type': 'about:blank', 'title': 'x', 'status': 401, 'code': 'invalid_token'}),
              401,
            ),
    );
    final api = ApiClient(baseUrl: Uri.parse('http://api/v1'), tokens: tokens, client: client);
    await expectLater(
      AccountRepositoryImpl(api).me(),
      throwsA(isA<ApiException>().having((e) => e.unauthorized, 'unauthorized', isTrue)),
    );
    expect(await tokens.read(), isNull);
  });

  test('offerings follow next_cursor; notifications send the language', () async {
    final client = MockClient((req) async {
      if (req.url.path == '/v1/offerings') {
        final cursor = req.url.queryParameters['cursor'];
        final item = {
          'id': '7d1e2b0c-0000-4000-8000-00000000000${cursor == null ? 1 : 2}',
          'state': 'live',
          'building': cursor == null ? 'Gulberg Tower' : 'DHA Plaza',
          'province': 'Punjab',
          'district': 'Lahore',
          'use': 'commercial',
          'price': {'amount': '100000', 'currency': 'PKR'},
          'units': {
            'hard_cap': '1000',
            'min_raise': '100',
            'min_per_investor': '1',
            'max_per_investor': '100',
            'paid': '0',
            'available': '1000',
          },
          'opens_at': null,
          'closes_at': '2026-12-01T00:00:00.000Z',
          'token': null,
        };
        return http.Response(
          jsonEncode({
            'data': [item],
            'next_cursor': cursor == null ? 'djE6MQ' : null,
          }),
          200,
        );
      }
      expect(req.headers['accept-language'], 'ur');
      return http.Response(
        jsonEncode({
          'data': [
            {
              'id': '9',
              'event': 'x',
              'title': 'عنوان',
              'body': 'متن',
              'created_at': '2026-11-04T00:00:00.000Z',
              'read': false,
            },
          ],
          'next_cursor': null,
        }),
        200,
        headers: {'content-type': 'application/json; charset=utf-8'},
      );
    });
    final tokens = MemoryTokenStore();
    await tokens.write(old);
    final api = ApiClient(baseUrl: Uri.parse('http://api/v1'), tokens: tokens, client: client, language: 'ur');
    final offerings = await OfferingsRepositoryImpl(api).offerings();
    expect(offerings.map((o) => o.title), ['Gulberg Tower', 'DHA Plaza']);
    final inbox = await InboxRepositoryImpl(api).page();
    expect(inbox.items.single.title, 'عنوان');
  });

  test('no network is an ApiException with status 0', () async {
    final api = ApiClient(
      baseUrl: Uri.parse('http://api/v1'),
      tokens: MemoryTokenStore(),
      client: MockClient((_) async => throw http.ClientException('down')),
    );
    await expectLater(
      OfferingsRepositoryImpl(api).offerings(),
      throwsA(isA<ApiException>().having((e) => e.status, 'status', 0)),
    );
  });
}

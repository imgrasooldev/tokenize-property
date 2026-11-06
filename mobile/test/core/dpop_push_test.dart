import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:pointycastle/export.dart';
import 'package:property_token_app/core/network/api_client.dart';
import 'package:property_token_app/core/network/dpop.dart';
import 'package:property_token_app/core/push/push_registrar.dart';
import 'package:property_token_app/core/storage/token_store.dart';

Map<String, dynamic> _part(String jwt, int i) =>
    jsonDecode(utf8.decode(base64Url.decode(base64Url.normalize(jwt.split('.')[i])))) as Map<String, dynamic>;

BigInt _int(String b64) =>
    base64Url.decode(base64Url.normalize(b64)).fold(BigInt.zero, (v, b) => (v << 8) | BigInt.from(b));

/// Checks an ES256 proof with the public key in its own header (as the server does).
bool _verifies(String jwt) {
  final jwk = _part(jwt, 0)['jwk'] as Map<String, dynamic>;
  final curve = ECCurve_secp256r1();
  final q = curve.curve.createPoint(_int(jwk['x'] as String), _int(jwk['y'] as String));
  final sig = base64Url.decode(base64Url.normalize(jwt.split('.')[2]));
  final verifier = ECDSASigner(SHA256Digest())..init(false, PublicKeyParameter<ECPublicKey>(ECPublicKey(q, curve)));
  final input = Uint8List.fromList(ascii.encode('${jwt.split('.')[0]}.${jwt.split('.')[1]}'));
  final r = sig.sublist(0, 32).fold(BigInt.zero, (BigInt v, b) => (v << 8) | BigInt.from(b));
  final s = sig.sublist(32).fold(BigInt.zero, (BigInt v, b) => (v << 8) | BigInt.from(b));
  return verifier.verifySignature(input, ECSignature(r, s));
}

class _FakeSource implements PushTokenSource {
  _FakeSource({this.allowed = true});

  final bool allowed;
  final refresh = StreamController<String>.broadcast();

  @override
  String get platform => 'android';

  @override
  Future<bool> requestPermission() async => allowed;

  @override
  Future<String?> token() async => 'fcm-token-1:${'x' * 40}';

  @override
  Stream<String> get onTokenRefresh => refresh.stream;
}

/// DPoP (ADR 0018 amendment 7, RFC 9449) and push registration (amendment 6) against a fake server.
void main() {
  test(
    'DPoP: the token request carries a proof; calls send the DPoP scheme with a signed proof of the same key',
    () async {
      final tokens = MemoryTokenStore();
      await tokens.write(const TokenPair(accessToken: 'a1', refreshToken: 'r1'));
      final proofs = <http.BaseRequest>[];
      final client = MockClient((req) async {
        proofs.add(req);
        if (req.url.path == '/v1/oauth/token') {
          return http.Response(
            jsonEncode({
              'access_token': 'a2',
              'token_type': 'DPoP',
              'expires_in': 900,
              'refresh_token': 'r2',
              'scope': 'read',
            }),
            200,
          );
        }
        if (req.headers['authorization'] == 'DPoP a1') {
          return http.Response(
            jsonEncode({'status': 401, 'code': 'invalid_token', 'title': 'x', 'type': 'about:blank'}),
            401,
          );
        }
        return http.Response(jsonEncode({'data': <Object>[], 'next_cursor': null}), 200);
      });
      final keys = MemoryDpopKeyStore();
      final api = ApiClient(
        baseUrl: Uri.parse('http://api.test/v1'),
        tokens: tokens,
        client: client,
        dpop: EcDpopSigner(keys),
      );
      await api.get('/me/holdings', query: {'limit': '5'});

      expect(proofs.map((r) => '${r.method} ${r.url.path} ${r.headers['authorization'] ?? ''}'), [
        'GET /v1/me/holdings DPoP a1',
        'POST /v1/oauth/token ',
        'GET /v1/me/holdings DPoP a2',
      ]);
      final token = proofs[1].headers['dpop']!;
      final call = proofs[2].headers['dpop']!;
      expect(_part(token, 0), containsPair('typ', 'dpop+jwt'));
      expect(
        _part(token, 1),
        allOf(containsPair('htm', 'POST'), containsPair('htu', 'http://api.test/v1/oauth/token')),
      );
      expect(_part(token, 1).containsKey('ath'), isFalse);
      expect(_part(call, 1), allOf(containsPair('htm', 'GET'), containsPair('htu', 'http://api.test/v1/me/holdings')));
      expect(
        _part(call, 1)['ath'],
        base64Url.encode(SHA256Digest().process(Uint8List.fromList(ascii.encode('a2')))).replaceAll('=', ''),
      );
      expect(_part(call, 1)['jti'], isNot(_part(token, 1)['jti']));
      expect(_verifies(token), isTrue);
      expect(_verifies(call), isTrue);
      // The key is kept: a new signer with the same store proves with the same key.
      final again = await EcDpopSigner(
        keys,
      ).proof(method: 'GET', url: Uri.parse('http://api.test/v1/me'), accessToken: 'a2');
      expect(_part(again, 0)['jwk'], _part(call, 0)['jwk']);
    },
  );

  test(
    'push: registers the token after permission, again on refresh, and removes the device; failures are quiet',
    () async {
      final tokens = MemoryTokenStore();
      await tokens.write(const TokenPair(accessToken: 'a1', refreshToken: 'r1'));
      final seen = <String>[];
      var answer = 204;
      final client = MockClient((req) async {
        seen.add('${req.method} ${req.url.path} ${req.body}');
        return http.Response(
          answer == 204
              ? ''
              : jsonEncode({'status': answer, 'code': 'push_unavailable', 'title': 'x', 'type': 'about:blank'}),
          answer,
        );
      });
      final api = ApiClient(baseUrl: Uri.parse('http://api.test/v1'), tokens: tokens, client: client);
      final source = _FakeSource();
      final push = PushRegistrar(api, source);
      await push.register();
      source.refresh.add('fcm-token-2:${'y' * 40}');
      await Future<void>.delayed(Duration.zero);
      await push.unregister();
      expect(seen, [
        'PUT /v1/me/push-device {"platform":"android","token":"fcm-token-1:${'x' * 40}"}',
        'PUT /v1/me/push-device {"platform":"android","token":"fcm-token-2:${'y' * 40}"}',
        'DELETE /v1/me/push-device ',
      ]);

      seen.clear();
      await PushRegistrar(api, _FakeSource(allowed: false)).register();
      expect(seen, isEmpty);
      answer = 503;
      await PushRegistrar(api, _FakeSource()).register(); // a server without push never stops the app
      expect(seen, hasLength(1));
    },
  );
}

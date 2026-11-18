import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:property_token_app/core/network/dpop.dart';
import 'package:property_token_app/core/storage/token_store.dart';

/// An error answer of the API: RFC 9457 problem details or an RFC 6749
/// OAuth error (ADR 0018, docs/api/openapi.json).
class ApiException implements Exception {
  const ApiException(this.status, this.code, [this.detail]);

  /// HTTP status; 0 when the server could not be reached.
  final int status;

  /// The problem's `code` or the OAuth `error`.
  final String code;
  final String? detail;

  bool get unauthorized => status == 401;

  @override
  String toString() => 'ApiException($status, $code)';
}

/// HTTP client of the public API `/v1`. Sends the access token, refreshes it
/// once on a 401 (the refresh token rotates, RFC 9700) and turns error answers
/// into [ApiException]s. Repositories are the only users of this class.
///
/// With a [dpop] signer (ADR 0018 amendment 7, RFC 9449) every token request
/// carries a proof of the phone's key, so the tokens are bound to it, and every
/// signed-in call uses `Authorization: DPoP` with a fresh proof. Without one it
/// sends Bearer tokens as before.
class ApiClient {
  ApiClient({required this.baseUrl, required this.tokens, http.Client? client, this.language = 'en', this.dpop})
    : _http = client ?? http.Client();

  static const clientId = 'pt-mobile';

  final Uri baseUrl;
  final TokenStore tokens;
  final http.Client _http;

  /// `en` or `ur`, sent as Accept-Language.
  String language;

  final DpopSigner? dpop;

  Future<void>? _refreshing;

  Uri _uri(String path, [Map<String, String>? query]) => baseUrl.replace(
    path: '${baseUrl.path.replaceAll(RegExp(r'/$'), '')}$path',
    queryParameters: query == null || query.isEmpty ? null : query,
  );

  Map<String, String> get _headers => {'accept': 'application/json', 'accept-language': language};

  /// The signed-in headers of one request: Bearer, or DPoP with a proof for this method and URL.
  Future<Map<String, String>> _auth(String method, Uri uri) async {
    final access = (await tokens.read())?.accessToken;
    if (access == null) return const {};
    final signer = dpop;
    if (signer == null) return {'authorization': 'Bearer $access'};
    return {'authorization': 'DPoP $access', 'dpop': await signer.proof(method: method, url: uri, accessToken: access)};
  }

  /// A form POST to an OAuth endpoint; returns the JSON object.
  Future<Map<String, dynamic>> postForm(String path, Map<String, String> fields) async {
    final uri = _uri(path);
    final signer = dpop;
    // RFC 9449 section 5: a proof at the token endpoint binds the new tokens to this phone's key.
    final proof = signer != null && path == '/oauth/token' ? await signer.proof(method: 'POST', url: uri) : null;
    final http.Response res;
    try {
      res = await _http.post(
        uri,
        headers: {..._headers, 'content-type': 'application/x-www-form-urlencoded', 'dpop': ?proof},
        body: fields,
      );
    } on Exception {
      throw const ApiException(0, 'unreachable');
    }
    final body = res.body.isEmpty ? <String, dynamic>{} : jsonDecode(res.body) as Map<String, dynamic>;
    if (res.statusCode != 200) {
      throw ApiException(
        res.statusCode,
        (body['error'] ?? body['code'] ?? 'error') as String,
        body['error_description'] as String?,
      );
    }
    return body;
  }

  /// A GET; signed in when [auth] is true.
  Future<Map<String, dynamic>> get(String path, {Map<String, String>? query, bool auth = true}) async {
    var res = await _send(path, query, auth: auth);
    if (res.statusCode == 401 && auth && await _refresh()) res = await _send(path, query, auth: auth);
    final body = res.body.isEmpty ? <String, dynamic>{} : jsonDecode(res.body) as Map<String, dynamic>;
    if (res.statusCode != 200) {
      throw ApiException(res.statusCode, (body['code'] ?? 'error') as String, body['detail'] as String?);
    }
    return body;
  }

  /// A signed-in JSON POST that creates something (phase 2a). The same
  /// [idempotencyKey] makes a retry return the first answer instead of a
  /// second request (IETF Idempotency-Key header); 200 and 201 are both success.
  Future<Map<String, dynamic>> postJson(
    String path,
    Map<String, Object?> body, {
    required String idempotencyKey,
  }) async {
    Future<http.Response> send() async {
      final uri = _uri(path);
      final auth = await _auth('POST', uri);
      try {
        return await _http.post(
          uri,
          headers: {..._headers, 'content-type': 'application/json', 'idempotency-key': idempotencyKey, ...auth},
          body: jsonEncode(body),
        );
      } on Exception {
        throw const ApiException(0, 'unreachable');
      }
    }

    var res = await send();
    if (res.statusCode == 401 && await _refresh()) res = await send();
    final json = res.body.isEmpty ? <String, dynamic>{} : jsonDecode(res.body) as Map<String, dynamic>;
    if (res.statusCode != 200 && res.statusCode != 201) {
      throw ApiException(res.statusCode, (json['code'] ?? 'error') as String, json['detail'] as String?);
    }
    return json;
  }

  /// A signed-in request without an answer body (push device, migration 0065): PUT with a JSON
  /// [body] or DELETE; 204 is success.
  Future<void> sendNoContent(String method, String path, [Map<String, Object?>? body]) async {
    Future<http.Response> send() async {
      final uri = _uri(path);
      final request = http.Request(method, uri)
        ..headers.addAll({
          ..._headers,
          ...await _auth(method, uri),
          if (body != null) 'content-type': 'application/json',
        });
      if (body != null) request.body = jsonEncode(body);
      try {
        return await http.Response.fromStream(await _http.send(request));
      } on Exception {
        throw const ApiException(0, 'unreachable');
      }
    }

    var res = await send();
    if (res.statusCode == 401 && await _refresh()) res = await send();
    if (res.statusCode != 204 && res.statusCode != 200) {
      final json = res.body.isEmpty ? <String, dynamic>{} : jsonDecode(res.body) as Map<String, dynamic>;
      throw ApiException(res.statusCode, (json['code'] ?? 'error') as String, json['detail'] as String?);
    }
  }

  Future<http.Response> _send(String path, Map<String, String>? query, {required bool auth}) async {
    final uri = _uri(path, query);
    final headers = auth ? await _auth('GET', uri) : const <String, String>{};
    try {
      return await _http.get(uri, headers: {..._headers, ...headers});
    } on Exception {
      throw const ApiException(0, 'unreachable');
    }
  }

  /// Rotates the token pair; false (and signed out) when the refresh token is no longer valid.
  Future<bool> _refresh() async {
    final current = _refreshing;
    if (current != null) {
      await current;
      return await tokens.read() != null;
    }
    final saved = await tokens.read();
    if (saved == null) return false;
    final future = () async {
      try {
        final t = await postForm('/oauth/token', {
          'grant_type': 'refresh_token',
          'refresh_token': saved.refreshToken,
          'client_id': clientId,
        });
        await tokens.write(TokenPair.fromJson(t));
      } on ApiException catch (e) {
        if (e.status != 0) await tokens.clear();
      }
    }();
    _refreshing = future;
    try {
      await future;
    } finally {
      _refreshing = null;
    }
    return await tokens.read() != null;
  }
}

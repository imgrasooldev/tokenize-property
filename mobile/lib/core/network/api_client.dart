import 'dart:convert';

import 'package:http/http.dart' as http;
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

/// HTTP client of the public API `/v1`. Sends the bearer token, refreshes it
/// once on a 401 (the refresh token rotates, RFC 9700) and turns error answers
/// into [ApiException]s. Repositories are the only users of this class.
class ApiClient {
  ApiClient({required this.baseUrl, required this.tokens, http.Client? client, this.language = 'en'})
    : _http = client ?? http.Client();

  static const clientId = 'pt-mobile';

  final Uri baseUrl;
  final TokenStore tokens;
  final http.Client _http;

  /// `en` or `ur`, sent as Accept-Language.
  String language;

  Future<void>? _refreshing;

  Uri _uri(String path, [Map<String, String>? query]) => baseUrl.replace(
    path: '${baseUrl.path.replaceAll(RegExp(r'/$'), '')}$path',
    queryParameters: query == null || query.isEmpty ? null : query,
  );

  Map<String, String> get _headers => {'accept': 'application/json', 'accept-language': language};

  /// A form POST to an OAuth endpoint; returns the JSON object.
  Future<Map<String, dynamic>> postForm(String path, Map<String, String> fields) async {
    final http.Response res;
    try {
      res = await _http.post(
        _uri(path),
        headers: {..._headers, 'content-type': 'application/x-www-form-urlencoded'},
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

  Future<http.Response> _send(String path, Map<String, String>? query, {required bool auth}) async {
    final access = auth ? (await tokens.read())?.accessToken : null;
    try {
      return await _http.get(
        _uri(path, query),
        headers: {..._headers, if (access != null) 'authorization': 'Bearer $access'},
      );
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

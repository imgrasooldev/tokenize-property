import 'dart:convert';

import 'package:equatable/equatable.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// The OAuth token pair of this device (ADR 0018): never in shared
/// preferences, only in the platform keystore (Android Keystore, iOS Keychain).
class TokenPair extends Equatable {
  const TokenPair({required this.accessToken, required this.refreshToken});

  factory TokenPair.fromJson(Map<String, dynamic> j) =>
      TokenPair(accessToken: j['access_token'] as String, refreshToken: j['refresh_token'] as String);

  final String accessToken;
  final String refreshToken;

  Map<String, String> toJson() => {'access_token': accessToken, 'refresh_token': refreshToken};

  @override
  List<Object?> get props => [accessToken, refreshToken];
}

abstract interface class TokenStore {
  Future<TokenPair?> read();
  Future<void> write(TokenPair pair);
  Future<void> clear();
}

class SecureTokenStore implements TokenStore {
  SecureTokenStore([FlutterSecureStorage? storage]) : _storage = storage ?? const FlutterSecureStorage();

  static const _key = 'pt.tokens.v1';
  final FlutterSecureStorage _storage;

  @override
  Future<TokenPair?> read() async {
    final raw = await _storage.read(key: _key);
    if (raw == null) return null;
    try {
      return TokenPair.fromJson(jsonDecode(raw) as Map<String, dynamic>);
    } on FormatException {
      await clear();
      return null;
    }
  }

  @override
  Future<void> write(TokenPair pair) => _storage.write(key: _key, value: jsonEncode(pair.toJson()));

  @override
  Future<void> clear() => _storage.delete(key: _key);
}

/// For tests and for previews.
class MemoryTokenStore implements TokenStore {
  TokenPair? _pair;

  @override
  Future<TokenPair?> read() async => _pair;

  @override
  Future<void> write(TokenPair pair) async => _pair = pair;

  @override
  Future<void> clear() async => _pair = null;
}

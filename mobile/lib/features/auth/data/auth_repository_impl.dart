import 'dart:async';

import 'package:property_token_app/core/network/api_client.dart';
import 'package:property_token_app/core/push/push_registrar.dart';
import 'package:property_token_app/core/storage/token_store.dart';
import 'package:property_token_app/features/auth/domain/auth_repository.dart';

/// OAuth 2.0 Device Authorization Grant against `/v1/oauth/*` (RFC 8628,
/// RFC 7009). Tokens go to the keystore only. With a [PushRegistrar] the phone
/// is registered for notices once signed in and removed before sign-out.
class AuthRepositoryImpl implements AuthRepository {
  AuthRepositoryImpl(this._api, this._tokens, [this._push]);

  final ApiClient _api;
  final TokenStore _tokens;
  final PushRegistrar? _push;

  @override
  Future<bool> isSignedIn() async {
    final signedIn = await _tokens.read() != null;
    if (signedIn) unawaited(_push?.register());
    return signedIn;
  }

  @override
  Future<DeviceCode> start(String deviceName) async {
    final j = await _api.postForm('/oauth/device_authorization', {
      'client_id': ApiClient.clientId,
      'scope': 'read',
      'device_name': deviceName,
    });
    return DeviceCode(
      deviceCode: j['device_code'] as String,
      userCode: j['user_code'] as String,
      verificationUri: j['verification_uri'] as String,
      verificationUriComplete: j['verification_uri_complete'] as String,
      interval: Duration(seconds: j['interval'] as int),
      expiresIn: Duration(seconds: j['expires_in'] as int),
    );
  }

  @override
  Future<PollResult> poll(DeviceCode code) async {
    try {
      final j = await _api.postForm('/oauth/token', {
        'grant_type': 'urn:ietf:params:oauth:grant-type:device_code',
        'device_code': code.deviceCode,
        'client_id': ApiClient.clientId,
      });
      await _tokens.write(TokenPair.fromJson(j));
      unawaited(_push?.register());
      return PollResult.approved;
    } on ApiException catch (e) {
      return switch (e.code) {
        'authorization_pending' => PollResult.pending,
        'slow_down' => PollResult.slowDown,
        'access_denied' => PollResult.denied,
        'expired_token' || 'invalid_grant' => PollResult.expired,
        _ => throw e,
      };
    }
  }

  @override
  Future<void> signOut() async {
    await _push?.unregister();
    final t = await _tokens.read();
    await _tokens.clear();
    if (t == null) return;
    try {
      await _api.postForm('/oauth/revoke', {
        'token': t.refreshToken,
        'token_type_hint': 'refresh_token',
        'client_id': ApiClient.clientId,
      });
    } on ApiException {
      // Signed out on the device either way; the website's linked-devices list can remove it too.
    }
  }
}

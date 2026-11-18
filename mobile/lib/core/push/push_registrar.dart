import 'dart:async';

import 'package:property_token_app/core/network/api_client.dart';

/// Where the phone's push token comes from (Firebase Cloud Messaging in the
/// app, a fake in tests).
abstract interface class PushTokenSource {
  /// `android` or `ios`.
  String get platform;

  /// Asks the investor once (Android 13+, iOS); false when refused.
  Future<bool> requestPermission();

  /// The current registration token, or null when there is none yet.
  Future<String?> token();

  /// New tokens (the push service rotates them now and then).
  Stream<String> get onTokenRefresh;
}

/// Registers this phone for notices after sign-in and removes it before
/// sign-out (ADR 0018 amendment 6: `PUT` / `DELETE /v1/me/push-device`).
/// Push is optional: a refusal, a server without push (503) or an unverified
/// account (409) never stops the app.
class PushRegistrar {
  PushRegistrar(this._api, this._source);

  final ApiClient _api;
  final PushTokenSource _source;
  StreamSubscription<String>? _refresh;

  Future<void> register() async {
    try {
      if (!await _source.requestPermission()) return;
      final token = await _source.token();
      if (token == null) return;
      await _put(token);
    } on Exception {
      return;
    }
    _refresh ??= _source.onTokenRefresh.listen((t) => unawaited(_put(t).catchError((Object _) {})));
  }

  Future<void> unregister() async {
    await _refresh?.cancel();
    _refresh = null;
    try {
      await _api.sendNoContent('DELETE', '/me/push-device');
    } on Exception {
      // Signing out ends the device's push on the server anyway (token revocation, migration 0065 PN-4).
    }
  }

  Future<void> _put(String token) =>
      _api.sendNoContent('PUT', '/me/push-device', {'platform': _source.platform, 'token': token});
}

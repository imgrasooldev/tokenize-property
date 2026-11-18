import 'dart:io';

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:property_token_app/core/push/push_registrar.dart';

/// Firebase project `property-token` (ADR 0018 amendment 6). The options come
/// from the build, not from google-services.json, so the app builds without
/// Firebase: push is off unless `--dart-define=FIREBASE_API_KEY=...` is given
/// (the Android API key of the project; never committed).
const _apiKey = String.fromEnvironment('FIREBASE_API_KEY');
const _appId = String.fromEnvironment(
  'FIREBASE_APP_ID',
  defaultValue: '1:1076431946582:android:708d49575b826a7f00ccf7',
);
const _senderId = String.fromEnvironment('FIREBASE_SENDER_ID', defaultValue: '1076431946582');
const _projectId = String.fromEnvironment('FIREBASE_PROJECT_ID', defaultValue: 'property-token');

/// Firebase Cloud Messaging as the app's [PushTokenSource].
class FirebasePushTokenSource implements PushTokenSource {
  FirebasePushTokenSource._();

  /// Starts Firebase; null when push is not configured or Firebase cannot start.
  static Future<FirebasePushTokenSource?> start() async {
    if (_apiKey.isEmpty || !(Platform.isAndroid || Platform.isIOS)) return null;
    try {
      await Firebase.initializeApp(
        options: const FirebaseOptions(
          apiKey: _apiKey,
          appId: _appId,
          messagingSenderId: _senderId,
          projectId: _projectId,
        ),
      );
      return FirebasePushTokenSource._();
    } on Exception {
      return null;
    }
  }

  @override
  String get platform => Platform.isIOS ? 'ios' : 'android';

  @override
  Future<bool> requestPermission() async {
    final s = await FirebaseMessaging.instance.requestPermission();
    return s.authorizationStatus == AuthorizationStatus.authorized ||
        s.authorizationStatus == AuthorizationStatus.provisional;
  }

  @override
  // The server sends to registration tokens (FCM HTTP v1 `message.token`, migration 0065); the
  // plugin's newer installation-id API needs a server change first.
  // ignore: deprecated_member_use
  Future<String?> token() => FirebaseMessaging.instance.getToken();

  @override
  // As above: registration tokens until the server sends to installation ids.
  // ignore: deprecated_member_use
  Stream<String> get onTokenRefresh => FirebaseMessaging.instance.onTokenRefresh;
}

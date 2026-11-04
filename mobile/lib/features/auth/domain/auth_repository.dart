import 'package:equatable/equatable.dart';

/// What the investor sees while signing in (RFC 8628 device authorization response).
class DeviceCode extends Equatable {
  const DeviceCode({
    required this.deviceCode,
    required this.userCode,
    required this.verificationUri,
    required this.verificationUriComplete,
    required this.interval,
    required this.expiresIn,
  });

  final String deviceCode;
  final String userCode;
  final String verificationUri;
  final String verificationUriComplete;
  final Duration interval;
  final Duration expiresIn;

  @override
  List<Object?> get props => [deviceCode, userCode];
}

/// One poll of the token endpoint, in domain terms.
enum PollResult { pending, slowDown, approved, denied, expired }

abstract interface class AuthRepository {
  Future<bool> isSignedIn();
  Future<DeviceCode> start(String deviceName);
  Future<PollResult> poll(DeviceCode code);
  Future<void> signOut();
}

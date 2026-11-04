import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:property_token_app/core/network/api_client.dart';
import 'package:property_token_app/features/auth/domain/auth_repository.dart';

sealed class AuthEvent extends Equatable {
  const AuthEvent();
  @override
  List<Object?> get props => [];
}

/// App start: is a token pair stored?
final class AuthStarted extends AuthEvent {
  const AuthStarted();
}

final class AuthSignInRequested extends AuthEvent {
  const AuthSignInRequested(this.deviceName);
  final String deviceName;
  @override
  List<Object?> get props => [deviceName];
}

final class AuthSignOutRequested extends AuthEvent {
  const AuthSignOutRequested();
}

/// The API answered 401 after a failed refresh: the device was signed out elsewhere.
final class AuthExpired extends AuthEvent {
  const AuthExpired();
}

sealed class AuthState extends Equatable {
  const AuthState();
  @override
  List<Object?> get props => [];
}

final class AuthUnknown extends AuthState {
  const AuthUnknown();
}

final class AuthSignedOut extends AuthState {
  const AuthSignedOut([this.reason]);
  final AuthFailure? reason;
  @override
  List<Object?> get props => [reason];
}

final class AuthAwaitingApproval extends AuthState {
  const AuthAwaitingApproval(this.code);
  final DeviceCode code;
  @override
  List<Object?> get props => [code];
}

final class AuthSignedIn extends AuthState {
  const AuthSignedIn();
}

enum AuthFailure { denied, expired, network }

/// Sign-in with the Device Authorization Grant (RFC 8628): shows the code,
/// polls at the server's interval (slower after slow_down) until approved,
/// denied or expired. The delay function is injected so tests do not wait.
class AuthBloc extends Bloc<AuthEvent, AuthState> {
  AuthBloc(this._repo, {Future<void> Function(Duration)? delay})
    : _delay = delay ?? Future<void>.delayed,
      super(const AuthUnknown()) {
    on<AuthStarted>((_, emit) async => emit(await _repo.isSignedIn() ? const AuthSignedIn() : const AuthSignedOut()));
    on<AuthSignInRequested>(_signIn);
    on<AuthSignOutRequested>((_, emit) async {
      await _repo.signOut();
      emit(const AuthSignedOut());
    });
    on<AuthExpired>((_, emit) => emit(const AuthSignedOut(AuthFailure.expired)));
  }

  final AuthRepository _repo;
  final Future<void> Function(Duration) _delay;

  Future<void> _signIn(AuthSignInRequested e, Emitter<AuthState> emit) async {
    final DeviceCode code;
    try {
      code = await _repo.start(e.deviceName);
    } on ApiException {
      emit(const AuthSignedOut(AuthFailure.network));
      return;
    }
    emit(AuthAwaitingApproval(code));
    var interval = code.interval;
    final deadline = DateTime.now().add(code.expiresIn);
    while (!isClosed && DateTime.now().isBefore(deadline)) {
      await _delay(interval);
      if (isClosed || state is! AuthAwaitingApproval) return;
      final PollResult r;
      try {
        r = await _repo.poll(code);
      } on ApiException {
        continue; // a lost connection does not end the attempt; the next poll tries again
      }
      switch (r) {
        case PollResult.pending:
          break;
        case PollResult.slowDown:
          interval += const Duration(seconds: 5); // RFC 8628 section 3.5
        case PollResult.approved:
          emit(const AuthSignedIn());
          return;
        case PollResult.denied:
          emit(const AuthSignedOut(AuthFailure.denied));
          return;
        case PollResult.expired:
          emit(const AuthSignedOut(AuthFailure.expired));
          return;
      }
    }
    if (!isClosed && state is AuthAwaitingApproval) emit(const AuthSignedOut(AuthFailure.expired));
  }
}

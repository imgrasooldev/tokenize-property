import 'package:bloc_test/bloc_test.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:property_token_app/core/network/api_client.dart';
import 'package:property_token_app/features/auth/domain/auth_repository.dart';
import 'package:property_token_app/features/auth/presentation/auth_bloc.dart';

class _MockAuth extends Mock implements AuthRepository {}

const _code = DeviceCode(
  deviceCode: 'dc',
  userCode: 'BCDF-GHJK',
  verificationUri: 'http://x/device',
  verificationUriComplete: 'http://x/device?code=BCDF-GHJK',
  interval: Duration(seconds: 5),
  expiresIn: Duration(minutes: 10),
);

void main() {
  late _MockAuth repo;
  final waits = <Duration>[];
  Future<void> noWait(Duration d) async => waits.add(d);

  setUpAll(() => registerFallbackValue(_code));
  setUp(() {
    repo = _MockAuth();
    waits.clear();
  });

  blocTest<AuthBloc, AuthState>(
    'starts signed in when a token pair is stored',
    build: () {
      when(() => repo.isSignedIn()).thenAnswer((_) async => true);
      return AuthBloc(repo, delay: noWait);
    },
    act: (b) => b.add(const AuthStarted()),
    expect: () => [const AuthSignedIn()],
  );

  blocTest<AuthBloc, AuthState>(
    'shows the code, waits while pending, slows down on slow_down (RFC 8628 3.5), then signs in',
    build: () {
      final answers = [PollResult.pending, PollResult.slowDown, PollResult.approved];
      when(() => repo.start(any())).thenAnswer((_) async => _code);
      when(() => repo.poll(any())).thenAnswer((_) async => answers.removeAt(0));
      return AuthBloc(repo, delay: noWait);
    },
    act: (b) => b.add(const AuthSignInRequested('phone')),
    expect: () => [const AuthAwaitingApproval(_code), const AuthSignedIn()],
    verify: (_) => expect(waits, [const Duration(seconds: 5), const Duration(seconds: 5), const Duration(seconds: 10)]),
  );

  blocTest<AuthBloc, AuthState>(
    'a denied code ends the attempt with the reason',
    build: () {
      when(() => repo.start(any())).thenAnswer((_) async => _code);
      when(() => repo.poll(any())).thenAnswer((_) async => PollResult.denied);
      return AuthBloc(repo, delay: noWait);
    },
    act: (b) => b.add(const AuthSignInRequested('phone')),
    expect: () => [const AuthAwaitingApproval(_code), const AuthSignedOut(AuthFailure.denied)],
  );

  blocTest<AuthBloc, AuthState>(
    'a lost connection while polling does not end the attempt',
    build: () {
      var n = 0;
      when(() => repo.start(any())).thenAnswer((_) async => _code);
      when(() => repo.poll(any())).thenAnswer((_) async {
        if (n++ == 0) throw const ApiException(0, 'unreachable');
        return PollResult.approved;
      });
      return AuthBloc(repo, delay: noWait);
    },
    act: (b) => b.add(const AuthSignInRequested('phone')),
    expect: () => [const AuthAwaitingApproval(_code), const AuthSignedIn()],
  );

  blocTest<AuthBloc, AuthState>(
    'no connection at the start says so',
    build: () {
      when(() => repo.start(any())).thenThrow(const ApiException(0, 'unreachable'));
      return AuthBloc(repo, delay: noWait);
    },
    act: (b) => b.add(const AuthSignInRequested('phone')),
    expect: () => [const AuthSignedOut(AuthFailure.network)],
  );

  blocTest<AuthBloc, AuthState>(
    'sign-out revokes and returns to the sign-in screen',
    build: () {
      when(() => repo.signOut()).thenAnswer((_) async {});
      return AuthBloc(repo, delay: noWait);
    },
    act: (b) => b.add(const AuthSignOutRequested()),
    expect: () => [const AuthSignedOut()],
    verify: (_) => verify(() => repo.signOut()).called(1),
  );
}

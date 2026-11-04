import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:property_token_app/app/app.dart';
import 'package:property_token_app/features/account/domain/me.dart';
import 'package:property_token_app/features/auth/domain/auth_repository.dart';
import 'package:property_token_app/features/auth/presentation/auth_bloc.dart';
import 'package:property_token_app/features/inbox/domain/message.dart';
import 'package:property_token_app/features/offerings/domain/offering.dart';
import 'package:property_token_app/features/portfolio/domain/portfolio.dart';

/// The whole app with in-memory repositories (the repository pattern's seam): sign-in with the
/// device code, the four tabs, the theme switch and Urdu right-to-left.
class _FakeAuth implements AuthRepository {
  _FakeAuth({required this.signedIn});
  bool signedIn;
  @override
  Future<bool> isSignedIn() async => signedIn;
  @override
  Future<DeviceCode> start(String deviceName) async => const DeviceCode(
    deviceCode: 'dc',
    userCode: 'BCDF-GHJK',
    verificationUri: 'http://51.79.144.40/device',
    verificationUriComplete: 'http://51.79.144.40/device?code=BCDF-GHJK',
    interval: Duration(seconds: 5),
    expiresIn: Duration(minutes: 10),
  );
  @override
  Future<PollResult> poll(DeviceCode code) async => PollResult.approved;
  @override
  Future<void> signOut() async => signedIn = false;
}

class _FakeOfferings implements OfferingsRepository {
  @override
  Future<List<Offering>> offerings() async => [
    const Offering(
      id: 'o1',
      state: 'live',
      building: 'Gulberg Tower',
      district: 'Lahore',
      province: 'Punjab',
      use: 'commercial',
      pricePaisa: '100000',
      hardCapUnits: '1000',
      availableUnits: '400',
      closesAt: null,
    ),
  ];
}

class _FakePortfolio implements PortfolioRepository {
  @override
  Future<Portfolio> portfolio() async => const Portfolio(
    holdings: [Holding(token: '0x1111111111111111111111111111111111111111', units: '20', frozenUnits: '0')],
    subscriptions: [],
    asOfBlock: '5',
  );
}

class _FakeInbox implements InboxRepository {
  @override
  Future<MessagePage> page({String? cursor}) async => MessagePage([
    Message(
      id: '1',
      title: 'Your verification status changed',
      body: 'verified',
      createdAt: DateTime.utc(2026, 11, 4),
      read: false,
    ),
  ], null);
}

class _FakeAccount implements AccountRepository {
  @override
  Future<Me> me() async => const Me(
    displayName: 'Ayesha',
    kyc: 'verified',
    wallet: '0x1111111111111111111111111111111111111111',
    nonResident: false,
    document: 'cnic',
    supportReference: 'deadbeef',
  );
}

Widget _app({required bool signedIn}) {
  final auth = _FakeAuth(signedIn: signedIn);
  return PropertyTokenApp(
    authBloc: AuthBloc(auth, delay: (_) async {})..add(const AuthStarted()),
    repositories: AppRepositories(
      auth: auth,
      offerings: _FakeOfferings(),
      portfolio: _FakePortfolio(),
      inbox: _FakeInbox(),
      account: _FakeAccount(),
    ),
  );
}

void main() {
  testWidgets('signed out: the device code is shown, then the app opens on Discover', (tester) async {
    await tester.pumpWidget(_app(signedIn: false));
    await tester.pumpAndSettle();
    expect(find.text('Sign in with the website'), findsOneWidget);
    await tester.tap(find.byKey(const Key('sign-in-start')));
    await tester.pumpAndSettle();
    expect(find.text('Gulberg Tower'), findsOneWidget);
    expect(find.text('400 of 1,000 units available'), findsOneWidget);
  });

  testWidgets('tabs: portfolio, inbox, account with theme and language switches; sign out', (tester) async {
    await tester.pumpWidget(_app(signedIn: true));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Portfolio').last);
    await tester.pumpAndSettle();
    expect(find.text('20 units'), findsOneWidget);
    await tester.tap(find.text('Inbox').last);
    await tester.pumpAndSettle();
    expect(find.text('Your verification status changed'), findsOneWidget);
    await tester.tap(find.text('Account').last);
    await tester.pumpAndSettle();
    expect(find.text('Verified'), findsOneWidget);

    await tester.tap(find.text('Night'));
    await tester.pumpAndSettle();
    expect(Theme.of(tester.element(find.text('Ayesha'))).brightness, Brightness.dark);
    await tester.tap(find.text('Day'));
    await tester.pumpAndSettle();
    expect(Theme.of(tester.element(find.text('Ayesha'))).brightness, Brightness.light);

    await tester.tap(find.text('اردو'));
    await tester.pumpAndSettle();
    expect(Directionality.of(tester.element(find.text('Ayesha'))), TextDirection.rtl);
    expect(find.text('تصدیق شدہ'), findsOneWidget);

    await tester.tap(find.byKey(const Key('sign-out')));
    await tester.pumpAndSettle();
    expect(find.text('ویب سائٹ کے ذریعے سائن اِن'), findsOneWidget);
  });
}

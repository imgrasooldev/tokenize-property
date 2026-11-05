import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:property_token_app/app/app.dart';
import 'package:property_token_app/core/network/api_client.dart';
import 'package:property_token_app/features/account/domain/me.dart';
import 'package:property_token_app/features/auth/domain/auth_repository.dart';
import 'package:property_token_app/features/auth/presentation/auth_bloc.dart';
import 'package:property_token_app/features/inbox/domain/message.dart';
import 'package:property_token_app/features/invest/domain/invest.dart';
import 'package:property_token_app/features/market/domain/market.dart';
import 'package:property_token_app/features/offerings/domain/offering.dart';
import 'package:property_token_app/features/portfolio/domain/portfolio.dart';
import 'package:property_token_app/features/rent/domain/rent.dart';

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

class _FakePortfolioWithSubscription implements PortfolioRepository {
  @override
  Future<Portfolio> portfolio() async => Portfolio(
    holdings: const [],
    subscriptions: [
      Subscription(
        id: 's1',
        units: '10',
        amountPaisa: '1000000',
        status: 'payment_pending',
        createdAt: DateTime.utc(2026, 11, 5),
      ),
    ],
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

class _FakeRent implements RentRepository {
  static const d = RentDistribution(
    token: '0x1111111111111111111111111111111111111111',
    distributionId: '7',
    period: '2026-10',
    status: 'finalized',
    units: '20',
    grossPaisa: '100000',
    withheldPaisa: '15000',
    netPaisa: '85000',
  );
  @override
  Future<List<RentDistribution>> distributions() async => [d];
  @override
  Future<RentProof> proof(RentDistribution d) async => const RentProof(
    registry: '0x2222222222222222222222222222222222222222',
    leaf: '0xaa',
    proof: ['0xbb'],
    merkleRoot: '0xcc',
    statementMatches: true,
    netPaisa: '85000',
  );
}

Widget _app({required bool signedIn, PortfolioRepository? portfolio}) {
  final auth = _FakeAuth(signedIn: signedIn);
  return PropertyTokenApp(
    authBloc: AuthBloc(auth, delay: (_) async {})..add(const AuthStarted()),
    repositories: AppRepositories(
      auth: auth,
      offerings: _FakeOfferings(),
      portfolio: portfolio ?? _FakePortfolio(),
      inbox: _FakeInbox(),
      account: _FakeAccount(),
      rent: _FakeRent(),
      invest: _FakeInvest(),
      market: _FakeMarket(),
    ),
  );
}

class _FakeMarket implements MarketRepository {
  @override
  Future<MarketData> overview() async => const MarketData(
    markets: [
      MarketBook(
        symbol: 'GPF3',
        bids: [BookLevel(pricePaisa: '49000', tokens: '20')],
        asks: [BookLevel(pricePaisa: '51000', tokens: '5')],
        lastPricePaisa: '50000',
      ),
    ],
    orders: [],
  );

  @override
  Future<OrderRequest> requestOrder({
    required String symbol,
    required String side,
    required String pricePaisa,
    required String tokens,
    required String idempotencyKey,
  }) => throw const ApiException(409, 'too_many_pending');

  @override
  Future<OrderRequest> orderRequest(String id) => throw const ApiException(404, 'not_found');
}

void main() {
  testWidgets('market: the book opens the order form; a refusal is shown', (tester) async {
    await tester.pumpWidget(_app(signedIn: true));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Portfolio').last);
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('open-market')));
    await tester.pumpAndSettle();
    expect(find.text('GPF3'), findsOneWidget);
    await tester.tap(find.byKey(const Key('order-open-GPF3')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('order-ask')));
    await tester.pumpAndSettle();
    expect(find.text('Confirm or let a waiting request expire first.'), findsOneWidget);
  });

  testWidgets('phase 2b: an unpaid reservation opens the cancel page; a refusal is shown', (tester) async {
    await tester.pumpWidget(_app(signedIn: true, portfolio: _FakePortfolioWithSubscription()));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Portfolio').last);
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('subscription-s1')));
    await tester.pumpAndSettle();
    expect(find.text('Ask to cancel'), findsOneWidget);
    await tester.tap(find.byKey(const Key('change-ask')));
    await tester.pumpAndSettle();
    expect(find.text('This subscription cannot be changed now.'), findsOneWidget);
  });

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
    await tester.tap(find.byKey(const Key('open-rent')));
    await tester.pumpAndSettle();
    expect(find.text('2026-10 · Rs 850.00'), findsOneWidget);
    await tester.tap(find.byKey(const Key('rent-7')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('proof-result')), findsOneWidget);
    expect(find.text('Your share is in the statement recorded on the blockchain.'), findsOneWidget);
    await tester.tapAt(const Offset(10, 10));
    await tester.pumpAndSettle();
    await tester.pageBack();
    await tester.pumpAndSettle();
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

class _FakeInvest implements InvestRepository {
  @override
  Future<SubscriptionRequest> requestReservation({
    required String offeringId,
    required String units,
    required String idempotencyKey,
  }) => throw const ApiException(422, 'offering_not_open');

  @override
  Future<SubscriptionRequest> requestChange({
    required String subscriptionId,
    required String action,
    required String idempotencyKey,
  }) => throw const ApiException(422, 'not_allowed_now');

  @override
  Future<SubscriptionRequest> request(String id) => throw const ApiException(404, 'not_found');

  @override
  Future<SubscriptionDetail> subscription(String id) => throw const ApiException(404, 'not_found');
}
